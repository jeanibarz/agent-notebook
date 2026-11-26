import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanProjectName, describeProject, groupsIndex, ownerRepo, resolveProject, type ProjectGit } from './project.js';
import type { GitRun } from './git.js';

// Issue #540: the project name, derived once in the core. These tests pin the
// URL rule, the order of the rules, every git failure, real repository layouts
// and the `nb project` output. Requirement: FR-PROJECT-001.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const isWin = process.platform === 'win32';
const SECRET = 'S3CR3T';

/** Names must always look like this: one path segment, lower case, letter or digit at both ends. */
const SAFE = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;

describe('the origin remote gives owner-repo (FR-PROJECT-001)', () => {
  // [url, name]: '' means "not a name", so the folder rule decides.
  const table: Array<[string, string]> = [
    ['git@github.com:jeanibarz/agent-notebook.git', 'jeanibarz-agent-notebook'],
    ['https://github.com/jeanibarz/agent-notebook', 'jeanibarz-agent-notebook'],
    ['https://github.com/jeanibarz/agent-notebook.git/', 'jeanibarz-agent-notebook'],
    ['ssh://git@github.com/jeanibarz/agent-notebook.git', 'jeanibarz-agent-notebook'],
    ['ssh://git@github.com:22/jeanibarz/agent-notebook.git', 'jeanibarz-agent-notebook'],
    ['git://github.com/jeanibarz/agent-notebook.git', 'jeanibarz-agent-notebook'],
    ['git+ssh://git@github.com/jeanibarz/agent-notebook.git', 'jeanibarz-agent-notebook'],
    ['https://user:tok@github.com/Acme/App.git', 'acme-app'],
    ['ssh://git@[::1]:22/o/r.git', 'o-r'],
    ['git@gitlab.com:a/b/c.git', 'a-b-c'],
    ['https://gitlab.com/a/b/c', 'a-b-c'],
    ['host:~user/repo.git', 'user-repo'],
    ['gh:o/r', 'o-r'], // an insteadOf alias, read raw
    ['git@github.com:o/my.repo.git', 'o-my.repo'],
    // Known mismatches between two forms of one repository, documented (no special rules).
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'v3-org-proj-repo'],
    ['https://org@dev.azure.com/org/proj/_git/repo', 'org-proj-_git-repo'],
    ['https://org.visualstudio.com/proj/_git/repo', 'proj-_git-repo'],
    ['ssh://git@bitbucket.example.com:7999/proj/repo.git', 'proj-repo'],
    ['https://bitbucket.example.com/scm/proj/repo.git', 'scm-proj-repo'],
    // Local remotes are not an identity.
    ['/srv/git/app.git', ''],
    ['./app', ''],
    ['../app', ''],
    ['~/git/app', ''],
    ['file:///srv/git/app.git', ''],
    ['C:\\repos\\x', ''],
    ['C:/src/app.git', ''],
    ['C:repo', ''],
    ['\\\\server\\share\\app', ''],
    // Fail closed.
    ['', ''],
    ['https://github.com', ''],
    ['https://github.com/', ''],
    ['git@github.com:', ''],
    ['git@github.com:../../etc.git', ''],
    ['https://h/o/../r', ''],
    ['https://h/o/./r', ''],
    ['https://h/o%20x/r', ''],
    ['https://h/o r/r', ''],
    ['https://h/ö/r', ''],
    ['https://h/o/r\nevil', ''],
    ['https://h/o/r?x=1', ''],
    ['https://h/o/r#x', ''],
    ['-oProxyCommand=touch /tmp/x', ''],
    ['just-a-word', ''],
  ];
  test.each(table)('%j gives %j', (url, name) => {
    expect(ownerRepo(url)).toBe(name);
  });

  test('a secret in any credential position never reaches the name', () => {
    const urls = [
      `https://${SECRET}@github.com/o/r.git`,
      `https://x:${SECRET}@github.com/o/r.git`,
      `https://x:a/${SECRET}@github.com/o/r.git`,
      `https://x:a@${SECRET}@github.com/o/r.git`,
      `https://github.com/o/r.git?token=${SECRET}`,
      `https://github.com/o/r.git#${SECRET}`,
      `x:${SECRET}@github.com/o/r`,
      `${SECRET}@github.com:o/r.git`,
      `ssh://git:${SECRET}@github.com/o/r.git`,
      `https://x%3A${SECRET}@github.com/o/r.git`,
    ];
    for (const u of urls) {
      const n = ownerRepo(u);
      expect(n.toLowerCase(), u).not.toContain(SECRET.toLowerCase());
      expect(n === '' || SAFE.test(n), u).toBe(true);
    }
  });

  test('a long path is cut to 100 characters and stays one safe segment', () => {
    const n = ownerRepo('https://h/' + 'a'.repeat(150) + '/' + 'b'.repeat(150));
    expect(n).toHaveLength(100);
    expect(n).toMatch(SAFE);
  });

  test('any string gives one safe segment or nothing (property, seeded)', () => {
    let seed = 540;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = 'aZ09._-/:@?#%~ \t\n\\$`"\'ö中.:/@..CONcon';
    for (let i = 0; i < 5000; i++) {
      const len = rand(60);
      let s = rand(4) === 0 ? 'https://h/' : rand(3) === 0 ? 'git@h:' : '';
      for (let j = 0; j < len; j++) s += alphabet[rand(alphabet.length)];
      const n = ownerRepo(s);
      expect(n === '' || SAFE.test(n), JSON.stringify(s)).toBe(true);
      expect(n.includes('..'), JSON.stringify(s)).toBe(false);
      expect(n.includes('/') || n.includes('\\'), JSON.stringify(s)).toBe(false);
    }
  });
});

describe('cleanProjectName keeps the 0.12 rule (FR-PROJECT-001)', () => {
  test.each([
    ['My Repo', 'my-repo'],
    ['my_repo--copy', 'my_repo--copy'],
    ['..a..b..', 'a.b'],
    ['-x-', 'x'],
    ['!!!', ''],
    ['   ', ''],
    ['CON', 'con'],
    ['a'.repeat(120), 'a'.repeat(100)],
  ])('%j gives %j', (raw, name) => {
    expect(cleanProjectName(raw)).toBe(name);
  });
});

/** A fake git: answers each command from a table, and counts calls. */
function fakeGit(answers: { top?: Partial<GitRun>; remote?: Partial<GitRun> }, commonDir = '.git'): ProjectGit & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: readonly string[]) => {
    calls.push([...args]);
    const base: GitRun = { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { ...base, stdout: commonDir + '\n', ...answers.top };
    return { ...base, ...answers.remote };
  }) as unknown as ProjectGit & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe('resolveProject: the order of the rules and every git failure (FR-PROJECT-001)', () => {
  let tmp: string;
  let work: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb project ')));
    work = join(tmp, 'My App');
    mkdirSync(join(work, '.git'), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  test('NB_PROJECT_SLUG wins and no git runs', () => {
    const g = fakeGit({});
    expect(resolveProject({ NB_PROJECT_SLUG: ' Foo/Bar ' }, work, g)).toMatchObject({ name: 'foo-bar', source: 'env', reason: 'env NB_PROJECT_SLUG' });
    expect(g.calls).toEqual([]);
  });

  test('a NB_PROJECT_SLUG with no usable character still wins, gives no name, and runs no git', () => {
    const g = fakeGit({});
    const st = resolveProject({ NB_PROJECT_SLUG: '   ' }, work, g);
    expect(st).toMatchObject({ name: '', source: 'env' });
    expect(describeProject(st)).toBe('(none: env NB_PROJECT_SLUG has no usable character)');
    expect(g.calls).toEqual([]);
  });

  test('an empty NB_PROJECT_SLUG counts as unset', () => {
    const g = fakeGit({ remote: { stdout: 'git@h:o/r.git\n' } });
    expect(resolveProject({ NB_PROJECT_SLUG: '' }, work, g)).toMatchObject({ name: 'o-r', source: 'remote' });
  });

  test('the origin remote, with exactly two git runs, in order', () => {
    const g = fakeGit({ remote: { stdout: 'git@github.com:Acme/App.git\n' } });
    expect(resolveProject({}, work, g)).toEqual({ name: 'acme-app', source: 'remote', reason: 'git remote origin', oldName: 'my-app' });
    expect(g.calls).toEqual([
      ['rev-parse', '--git-common-dir'],
      ['config', '--get', 'remote.origin.url'],
    ]);
  });

  test('no origin (exit 1) gives the folder name', () => {
    const g = fakeGit({ remote: { status: 1 } });
    expect(resolveProject({}, work, g)).toMatchObject({ name: 'my-app', source: 'folder', reason: 'folder of the git repository (no origin remote)' });
  });

  test('a local or unusable origin gives the folder name', () => {
    for (const url of ['/srv/app.git', `https://h/o/r?t=${SECRET}`, 'git@h:o/r\nevil']) {
      const st = resolveProject({}, work, fakeGit({ remote: { stdout: url + '\n' } }));
      expect(st).toMatchObject({ name: 'my-app', source: 'folder' });
      expect(JSON.stringify(st)).not.toContain(SECRET);
    }
  });

  test.each<[string, Partial<GitRun>, string]>([
    ['git missing', { status: null, error: 'ENOENT' }, 'git not found'],
    ['git too slow', { status: null, error: 'ETIMEDOUT' }, 'git timed out'],
    ['git killed otherwise', { status: null, error: 'EACCES' }, 'git could not be run'],
    ['not a repository, or refused (dubious ownership)', { status: 128, stderr: 'fatal: detected dubious ownership' }, 'not in a git repository, or git refused this folder'],
    ['a stub that exits 1', { status: 1, stderr: 'xcrun: error' }, 'not in a git repository, or git refused this folder'],
  ])('the first run failing (%s) gives no name and no second run', (_label, top, reason) => {
    const g = fakeGit({ top });
    const st = resolveProject({}, work, g);
    expect(st).toEqual({ name: '', source: 'none', reason, oldName: '' });
    expect(g.calls).toHaveLength(1);
    expect(st.reason).not.toContain('fatal');
  });

  test.each<[string, Partial<GitRun>, string]>([
    ['timeout', { status: null, error: 'ETIMEDOUT' }, 'git timed out'],
    ['a bad config file (exit 3)', { status: 3, stderr: 'fatal: bad config line 1' }, 'git failed (exit 3)'],
    ['git missing between runs', { status: null, error: 'ENOENT' }, 'git not found'],
  ])('the remote read failing (%s) gives no name, never the folder name', (_label, remote, reason) => {
    expect(resolveProject({}, work, fakeGit({ remote }))).toEqual({ name: '', source: 'none', reason, oldName: '' });
  });

  test('a common dir that cannot be resolved gives no name', () => {
    expect(resolveProject({}, work, fakeGit({ top: { stdout: 'gone/.git\n' } }))).toMatchObject({ source: 'none', reason: 'the repository folder could not be read' });
  });

  test('a folder name with no usable character gives no name', () => {
    const odd = join(tmp, '!!!');
    mkdirSync(join(odd, '.git'), { recursive: true });
    expect(resolveProject({}, odd, fakeGit({ remote: { status: 1 } }))).toMatchObject({ name: '', source: 'none' });
  });

  test('the folder rule: .git and .bare name their parent; anything else is its own name minus .git', () => {
    mkdirSync(join(tmp, 'proj', '.bare'), { recursive: true });
    mkdirSync(join(tmp, 'app.git'), { recursive: true });
    mkdirSync(join(tmp, 'top', '.git', 'modules', 'nested', 'sub2'), { recursive: true });
    const named = (common: string): string => resolveProject({}, tmp, fakeGit({ remote: { status: 1 } }, common)).name;
    expect(named(join(tmp, 'My App', '.git'))).toBe('my-app');
    expect(named(join(tmp, 'proj', '.bare'))).toBe('proj');
    expect(named(join(tmp, 'app.git'))).toBe('app');
    expect(named(join(tmp, 'top', '.git', 'modules', 'nested', 'sub2'))).toBe('sub2');
  });

  test('groupsIndex: only a name the user set or the remote gives', () => {
    const st = (source: 'env' | 'remote' | 'folder' | 'none') => ({ name: 'x', source, reason: '', oldName: '' });
    expect([groupsIndex(st('env')), groupsIndex(st('remote')), groupsIndex(st('folder')), groupsIndex(st('none'))]).toEqual([true, true, false, false]);
  });
});

// Real git, real layouts, through the built CLI.
// Each test here creates real repositories and spawns git and nb several times:
// slow on a loaded Windows runner, so the time limit is raised (not a timing assertion).
describe('nb project on real repositories (FR-PROJECT-001)', { timeout: 60_000 }, () => {
  let tmp: string;
  let home: string;
  let globalCfg: string;
  let store: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb project ')));
    home = join(tmp, 'home');
    store = join(tmp, 'store');
    mkdirSync(home);
    mkdirSync(store);
    globalCfg = join(tmp, 'global.gitconfig');
    writeFileSync(globalCfg, '[user]\n\tname = t\n\temail = t@example.invalid\n[protocol "file"]\n\tallow = always\n');
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(e)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete e[k];
    return { ...e, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, HOME: home, USERPROFILE: home, NB_DIR: store, ...extra };
  }
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: env(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function repo(dir: string, origin?: string): string {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    if (origin !== undefined) git(dir, 'remote', 'add', 'origin', origin);
    return dir;
  }
  function nb(args: string[], cwd: string, extra: Record<string, string> = {}): { code: number | null; out: string; err: string } {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(extra), encoding: 'utf-8', timeout: 20_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  test('the three output forms, goldens', () => {
    const r = repo(join(tmp, 'agent notebook'), 'git@github.com:jeanibarz/agent-notebook.git');
    expect(nb(['project'], r)).toEqual({ code: 0, out: 'jeanibarz-agent-notebook\n', err: '' });
    expect(nb(['project', '--why'], r)).toEqual({
      code: 0,
      out: 'jeanibarz-agent-notebook (git remote origin; nb 0.12 filled the retrospective\'s {project} with "agent-notebook")\n',
      err: '',
    });
    expect(nb(['project', '--json'], r)).toEqual({
      code: 0,
      out: '{"name":"jeanibarz-agent-notebook","source":"remote","reason":"git remote origin"}\n',
      err: '',
    });
    expect(nb(['project', '--why'], r, { NB_PROJECT_SLUG: 'Mine' }).out).toBe('mine (env NB_PROJECT_SLUG)\n');
  });

  test('no origin: the folder; outside a repository: nothing, on every form', () => {
    const r = repo(join(tmp, 'My Repo'));
    expect(nb(['project', '--why'], r).out).toBe('my-repo (folder of the git repository (no origin remote))\n');
    const outside = join(tmp, 'plain');
    mkdirSync(outside);
    expect(nb(['project'], outside)).toEqual({ code: 0, out: '\n', err: '' });
    expect(nb(['project', '--why'], outside).out).toBe('(none: not in a git repository, or git refused this folder)\n');
    expect(JSON.parse(nb(['project', '--json'], outside).out)).toEqual({ name: '', source: 'none', reason: 'not in a git repository, or git refused this folder' });
  });

  test('a subfolder, a linked worktree and a worktree of a bare clone all give the origin name', () => {
    const main = repo(join(tmp, 'main'), 'git@github.com:acme/app.git');
    mkdirSync(join(main, 'src', 'deep'), { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', 'wt', join(tmp, 'wt with space'));
    git(tmp, 'clone', '-q', '--bare', main, join(tmp, 'proj', '.bare'));
    git(join(tmp, 'proj', '.bare'), 'config', 'remote.origin.url', 'git@github.com:acme/app.git');
    git(join(tmp, 'proj', '.bare'), 'worktree', 'add', '-q', '-b', 'wt2', join(tmp, 'proj', 'main'));
    for (const d of [main, join(main, 'src', 'deep'), join(tmp, 'wt with space'), join(tmp, 'proj', 'main')]) {
      expect(nb(['project'], d).out, d).toBe('acme-app\n');
    }
  });

  test('without a remote: a submodule is named after itself, a bare clone after its folder', () => {
    const sub = repo(join(tmp, 'libsrc'));
    const top = repo(join(tmp, 'top'));
    git(top, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'nested/sub2');
    git(join(top, 'nested', 'sub2'), 'remote', 'remove', 'origin');
    expect(nb(['project'], join(top, 'nested', 'sub2')).out).toBe('sub2\n');
    git(tmp, 'clone', '-q', '--bare', sub, join(tmp, 'Bare.git'));
    git(join(tmp, 'Bare.git'), 'remote', 'remove', 'origin');
    expect(nb(['project'], join(tmp, 'Bare.git')).out).toBe('bare\n');
  });

  (isWin ? test.skip : test)('a symlinked folder gives the real repository name', () => {
    const r = repo(join(tmp, 'real-name'));
    symlinkSync(r, join(tmp, 'link'));
    expect(nb(['project'], join(tmp, 'link')).out).toBe('real-name\n');
  });

  test('a repository git refuses (dubious ownership) gives no name, and git\'s words are not shown', () => {
    const r = repo(join(tmp, 'theirs'), 'git@github.com:acme/app.git');
    const out = nb(['project', '--why'], r, { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' });
    expect(out).toEqual({ code: 0, out: '(none: not in a git repository, or git refused this folder)\n', err: '' });
  });

  test('git missing gives no name, exit 0', () => {
    const r = repo(join(tmp, 'r'), 'git@github.com:acme/app.git');
    const empty = join(tmp, 'emptybin');
    mkdirSync(empty);
    const out = nb(['project', '--json'], r, { PATH: empty, Path: empty });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out)).toEqual({ name: '', source: 'none', reason: 'git not found' });
  });

  test('a token in the origin URL appears in no output and no usage row', () => {
    const r = repo(join(tmp, 'r'), `https://x:${SECRET}@github.com/acme/app.git`);
    for (const args of [['project'], ['project', '--why'], ['project', '--json']]) {
      const o = nb(args, r);
      expect(o.out + o.err).not.toContain(SECRET);
      expect(o.out).toContain('acme-app');
    }
    git(r, 'config', 'remote.origin.url', `https://github.com/acme/app.git?token=${SECRET}`);
    const o = nb(['project', '--json'], r);
    expect(o.out + o.err).not.toContain(SECRET);
    expect(JSON.parse(o.out)).toMatchObject({ name: 'r', source: 'folder' });
    const usage = join(store, '.nb-usage');
    if (existsSync(usage)) expect(readFileSync(usage, 'utf-8')).not.toContain(SECRET);
  });

  test('hostile remote values give one safe name or the folder', () => {
    const r = repo(join(tmp, 'r'));
    git(r, 'remote', 'add', 'origin', 'x');
    const cases: Array<[string, string]> = [
      ['git@h:../../etc.git', 'r'],
      ['git@h:o/r\nevil', 'r'],
      ['git@h:$(touch x)/`id`', 'r'],
      ['-oProxyCommand=touch pwned', 'r'],
      ['git@h:CON/NUL.git', 'con-nul'],
      ['git@h:' + 'z/'.repeat(250) + 'r', 'z-'.repeat(49) + 'z'],
    ];
    for (const [url, want] of cases) {
      git(r, 'config', 'remote.origin.url', url);
      expect(nb(['project'], r).out, JSON.stringify(url)).toBe(want + '\n');
    }
    expect(existsSync(join(r, 'pwned'))).toBe(false);
  });

  test('hostile folder names give one safe segment', () => {
    const names = ['with space', "quo'te", 'dol$lar', 'back`tick', 'naïve-日本', 'a..b', 'x'.repeat(isWin ? 100 : 200)];
    // Windows refuses a folder named CON or holding a newline.
    if (!isWin) names.push('CON', 'new\nline');
    for (const n of names) {
      const d = repo(join(tmp, 'h', n.replace(/[<>:"|?*]/g, '_')));
      const name = nb(['project'], d).out.replace(/\n$/, '');
      expect(name === '' || SAFE.test(name), JSON.stringify(n)).toBe(true);
    }
  });

  (isWin ? test.skip : test)('NB_PROJECT_SLUG still wins when the working directory was removed', () => {
    const run = (slug?: string): string =>
      execFileSync('sh', ['-c', 'mkdir gone && cd gone && rmdir ../gone && exec "$0" "$1" project --why', process.execPath, CLI], {
        cwd: tmp,
        env: env(slug === undefined ? {} : { NB_PROJECT_SLUG: slug }),
        encoding: 'utf-8',
      });
    expect(run('Mine')).toBe('mine (env NB_PROJECT_SLUG)\n');
    expect(run()).toBe('(none: the working directory no longer exists)\n');
  });

  test('an unknown flag is refused, as for every command', () => {
    const r = repo(join(tmp, 'r'));
    const o = nb(['project', '--bogus'], r);
    expect(o.code).not.toBe(0);
    expect(o.err).toContain('--bogus');
  });
});
