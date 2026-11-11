import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// End-to-end coverage for issue #252: the nb-git-wrapper must seed a default
// .gitignore on its first commit so a repo set up with the documented one-liner
// (`git init`, no .gitignore) never commits the churning usage log, lock, or
// other transient runtime files. We drive the REAL wrapper as a subprocess
// against a seeded temp NB_DIR git repo — exactly as a user runs it — and assert
// against real `git ls-files`, not an in-process import of internals.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wrapper = join(root, 'examples', 'nb-git-wrapper.mjs');

// Isolate git from the host so the wrapper's commit always succeeds and the
// test's own git calls can't be redirected: strip any inherited GIT_* that
// would repoint git at another worktree/index (the wrapper scrubs these for its
// own calls, but the test's git calls must too), and neutralize global/system
// config (gpgsign, hooksPath, templateDir) that could otherwise make the
// wrapper's commit fail silently and let a vacuous pass slip through.
function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { ...env, ...extra };
}

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

let dir: string;

/** Run a git command inside the temp NB_DIR with an isolated environment. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: cleanGitEnv(), encoding: 'utf-8' });
}

/** Init a bare NB_DIR git repo, hermetic against the host's global gitignore. */
function initRepo(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'core.excludesFile', '/dev/null');
}

/**
 * Run the wrapper with a mutating command against the temp NB_DIR. stderr is
 * captured so a resolution/commit failure surfaces a diagnostic instead of a
 * silent non-zero exit.
 */
function runWrapper(...argv: string[]): void {
  execFileSync(process.execPath, [wrapper, ...argv], {
    env: cleanGitEnv({ NB_DIR: dir, NB_GIT_AUTOCOMMIT: '1' }),
    encoding: 'utf-8',
  });
}

/** Files git actually tracks after the wrapper's commit. */
function trackedFiles(): string[] {
  return git('ls-files')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Number of commits on HEAD (0 before any commit exists). */
function commitCount(): number {
  try {
    return parseInt(git('rev-list', '--count', 'HEAD').trim(), 10);
  } catch {
    return 0;
  }
}

/** The single-quoted pattern operands the harness-setup.md recipe writes. */
function recipeGitignorePatterns(): string[] {
  const doc = readFileSync(join(root, 'docs', 'harness-setup.md'), 'utf-8');
  const line = doc.split('\n').find((l) => l.includes('printf') && l.includes('> .gitignore'));
  expect(line, 'recipe should contain a `printf ... > .gitignore` line').toBeTruthy();
  return [...line!.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((t) => t !== '%s\\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-wrapper-gitignore-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-git-wrapper default .gitignore seeding (issue #252)', () => {
  test('seeds a .gitignore and never tracks the churning usage log', () => {
    if (!gitAvailable) return;
    initRepo();
    runWrapper('add', 'demo', 'a first versioned lesson');

    // The commit actually ran (guards against a vacuous pass on a fail-open path).
    expect(commitCount()).toBe(1);
    // The ignore file is created...
    expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    // ...a usage log was written by the CLI (otherwise this test proves nothing)...
    expect(existsSync(join(dir, '.nb-usage.log'))).toBe(true);

    const tracked = trackedFiles();
    // ...yet the churning usage log is NOT tracked (acceptance criterion #1)...
    expect(tracked).not.toContain('.nb-usage.log');
    // ...while the real notebook content and the seeded ignore file ARE.
    expect(tracked).toContain('demo.md');
    expect(tracked).toContain('.gitignore');
  });

  test('the committed set is exactly the real notebook files, with every transient pattern excluded', () => {
    if (!gitAvailable) return;
    initRepo();
    // Plant inert files matching three of the seeded patterns so the exact
    // committed-set assertion below exercises them end to end. We do NOT plant
    // `.nb.lock` (the CLI's live lock file — planting it blocks `nb add`) or a
    // `.nb-usage.log*` file: the CLI creates those itself at runtime, so the
    // `.nb.lock` and `.nb-usage.log*` patterns are covered by the real transients.
    writeFileSync(join(dir, 'scratch.tmp'), 'x'); // *.tmp
    writeFileSync(join(dir, '.retro-abc'), 'x'); // .retro-*
    writeFileSync(join(dir, '.nb-backup.cron.log'), 'x'); // .nb-backup.*

    runWrapper('add', 'demo', 'a first versioned lesson');

    expect(commitCount()).toBe(1);
    // The CLI's own usage log/lock plus all three planted transients stay out;
    // only the notebook shelf and the seeded ignore file are committed (#3).
    expect(trackedFiles().sort()).toEqual(['.gitignore', 'demo.md']);
  });

  test('an existing .gitignore is never clobbered and no default patterns leak into it', () => {
    if (!gitAvailable) return;
    initRepo();
    const existing = '# my own rules\nsecret.txt\n';
    writeFileSync(join(dir, '.gitignore'), existing);

    runWrapper('add', 'demo', 'a first versioned lesson');

    // The commit path actually ran — so the assertions below are not vacuous.
    expect(commitCount()).toBe(1);
    expect(trackedFiles()).toContain('demo.md');
    // The user's file is preserved byte-for-byte — the wrapper does not merge,
    // append, or overwrite (acceptance criterion #2), in the working tree...
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(existing);
    // ...and in what was committed.
    expect(git('show', 'HEAD:.gitignore')).toBe(existing);
    // Because the user's rules don't cover the usage log, it IS tracked here —
    // proving the wrapper injected none of its default patterns (which would
    // have excluded it). The log is the user's own .gitignore's responsibility.
    expect(trackedFiles()).toContain('.nb-usage.log');
  });

  test('the seeded .gitignore matches the documented harness-setup.md recipe verbatim', () => {
    if (!gitAvailable) return;
    initRepo();
    runWrapper('add', 'demo', 'a first versioned lesson');

    // Compare the ACTUALLY-seeded file (from a real run) to the recipe's
    // patterns, rather than scraping a source line — so a reformat of the
    // wrapper's array can't silently drift the default out of sync with the
    // long-form recipe (independently guarded by harness-setup-gitignore.test.ts).
    const seeded = readFileSync(join(dir, '.gitignore'), 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(seeded).toEqual(recipeGitignorePatterns());
  });
});

describe('nb-git-wrapper Nb-Session trailer (issue #409)', () => {
  function runWith(extra: Record<string, string>, ...argv: string[]): void {
    execFileSync(process.execPath, [wrapper, ...argv], {
      env: cleanGitEnv({ NB_DIR: dir, NB_GIT_AUTOCOMMIT: '1', NB_SESSION: '', ...extra }),
      encoding: 'utf-8',
    });
  }
  const body = (rev = 'HEAD') => git('log', '-1', '--format=%B', rev);

  test('opt-in adds an exact Nb-Session line; subject unchanged; grep does not match task-10', () => {
    if (!gitAvailable) return;
    initRepo();
    runWith({ NB_GIT_SESSION_TRAILER: '1', NB_SESSION: 'task-1' }, 'add', 'demo', 'first lesson one');
    runWith({ NB_GIT_SESSION_TRAILER: '1', NB_SESSION: 'task-10' }, 'add', 'demo', 'second lesson two');
    expect(git('log', '--format=%s', '--grep', '^Nb-Session: task-1$')).toBe('nb add demo\n');
    expect(git('log', '--format=%s', '--grep', '^Nb-Session: task-1$').split('\n').filter(Boolean)).toHaveLength(1);
    expect(git('log', '-1', '--format=%s')).toBe('nb add demo\n');
  });

  test('without the opt-in, or with a blank session, the message is the bare subject', () => {
    if (!gitAvailable) return;
    initRepo();
    runWith({ NB_SESSION: 'task-1' }, 'add', 'demo', 'first lesson one');
    expect(body()).toBe('nb add demo\n\n');
    runWith({ NB_GIT_SESSION_TRAILER: '1', NB_SESSION: '  ' }, 'add', 'demo', 'second lesson two');
    expect(body()).toBe('nb add demo\n\n');
    runWith({ NB_GIT_SESSION_TRAILER: '1' }, 'add', 'demo', 'third lesson three');
    expect(body()).toBe('nb add demo\n\n');
  });

  test('a session with newline/control characters becomes one cleaned line equal to the usage log', () => {
    if (!gitAvailable) return;
    initRepo();
    runWith({ NB_GIT_SESSION_TRAILER: '1', NB_SESSION: 'a\nb\u001b[31mc' }, 'add', 'demo', 'first lesson one');
    expect(body().trim().split('\n')).toEqual(['nb add demo', '', 'Nb-Session: a b[31mc']);
    const log = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(log).toContain('a b[31mc');
  });
});
