import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// Regression test for issue #165: `nb-retrospective.sh` writes a
// `.retro-<session_id>` sentinel into NB_DIR once per session and nothing ever
// removed them, so on a busy machine they accumulated without bound. The hook
// now prunes `.retro-*` files older than a TTL (default 7 days, overridable via
// NB_RETRO_TTL_DAYS) after claiming the current session's sentinel — all
// best-effort so cleanup can never block the stop. These tests drive the real
// script to assert the sentinel is still claimed (the one-nudge contract holds)
// AND that stale sentinels are reaped while fresh ones and non-sentinel files
// are left alone — and that a failing unlink can never break the stop.
const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, '..', 'examples', 'hooks', 'claude-code', 'nb-retrospective.sh');

const DAY_MS = 86400000;

let dir: string;

// Set a file's mtime to `daysAgo` days in the past.
function ageFile(path: string, daysAgo: number): void {
  const when = (Date.now() - daysAgo * DAY_MS) / 1000;
  utimesSync(path, when, when);
}

// Create a `.retro-<name>` file aged `daysAgo` days and return its path.
function seedSentinel(name: string, daysAgo: number): string {
  const p = join(dir, `.retro-${name}`);
  writeFileSync(p, 'x');
  ageFile(p, daysAgo);
  return p;
}

// Run the Stop hook against NB_DIR=dir with the given hook-input JSON and env
// overrides. NB_RETRO_TTL_DAYS is stripped from the inherited env first, so a
// developer's or CI's ambient setting can never change the default-TTL tests —
// only an explicit `env` override here is seen. Returns the block decision JSON
// written to stdout (or '').
function runHook(input: Record<string, unknown>, env: Record<string, string> = {}): string {
  const base = { ...process.env, NB_DIR: dir } as Record<string, string>;
  delete base.NB_RETRO_TTL_DAYS;
  return execFileSync('bash', [hook], {
    input: JSON.stringify(input),
    env: { ...base, ...env },
    encoding: 'utf-8',
  });
}

// Spawn `n` hook processes that each block reading stdin (the hook reads its
// JSON via `cat` before doing anything), then release every process's stdin in
// the same tick so they contend on the sentinel claim together — the closest a
// multi-process test can get to a real concurrent-SubagentStop race. Resolves to
// each process's stdout and exit code. (Process-start jitter after stdin closes
// still means overlap at the claim isn't guaranteed on every run, which is why
// the race test is paired with a deterministic loser-path guard below.)
function raceHooks(
  n: number,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Array<{ out: string; code: number | null }>> {
  const base = { ...process.env, NB_DIR: dir } as Record<string, string>;
  delete base.NB_RETRO_TTL_DAYS;
  const payload = JSON.stringify(input);

  const children = Array.from({ length: n }, () =>
    spawn('bash', [hook], { env: { ...base, ...env } }),
  );
  const done = children.map(
    (child) =>
      new Promise<{ out: string; code: number | null }>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ out, code }));
      }),
  );
  // Release every process's stdin together to maximize overlap at the claim.
  for (const child of children) child.stdin.end(payload);
  return Promise.all(done);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-retro-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retrospective.sh sentinel TTL prune (issue #165)', () => {
  test('claims the current session sentinel and blocks the stop once', () => {
    const out = runHook({ session_id: 'sess-1' });
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(true);
    expect(JSON.parse(out).decision).toBe('block');
  });

  test('a second stop (sentinel already present) lets the stop through', () => {
    runHook({ session_id: 'sess-1' });
    const out = runHook({ session_id: 'sess-1' });
    // No block decision emitted on the second stop.
    expect(out.trim()).toBe('');
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(true);
  });

  test('stop_hook_active short-circuits before writing OR pruning', () => {
    // A stale sentinel present: because the hook exits before the prune when
    // stop_hook_active is set, it must survive (guards against the prune being
    // moved above the early exit).
    const stale = seedSentinel('old', 10);
    const out = runHook({ session_id: 'sess-1', stop_hook_active: true });
    expect(out.trim()).toBe('');
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(false);
    expect(existsSync(stale)).toBe(true);
  });

  test('prunes a stale .retro-* sentinel older than the default 7d TTL', () => {
    const stale = seedSentinel('old', 10);

    const out = runHook({ session_id: 'sess-new' });

    expect(existsSync(stale)).toBe(false);
    // The new session still claimed its own sentinel and still blocked.
    expect(existsSync(join(dir, '.retro-sess-new'))).toBe(true);
    expect(JSON.parse(out).decision).toBe('block');
  });

  test('keeps a fresh .retro-* sentinel inside the TTL window', () => {
    const fresh = seedSentinel('recent', 1);
    runHook({ session_id: 'sess-new' });
    expect(existsSync(fresh)).toBe(true);
  });

  test('never reaps the session sentinel it just wrote, even under a tiny TTL', () => {
    // TTL ~14.4 min (0.01 d): comfortably above the sub-second cold start so
    // the just-written sentinel is never on the wrong side of the cutoff, yet a
    // 1-day-old control IS stale — proving the prune actually ran, not that it
    // simply pruned nothing.
    const stale = seedSentinel('control', 1);
    runHook({ session_id: 'sess-self' }, { NB_RETRO_TTL_DAYS: '0.01' });
    expect(existsSync(join(dir, '.retro-sess-self'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test('NB_RETRO_TTL_DAYS overrides the TTL', () => {
    const threeDays = seedSentinel('3d', 3);
    // TTL=1 day → a 3-day-old sentinel is stale and reaped.
    runHook({ session_id: 'sess-a' }, { NB_RETRO_TTL_DAYS: '1' });
    expect(existsSync(threeDays)).toBe(false);

    // Same age, default 7-day TTL → kept.
    const threeDaysAgain = seedSentinel('3d-again', 3);
    runHook({ session_id: 'sess-b' });
    expect(existsSync(threeDaysAgain)).toBe(true);
  });

  // Every invalid / non-positive value must fall back to the 7-day default —
  // NOT reap everything (which a `> 0` → `>= 0` slip would do under '0'), and
  // NOT reap the session's own just-written sentinel.
  test.each(['', '0', '-5', 'not-a-number', 'Infinity', 'NaN'])(
    'NB_RETRO_TTL_DAYS=%j falls back to the 7d default',
    (ttl) => {
      const old = seedSentinel('old', 10);
      const young = seedSentinel('young', 2);

      runHook({ session_id: 'sess-c' }, { NB_RETRO_TTL_DAYS: ttl });

      expect(existsSync(old)).toBe(false); // 10d > 7d → reaped
      expect(existsSync(young)).toBe(true); // 2d < 7d → kept
      expect(existsSync(join(dir, '.retro-sess-c'))).toBe(true); // own sentinel safe
    },
  );

  test('a failing unlink never breaks the stop (best-effort cleanup)', () => {
    // A `.retro-*` entry that is a DIRECTORY makes unlinkSync throw. The stop
    // must still complete (block JSON emitted), the session sentinel must still
    // be claimed, and other stale `.retro-*` files must still be reaped — i.e.
    // one failing entry neither aborts the sweep nor kills the hook.
    const retroDir = join(dir, '.retro-dir');
    mkdirSync(retroDir);
    ageFile(retroDir, 30);
    const staleA = seedSentinel('aaa-old', 30);
    const staleZ = seedSentinel('zzz-old', 30);

    const out = runHook({ session_id: 'sess-robust' });

    expect(JSON.parse(out).decision).toBe('block'); // hook did not crash
    expect(existsSync(join(dir, '.retro-sess-robust'))).toBe(true);
    expect(existsSync(retroDir)).toBe(true); // undeletable entry left in place
    // Both stale files reaped regardless of readdir order → the sweep continued
    // past the throwing directory entry.
    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleZ)).toBe(false);
  });

  test('leaves non-sentinel files (notebooks, near-miss names) untouched', () => {
    const keep = [
      'change-verifier.md', // a notebook
      '.gitkeep', // an unrelated dotfile
      '.retrospective-notes', // `.retro` but NOT `.retro-` → must not match
      'my.retro-x', // contains `retro-` but does not start with `.retro-`
    ].map((name) => {
      const p = join(dir, name);
      writeFileSync(p, 'x');
      ageFile(p, 365);
      return p;
    });

    runHook({ session_id: 'sess-d' });

    for (const p of keep) expect(existsSync(p)).toBe(true);
    // Only the session's own sentinel should exist among `.retro-` entries.
    const retros = readdirSync(dir).filter((n) => n.startsWith('.retro-'));
    expect(retros).toEqual(['.retro-sess-d']);
  });
});

describe('nb-retrospective.sh atomic sentinel claim (issue #245)', () => {
  test('concurrent stops on one session_id: exactly one blocks, every process exits 0', async () => {
    // Parallel subagents share the parent session_id and can stop at once. With
    // a non-atomic existsSync()-then-writeFileSync() claim, several processes
    // could all see the sentinel absent and all emit `block`. The atomic `wx`
    // create lets exactly one win; the losers throw EEXIST and exit 0. Spawn
    // many real hook processes against ONE session_id and release their stdin
    // together (see raceHooks) so they contend on the claim at once. Overlap at
    // the claim is timing-dependent, so run several independent rounds: the fix
    // holds the invariant every round, while a non-atomic claim breaks it as
    // soon as any one round actually overlaps.
    const N = 24;
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      const session = `sess-race-${round}`;
      const runs = await raceHooks(N, { session_id: session });

      const blocks = runs.filter((r) => r.out.trim() !== '');
      expect(blocks).toHaveLength(1);
      expect(JSON.parse(blocks[0].out).decision).toBe('block');
      // Every other process let its stop through with no block decision …
      expect(runs.filter((r) => r.out.trim() === '')).toHaveLength(N - 1);
      // … and did so cleanly (exit 0), not by crashing with empty stdout.
      expect(runs.every((r) => r.code === 0)).toBe(true);
      // This round claimed exactly one sentinel and the losers left no stray
      // temp files: the `.retro-*` count grows by exactly one per round.
      const retros = readdirSync(dir).filter((n) => n.startsWith('.retro-'));
      expect(retros).toContain(`.retro-${session}`);
      expect(retros).toHaveLength(round + 1);
    }
  });

  test('a loser finding the sentinel already present exits 0 without overwriting it', () => {
    // Deterministic companion to the race (whose overlap is timing-dependent):
    // the EEXIST path must allow the stop (no block) AND leave the existing
    // sentinel untouched — proving the claim uses `wx` (create-only), never `w`,
    // which would truncate and, by never throwing EEXIST, reintroduce the
    // double-nudge bug.
    const sentinel = join(dir, '.retro-sess-pre');
    writeFileSync(sentinel, 'ORIGINAL-CLAIM');
    const out = runHook({ session_id: 'sess-pre' });
    expect(out.trim()).toBe('');
    expect(readFileSync(sentinel, 'utf-8')).toBe('ORIGINAL-CLAIM');
  });
});

describe('nb-retrospective.sh length target (issue #342)', () => {
  test('the nudge gives an actionable ~150-char target while keeping the 200 cap', () => {
    const reason = (JSON.parse(runHook({ session_id: 'sess-len' })) as { reason: string }).reason;
    expect(reason).toContain('<=200-char lesson');
    expect(reason).toMatch(/aim for ~150 chars/);
    expect(reason).toMatch(/rejected, not truncated/);
  });
});
