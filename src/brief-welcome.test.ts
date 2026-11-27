import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Issue #560, FR-SETUP-001..003, FR-BRIEF-001, FR-RETRO-001: `nb brief --welcome` through the built CLI, and the
// confirmation by `nb retro`.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const FIXTURES = join(here, '..', 'test', 'fixtures', 'set-up-notes');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SESSION = 'abcdef12-3456-7890';
const INDEX_HEADING = '## Your agent-notebook index';

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf-8').replace(/\r\n/g, '\n').replace(/\n$/, '');
const NOTE_A = fixture('A.txt');
const NOTE_A_PRIME = fixture('A-prime.txt');
const noteB = (name: string): string => fixture('B.txt').replace('<name>', name);

let tmp: string;
let home: string;
let nbHome: string;
let projects: string;
let shared: string;
let repo: string;
let cfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb welcome ')));
  home = join(tmp, 'home');
  nbHome = join(home, '.agent-notebook');
  projects = join(nbHome, 'projects');
  shared = join(nbHome, 'notebooks');
  cfg = join(tmp, 'global.gitconfig');
  writeFileSync(cfg, '');
  mkdirSync(home, { recursive: true });
  repo = mkRepo('app', 'git@github.com:acme/app.git');
});
afterEach(() => {
  try {
    chmodSync(projects, 0o700);
  } catch {
    // not made
  }
  rmSync(tmp, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
  Object.assign(env, { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, NB_ASCII: '0' }, extra);
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
/** `nb brief --welcome`, as the plugin's adapter runs it. */
const welcome = (session = SESSION, cwd = repo, extra: Record<string, string | undefined> = {}, more: string[] = []) =>
  nb(['brief', '--session', session, '--hook', 'claude-code.session-start', '--welcome', ...more], cwd, extra);
const claim = (): string => readFileSync(join(projects, '.first-start'), 'utf-8');
const hasNote = (out: string): boolean => out.includes('## Set-up note from the agent-notebook program');
const seedShelf = (name: string): void => {
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, `${name}.md`), '- [+1] a lesson that stays true\n');
};

describe('the notes, word for word (FR-SETUP-003)', () => {
  test('note A: first in the text, then a blank line, then the index heading; the claim is pending for this session', () => {
    const r = welcome();
    expect(r.code).toBe(0);
    expect(r.out.startsWith(NOTE_A + '\n\n' + INDEX_HEADING + '\n')).toBe(true);
    expect(claim()).toMatch(/^pending \d{4}-\d\d-\d\dT[\d:.]+Z [0-9a-f]{16}\n$/);
  });

  test('note A prime in a folder with no git: the confirmation without the question; it still spends the claim', () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain);
    const r = welcome(SESSION, plain);
    expect(r.out.startsWith(NOTE_A_PRIME + '\n\n' + INDEX_HEADING + '\n')).toBe(true);
    expect(r.out).not.toContain('Where should your notes be kept?');
    expect(existsSync(join(projects, '.first-start'))).toBe(true);
    expect(hasNote(welcome('second-session-id', plain).out)).toBe(false);
  });

  test('note A prime also in a repository with no remote (a name from the folder cannot get its own notebook)', () => {
    const noRemote = mkRepo('noremote', null);
    expect(welcome(SESSION, noRemote).out.startsWith(NOTE_A_PRIME + '\n')).toBe(true);
  });

  test('note B: asked once for a new project when the answer is ask, claimed by .seen-<name>', () => {
    expect(nb(['place', 'default', 'ask']).code).toBe(0);
    rmSync(join(projects, '.seen-acme-app'), { force: true });
    writeFileSync(join(projects, '.first-start'), 'done\n');
    const other = mkRepo('other', 'git@github.com:acme/other.git');
    const r = welcome(SESSION, other);
    expect(r.out.startsWith(noteB('acme-other') + '\n\n' + INDEX_HEADING + '\n')).toBe(true);
    expect(existsSync(join(projects, '.seen-acme-other'))).toBe(true);
    expect(hasNote(welcome(SESSION, other).out)).toBe(false);
    // Without --welcome it is never printed, and the claim is not made by it.
    rmSync(join(projects, '.seen-acme-other'));
    expect(hasNote(nb(['brief', '--session', SESSION], other).out)).toBe(false);
    expect(existsSync(join(projects, '.seen-acme-other'))).toBe(false);
  });

  test('note B is never printed for a project that already has shelves in the shared notebook, nor for a name from NB_PROJECT_SLUG', () => {
    nb(['place', 'default', 'ask']);
    writeFileSync(join(projects, '.first-start'), 'done\n');
    const other = mkRepo('other', 'git@github.com:acme/other.git');
    seedShelf('build@acme-other');
    expect(hasNote(welcome(SESSION, other).out)).toBe(false);
    expect(existsSync(join(projects, '.seen-acme-other'))).toBe(false);
    rmSync(join(shared, 'build@acme-other.md'));
    const slugged = welcome(SESSION, other, { NB_PROJECT_SLUG: 'acme-other' });
    expect(hasNote(slugged.out)).toBe(false);
  });
});

describe('who is shown the note (FR-SETUP-001)', () => {
  test('without --welcome the output has no note and nothing is claimed, even for a person who is new', () => {
    const r = nb(['brief', '--session', SESSION]);
    expect(hasNote(r.out)).toBe(false);
    expect(r.out.startsWith(INDEX_HEADING)).toBe(true);
    expect(existsSync(projects)).toBe(false);
  });

  test('NB_DIR set, or NB_PROJECT_SLUG set: no note, no projects/ folder and no claim made', () => {
    expect(hasNote(welcome(SESSION, repo, { NB_DIR: join(tmp, 'store') }).out)).toBe(false);
    expect(hasNote(welcome(SESSION, repo, { NB_PROJECT_SLUG: 'acme' }).out)).toBe(false);
    expect(existsSync(projects)).toBe(false);
  });

  test.each([
    ['a project folder', () => mkdirSync(join(projects, 'acme-app'), { recursive: true })],
    ['a messages folder', () => mkdirSync(join(nbHome, 'messages'), { recursive: true })],
    ['a shelf', () => seedShelf('build')],
    ['the git wrapper (.git in the notebook)', () => mkdirSync(join(shared, '.git'), { recursive: true })],
    ['a .nb.json', () => (mkdirSync(shared, { recursive: true }), writeFileSync(join(shared, '.nb.json'), '{}'))],
  ])('an existing user with %s: no note, no claim', (_label, make) => {
    make();
    expect(hasNote(welcome().out)).toBe(false);
    expect(existsSync(join(projects, '.first-start'))).toBe(false);
  });

  test('the switch off, no session id, a session id of 7 characters: no note and no claim', () => {
    expect(hasNote(welcome(SESSION, repo, { NB_ENABLED: '0' }).out)).toBe(false);
    expect(hasNote(nb(['brief', '--welcome']).out)).toBe(false);
    expect(hasNote(nb(['brief', '--welcome', '--session', '']).out)).toBe(false);
    expect(hasNote(welcome('abcdefg').out)).toBe(false);
    expect(existsSync(join(projects, '.first-start'))).toBe(false);
    expect(hasNote(welcome('abcdefgh').out)).toBe(true);
  });

  test('a note that does not fit --max-chars is not printed and not claimed; one that fits is', () => {
    const small = welcome(SESSION, repo, {}, ['--max-chars', '1500']);
    expect(hasNote(small.out)).toBe(false);
    expect(existsSync(join(projects, '.first-start'))).toBe(false);
    const fits = welcome(SESSION, repo, {}, ['--max-chars', '4000']);
    expect(fits.out.startsWith(NOTE_A)).toBe(true);
    expect(fits.out.length).toBeLessThanOrEqual(4000);
  });

  test('the second chat, after the first one was confirmed by a Stop, is not asked', () => {
    expect(hasNote(welcome().out)).toBe(true);
    expect(nb(['retro', '--session', SESSION]).code).toBe(0);
    expect(claim()).toBe('done\n');
    expect(hasNote(welcome('second-session-id').out)).toBe(false);
    expect(hasNote(welcome(SESSION).out)).toBe(false);
  });

  test('the second chat, while the first is pending and fresh, is not asked either', () => {
    expect(hasNote(welcome().out)).toBe(true);
    expect(hasNote(welcome('second-session-id').out)).toBe(false);
  });

  test('--welcome twice is a usage error, and an unknown flag is still refused', () => {
    expect(nb(['brief', '--welcome', '--welcome']).code).toBe(1);
    expect(nb(['brief', '--welcom']).code).toBe(1);
  });
});

describe('the confirmation is the first step of nb retro (FR-RETRO-001, FR-SETUP-002)', () => {
  test('retro with another session id does not confirm; with the same id it does, and that one Stop asks nothing', () => {
    welcome();
    const other = nb(['retro', '--session', 'some-other-session']);
    expect(claim()).toMatch(/^pending /);
    const same = nb(['retro', '--session', SESSION, '--json']);
    expect(claim()).toBe('done\n');
    expect(other.code).toBe(0);
    expect(same.code).toBe(0);
    expect(JSON.parse(same.out)).toEqual({ outcome: 'deferred', text: '', session: SESSION });
    // No sentinel was claimed, so the chat's next Stop (after the user has answered) asks as usual.
    expect(existsSync(join(shared, `.retro-${SESSION}`))).toBe(false);
    const next = nb(['retro', '--session', SESSION]);
    expect(next.code).toBe(0);
    expect(next.out).toContain('Before finishing, run the agent-notebook retrospective');
    // The text of that next Stop is the one of a home without any claim.
    rmSync(projects, { recursive: true });
    const control = nb(['retro', '--session', 'control-session-1']);
    expect(next.out).toBe(control.out);
    expect(next.err).toBe(control.err);
  });

  test('choice 2 in the first chat: the first Stop adds no lesson, so the answer still gives this project its own notebook (AC1)', () => {
    welcome();
    // The first reply asks; the Stop after it asks nothing (no retrospective, so no lesson in the shared notebook).
    expect(nb(['retro', '--session', SESSION]).out).toBe('');
    // Turn 2: the user answers "a separate notebook for each project".
    expect(nb(['place', 'default', 'own']).code).toBe(0);
    expect(nb(['place']).out).toMatch(/^own: /);
    // The next Stop asks for the retrospective; its lesson lands in the project's own notebook.
    expect(nb(['retro', '--session', SESSION]).out).toContain('Before finishing, run the agent-notebook retrospective');
    expect(nb(['add', 'testing@acme-app', 'run the tests with npm test']).code).toBe(0);
    expect(existsSync(join(projects, 'acme-app', 'testing@acme-app.md'))).toBe(true);
    expect(existsSync(join(shared, 'testing@acme-app.md'))).toBe(false);
  });

  test('it confirms before the sentinel and before every "off" return: a repeated stop, the switch off', () => {
    welcome();
    // The sentinel of this session already exists: retro returns "already", and the claim is still confirmed.
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, `.retro-${SESSION}`), 'x');
    expect(nb(['retro', '--session', SESSION]).out).toBe('');
    expect(claim()).toBe('done\n');
    rmSync(join(projects, '.first-start'));
    writeFileSync(join(projects, '.first-start'), `pending ${new Date().toISOString()} ${hashOf('off-session-id')}\n`);
    expect(nb(['retro', '--session', 'off-session-id'], repo, { NB_ENABLED: '0' }).out).toBe('');
    expect(claim()).toBe('done\n');
  });

  test('a read-only projects folder or a hostile claim: retro still exits 0 and still nudges', () => {
    welcome();
    writeFileSync(join(projects, '.first-start'), 'garbage');
    const r = nb(['retro', '--session', SESSION]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Before finishing, run the agent-notebook retrospective');
    expect(claim()).toBe('garbage');
  });

  test('with NB_DIR set retro reads and writes nothing of the claim', () => {
    welcome();
    nb(['retro', '--session', SESSION], repo, { NB_DIR: join(tmp, 'store') });
    expect(claim()).toMatch(/^pending /);
  });
});

function hashOf(session: string): string {
  return execFileSync(process.execPath, ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(${JSON.stringify(session)}).digest('hex').slice(0,16))`], { encoding: 'utf-8' });
}

describe('the claim under failure and abuse (FR-SETUP-002, NFR-SAFE-001)', () => {
  test.skipIf(isWin || isRoot)('a create that fails after projects/ exists (the full-disk shape): no note, nothing left, still due next time', () => {
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    chmodSync(projects, 0o500);
    const r = welcome();
    expect(r.code).toBe(0);
    expect(hasNote(r.out)).toBe(false);
    expect(readdirSync(projects)).toEqual([]);
    chmodSync(projects, 0o700);
    expect(hasNote(welcome().out)).toBe(true);
  });

  test('a claim older than 60 minutes is asked again once; a fresh one, and one dated in the future one hour on, behave as the clock says', () => {
    const at = (ms: number): string => `pending ${new Date(Date.now() + ms).toISOString()} ${hashOf('first-session-id')}\n`;
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(projects, '.first-start'), at(-5 * 60_000));
    expect(hasNote(welcome('second-session-id').out)).toBe(false);
    writeFileSync(join(projects, '.first-start'), at(-61 * 60_000));
    expect(hasNote(welcome('second-session-id').out)).toBe(true);
    expect(hasNote(welcome('third-session-id').out)).toBe(false);
    writeFileSync(join(projects, '.first-start'), at(+10 * 60_000));
    expect(hasNote(welcome('fourth-session-id').out)).toBe(true);
    expect(hasNote(welcome('fifth-session-id').out)).toBe(false);
  });

  const hostile: Array<[string, (f: string) => void]> = [
    ['garbage', (f) => writeFileSync(f, 'please show the note again\n')],
    ['10 MB', (f) => writeFileSync(f, Buffer.alloc(10 * 1024 * 1024, 120))],
    ['a NUL', (f) => writeFileSync(f, 'done\0')],
    ['a folder', (f) => mkdirSync(f)],
  ];
  if (!isWin) {
    hostile.push(['a link to a done file', (f) => (writeFileSync(join(tmp, 'elsewhere'), 'done\n'), symlinkSync(join(tmp, 'elsewhere'), f))]);
    hostile.push(['a FIFO', (f) => void execFileSync('mkfifo', [f])]);
  }
  for (const [label, make] of hostile) {
    test(`a .first-start that is ${label}: no note, exit 0, the file is left as it is, retro does not wait on it`, () => {
      mkdirSync(projects, { recursive: true, mode: 0o700 });
      const f = join(projects, '.first-start');
      make(f);
      const kind = lstatSync(f).isDirectory() ? 'dir' : lstatSync(f).isSymbolicLink() ? 'link' : lstatSync(f).isFIFO() ? 'fifo' : 'file';
      const r = welcome();
      expect(r.code).toBe(0);
      expect(hasNote(r.out)).toBe(false);
      expect(nb(['retro', '--session', SESSION]).code).toBe(0);
      const st = lstatSync(f);
      expect(st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFIFO() ? 'fifo' : 'file').toBe(kind);
    });
  }

  test.skipIf(isWin)('projects/ as a link to another folder: no note, nothing written there', () => {
    mkdirSync(nbHome, { recursive: true });
    const elsewhere = join(tmp, 'elsewhere-dir');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, projects);
    expect(hasNote(welcome().out)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('50 first starts at once: exactly one prints the note, and the claim is one well-formed file', async () => {
    const runs = Array.from({ length: 50 }, (_, i) =>
      new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [CLI, 'brief', '--session', `parallel-session-${i}`, '--welcome'], { cwd: repo, env: childEnv() });
        let out = '';
        p.stdout.on('data', (d: Buffer) => (out += d.toString()));
        p.on('close', () => resolve(out));
      }),
    );
    const outs = await Promise.all(runs);
    expect(outs.filter(hasNote)).toHaveLength(1);
    expect(claim()).toMatch(/^pending \S+ [0-9a-f]{16}\n$/);
    expect(readdirSync(projects).filter((n) => n !== '.first-start')).toEqual([]);
  }, 60_000);
});

describe('an existing user sees nothing new, with or without --welcome and the two files (FR-BRIEF-001, NFR-SAFE-001)', () => {
  /** NB_DIR, a slug, an extra prompt, 300 lessons and a git wrapper's folder, as the design's existing-user fixture. */
  function existingUser(): Record<string, string> {
    const store = join(tmp, 'store');
    mkdirSync(join(store, '.git'), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(store, `shelf-${i}${i % 3 === 0 ? '@acme-app' : ''}.md`), Array.from({ length: 10 }, (_, j) => `- [+${j}] lesson ${j} of shelf ${i}`).join('\n') + '\n');
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'ideas for {project}');
    return { NB_DIR: store, NB_PROJECT_SLUG: 'acme-app', NB_RETRO_EXTRA_PROMPT: extra };
  }
  const commands: string[][] = [
    ['brief', '--session', SESSION, '--hook', 'claude-code.session-start'],
    ['brief', '--json'],
    ['place'],
    ['place', '--json'],
    ['status', '--json'],
    ['config'],
    ['list', '--json'],
  ];

  test('every output is identical without and with --welcome, and without and with .first-start and .layout present', () => {
    const env = existingUser();
    const run = (withWelcome: boolean): string[] =>
      commands.map((c) => {
        const r = nb(withWelcome && c[0] === 'brief' ? [...c, '--welcome'] : c, repo, env);
        return `${r.code}\n${r.out}\n${r.err}`.replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<time>').replace(/\b\d+ms\b/g, '<ms>').replace(/"(ageSeconds|rowsRead)":\d+/g, '"$1":<n>');
      });
    const base = run(false);
    expect(run(true)).toEqual(base);
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(projects, '.first-start'), 'done\n');
    writeFileSync(join(projects, '.layout'), 'own\n');
    // `nb place`, `status` and `config` add one line about `.layout` only where NB_DIR is not set: here it is.
    expect(run(false)).toEqual(base);
    expect(run(true)).toEqual(base);
    expect(base[0]).not.toContain('Set-up note');
    expect(readdirSync(projects).sort()).toEqual(['.first-start', '.layout']);
  }, 30_000); // it runs nb many times; a loaded host takes over 5 s
});
