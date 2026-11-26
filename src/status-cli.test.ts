import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Issue #558, FR-STATUS-001..003: the built `dist/cli.js` run end to end in temp folders, with HOME and
// NB_DIR set per test. Time is handled in two ways: rows that a real `nb brief` writes are asserted by
// structure ("just now" or a few minutes), and forged rows are dated a fixed offset (3 h 30 s) before the
// call, so "3 hours ago" holds however long the test takes.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const noPerm = isWin || isRoot; // POSIX permission cases need a non-root POSIX user

const sha12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
const folderKey = (p: string): string => `h:${sha12(isWin ? realpathSync.native(p).replace(/^[A-Za-z]:/, (x) => x.toLowerCase()) : realpathSync.native(p))}`;

let tmp: string; // contains a space on purpose
let store: string;
let home: string;
let globalCfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb status ')));
  store = join(tmp, 'store');
  home = join(tmp, 'home');
  for (const d of [store, home]) mkdirSync(d);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
});
afterEach(() => {
  for (const p of [store, join(home, '.agent-notebook', 'projects'), join(store, '.nb-usage.log')]) {
    try {
      chmodSync(p, 0o755);
    } catch {
      // never made
    }
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
    NB_ASCII: '0',
    ...extra,
  };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete out[k];
  return out;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
  ms: number;
}
function nb(args: string[], cwd: string, env: Record<string, string | undefined> = {}): Run {
  const t = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(env), encoding: 'utf-8', timeout: 20_000, killSignal: 'SIGKILL' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t };
}

function repo(name: string, origin?: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: d, env: childEnv(), stdio: 'ignore' });
  git('init', '-q');
  if (origin !== undefined) git('remote', 'add', 'origin', origin);
  return d;
}

interface StatusJson {
  schemaVersion: number;
  verdict: string;
  scope: string;
  headline: string;
  next: string;
  announce: boolean;
  problem: string | null;
  now: string;
  evidence: { lastStart: { at: string; label: string; outcome: string; version: string | null } | null; lastEnd: unknown; olderProgram: unknown; rowsRead: number; since: string | null };
  switch: { enabled: boolean; source: string };
  place: { kind: string };
  project: { name: string | null; source: string; key: string };
  notebook: { shelves: number | null; lastAddAt: string | null };
  program: { version: string; released: string | null; nodeVersion: string; platform: string };
}
function status(cwd: string, env: Record<string, string | undefined> = {}): { json: StatusJson; code: number | null } {
  const r = nb(['status', '--json'], cwd, env);
  expect(r.err).toBe('');
  return { json: JSON.parse(r.out) as StatusJson, code: r.code };
}

/** A forged usage row, 18 columns. `agoSeconds` before now. */
function rowLine(o: { agoSeconds?: number; ts?: string; command?: string; ok?: boolean; outcome?: string; label?: string; errorClass?: string; version?: string; project?: string }): string {
  const ts = o.ts ?? new Date(Date.now() - (o.agoSeconds ?? 0) * 1000).toISOString();
  return [ts, '-', o.command ?? 'brief', o.ok === false ? 'err' : 'ok', '1ms', 'sess1234', '', o.outcome ?? 'index', '', '', '', o.label ?? 'tool-a.start', o.errorClass ?? '', '', '', '0', o.version ?? '0.13.0', o.project ?? ''].join('\t');
}
function writeLog(dir: string, rows: string[]): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n');
}
const THREE_HOURS = 3 * 3600 + 30;

/** Every entry under `dir` with its type, mode and bytes, sorted. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.push(`d ${p} ${st.mode}`);
        walk(p);
      } else if (st.isFile()) out.push(`f ${p} ${st.mode} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
      else out.push(`o ${p} ${st.mode}`);
    }
  };
  walk(dir);
  return out;
}

const LINES = {
  notSeenYet: 'This check has not seen a chat in this project start the notebook on its own yet.',
  newChat: 'Start a new chat here and ask again. If it still says this, ask your assistant to look at the details below.',
  askDetails: 'Ask your assistant to look at the details below.',
  placeUnknown: "The notebook can't tell where this project's lessons are kept, so it stays closed here for now. Your lessons are safe.",
  brokenFolder: "The notebook can't be opened right now, so chats can't use it.",
  brokenLog: "The notebook can't note when a chat starts it (a file in it can't be written), so this check can't tell whether it works.",
};

describe('nb status, the built CLI (FR-STATUS-001..003)', { timeout: 120_000 }, () => {
  describe('the verdicts, as text and as JSON (golden)', () => {
    test('not_seen on a fresh notebook: the two lines, the detail block and the names group, exit 1', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const t = nb(['status'], r);
      expect(t.code).toBe(1);
      expect(t.err).toBe('');
      const lines = t.out.split('\n');
      expect(lines.slice(0, 3)).toEqual([LINES.notSeenYet, LINES.newChat, '']);
      expect(lines[3]).toBe('This shows the start step ran. It does not show that your assistant read the list or used a lesson.');
      expect(t.out).toContain('Record: no rows (the usage log is missing, empty or cannot be read)');
      expect(t.out).toContain('Notebook: 0 shelves; no lesson added in the record');
      expect(t.out).toContain('Project: name from the git remote; the key is the project name');
      expect(t.out).toContain('When nb status has not seen a chat');
      expect(t.out).toContain('\nNames and paths (remove these lines before posting publicly if they are private)\nProject name: acme-app\n');
      expect(t.out).toContain(`Folder asked: ${r}\n`);
      expect(t.out).toContain(`Notebook folder: ${store} (NB_DIR is set`);
      // the facts come before the names group, and no usage row was written
      expect(t.out.indexOf('Version:')).toBeLessThan(t.out.indexOf('Names and paths'));
      expect(existsSync(join(store, '.nb-usage.log'))).toBe(false);

      const j = status(r);
      expect(j.code).toBe(1);
      const { now, program, ...rest } = j.json;
      expect(Number.isNaN(Date.parse(now))).toBe(false);
      expect(program.platform).toBe(process.platform);
      expect(rest).toEqual({
        schemaVersion: 1,
        verdict: 'not_seen',
        scope: 'project',
        headline: LINES.notSeenYet,
        next: LINES.newChat,
        announce: false,
        problem: null,
        evidence: { lastStart: null, lastEnd: null, olderProgram: null, rowsRead: 0, since: null },
        switch: { enabled: true, source: 'default' },
        place: { kind: 'env' },
        project: { name: 'acme-app', source: 'remote', key: 'name' },
        notebook: { shelves: 0, lastAddAt: null },
      });
    });

    test('running after a real `brief --hook tool-a.session-start`, asked from a subfolder: exit 0, structure asserted', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      mkdirSync(join(r, 'sub', 'deeper'), { recursive: true });
      writeFileSync(join(store, 'build.md'), '- [+1] one lesson long enough to count\n');
      expect(nb(['brief', '--hook', 'tool-a.session-start', '--session', 'abcdef123456'], r).code).toBe(0);
      const t = nb(['status'], join(r, 'sub', 'deeper'));
      expect(t.code).toBe(0);
      const [l1, l2] = t.out.split('\n');
      expect(l1).toMatch(/^The notebook was working when a chat last started it on its own, (just now|\d+ minutes? ago)\. /);
      expect(l2).toBe('Nothing to do.');
      expect(t.out).toMatch(/ {2}start {2}tool-a\.session-start {2}(index|layered) {2}\S+ {2}session \.\.\.ef123456\n/);
      const j = status(join(r, 'sub'));
      expect(j.code).toBe(0);
      expect(j.json.verdict).toBe('running');
      expect(j.json.announce).toBe(false);
      expect(j.json.evidence.lastStart).toMatchObject({ label: 'tool-a.session-start', outcome: expect.stringMatching(/^(index|layered)$/) });
      expect(j.json.evidence.lastStart!.version).toBe(j.json.program.version);
      expect(j.json.project).toEqual({ name: 'acme-app', source: 'remote', key: 'name' });
      expect(j.json.notebook.shelves).toBe(1);
    });

    test('a repository with no remote: a subfolder shares the key of the repository folder', () => {
      const r = repo('plain');
      mkdirSync(join(r, 'sub'));
      writeLog(store, [rowLine({ agoSeconds: THREE_HOURS, project: folderKey(r) })]);
      for (const cwd of [r, join(r, 'sub')]) {
        const j = status(cwd);
        expect(j.json.verdict).toBe('running');
        expect(j.json.project.key).toBe('folder-hash');
      }
    });

    test('running from a forged start row says "3 hours ago"', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [rowLine({ agoSeconds: THREE_HOURS, project: 'acme-app' })]);
      const t = nb(['status'], r);
      expect(t.out.split('\n')[0]).toBe('The notebook was working when a chat last started it on its own, 3 hours ago. No lessons yet: they are added at the end of tasks.');
      expect(t.code).toBe(0);
    });

    test('off: the switch is off in this terminal (git config), and from the environment', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      execFileSync('git', ['config', 'nb.enabled', 'false'], { cwd: r, env: childEnv() });
      const g = nb(['status'], r);
      expect(g.code).toBe(1);
      expect(g.out.split('\n').slice(0, 2)).toEqual([
        'The notebook is switched off for this folder.',
        'It was switched off on purpose. To use it here again, ask your assistant to switch it back on.',
      ]);
      const e = status(r, { NB_ENABLED: '0' });
      expect(e.json).toMatchObject({ verdict: 'off', switch: { enabled: false, source: 'env' }, announce: false });
      expect(e.json.next).toBe('A setting on this computer switched it off, possibly set by whoever manages it. Leave it unless you set it yourself.');
    });

    test('off from the rows: the chats found the notebook switched off', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [rowLine({ agoSeconds: THREE_HOURS, outcome: 'off', project: 'acme-app' })]);
      expect(status(r).json).toMatchObject({ verdict: 'off', headline: 'Your chats here found the notebook switched off (last start 3 hours ago).' });
    });

    test.skipIf(noPerm)('place_unknown: an unreadable projects/ folder, announced', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const projects = join(home, '.agent-notebook', 'projects');
      mkdirSync(projects, { recursive: true });
      chmodSync(projects, 0o000);
      const t = nb(['status'], r, { NB_DIR: undefined });
      expect(t.code).toBe(1);
      expect(t.out.split('\n').slice(0, 2)).toEqual([LINES.placeUnknown, LINES.askDetails]);
      const j = status(r, { NB_DIR: undefined });
      expect(j.json).toMatchObject({ verdict: 'place_unknown', announce: true, place: { kind: 'unknown' } });
    });

    test.skipIf(noPerm)('broken: NB_DIR unreadable, announced and project-scoped', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      chmodSync(store, 0o000);
      const t = nb(['status'], r);
      expect(t.code).toBe(1);
      expect(t.out.split('\n').slice(0, 2)).toEqual([LINES.brokenFolder, LINES.askDetails]);
      // the shared config loader warns on stderr about the unreadable folder; stdout stays pure JSON
      expect((JSON.parse(nb(['status', '--json'], r).out) as StatusJson)).toMatchObject({ verdict: 'broken', scope: 'project', announce: true });
    });

    test('broken: NB_DIR is a file', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const file = join(tmp, 'a-file');
      writeFileSync(file, 'x');
      const t = nb(['status'], r, { NB_DIR: file });
      expect(t.out.split('\n').slice(0, 2)).toEqual([LINES.brokenFolder, LINES.askDetails]);
      expect(t.code).toBe(1);
      expect(status(r, { NB_DIR: file }).json.verdict).toBe('broken');
      expect(readFileSync(file, 'utf-8')).toBe('x');
    });

    test.skipIf(noPerm)('broken: a read-only usage log', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [rowLine({ agoSeconds: THREE_HOURS, project: 'acme-app' })]);
      chmodSync(join(store, '.nb-usage.log'), 0o444);
      const t = nb(['status'], r);
      expect(t.out.split('\n').slice(0, 2)).toEqual([LINES.brokenLog, LINES.askDetails]);
      expect(status(r).json).toMatchObject({ verdict: 'broken', announce: true });
    });

    test('broken from the rows: a start that could not open, and the notebook opens now', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [rowLine({ agoSeconds: THREE_HOURS, outcome: 'broken', project: 'acme-app' })]);
      const t = nb(['status'], r);
      expect(t.out.split('\n').slice(0, 2)).toEqual(['The notebook could not open when a chat last started it (3 hours ago).', 'It opens now: start a new chat and ask again.']);
      expect(status(r).json).toMatchObject({ verdict: 'broken', scope: 'project', announce: true });
    });
  });

  describe('read-only and never blocked', () => {
    test('the folder is byte-identical after a status, text and JSON, and no usage row is written', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeFileSync(join(store, 'build.md'), '- [+1] one lesson long enough to count\n');
      nb(['brief', '--hook', 'tool-a.session-start'], r);
      const before = [...snapshot(store), ...snapshot(home)];
      const logBefore = readFileSync(join(store, '.nb-usage.log'), 'utf-8');
      expect(nb(['status'], r).code).toBe(0);
      expect(nb(['status', '--json'], r).code).toBe(0);
      expect([...snapshot(store), ...snapshot(home)]).toEqual(before);
      expect(readFileSync(join(store, '.nb-usage.log'), 'utf-8')).toBe(logBefore);
    });

    test('a missing NB_DIR is not created, and the detail reads "0 shelves"', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const missing = join(tmp, 'not-yet');
      const homeBefore = snapshot(home);
      const t = nb(['status'], r, { NB_DIR: missing });
      expect(t.code).toBe(1);
      expect(t.out.split('\n')[0]).toBe(LINES.notSeenYet);
      expect(t.out).toContain('Notebook: 0 shelves;');
      expect(t.out).not.toContain('could not be counted');
      expect(existsSync(missing)).toBe(false);
      expect(snapshot(home)).toEqual(homeBefore);
      expect(existsSync(join(tmp, 'store', '.nb-usage.log'))).toBe(false);
    });

    test('bad usage exits 1 with a message, and writes no row either', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      for (const args of [['status', '--bogus'], ['status', '--limit', '3'], ['status', 'extra'], ['status', '--hook', 'tool-a.start']]) {
        const t = nb(args, r);
        expect(t.code, args.join(' ')).toBe(1);
        expect(t.out).toBe('');
        expect(t.err).toMatch(/^nb status: /);
      }
      const j = nb(['status', '--json', '--bogus'], r);
      expect(j.code).toBe(1);
      expect(JSON.parse(j.out)).toMatchObject({ ok: false, command: 'status', error: { class: 'bad_args' } });
      {
      }
      expect(existsSync(join(store, '.nb-usage.log'))).toBe(false);
    });

    test('it answers while .nb.lock is held, and leaves the lock alone', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      mkdirSync(join(store, '.nb.lock'));
      writeFileSync(join(store, '.nb.lock', 'owner'), `${process.pid}\n`);
      const before = snapshot(store);
      const t = nb(['status'], r);
      expect(t.code).toBe(1);
      expect(t.out.split('\n')[0]).toBe(LINES.notSeenYet);
      expect(t.ms).toBeLessThan(10_000);
      expect(snapshot(store)).toEqual(before);
    });

    test('git removed from PATH: it still answers, with a verdict and no error', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const empty = join(tmp, 'empty-bin');
      mkdirSync(empty);
      const t = nb(['status', '--json'], r, { PATH: empty });
      expect(t.err).toBe('');
      expect([0, 1]).toContain(t.code);
      const j = JSON.parse(t.out) as StatusJson;
      expect(['not_seen', 'off', 'broken', 'running', 'place_unknown']).toContain(j.verdict);
      expect(j.project.name).not.toBe('acme-app'); // no git: the remote cannot have been read
    });

    test.skipIf(isWin)('a FIFO as the usage log does not hang, and a link to /dev/zero does not either', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const fifoStore = join(tmp, 'fifo-store');
      mkdirSync(fifoStore);
      execFileSync('mkfifo', [join(fifoStore, '.nb-usage.log')]);
      const a = nb(['status', '--json'], r, { NB_DIR: fifoStore });
      expect(a.code).not.toBeNull();
      expect(a.ms).toBeLessThan(10_000);
      expect((JSON.parse(a.out) as StatusJson).verdict).toBe('broken'); // not a plain file: a row cannot be written

      const zeroStore = join(tmp, 'zero-store');
      mkdirSync(zeroStore);
      symlinkSync('/dev/zero', join(zeroStore, '.nb-usage.log'));
      const b = nb(['status', '--json'], r, { NB_DIR: zeroStore });
      expect(b.code).not.toBeNull();
      expect(b.ms).toBeLessThan(10_000);
      expect((JSON.parse(b.out) as StatusJson).verdict).toBe('broken');
    });

    test('1,000 shelves are counted, and it stays quick', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      for (let i = 0; i < 1000; i++) writeFileSync(join(store, `shelf-${i}.md`), '- [+1] a lesson\n');
      const t = nb(['status', '--json'], r);
      expect(t.ms).toBeLessThan(10_000);
      expect((JSON.parse(t.out) as StatusJson).notebook.shelves).toBe(1000);
      expect(readdirSync(store).length).toBe(1000);
    });
  });

  describe('rows that are not trusted', () => {
    test('a row with a future date, a bad label or an unknown outcome is ignored', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [
        rowLine({ ts: new Date(Date.now() + 86_400_000).toISOString(), project: 'acme-app' }),
        rowLine({ agoSeconds: THREE_HOURS, label: 'Bad Label!', project: 'acme-app' }),
        rowLine({ agoSeconds: THREE_HOURS, outcome: 'bogus', project: 'acme-app' }),
        rowLine({ agoSeconds: THREE_HOURS, project: 'Not A Key!' }),
        rowLine({ agoSeconds: THREE_HOURS, project: 'other-project' }),
        rowLine({ agoSeconds: THREE_HOURS, project: '?' }),
      ]);
      const j = status(r);
      expect(j.json.verdict).toBe('not_seen');
      expect(j.json.evidence.lastStart).toBeNull();
    });

    test('a valid row of this project, written alongside the forged ones, is the one used', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      writeLog(store, [
        rowLine({ ts: new Date(Date.now() + 86_400_000).toISOString(), project: 'acme-app', label: 'forged.later' }),
        rowLine({ agoSeconds: THREE_HOURS, project: 'acme-app', label: 'tool-a.start' }),
      ]);
      expect(status(r).json.evidence.lastStart).toMatchObject({ label: 'tool-a.start' });
    });

    test('rows from 0.12 (an unknown_subcommand, no version) give the out-of-date sentence only while no later row has a version', () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const old = rowLine({ agoSeconds: THREE_HOURS, ok: false, outcome: '', errorClass: 'unknown_subcommand', version: '', project: '' });
      writeLog(store, [old]);
      const before = nb(['status'], r);
      const [l1, l2] = before.out.split('\n');
      expect(l1).toBe(`${LINES.notSeenYet.slice(0, -5)} (it looked at the last day). Part of the notebook seemed out of date the last time a chat tried (3 hours ago).`);
      expect(l2).toBe('Ask your assistant to help you update the notebook, then start a new chat. Your lessons are safe.');
      expect(before.out).toContain('An older program answered a chat start 1 time; the last was 3 hours ago.');
      expect(status(r).json.verdict).toBe('not_seen');

      // a later row that carries a version (any project): the sentence goes away
      writeLog(store, [rowLine({ agoSeconds: 60, project: 'other-project', version: '0.13.0' })]);
      const after = nb(['status'], r);
      expect(after.out).not.toContain('out of date');
      expect(after.out.split('\n')[1]).toBe(LINES.newChat);
    });
  });

  describe.skipIf(isWin)('polled while writers append', () => {
    test('status never throws while at most 20 writers append hook rows', async () => {
      const r = repo('app', 'git@github.com:Acme/App.git');
      const writers: Promise<void>[] = [];
      for (let w = 0; w < 16; w++) {
        writers.push(
          new Promise<void>((resolve) => {
            const script = `for i in 1 2 3 4 5 6 7 8; do "${process.execPath}" "${CLI}" brief --hook tool-a.session-start --session w${w}x$i >/dev/null 2>&1; done`;
            const c = spawn('sh', ['-c', script], { cwd: r, env: childEnv(), stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' });
            c.on('close', () => resolve());
          }),
        );
      }
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const t = nb(['status', '--json'], r);
        expect(t.err).toBe('');
        expect([0, 1]).toContain(t.code);
        const j = JSON.parse(t.out) as StatusJson;
        expect(j.schemaVersion).toBe(1);
        seen.add(j.verdict);
      }
      await Promise.all(writers);
      expect([...seen].every((v) => ['not_seen', 'running'].includes(v)), [...seen].join()).toBe(true);
      expect(status(r).json.verdict).toBe('running');
    });
  });

  test('the text never prints the lesson text, a remote URL or a path in the JSON', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    writeFileSync(join(store, 'build.md'), '- [+1] SECRET-LESSON-TEXT one lesson long enough\n');
    nb(['brief', '--hook', 'tool-a.session-start'], r);
    const t = nb(['status'], r);
    const j = nb(['status', '--json'], r);
    expect(t.out).not.toContain('SECRET-LESSON-TEXT');
    expect(t.out).not.toContain('git@github.com');
    expect(j.out).not.toContain(tmp);
    expect(j.out).not.toContain(process.execPath);
    expect(t.out.split('\n').slice(0, 2).join('\n')).not.toContain(tmp);
  });

  test('the home folder is shown as ~ in the names and paths group', () => {
    const r = repo('app', 'git@github.com:Acme/App.git');
    const inHome = join(home, 'work', 'app');
    mkdirSync(inHome, { recursive: true });
    const t = nb(['status'], inHome, { NB_DIR: join(home, 'nb-store') });
    expect(t.out).toContain('Folder asked: ~/work/app\n');
    expect(t.out).toContain('Notebook folder: ~/nb-store (');
    expect(t.out).not.toContain(home);
    void r;
  });
});
