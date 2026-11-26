import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, unlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { isWindowsDeviceName, resolvePlace, sharedWriteRefusal, type Place } from './place.js';
import { setCallNoCreateDir, withLock } from './notebook.js';
import type { ProjectState } from './project.js';

// Issue #548 (FR-PLACE-001, -002, -004): a project has its own notebook when
// `~/.agent-notebook/projects/<project>/` exists; otherwise the shared notebook.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string; // contains a space on purpose
let home: string;
let projects: string;
let shared: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb place ')));
  home = join(tmp, 'home');
  projects = join(home, '.agent-notebook', 'projects');
  shared = join(home, '.agent-notebook', 'notebooks');
  mkdirSync(home, { recursive: true });
});
afterEach(() => {
  try {
    chmodSync(projects, 0o755);
  } catch {
    // never made unreadable, or gone
  }
  rmSync(tmp, { recursive: true, force: true });
});

const st = (over: Partial<ProjectState> = {}): ProjectState => ({
  name: 'acme-app',
  source: 'remote',
  reason: 'git remote origin',
  oldName: '',
  bare: false,
  undetermined: false,
  ...over,
});

/** resolvePlace with this test's home, a fake project resolver that counts its calls, and the real uid. */
function place(env: NodeJS.ProcessEnv = {}, project: ProjectState = st(), cwd: string | null = tmp, uid?: number | null) {
  let asked = 0;
  const p = resolvePlace({ ...env }, cwd, {
    home,
    project: () => {
      asked++;
      return project;
    },
    ...(uid !== undefined ? { uid } : {}),
  });
  return { p, asked };
}

describe('resolvePlace: the rule, first match wins (FR-PLACE-001)', () => {
  // notebooksDir() reads process.env; the resolver's own env is what decides the kind.
  const saved = { NB_DIR: process.env.NB_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  beforeEach(() => {
    delete process.env.NB_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('NB_DIR set: env, and neither projects/ nor the project name is read', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    process.env.NB_DIR = join(tmp, 'mine');
    const { p, asked } = place({ NB_DIR: join(tmp, 'mine') });
    expect(p).toMatchObject({ kind: 'env', dir: join(tmp, 'mine'), folders: [], project: null });
    expect(asked).toBe(0);
  });

  test('no projects/ folder: shared, and the project name is never asked (AC2)', () => {
    const { p, asked } = place();
    expect(p).toMatchObject({ kind: 'shared', dir: shared, folders: [], reason: 'no project folders' });
    expect(asked).toBe(0);
  });

  test.each([
    ['empty', () => mkdirSync(projects, { recursive: true })],
    ['a file only', () => (mkdirSync(projects, { recursive: true }), writeFileSync(join(projects, 'acme-app'), ''))],
    ['dot-entries only', () => (mkdirSync(join(projects, '.DS_Store'), { recursive: true }), mkdirSync(join(projects, '.new-acme-app-1')))],
    ['names nb never produces', () => ['Acme-App', 'a b', 'a..b', '-x', 'é'].forEach((n) => mkdirSync(join(projects, n), { recursive: true }))],
    ['Windows device names', () => ['con', 'nul.x', 'com1', 'lpt9.tar.gz', 'aux'].forEach((n) => mkdirSync(join(projects, n), { recursive: true }))],
  ])('projects/ with %s: shared, and the project name is never asked', (_label, make) => {
    make();
    const { p, asked } = place();
    expect(p).toMatchObject({ kind: 'shared', folders: [] });
    expect(asked).toBe(0);
  });

  test('projects/ as a file: shared', () => {
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    writeFileSync(projects, '');
    expect(place().p).toMatchObject({ kind: 'shared', folders: [] });
  });

  test.skipIf(isWin || isRoot)('an unreadable projects/: unknown, never shared', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    chmodSync(projects, 0o000);
    const { p } = place();
    expect(p.kind).toBe('unknown');
    expect(p.dir).toBeNull();
    expect(p.reason).toContain('could not be read (EACCES)');
  });

  test.each<[string, Partial<ProjectState>]>([
    ['the remote', {}],
    ['NB_PROJECT_SLUG', { source: 'env', reason: 'env NB_PROJECT_SLUG' }],
  ])('a name from %s that names a folder: own', (_label, over) => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    mkdirSync(join(projects, 'beta'), { recursive: true });
    const { p, asked } = place({}, st(over));
    expect(p).toMatchObject({ kind: 'own', dir: join(projects, 'acme-app'), folders: ['acme-app', 'beta'] });
    expect(asked).toBe(1);
  });

  test.each<[string, Partial<ProjectState>, string]>([
    ['a name from the folder (AC4: a fresh clone may not share it)', { source: 'folder', reason: 'folder' }, 'is named from its folder'],
    ['a bare repository', { bare: true }, 'is a bare repository'],
    ['no name', { name: '', source: 'none', reason: 'not in a git repository, or git refused this folder' }, 'no project name'],
    ['git not found', { name: '', source: 'none', reason: 'git not found' }, 'no project name (git not found)'],
    ['another name', { name: 'other' }, 'project other (git remote origin) has no own notebook'],
  ])('%s: shared', (_label, over, reason) => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const { p } = place({}, st({ ...over, name: over.name ?? 'acme-app' }));
    expect(p.kind).toBe('shared');
    expect(p.dir).toBe(shared);
    expect(p.reason).toContain(reason);
  });

  test('git could not answer (undetermined): unknown', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const { p } = place({}, st({ name: '', source: 'none', reason: 'git timed out', undetermined: true }));
    expect(p).toMatchObject({ kind: 'unknown', dir: null, reason: 'git timed out' });
  });

  test('a removed working directory with no slug: unknown, and git is not asked', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const { p, asked } = place({}, st(), null);
    expect(p).toMatchObject({ kind: 'unknown', reason: 'the working directory no longer exists' });
    expect(asked).toBe(0);
  });

  test.skipIf(isWin)('the project name matching a symlink, or a folder of another user: unknown, never a silent shared', () => {
    mkdirSync(join(projects, 'beta'), { recursive: true });
    mkdirSync(join(tmp, 'elsewhere'));
    symlinkSync(join(tmp, 'elsewhere'), join(projects, 'acme-app'));
    expect(place().p).toMatchObject({ kind: 'unknown', reason: 'projects/acme-app is a symbolic link', folders: ['beta'] });
    unlinkSync(join(projects, 'acme-app'));
    mkdirSync(join(projects, 'acme-app'));
    expect(place({}, st(), tmp, 999_999).p).toMatchObject({ kind: 'unknown', reason: 'projects/acme-app is owned by another user' });
    expect(place({}, st(), tmp).p.kind).toBe('own');
  });

  test.skipIf(isWin)('every folder failing the check (another owner): the name is still asked, and a match is unknown', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const { p, asked } = place({}, st(), tmp, 999_999);
    expect(p).toMatchObject({ kind: 'unknown', reason: 'projects/acme-app is owned by another user', folders: [] });
    expect(asked).toBe(1);
    expect(place({}, st({ name: 'other' }), tmp, 999_999).p).toMatchObject({ kind: 'shared' });
  });

  test('1,000 project folders: one readdir, the list complete and sorted (AC3)', () => {
    const names = Array.from({ length: 1000 }, (_, i) => `p${String(i).padStart(4, '0')}`);
    for (const n of names) mkdirSync(join(projects, n), { recursive: true });
    const { p } = place({}, st({ name: 'p0500' }));
    expect(p.kind).toBe('own');
    expect(p.folders).toEqual(names);
  });
});

describe('isWindowsDeviceName', () => {
  test.each([
    ['con', true],
    ['CON', true],
    ['nul.txt', true],
    ['com1', true],
    ['lpt9.tar.gz', true],
    ['aux', true],
    ['prn', true],
    ['com0', false],
    ['console', false],
    ['acme-con', false],
    ['nul-x', false],
  ])('%s → %s', (name, yes) => {
    expect(isWindowsDeviceName(name)).toBe(yes);
  });
});

describe('sharedWriteRefusal: the write guard (FR-PLACE-001)', () => {
  const base: Place = {
    kind: 'shared',
    dir: '/s',
    shared: '/s',
    projectsDir: '/h/.agent-notebook/projects',
    project: null,
    reason: 'no project name (git not found)',
    folders: ['acme-app'],
  };
  const own: Place = { ...base, kind: 'own', dir: '/h/.agent-notebook/projects/acme-app', project: st(), reason: 'own' };

  test.each<[string, Place, string[], boolean]>([
    ['add of a project shelf from shared', base, ['add', 'x@acme-app', 'l'], true],
    ['vote', base, ['vote', 'x@acme-app', 'abc123', '+1'], true],
    ['merge', base, ['merge', 'x@acme-app', 'a', 'b', 'm'], true],
    ['split', base, ['split', 'x@acme-app', 'a', 'l1', 'l2'], true],
    ['describe with text', base, ['describe', 'x@acme-app', 'text'], true],
    ['describe that only reads', base, ['describe', 'x@acme-app'], false],
    ['move INTO a project shelf', base, ['move', 'general', 'x@acme-app', 'abc'], true],
    ['move OUT of a project shelf (repair)', base, ['move', 'x@acme-app', 'general', 'abc'], false],
    ['rm (repair)', base, ['rm', 'x@acme-app', 'abc'], false],
    ['show', base, ['show', 'x@acme-app'], false],
    ['an unscoped shelf', base, ['add', 'general', 'l'], false],
    ['a project with no folder', base, ['add', 'x@beta', 'l'], false],
    ['the suffix is the last @', base, ['add', 'x@acme-app@beta', 'l'], false],
    ['own of the same project', own, ['add', 'x@acme-app', 'l'], false],
    ['the suffix in another letter case, from shared', base, ['add', 'x@Acme-App', 'l'], true],
    ['the suffix in another letter case, from own of that project', own, ['add', 'x@ACME-APP', 'l'], false],
    ['own of another project', { ...own, folders: ['acme-app', 'beta'] }, ['add', 'x@beta', 'l'], true],
    ['NB_DIR set', { ...base, kind: 'env', folders: [] }, ['add', 'x@acme-app', 'l'], false],
  ])('%s', (_label, p, args, refused) => {
    const r = sharedWriteRefusal(p, args);
    expect(r !== null).toBe(refused);
    if (r !== null) {
      expect(r).toContain('belongs to the project');
      expect(r).toContain('Nothing was written.');
    }
  });
});

describe('the no-re-create switch (issue #548)', () => {
  test('while set, withLock refuses on a removed own folder and does not create it; unset, it creates it as before', async () => {
    const gone = join(tmp, 'gone');
    setCallNoCreateDir(gone);
    try {
      await expect(withLock(gone, () => 1)).rejects.toMatchObject({ errorClass: 'place_unknown' });
      expect(existsSync(gone)).toBe(false);
    } finally {
      setCallNoCreateDir(undefined);
    }
    expect(await withLock(gone, () => 2)).toBe(2);
    expect(existsSync(gone)).toBe(true);
  });
});

// ---- The built CLI on real repositories -------------------------------------

// Each test spawns git and nb many times: slow on a loaded macOS or Windows runner, so the
// time limit is raised (not a timing assertion).
describe('nb with project folders, through the built CLI (FR-PLACE-001, -002, -004)', { timeout: 60_000 }, () => {
  let globalCfg: string;
  beforeEach(() => {
    globalCfg = join(tmp, 'global.gitconfig');
    writeFileSync(globalCfg, '');
  });

  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
    return {
      ...env,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: tmp,
      NB_ASCII: '0',
      ...extra,
    };
  }
  function nb(args: string[], cwd: string, extra: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(extra), encoding: 'utf-8', timeout: 20_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf-8' });
  }
  function repo(name: string, origin?: string): string {
    const d = join(tmp, name);
    mkdirSync(d, { recursive: true });
    git(d, 'init', '-q');
    git(d, 'config', 'user.email', 't@t');
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'commit.gpgsign', 'false');
    if (origin !== undefined) git(d, 'remote', 'add', 'origin', origin);
    return d;
  }
  const shelves = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
  const json = (r: { out: string }) => JSON.parse(r.out);

  /** A `git` on PATH that logs its arguments, then runs the real one. */
  function gitLogger(): { env: Record<string, string>; calls: () => string[] } {
    const bin = join(tmp, 'logbin');
    const log = join(tmp, 'git-calls.log');
    mkdirSync(bin, { recursive: true });
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    writeFileSync(log, '');
    return {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
      calls: () => readFileSync(log, 'utf-8').split('\n').filter((l) => l !== '' && !l.includes('nb.enabled')),
    };
  }

  test.skipIf(isWin)('no projects/ folder, an empty one or a file: no git is started for the place, and the output is that of NB_DIR=<default> (AC2)', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const g = gitLogger();
    // `brief` is left out of the count: with a project shelf it asks the name itself (#540, FR-BRIEF-003).
    const cmds = [['add', 'x@acme-app', 'a lesson'], ['list'], ['show', 'x@acme-app'], ['path'], ['config'], ['vote', 'x@acme-app', 'a lesson', '+1']];
    for (const setup of [() => {}, () => mkdirSync(projects, { recursive: true }), () => writeFileSync(join(projects, 'notes.txt'), '')]) {
      setup();
      const seen = g.calls().length;
      for (const c of cmds) {
        const implicit = nb(c, r, g.env);
        expect(implicit.code, c.join(' ')).toBe(0);
      }
      expect(g.calls().slice(seen)).toEqual([]);
      for (const c of [['list'], ['show', 'x@acme-app'], ['path'], ['brief']]) {
        expect(nb(c, r, g.env)).toEqual(nb(c, r, { ...g.env, NB_DIR: shared }));
      }
    }
  });

  test('NB_DIR set: project folders are ignored, every output is the same with or without them (AC1)', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const mine = join(tmp, 'mine');
    const env = { NB_DIR: mine };
    nb(['add', 'x@acme-app', 'a lesson'], r, env);
    const before = [['list'], ['show', 'x@acme-app'], ['path'], ['brief'], ['config']].map((c) => nb(c, r, env));
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const after = [['list'], ['show', 'x@acme-app'], ['path'], ['brief'], ['config']].map((c) => nb(c, r, env));
    expect(after).toEqual(before);
    expect(nb(['add', 'y@acme-app', 'another'], r, env).code).toBe(0);
    expect(shelves(join(projects, 'acme-app'))).toEqual([]);
    expect(shelves(mine)).toEqual(['x@acme-app.md', 'y@acme-app.md']);
  });

  test('the checkout, a linked worktree, a subfolder and a fresh clone with the same URL all write to one own folder (AC4)', () => {
    const main = repo('main', 'git@github.com:acme/app.git');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', join(tmp, 'wt with space'));
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    git(tmp, 'clone', '-q', main, join(tmp, 'other name'));
    git(join(tmp, 'other name'), 'remote', 'set-url', 'origin', 'https://github.com/acme/app.git');
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const dirs = [main, join(tmp, 'wt with space'), join(main, 'src', 'deep'), join(tmp, 'other name')];
    dirs.forEach((d, i) => expect(nb(['add', 'x@acme-app', `lesson number ${i}`], d).code, d).toBe(0));
    for (const d of dirs) expect(nb(['path'], d).out, d).toBe(join(projects, 'acme-app') + '\n');
    expect(nb(['show', 'x@acme-app'], main).out.match(/lesson number/g)).toHaveLength(4);
    expect(shelves(shared)).toEqual([]);
  });

  test('a clone from a local path is named from its folder, so it uses the shared notebook, and the guard keeps the project shelves out of it', () => {
    const main = repo('main', 'git@github.com:acme/app.git');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(tmp, 'clone', '-q', main, join(tmp, 'local clone'));
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const c = join(tmp, 'local clone');
    expect(json(nb(['place', '--json'], c))).toMatchObject({ kind: 'shared', project: { name: 'local-clone', source: 'folder' } });
    const r = nb(['add', 'x@acme-app', 'misplaced'], c, {});
    expect(r.code).toBe(1);
    expect(r.err).toContain('x@acme-app belongs to the project acme-app, which has its own notebook');
    expect(shelves(shared)).toEqual([]);
  });

  test('own: the project writes and reads only its folder; other directories see the shared notebook and a count', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    nb(['add', 'general', 'a shared lesson'], plain);
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    expect(nb(['add', 'build@acme-app', 'an own lesson'], r).code).toBe(0);
    expect(nb(['add', 'testing', 'unscoped, still own'], r).code).toBe(0);
    expect(shelves(join(projects, 'acme-app'))).toEqual(['build@acme-app.md', 'testing.md']);
    expect(shelves(shared)).toEqual(['general.md']);
    expect(nb(['show', 'general'], r).err).toContain('no notebook for shelf "general"');
    // brief: one added line, after the framing line.
    const own = nb(['brief'], r).out;
    expect(own).toContain(`\nLessons for acme-app go to its own notebook (${join(projects, 'acme-app')}); it does not include the shared notebook's general shelves.\n`);
    expect(own).not.toContain('  general');
    const other = nb(['brief'], plain).out;
    expect(other).toContain("\n1 project has its own notebook; this one uses the shared notebook (`nb place` says why).\n");
    expect(other).not.toContain('acme-app');
    // The usage log follows the folder.
    expect(existsSync(join(projects, 'acme-app', '.nb-usage.log'))).toBe(true);
  });

  test('nb place: the four forms, plain and --json (golden)', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    expect(nb(['place'], r).out).toBe(`shared: ${shared}\n  no project folders.\nproject folders: none (in ${projects})\n`);
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    mkdirSync(join(projects, 'beta'), { recursive: true });
    expect(nb(['place'], r)).toEqual({
      code: 0,
      out:
        `own: ${join(projects, 'acme-app')}\n` +
        "  project acme-app (git remote origin) has its own notebook. It is kept on this computer, separate from the notebook your other projects share, and does not include that notebook's general shelves.\n" +
        'project folders (2): acme-app, beta\n',
      err: '',
    });
    expect(json(nb(['place', '--json'], r))).toEqual({
      kind: 'own',
      dir: join(projects, 'acme-app'),
      shared,
      project: { name: 'acme-app', source: 'remote', reason: 'git remote origin' },
      reason: 'project acme-app (git remote origin) has its own notebook',
      folders: [
        { name: 'acme-app', dir: join(projects, 'acme-app') },
        { name: 'beta', dir: join(projects, 'beta') },
      ],
    });
    expect(nb(['place'], plain).out).toBe(
      `shared: ${shared}\n  no project name (not in a git repository, or git refused this folder).\nproject folders (2): acme-app, beta\n`,
    );
    expect(nb(['place'], r, { NB_DIR: shared }).out).toBe(
      `env: ${shared}\n  NB_DIR is set, so project folders are not used. To use them, unset NB_DIR, or set NB_DIR for one project only.\n` +
        '  NB_DIR is the default path: if you did not set it, a copied nb-git-wrapper from nb 0.12 may set it; update the wrapper.\n',
    );
    expect(nb(['place', 'extra'], r).code).toBe(1);
  });

  test('git refusing the folder (safe.directory) with a project folder: every notebook command refuses, brief and place say why', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const refuse = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
    for (const c of [['add', 'general', 'x'], ['list'], ['show', 'general'], ['path'], ['stats']]) {
      const out = nb([...c, '--json'], r, refuse);
      expect(out.code, c.join(' ')).toBe(1);
      expect(json(out).error.class).toBe('place_unknown');
      expect(out.err).toContain('could not tell which notebook this project uses (git refused this folder (safe.directory)); your lessons are untouched');
    }
    expect(shelves(shared)).toEqual([]);
    expect(shelves(join(projects, 'acme-app'))).toEqual([]);
    const b = nb(['brief', '--json'], r, refuse);
    expect(b.code).toBe(0);
    expect(json(b).outcome).toBe('broken');
    expect(json(b).text).toContain('agent-notebook could not tell which notebook this project uses (git refused this folder (safe.directory)), so no lessons are shown');
    expect(nb(['place'], r, refuse)).toMatchObject({ code: 0, out: expect.stringMatching(/^unknown: git refused this folder \(safe\.directory\)\n/) });
    // The refused calls are logged in the shared notebook's usage log.
    expect(readFileSync(join(shared, '.nb-usage.log'), 'utf-8')).toContain('place_unknown');
  });

  test.skipIf(isWin)('git missing with a project folder: the shared notebook still works, and the project shelves are refused there', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const bin = join(tmp, 'nogit');
    mkdirSync(bin);
    const noGit = { PATH: bin };
    const run = (args: string[]) => {
      const p = spawnSync(process.execPath, [CLI, ...args], { cwd: r, env: childEnv(noGit), encoding: 'utf-8', timeout: 20_000 });
      return { code: p.status, out: p.stdout, err: p.stderr };
    };
    expect(run(['add', 'general', 'works without git']).code).toBe(0);
    expect(run(['add', 'x@acme-app', 'refused']).code).toBe(1);
    expect(run(['place']).out).toContain('no project name (git not found)');
    expect(shelves(shared)).toEqual(['general.md']);
  });

  test('the retrospective marker stays in the shared notebook for an own project, so a session is asked once across a cd', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    expect(json(nb(['retro', '--session', 's1', '--json'], r)).outcome).toBe('nudge');
    expect(json(nb(['retro', '--session', 's1', '--json'], plain)).outcome).toBe('already');
    expect(existsSync(join(shared, '.retro-s1'))).toBe(true);
    expect(readdirSync(join(projects, 'acme-app')).filter((f) => f.startsWith('.retro-'))).toEqual([]);
  });

  test('hostile entries under projects/ are never folders, and nb place prints none of them', () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    const hostile = ['a b', "o'q", 'd$x', 'b`t', 'é', '..x', 'x'.repeat(200), 'CON', 'con', 'nul.md'];
    if (!isWin) hostile.push('new\nline', 'esc\u001b[31m');
    for (const n of hostile) mkdirSync(join(projects, n), { recursive: true });
    mkdirSync(join(projects, 'acme-app'));
    const out = nb(['place'], r).out;
    expect(out).toContain('project folders (1): acme-app\n');
    for (const n of hostile) if (n !== 'con') expect(out).not.toContain(n);
    expect(out).not.toContain('\u001b');
  });

  test.skipIf(isWin)('20 parallel adds from the project, with no lost or torn line [timing]', { timeout: 60_000 }, async () => {
    const r = repo('app', 'git@github.com:acme/app.git');
    mkdirSync(join(projects, 'acme-app'), { recursive: true });
    const codes = await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) =>
          new Promise<number | null>((res) => {
            const p = spawn(process.execPath, [CLI, 'add', 'x@acme-app', `parallel lesson ${i}`], { cwd: r, env: childEnv(), stdio: 'ignore' });
            p.on('close', res);
          }),
      ),
    );
    expect(codes.every((c) => c === 0)).toBe(true);
    const text = readFileSync(join(projects, 'acme-app', 'x@acme-app.md'), 'utf-8');
    for (let i = 0; i < 20; i++) expect(text).toContain(`parallel lesson ${i}\n`);
    expect(shelves(shared)).toEqual([]);
  });
});
