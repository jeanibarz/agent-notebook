import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, renameSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { isNbOwnFile, linkAll, placeOwn, placeShared, sharedBlockers, unlinkSame } from './place-ops.js';

// Issue #548, FR-PLACE-003: `nb place own` and `nb place shared` move whole shelf
// files between the shared notebook and ~/.agent-notebook/projects/<project>/.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const WRAPPER = join(here, '..', 'examples', 'nb-git-wrapper.mjs');
const isWin = process.platform === 'win32';

let tmp: string;
let home: string;
let projects: string;
let shared: string;
let own: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb place ops ')));
  home = join(tmp, 'home');
  projects = join(home, '.agent-notebook', 'projects');
  shared = join(home, '.agent-notebook', 'notebooks');
  own = join(projects, 'acme-app');
  mkdirSync(shared, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const shelves = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []);
const SHELF = '# desc: open when building\n+3 build with npm run build\n+1 run one test file at a time\n';

describe('placeOwn and placeShared (FR-PLACE-003)', () => {
  test('own creates the folder (0700), moves only the project shelves byte for byte, and leaves no staging folder', async () => {
    writeFileSync(join(shared, 'build@acme-app.md'), SHELF);
    writeFileSync(join(shared, 'review@acme-app.md'), '+1 one lesson\n');
    writeFileSync(join(shared, 'review@other.md'), '+1 not ours\n');
    writeFileSync(join(shared, 'testing.md'), '+1 general\n');
    const r = await placeOwn(shared, projects, 'acme-app');
    expect(r).toMatchObject({ dir: own, created: true, moved: ['build@acme-app', 'review@acme-app'], kept: [], lessons: 3 });
    expect(shelves(own)).toEqual(['build@acme-app.md', 'review@acme-app.md']);
    expect(readFileSync(join(own, 'build@acme-app.md'), 'utf-8')).toBe(SHELF);
    expect(shelves(shared)).toEqual(['review@other.md', 'testing.md']);
    expect(readdirSync(projects)).toEqual(['acme-app']);
    if (!isWin) expect(statSync(own).mode & 0o777).toBe(0o700);
  });

  test('own with nothing to move still creates the folder; run again it moves what is left and keeps a name already there', async () => {
    expect(await placeOwn(shared, projects, 'acme-app')).toMatchObject({ created: true, moved: [] });
    writeFileSync(join(shared, 'late@acme-app.md'), '+1 written before the rename\n');
    writeFileSync(join(shared, 'dup@acme-app.md'), '+1 shared copy\n');
    writeFileSync(join(own, 'dup@acme-app.md'), '+1 own copy\n');
    const r = await placeOwn(shared, projects, 'acme-app');
    expect(r).toMatchObject({ created: false, moved: ['late@acme-app'], kept: [{ shelf: 'dup@acme-app', why: 'a shelf of that name is already there' }] });
    expect(readFileSync(join(own, 'dup@acme-app.md'), 'utf-8')).toBe('+1 own copy\n');
    expect(readFileSync(join(shared, 'dup@acme-app.md'), 'utf-8')).toBe('+1 shared copy\n');
  });

  test('own removes a staging folder of a dead process, and never one of a live process', async () => {
    mkdirSync(join(projects, '.new-acme-app-2147483646'), { recursive: true });
    writeFileSync(join(projects, '.new-acme-app-2147483646', 'x@acme-app.md'), '+1 a copy\n');
    mkdirSync(join(projects, `.new-acme-app-${process.ppid}`));
    await placeOwn(shared, projects, 'acme-app');
    expect(readdirSync(projects).sort()).toEqual([`.new-acme-app-${process.ppid}`, 'acme-app']);
  });

  test('shared moves every shelf back, removes nb files and the folder; refuses clashes and foreign files', async () => {
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'build@acme-app.md'), SHELF);
    writeFileSync(join(own, 'testing.md'), '+1 unscoped, written in the project\n');
    writeFileSync(join(own, '.nb-usage.log'), 'x\n');
    writeFileSync(join(own, '.nb-usage.log.count'), '1');
    expect(sharedBlockers(shared, own)).toEqual({ foreign: [], clashes: [] });
    const r = await placeShared(shared, own);
    expect(r).toMatchObject({ moved: ['build@acme-app', 'testing'], kept: [], removed: true, lessons: 3 });
    expect(existsSync(own)).toBe(false);
    expect(readFileSync(join(shared, 'build@acme-app.md'), 'utf-8')).toBe(SHELF);
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'testing.md'), '+1 clash\n');
    mkdirSync(join(own, '.git'));
    writeFileSync(join(own, '.nb.json'), '{}');
    expect(sharedBlockers(shared, own)).toEqual({ foreign: ['.git', '.nb.json'], clashes: ['testing'] });
  });

  test('a source replaced after it was linked (a write under a stolen lock) is not unlinked: its lesson stays, reported', () => {
    mkdirSync(own, { recursive: true });
    writeFileSync(join(shared, 'a@acme-app.md'), '+1 linked\n');
    writeFileSync(join(shared, 'b@acme-app.md'), '+1 linked too\n');
    const kept: { shelf: string; why: string }[] = [];
    const linked = linkAll(shared, own, ['a@acme-app', 'b@acme-app'], kept);
    // The way nb writes a shelf: a temporary file renamed over it, so a new inode.
    writeFileSync(join(shared, 'a@acme-app.md.tmp'), '+1 linked\n+1 written meanwhile\n');
    renameSync(join(shared, 'a@acme-app.md.tmp'), join(shared, 'a@acme-app.md'));
    expect(unlinkSame(shared, linked, kept)).toEqual(['b@acme-app']);
    expect(kept).toEqual([{ shelf: 'a@acme-app', why: 'it changed during the move; run the command again' }]);
    expect(readFileSync(join(shared, 'a@acme-app.md'), 'utf-8')).toContain('written meanwhile');
    expect(existsSync(join(shared, 'b@acme-app.md'))).toBe(false);
  });

  test.each([
    ['.nb-usage.log', true],
    ['.nb-usage.log.count', true],
    ['.nb-usage.log.123.tmp', true],
    ['.retro-abc', true],
    ['x@y.md.42.tmp', true],
    ['.nb.json', false],
    ['.git', false],
    ['notes.txt', false],
    ['x.md', false],
  ])('isNbOwnFile(%s) is %s', (name, yes) => {
    expect(isNbOwnFile(name)).toBe(yes);
  });
});

describe('nb place own / shared through the built CLI (FR-PLACE-003)', { timeout: 60_000 }, () => {
  let globalCfg: string;
  let repo: string;
  beforeEach(() => {
    globalCfg = join(tmp, 'global.gitconfig');
    writeFileSync(globalCfg, '');
    repo = join(tmp, 'app');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
  });
  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
    return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, NB_ASCII: '0', ...extra };
  }
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf-8' });
  }
  function nb(args: string[], cwd = repo, extra: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(extra), encoding: 'utf-8', timeout: 20_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  test('own then shared: the goldens, and the lessons come back where they were', () => {
    expect(nb(['add', 'build@acme-app', 'build with npm run build']).code).toBe(0);
    expect(nb(['add', 'build@acme-app', 'run one test file at a time']).code).toBe(0);
    expect(nb(['add', 'testing', 'a general lesson']).code).toBe(0);
    const before = readFileSync(join(shared, 'build@acme-app.md'), 'utf-8');
    expect(nb(['place', 'own'])).toEqual({
      code: 0,
      out:
        `own: ${own} (created)\n` +
        '  moved 2 lessons (1 shelf) from the shared notebook: build@acme-app\n' +
        "  This project now reads and writes only this folder. It is kept on this computer, and does not include the shared notebook's general shelves.\n",
      err: '',
    });
    expect(readFileSync(join(own, 'build@acme-app.md'), 'utf-8')).toBe(before);
    expect(nb(['place']).out).toBe(
      `own: ${own}\n` +
        "  project acme-app (git remote origin) has its own notebook. It is kept on this computer, separate from the notebook your other projects share, and does not include that notebook's general shelves.\n" +
        'project folders (1): acme-app\n',
    );
    expect(nb(['place', 'own']).out).toBe(
      `own: ${own}\n  nothing to move: the shared notebook holds no shelf ending in @acme-app\n` +
        "  This project now reads and writes only this folder. It is kept on this computer, and does not include the shared notebook's general shelves.\n",
    );
    const back = nb(['place', 'shared', '--json']);
    expect(back.code).toBe(0);
    expect(JSON.parse(back.out)).toEqual({ kind: 'shared', dir: shared, moved: ['build@acme-app'], kept: [], lessons: 2, removed: true });
    expect(existsSync(own)).toBe(false);
    expect(readFileSync(join(shared, 'build@acme-app.md'), 'utf-8')).toBe(before);
    expect(nb(['place', 'shared'])).toEqual({
      code: 0,
      out: `shared: ${shared}\n  this directory does not use an own notebook (no project folders); nothing to move.\n`,
      err: '',
    });
    expect(shelves(shared)).toEqual(['build@acme-app.md', 'testing.md']);
  });

  test('own --json, and nb place counts shelves left in the shared notebook', () => {
    nb(['add', 'build@acme-app', 'a lesson']);
    const r = JSON.parse(nb(['place', 'own', '--json']).out);
    expect(r).toEqual({ kind: 'own', dir: own, created: true, moved: ['build@acme-app'], kept: [], lessons: 1, unversioned: false });
    writeFileSync(join(shared, 'late@acme-app.md'), '+1 written by a call that resolved before the folder existed\n');
    expect(nb(['place']).out).toContain('  1 shelf of acme-app is still in the shared notebook; `nb place own` moves them.\n');
    expect(JSON.parse(nb(['place', '--json']).out).stranded).toEqual(['late@acme-app']);
    expect(nb(['place', 'own']).out).toContain('moved 1 lesson (1 shelf) from the shared notebook: late@acme-app');
  });

  test('own warns when the shared notebook is a git repository and the folder is not', () => {
    git(shared, 'init', '-q');
    nb(['add', 'build@acme-app', 'a lesson']);
    expect(nb(['place', 'own']).out).toContain('warning: the shared notebook is a git repository and this folder is not');
  });

  test('nb place warns about a hand-made folder other users can read', () => {
    if (isWin) return; // POSIX modes only
    mkdirSync(own, { recursive: true, mode: 0o755 });
    expect(nb(['place']).out).toContain('warning: other users of this computer can read this folder');
  });

  test.each<[string, () => Record<string, string>, () => void, string]>([
    ['NB_DIR set', () => ({ NB_DIR: join(tmp, 'mine') }), () => {}, 'NB_DIR is set'],
    ['a device name', () => ({ NB_PROJECT_SLUG: 'con' }), () => {}, 'cannot be a folder name on Windows'],
    ['a name over 64 characters', () => ({ NB_PROJECT_SLUG: 'a'.repeat(65) }), () => {}, 'over 64'],
    ['a folder differing in case', () => ({}), () => mkdirSync(join(projects, 'Acme-App'), { recursive: true }), 'only in letter case'],
  ])('own refuses: %s, and changes nothing', (_label, envOf, setup, msg) => {
    const env = envOf();
    setup();
    nb(['add', 'build@acme-app', 'a lesson'], repo, env.NB_DIR ? env : {});
    const r = nb(['place', 'own', '--json'], repo, env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).error.class).toBe('bad_args');
    expect(r.err).toContain(msg);
    expect(r.err).toContain('Nothing changed.');
    // readdir, not existsSync: on a case-insensitive disk `acme-app` is the hand-made `Acme-App`.
    expect(existsSync(projects) ? readdirSync(projects).filter((n) => n.toLowerCase() === 'acme-app' && n !== 'Acme-App') : []).toEqual([]);
  });

  test('own refuses a name from the folder, and outside a repository', () => {
    const noRemote = join(tmp, 'lonely');
    mkdirSync(noRemote);
    git(noRemote, 'init', '-q');
    expect(nb(['place', 'own'], noRemote).err).toContain('comes from its folder, which another copy of it may not share. Add an origin remote (it uploads nothing)');
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    expect(nb(['place', 'own'], plain).err).toContain('no project name here');
    expect(existsSync(projects)).toBe(false);
  });

  test('shared refuses a clash and a foreign file, and keeps the folder', () => {
    mkdirSync(own, { recursive: true });
    nb(['add', 'testing', 'own copy']);
    writeFileSync(join(shared, 'testing.md'), '+1 shared copy\n');
    expect(nb(['place', 'shared']).err).toContain('the shared notebook already has shelves named testing');
    rmSync(join(shared, 'testing.md'));
    mkdirSync(join(own, '.git'));
    expect(nb(['place', 'shared']).err).toContain('holds files that are not lessons (.git)');
    expect(existsSync(join(own, 'testing.md'))).toBe(true);
  });

  test('a bad action is refused', () => {
    expect(nb(['place', 'mine'])).toMatchObject({ code: 1, err: expect.stringContaining('unknown action "mine"') });
    expect(nb(['place', 'own', 'extra']).code).toBe(1);
  });

  test.skipIf(isWin)('20 adds running during nb place own lose no lesson, counted across both notebooks [timing]', async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(shared, `s${i}@acme-app.md`), `+1 seed lesson ${i}\n`);
    const run = (args: string[]) =>
      new Promise<number | null>((res) => {
        const p = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: childEnv(), stdio: 'ignore' });
        p.on('close', res);
      });
    const adds = Array.from({ length: 20 }, (_, i) => run(['add', 'live@acme-app', `concurrent lesson ${i}`]));
    const codes = await Promise.all([run(['place', 'own']), ...adds]);
    expect(codes[0]).toBe(0);
    // A refused add (the guard, once the folder exists) is a loud failure, not a lost lesson.
    const read = (d: string): string => shelves(d).map((f) => readFileSync(join(d, f), 'utf-8')).join('');
    const all = read(shared) + read(own);
    const landed = Array.from({ length: 20 }, (_, i) => all.includes(`concurrent lesson ${i}\n`));
    landed.forEach((ok, i) => {
      if (!ok) expect(codes[i + 1], `add ${i} exited 0 but its lesson is nowhere`).not.toBe(0);
    });
    for (let i = 0; i < 30; i++) expect(all).toContain(`seed lesson ${i}\n`);
    expect(nb(['place', 'own']).code).toBe(0);
    expect(shelves(shared).filter((f) => f.endsWith('@acme-app.md'))).toEqual([]);
  });

  test.skipIf(isWin)('through the git wrapper, nb place own commits the shelves leaving the shared notebook', () => {
    git(shared, 'init', '-q');
    git(shared, 'config', 'user.email', 't@t');
    git(shared, 'config', 'user.name', 't');
    git(shared, 'config', 'commit.gpgsign', 'false');
    nb(['add', 'build@acme-app', 'a lesson']);
    git(shared, 'add', '-A');
    git(shared, 'commit', '-q', '-m', 'seed');
    const r = spawnSync(process.execPath, [WRAPPER, 'place', 'own'], { cwd: repo, env: childEnv(), encoding: 'utf-8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(git(shared, 'log', '-1', '--format=%s').trim()).toBe('nb place own');
    expect(git(shared, 'status', '--porcelain', '--', '*.md').trim()).toBe('');
    expect(git(shared, 'ls-files').split('\n')).not.toContain('build@acme-app.md');
  });
});
