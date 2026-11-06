import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
