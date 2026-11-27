import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { placeOwn, placeShared } from './place-ops.js';
import { acquireLock, releaseLock } from './notebook.js';
import { readLayout, writeSeen } from './layout-io.js';

// Issue #560, FR-PLACE-005 and FR-SETUP-004: `nb place default`, and the answer applied when a chat starts, through the built CLI.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const WRAPPER = join(here, '..', 'examples', 'nb-git-wrapper.mjs');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string;
let home: string;
let projects: string;
let shared: string;
let repo: string;
let cfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb place default ')));
  home = join(tmp, 'home');
  projects = join(home, '.agent-notebook', 'projects');
  shared = join(home, '.agent-notebook', 'notebooks');
  cfg = join(tmp, 'global.gitconfig');
  writeFileSync(cfg, '');
  mkdirSync(home, { recursive: true });
  repo = mkRepo('app', 'git@github.com:acme/app.git');
});
afterEach(() => {
  try {
    chmodSync(join(home, '.agent-notebook'), 0o700);
  } catch {
    // not made
  }
  rmSync(tmp, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
  Object.assign(env, { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', NB_ASCII: '0' }, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf-8' });
}
function mkRepo(name: string, remote: string | null): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  if (remote !== null) git(d, 'config', 'remote.origin.url', remote);
  return d;
}
function nb(args: string[], cwd = repo, extra: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(extra), encoding: 'utf-8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const setLayout = (word: string | Buffer): void => {
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  writeFileSync(join(projects, '.layout'), word);
};
const listing = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
const OWN_SENTENCE =
  'Done: from now on each project gets its own notebook, starting with this one. Notes already kept stay where they are until you ask to move them. To go back, just ask.\n';

describe('nb place default: read-only without a value (FR-PLACE-005)', { timeout: 60_000 }, () => {
  test('no choice made: the recommended one, text and JSON, and nothing is written', () => {
    expect(nb(['place', 'default'])).toEqual({
      code: 0,
      out: 'default: shared (the recommended choice)\n  one notebook for all projects, in sections per project.\n',
      err: '',
    });
    expect(nb(['place', 'default', '--json'])).toEqual({ code: 0, out: '{"default":"shared","source":"recommended"}\n', err: '' });
    expect(existsSync(projects)).toBe(false);
  });

  test('a chosen answer says its date (from the file time); an unreadable one says so and gives shared', () => {
    setLayout('ask\n');
    utimesSync(join(projects, '.layout'), new Date('2026-01-02T12:00:00Z'), new Date('2026-01-02T12:00:00Z'));
    expect(nb(['place', 'default']).out).toBe('default: ask (chosen on 2026-01-02)\n  you are asked in each new project.\n');
    expect(JSON.parse(nb(['place', 'default', '--json']).out)).toEqual({ default: 'ask', source: 'chosen' });
    setLayout('maybe\n');
    expect(nb(['place', 'default']).out).toBe(
      'default: shared (the choice file could not be read, so the recommended choice applies)\n' +
        '  one notebook for all projects, in sections per project.\n' +
        '  To set it again: nb place default shared|own|ask.\n',
    );
    expect(JSON.parse(nb(['place', 'default', '--json']).out)).toEqual({ default: 'shared', source: 'unreadable' });
  });

  test('with NB_DIR set it still reads, and says it applies only where NB_DIR is not set', () => {
    setLayout('own\n');
    const r = nb(['place', 'default'], repo, { NB_DIR: join(tmp, 'mine') });
    expect(r.out).toMatch(/^default: own \(chosen on \d{4}-\d\d-\d\d\)\n {2}a separate notebook for each project\.\n {2}NB_DIR is set here, so this applies only where NB_DIR is not set\.\n$/);
  });

  test('bad arguments exit 1 with the class bad_args', () => {
    for (const args of [['place', 'default', 'maybe'], ['place', 'default', 'own', 'extra'], ['place', 'default', 'Own']]) {
      const r = nb([...args, '--json']);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out).error.class).toBe('bad_args');
    }
    expect(nb(['place', 'default', 'maybe']).err).toBe('nb place: unknown choice "maybe" for `nb place default` (use shared, own or ask)\n');
    expect(existsSync(projects)).toBe(false);
  });
});

describe('nb place default <value>: records the answer (FR-PLACE-005)', { timeout: 60_000 }, () => {
  test('goldens for each value, in a repository with a remote: .layout 0600, projects/ 0700, no temporary file', () => {
    expect(nb(['place', 'default', 'shared'])).toEqual({
      code: 0,
      out: 'Done: all projects keep their notes in one shared notebook, in sections per project. Notes already kept stay where they are. To go back, just ask.\n',
      err: '',
    });
    expect(readFileSync(join(projects, '.layout'), 'utf-8')).toBe('shared\n');
    expect(nb(['place', 'default', 'ask']).out).toBe('Done: from now on the notebook asks, in each new project, where its notes are kept. Notes already kept stay where they are. To go back, just ask.\n');
    expect(nb(['place', 'default', 'ask', '--json'])).toEqual({ code: 0, out: '{"default":"ask","source":"chosen"}\n', err: '' });
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app']);
    if (!isWin) {
      expect(statSync(join(projects, '.layout')).mode & 0o777).toBe(0o600);
      expect(statSync(join(projects, '.seen-acme-app')).mode & 0o777).toBe(0o600);
      expect(statSync(projects).mode & 0o777).toBe(0o700);
    }
  });

  test('own makes this project\'s EMPTY folder and its .seen file; a second run changes nothing', () => {
    expect(nb(['place', 'default', 'own'])).toEqual({ code: 0, out: OWN_SENTENCE, err: '' });
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app', 'acme-app']);
    expect(listing(join(projects, 'acme-app'))).toEqual([]);
    if (!isWin) expect(statSync(join(projects, 'acme-app')).mode & 0o777).toBe(0o700);
    expect(nb(['place', 'default', 'own']).out).toBe(OWN_SENTENCE);
    expect(JSON.parse(nb(['place', 'default', 'own', '--json']).out)).toEqual({ default: 'own', source: 'chosen' });
  });

  test('own with shelves of the project in the shared notebook moves nothing, makes no folder and no .seen', () => {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'Build@ACME-App.md'), '+1 a lesson\n');
    expect(nb(['place', 'default', 'own']).out).toBe(
      'Done: from now on each project gets its own notebook. This project already has notes in the shared notebook, so they stay there until you ask to move them. To go back, just ask.\n',
    );
    expect(listing(projects)).toEqual(['.layout']);
    expect(readFileSync(join(shared, 'Build@ACME-App.md'), 'utf-8')).toBe('+1 a lesson\n');
  });

  test('in a folder with no project name every answer says so, and nothing but .layout is made', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const r = nb(['place', 'default', 'own'], plain);
    expect(r.out).toBe(
      'Done: from now on each project gets its own notebook. Notes already kept stay where they are until you ask to move them. ' +
        'This folder is not a project the notebook can tell apart, so its notes stay in the shared notebook. To go back, just ask.\n',
    );
    expect(listing(projects)).toEqual(['.layout']);
    expect(nb(['place', 'default', 'ask'], plain).out).toContain('This folder is not a project the notebook can tell apart');
  });

  test('a name from the folder (no remote) gets no folder and no .seen', () => {
    const lonely = mkRepo('lonely', null);
    nb(['place', 'default', 'own'], lonely);
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('a name from NB_PROJECT_SLUG never makes a folder or a .seen file, for any answer', () => {
    for (const v of ['own', 'ask', 'shared']) nb(['place', 'default', v], repo, { NB_PROJECT_SLUG: 'acme-app' });
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('with NB_DIR set it records, says it applies only where NB_DIR is not set, and changes nothing in NB_DIR or the folders', () => {
    const mine = join(tmp, 'mine');
    const r = nb(['place', 'default', 'own'], repo, { NB_DIR: mine });
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'Done: from now on each project gets its own notebook. Notes already kept stay where they are until you ask to move them. ' +
        'Your notes are kept in the folder NB_DIR names here, so this choice applies only where NB_DIR is not set. To go back, just ask.\n',
    );
    expect(listing(projects)).toEqual(['.layout']);
    expect(listing(mine).filter((n) => !n.startsWith('.nb-usage'))).toEqual([]);
  });

  test('a read-only home is refused with one plain sentence and nothing changes', () => {
    if (isWin || isRoot) return;
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    chmodSync(join(home, '.agent-notebook'), 0o500);
    const r = nb(['place', 'default', 'own']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^nb place: could not make the folder .*\(EACCES\)\. Nothing changed\.\n$/);
    expect(r.out).toBe('');
  });

  test('git missing: the answer is recorded, nothing else is made, exit 0', () => {
    const r = spawnSync(process.execPath, [CLI, 'place', 'default', 'own'], { cwd: repo, env: childEnv({ PATH: dirname(process.execPath) }), encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('nb place own and nb place shared write .seen for a remote name, and not for a slug', () => {
    nb(['place', 'own']);
    expect(listing(projects)).toEqual(['.seen-acme-app', 'acme-app']);
    nb(['place', 'shared']);
    expect(listing(projects)).toEqual(['.seen-acme-app']);
    rmSync(join(projects, '.seen-acme-app'));
    nb(['place', 'shared']);
    expect(listing(projects)).toEqual(['.seen-acme-app']);
    rmSync(join(projects, '.seen-acme-app'));
    nb(['place', 'own'], repo, { NB_PROJECT_SLUG: 'other-name' });
    expect(listing(projects)).toEqual(['other-name']);
  });

  test('"default" is refused as a project name, with the name unchanged on disk', () => {
    const r = nb(['place', 'own'], repo, { NB_PROJECT_SLUG: 'default' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('"default" cannot be the name of a project notebook');
    expect(existsSync(projects)).toBe(false);
  });
});

describe('nb brief applies the answer (FR-SETUP-004)', { timeout: 60_000 }, () => {
  const brief = (cwd = repo, extra: Record<string, string | undefined> = {}) => nb(['brief'], cwd, { NB_ENABLED: '1', ...extra });

  test('own, a remote name, no folder, no .seen: an empty folder and .seen are made before the place is resolved', () => {
    setLayout('own\n');
    const r = brief();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Lessons for acme-app go to its own notebook (${join(projects, 'acme-app')})`);
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app', 'acme-app']);
    expect(listing(join(projects, 'acme-app')).filter((n) => !n.startsWith('.nb'))).toEqual([]);
    const again = brief();
    expect(again.out).toContain('go to its own notebook');
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app', 'acme-app']);
  });

  test('with --json too: the writes are the same, the output is still one JSON object', () => {
    setLayout('own\n');
    const r = nb(['brief', '--json'], repo, { NB_ENABLED: '1' });
    expect(JSON.parse(r.out).text).toContain('its own notebook');
    expect(existsSync(join(projects, 'acme-app'))).toBe(true);
  });

  test('shelves of the project in the shared notebook: nothing is made, nothing moves, no .seen', () => {
    setLayout('own\n');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'build@acme-app.md'), '+1 a lesson\n');
    const r = brief();
    expect(r.code).toBe(0);
    expect(listing(projects)).toEqual(['.layout']);
    expect(readFileSync(join(shared, 'build@acme-app.md'), 'utf-8')).toBe('+1 a lesson\n');
  });

  test('a .seen file (the user chose shared for this project) keeps the folder from being made', () => {
    setLayout('own\n');
    writeFileSync(join(projects, '.seen-acme-app'), '');
    brief();
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app']);
  });

  test('answers other than own, no .layout, and NB_DIR set make nothing; NB_DIR does not even read .layout', () => {
    setLayout('ask\n');
    brief();
    setLayout('shared\n');
    brief();
    rmSync(join(projects, '.layout'));
    brief();
    setLayout('own\n');
    brief(repo, { NB_DIR: join(tmp, 'mine') });
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('a name from NB_PROJECT_SLUG never makes a folder or a .seen file, in own mode', () => {
    setLayout('own\n');
    brief(repo, { NB_PROJECT_SLUG: 'acme-app' });
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('the notebook switched off here: nothing is made', () => {
    setLayout('own\n');
    nb(['brief'], repo, { NB_ENABLED: '0' });
    expect(listing(projects)).toEqual(['.layout']);
  });

  test.each([
    ['unknown word', 'maybe\n'],
    ['a NUL', 'own\0\n'],
    ['over 64 bytes', 'own\n' + ' '.repeat(100)],
    ['ten megabytes', Buffer.alloc(10 * 1024 * 1024, 0x6f)],
  ])('an unreadable .layout (%s) means no default: no folder, no .seen, exit 0', (_label, content) => {
    setLayout(content);
    expect(brief().code).toBe(0);
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('BOM and CRLF in .layout are accepted', () => {
    setLayout('\uFEFFown\r\n');
    brief();
    expect(existsSync(join(projects, 'acme-app'))).toBe(true);
  });

  test('.layout as a link, a folder or a FIFO is unreadable: no folder, and the call does not hang', () => {
    if (isWin) return;
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, 'good'), 'own\n');
    symlinkSync(join(tmp, 'good'), join(projects, '.layout'));
    expect(brief().code).toBe(0);
    rmSync(join(projects, '.layout'));
    mkdirSync(join(projects, '.layout'));
    expect(brief().code).toBe(0);
    rmSync(join(projects, '.layout'), { recursive: true });
    if (spawnSync('mkfifo', [join(projects, '.layout')]).status === 0) expect(brief().code).toBe(0);
    expect(listing(projects).filter((n) => !n.startsWith('.layout'))).toEqual([]);
  });

  test('projects/ as a link: .layout in it is not read and nothing is made', () => {
    if (isWin) return;
    const real = join(tmp, 'real');
    mkdirSync(real);
    writeFileSync(join(real, '.layout'), 'own\n');
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    symlinkSync(real, projects);
    expect(brief().code).toBe(0);
    expect(listing(real)).toEqual(['.layout']);
  });

  test('an own folder plus a corrupt .layout: the folder wins, for brief and for nb place', () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true, mode: 0o700 });
    setLayout('\0\0garbage');
    expect(brief().out).toContain('go to its own notebook');
    expect(nb(['place']).out).toMatch(/^own: /);
    expect(nb(['place']).out).toContain('Where notes are kept: the choice could not be read');
  });

  test('the lock held by another call: skipped silently, exit 0, the folder is made by a later start', () => {
    setLayout('own\n');
    mkdirSync(join(shared, '.nb.lock'), { recursive: true });
    const r = brief();
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(listing(projects)).toEqual(['.layout']);
    rmSync(join(shared, '.nb.lock'), { recursive: true });
    brief();
    expect(existsSync(join(projects, 'acme-app'))).toBe(true);
  });

  test('a read-only home: the start still prints, silently', () => {
    if (isWin || isRoot) return;
    setLayout('own\n');
    chmodSync(projects, 0o500);
    try {
      const r = brief();
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toContain('## Your agent-notebook index');
    } finally {
      chmodSync(projects, 0o700);
    }
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('git missing: the start still prints and nothing is made', () => {
    setLayout('own\n');
    const r = spawnSync(process.execPath, [CLI, 'brief'], { cwd: repo, env: childEnv({ NB_ENABLED: '1', PATH: dirname(process.execPath) }), encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(listing(projects)).toEqual(['.layout']);
  });

  const remotes: [string, string][] = [
    ['a space', 'git@github.com:acme/app one.git'],
    ['a quote', "git@github.com:acme/it's.git"],
    ['a dollar', 'git@github.com:acme/$HOME.git'],
    ['a backtick', 'git@github.com:acme/`id`.git'],
    ['a newline', 'git@github.com:acme/a\nb.git'],
    ['dot dot', 'git@github.com:acme/../x.git'],
    ['non-ASCII', 'git@github.com:acme/café.git'],
    ['a Windows device name', 'git@github.com:con.git'],
    ['the word default', 'git@github.com:default.git'],
    ['65 characters', `git@github.com:acme/${'a'.repeat(60)}.git`],
  ];
  test.each(remotes)('a remote name with %s makes no folder and no .seen, and brief still exits 0', (label, url) => {
    if (isWin && label === 'a newline') return;
    setLayout('own\n');
    const d = mkRepo(`odd-${label.replace(/\W/g, '')}`, url);
    const r = brief(d);
    expect(r.code).toBe(0);
    expect(listing(projects)).toEqual(['.layout']);
  });

  test('git is never started in a folder with no .git entry above it, on the paths of issue #560', () => {
    if (isWin) return;
    const shimDir = join(tmp, 'shim');
    mkdirSync(shimDir);
    const calls = join(tmp, 'git-calls');
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\necho "$@" >> '${calls}'\nexit 128\n`, { mode: 0o755 });
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const env = { PATH: `${shimDir}:${process.env.PATH}`, NB_ENABLED: '1' };
    setLayout('own\n');
    expect(nb(['brief'], plain, env).code).toBe(0);
    expect(nb(['place', 'default', 'own'], plain, env).code).toBe(0);
    expect(nb(['place', 'default'], plain, env).code).toBe(0);
    expect(nb(['place', 'default', 'ask'], plain, env).code).toBe(0);
    expect(existsSync(calls)).toBe(false);
    // The control: with a .git entry the shim is reached.
    mkdirSync(join(plain, '.git'));
    nb(['brief'], plain, env);
    expect(existsSync(calls)).toBe(true);
  });
});

describe('the one line saying where notes are kept (FR-PLACE-005, FR-STATUS-001)', { timeout: 60_000 }, () => {
  const LINE = /Where notes are kept: a separate notebook for each project \(chosen on \d{4}-\d\d-\d\d\)\. To change it: nb place default shared\|own\|ask\./;

  test('nb place, nb status and nb config show it, and their JSON gains a layout key', () => {
    setLayout('own\n');
    expect(nb(['place']).out).toMatch(LINE);
    expect(nb(['status']).out).toMatch(LINE);
    expect(nb(['config']).out).toMatch(LINE);
    for (const c of ['place', 'status', 'config']) {
      const j = JSON.parse(nb([c, '--json']).out);
      expect(j.layout).toEqual({ default: 'own', source: 'chosen', since: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) });
    }
  });

  test('an unreadable file is shown as such', () => {
    setLayout('???\n');
    for (const c of ['place', 'status', 'config']) expect(nb([c]).out).toContain('Where notes are kept: the choice could not be read');
    expect(JSON.parse(nb(['status', '--json']).out).layout).toMatchObject({ default: 'shared', source: 'unreadable' });
  });

  test('with no .layout, or with NB_DIR set, nothing is added anywhere', () => {
    for (const c of ['place', 'status', 'config']) {
      expect(nb([c]).out).not.toContain('Where notes are kept');
      expect(nb([c, '--json']).out).not.toContain('"layout"');
    }
    setLayout('own\n');
    const mine = { NB_DIR: join(tmp, 'mine') };
    for (const c of ['place', 'status', 'config']) {
      expect(nb([c], repo, mine).out).not.toContain('Where notes are kept');
      expect(nb([c, '--json'], repo, mine).out).not.toContain('"layout"');
    }
  });

  test('the brief index is grouped by the derived project name once .layout exists, and stays flat without it', () => {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'general.md'), '+1 a lesson\n');
    const flat = nb(['brief'], repo, { NB_ENABLED: '1' }).out;
    expect(flat).not.toContain('### ');
    setLayout('shared\n');
    expect(nb(['brief'], repo, { NB_ENABLED: '1' }).out).toContain('### Project layer (shelves ending in @acme-app)');
  });
});

describe('an existing user sees no change (FR-PLACE-005, upgrade byte-identity)', { timeout: 60_000 }, () => {
  // The fixture of a user who set everything by hand: NB_DIR, NB_PROJECT_SLUG, an extra retrospective prompt, 300 lessons.
  function fixture(): { mine: string; env: Record<string, string> } {
    const mine = join(tmp, 'mine');
    mkdirSync(mine, { recursive: true });
    for (let s = 0; s < 6; s++) {
      const lines = Array.from({ length: 50 }, (_, i) => `+${i % 4} lesson ${s}-${i} about something durable`);
      writeFileSync(join(mine, `shelf${s}${s % 2 === 0 ? '@acme-app' : ''}.md`), `# desc: open when doing thing ${s}\n${lines.join('\n')}\n`);
    }
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'Please also mention the release notes.\n');
    return { mine, env: { NB_DIR: mine, NB_PROJECT_SLUG: 'acme-app', NB_RETRO_EXTRA_PROMPT: extra, NB_ENABLED: '1' } };
  }
  function outputs(env: Record<string, string | undefined>): string[] {
    const status = JSON.parse(nb(['status', '--json'], repo, env).out);
    // The headline and the evidence follow the rows the earlier calls of this very test wrote.
    for (const k of ['now', 'headline', 'next', 'evidence']) delete status[k];
    return [
      nb(['brief'], repo, env).out,
      nb(['place'], repo, env).out,
      nb(['place', '--json'], repo, env).out,
      JSON.stringify(status),
      nb(['config'], repo, env).out,
      nb(['config', '--json'], repo, env).out,
      nb(['list', '--json'], repo, env).out,
    ];
  }

  test('with NB_DIR set, a .layout of any kind in the home changes no output byte', () => {
    const { env } = fixture();
    const base = outputs(env);
    expect(base[0]).toContain('lesson');
    for (const word of ['own\n', 'ask\n', 'shared\n', 'garbage\0']) {
      setLayout(word);
      writeFileSync(join(projects, '.first-start'), 'done');
      expect(outputs(env)).toEqual(base);
    }
  });

  test('without NB_DIR and without .layout, no output mentions the new line or key', () => {
    const { env } = fixture();
    delete (env as Record<string, string | undefined>).NB_DIR;
    for (const out of outputs(env)) {
      expect(out).not.toContain('Where notes are kept');
      expect(out).not.toMatch(/"layout"/);
    }
  });
});

describe('the git wrapper passes nb place default through and changes nothing in NB_DIR (FR-PLACE-005)', { timeout: 60_000 }, () => {
  function seed(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'seed');
  }
  const wrap = (args: string[], extra: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [WRAPPER, ...args], { cwd: repo, env: childEnv(extra), encoding: 'utf-8', timeout: 30_000 });

  test.each([
    ['NB_DIR set', true],
    ['NB_DIR unset (the shared notebook is the repository)', false],
  ])('%s: the sentence, exit 0, no commit, a clean repository', (_label, withNbDir) => {
    const dir = withNbDir ? join(tmp, 'mine') : shared;
    seed(dir);
    const before = git(dir, 'rev-list', '--count', 'HEAD');
    const r = wrap(['place', 'default', 'own'], withNbDir ? { NB_DIR: dir } : {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Done: from now on each project gets its own notebook');
    expect(r.stdout.endsWith('To go back, just ask.\n')).toBe(true);
    expect(git(dir, 'rev-list', '--count', 'HEAD')).toBe(before);
    expect(git(dir, 'status', '--porcelain').split('\n').filter((l) => l !== '' && !l.includes('.nb-usage'))).toEqual([]);
    expect(readFileSync(join(projects, '.layout'), 'utf-8')).toBe('own\n');
    expect(JSON.parse(wrap(['place', 'default', '--json'], withNbDir ? { NB_DIR: dir } : {}).stdout)).toEqual({ default: 'own', source: 'chosen' });
  });
});

describe('a start never undoes what nb place chose, decided under the lock (FR-SETUP-004)', { timeout: 60_000 }, () => {
  test('a start that waits for the lock sees the .seen marker written meanwhile, and makes no folder', async () => {
    setLayout('own\n');
    mkdirSync(shared, { recursive: true });
    const held = await acquireLock(shared);
    // What `brief` passes: the answer and the marker are asked again once the lock is held.
    const start = placeOwn(shared, projects, 'acme-app', {}, {
      onlyIfNoShelves: true,
      precondition: () => !existsSync(join(projects, '.seen-acme-app')) && readLayout(projects).state === 'chosen',
    });
    // `nb place shared` records the user's choice while the start waits, then releases.
    expect(writeSeen(projects, 'acme-app')).toBe(true);
    releaseLock(held);
    expect(await start).toMatchObject({ skipped: true, created: false });
    expect(existsSync(join(projects, 'acme-app'))).toBe(false);
    expect(nb(['place'], repo, { NB_ENABLED: '1' }).out).toMatch(/^shared: /);
  });

  test('nb place shared and nb place own write .seen while both locks are held, before anything moves', async () => {
    mkdirSync(join(projects, 'acme-app'), { recursive: true, mode: 0o700 });
    writeFileSync(join(projects, 'acme-app', 'build@acme-app.md'), '+1 a lesson\n');
    const seen: { lock: boolean; folder: boolean; marker: boolean }[] = [];
    const probe = (): void => {
      seen.push({ lock: existsSync(join(shared, '.nb.lock')), folder: existsSync(join(projects, 'acme-app', 'build@acme-app.md')), marker: existsSync(join(projects, '.seen-acme-app')) });
    };
    await placeShared(shared, join(projects, 'acme-app'), 'acme-app', { whenLocked: () => { probe(); writeSeen(projects, 'acme-app'); } });
    expect(seen).toEqual([{ lock: true, folder: true, marker: false }]);
    expect(existsSync(join(projects, '.seen-acme-app'))).toBe(true);
    seen.length = 0;
    rmSync(join(projects, '.seen-acme-app'));
    await placeOwn(shared, projects, 'acme-app', { whenLocked: probe });
    expect(seen).toEqual([{ lock: true, folder: false, marker: false }]);
  });

  test('through the CLI: nb place shared in a project whose start raced it leaves the project shared', () => {
    setLayout('own\n');
    expect(nb(['brief'], repo, { NB_ENABLED: '1' }).code).toBe(0);
    expect(nb(['place', 'shared']).code).toBe(0);
    expect(nb(['brief'], repo, { NB_ENABLED: '1' }).code).toBe(0);
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app']);
    expect(nb(['place']).out).toMatch(/^shared: /);
  });

  test('nb place shared that has not yet looked at the folder is not undone by a start that makes it first (an ordering gate, no timing)', async () => {
    if (isWin) return;
    setLayout('own\n');
    const shimDir = join(tmp, 'gate');
    mkdirSync(shimDir);
    const reached = join(tmp, 'git-reached');
    const go = join(tmp, 'git-go');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
    // A git for this one `nb place shared` call only: it says it was reached, then waits for the go file.
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ntouch '${reached}'\nwhile [ ! -e '${go}' ]; do sleep 0.05; done\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const child = spawn(process.execPath, [CLI, 'place', 'shared'], { cwd: repo, env: childEnv({ PATH: `${shimDir}:${process.env.PATH}` }) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const done = new Promise<number | null>((r) => child.on('close', r));
    while (!existsSync(reached)) await new Promise((r) => setTimeout(r, 20));
    // `place shared` has resolved its place (no folder) and is inside git; a start now makes the folder, as it may.
    expect(nb(['brief'], repo, { NB_ENABLED: '1' }).code).toBe(0);
    expect(existsSync(join(projects, 'acme-app'))).toBe(true);
    writeFileSync(go, '');
    expect(await done).toBe(0);
    expect(out).toContain('shared: ');
    expect(listing(projects)).toEqual(['.layout', '.seen-acme-app']);
    expect(nb(['place']).out).toMatch(/^shared: /);
  });
});
