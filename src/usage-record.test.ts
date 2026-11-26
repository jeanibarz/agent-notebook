import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { logUsage, parseUsage } from './usage.js';

// Issue #558, FR-HEARTBEAT-001, FR-USAGE-001/002: the usage row of `brief` and
// `retro` carries the nb version and, with `--hook`, the project key; and the
// bounded reader `nb status` will use reads only the tail of a log that may not
// be a plain file.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

let tmp: string; // contains a space on purpose
let store: string;
let plain: string;
let home: string;
let globalCfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb record ')));
  store = join(tmp, 'store');
  plain = join(tmp, 'plain');
  home = join(tmp, 'home');
  for (const d of [store, plain, home]) mkdirSync(d);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
});
afterEach(() => {
  try {
    chmodSync(join(home, '.agent-notebook', 'projects'), 0o755);
  } catch {
    // never made
  }
  rmSync(tmp, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmp,
    NB_DIR: store,
    NB_ASCII: '0',
    ...extra,
  };
}

function nb(args: string[], env: Record<string, string> = {}, cwd = plain): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(env), encoding: 'utf-8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function repo(name: string, origin?: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: d, env: childEnv(), stdio: 'ignore' });
  git('init', '-q');
  if (origin !== undefined) git('remote', 'add', 'origin', origin);
  return d;
}

/** The raw rows of a log, split into columns. */
const rawRows = (dir: string): string[][] =>
  readFileSync(join(dir, '.nb-usage.log'), 'utf-8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split('\t'));

describe('a brief or retro row records the version and, with --hook, the project (FR-HEARTBEAT-001, FR-USAGE-001)', { timeout: 60_000 }, () => {
  test('brief --hook a.b writes the nb version in column 17 and the project name in column 18', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    expect(nb(['brief', '--hook', 'a.b', '--session', 's1'], {}, r).code).toBe(0);
    const [row] = rawRows(store);
    expect(row).toHaveLength(18);
    expect(row![2]).toBe('brief');
    expect(row![16]).toBe(VERSION);
    expect(row![17]).toBe('acme-app');
    const parsed = parseUsage(store)[0]!;
    expect(parsed).toMatchObject({ command: 'brief', note: 'a.b', version: VERSION, project: 'acme-app' });
  });

  test('brief --hook in a repository with no remote writes h: and 12 hex of the repository folder, from a subfolder too', () => {
    const r = repo('norem');
    mkdirSync(join(r, 'sub'));
    nb(['brief', '--hook', 'a.b'], {}, r);
    nb(['brief', '--hook', 'a.b'], {}, join(r, 'sub'));
    const keys = rawRows(store).map((c) => c[17]);
    expect(keys).toEqual([`h:${sha12(r)}`, `h:${sha12(r)}`]);
  });

  test('brief without --hook writes the version and leaves column 18 empty', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    nb(['brief'], {}, r);
    const [row] = rawRows(store);
    expect(row).toHaveLength(18);
    expect(row![16]).toBe(VERSION);
    expect(row![17]).toBe('');
  });

  test('an inherited NB_SESSION without --hook writes no key', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    nb(['brief'], { NB_SESSION: 'inherited' }, r);
    nb(['retro', '--session', 'inherited2'], { NB_SESSION: 'inherited' }, r);
    const rows = rawRows(store);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row[5]).toMatch(/^inherited/);
      expect(row[17]).toBe('');
    }
  });

  test('retro --hook computes the key in --work-dir when it is an absolute folder, else in the working folder', () => {
    const cwdRepo = repo('cwd', 'git@github.com:Acme/Cwd.git');
    const workRepo = repo('work', 'git@github.com:Acme/Work.git');
    nb(['retro', '--session', 's1', '--work-dir', workRepo, '--hook', 'a.stop'], {}, cwdRepo);
    nb(['retro', '--session', 's2', '--work-dir', 'relative/dir', '--hook', 'a.stop'], {}, cwdRepo);
    nb(['retro', '--session', 's3', '--work-dir', join(tmp, 'does-not-exist'), '--hook', 'a.stop'], {}, cwdRepo);
    const rows = rawRows(store).filter((c) => c[2] === 'retro');
    expect(rows.map((c) => c[17])).toEqual(['acme-work', 'acme-cwd', 'acme-cwd']);
    for (const c of rows) expect(c[16]).toBe(VERSION);
  });

  test('every other command keeps its 16 columns', () => {
    writeFileSync(join(store, 'build.md'), '- [+1] one\n');
    nb(['list']);
    nb(['show', 'build']);
    nb(['add', 'build', 'a lesson that is long enough to count']);
    const rows = rawRows(store);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const c of rows) expect(c, c[2]).toHaveLength(16);
  });

  test('a brief with bad usage inside the command still records the version, and no project', () => {
    nb(['brief', '--max-chars', '1', '--max-chars', '2']);
    const [row] = rawRows(store);
    expect(row![2]).toBe('brief');
    expect(row![3]).toBe('err');
    expect(row![16]).toBe(VERSION);
    expect(row![17]).toBe('');
  });

  test('the version and project are cleaned to their alphabets and never cut with an ellipsis', () => {
    logUsage(store, '-', 'brief', true, 1, { version: `1.2.3-beta+x\t\n"é ${'9'.repeat(60)}`, project: `ac me/é:?${'a'.repeat(200)}` });
    const [row] = rawRows(store);
    expect(row).toHaveLength(18);
    expect(row![16]).toMatch(/^[0-9A-Za-z.+-]{1,32}$/);
    expect(row![16].startsWith('1.2.3-beta+x')).toBe(true);
    expect(row![17]).toMatch(/^[0-9A-Za-z.:?_-]{1,80}$/);
    expect(`${row![16]}${row![17]}`).not.toContain('…');
  });

  test('NB_MAX_CHARS does not cut either column', () => {
    logUsage(store, '-', 'brief', true, 1, { version: VERSION, project: 'h:0123456789ab' });
    const r = repo('app', 'git@github.com:Acme/App.git');
    nb(['brief', '--hook', 'a.b'], { NB_MAX_CHARS: '20' }, r);
    const rows = rawRows(store);
    expect(rows[1]![16]).toBe(VERSION);
    expect(rows[1]![17]).toBe('acme-app');
  });

  test.skipIf(isWin || isRoot)('a place that is unknown still leaves a brief row, outcome broken, with the project name', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    const projects = join(home, '.agent-notebook', 'projects');
    mkdirSync(projects, { recursive: true });
    chmodSync(projects, 0o000);
    const out = nb(['brief', '--hook', 'a.session-start', '--session', 's1'], { NB_DIR: '' }, r);
    expect(out.code).toBe(0);
    const shared = join(home, '.agent-notebook', 'notebooks');
    const row = parseUsage(shared).find((x) => x.command === 'brief')!;
    expect(row).toMatchObject({ outcome: 'broken', ok: true, note: 'a.session-start', version: VERSION });
    // the name when git answers, `?` when it could not: never anything else
    expect(['acme-app', '?']).toContain(row.project);
  });

  test.skipIf(isWin)('a call where git is not found still leaves a row with a key of the working folder', () => {
    nb(['brief', '--hook', 'a.b'], { PATH: join(tmp, 'no-such-bin') });
    const [row] = rawRows(store);
    expect(row![17]).toBe(`h:${sha12(plain)}`);
  });
});

describe('old rows and the stats readout (FR-USAGE-001, issue #558)', () => {
  const T = new Date(Date.now() - 3600_000).toISOString();
  // 16 columns, as written by 0.12 and 0.13.
  const old = (cmd: string, outcome: string): string => `${T}\t-\t${cmd}\tok\t3ms\ts1\t\t${outcome}\t\t\t\ta.b\t\t\t\t`;

  test('a log of 0.12 and 0.13 rows parses with version and project both empty', () => {
    // a pre-#176 row with only 12 columns, then 16-column rows
    writeFileSync(join(store, '.nb-usage.log'), [`${T}\tbuild\tadd\tok\t2ms\t\t\taccepted\t\t\t\t`, old('brief', 'index'), old('retro', 'nudge')].join('\n') + '\n');
    const rows = parseUsage(store);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ version: '', project: '' });
    expect(rows[1]).toMatchObject({ command: 'brief', outcome: 'index', note: 'a.b' });
  });

  test('stats --json is byte-identical on a log with and without the two new columns', () => {
    const without = [old('brief', 'index'), old('retro', 'nudge'), old('list', ''), old('brief', 'empty')];
    const withCols = without.map((l, i) => (i === 2 ? l : `${l}\t${VERSION}\t${i === 0 ? 'acme-app' : ''}`));
    const run = (lines: string[]): string => {
      const d = mkdtempSync(join(tmp, 'log '));
      writeFileSync(join(d, '.nb-usage.log'), lines.join('\n') + '\n');
      const r = nb(['stats', '--json'], { NB_DIR: d });
      expect(r.code).toBe(0);
      // the only two fields that hold the time of the call
      return r.out.replace(/"(generatedAt|windowStart)":"[^"]*"/g, '"$1":"-"');
    };
    const a = run(without);
    const b = run(withCols);
    expect(JSON.parse(a).totalCalls).toBe(4);
    expect(b).toBe(a);
    expect(nb(['stats'], { NB_DIR: store }).code).toBe(0);
  });
});

describe('parseUsage reads a bounded tail and refuses what is not a plain file (NFR-BOUND-001, issue #558)', { timeout: 60_000 }, () => {
  const rowAt = (i: number): string => `2026-11-25T10:00:${String(i % 60).padStart(2, '0')}.000Z\t-\tlist\tok\t1ms\ts${i}\t\t\t\t\t\t\t\t\t\t`;

  test('without the option the whole file is read, as before', () => {
    writeFileSync(join(store, '.nb-usage.log'), Array.from({ length: 50 }, (_, i) => rowAt(i)).join('\n') + '\n');
    expect(parseUsage(store)).toHaveLength(50);
    expect(parseUsage(store, {})).toHaveLength(50);
  });

  test('with maxBytes only the last bytes are read and the first partial line is dropped', () => {
    const lines = Array.from({ length: 50 }, (_, i) => rowAt(i));
    writeFileSync(join(store, '.nb-usage.log'), lines.join('\n') + '\n');
    const one = Buffer.byteLength(lines[0]! + '\n');
    const rows = parseUsage(store, { maxBytes: one * 3 + 5 });
    // 3 whole rows and 5 bytes of a fourth, which is dropped
    expect(rows.map((r) => r.session)).toEqual(['s47', 's48', 's49']);
    expect(parseUsage(store, { maxBytes: 1_000_000 })).toHaveLength(50);
    expect(parseUsage(store, { maxBytes: 0 })).toEqual([]);
  });

  test('a truncated last line is a row with what it has, and never throws', () => {
    writeFileSync(join(store, '.nb-usage.log'), `${rowAt(1)}\n${rowAt(2)}\n2026-11-25T10:00:09.000Z\t-\tbri`);
    const rows = parseUsage(store, { maxBytes: 100_000 });
    expect(rows.map((r) => r.session)).toEqual(['s1', 's2', '']);
    expect(rows[2]!.command).toBe('bri');
    // a cut that leaves no newline at all gives no row
    expect(parseUsage(store, { maxBytes: 10 })).toEqual([]);
  });

  test('a missing log and a folder named .nb-usage.log give no rows', () => {
    expect(parseUsage(store, { maxBytes: 1000 })).toEqual([]);
    mkdirSync(join(store, '.nb-usage.log'));
    expect(parseUsage(store, { maxBytes: 1000 })).toEqual([]);
  });

  test.skipIf(isWin)('a large sparse file is read from its tail in a bounded time', () => {
    const file = join(store, '.nb-usage.log');
    const fd = openSync(file, 'w');
    closeSync(fd);
    truncateSync(file, 2 * 1024 ** 3); // 2 GiB of holes
    appendFileSync(file, `\n${rowAt(1)}\n${rowAt(2)}\n`);
    const t0 = Date.now();
    const rows = parseUsage(store, { maxBytes: 1024 * 1024 });
    expect(rows.map((r) => r.session)).toEqual(['s1', 's2']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test.skipIf(isWin)('a FIFO named .nb-usage.log does not hang and gives no rows', () => {
    execFileSync('mkfifo', [join(store, '.nb-usage.log')]);
    const t0 = Date.now();
    expect(parseUsage(store, { maxBytes: 1024 })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test.skipIf(isWin)('a symlink to /dev/zero gives no rows and reads nothing', () => {
    symlinkSync('/dev/zero', join(store, '.nb-usage.log'));
    const t0 = Date.now();
    expect(parseUsage(store, { maxBytes: 1024 * 1024 })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test.skipIf(isWin)('a symlink to a plain log is refused too', () => {
    writeFileSync(join(tmp, 'real.log'), rowAt(1) + '\n');
    symlinkSync(join(tmp, 'real.log'), join(store, '.nb-usage.log'));
    expect(parseUsage(store, { maxBytes: 1024 })).toEqual([]);
  });
});

describe('brief --hook under concurrency leaves no torn row (FR-HEARTBEAT-001, issue #558)', () => {
  // A launcher that waits until a barrier file exists, then runs the command, so
  // all of them start at nearly the same moment.
  const gateSrc = [
    "const { existsSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [barrier, cmd, ...args] = process.argv.slice(1);',
    'while (!existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);',
    "const r = spawnSync(cmd, args, { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
  ].join('\n');

  test('20 parallel brief --hook calls on one folder write 20 whole rows of 18 columns', async () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    const barrier = join(tmp, 'barrier');
    const env = childEnv();
    const runs = Array.from(
      { length: 20 },
      (_, i) =>
        new Promise<number | null>((done, fail) => {
          const child = spawn(process.execPath, ['-e', gateSrc, barrier, process.execPath, CLI, 'brief', '--hook', 'a.session-start', '--session', `s${i}`], {
            cwd: r,
            env,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          child.on('error', fail);
          child.on('close', done);
        }),
    );
    await new Promise((res) => setTimeout(res, 600));
    writeFileSync(barrier, '');
    expect(await Promise.all(runs)).toEqual(Array(20).fill(0));
    const rows = rawRows(store);
    expect(rows).toHaveLength(20);
    for (const c of rows) {
      expect(c).toHaveLength(18);
      expect(c.slice(2, 3)).toEqual(['brief']);
      expect(c[16]).toBe(VERSION);
      expect(c[17]).toBe('acme-app');
    }
    expect(new Set(rows.map((c) => c[5])).size).toBe(20);
  }, 60_000);
});
