import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendUsage, logUsage, parseUsage, setUsageTestHook, usageByteBudget, usageFileState, usageNotice, usageTooLargeBytes } from './usage.js';
import { isLeftoverTemp } from './notebook.js';
import { isNbOwnFile } from './place-ops.js';
import { runNbCli } from './cli.js';

// Issue #576, FR-USAGE-005: what the usage-log path is (a FIFO, a device, a folder, a
// link, a huge file) can no longer block a call, grow its memory or fail it; the
// writer and `nb status` accept the same kinds of file; and the ring loses no row
// written by a concurrent call, because it rotates to `.nb-usage.log.1` instead of
// rewriting the log.
//
// Every spawn below runs under a hard 10 s timeout that ends in SIGKILL and asserts
// that no signal ended it, so a regression that blocks fails in seconds instead of
// hanging the suite (a task before this one left `nb status --json` blocked on a FIFO
// for 26 minutes).

// A seam on node:fs for the deterministic interleavings: it lets a test act at the
// exact moment the writer renames the log or takes `.nb.lock`, on this code and on
// the code before it (whose compaction renamed a temp over the log).
const fsHook = vi.hoisted(() => ({
  onRename: null as ((from: string, to: string, real: () => void) => void) | null,
  onMkdir: null as ((path: string) => void) | null,
  onOpen: null as ((path: string) => void) | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((from: string, to: string) => {
      const hook = fsHook.onRename;
      if (hook !== null) {
        fsHook.onRename = null; // one shot
        let done = false;
        hook(String(from), String(to), () => {
          done = true;
          actual.renameSync(from, to);
        });
        if (!done) actual.renameSync(from, to);
        return;
      }
      actual.renameSync(from, to);
    }) as typeof actual.renameSync,
    mkdirSync: ((path: string, opts?: Parameters<typeof actual.mkdirSync>[1]) => {
      const hook = fsHook.onMkdir;
      if (hook !== null && String(path).endsWith('.nb.lock')) {
        fsHook.onMkdir = null;
        hook(String(path));
      }
      return actual.mkdirSync(path, opts as never);
    }) as typeof actual.mkdirSync,
    openSync: ((path: string, flags?: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      const hook = fsHook.onOpen;
      if (hook !== null) hook(String(path));
      return actual.openSync(path, flags as never, mode as never);
    }) as typeof actual.openSync,
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string; // contains a space on purpose
let store: string;
let home: string;
let work: string;
let globalCfg: string;
const ENV_KEYS = ['NB_USAGE_RING', 'NB_MAX_CHARS', 'NB_SESSION', 'NB_DIR', 'HOME', 'USERPROFILE'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb hostile ')));
  store = join(tmp, 'store');
  home = join(tmp, 'home');
  work = join(tmp, 'work');
  for (const d of [store, home, work]) mkdirSync(d);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.NB_USAGE_RING;
  delete process.env.NB_MAX_CHARS;
  delete process.env.NB_SESSION;
});
afterEach(() => {
  fsHook.onRename = null;
  fsHook.onMkdir = null;
  fsHook.onOpen = null;
  setUsageTestHook(undefined);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  const out: NodeJS.ProcessEnv = {
    ...env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmp,
    NB_DIR: store,
    ...extra,
  };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete out[k];
  return out;
}

interface Run {
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  err: string;
  ms: number;
}
/** The built CLI, killed with SIGKILL after 10 s so a call that blocks fails fast. */
function nb(args: string[], env: Record<string, string | undefined> = {}): Run {
  const t = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: work, env: childEnv(env), encoding: 'utf-8', timeout: 10_000, killSignal: 'SIGKILL' });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr, ms: Date.now() - t };
}

const LOG = (d: string): string => join(d, '.nb-usage.log');
const NOTICE = 'nb (the notebook): this use of the notebook was not recorded in its usage log';
const noticeLines = (err: string): string[] => err.split('\n').filter((l) => l.startsWith(NOTICE));
const withoutNotice = (err: string): string => err.split('\n').filter((l) => !l.startsWith(NOTICE)).join('\n');
const rowsOf = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf-8').split('\n').filter((l) => l !== '') : []);
const seedRow = (i: number, cmd = `c${i}`): string => `${new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()}\tseed\t${cmd}\tok\t1ms`;
/** A ready store with `.nb-usage.log` replaced by `make`; returns the store. */
function storeWith(name: string, make: (log: string) => void): string {
  const d = join(tmp, name);
  mkdirSync(d);
  make(LOG(d));
  return d;
}
function canSymlink(): boolean {
  const probe = join(tmp, 'probe-link');
  try {
    symlinkSync(join(tmp, 'global.gitconfig'), probe);
    rmSync(probe);
    return true;
  } catch {
    return false; // Windows without the symlink privilege
  }
}

/** Each command, run against a normal store and against `hostile`: same exit, same stdout, one notice. */
function expectSameAsWithoutLog(hostile: string, commands: string[][], kind: RegExp): void {
  for (const args of commands) {
    const ref = nb(args, { NB_DIR: join(tmp, `ref-${args[0]}`) });
    const got = nb(args, { NB_DIR: hostile });
    expect(got.signal, `nb ${args.join(' ')} was killed`).toBeNull();
    expect(got.ms, `nb ${args.join(' ')} took ${got.ms} ms`).toBeLessThan(10_000);
    expect(got.code, `nb ${args.join(' ')}: ${got.err}`).toBe(ref.code);
    expect(got.out.split(hostile).join('<dir>')).toBe(ref.out.split(join(tmp, `ref-${args[0]}`)).join('<dir>'));
    const lines = noticeLines(got.err);
    expect(lines, `nb ${args.join(' ')} stderr: ${got.err}`).toHaveLength(1);
    expect(lines[0]).toMatch(kind);
    expect(withoutNotice(got.err).split(hostile).join('<dir>')).toBe(ref.err.split(join(tmp, `ref-${args[0]}`)).join('<dir>'));
  }
}

const COMMANDS = [['brief'], ['list'], ['stats'], ['path'], ['show', 'build'], ['add', 'build', 'run the build before the tests']];

describe('a usage log that is not a plain file never blocks, grows or fails a call (issue #576, FR-USAGE-005)', () => {
  test.skipIf(isWin)('a FIFO as the log: every command returns as without a log, with one notice', () => {
    const d = storeWith('fifo', (log) => execFileSync('mkfifo', [log]));
    expectSameAsWithoutLog(d, COMMANDS, /is a special system file instead of a normal file\. Your lessons are not in it; delete it/);
    expect(lstatSync(LOG(d)).isFIFO()).toBe(true); // never replaced, never written
  });

  test.skipIf(isWin)('a FIFO as the log with a sidecar that sends the writer straight to the append still returns', () => {
    const d = storeWith('fifo-fast', (log) => execFileSync('mkfifo', [log]));
    writeFileSync(join(d, '.nb-usage.log.count'), '0\t0\n');
    expectSameAsWithoutLog(d, [['path']], /special system file/);
  });

  test.skipIf(isWin)('a FIFO as the .count sidecar: the row is still written, and no notice', () => {
    mkdirSync(join(tmp, 'side'));
    const d = join(tmp, 'side');
    execFileSync('mkfifo', [join(d, '.nb-usage.log.count')]);
    const r = nb(['path'], { NB_DIR: d });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(rowsOf(LOG(d)).join('\n')).toContain('\t-\tpath\tok\t');
  });

  test.skipIf(isWin)('a link to /dev/zero: every command returns as without a log, with one notice', () => {
    const d = storeWith('zero', (log) => symlinkSync('/dev/zero', log));
    expectSameAsWithoutLog(d, [['brief'], ['stats'], ['path']], /is a shortcut \(symbolic link\) instead of a normal file\. Your lessons are not in that file\. Delete the link itself, not what it points to/);
  });

  test('a folder as the log: nb stats exits 0 (it exited 1 with EISDIR), and every command says so once', () => {
    const d = storeWith('folder', (log) => mkdirSync(log));
    writeFileSync(join(LOG(d), 'keep.txt'), 'not ours');
    expectSameAsWithoutLog(d, COMMANDS, /is a folder instead of a normal file\. Your lessons are not in it; look inside it before you delete it/);
    expect(readFileSync(join(LOG(d), 'keep.txt'), 'utf-8')).toBe('not ours');
  });

  test('a link to a regular file: the target is never written, and the writer and nb status both refuse it', () => {
    if (!canSymlink()) return;
    const target = join(tmp, 'elsewhere.log');
    writeFileSync(target, 'TARGET\n');
    const d = storeWith('link', (log) => symlinkSync(target, log));
    expectSameAsWithoutLog(d, [['path'], ['brief']], /symbolic link/);
    process.env.NB_USAGE_RING = '100';
    for (let i = 0; i < 130; i++) logUsage(d, 'p', 'show', true, 1);
    expect(readFileSync(target, 'utf-8')).toBe('TARGET\n'); // before: written until the first compaction replaced the link
    expect(lstatSync(LOG(d)).isSymbolicLink()).toBe(true); // the link is not replaced either
    const st = nb(['status', '--json'], { NB_DIR: d });
    expect(st.signal).toBeNull();
    const j = JSON.parse(st.out) as { verdict: string; headline: string };
    expect(j.verdict).toBe('broken');
    expect(j.headline).toContain('is a shortcut (symbolic link) instead of a normal file');
  });

  test('a sidecar planted as a link never overwrites what it points to', () => {
    if (!canSymlink()) return;
    const victim = join(tmp, 'victim.txt');
    writeFileSync(victim, 'precious\n');
    const d = join(tmp, 'side-link');
    mkdirSync(d);
    symlinkSync(victim, join(d, '.nb-usage.log.count'));
    const r = nb(['list'], { NB_DIR: d });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(readFileSync(victim, 'utf-8')).toBe('precious\n'); // before: overwritten with "1\t<bytes>"
    expect(rowsOf(LOG(d))).toHaveLength(1); // the row itself is still written
  });

  test.skipIf(isWin)('a 3 GiB sparse log: a call writes its row, nb stats reads it quickly, and memory stays small', () => {
    const d = storeWith('huge', (log) => {
      writeFileSync(log, '');
      truncateSync(log, 3 * 1024 ** 3);
    });
    const p = nb(['path'], { NB_DIR: d });
    expect(p.signal).toBeNull();
    expect(p.code).toBe(0);
    expect(p.err).toBe('');
    const s = nb(['stats', '--json'], { NB_DIR: d });
    expect(s.signal).toBeNull();
    expect(s.code).toBe(0);
    const j = JSON.parse(s.out) as { perCommand: { command: string; calls: number }[] };
    expect(j.perCommand.find((c) => c.command === 'path')?.calls).toBe(1); // before: no row was ever written
    expect(statSync(LOG(d)).size).toBeLessThan(10_000); // the huge file is now the older generation
  });
});

describe('the writer and nb status accept the same kinds of file (issue #576)', () => {
  test('for an absent log, a plain file, a link, a FIFO and a folder, nb status says what the writer did', () => {
    const kinds: [string, (log: string) => void][] = [
      ['absent', () => {}],
      ['file', (log) => writeFileSync(log, '')],
      ['folder', (log) => mkdirSync(log)],
    ];
    if (!isWin) kinds.push(['fifo', (log) => execFileSync('mkfifo', [log])]);
    if (canSymlink()) kinds.push(['link', (log) => {
      writeFileSync(join(tmp, 'link-target'), '');
      symlinkSync(join(tmp, 'link-target'), log);
    }]);
    for (const [name, make] of kinds) {
      const d = storeWith(`agree-${name}`, make);
      const st = nb(['status', '--json'], { NB_DIR: d });
      expect(st.signal).toBeNull();
      const j = JSON.parse(st.out) as { verdict: string; headline: string };
      const res = appendUsage(d, 'p', 'show', true, 1);
      const writerRefuses = typeof res !== 'string';
      const statusRefuses = j.verdict === 'broken' && j.headline.includes('record of chat starts');
      expect(statusRefuses, `${name}: writer ${JSON.stringify(res)}, status ${j.headline}`).toBe(writerRefuses);
      expect(writerRefuses).toBe(!['absent', 'file'].includes(name));
    }
  });

  test('usageFileState is the single rule: only a regular file (or nothing) is used', () => {
    const st = (over: Partial<Record<'isFile' | 'isDirectory' | 'isSymbolicLink', boolean>>) => ({
      isFile: () => over.isFile ?? false,
      isDirectory: () => over.isDirectory ?? false,
      isSymbolicLink: () => over.isSymbolicLink ?? false,
      size: 0,
    });
    expect(usageFileState(null)).toBe('absent');
    expect(usageFileState(st({ isFile: true }))).toBe('file');
    expect(usageFileState(st({ isSymbolicLink: true }))).toEqual({ refused: 'link' });
    expect(usageFileState(st({ isDirectory: true }))).toEqual({ refused: 'folder' });
    expect(usageFileState(st({}))).toEqual({ refused: 'special' });
  });
});

describe('the ring loses no row written by a concurrent call (issue #576)', () => {
  /** A ring of 100 already past every threshold (116 rows, no sidecar), so the next call rotates (or, before, compacted). */
  function fullRing(d: string): void {
    process.env.NB_USAGE_RING = '100';
    writeFileSync(LOG(d), Array.from({ length: 116 }, (_, i) => seedRow(i)).join('\n') + '\n');
  }
  const commands = (d: string): string[] => parseUsage(d).map((r) => r.command);

  test('a row appended, and a row from a call that opened the log before the rename and writes after it, both survive', () => {
    fullRing(store);
    let fired = false;
    fsHook.onRename = (_from, to, real) => {
      if (to !== LOG(store) && to !== `${LOG(store)}.1`) return;
      fired = true;
      appendFileSync(LOG(store), `${seedRow(500, 'concurrent')}\n`); // another call's append, just before the rename
      const straggler = openSync(LOG(store), 'a'); // a call that opened the log before the rename…
      real();
      writeSync(straggler, `${seedRow(501, 'straggler')}\n`); // …and writes after it
      closeSync(straggler);
    };
    logUsage(store, 'p', 'mine', true, 1);
    expect(fired).toBe(true);
    const got = commands(store);
    expect(got).toContain('concurrent'); // before: the compaction's rename dropped it
    expect(got).toContain('straggler'); // before: written into the replaced file
    expect(got[got.length - 1]).toBe('mine');
  });

  test('two rotators: the second, which counted the full file, re-counts under the lock and does not rotate the fresh one', () => {
    fullRing(store);
    let fired = false;
    fsHook.onMkdir = () => {
      fired = true;
      logUsage(store, 'p', 'first', true, 1); // rotates first, while the outer call is about to take the lock
    };
    logUsage(store, 'p', 'second', true, 1);
    expect(fired).toBe(true); // before: the writer took no lock, so this seam never fired
    expect(rowsOf(`${LOG(store)}.1`).length).toBe(116); // the full generation is kept, not replaced by a 1-row file
    const got = commands(store);
    expect(got.slice(-2)).toEqual(['first', 'second']);
    expect(got).toContain('c115'); // the newest seed row is still read
  });

  test('a rotator whose lock was taken from it as stale does not rename', () => {
    fullRing(store);
    setUsageTestHook((point) => {
      if (point === 'locked') writeFileSync(join(store, '.nb.lock', 'owner'), 'someone-else');
    });
    logUsage(store, 'p', 'mine', true, 1);
    setUsageTestHook(undefined);
    expect(existsSync(`${LOG(store)}.1`)).toBe(false); // holds() said no: no rename
    expect(existsSync(join(store, '.nb.lock'))).toBe(true); // and the thief's lock is left to the thief
    expect(commands(store)).toContain('mine'); // the row is still written, to the live file
  });

  test('a busy lock skips the rotation, writes the row, and tries again a slack of rows later', () => {
    fullRing(store);
    mkdirSync(join(store, '.nb.lock')); // a fresh lock held by a running mutation
    writeFileSync(join(store, '.nb.lock', 'owner'), 'busy');
    logUsage(store, 'p', 'one', true, 1);
    expect(existsSync(`${LOG(store)}.1`)).toBe(false);
    expect(readFileSync(join(store, '.nb-usage.log.count'), 'utf-8')).toMatch(/^117\t\d+\t\d+\n$/); // the next try, by size
    rmSync(join(store, '.nb.lock'), { recursive: true });
    logUsage(store, 'p', 'two', true, 1); // within the back-off: appended, not rotated
    expect(existsSync(`${LOG(store)}.1`)).toBe(false);
    for (let i = 0; i < 20; i++) logUsage(store, 'p', `later${i}`, true, 1);
    expect(existsSync(`${LOG(store)}.1`)).toBe(true); // tried again and rotated
    expect(commands(store).slice(-3)).toEqual(['later17', 'later18', 'later19']);
  });

  test('a sidecar that can never be written does not stop rotation', () => {
    process.env.NB_USAGE_RING = '100';
    mkdirSync(join(store, '.nb-usage.log.count')); // a folder where the sidecar goes
    for (let i = 0; i < 250; i++) logUsage(store, 'p', `c${i}`, true, 1);
    expect(existsSync(`${LOG(store)}.1`)).toBe(true);
    expect(rowsOf(LOG(store)).length).toBeLessThan(100);
    expect(commands(store)[99]).toBe('c249');
  });

  test('a log past the size cap names the folder that blocks its rotation, and logs again once that is gone', () => {
    process.env.NB_USAGE_RING = '100';
    const filler = 'x'.repeat(1000);
    const rows = Array.from({ length: Math.ceil(usageTooLargeBytes() / 1000) + 10 }, (_, i) => `${seedRow(i)}\t${filler}`);
    writeFileSync(LOG(store), rows.join('\n') + '\n');
    mkdirSync(`${LOG(store)}.1`); // the rename to .1 fails
    for (let i = 0; i < 3; i++) {
      expect(appendUsage(store, 'p', 'blocked', true, 1)).toEqual({ refused: 'folder', path: `${LOG(store)}.1` });
    }
    rmSync(`${LOG(store)}.1`, { recursive: true });
    expect(appendUsage(store, 'p', 'free', true, 1)).toBe('written'); // tried again at once, not a slack later
    expect(rowsOf(`${LOG(store)}.1`).length).toBe(rows.length);
    expect(rowsOf(LOG(store))).toHaveLength(1);
    expect(parseUsage(store).at(-1)?.command).toBe('free');
  });

  test('a reader that meets a rotation between its two opens reads every row once', () => {
    process.env.NB_USAGE_RING = '100';
    for (let i = 0; i < 50; i++) logUsage(store, 'p', `c${i}`, true, 1);
    writeFileSync(`${LOG(store)}.1`, `${seedRow(0, 'older')}\n`);
    let rotated = false;
    fsHook.onOpen = (path) => {
      if (rotated || path !== `${LOG(store)}.1`) return;
      rotated = true; // the live file is open; now another call rotates it
      fsHook.onOpen = null;
      renameSync(LOG(store), `${LOG(store)}.1`);
    };
    const got = commands(store);
    expect(rotated).toBe(true);
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => `c${i}`)); // no row twice, none missed of the file it opened
  });

  test('rows that are large in bytes rotate by size, and logging never stops', () => {
    process.env.NB_USAGE_RING = '100';
    process.env.NB_MAX_CHARS = '2000';
    const wide = '漢'.repeat(2000); // 6 KB in UTF-8 for 2000 characters
    const results = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const r = appendUsage(store, 'p', `c${i}`, true, 1, { session: wide, note: wide, entries: [] });
      results.add(typeof r === 'string' ? r : JSON.stringify(r));
    }
    expect([...results]).toEqual(['written']);
    expect(existsSync(`${LOG(store)}.1`)).toBe(true);
    expect(statSync(LOG(store)).size).toBeLessThan(usageByteBudget() + 20_000);
    expect(statSync(`${LOG(store)}.1`).size).toBeLessThan(usageTooLargeBytes());
    const got = commands(store);
    expect(got[got.length - 1]).toBe('c399');
  });

  test('the log keeps its mode (0600 or 0660) across a rotation, whatever the umask', () => {
    if (isWin) return; // POSIX modes and umask
    for (const mode of [0o600, 0o660]) {
      const d = join(tmp, `mode-${mode.toString(8)}`);
      mkdirSync(d);
      process.env.NB_USAGE_RING = '100';
      logUsage(d, 'p', 'first', true, 1);
      chmodSync(LOG(d), mode);
      const old = process.umask(0o022);
      try {
        for (let i = 0; i < 150; i++) logUsage(d, 'p', 'show', true, 1);
      } finally {
        process.umask(old);
      }
      expect(existsSync(`${LOG(d)}.1`)).toBe(true);
      expect(statSync(LOG(d)).mode & 0o777).toBe(mode);
    }
  });

  test('the older generation is nb\'s own file for nb place, and is never reaped as a temp', () => {
    expect(isNbOwnFile('.nb-usage.log.1')).toBe(true);
    expect(isLeftoverTemp(store, '.nb-usage.log.1')).toBe(false);
    const r = nb(['path', '--usage']);
    expect(r.out).toBe(`${LOG(store)}\n`); // still one line, the live file
  });

  test('a burst of 50 parallel calls at the rotation point keeps every row, 10 times [timing]', async () => {
    for (let t = 0; t < 10; t++) {
      const d = join(tmp, `burst-${t}`);
      mkdirSync(d);
      writeFileSync(LOG(d), Array.from({ length: 110 }, (_, i) => seedRow(i)).join('\n') + '\n');
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          new Promise<void>((resolve) => {
            const c = spawn(process.execPath, [CLI, 'path'], {
              cwd: work,
              env: childEnv({ NB_DIR: d, NB_USAGE_RING: '100', NB_SESSION: `burst-${i}` }),
              stdio: 'ignore',
              timeout: 30_000,
              killSignal: 'SIGKILL',
            });
            c.on('close', () => resolve());
          }),
        ),
      );
      const sessions = new Set([...rowsOf(LOG(d)), ...rowsOf(`${LOG(d)}.1`)].map((l) => l.split('\t')[5]));
      const missing = Array.from({ length: 50 }, (_, i) => `burst-${i}`).filter((s) => !sessions.has(s));
      expect(missing, `burst ${t}`).toEqual([]); // before: 59 of 100 such bursts lost a row
      expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }
  }, 120_000);
});

describe('the one-line notice (issue #576)', () => {
  async function inProcess(args: string[], dir: string): Promise<{ code: number; err: string }> {
    const saved = { NB_DIR: process.env.NB_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.NB_DIR = dir;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const we = process.stderr.write.bind(process.stderr);
    const wo = process.stdout.write.bind(process.stdout);
    let err = '';
    process.stderr.write = ((x: string) => ((err += x), true)) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const code = await runNbCli(args);
      return { code, err };
    } finally {
      process.stderr.write = we;
      process.stdout.write = wo;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test('is printed once by each call, also when runNbCli runs twice in one process (no module-wide latch)', async () => {
    const d = storeWith('notice', (log) => mkdirSync(log));
    for (let i = 0; i < 2; i++) {
      const r = await inProcess(['path'], d);
      expect(r.code).toBe(0);
      expect(noticeLines(r.err)).toHaveLength(1);
    }
    const h = await inProcess(['--help'], d);
    expect(noticeLines(h.err)).toHaveLength(1); // the help row goes through the same rule
  });

  test.skipIf(isWin || isRoot)('a read-only notebook folder stays silent, as before', () => {
    const d = join(tmp, 'ro');
    mkdirSync(d);
    chmodSync(d, 0o555);
    try {
      const r = nb(['path'], { NB_DIR: d });
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
    } finally {
      chmodSync(d, 0o755);
    }
  });

  test('shows the home folder as ~ and escapes a control character in the path', () => {
    const res = { refused: 'folder' as const, path: join(home, 'a\u001b[2Jb', '.nb-usage.log') };
    const line = usageNotice(res, home)!;
    expect(line).toContain(`because ~${sep}a\\u001b[2Jb${sep}.nb-usage.log is a folder`);
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain(home);
    expect(usageNotice('written', home)).toBeNull();
    expect(usageNotice('failed', home)).toBeNull();
    expect(usageNotice({ tooLarge: true, path: '/x/.nb-usage.log' }, home)).toMatch(/has grown past \d+ MB and the notebook could not start a new one/);
  });
});
