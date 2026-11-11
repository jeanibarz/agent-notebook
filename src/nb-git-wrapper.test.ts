import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Guards issue #244: nb-git-wrapper.mjs commits a notebook on every *mutating*
// nb command, but its hard-coded MUTATING set once omitted `move` — a fully
// shipped command that rewrites two shelves — so a move was silently left
// uncommitted, breaking the one-commit-per-change contract for that command.
// These are the wrapper's first behavioral tests: we drive the REAL wrapper
// against throwaway git repos and assert commit behavior, exit-code fidelity,
// GIT_* stripping, and fail-open on git error.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wrapper = join(root, 'examples', 'nb-git-wrapper.mjs');
const source = readFileSync(wrapper, 'utf-8');

let nbDir: string;

/** A throwaway git repo seeded with one empty commit, so HEAD exists and commit
 *  counting starts from a known baseline. Identity lives in the repo config so no
 *  GIT_AUTHOR / GIT_COMMITTER env is needed (and the wrapper is free to strip
 *  env without starving `git commit` of an author). */
function seedRepo(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', 'seed'], { stdio: 'ignore' });
}

function commitCount(dir: string): number {
  return Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim());
}

function lastSubject(dir: string): string {
  return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf-8' }).trim();
}

/** Drive the real wrapper. `env` overlays the base env (which pins NB_DIR). The
 *  wrapper resolves `agent-notebook` by self-reference to this repo's own
 *  freshly-built dist/cli.js (the pretest build guarantees it exists). */
function runWrapper(args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stderr: string } {
  const r = spawnSync('node', [wrapper, ...args], {
    env: { ...process.env, NB_DIR: nbDir, ...env },
    encoding: 'utf-8',
    timeout: 20000, // a hung wrapper must not stall the suite
  });
  return { status: r.status ?? 1, stderr: r.stderr ?? '' };
}

beforeEach(() => {
  nbDir = mkdtempSync(join(tmpdir(), 'nb-git-wrapper-'));
  seedRepo(nbDir);
});
afterEach(() => {
  rmSync(nbDir, { recursive: true, force: true });
});

describe('nb-git-wrapper MUTATING set (issue #244)', () => {
  test('the source lists `move` in the MUTATING set and the doc comment', () => {
    // Pin the literal change so a future edit that drops `move` from either the
    // commit-gating set or the documented surface fails here, independent of the
    // behavioral tests below.
    expect(source).toMatch(/const MUTATING = new Set\(\[[^\]]*'move'[^\]]*\]\);/);
    expect(source).toContain('add/vote/merge/rm/split/move/describe');
  });

  test('`nb move` through the wrapper produces exactly one commit naming the move', () => {
    // A lesson must exist in the source shelf before it can be moved.
    expect(runWrapper(['add', 'src-shelf', 'remember to feed the hamster']).status).toBe(0);
    const before = commitCount(nbDir);

    const moved = runWrapper(['move', 'src-shelf', 'dst-shelf', 'hamster']);
    expect(moved.status).toBe(0);

    // Exactly one new commit — not zero (the bug), not two.
    expect(commitCount(nbDir)).toBe(before + 1);
    // The commit names the move (message is `nb <cmd> <source-shelf>`).
    expect(lastSubject(nbDir)).toBe('nb move src-shelf');
  });

  test('a mutating command (`add`) commits', () => {
    const before = commitCount(nbDir);
    expect(runWrapper(['add', 'notes', 'a durable lesson']).status).toBe(0);
    expect(commitCount(nbDir)).toBe(before + 1);
    expect(lastSubject(nbDir)).toBe('nb add notes');
  });

  test('a read-only command (`show`) produces no commit', () => {
    // Seed a shelf so `show` has something to read, committed as its own step.
    expect(runWrapper(['add', 'notes', 'a durable lesson']).status).toBe(0);
    const before = commitCount(nbDir);

    const shown = runWrapper(['show', 'notes']);
    expect(shown.status).toBe(0);
    // The wrapper never calls autoCommit for a non-mutating command.
    expect(commitCount(nbDir)).toBe(before);
  });

  test('the wrapper preserves the CLI exit code and does not commit on a failed mutating command', () => {
    // Dirty the tree with an untracked file FIRST, so that a wrapper which ran
    // autoCommit regardless of the exit code would stage and commit it — making
    // this a real test of the `code === 0` gate, not a vacuous one (a failing
    // `move` writes nothing, so a clean tree would show no commit either way).
    writeFileSync(join(nbDir, 'stray.txt'), 'uncommitted\n', 'utf-8');
    const before = commitCount(nbDir);

    // `move` with no selector → the CLI exits 1 (a handled argument error).
    const failed = runWrapper(['move', 'src-shelf', 'dst-shelf']);
    expect(failed.status).toBe(1);
    // code !== 0 ⇒ autoCommit is never invoked, so history is untouched despite
    // the dirty tree.
    expect(commitCount(nbDir)).toBe(before);
    expect(existsSync(join(nbDir, 'stray.txt'))).toBe(true); // still uncommitted/working-tree only
  });

  test('GIT_* env is stripped so the commit targets NB_DIR, not an inherited repo', () => {
    // A decoy repo whose GIT_DIR would hijack `git -C <NB_DIR>` if the wrapper did
    // not strip nested GIT_* vars: the commit would land in the decoy instead.
    const decoy = mkdtempSync(join(tmpdir(), 'nb-git-wrapper-decoy-'));
    try {
      seedRepo(decoy);
      const nbBefore = commitCount(nbDir);
      const decoyBefore = commitCount(decoy);

      const r = runWrapper(['add', 'notes', 'a durable lesson'], {
        GIT_DIR: join(decoy, '.git'),
        GIT_WORK_TREE: decoy,
      });
      expect(r.status).toBe(0);

      // The commit landed in NB_DIR (stripping worked) and NOT in the decoy.
      expect(commitCount(nbDir)).toBe(nbBefore + 1);
      expect(commitCount(decoy)).toBe(decoyBefore);
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test('a git error never fails an nb call (fail-open)', () => {
    // Replace .git with a plain file: `existsSync(.git)` still passes, so the
    // wrapper attempts the commit, but every `git -C <dir>` call fails. The nb
    // command must still succeed (exit 0) and the lesson must still be written.
    rmSync(join(nbDir, '.git'), { recursive: true, force: true });
    writeFileSync(join(nbDir, '.git'), 'not a git repo\n', 'utf-8');

    const r = runWrapper(['add', 'notes', 'a durable lesson']);
    expect(r.status).toBe(0);
    // The real CLI wrote the lesson before any git call — a git failure loses nothing.
    expect(existsSync(join(nbDir, 'notes.md'))).toBe(true);
    expect(readFileSync(join(nbDir, 'notes.md'), 'utf-8')).toContain('a durable lesson');
  });
});

describe('nb-git-wrapper installed outside the package (issue #376)', () => {
  // The documented install copies the wrapper to ~/.local/bin, where normal module
  // resolution cannot see a global npm install. Simulate that: a copy in a temp dir
  // with a fake `npm` on PATH whose global root holds a symlink to this repo.
  function installCopy(): { dir: string; env: NodeJS.ProcessEnv } {
    const dir = mkdtempSync(join(tmpdir(), 'nb-wrapper-copy-'));
    const globalRoot = join(dir, 'global', 'node_modules');
    mkdirSync(globalRoot, { recursive: true });
    symlinkSync(root, join(globalRoot, 'agent-notebook'), 'dir');
    mkdirSync(join(dir, 'bin'));
    const fakeNpm = join(dir, 'bin', 'npm');
    writeFileSync(fakeNpm, `#!/bin/sh\necho "${globalRoot}"\n`);
    chmodSync(fakeNpm, 0o755);
    copyFileSync(wrapper, join(dir, 'nb-git-wrapper.mjs'));
    writeFileSync(join(dir, 'nb'), '#!/bin/sh\nexec node "$(dirname "$0")/nb-git-wrapper.mjs" "$@"\n');
    chmodSync(join(dir, 'nb'), 0o755);
    return { dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}` } };
  }

  test.skipIf(process.platform === 'win32')('the documented shim + .mjs copy runs via the global npm root', () => {
    const { dir, env } = installCopy();
    try {
      const r = spawnSync(join(dir, 'nb'), ['--version'], {
        env: { ...process.env, NB_DIR: nbDir, ...env },
        encoding: 'utf-8',
        timeout: 20000,
      });
      expect(r.stderr).not.toContain('Cannot find module');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #405: the documented recipe bakes the global root into the shim as NODE_PATH,
  // so a call does not spawn `npm root -g`. The fake npm logs every invocation.
  function installDocumentedShim(npmRoot: (globalRoot: string) => string): { dir: string; log: string; env: NodeJS.ProcessEnv } {
    const { dir } = installCopy();
    const globalRoot = join(dir, 'global', 'node_modules');
    const log = join(dir, 'npm-calls.log');
    const fakeNpm = join(dir, 'bin', 'npm');
    writeFileSync(fakeNpm, `#!/bin/sh\necho called >> "${log}"\necho "${npmRoot(globalRoot)}"\n`);
    chmodSync(fakeNpm, 0o755);
    const home = join(dir, 'home');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    copyFileSync(wrapper, join(home, '.local', 'bin', 'nb-git-wrapper.mjs'));
    const env = { ...process.env, HOME: home, PATH: `${join(dir, 'bin')}:${process.env.PATH}` };
    // Run the install lines of the documented recipe verbatim (docs/harness-setup.md).
    const doc = readFileSync(join(root, 'docs', 'harness-setup.md'), 'utf-8');
    const recipe = doc.split('\n').filter((l) => l.startsWith('NB_GLOBAL_ROOT=') || l.startsWith("printf '#!/bin/sh")).join('\n');
    expect(recipe).toContain('NODE_PATH');
    const w = spawnSync('sh', ['-c', recipe], { env, encoding: 'utf-8' });
    expect(w.status).toBe(0);
    chmodSync(join(home, '.local', 'bin', 'nb'), 0o755);
    writeFileSync(log, ''); // forget the install-time lookup; only call-time invocations count
    return { dir, log, env: { ...env, NB_DIR: nbDir } };
  }

  test.skipIf(process.platform === 'win32')('a shim written by the documented recipe does not spawn npm at call time', () => {
    const { dir, log, env } = installDocumentedShim((g) => g);
    try {
      const r = spawnSync(join(dir, 'home', '.local', 'bin', 'nb'), ['--version'], { env, encoding: 'utf-8', timeout: 20000 });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
      expect(readFileSync(log, 'utf-8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('a shim without NODE_PATH does spawn npm (the two paths are distinct)', () => {
    const { dir, env } = installCopy();
    const log = join(dir, 'npm-calls.log');
    try {
      const globalRoot = join(dir, 'global', 'node_modules');
      writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho called >> "${log}"\necho "${globalRoot}"\n`);
      chmodSync(join(dir, 'bin', 'npm'), 0o755);
      const r = spawnSync(join(dir, 'nb'), ['--version'], { env: { ...process.env, NB_DIR: nbDir, ...env }, encoding: 'utf-8', timeout: 20000 });
      expect(r.status).toBe(0);
      expect(readFileSync(log, 'utf-8')).toContain('called');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('a baked root that no longer exists falls back to npm and still runs', () => {
    const { dir, log, env } = installDocumentedShim((g) => g);
    try {
      const shim = join(dir, 'home', '.local', 'bin', 'nb');
      const baked = join(dir, 'global', 'node_modules');
      writeFileSync(shim, readFileSync(shim, 'utf-8').replace(baked, join(dir, 'gone')));
      const r = spawnSync(shim, ['--version'], { env, encoding: 'utf-8', timeout: 20000 });
      expect(r.status).toBe(0);
      expect(readFileSync(log, 'utf-8')).toContain('called');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('the recipe bakes nothing when npm reports a directory that does not exist', () => {
    const { dir, env } = installDocumentedShim((g) => join(g, 'missing'));
    try {
      expect(readFileSync(join(dir, 'home', '.local', 'bin', 'nb'), 'utf-8')).toContain('NODE_PATH=""');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('when the package cannot be found the message says what was searched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nb-wrapper-missing-'));
    try {
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'npm'), `#!/bin/sh\necho "${join(dir, 'empty')}"\n`);
      chmodSync(join(dir, 'bin', 'npm'), 0o755);
      copyFileSync(wrapper, join(dir, 'nb-git-wrapper.mjs'));
      const r = spawnSync('node', [join(dir, 'nb-git-wrapper.mjs'), '--version'], {
        env: { ...process.env, NB_DIR: nbDir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
        encoding: 'utf-8',
        timeout: 20000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("searched the wrapper's own location");
      expect(r.stderr).toContain(`the global npm root (${join(dir, 'empty')})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Issue #401: the CLI installs its broken-pipe and signal-lock-release guards only
// when it is the main module, so the wrapper (which imports runNbCli) must install
// them itself. These drive the real wrapper under a real pipe / real signal.
describe('nb-git-wrapper process guards (issue #401)', () => {
  test.skipIf(process.platform === 'win32')('`show | head -1` through the wrapper exits 0 with no EPIPE', () => {
    // Output must exceed the ~64 KiB pipe buffer, or head closing early never
    // produces EPIPE and the test would pass without the fix.
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) lines.push(`+1\t#${i} ${'x'.repeat(180)}`);
    writeFileSync(join(nbDir, 'big.md'), lines.join('\n') + '\n');
    const r = spawnSync(
      'bash',
      ['-c', `set -o pipefail; node ${JSON.stringify(wrapper)} show big | head -1`],
      { env: { ...process.env, NB_DIR: nbDir }, encoding: 'utf-8', timeout: 20000 },
    );
    expect(r.stderr).not.toMatch(/EPIPE/);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
  });

  test.skipIf(process.platform === 'win32')('a SIGTERM while `.nb.lock` is held leaves no lock behind', async () => {
    const lock = join(nbDir, '.nb.lock');
    for (let trial = 0; trial < 5; trial++) {
      const child = spawn('node', [wrapper, 'add', 'sig-shelf', `lesson ${trial}`], {
        env: { ...process.env, NB_DIR: nbDir },
        stdio: 'ignore',
      });
      const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve, reject) => {
        child.on('exit', (code, sig) => resolve({ code, sig }));
        child.on('error', reject);
      });
      // Send the signal the moment the lock appears (or give up once it exits).
      let done = false;
      void exited.then(() => {
        done = true;
      });
      const deadline = Date.now() + 15000;
      while (!done && !existsSync(lock) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1));
      }
      if (!done) child.kill('SIGTERM');
      const { sig } = await exited;
      // Without the handler the default disposition kills it outright (sig set).
      expect(sig).toBeNull();
      expect(existsSync(lock)).toBe(false);
    }
  }, 60000);
});
