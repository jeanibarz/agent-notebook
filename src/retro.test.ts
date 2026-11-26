import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { RETRO_LESSONS } from './agent-text.js';
import { parseUsage } from './usage.js';

// Issue #538: `nb retro`, the once-per-session retrospective, ported from the
// 0.12 `nb-retrospective.sh`. These tests drive the BUILT `dist/cli.js` and the
// real old script side by side, so the claims "same text", "same sentinel" and
// "one nudge between them" are checked against the behaviour being replaced.
// Requirements: FR-RETRO-001..003.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const OLD_HOOK = join(here, '..', 'examples', 'hooks', 'claude-code', 'nb-retrospective.sh');
const DAY_MS = 86_400_000;
const isWin = process.platform === 'win32';
// The 0.12 Stop hook is a bash script; the Windows CI leg has no POSIX shell it can rely on.
const testOld = isWin ? test.skip : test;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string; // contains a space on purpose
let store: string;
let home: string;
let globalCfg: string;
let stub: string;
let plain: string; // a directory that is not in a git repository

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb retro ')));
  store = join(tmp, 'store');
  home = join(tmp, 'home');
  plain = join(tmp, 'plain');
  mkdirSync(store);
  mkdirSync(home);
  mkdirSync(plain);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
  // A stand-in for `nb` that answers `enabled` with `on`, for the old script.
  stub = join(tmp, 'nb-stub.sh');
  writeFileSync(stub, '#!/bin/sh\necho on\n', { mode: 0o755 });
});
afterEach(() => {
  try {
    chmodSync(store, 0o755);
  } catch {
    // gone already
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Env for a child: no NB_* from the developer's shell, a private store and git config. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_')) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: tmp,
    HOME: home,
    USERPROFILE: home,
    NB_DIR: store,
    ...extra,
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(name: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  return d;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function nb(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? plain,
    env: childEnv(opts.env),
    encoding: 'utf-8',
    timeout: opts.timeout ?? 20_000,
    // SIGKILL: the CLI's SIGTERM handler cannot run while the process is blocked in open(2) on a FIFO.
    killSignal: 'SIGKILL',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The 0.12 Stop hook, fed a payload with only a session id. Returns the block reason, or null when it printed nothing. */
function oldHook(session: string | undefined, opts: { cwd?: string; env?: Record<string, string> } = {}): string | null {
  const payload = session === undefined ? {} : { session_id: session };
  const r = spawnSync('bash', [OLD_HOOK], {
    cwd: opts.cwd ?? plain,
    env: childEnv({ NB_BIN: stub, ...opts.env }),
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 20_000,
  });
  expect(r.status).toBe(0);
  if (r.stdout.trim() === '') return null;
  const j = JSON.parse(r.stdout) as { decision: string; reason: string };
  expect(j.decision).toBe('block');
  return j.reason;
}

const sentinels = (): string[] => readdirSync(store).filter((n) => n.startsWith('.retro-')).sort();
const retroJson = (r: Run) => JSON.parse(r.out) as { outcome: string; text: string; session: string };

function age(path: string, days: number): void {
  const t = (Date.now() - days * DAY_MS) / 1000;
  utimesSync(path, t, t);
}

describe('nb retro sends what the 0.12 Stop hook sent (FR-RETRO-001, FR-RETRO-002)', () => {
  testOld('for a fresh session nb retro prints exactly the reason the 0.12 Stop hook blocked with, plus a newline', () => {
    const old = oldHook('parity-1', { env: { NB_DIR: join(tmp, 'old-store') } });
    const r = nb(['retro', '--session', 'parity-1']);
    expect(old).not.toBeNull();
    expect(r.code).toBe(0);
    expect(r.out).toBe(old + '\n');
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(r.err).toBe('');
  });

  testOld('with NB_RETRO_EXTRA_PROMPT in a git repository nb retro matches the 0.12 Stop hook, placeholders filled', () => {
    const proj = repo('Proj.One');
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, '\n  Project {project}, session {session}; again {project}.\n\n');
    const env = { NB_RETRO_EXTRA_PROMPT: extra };
    const old = oldHook('sess-extra', { cwd: proj, env: { ...env, NB_DIR: join(tmp, 'old-store') } });
    const r = nb(['retro', '--session', 'sess-extra'], { cwd: proj, env });
    expect(old).toBe(`${RETRO_LESSONS}\n\nProject proj.one, session sess-extra; again proj.one.`);
    expect(r.out).toBe(old + '\n');
  });

  test('the project name for {project} is asked in --work-dir before the working directory', () => {
    const workDir = repo('Proj.B');
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'project={project}');
    const r = nb(['retro', '--session', 'wd', '--work-dir', workDir], { env: { NB_RETRO_EXTRA_PROMPT: extra } });
    expect(r.out).toBe(`${RETRO_LESSONS}\n\nproject=proj.b\n`);
  });

  testOld('with NB_PROJECT_SLUG set nb retro matches the 0.12 Stop hook outside a git repository', () => {
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'slug={project} id={session}');
    const env = { NB_RETRO_EXTRA_PROMPT: extra, NB_PROJECT_SLUG: 'My Slug!' };
    const old = oldHook('sess-slug', { env: { ...env, NB_DIR: join(tmp, 'old-store') } });
    const r = nb(['retro', '--session', 'sess-slug'], { env });
    expect(old).toBe(`${RETRO_LESSONS}\n\nslug=my-slug id=sess-slug`);
    expect(r.out).toBe(old + '\n');
  });
});

describe('nb retro speaks once per session and shares the 0.12 sentinel (FR-RETRO-001)', () => {
  test('a second nb retro call for the same session prints nothing and exits 0', () => {
    const first = nb(['retro', '--session', 's1']);
    const second = nb(['retro', '--session', 's1']);
    expect(first.out).toBe(RETRO_LESSONS + '\n');
    expect(second).toMatchObject({ code: 0, out: '', err: '' });
  });

  test('nb retro --json reports outcome nudge then already, with the cleaned session', () => {
    const first = nb(['retro', '--session', 'a b', '--json']);
    const second = nb(['retro', '--session', 'a b', '--json']);
    expect(first.code).toBe(0);
    expect(retroJson(first)).toEqual({ outcome: 'nudge', text: RETRO_LESSONS, session: 'a_b' });
    expect(second.code).toBe(0);
    expect(retroJson(second)).toEqual({ outcome: 'already', text: '', session: 'a_b' });
  });

  test('the sentinel is exactly NB_DIR/.retro-<clean id>', () => {
    nb(['retro', '--session', 'abc-123_X.y']);
    expect(sentinels()).toEqual(['.retro-abc-123_X.y']);
    expect(readFileSync(join(store, '.retro-abc-123_X.y'), 'utf-8')).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  testOld('a sentinel written by the 0.12 Stop hook silences nb retro for that session', () => {
    expect(oldHook('shared-1')).not.toBeNull();
    expect(sentinels()).toEqual(['.retro-shared-1']);
    const r = nb(['retro', '--session', 'shared-1', '--json']);
    expect(retroJson(r).outcome).toBe('already');
    expect(r.code).toBe(0);
  });

  testOld('a sentinel written by nb retro silences the 0.12 Stop hook for that session', () => {
    expect(nb(['retro', '--session', 'shared-2']).out).toBe(RETRO_LESSONS + '\n');
    expect(oldHook('shared-2')).toBeNull();
  });
});

describe('nb retro cleans the session id before it becomes a file name (FR-RETRO-001)', () => {
  const cases: Array<[string, string, string]> = [
    ['dot dot slash', '../x', '.._x'],
    ['a slash', 'a/b', 'a_b'],
    ['a command substitution', '$(id)', '__id_'],
    ['a backtick', 'a`b', 'a_b'],
    ['a single quote', "a'b", 'a_b'],
    ['a double quote', 'a"b', 'a_b'],
    ['a newline', 'a\nb', 'a_b'],
    ['a non-ASCII letter', 'é', '_'],
    ['a leading dash', '-x', '_x'],
    ['an empty id', '', 'nosession'],
  ];
  for (const [label, raw, clean] of cases) {
    test(`session id cleaning: ${label} becomes ${clean} and the sentinel stays inside NB_DIR`, () => {
      const before = readdirSync(tmp).sort();
      const r = nb(['retro', '--session', raw, '--json']);
      expect(r.code).toBe(0);
      expect(retroJson(r)).toMatchObject({ outcome: 'nudge', session: clean });
      expect(sentinels()).toEqual([`.retro-${clean}`]);
      expect(readdirSync(tmp).sort()).toEqual(before);
      // A second call finds the same file: the name is stable.
      expect(retroJson(nb(['retro', '--session', raw, '--json'])).outcome).toBe('already');
    });
  }

  test('session id cleaning: a 300 character id is cut to 128 characters', () => {
    const r = nb(['retro', '--session', 'a'.repeat(300), '--json']);
    expect(retroJson(r).session).toBe('a'.repeat(128));
    expect(sentinels()).toEqual([`.retro-${'a'.repeat(128)}`]);
  });

  test('session id cleaning: a reserved device name such as CON is kept as a plain name', () => {
    if (isWin) return;
    const r = nb(['retro', '--session', 'CON', '--json']);
    expect(retroJson(r)).toMatchObject({ outcome: 'nudge', session: 'CON' });
    expect(sentinels()).toEqual(['.retro-CON']);
  });

  test('session id cleaning: a leading dash keeps the cleaned id from being read as a flag', () => {
    const r = nb(['retro', '--session', '-x']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(sentinels()).toEqual(['.retro-_x']);
  });

  testOld('session id cleaning: a UUID passes through unchanged and matches the 0.12 sentinel name', () => {
    const id = '0cd5aff4-0cda-4799-92ad-984c5bd83682';
    nb(['retro', '--session', id]);
    expect(sentinels()).toEqual([`.retro-${id}`]);
    expect(oldHook(id)).toBeNull();
  });
});

describe('nb retro respects the per-repository switch (FR-RETRO-001)', () => {
  test('NB_ENABLED=0 prints nothing, reports off, and keeps the sentinel', () => {
    const r = nb(['retro', '--session', 'off-env', '--json'], { env: { NB_ENABLED: '0' } });
    expect(r.code).toBe(0);
    expect(retroJson(r)).toEqual({ outcome: 'off', text: '', session: 'off-env' });
    expect(sentinels()).toEqual(['.retro-off-env']);
    const plainOut = nb(['retro', '--session', 'off-env2'], { env: { NB_ENABLED: '0' } });
    expect(plainOut).toMatchObject({ code: 0, out: '' });
  });

  test('git config nb.enabled false in the working directory prints nothing, reports off, and keeps the sentinel', () => {
    const off = repo('off-repo');
    git(off, 'config', 'nb.enabled', 'false');
    const r = nb(['retro', '--session', 'off-git', '--json'], { cwd: off });
    expect(r.code).toBe(0);
    expect(retroJson(r).outcome).toBe('off');
    expect(sentinels()).toEqual(['.retro-off-git']);
    // Kept: even from an on directory the session stays claimed.
    expect(retroJson(nb(['retro', '--session', 'off-git', '--json'])).outcome).toBe('already');
  });

  test('--work-dir in a repository that is off prints nothing, reports off-work-dir, and releases the sentinel', () => {
    const off = repo('off-work');
    git(off, 'config', 'nb.enabled', 'false');
    const r = nb(['retro', '--session', 'wd', '--work-dir', off, '--json']);
    expect(r.code).toBe(0);
    expect(retroJson(r)).toEqual({ outcome: 'off-work-dir', text: '', session: 'wd' });
    expect(sentinels()).toEqual([]);
    const on = repo('on-work');
    const later = nb(['retro', '--session', 'wd', '--work-dir', on, '--json']);
    expect(retroJson(later)).toMatchObject({ outcome: 'nudge', text: RETRO_LESSONS });
    expect(sentinels()).toEqual(['.retro-wd']);
  });

  test('a relative --work-dir is ignored even when it names a repository that is off', () => {
    const off = repo('off-rel');
    git(off, 'config', 'nb.enabled', 'false');
    const r = nb(['retro', '--session', 'rel', '--work-dir', 'off-rel', '--json'], { cwd: tmp });
    expect(retroJson(r).outcome).toBe('nudge');
  });

  test('a --work-dir that does not exist is ignored', () => {
    const r = nb(['retro', '--session', 'gone', '--work-dir', join(tmp, 'no-such-dir'), '--json']);
    expect(retroJson(r).outcome).toBe('nudge');
    expect(sentinels()).toEqual(['.retro-gone']);
  });
});

describe('nb retro and a broken NB_RETRO_EXTRA_PROMPT (FR-RETRO-002)', () => {
  const extraEnv = (p: string) => ({ NB_RETRO_EXTRA_PROMPT: p, NB_PROJECT_SLUG: 'proj' });

  function expectLessonsAlone(r: Run): void {
    expect(r.code).toBe(0);
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(r.err).toContain('ignoring NB_RETRO_EXTRA_PROMPT');
  }

  test('a relative NB_RETRO_EXTRA_PROMPT path sends the lessons alone with a warning', () => {
    writeFileSync(join(plain, 'extra.txt'), 'hello');
    expectLessonsAlone(nb(['retro', '--session', 'e1'], { env: extraEnv('extra.txt') }));
  });

  test('a missing NB_RETRO_EXTRA_PROMPT file sends the lessons alone with a warning', () => {
    expectLessonsAlone(nb(['retro', '--session', 'e2'], { env: extraEnv(join(tmp, 'missing.txt')) }));
  });

  test('an NB_RETRO_EXTRA_PROMPT that is a directory sends the lessons alone with a warning', () => {
    expectLessonsAlone(nb(['retro', '--session', 'e3'], { env: extraEnv(tmp) }));
  });

  test('an NB_RETRO_EXTRA_PROMPT that is a FIFO sends the lessons alone and does not hang', () => {
    if (isWin) return;
    const fifo = join(tmp, 'extra.fifo');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) return; // no mkfifo on this host
    const t0 = Date.now();
    const r = nb(['retro', '--session', 'e4'], { env: extraEnv(fifo), timeout: 8000 });
    expect(Date.now() - t0).toBeLessThan(8000);
    expectLessonsAlone(r);
  }, 15_000);

  test('an NB_RETRO_EXTRA_PROMPT file over 64 KiB sends the lessons alone with a warning', () => {
    const big = join(tmp, 'big.txt');
    writeFileSync(big, 'x'.repeat(64 * 1024 + 1));
    expectLessonsAlone(nb(['retro', '--session', 'e5'], { env: extraEnv(big) }));
  });

  test('an NB_RETRO_EXTRA_PROMPT file of exactly 64 KiB is used', () => {
    const edge = join(tmp, 'edge.txt');
    writeFileSync(edge, 'y'.repeat(64 * 1024));
    const r = nb(['retro', '--session', 'e5b'], { env: extraEnv(edge) });
    expect(r.err).toBe('');
    expect(r.out).toBe(`${RETRO_LESSONS}\n\n${'y'.repeat(64 * 1024)}\n`);
  });

  test('an NB_RETRO_EXTRA_PROMPT file with a NUL byte (UTF-16 with a BOM) sends the lessons alone with a warning', () => {
    const f = join(tmp, 'utf16.txt');
    writeFileSync(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello {project}', 'utf16le')]));
    expectLessonsAlone(nb(['retro', '--session', 'e6'], { env: extraEnv(f) }));
  });

  test('a UTF-8 byte-order mark at the start of the NB_RETRO_EXTRA_PROMPT file is not printed', () => {
    const f = join(tmp, 'bom.txt');
    writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hello {project} {session}\n')]));
    const r = nb(['retro', '--session', 'e7'], { env: extraEnv(f) });
    expect(r.err).toBe('');
    expect(r.out).toBe(`${RETRO_LESSONS}\n\nHello proj e7\n`);
    expect(r.out.includes('﻿')).toBe(false);
  });

  test('a leading ~/ in NB_RETRO_EXTRA_PROMPT expands to the home directory', () => {
    writeFileSync(join(home, 'extra.txt'), 'from home: {project}');
    const r = nb(['retro', '--session', 'e8'], { env: extraEnv('~/extra.txt') });
    expect(r.err).toBe('');
    expect(r.out).toBe(`${RETRO_LESSONS}\n\nfrom home: proj\n`);
  });

  test('the extra text is left out when the session id is empty', () => {
    const f = join(tmp, 'extra.txt');
    writeFileSync(f, 'extra');
    const r = nb(['retro', '--session', ''], { env: extraEnv(f) });
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(r.err).toBe('');
  });

  test('the extra text is left out when there is no project name (not a git repository, no NB_PROJECT_SLUG)', () => {
    const f = join(tmp, 'extra.txt');
    writeFileSync(f, 'extra');
    const r = nb(['retro', '--session', 'noproj'], { env: { NB_RETRO_EXTRA_PROMPT: f } });
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(r.err).toBe('');
  });
});

describe('nb retro sweeps old sentinels (FR-RETRO-003)', () => {
  function seed(name: string, days: number): string {
    const p = join(store, name);
    writeFileSync(p, 'x');
    age(p, days);
    return p;
  }

  test('on a nudge, .retro- files older than 7 days are removed, fresh ones and other files are kept', () => {
    seed('.retro-old', 8);
    seed('.retro-fresh', 6);
    seed('notes.txt', 30);
    seed('.retroX', 30);
    const r = nb(['retro', '--session', 'now']);
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(readdirSync(store).filter((n) => n !== '.nb-usage.log' && !n.startsWith('.nb-usage')).sort()).toEqual(
      ['.retro-fresh', '.retro-now', '.retroX', 'notes.txt'].sort(),
    );
  });

  test('NB_RETRO_TTL_DAYS=1 removes sentinels older than one day', () => {
    seed('.retro-two', 2);
    seed('.retro-half', 0.5);
    nb(['retro', '--session', 'now'], { env: { NB_RETRO_TTL_DAYS: '1' } });
    expect(sentinels()).toEqual(['.retro-half', '.retro-now']);
  });

  test('an invalid NB_RETRO_TTL_DAYS falls back to 7 days', () => {
    for (const bad of ['abc', '0', '-3', '']) {
      rmSync(store, { recursive: true, force: true });
      mkdirSync(store);
      seed('.retro-old', 8);
      seed('.retro-mid', 6);
      nb(['retro', '--session', 'now'], { env: { NB_RETRO_TTL_DAYS: bad } });
      expect(sentinels(), `TTL ${JSON.stringify(bad)}`).toEqual(['.retro-mid', '.retro-now']);
    }
  });

  test('an already call does not sweep', () => {
    nb(['retro', '--session', 'now']);
    const old = seed('.retro-old', 30);
    const r = nb(['retro', '--session', 'now', '--json']);
    expect(retroJson(r).outcome).toBe('already');
    expect(existsSync(old)).toBe(true);
  });
});

describe('nb retro fails open (FR-RETRO-001)', () => {
  test('a read-only NB_DIR still nudges on every call and exits 0', () => {
    if (isWin || isRoot) return;
    chmodSync(store, 0o555);
    for (let i = 0; i < 2; i++) {
      const r = nb(['retro', '--session', 'ro']);
      expect(r.code).toBe(0);
      expect(r.out).toBe(RETRO_LESSONS + '\n');
    }
    expect(sentinels()).toEqual([]);
  });

  test('an NB_DIR that does not exist yet is created and holds the sentinel', () => {
    const deep = join(tmp, 'not', 'yet', 'there');
    const r = nb(['retro', '--session', 'mk'], { env: { NB_DIR: deep } });
    expect(r.code).toBe(0);
    expect(r.out).toBe(RETRO_LESSONS + '\n');
    expect(existsSync(join(deep, '.retro-mk'))).toBe(true);
  });

  test('a working directory that no longer exists still nudges and exits 0', () => {
    if (isWin) return; // a process cannot sit in a removed directory there
    const gone = join(tmp, 'gone');
    mkdirSync(gone);
    const r = spawnSync('sh', ['-c', 'cd "$1" && rmdir "$1" && exec "$2" "$3" retro --session gone', 'sh', gone, process.execPath, CLI], {
      env: childEnv(),
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(RETRO_LESSONS + '\n');
    expect(sentinels()).toEqual(['.retro-gone']);
  });

  test('from a removed working directory, NB_PROJECT_SLUG still fills {project}', () => {
    if (isWin) return; // a process cannot sit in a removed directory there
    const gone = join(tmp, 'gone-slug');
    mkdirSync(gone);
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'project={project}');
    const r = spawnSync('sh', ['-c', 'cd "$1" && rmdir "$1" && exec "$2" "$3" retro --session gs', 'sh', gone, process.execPath, CLI], {
      env: childEnv({ NB_PROJECT_SLUG: 'Acme.App', NB_RETRO_EXTRA_PROMPT: extra }),
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${RETRO_LESSONS}\n\nproject=acme.app\n`);
  });
});

describe('nb retro exit codes and the usage log (FR-RETRO-001, FR-USAGE-001)', () => {
  test('a missing --session exits 1 with bad_args under --json and never 2', () => {
    const r = nb(['retro', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, command: 'retro', error: { class: 'bad_args' } });
    expect(nb(['retro']).code).toBe(1);
  });

  test('an unknown flag exits 1 and never 2', () => {
    expect(nb(['retro', '--session', 'a', '--bogus']).code).toBe(1);
  });

  test('an extra operand exits 1 and never 2', () => {
    expect(nb(['retro', '--session', 'a', 'extra']).code).toBe(1);
    expect(nb(['retro', '--session', 'a', '--', 'extra']).code).toBe(1);
  });

  test('a repeated --session exits 1 and never 2', () => {
    expect(nb(['retro', '--session', 'a', '--session', 'b']).code).toBe(1);
  });

  test('a nudge logs one retro row with outcome nudge, the cleaned session and the hook label', () => {
    nb(['retro', '--session', 'a/b', '--hook', 'Claude-Code.Stop']);
    const rows = parseUsage(store).filter((r) => r.command === 'retro');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, outcome: 'nudge', session: 'a_b', note: 'claude-code.stop' });
    const raw = readFileSync(join(store, '.nb-usage.log'), 'utf-8').trim().split('\t');
    expect(raw[2]).toBe('retro');
    expect(raw[5]).toBe('a_b');
    expect(raw[7]).toBe('nudge');
    expect(raw[11]).toBe('claude-code.stop');
  });

  test('an already call adds no usage row', () => {
    nb(['retro', '--session', 'once', '--hook', 'claude-code.stop']);
    nb(['retro', '--session', 'once', '--hook', 'claude-code.stop']);
    nb(['retro', '--session', 'once', '--hook', 'claude-code.stop']);
    expect(parseUsage(store).filter((r) => r.command === 'retro')).toHaveLength(1);
  });

  test('an off call logs a retro row with outcome off', () => {
    nb(['retro', '--session', 'offrow'], { env: { NB_ENABLED: 'off' } });
    const rows = parseUsage(store).filter((r) => r.command === 'retro');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'off', session: 'offrow' });
  });
});

describe('nb retro under concurrency (FR-RETRO-001)', () => {
  // A launcher that waits until a barrier file exists, then runs the command it
  // was given with its stdin passed through. All launchers are already running
  // when the barrier is lifted, so the commands start at nearly the same moment.
  const gateSrc = [
    "const { existsSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [barrier, cmd, ...args] = process.argv.slice(1);',
    'while (!existsSync(barrier)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);',
    "const r = spawnSync(cmd, args, { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
  ].join('\n');

  interface Done {
    code: number | null;
    out: string;
  }

  function gated(barrier: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Done> {
    return new Promise((resolveDone, reject) => {
      const child = spawn(process.execPath, ['-e', gateSrc, barrier, cmd, ...args], {
        cwd: plain,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => resolveDone({ code, out }));
      child.stdin.end(input ?? '');
    });
  }

  const newCmd = (session: string): [string, string[]] => [process.execPath, [CLI, 'retro', '--session', session]];
  const oldCmd = (session: string): [string, string[], string] => ['bash', [OLD_HOOK], JSON.stringify({ session_id: session })];

  async function release(barrier: string, runs: Array<Promise<Done>>): Promise<Done[]> {
    // Let every launcher reach its wait loop first, then lift the barrier.
    await new Promise((r) => setTimeout(r, 600));
    writeFileSync(barrier, '');
    return Promise.all(runs);
  }

  const nonEmpty = (ds: Done[]) => ds.filter((d) => d.out.trim() !== '');

  test('30 parallel nb retro processes for one session yield exactly one nudge', async () => {
    const barrier = join(tmp, 'barrier');
    const env = childEnv();
    const [cmd, args] = newCmd('same');
    const done = await release(
      barrier,
      Array.from({ length: 30 }, () => gated(barrier, cmd, args, env)),
    );
    expect(done.every((d) => d.code === 0)).toBe(true);
    expect(nonEmpty(done)).toHaveLength(1);
    expect(nonEmpty(done)[0]!.out).toBe(RETRO_LESSONS + '\n');
    expect(sentinels()).toEqual(['.retro-same']);
  }, 60_000);

  testOld('10 runs of the 0.12 Stop hook and 10 runs of nb retro on one session yield exactly one nudge in total', async () => {
    const barrier = join(tmp, 'barrier');
    const env = childEnv({ NB_BIN: stub });
    const runs: Array<Promise<Done>> = [];
    for (let i = 0; i < 10; i++) {
      const [c1, a1, in1] = oldCmd('mixed');
      runs.push(gated(barrier, c1, a1, env, in1));
      const [c2, a2] = newCmd('mixed');
      runs.push(gated(barrier, c2, a2, env));
    }
    const done = await release(barrier, runs);
    expect(done.every((d) => d.code === 0)).toBe(true);
    expect(nonEmpty(done)).toHaveLength(1);
    expect(sentinels()).toEqual(['.retro-mixed']);
  }, 60_000);

  testOld('a pre-existing sentinel yields zero nudges from parallel old and new callers', async () => {
    writeFileSync(join(store, '.retro-taken'), 'x');
    const barrier = join(tmp, 'barrier');
    const env = childEnv({ NB_BIN: stub });
    const runs: Array<Promise<Done>> = [];
    for (let i = 0; i < 6; i++) {
      const [c1, a1, in1] = oldCmd('taken');
      runs.push(gated(barrier, c1, a1, env, in1));
      const [c2, a2] = newCmd('taken');
      runs.push(gated(barrier, c2, a2, env));
    }
    const done = await release(barrier, runs);
    expect(done.every((d) => d.code === 0)).toBe(true);
    expect(nonEmpty(done)).toHaveLength(0);
  }, 60_000);

  test('30 distinct sessions in parallel yield 30 nudges and 30 sentinels', async () => {
    const barrier = join(tmp, 'barrier');
    const env = childEnv();
    const done = await release(
      barrier,
      Array.from({ length: 30 }, (_, i) => {
        const [cmd, args] = newCmd(`sess-${i}`);
        return gated(barrier, cmd, args, env);
      }),
    );
    expect(done.every((d) => d.code === 0)).toBe(true);
    expect(nonEmpty(done)).toHaveLength(30);
    expect(sentinels()).toHaveLength(30);
  }, 60_000);
});
