import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
