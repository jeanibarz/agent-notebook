import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, rmdirSync, mkdirSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Guards issue #271: the wrapper's git section used to run with no lock of its
// own, AFTER the package had already released its `.nb.lock`. Under the parallel
// subagent workloads this project anticipates, two wrapper processes interleave:
// process 1's `git add -A` stages BOTH its own and process 2's already-written
// .md, so one commit carries two changes under a single, mislabelled message and
// process 2 finds nothing staged — its commit silently dropped (or the two git
// invocations collide on index.lock). The fix wraps the whole read-modify-write
// (CLI write AND commit) in a per-NB_DIR `.nb-git.lock` mkdir spinlock that is
// fail-open. We drive the REAL wrapper against throwaway git repos and assert
// the serialization behavior end to end.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wrapper = join(root, 'examples', 'nb-git-wrapper.mjs');
const source = readFileSync(wrapper, 'utf-8');

let nbDir: string;

/** A throwaway git repo seeded with one empty commit, so HEAD exists and commit
 *  counting starts from a known baseline. Identity lives in the repo config so no
 *  GIT_* env is needed. */
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

/** Subjects of the most recent `n` commits, newest first. */
function recentSubjects(dir: string, n: number): string[] {
  return execFileSync('git', ['-C', dir, 'log', `-${n}`, '--format=%s'], { encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.length > 0);
}

/** The files a single commit (by subject) changed — used to prove no bundling. */
function filesInCommitBySubject(dir: string, subject: string): string[] {
  const sha = execFileSync('git', ['-C', dir, 'log', '--format=%H', '--grep', `^${subject}$`, '-1'], {
    encoding: 'utf-8',
  }).trim();
  if (!sha) return [];
  return execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', sha], { encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Drive the real wrapper synchronously. The wrapper resolves `agent-notebook`
 *  by self-reference to this repo's freshly-built dist/cli.js (pretest builds it). */
function runWrapper(args: string[], env: NodeJS.ProcessEnv = {}): number {
  const r = spawnSync('node', [wrapper, ...args], {
    env: { ...process.env, NB_DIR: nbDir, ...env },
    encoding: 'utf-8',
    timeout: 20000,
  });
  return r.status ?? 1;
}

/** Drive the real wrapper asynchronously, resolving with its exit code. */
function runWrapperAsync(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('node', [wrapper, ...args], {
      env: { ...process.env, NB_DIR: nbDir },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  nbDir = mkdtempSync(join(tmpdir(), 'nb-git-wrapper-lock-'));
  seedRepo(nbDir);
});
afterEach(() => {
  rmSync(nbDir, { recursive: true, force: true });
});

describe('nb-git-wrapper git-section lock (issue #271)', () => {
  test('the source serializes the git section with a per-NB_DIR `.nb-git.lock`, distinct from `.nb.lock`', () => {
    // Pin the literal mechanism so a refactor that drops the lock fails here,
    // independent of the behavioral tests below.
    expect(source).toContain('withGitLock');
    expect(source).toContain('.nb-git.lock');
    // Atomic mkdir spinlock, not a flag file or a plain writeFile.
    expect(source).toMatch(/mkdirSync\(lock\)/);
    // Per-change staging is the bundling fix: stage everything except shelves,
    // then add back only this command's. Pin the exclude so a regression to a
    // bare `git add -A` (which bundles siblings' .md) fails here.
    expect(source).toContain(':(exclude)*.md');
    // The git lock must NOT reuse the package's own write lock name — sharing
    // `.nb.lock` would starve the CLI's write lock.
    expect(source).not.toMatch(/join\(\s*dir\s*,\s*['"]\.nb\.lock['"]\s*\)/);
    // Lesson-first: the lock lives in autoCommit (the git section), never around
    // the CLI write. The behavioral test below proves the lesson is written even
    // while the commit lock is held; here we pin that withGitLock is called from
    // autoCommit, not from main's run of the CLI.
    expect(source).toMatch(/async function autoCommit[\s\S]*?withGitLock\(/);
  });

  test('concurrent mutating commands each produce their own one-change commit (no bundling, no dropped commit)', async () => {
    // Warm up so `.gitignore` is already seeded and committed: a clean tree means
    // each later commit adds exactly ONE shelf file, making the no-bundling
    // assertion sharp.
    expect(runWrapper(['add', 'warmup', 'a baseline lesson'])).toBe(0);
    const before = commitCount(nbDir);

    // Fire several wrappers at once. This exercises BOTH guards end to end: the
    // per-change staging (so no commit bundles a sibling's already-written .md)
    // and the lock (so the concurrent git invocations don't collide on index.lock
    // and drop a commit). A wider fan-out raises the odds of a real interleave.
    const shelves = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota'];
    const codes = await Promise.all(shelves.map((s) => runWrapperAsync(['add', s, `lesson for ${s}`])));
    expect(codes.every((c) => c === 0)).toBe(true);

    // 1) No dropped commit: exactly one new commit per concurrent change.
    expect(commitCount(nbDir)).toBe(before + shelves.length);

    // 2) Accurate messages: the new commit subjects are exactly one per shelf.
    const expected = shelves.map((s) => `nb add ${s}`).sort();
    expect(recentSubjects(nbDir, shelves.length).sort()).toEqual(expected);

    // 3) No bundling: each commit changed exactly its own single shelf file.
    for (const s of shelves) {
      expect(filesInCommitBySubject(nbDir, `nb add ${s}`)).toEqual([`${s}.md`]);
    }
  });

  test('a global flag before the shelf (--json / --reason) still commits exactly that shelf, never dropped', () => {
    // Per-change staging must resolve the shelf the way the CLI does: --json,
    // --reason <code>, and --note <text> may precede the shelf, so reading raw
    // argv[1] would miss it, stage nothing, and DROP the commit (the file stays
    // untracked). Warm up first so each later commit is a clean, single-file one.
    expect(runWrapper(['add', 'warmup', 'a baseline lesson'])).toBe(0);

    // --json: a valueless global flag before the shelf.
    let before = commitCount(nbDir);
    expect(runWrapper(['add', '--json', 'viajson', 'a lesson added json-first'])).toBe(0);
    expect(existsSync(join(nbDir, 'viajson.md'))).toBe(true);
    expect(commitCount(nbDir)).toBe(before + 1); // committed, not dropped
    expect(filesInCommitBySubject(nbDir, 'nb add viajson')).toEqual(['viajson.md']);

    // --reason <code>: a global flag that CONSUMES its next token, before the shelf.
    before = commitCount(nbDir);
    expect(runWrapper(['add', '--reason', 'other', 'viareason', 'a lesson added reason-first'])).toBe(0);
    expect(existsSync(join(nbDir, 'viareason.md'))).toBe(true);
    expect(commitCount(nbDir)).toBe(before + 1);
    expect(filesInCommitBySubject(nbDir, 'nb add viareason')).toEqual(['viareason.md']);
  });

  test("a crashed wrapper's stale lock is reclaimed, so one dead process cannot wedge commits", () => {
    const lock = join(nbDir, '.nb-git.lock');
    mkdirSync(lock); // an abandoned, empty lock dir
    // Age it past the stale threshold (30s) so it reads as a crashed holder's.
    const past = new Date(Date.now() - 120_000);
    utimesSync(lock, past, past);
    const before = commitCount(nbDir);

    // The wrapper must reclaim the stale lock and still commit — not give up, not
    // hang for the full budget.
    expect(runWrapper(['add', 'recovered', 'a lesson after a crash'])).toBe(0);
    expect(commitCount(nbDir)).toBe(before + 1);
    // The lock is reclaimed, used, and released — never left behind.
    expect(existsSync(lock)).toBe(false);
  });

  test('a held `.nb-git.lock` blocks the COMMIT but NOT the lesson write (lesson-first invariant)', async () => {
    const lock = join(nbDir, '.nb-git.lock');
    mkdirSync(lock); // a fresh (not stale) holder, so the wrapper waits rather than stealing
    const before = commitCount(nbDir);

    const done = runWrapperAsync(['add', 'blocked', 'a lesson that must survive']);
    // The lesson is written FIRST, before the git lock is ever taken, so it lands
    // on disk even while we hold the lock. Wait for it to appear (node boot + CLI).
    for (let i = 0; i < 100 && !existsSync(join(nbDir, 'blocked.md')); i++) await sleep(20);
    expect(existsSync(join(nbDir, 'blocked.md')), 'the lesson must be written despite the held lock').toBe(true);

    // ...but the COMMIT is serialized behind the lock: it must not land while we
    // hold it. Assert that as a sustained invariant for a spell.
    for (let i = 0; i < 10; i++) {
      await sleep(100);
      expect(commitCount(nbDir)).toBe(before);
    }

    // Release the lock; the wrapper then acquires it and commits.
    rmdirSync(lock);
    expect(await done).toBe(0);
    expect(commitCount(nbDir)).toBe(before + 1);
  });
});
