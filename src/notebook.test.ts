import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
// The built CLI, used to drive REAL cross-process contention on the mkdir lock
// (the actual hazard: several `nb` invocations mutating one shelf at once).
// `npm test` builds dist/ via the pretest script before vitest runs.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Durable-write observation hook (issue #15). `node:fs` is wrapped so a test can
// observe the fsync/rename order and simulate a platform where directory fsync
// throws. Everything delegates to the real fs; when `events` is null and
// `failDirFsync` is false (the default, reset in afterEach) behavior is identical
// to the unwrapped module, so every other test is unaffected.
const fsHook = vi.hoisted(() => ({ events: null as string[] | null, renames: null as string[] | null, reads: null as string[] | null, failDirFsync: false, failBodyFsync: false, failRenameTo: null as string | null, failLockMkdirCode: null as string | null, failReadOnceCode: null as string | null, failCodelessRead: false, failReaddirCode: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], opts?: Parameters<typeof actual.readFileSync>[1]) => {
      fsHook.reads?.push(String(path)); // capture read paths (opt-in; null by default)
      if (fsHook.failCodelessRead && String(path).endsWith('.md')) {
        // Simulate a throw with NO errno `code` (a parser TypeError on malformed
        // input, a programming bug) — not a filesystem read failure (issue #332).
        throw new TypeError('simulated parser bug (no errno)');
      }
      if (fsHook.failReadOnceCode !== null && String(path).endsWith('.md')) {
        // One-shot fault injection (issue #300): simulate the file vanishing / failing after existsSync.
        const code = fsHook.failReadOnceCode;
        fsHook.failReadOnceCode = null;
        throw Object.assign(new Error(`${code}: injected read failure for ${path}`), { code });
      }
      return actual.readFileSync(path, opts as never);
    }) as typeof actual.readFileSync,
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], opts?: Parameters<typeof actual.readdirSync>[1]) => {
      // Opt-in fault injection for the notebooks-directory listing (issue #383):
      // a non-empty string throws with that errno `code`; the empty string throws
      // a codeless TypeError (a bug, not a filesystem failure).
      if (fsHook.failReaddirCode !== null) {
        if (fsHook.failReaddirCode === '') throw new TypeError('simulated bug in readdir (no errno)');
        throw Object.assign(new Error(`${fsHook.failReaddirCode}: injected readdir failure for ${path}`), { code: fsHook.failReaddirCode });
      }
      return actual.readdirSync(path, opts as never);
    }) as typeof actual.readdirSync,
    fsyncSync: (fd: number) => {
      const isDir = actual.fstatSync(fd).isDirectory();
      fsHook.events?.push(isDir ? 'fsync-dir' : 'fsync-body');
      if (isDir && fsHook.failDirFsync) throw new Error('EINVAL: directory fsync unsupported');
      if (!isDir && fsHook.failBodyFsync) throw new Error('EIO: body fsync failed');
      return actual.fsyncSync(fd);
    },
    renameSync: ((from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      fsHook.events?.push('rename');
      fsHook.renames?.push(String(from)); // capture the temp source path (opt-in; null by default)
      // Opt-in crash injection: fail the atomic rename for exactly one target
      // file (the final `<shelf>.md`, not the temp), so a test can simulate an
      // interruption of a specific write. The attempt is still recorded above, so
      // `renames` preserves the real write order even for the write that throws.
      if (fsHook.failRenameTo !== null && String(to) === fsHook.failRenameTo) {
        throw new Error(`EIO: injected rename failure for ${fsHook.failRenameTo}`);
      }
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
    mkdirSync: ((path: Parameters<typeof actual.mkdirSync>[0], opts?: Parameters<typeof actual.mkdirSync>[1]) => {
      // Opt-in fault injection for withLock's acquire path (issue #263): make the
      // `mkdirSync(.nb.lock)` that acquires the lock throw a specific errno code
      // (EACCES/EROFS/ENOSPC/…), simulating an unwritable NB_DIR. Scoped to the
      // lock dir only so the recursive `mkdirSync(dir, { recursive: true })` that
      // precedes it still creates the store.
      if (fsHook.failLockMkdirCode !== null && String(path).endsWith('.nb.lock')) {
        const err = new Error(`${fsHook.failLockMkdirCode}: injected mkdir failure for ${path}`) as NodeJS.ErrnoException;
        err.code = fsHook.failLockMkdirCode;
        throw err;
      }
      return actual.mkdirSync(path, opts as never);
    }) as typeof actual.mkdirSync,
  };
});

import {
  activityByDay,
  addEntry,
  assertSafeRole,
  assertSafeShelf,
  classifyError,
  dedupKey,
  diagnoseEngagement,
  entryId,
  formatEvictedUsage,
  similarity,
  getDescription,
  getMetaValue,
  isMetaLine,
  isConflictMarker,
  isValidWindow,
  listNotebooks,
  listRoles,
  listShelves,
  logUsage,
  maxChars,
  maxLines,
  merge,
  move,
  nearThreshold,
  NbError,
  ERROR_CLASSES,
  normalizeReason,
  notebookExists,
  parseUsage,
  parseWindowMs,
  noteRecovery,
  drainPendingRecovery,
  stealStale,
  readEntries,
  reapLeftoverTemps,
  readMetaLines,
  readShelf,
  remove,
  render,
  renderEntries,
  sanitizeLesson,
  stripControlChars,
  asciiMode,
  search,
  setDescription,
  setMetaValue,
  showJson,
  showJsonMany,
  staleCandidates,
  sparkGlyphs,
  sparkline,
  split,
  stats,
  STATS_SCHEMA_VERSION,
  usageRing,
  usageRingSlack,
  expandHomeDir,
  notebooksDir,
  vote,
  voteMany,
  releaseHeldLock,
  withLock,
  resolveIntEnv,
} from './notebook.js';
import type { UsageRow } from './notebook.js';

/**
 * A complete `UsageRow` with every column at its empty value, overridden by `over`.
 * Fixtures built through this helper break at type-check time (tsconfig.test.json)
 * when `UsageRow` gains a required column, instead of silently going stale.
 */
function usageRow(over: Partial<UsageRow> = {}): UsageRow {
  return {
    ts: 't', role: 'r', command: 'add', ok: true, ms: 1, session: '', entries: [],
    outcome: '', collided: '', evicted: '', reason: '', note: '',
    errorClass: '', decayed: '', recovered: '', misses: 0,
    ...over,
  };
}
import { runNbCli } from './cli.js';

let dir: string;
const SAVED = { ...process.env };
// Every NB_* env var this suite reads or sets. Hoisted to one list so the
// clean-baseline `beforeEach` and the restore-to-parent `afterEach` can never
// drift apart (issue #230).
const MANAGED_ENV = [
  'NB_MAX_LINES',
  'NB_MAX_CHARS',
  'NB_USAGE_RING',
  'NB_NEAR_DUP',
  'NB_LOOP_N',
  'NB_LOOP_WINDOW_S',
  'NB_SILENT_H',
  'NB_ERR_MIN',
  'NB_ADD_BURST_N',
  'NB_ERR_RATE',
  'NB_SESSION',
  'NB_COVERAGE_HI',
  'NB_RECALL_MISS_HI',
  'NB_STALE_LOCK_MS',
  'NB_LOCK_GRACE_MS',
] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-'));
  // Establish a clean baseline: clear every managed NB_* var so an ambient
  // value the host exported (most often NB_SESSION — agents and CI-adjacent
  // tooling set it) cannot leak into a test that assumes it is unset. A test
  // that needs a variable set already sets it explicitly (issue #230).
  for (const k of MANAGED_ENV) delete process.env[k];
  // The crash-recovery tally (issue #309) is process-global module state, not
  // env: reset it so a steal/reap in one test (counted via withLock but not yet
  // drained by a logUsage) can never leak its count into a later test's row.
  drainPendingRecovery();
});
afterEach(() => {
  for (const k of MANAGED_ENV) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  fsHook.reads = null; // leave the shared read hook off for tests that don't opt in
  fsHook.failLockMkdirCode = null; // clear lock-mkdir fault injection (issue #263) so it can never leak into another test
  fsHook.failReadOnceCode = null; // clear one-shot read fault injection (issue #300)
  fsHook.failCodelessRead = false; // clear codeless-throw fault injection (issue #332)
  fsHook.failReaddirCode = null; // clear readdir fault injection (issue #383)
  rmSync(dir, { recursive: true, force: true });
});

describe('add / read / render', () => {
  test('adds a lesson and reads it back with score +1', async () => {
    const r = await addEntry(dir, 'patcher', 'prefer execFileSync, array args');
    expect(r.added).toBe(true);
    expect(r.size).toBe(1);
    const entries = readEntries(dir, 'patcher');
    expect(entries).toEqual([{ score: 1, text: 'prefer execFileSync, array args' }]);
  });

  test('persists on disk as "<score>\\t<lesson>"', async () => {
    await addEntry(dir, 'patcher', 'run pnpm lint before done');
    const raw = readFileSync(join(dir, 'patcher.md'), 'utf-8');
    expect(raw).toBe('+1\trun pnpm lint before done\n');
  });

  test('render shows a stable id + score, highest score first', async () => {
    await addEntry(dir, 'v', 'aaa');
    await addEntry(dir, 'v', 'bbb');
    await vote(dir, 'v', 'bbb', 1); // bbb -> +2, ranks first
    const out = render(dir, 'v');
    expect(out.split('\n')[0]).toBe(`${entryId('bbb')}  [+2]  bbb`);
    expect(out.split('\n')[1]).toBe(`${entryId('aaa')}  [+1]  aaa`);
  });

  test('empty notebook renders a friendly message', () => {
    expect(render(dir, 'nobody')).toContain('is empty');
  });
});

describe('voteMany (batch vote)', () => {
  test('applies one delta to several ids and persists all score changes', async () => {
    await addEntry(dir, 'v', 'alpha');
    await addEntry(dir, 'v', 'bravo');
    await addEntry(dir, 'v', 'charlie');
    const res = await voteMany(dir, 'v', [entryId('alpha'), entryId('charlie')], 1);
    expect(res.map((r) => r.id)).toEqual([entryId('alpha'), entryId('charlie')]);
    expect(res.every((r) => r.error === undefined)).toBe(true);
    const byText = Object.fromEntries(readEntries(dir, 'v').map((e) => [e.text, e.score]));
    expect(byText).toEqual({ alpha: 2, bravo: 1, charlie: 2 });
  });

  test('best-effort: an unresolved id is reported but never aborts the rest', async () => {
    await addEntry(dir, 'v', 'alpha');
    await addEntry(dir, 'v', 'bravo');
    const res = await voteMany(dir, 'v', [entryId('alpha'), 'ffffff', entryId('bravo')], 1);
    const landed = res.filter((r) => r.id !== undefined);
    const failed = res.filter((r) => r.error !== undefined);
    expect(landed.map((r) => r.id)).toEqual([entryId('alpha'), entryId('bravo')]);
    expect(failed).toHaveLength(1);
    expect(failed[0].selector).toBe('ffffff');
    const byText = Object.fromEntries(readEntries(dir, 'v').map((e) => [e.text, e.score]));
    expect(byText).toEqual({ alpha: 2, bravo: 2 });
  });

  test('when no id resolves, nothing is written and every item carries an error', async () => {
    await addEntry(dir, 'v', 'alpha');
    const res = await voteMany(dir, 'v', ['ffffff', 'eeeeee'], 1);
    expect(res.every((r) => r.error !== undefined && r.id === undefined)).toBe(true);
    expect(readEntries(dir, 'v')).toEqual([{ score: 1, text: 'alpha' }]);
  });

  test('a repeated id votes twice but the file keeps exactly one row for it', async () => {
    await addEntry(dir, 'v', 'alpha');
    const res = await voteMany(dir, 'v', [entryId('alpha'), entryId('alpha')], 1);
    expect(res).toHaveLength(2);
    const entries = readEntries(dir, 'v');
    expect(entries).toEqual([{ score: 3, text: 'alpha' }]); // +1 base, +1, +1
  });

  test('touched entries move to the fresh end in first-touch order (recency preserved)', async () => {
    await addEntry(dir, 'v', 'alpha'); // oldest
    await addEntry(dir, 'v', 'bravo');
    await addEntry(dir, 'v', 'charlie'); // newest
    // File order is least-recently-touched first: alpha, bravo, charlie.
    await voteMany(dir, 'v', [entryId('charlie'), entryId('alpha')], 1);
    // charlie then alpha are touched → they move to the end in that order; bravo
    // (untouched) is now the stalest, so file order is bravo, charlie, alpha.
    expect(readEntries(dir, 'v').map((e) => e.text)).toEqual(['bravo', 'charlie', 'alpha']);
  });

  test('a batch downvote lowers every targeted score', async () => {
    await addEntry(dir, 'v', 'alpha');
    await addEntry(dir, 'v', 'bravo');
    await voteMany(dir, 'v', [entryId('alpha'), entryId('bravo')], -1);
    const byText = Object.fromEntries(readEntries(dir, 'v').map((e) => [e.text, e.score]));
    expect(byText).toEqual({ alpha: 0, bravo: 0 });
  });

  test('rejects a bad delta, an empty selector list, and an empty shelf', async () => {
    await addEntry(dir, 'v', 'alpha');
    await expect(voteMany(dir, 'v', [entryId('alpha')], 2)).rejects.toThrow(/delta/);
    await expect(voteMany(dir, 'v', [], 1)).rejects.toThrow(/at least one/);
    await expect(voteMany(dir, 'empty', [entryId('alpha')], 1)).rejects.toThrow(/empty/);
  });
});

describe('dedup', () => {
  test('skips a near-identical lesson (case/punctuation-insensitive)', async () => {
    await addEntry(dir, 'c', 'Prefer execFileSync, array args.');
    const r = await addEntry(dir, 'c', 'prefer execfilesync array args');
    expect(r.added).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(readEntries(dir, 'c')).toHaveLength(1);
  });

  test('dedupKey normalizes case, punctuation, whitespace', () => {
    // Assert the concrete normalized value, not just that two inputs agree: a
    // dedupKey that returned a constant would satisfy an equality-only check but
    // fail here (and would wrongly collapse every lesson into one).
    expect(dedupKey('Use   execFileSync!!')).toBe('use execfilesync');
    expect(dedupKey('use execfilesync')).toBe('use execfilesync');
  });

  test('distinct lessons are both kept', async () => {
    await addEntry(dir, 'c', 'lesson one');
    await addEntry(dir, 'c', 'lesson two');
    expect(readEntries(dir, 'c')).toHaveLength(2);
  });
});

describe('near-duplicate advisory (FR-ADD-008)', () => {
  test('similarity is 1 for identical normal forms, 0 for disjoint, and in-between for a paraphrase', () => {
    expect(similarity('run lint before done', 'run lint before done')).toBe(1);
    expect(similarity('Run LINT before done!', 'run lint before done')).toBe(1); // normal-form equal
    expect(similarity('xyz', 'run lint before done')).toBeLessThan(0.1);
    const s = similarity('run lint before claiming done', 'lint before claiming complete');
    expect(s).toBeGreaterThan(0.3);
    expect(s).toBeLessThan(1);
    // Empty / punctuation-only normal forms stay finite in [0,1] (no guard, no NaN).
    expect(similarity('', '')).toBe(1);
    const e = similarity('', 'abc');
    expect(e).toBeGreaterThanOrEqual(0);
    expect(e).toBeLessThanOrEqual(1);
  });

  test('NB_NEAR_DUP=0 disables the advisory entirely (no spurious near-match on every add)', async () => {
    process.env.NB_NEAR_DUP = '0';
    await addEntry(dir, 'c', 'run lint before claiming done');
    const r = await addEntry(dir, 'c', 'run lint before claiming complete');
    expect(r.added).toBe(true);
    expect(r.nearId).toBeUndefined();
    delete process.env.NB_NEAR_DUP;
  });

  test('ties resolve to the earliest-stored entry (first-wins)', async () => {
    process.env.NB_NEAR_DUP = '0.3';
    // Two existing entries exactly equidistant from the candidate — their
    // differing suffixes share no trigrams with it and are the same length, so
    // similarity ties (0.85 each). Added oldest-first; the advisory names the FIRST.
    await addEntry(dir, 'c', 'always rotate the token qqqqq');
    await addEntry(dir, 'c', 'always rotate the token wwwww');
    const r = await addEntry(dir, 'c', 'always rotate the token');
    expect(r.added).toBe(true);
    expect(r.nearId).toBe(entryId('always rotate the token qqqqq')); // earliest wins
    delete process.env.NB_NEAR_DUP;
  });

  test('a resembling (non-exact) lesson is STILL stored and carries a near-match id — it never blocks', async () => {
    process.env.NB_NEAR_DUP = '0.4';
    await addEntry(dir, 'c', 'run lint before claiming done');
    const r = await addEntry(dir, 'c', 'run lint before claiming complete');
    expect(r.added).toBe(true); // non-blocking: the lesson is NOT lost
    expect(r.reason).toBe('added');
    expect(r.nearId).toBe(entryId('run lint before claiming done'));
    expect(r.nearText).toBe('run lint before claiming done');
    expect(readEntries(dir, 'c')).toHaveLength(2); // both kept
    delete process.env.NB_NEAR_DUP;
  });

  test('an exact-normal-form duplicate still hard-blocks (not downgraded to an advisory)', async () => {
    process.env.NB_NEAR_DUP = '0.4';
    await addEntry(dir, 'c', 'prefer execFileSync');
    const r = await addEntry(dir, 'c', 'Prefer  execFileSync!');
    expect(r.added).toBe(false);
    expect(r.reason).toBe('duplicate');
    expect(r.nearId).toBeUndefined();
    delete process.env.NB_NEAR_DUP;
  });

  test('a dissimilar lesson is added with no near-match attached', async () => {
    await addEntry(dir, 'c', 'run lint before done');
    const r = await addEntry(dir, 'c', 'rotate the TLS certificate yearly');
    expect(r.added).toBe(true);
    expect(r.nearId).toBeUndefined();
  });

  test('a higher threshold suppresses the advisory for a weak resemblance', async () => {
    process.env.NB_NEAR_DUP = '0.95';
    await addEntry(dir, 'c', 'run lint before claiming done');
    const r = await addEntry(dir, 'c', 'run lint before claiming complete');
    expect(r.added).toBe(true);
    expect(r.nearId).toBeUndefined(); // below the (very high) bar ⇒ no advisory
    delete process.env.NB_NEAR_DUP;
  });
});

describe('caps', () => {
  test('sanitizeLesson collapses to one line but does NOT truncate', () => {
    process.env.NB_MAX_CHARS = '20';
    const s = sanitizeLesson('this is\n a very   long\tlesson that exceeds the cap by a lot');
    expect(s).not.toContain('\n');
    expect(s).not.toContain('\t');
    expect(s.length).toBeGreaterThan(20); // full length preserved, not cut to the cap
    expect(maxChars()).toBe(20);
  });

  test('rejects an over-length lesson instead of truncating it', async () => {
    process.env.NB_MAX_CHARS = '30';
    const r = await addEntry(dir, 'c', 'x'.repeat(50));
    expect(r.added).toBe(false);
    expect(r.reason).toBe('too-long');
    expect(r.length).toBe(50);
    expect(r.overflow).toBe(20); // 50 - 30: how much to trim (issue #239)
    expect(readEntries(dir, 'c')).toHaveLength(0); // nothing stored
    const ok = await addEntry(dir, 'c', 'y'.repeat(30)); // exactly at the cap
    expect(ok.added).toBe(true);
    expect(readEntries(dir, 'c')[0].text).toHaveLength(30); // stored in full
  });

  test('evicts the LOWEST-scored line when full (ties: oldest)', async () => {
    process.env.NB_MAX_LINES = '3';
    await addEntry(dir, 'r', 'oldest');   // +1
    await addEntry(dir, 'r', 'middle');   // +1
    await addEntry(dir, 'r', 'useful');   // +1
    await vote(dir, 'r', 'useful', 1);    // useful -> +2
    const r = await addEntry(dir, 'r', 'newcomer'); // now 4 > cap 3 -> evict lowest, ties oldest
    expect(r.evicted?.text).toBe('oldest'); // +1 tie with 'middle', 'oldest' is older
    const texts = readEntries(dir, 'r').map((e) => e.text).sort();
    expect(texts).toEqual(['middle', 'newcomer', 'useful']);
  });

  // Issues #414 and #437: docs/eviction-and-aging.md quotes this sequence. The
  // aging dock moves the docked line to the fresh end, so a run of unrelated
  // adds takes one point from each proven lesson in turn. The first add must
  // evict one of them (every line is proven and the newcomer is protected);
  // after that none is lost until each has been docked once.
  test('a run of unrelated adds docks each proven lesson once before it evicts a second one (#414, #437)', async () => {
    process.env.NB_MAX_LINES = '10';
    const originals: string[] = [];
    for (let i = 0; i < 10; i++) {
      const t = `proven lesson number ${i} about topic${i}`;
      originals.push(t);
      await addEntry(dir, 'burst', t);
      await vote(dir, 'burst', t, 1); // +1 -> +2
      await vote(dir, 'burst', t, 1); // +2 -> +3
    }
    const survivors: number[] = [];
    for (let i = 0; i < 20; i++) {
      await addEntry(dir, 'burst', `unrelated junk entry ${i} zzq${i}`);
      const now = readEntries(dir, 'burst');
      const left = now.filter((e) => originals.includes(e.text)).length;
      survivors.push(left);
      // Through the eleventh add the one line that is not an original is the
      // newest add: each of the first ten newcomers was evicted by the add that
      // followed it. The twelfth add evicts an original instead, so the
      // eleventh newcomer is the first to survive the add that follows it.
      const others = now.filter((e) => !originals.includes(e.text)).map((e) => e.text);
      if (i <= 10) expect(others).toEqual([`unrelated junk entry ${i} zzq${i}`]);
      if (i === 11) expect(others).toEqual(['unrelated junk entry 10 zzq10', 'unrelated junk entry 11 zzq11']);
      if (i === 8) {
        // Nine adds in: the nine surviving originals have each lost exactly one point.
        const scores = readEntries(dir, 'burst').filter((e) => originals.includes(e.text)).map((e) => e.score);
        expect(scores).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
      }
    }
    expect(survivors).toEqual([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4]);
  }, 30_000);

  // Issue #437: WHERE the docked line lands. It goes to the very end of the
  // file, after the newcomer, and every other survivor keeps its place.
  test('the docked line moves to the end of the file, after the newcomer (#437)', async () => {
    process.env.NB_MAX_LINES = '4';
    for (const t of ['alpha', 'bravo', 'charlie', 'delta']) await addEntry(dir, 'o', t);
    for (const t of ['alpha', 'bravo', 'charlie']) await vote(dir, 'o', t, 1); // file: delta+1, alpha+2, bravo+2, charlie+2
    const r = await addEntry(dir, 'o', 'echo');
    expect(r.evicted?.text).toBe('delta'); // lowest score
    expect(r.decayed?.text).toBe('alpha'); // stalest survivor
    expect(readEntries(dir, 'o')).toEqual([
      { score: 2, text: 'bravo' },
      { score: 2, text: 'charlie' },
      { score: 1, text: 'echo' },
      { score: 1, text: 'alpha' }, // docked +2 -> +1 and moved after the newcomer
    ]);
    // The next add docks the NEXT stalest line (bravo), not alpha again, and
    // evicts the previous newcomer: it is as low as alpha and now staler.
    const r2 = await addEntry(dir, 'o', 'foxtrot');
    expect(r2.evicted?.text).toBe('echo');
    expect(r2.decayed?.text).toBe('bravo');
    expect(readEntries(dir, 'o')).toEqual([
      { score: 2, text: 'charlie' },
      { score: 1, text: 'alpha' },
      { score: 1, text: 'foxtrot' },
      { score: 1, text: 'bravo' },
    ]);
  });

  test('a move into a full shelf and a split of a full shelf also send the docked line to the end (#437)', async () => {
    process.env.NB_MAX_LINES = '3';
    for (const t of ['alpha', 'bravo', 'charlie']) await addEntry(dir, 'to', t);
    await vote(dir, 'to', 'bravo', 1);
    await vote(dir, 'to', 'charlie', 1); // file: alpha+1, bravo+2, charlie+2
    await addEntry(dir, 'from', 'moved lesson');
    const m = await move(dir, 'from', 'to', 'moved lesson');
    expect(m.evicted?.text).toBe('alpha');
    expect(m.decayed?.text).toBe('bravo');
    expect(readEntries(dir, 'to')).toEqual([
      { score: 2, text: 'charlie' },
      { score: 1, text: 'moved lesson' },
      { score: 1, text: 'bravo' }, // docked, after the moved-in lesson
    ]);
    // split: charlie (the stalest) becomes two new lines, both protected. The
    // shelf is over its cap by one, so 'moved lesson' (lowest score, staler than
    // bravo) is evicted; the dock falls on the stalest survivor, bravo, which
    // lands after both halves.
    const sp = await split(dir, 'to', 'charlie', 'first half of charlie', 'second half of charlie');
    expect(sp.evicted?.text).toBe('moved lesson');
    expect(sp.decayed?.text).toBe('bravo');
    expect(readEntries(dir, 'to')).toEqual([
      { score: 2, text: 'first half of charlie' },
      { score: 2, text: 'second half of charlie' },
      { score: 0, text: 'bravo' },
    ]);
  });

  // docs/eviction-and-aging.md §7.2 traces this shelf round by round.
  test('worked example §7.2: two quiet +3 lessons take the docks in turn; one vote decides which leaves first (#437)', async () => {
    process.env.NB_MAX_LINES = '4';
    const seed = async (shelf: string) => {
      for (const t of ['S', 'T']) {
        await addEntry(dir, shelf, t);
        await vote(dir, shelf, t, 1);
        await vote(dir, shelf, t, 1); // -> +3
      }
      await addEntry(dir, shelf, 'u');
      await addEntry(dir, shelf, 'v');
    };
    const file = (shelf: string) => readEntries(dir, shelf).map((e) => `${e.text} ${e.score > 0 ? '+' : ''}${e.score}`).join(' · ');
    await seed('w');
    expect(file('w')).toBe('S +3 · T +3 · u +1 · v +1');
    const rounds: string[] = [];
    const evictedAt: Record<string, number> = {};
    for (let n = 1; n <= 9; n++) {
      const r = await addEntry(dir, 'w', `n${n}`);
      if (n <= 6) rounds.push(file('w'));
      if (r.evicted) evictedAt[r.evicted.text] = n;
    }
    expect(rounds).toEqual([
      'T +3 · v +1 · n1 +1 · S +2',
      'n1 +1 · S +2 · n2 +1 · T +2',
      'n2 +1 · T +2 · n3 +1 · S +1',
      'n3 +1 · S +1 · n4 +1 · T +1',
      'n4 +1 · T +1 · n5 +1 · S 0',
      'T +1 · n5 +1 · n6 +1 · n4 0',
    ]);
    expect(evictedAt.S).toBe(6);
    expect(evictedAt.T).toBe(8);
    // The same shelf, with one upvote on S after round 3.
    await seed('x');
    const evictedAtX: Record<string, number> = {};
    for (let n = 1; n <= 9; n++) {
      const r = await addEntry(dir, 'x', `n${n}`);
      if (r.evicted) evictedAtX[r.evicted.text] = n;
      if (n === 3) await vote(dir, 'x', 'S', 1); // +1 -> +2
    }
    expect(evictedAtX.T).toBe(7);
    expect(evictedAtX.S).toBe(9);
  });

  test('a merge that overflows a lowered cap also sends the docked line to the end (#437)', async () => {
    process.env.NB_MAX_LINES = '4';
    for (const t of ['quiet one', 'quiet two', 'first half', 'second half']) await addEntry(dir, 'mg', t);
    for (const t of ['first half', 'second half', 'quiet one', 'quiet two']) await vote(dir, 'mg', t, 1);
    // file: first half+2, second half+2, quiet one+2, quiet two+2
    process.env.NB_MAX_LINES = '2';
    const m = await merge(dir, 'mg', 'first half', 'second half', 'both halves together');
    expect(m.evicted?.text).toBe('quiet one');
    expect(m.decayed?.text).toBe('quiet two');
    expect(readEntries(dir, 'mg').map((e) => e.text)).toEqual(['both halves together', 'quiet two']); // docked line after the merged one
    expect(readEntries(dir, 'mg')[1].score).toBe(1);
  });

  // Issue #437: docs/eviction-and-aging.md quotes these numbers. On a shelf that
  // also holds unvoted lessons, a run of adds evicts those (lowest score first)
  // and takes points from the proven ones without evicting any of them.
  test('40 unrelated adds into 20 stale +4 lessons and 30 unvoted ones evict none of the 20 (#437)', async () => {
    process.env.NB_MAX_LINES = '50';
    const proven: string[] = [];
    for (let i = 0; i < 20; i++) {
      const t = `proven alpha${i} widget${i} about gamma${i}`;
      proven.push(t);
      await addEntry(dir, 'mix', t);
    }
    for (let k = 0; k < 3; k++) await voteMany(dir, 'mix', proven.map((t) => entryId(t)), 1); // each -> +4
    for (let i = 0; i < 30; i++) await addEntry(dir, 'mix', `unvoted beta${i} thing${i} delta${i}`);
    for (let i = 0; i < 40; i++) await addEntry(dir, 'mix', `junk zeta${i} blob${i} omega${i}`);
    const after = readEntries(dir, 'mix');
    const left = after.filter((e) => proven.includes(e.text));
    expect(left).toHaveLength(20); // none of the proven lessons was evicted
    expect(left.reduce((sum, e) => sum + e.score, 0)).toBe(50); // 80 points before; 30 docked
    expect(Math.max(...left.map((e) => e.score)) - Math.min(...left.map((e) => e.score))).toBeLessThanOrEqual(1); // spread evenly
    expect(after.filter((e) => e.text.startsWith('unvoted')).length).toBe(0); // the unvoted lessons paid
    expect(after.filter((e) => e.text.startsWith('junk')).length).toBe(30); // and so did ten of the forty adds
  }, 30_000);

  // Issue #437: docs/eviction-and-aging.md quotes these numbers (G3). One lesson
  // is voted to a score and then left alone on a full shelf of unvoted lessons
  // that keeps taking unrelated adds. Find the add that evicts it. About 210
  // durable writes, so it carries its own timeout.
  test('each extra point buys an untouched lesson another pass of the decay (#437)', async () => {
    process.env.NB_MAX_LINES = '10';
    const evictedByAdd = async (shelf: string, score: number): Promise<number> => {
      for (let i = 0; i < 9; i++) await addEntry(dir, shelf, `filler eta${i} item${i} theta${i}`);
      await addEntry(dir, shelf, 'the watched lesson');
      for (let k = 1; k < score; k++) await vote(dir, shelf, 'the watched lesson', 1);
      for (let n = 1; n <= 200; n++) {
        await addEntry(dir, shelf, `junk iota${n} lump${n} kappa${n}`);
        if (!readEntries(dir, shelf).some((e) => e.text === 'the watched lesson')) return n;
      }
      return -1;
    };
    expect(await evictedByAdd('s1', 1)).toBe(10);
    expect(await evictedByAdd('s2', 2)).toBe(19);
    expect(await evictedByAdd('s4', 4)).toBe(37);
    expect(await evictedByAdd('s10', 10)).toBe(91);
  }, 60_000);

  test('a downvoted line is evicted before useful ones', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'harmful');
    await addEntry(dir, 'r', 'good');
    await vote(dir, 'r', 'harmful', -1); // harmful -> 0
    await vote(dir, 'r', 'good', 1);     // good -> +2
    const r = await addEntry(dir, 'r', 'fresh'); // evict lowest = harmful(0)
    expect(r.evicted?.text).toBe('harmful');
    expect(readEntries(dir, 'r').map((e) => e.text).sort()).toEqual(['fresh', 'good']);
  });

  test('a full notebook ALWAYS admits a newcomer, aging and evicting its stalest line', async () => {
    // The old behavior rejected a newcomer when every entry outranked it; the
    // recency-aging policy never does that (no more `rejected-full`). Instead the
    // stalest high line is docked a point and evicted so the newcomer gets in.
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'alpha');
    await addEntry(dir, 'r', 'bravo');
    await vote(dir, 'r', 'alpha', 1); // alpha -> +2, touched (moves to fresh end)
    await vote(dir, 'r', 'bravo', 1); // bravo -> +2, touched LAST, so alpha is now the stalest
    const res = await addEntry(dir, 'r', 'charlie'); // always admitted
    expect(res.added).toBe(true);
    expect(res.reason).toBe('added');
    // Eviction runs first by score (ties → stalest): alpha and bravo are both +2,
    // alpha is the stalest (touched before bravo), so alpha is evicted.
    expect(res.evicted?.text).toBe('alpha');
    expect(readEntries(dir, 'r').map((e) => e.text).sort()).toEqual(['bravo', 'charlie']);
    // Then the stalest SURVIVOR is aged one point — here bravo, which would
    // otherwise be immortal (a newcomer at +1 can never outscore a static +2).
    // That dock is what lets even bravo eventually fall if it goes quiet.
    const byText = Object.fromEntries(readEntries(dir, 'r').map((e) => [e.text, e.score]));
    expect(byText).toEqual({ bravo: 1, charlie: 1 });
  });

  test('anti-immortality: a high-scored lesson never re-voted ages out over repeated adds', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'stale high lesson');
    for (let i = 0; i < 4; i++) await vote(dir, 'r', 'stale high', 1); // -> +5
    await addEntry(dir, 'r', 'filler lesson'); // notebook now full at +5 / +1
    // Under plain eviction a +5 lesson is immortal (newcomers enter at +1 and are
    // always the lowest). The staleness dock on the stalest survivor pulls it down
    // until it reaches the bottom and is evicted. With a cap of 2 it is the only
    // line that is not a newcomer, so here it is docked on every add.
    let evictedStale = false;
    for (let i = 0; i < 6 && !evictedStale; i++) {
      const r = await addEntry(dir, 'r', `newcomer number ${i}`);
      if (r.evicted?.text === 'stale high lesson') evictedStale = true;
    }
    expect(evictedStale).toBe(true);
    expect(readEntries(dir, 'r').some((e) => e.text === 'stale high lesson')).toBe(false);
  });

  test('aging targets the stalest survivor, sparing a recently-voted lesson (G5)', async () => {
    process.env.NB_MAX_LINES = '3';
    await addEntry(dir, 'g', 'aaa');
    await addEntry(dir, 'g', 'bbb');
    await addEntry(dir, 'g', 'ccc');
    await vote(dir, 'g', 'aaa', 1); // aaa -> +2, moved to the fresh end; bbb,ccc stay quiet
    await addEntry(dir, 'g', 'ddd'); // full → evict lowest, then age the stalest survivor
    const byText = Object.fromEntries(readEntries(dir, 'g').map((e) => [e.text, e.score]));
    // bbb (stalest, +1) is evicted; ccc (next stalest survivor) is aged +1 → 0;
    // aaa was just voted so it is fresher than ccc and is NOT the one aged.
    expect(byText.bbb).toBeUndefined();
    expect(byText.ccc).toBe(0);
    expect(byText.aaa).toBe(2);
    expect(byText.ddd).toBe(1);
    // Stored order (the worked example of docs/eviction-and-aging.md §7.1): the
    // aged line goes last, after the newcomer.
    expect(readEntries(dir, 'g').map((e) => e.text)).toEqual(['aaa', 'ddd', 'ccc']);
  });

  test('an add under the cap neither evicts nor decays (issue #293)', async () => {
    process.env.NB_MAX_LINES = '3';
    const r = await addEntry(dir, 'u', 'only');
    expect(r.decayed).toBeNull();
    expect(r.evicted).toBeNull();
  });

  test('add returns the stalest survivor as `decayed` with its POST-dock score; eviction target is unchanged', async () => {
    process.env.NB_MAX_LINES = '3';
    await addEntry(dir, 'g', 'aaa');
    await addEntry(dir, 'g', 'bbb');
    await addEntry(dir, 'g', 'ccc');
    await vote(dir, 'g', 'aaa', 1);
    const r = await addEntry(dir, 'g', 'ddd');
    expect(r.evicted?.text).toBe('bbb'); // unchanged eviction behaviour
    expect(r.decayed?.text).toBe('ccc');
    expect(r.decayed?.score).toBe(0); // +1 -> 0 (post-dock)
  });

  test('a dock on a voted-up line reports the post-dock score (pre-decay > 1)', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'v', 'stale high lesson');
    for (let i = 0; i < 2; i++) await vote(dir, 'v', 'stale high', 1); // -> +3
    await addEntry(dir, 'v', 'filler lesson');
    const r = await addEntry(dir, 'v', 'newcomer');
    expect(r.evicted?.text).toBe('filler lesson');
    expect(r.decayed?.text).toBe('stale high lesson');
    expect(r.decayed?.score).toBe(2); // 3 -> 2
  });

  test('move, merge and split also return decayed (split also returns evicted)', async () => {
    process.env.NB_MAX_LINES = '3';
    for (const t of ['aaa', 'bbb', 'ccc']) await addEntry(dir, 'dst', t);
    await addEntry(dir, 'src', 'mover');
    const m = await move(dir, 'src', 'dst', 'mover');
    expect(m.evicted?.text).toBe('aaa');
    expect(m.decayed?.text).toBe('bbb');

    for (const t of ['one', 'two', 'three']) await addEntry(dir, 'sp', t);
    const sp = await split(dir, 'sp', 'one', 'half alpha', 'half beta');
    expect(sp.evicted).not.toBeNull();
    expect(sp.decayed).not.toBeNull();

    process.env.NB_MAX_LINES = '5';
    for (const t of ['m1', 'm2', 'm3', 'm4', 'm5']) await addEntry(dir, 'mg', t);
    process.env.NB_MAX_LINES = '3';
    const mg = await merge(dir, 'mg', 'm1', 'm2', 'm1 and m2 merged');
    expect(mg.decayed).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Mass eviction on a lowered cap (issue #306)
  // ---------------------------------------------------------------------------
  //
  // Lowering NB_MAX_LINES below a full shelf's size makes the next mutation trim
  // the shelf all the way down in ONE call — many evictions at once. Before #306
  // the result and the usage `evicted` column surfaced only the FIRST, so a
  // data-loss event was under-reported to one entry and the
  // eviction-while-still-voted signal that reads that column missed the scale.
  describe('mass eviction on a lowered cap (issue #306)', () => {
    test('add on a shelf filled to 50 then capped at 10 evicts all 41 and reports every one', async () => {
      process.env.NB_MAX_LINES = '50';
      for (let i = 0; i < 50; i++) await addEntry(dir, 'patcher', `lesson ${i}`);
      expect(readEntries(dir, 'patcher')).toHaveLength(50); // full, nothing evicted yet

      process.env.NB_MAX_LINES = '10';
      const r = await addEntry(dir, 'patcher', 'the newcomer');

      expect(r.size).toBe(10); // trimmed to the new cap
      expect(r.evictedAll).toHaveLength(41); // 50 + 1 newcomer − 10
      expect(r.evicted).toBe(r.evictedAll[0]); // primary is still the first evicted
      // The protected newcomer is never among the evicted — only the pre-existing lessons left.
      expect(r.evictedAll.some((e) => e.text === 'the newcomer')).toBe(false);
      expect(r.evictedAll.every((e) => /^lesson \d+$/.test(e.text))).toBe(true);
    });

    test('a single over-cap add still reports exactly one eviction (common case unchanged)', async () => {
      process.env.NB_MAX_LINES = '3';
      for (const t of ['a', 'b', 'c']) await addEntry(dir, 's', t);
      const r = await addEntry(dir, 's', 'd'); // 3 → 4, cap 3 ⇒ one eviction
      expect(r.evictedAll).toHaveLength(1);
      expect(r.evicted).toBe(r.evictedAll[0]);
    });

    test('move into a target filled to 10 then capped at 3 evicts all the overflow', async () => {
      process.env.NB_MAX_LINES = '10';
      for (let i = 0; i < 10; i++) await addEntry(dir, 'dst', `d${i}`);
      await addEntry(dir, 'src', 'relocated');
      process.env.NB_MAX_LINES = '3';
      const r = await move(dir, 'src', 'dst', 'relocated');
      expect(r.toSize).toBe(3);
      expect(r.evictedAll).toHaveLength(8); // 10 + 1 moved − 3
      expect(r.evicted).toBe(r.evictedAll[0]);
      expect(r.evictedAll.some((e) => e.text === 'relocated')).toBe(false); // the moved lesson is protected
    });

    test('formatEvictedUsage: empty → "", single pair is byte-identical to the pre-#306 format', () => {
      expect(formatEvictedUsage([])).toBe('');
      expect(formatEvictedUsage([{ score: 3, text: 'solo' }])).toBe(`${entryId('solo')}:3`);
    });

    test('formatEvictedUsage: a short list records every pair in order', () => {
      const evicted = [
        { score: 2, text: 'one' },
        { score: 5, text: 'two' },
        { score: 1, text: 'three' },
      ];
      expect(formatEvictedUsage(evicted)).toBe(
        `${entryId('one')}:2,${entryId('two')}:5,${entryId('three')}:1`,
      );
    });

    test('formatEvictedUsage: a huge list is byte-bounded by maxChars with a count-preserving +N marker', () => {
      const evicted = Array.from({ length: 41 }, (_, i) => ({ score: 1, text: `evicted lesson number ${i}` }));
      const field = formatEvictedUsage(evicted);
      expect(field.length).toBeLessThanOrEqual(maxChars()); // never blows the usage ring's per-row budget

      const tokens = field.split(',');
      const markers = tokens.filter((t) => t.startsWith('+'));
      expect(markers).toHaveLength(1); // exactly one trailing overflow marker
      const pairs = tokens.filter((t) => !t.startsWith('+'));
      // Every listed token is a well-formed `<id>:<score>` pair (no mangled half-id).
      for (const p of pairs) expect(p).toMatch(/^[0-9a-f]{6}:-?\d+$/);
      // The TOTAL evicted count is recoverable: listed pairs + the dropped count.
      const dropped = Number(markers[0].slice(1));
      expect(pairs.length + dropped).toBe(41);
      expect(pairs.length).toBeGreaterThan(1); // many are listed, not just one
    });

    test('eviction-while-still-voted counts EVERY still-voted entry in one mass eviction, not just the first', () => {
      // One add row whose evicted column lists three evictions: two still above
      // the +1 start (3 and 2) and one at the floor (1). Both still-voted ones
      // must surface a signal; the floor one must not.
      const evicted = [
        { score: 3, text: 'still useful A' },
        { score: 2, text: 'still useful B' },
        { score: 1, text: 'never voted C' },
      ];
      logUsage(dir, 'patcher', 'add', true, 2, {
        session: 's1',
        entries: ['new999'],
        outcome: 'accepted',
        evicted: formatEvictedUsage(evicted),
      });
      const rep = stats(dir, { now: Date.now() });
      const sigs = rep.signals.filter((s) => s.kind === 'eviction-while-still-voted');
      expect(sigs.map((s) => s.entry).sort()).toEqual(
        [entryId('still useful A'), entryId('still useful B')].sort(),
      );
    });

    test('eviction-while-still-voted ignores the +N overflow marker (no phantom signal)', () => {
      logUsage(dir, 'patcher', 'add', true, 2, {
        session: 's1',
        entries: ['new999'],
        outcome: 'accepted',
        evicted: `${entryId('still voted')}:4,+40`, // one real pair + a 40-dropped marker
      });
      const rep = stats(dir, { now: Date.now() });
      const sigs = rep.signals.filter((s) => s.kind === 'eviction-while-still-voted');
      expect(sigs).toHaveLength(1);
      expect(sigs[0].entry).toBe(entryId('still voted'));
      expect(sigs.some((s) => (s.entry ?? '').startsWith('+'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Randomized invariant sweep (issue #189)
  // ---------------------------------------------------------------------------
  //
  // The cap tests above are fixed scenarios. This one drives MANY seeded,
  // deterministic add/vote sequences through the real addEntry/vote path and
  // asserts, after every op, the invariants enforceCap must never break
  // (docs/eviction-and-aging.md). It is a property test with a hand-rolled PRNG
  // (no fast-check — the same zero-dependency stance as the round-trip suite
  // below), so a future refactor of the eviction/decay ordering that slips past
  // the three hand-written cases fails loudly and reproducibly.
  //
  // Every assertion is an INDEPENDENT oracle computed from the before/after
  // state (storage order = recency, least-recently-touched first) and the
  // public addEntry/vote result — never a re-derivation of enforceCap's own
  // code — so the test cannot tautologically agree with a buggy implementation:
  //   1. the stored entry count never exceeds maxLines();
  //   2. the entry an add just created is always still present afterward, enters
  //      at +1, and is never the one it reports evicted (newcomers are protected);
  //   3. every stored score is an integer (no fractional decay);
  //   4. when an add evicts from a full notebook: the evicted line is the
  //      lowest-scored one, ties broken by staleness (topmost in storage order);
  //      EXACTLY ONE surviving non-protected line — the stalest survivor — is
  //      docked EXACTLY ONE point; every other survivor is unchanged; the docked
  //      line is moved to the very end, after the newcomer, and the other
  //      survivors keep their relative order (issue #437);
  //   5. a vote applies ±delta to its target and moves it to the fresh end — the
  //      recency signal the staleness targeting in (4) is built on.
  // [slow]: ~19s of durable fsync writes (300 sequences × 6 ops). Tagged so the
  // `test:fast` inner loop skips it (issue #232); `npm test` and CI still run it.
  test('randomized add/vote sequences never break the cap/eviction/decay invariants [slow]', async () => {
    // A tiny self-contained PRNG (mulberry32): deterministic given its seed, so
    // every sequence — and any failure — reproduces exactly. Zero dependency,
    // matching the round-trip generator below.
    const mulberry32 = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };

    const SEQUENCES = 300; // "a few hundred" op sequences (acceptance criterion)
    const OPS = 6; // ops/sequence; each op is a durable fsync write, so keep it lean
    const BASE_SEED = 0x5eed;
    let evictionsSeen = 0; // guard against a vacuous run (did eviction ever fire?)

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const rng = mulberry32(BASE_SEED + seq);
      // cap >= 2 so an eviction always leaves at least one surviving
      // non-protected line to dock (invariant 4); kept small (2..4) so a notebook
      // fills fast and the eviction+decay path is exercised densely.
      const cap = 2 + Math.floor(rng() * 3); // 2..4
      process.env.NB_MAX_LINES = String(cap);
      const shelf = `fuzz${seq}`;
      let counter = 0; // monotonic → every lesson text is unique (no dedup blocks)

      for (let op = 0; op < OPS; op++) {
        const before = readEntries(dir, shelf); // storage order: index 0 = stalest
        const beforeScore = new Map(before.map((e) => [e.text, e.score]));
        const doVote = before.length > 0 && rng() < 0.4;
        let after: ReturnType<typeof readEntries>;

        if (doVote) {
          // A vote never grows the notebook, so it can neither evict nor decay.
          const victim = before[Math.floor(rng() * before.length)];
          const delta = rng() < 0.5 ? 1 : -1;
          await vote(dir, shelf, entryId(victim.text), delta);
          after = readEntries(dir, shelf);
          // (5) the vote applied ±delta and the touched line moved to the fresh end.
          const moved = after[after.length - 1];
          expect(moved.text).toBe(victim.text);
          expect(moved.score).toBe(victim.score + delta);
        } else {
          const text = `lesson ${seq}-${counter++}`;
          const res = await addEntry(dir, shelf, text);
          expect(res.added).toBe(true); // unique + short → always accepted
          after = readEntries(dir, shelf);
          const afterScore = new Map(after.map((e) => [e.text, e.score]));

          // (2) the just-added entry survives, enters at +1, and is never evicted.
          expect(afterScore.get(text)).toBe(1);
          if (res.evicted) expect(res.evicted.text).not.toBe(text);

          // (4) an eviction happens only when the add overflowed a full notebook.
          if (res.evicted) {
            evictionsSeen++;
            expect(before.length).toBe(cap); // the notebook was full

            // Eviction oracle: the removed line is the lowest-scored, ties broken
            // by staleness — i.e. the FIRST entry in storage order whose score is
            // the minimum. Derived from `before` alone, not from enforceCap.
            const minScore = Math.min(...before.map((e) => e.score));
            const expectedEvicted = before.find((e) => e.score === minScore);
            expect(res.evicted.score).toBe(minScore);
            expect(res.evicted.text).toBe(expectedEvicted?.text);
            expect(afterScore.has(res.evicted.text)).toBe(false); // and it is gone

            // Dock oracle: the stalest surviving non-protected line — the first in
            // storage order that was NOT evicted — loses exactly 1 point; every
            // other survivor is unchanged, and no one else is docked.
            const expectedDock = before.find((e) => e.text !== res.evicted!.text);
            let docked = 0;
            for (const [t, s0] of beforeScore) {
              if (t === res.evicted.text) continue; // the evicted line
              const s1 = afterScore.get(t);
              expect(s1).not.toBeUndefined(); // every survivor is kept
              if (t === expectedDock?.text) {
                expect(s1).toBe(s0 - 1); // the one decayed line, docked by exactly 1
                docked++;
              } else {
                expect(s1).toBe(s0); // all other survivors unchanged
              }
            }
            expect(docked).toBe(1); // exactly one survivor docked

            // Order oracle (issue #437): the file is the other survivors in their
            // old order, then the newcomer, then the docked line.
            const expectedOrder = before
              .filter((e) => e.text !== res.evicted!.text && e.text !== expectedDock?.text)
              .map((e) => e.text)
              .concat(text, expectedDock ? [expectedDock.text] : []);
            expect(after.map((e) => e.text)).toEqual(expectedOrder);
            expect(res.decayed?.text).toBe(expectedDock?.text);
          }
        }

        // (1) + (3): hold after EVERY op, add or vote.
        expect(after.length).toBeLessThanOrEqual(cap);
        for (const e of after) expect(Number.isInteger(e.score)).toBe(true);
      }
    }

    // The sweep is only meaningful if it actually drove the eviction+decay path
    // many times; a run that never filled a notebook would satisfy invariant 4
    // vacuously. This floor fails such a degenerate run loudly.
    expect(evictionsSeen).toBeGreaterThan(100);
  }, 120_000);

  // Issue #437, goal G6 of docs/eviction-and-aging.md, as an invariant: a lesson
  // is not docked a second time until every other lesson that was on the shelf
  // at its previous dock has since been docked, voted on, or removed. So a run
  // of adds cannot single one lesson out. The oracle keeps, for each docked
  // lesson, the set of lessons that were present at that dock and have not been
  // docked, voted or evicted since; the set must be empty when it is docked again.
  // A vote on the docked lesson itself does not reset its set: the vote only
  // moves it further back, so the lessons it was behind are still ahead of it.
  // Longer sequences than the sweep above, and mostly upvotes, so lessons live
  // long enough to be docked several times.
  // [slow]: ~600 durable writes.
  test('randomized: a lesson is docked again only after the decay has passed over the rest of the shelf [slow]', async () => {
    const mulberry32 = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    let repeatDocks = 0; // guard against a vacuous run
    for (let seq = 0; seq < 12; seq++) {
      const rng = mulberry32(0xd0c4 + seq);
      const cap = 3 + Math.floor(rng() * 4); // 3..6
      process.env.NB_MAX_LINES = String(cap);
      const shelf = `pass${seq}`;
      let counter = 0;
      // text of a docked lesson -> the lessons still "ahead of it" since that dock
      const ahead = new Map<string, Set<string>>();
      // `text` no longer stands ahead of anyone (it was docked, voted or evicted).
      const passed = (text: string) => {
        for (const set of ahead.values()) set.delete(text);
      };
      for (let op = 0; op < 50; op++) {
        const before = readEntries(dir, shelf);
        if (before.length > 0 && rng() < 0.45) {
          const target = before[Math.floor(rng() * before.length)];
          await vote(dir, shelf, entryId(target.text), rng() < 0.85 ? 1 : -1);
          passed(target.text); // a voted lesson moves to the end: it is ahead of nobody
          continue;
        }
        const res = await addEntry(dir, shelf, `lesson ${seq}-${counter++}`);
        for (const e of res.evictedAll) {
          passed(e.text);
          ahead.delete(e.text);
        }
        if (!res.decayed) continue;
        const docked = res.decayed.text;
        const pending = ahead.get(docked);
        if (pending) {
          repeatDocks++;
          expect([...pending]).toEqual([]); // nobody it was behind is still waiting
        }
        passed(docked);
        ahead.set(docked, new Set(readEntries(dir, shelf).map((e) => e.text).filter((t) => t !== docked)));
      }
    }
    expect(repeatDocks).toBeGreaterThan(20);
  }, 120_000);
});

describe('serialization round-trip', () => {
  // The plain-text file (`<score>\t<lesson>` lines) is the tool's durable
  // contract: its backup/diff story and how an upgraded binary must still read
  // an old on-disk notebook. These tests pin that codec with a hand-rolled
  // generator (no fast-check, to honor the zero-dependency stance) so a future
  // tweak to the field separator, the +N score formatting, the no-tab
  // tolerance, or whitespace collapsing becomes a loud failure instead of a
  // silent corruption of a user's memory file.
  //
  // The round-trip runs through the REAL codec end-to-end via the public API:
  // addEntry/vote persist with formatLine, readEntries parses with parseLine.
  const RAW_LESSONS = [
    'plain lesson',
    'tab\there and\tthere',                 // tabs = the field separator
    'line one\nline two\r\nline three',     // newlines = the record separator
    '+5 looks like a score but is lesson text', // leading score-like token
    '-3 leading negative-looking token',
    'café — naïve — 日本語 — 🧠 unicode survives',
    '   leading and trailing   whitespace   ',
    'multiple     interior     spaces',
    'x'.repeat(maxChars()),                 // exactly at the length cap
    'y'.repeat(maxChars() - 1),             // just under the cap
  ];
  // Integer scores spanning negative, zero, the +1 default, and the +N path.
  const SCORES = [-3, 0, 1, 4];

  // [slow]: a randomized round-trip fuzz over the on-disk codec; tagged so the
  // `test:fast` inner loop skips it (issue #232), the full `npm test` keeps it.
  test('format→parse recovers every (score, lesson) pair through the on-disk codec [slow]', async () => {
    let n = 0;
    let exercised = 0;
    for (const raw of RAW_LESSONS) {
      const text = sanitizeLesson(raw);
      expect(text).not.toMatch(/[\t\r\n]/); // sanitize never leaves our separators behind
      if (text === '' || text.length > maxChars()) continue; // addEntry would reject these
      for (const target of SCORES) {
        const shelf = `rt-${n++}`;
        const add = await addEntry(dir, shelf, text);
        expect(add.added).toBe(true); // stored at the +1 default
        // Drive the score to `target`; each vote re-formats and re-parses the
        // whole file, so reaching a non-default score already round-trips it.
        const id = entryId(text);
        const steps = target - 1;
        for (let i = 0; i < Math.abs(steps); i++) await vote(dir, shelf, id, steps >= 0 ? 1 : -1);
        // format -> parse recovers the exact entry.
        expect(readEntries(dir, shelf)).toEqual([{ score: target, text }]);
        exercised++;
      }
    }
    // Make the `continue` guard loud: if a case were ever silently skipped the
    // loop would weaken without failing, so assert the full matrix ran.
    expect(exercised).toBe(RAW_LESSONS.length * SCORES.length);
  });

  test('re-formatting a parsed notebook is a byte-for-byte fixed point', async () => {
    // A true fixed point is parse→format→parse→format, not just two reads. Drive
    // two whole-file rewrites that do NOT touch the entries — set then clear a
    // description (a vote is no longer order-neutral: it moves its line to the
    // fresh end) — then assert the bytes and entries never drifted.
    await addEntry(dir, 'fp', 'alpha lesson');
    await addEntry(dir, 'fp', 'beta lesson');
    const before = readFileSync(join(dir, 'fp.md'), 'utf-8');
    await setDescription(dir, 'fp', 'temporary'); // rewrites the file (adds a meta line)
    await setDescription(dir, 'fp', ''); // clears it — entries-only, as before
    expect(readFileSync(join(dir, 'fp.md'), 'utf-8')).toBe(before); // format(parse(x)) === x
    expect(readEntries(dir, 'fp')).toEqual([
      { score: 1, text: 'alpha lesson' },
      { score: 1, text: 'beta lesson' },
    ]);
  });

  test('parseLine reads a hand-written score line: first-tab split, whitespace collapse, bad-score fallback', () => {
    // These lines are written in the ON-DISK format directly (not via addEntry),
    // so the PARSE side of the codec sees raw tabs and odd score columns that a
    // pre-sanitized in-memory lesson can never produce.
    const lines = [
      '+2\ta\tb',                // a second tab lives INSIDE the lesson: split on the FIRST tab only
      '+1\t  collapse   me  ',   // the parse side must collapse interior/edge whitespace
      'abc\tnon-numeric score',  // an unparseable score column falls back to 0
      '\tempty score column',    // an empty score column falls back to 0
      '1.5\tfractional score',   // parseInt stops at '.', so +1
      '-12\ttwo digit negative', // multi-digit signed scores survive
      '+10\ttwo digit positive',
    ];
    writeFileSync(join(dir, 'raw.md'), lines.join('\n') + '\n', 'utf-8');
    expect(readEntries(dir, 'raw')).toEqual([
      { score: 2, text: 'a b' },
      { score: 1, text: 'collapse me' },
      { score: 0, text: 'non-numeric score' },
      { score: 0, text: 'empty score column' },
      { score: 1, text: 'fractional score' },
      { score: -12, text: 'two digit negative' },
      { score: 10, text: 'two digit positive' },
    ]);
  });

  test('persists each entry as "<signed-score>\\t<lesson>" at the byte level', async () => {
    await addEntry(dir, 'fmt', 'first lesson');
    await addEntry(dir, 'fmt', 'second lesson');
    await vote(dir, 'fmt', entryId('second lesson'), -1); // +1 -> 0
    await vote(dir, 'fmt', entryId('second lesson'), -1); //  0 -> -1
    const raw = readFileSync(join(dir, 'fmt.md'), 'utf-8');
    expect(raw).toBe('+1\tfirst lesson\n-1\tsecond lesson\n'); // pins the tab + signed score
    expect(readEntries(dir, 'fmt')).toEqual([
      { score: 1, text: 'first lesson' },
      { score: -1, text: 'second lesson' },
    ]);
  });

  test('a tab-less line reads back as score 0 (hand-edited notebook tolerance)', () => {
    // A human may jot a bare lesson with no score column; parseLine must treat
    // it as score 0, sanitized — an invariant worth pinning.
    const lines = [
      'a bare hand-written lesson',
      '   padded   bare   lesson   ',
      'café unicode bare lesson 🧠',
    ];
    writeFileSync(join(dir, 'bare.md'), lines.join('\n') + '\n', 'utf-8');
    expect(readEntries(dir, 'bare')).toEqual([
      { score: 0, text: 'a bare hand-written lesson' },
      { score: 0, text: 'padded bare lesson' },
      { score: 0, text: 'café unicode bare lesson 🧠' },
    ]);
  });

  test('sanitizeLesson strips ESC/NUL/C1/bidi/zero-width but keeps emoji ZWJ and non-ASCII (issue #335)', () => {
    // ESC, BEL, NUL, DEL, a C1 control, ZWSP, RTL override, word joiner, BOM, isolate.
    const evil = 'a\u001b[31mred\u001b[0m\u0007b\u0000c\u007fd\u0085e\u200bf\u202eg\u2060h\uFEFFi\u2066j';
    const clean = sanitizeLesson(evil);
    expect(clean).toBe('a[31mred[0mbcdefghij');
    // No raw control / bidi / zero-width bytes survive.
    expect(clean).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u00AD\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u);
    // Emoji ZWJ sequence (ZWJ U+200D) and a variation selector are preserved.
    const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}';
    expect(sanitizeLesson(`keep ${family} 👍🏽 café 漢字`)).toBe(`keep ${family} 👍🏽 café 漢字`);
  });

  test('Unicode Tag characters and the soft hyphen are stripped; ZWJ, CJK and RTL text survive (issue #374)', async () => {
    const tags = '\u{E0049}\u{E0067}\u{E007F}';
    expect(sanitizeLesson(`visible ${tags}end`)).toBe('visible end');
    expect(sanitizeLesson('co\u00ADoperate')).toBe('cooperate');
    expect(stripControlChars(`a${tags}b`)).toBe('ab');
    const keep = '\u{1F469}\u200D\u{1F467} 漢字 \u05E9\u05DC\u05D5\u05DD \u200F';
    expect(sanitizeLesson(keep)).toBe(keep);
    expect((await addEntry(dir, 't', `x${tags}y`)).added).toBe(true);
    expect(readEntries(dir, 't')[0].text).toBe('xy');
    writeFileSync(join(dir, 'tagold.md'), `+1\tlegacy${tags} line\n`, 'utf-8');
    expect(render(dir, 'tagold')).toContain('legacy line');
    expect(render(dir, 'tagold')).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
  });

  test('VT and FF stay whitespace: they become a space, not a deletion (issue #335)', () => {
    expect(sanitizeLesson('page1\fpage2')).toBe('page1 page2');
    expect(sanitizeLesson('a\vb\u000b\u000cc')).toBe('a b c');
  });

  test('a lesson with control bytes is stored clean and the exact-dup check sees through ZWSP (issue #335)', async () => {
    expect((await addEntry(dir, 's', 'x\u001b[31my\u0000z\u202e!')).added).toBe(true);
    expect(readEntries(dir, 's')[0].text).toBe('x[31myz!');
    expect((await addEntry(dir, 'z', 'ab')).added).toBe(true);
    const zwsp = await addEntry(dir, 'z', 'a\u200bb');
    expect(zwsp.added).toBe(false);
    expect(zwsp.reason).toBe('duplicate');
    expect(readEntries(dir, 'z')).toHaveLength(1);
  });

  test('show/list/search output contains no raw control bytes (issue #335)', async () => {
    await addEntry(dir, 's', 'ansi \u001b[31mred\u001b[0m \u001b]0;title\u0007 injected');
    await setDescription(dir, 's', 'desc \u001b[31mred\u0000');
    // A pre-existing file that already holds an ESC byte (stored before the rule).
    writeFileSync(join(dir, 'old.md'), '+1\tlegacy \u001b[31mred\u001b[0m line\n', 'utf-8');
    const bad = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
    expect(render(dir, 's')).not.toMatch(bad);
    expect(renderEntries('s', readEntries(dir, 's'))).not.toMatch(bad);
    expect(render(dir, 'old')).not.toMatch(bad);
    expect(render(dir, 'old')).toContain('legacy [31mred[0m line');
    const listing = listNotebooks(dir);
    expect(JSON.stringify(listing)).not.toMatch(bad);
    expect(listing.rows.find((r) => r.shelf === 's')!.desc).toBe('desc [31mred');
    const found = search(dir, 'red');
    expect(JSON.stringify(found)).not.toMatch(bad);
    expect(showJson(dir, 's').description).toBe('desc [31mred');
  });

  test('sanitizeLesson is idempotent — a second pass is a fixed point', () => {
    for (const raw of RAW_LESSONS) {
      const once = sanitizeLesson(raw);
      expect(sanitizeLesson(once)).toBe(once);
      expect(once).not.toMatch(/[\t\r\n]/);
    }
  });
});

describe('vote', () => {
  test('votes by stable id and by substring query', async () => {
    await addEntry(dir, 'v', 'alpha lesson');
    await addEntry(dir, 'v', 'beta lesson');
    const byQuery = await vote(dir, 'v', 'alpha', 1); // unique substring
    expect(byQuery.score).toBe(2);
    const r = await vote(dir, 'v', entryId('alpha lesson'), 1); // by stable id
    expect(r.text).toBe('alpha lesson');
    expect(r.score).toBe(3);
  });

  test('a stable id keeps pointing at the same entry after reordering (regression)', async () => {
    await addEntry(dir, 'v', 'alpha'); // file index 0
    await addEntry(dir, 'v', 'beta'); // file index 1
    const idBeta = entryId('beta');
    await vote(dir, 'v', idBeta, 1); // beta -> +2 (now ranks first)
    await vote(dir, 'v', idBeta, 1); // same id still hits beta despite the reorder -> +3
    expect(readEntries(dir, 'v').find((e) => e.text === 'beta')!.score).toBe(3);
    expect(readEntries(dir, 'v').find((e) => e.text === 'alpha')!.score).toBe(1); // untouched
  });

  test('an id prefix shorter than the full id still resolves when unique', async () => {
    await addEntry(dir, 'v', 'solo lesson');
    const full = entryId('solo lesson');
    const r = await vote(dir, 'v', full.slice(0, 2), 1); // 2-char unique prefix
    expect(r.text).toBe('solo lesson');
    expect(r.score).toBe(2);
  });

  test('a short hex selector that is an id prefix of one lesson and text in another is refused (#412)', async () => {
    await addEntry(dir, 'v', 'Prefer rebase over merge for feature branch 51'); // id 184862
    await addEntry(dir, 'v', 'Node 18 lacks a global fetch without --experimental-fetch');
    await addEntry(dir, 'v', 'Run the linter before every commit');
    expect(entryId('Prefer rebase over merge for feature branch 51')).toBe('184862');
    const file = join(dir, 'v.md');
    const before = readFileSync(file, 'utf8');
    const err = await remove(dir, 'v', '18').catch((e) => e);
    expect(err.errorClass).toBe('ambiguous_selector');
    expect(err.message).toContain('Node 18');
    expect(err.message).toContain('Prefer rebase');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('a full 6-hex id resolves even when another lesson text contains it (#412)', async () => {
    await addEntry(dir, 'v', 'Prefer rebase over merge for feature branch 51'); // id 184862
    await addEntry(dir, 'v', 'ticket 184862 tracks the flaky fetch');
    const r = await vote(dir, 'v', '184862', 1);
    expect(r.text).toBe('Prefer rebase over merge for feature branch 51');
  });

  test('batch vote records the new refusal as a per-selector miss (#412)', async () => {
    await addEntry(dir, 'v', 'Prefer rebase over merge for feature branch 51');
    await addEntry(dir, 'v', 'Node 18 lacks a global fetch');
    const r = await voteMany(dir, 'v', ['18', 'Node 18'], 1);
    expect(r[0].error).toMatch(/id prefix/);
  });

  test('a hex-looking word falls through to a text match when it is not an id', async () => {
    await addEntry(dir, 'v', 'dead letter queue retries thrice'); // "dead" is hex but a real word here
    await addEntry(dir, 'v', 'unrelated note');
    const r = await vote(dir, 'v', 'dead', 1); // not an id prefix (6-hex) -> resolves as substring
    expect(r.text).toBe('dead letter queue retries thrice');
    expect(r.score).toBe(2);
  });

  test('an ambiguous selector refuses and mutates nothing (never a wrong-lesson vote)', async () => {
    await addEntry(dir, 'v', 'widget cache warm path');
    await addEntry(dir, 'v', 'widget cache cold path');
    await expect(vote(dir, 'v', 'widget', 1)).rejects.toThrow(/matches 2/);
    // the error must also LIST the candidate ids so the agent can disambiguate by id
    await expect(vote(dir, 'v', 'widget', 1)).rejects.toThrow(new RegExp(entryId('widget cache warm path')));
    expect(readEntries(dir, 'v').every((e) => e.score === 1)).toBe(true); // both untouched
  });

  test('a failed vote lists candidate ids so the agent can retry by id', async () => {
    await addEntry(dir, 'v', 'use npm ci --ignore-scripts after lockfile regen');
    await addEntry(dir, 'v', 'diff lockfile vs origin/main for dropped deps');
    // agent guesses a topic word absent from the stored text -> no match, but the
    // error must surface the real entries' ids so it can re-vote correctly.
    await expect(vote(dir, 'v', 'lint', 1)).rejects.toThrow(
      new RegExp(entryId('use npm ci --ignore-scripts after lockfile regen')),
    );
  });

  test('downvote lowers score', async () => {
    await addEntry(dir, 'v', 'x');
    const r = await vote(dir, 'v', 'x', -1);
    expect(r.score).toBe(0);
  });

  test('rejects a delta other than +1/-1', async () => {
    await addEntry(dir, 'v', 'x');
    await expect(vote(dir, 'v', 'x', 2)).rejects.toThrow(/\+1 or -1/);
  });

  test('ambiguous query throws, no match throws', async () => {
    await addEntry(dir, 'v', 'shared token one');
    await addEntry(dir, 'v', 'shared token two');
    await expect(vote(dir, 'v', 'shared', 1)).rejects.toThrow(/matches 2/);
    await expect(vote(dir, 'v', 'zzz', 1)).rejects.toThrow(/no entry matches/);
  });
});

describe('merge', () => {
  test('consolidates two entries into one, inheriting the higher score', async () => {
    await addEntry(dir, 'm', 'tests live in __tests__');
    await addEntry(dir, 'm', 'run vitest for a single file');
    await vote(dir, 'm', 'vitest', 1); // that one -> +2
    const r = await merge(dir, 'm', entryId('tests live in __tests__'), 'vitest', 'tests: __tests__, pnpm vitest run <file>');
    expect(r.added).toBe(true);
    const entries = readEntries(dir, 'm');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('tests: __tests__, pnpm vitest run <file>');
    expect(entries[0].score).toBe(2); // max(+1, +2)
  });

  test('drops a THIRD entry whose text the merged lesson duplicates (never creates a dup)', async () => {
    // merge A+B into text that is a near-duplicate (dedupKey-equal) of a third
    // entry C. The dedup-drop branch must remove C so the notebook never holds
    // two entries with the same dedupKey — the invariant addEntry enforces.
    await addEntry(dir, 'm', 'alpha one');          // A
    await addEntry(dir, 'm', 'beta two');           // B
    await addEntry(dir, 'm', 'shared merged text'); // C (the third entry)
    await vote(dir, 'm', entryId('alpha one'), 1);  // A -> +2
    await vote(dir, 'm', entryId('beta two'), 1);
    await vote(dir, 'm', entryId('beta two'), 1);   // B -> +3
    await vote(dir, 'm', entryId('shared merged text'), 1); // C -> +2 (higher than it will inherit)

    // Merged text dedupKey-equals C ("Shared merged text!!" normalizes to C's key).
    const r = await merge(dir, 'm', entryId('alpha one'), entryId('beta two'), 'Shared merged text!!');
    expect(r.added).toBe(true);

    const entries = readEntries(dir, 'm');
    // Exactly ONE entry survives: A and B consumed, C dropped as the duplicate.
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Shared merged text!!');
    // No two entries share a dedupKey (the invariant this branch protects).
    expect(new Set(entries.map((e) => dedupKey(e.text))).size).toBe(entries.length);
    // Documented behavior (NOT asserted as desirable): the merged entry inherits
    // only max(A,B) = +3; the dropped C's +2 is discarded. Pinned so a change to
    // merge's score inheritance becomes a visible, deliberate decision.
    expect(entries[0].score).toBe(3);
  });

  test('refuses to merge an entry with itself', async () => {
    await addEntry(dir, 'm', 'only one');
    const id = entryId('only one');
    await expect(merge(dir, 'm', id, id, 'x')).rejects.toThrow(/two different/);
  });

  test('rejects an over-length merged lesson and leaves both source entries intact', async () => {
    process.env.NB_MAX_CHARS = '30';
    await addEntry(dir, 'm', 'alpha');
    await addEntry(dir, 'm', 'beta');
    await expect(merge(dir, 'm', entryId('alpha'), entryId('beta'), 'z'.repeat(50))).rejects.toThrow(/max is 30/);
    expect(readEntries(dir, 'm').map((e) => e.text).sort()).toEqual(['alpha', 'beta']); // nothing mutated
  });
});

describe('split', () => {
  test('replaces one entry with two, each inheriting the original score (reverse of merge)', async () => {
    await addEntry(dir, 's', 'run build, then run vitest');
    await vote(dir, 's', 'build', 1); // original -> +2
    const r = await split(dir, 's', 'build', 'run the build first', 'run vitest after the build');
    expect(r.size).toBe(2);
    expect(r.source).toBe(entryId('run build, then run vitest'));
    expect(r.ids).toEqual([entryId('run the build first'), entryId('run vitest after the build')]);

    const entries = readEntries(dir, 's');
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.text).sort()).toEqual(['run the build first', 'run vitest after the build']);
    // Both halves inherit the overloaded entry's +2 — no score is invented or lost.
    expect(entries.every((e) => e.score === 2)).toBe(true);
    // The original is gone.
    expect(entries.some((e) => e.text === 'run build, then run vitest')).toBe(false);
  });

  test('rejects an over-length half and leaves the original intact (reject, never truncate)', async () => {
    process.env.NB_MAX_CHARS = '30';
    await addEntry(dir, 's', 'overloaded line');
    await expect(split(dir, 's', 'overloaded', 'short half', 'z'.repeat(50))).rejects.toThrow(/lesson B is 50 chars; max is 30/);
    expect(readEntries(dir, 's').map((e) => e.text)).toEqual(['overloaded line']); // nothing mutated
  });

  test('refuses an empty half, leaving the original intact', async () => {
    await addEntry(dir, 's', 'overloaded line');
    await expect(split(dir, 's', 'overloaded', 'keeps something', '   ')).rejects.toThrow(/lesson B is empty/);
    expect(readEntries(dir, 's').map((e) => e.text)).toEqual(['overloaded line']);
  });

  test('refuses two halves that are duplicates of each other', async () => {
    await addEntry(dir, 's', 'overloaded line');
    // Same dedup key (case/punctuation-insensitive) — a split into two identical lessons.
    await expect(split(dir, 's', 'overloaded', 'same lesson', 'Same lesson!!')).rejects.toThrow(/duplicates of each other/);
    expect(readEntries(dir, 's')).toHaveLength(1);
  });

  test('refuses a half that duplicates an existing OTHER entry (never creates a dup)', async () => {
    await addEntry(dir, 's', 'overloaded line');
    await addEntry(dir, 's', 'already present');
    await expect(split(dir, 's', 'overloaded', 'brand new half', 'Already present!!')).rejects.toThrow(/duplicates an existing entry/);
    // Atomic: nothing changed — the original and the existing entry both survive.
    expect(readEntries(dir, 's').map((e) => e.text).sort()).toEqual(['already present', 'overloaded line']);
  });

  test('a half may legitimately echo the entry being split (the original is leaving)', async () => {
    // Splitting "A; B" into "A" + "B" where "A" dedupKey-equals the original is
    // fine, because the original is removed — the result holds no duplicate.
    await addEntry(dir, 's', 'overloaded line');
    const r = await split(dir, 's', 'overloaded', 'overloaded line', 'the freshly separated half');
    expect(r.size).toBe(2);
    expect(readEntries(dir, 's').map((e) => e.text).sort()).toEqual(['overloaded line', 'the freshly separated half']);
  });

  test('an empty notebook throws', async () => {
    await expect(split(dir, 's', 'anything', 'a', 'b')).rejects.toThrow(/empty/);
  });

  test('obeys the cap: splitting at maxLines trims back down (one net addition evicts one)', async () => {
    process.env.NB_MAX_LINES = '3';
    await addEntry(dir, 's', 'keep one');
    await addEntry(dir, 's', 'keep two');
    await addEntry(dir, 's', 'overloaded three'); // notebook now full (3/3)
    await vote(dir, 's', 'keep one', 1); // +2 so it outranks the split halves
    await vote(dir, 's', 'keep two', 1); // +2 so it outranks the split halves
    // Split the +1 entry into two +1 halves → 4 entries → trim back to 3.
    const r = await split(dir, 's', 'overloaded three', 'half a', 'half b');
    expect(r.size).toBe(3);
    expect(readEntries(dir, 's')).toHaveLength(3); // cap honored
  });
});

describe('operation reasons (seed-and-grow enum)', () => {
  test('a recognized split code passes through unchanged', () => {
    expect(normalizeReason('split', 'overloaded', undefined)).toEqual({ reason: 'overloaded', note: '' });
  });

  test('an empty/absent code yields an empty reason (reasons are optional)', () => {
    expect(normalizeReason('split', undefined, undefined)).toEqual({ reason: '', note: '' });
    expect(normalizeReason('split', '', 'free text only')).toEqual({ reason: '', note: 'free text only' });
  });

  test('an unrecognized code is accepted as other, keeping the original code in the note', () => {
    // Never rejected: the `other` rate is the growth thermostat, and the kept
    // code lets an offline miner promote a recurring one into a real enum.
    expect(normalizeReason('split', 'redundant', undefined)).toEqual({ reason: 'other', note: 'redundant' });
    expect(normalizeReason('split', 'redundant', 'with detail')).toEqual({ reason: 'other', note: 'redundant: with detail' });
  });

  test('an explicit other with a note passes through as other', () => {
    expect(normalizeReason('split', 'OTHER', 'mixed two concerns')).toEqual({ reason: 'other', note: 'mixed two concerns' });
  });

  test('merge seeds duplicate · other', () => {
    expect(normalizeReason('merge', 'duplicate', undefined)).toEqual({ reason: 'duplicate', note: '' });
    expect(normalizeReason('merge', 'other', 'cheaper than three calls')).toEqual({ reason: 'other', note: 'cheaper than three calls' });
  });

  test('rm seeds wrong · obsolete · other', () => {
    expect(normalizeReason('rm', 'wrong', undefined)).toEqual({ reason: 'wrong', note: '' });
    expect(normalizeReason('rm', 'OBSOLETE', undefined)).toEqual({ reason: 'obsolete', note: '' });
    expect(normalizeReason('rm', 'stale', 'path refactored away')).toEqual({ reason: 'other', note: 'stale: path refactored away' });
  });

  test('add has no seeded enum: a code buckets to other so the vocabulary can emerge', () => {
    // Free text (a bare --note) records with an empty reason, and any code on
    // `add` becomes `other` (kept in the note) rather than being rejected.
    expect(normalizeReason('add', undefined, 'found via grep')).toEqual({ reason: '', note: 'found via grep' });
    expect(normalizeReason('add', 'learned', 'from a failed CI run')).toEqual({ reason: 'other', note: 'learned: from a failed CI run' });
  });

  test('codes are per-op: a code valid for one op is other on another', () => {
    // `overloaded` is split's; it is not in merge's or rm's vocabulary.
    expect(normalizeReason('merge', 'overloaded', undefined)).toEqual({ reason: 'other', note: 'overloaded' });
    expect(normalizeReason('rm', 'duplicate', undefined)).toEqual({ reason: 'other', note: 'duplicate' });
    // `duplicate` is merge's; it is not in split's vocabulary.
    expect(normalizeReason('split', 'duplicate', undefined)).toEqual({ reason: 'other', note: 'duplicate' });
  });

  test('the usage log round-trips the reason and note columns', () => {
    logUsage(dir, 's', 'split', true, 3, { entries: ['aaa', 'bbb', 'ccc'], outcome: 'split', reason: 'overloaded', note: 'cut apart' });
    const [row] = parseUsage(dir);
    expect(row.outcome).toBe('split');
    expect(row.reason).toBe('overloaded');
    expect(row.note).toBe('cut apart');
  });

  test('an old row without the reason columns parses with them blank (backward compatible)', () => {
    // A ten-column row written before the reason columns existed.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      `2026-10-23T10:00:00.000Z\tp\tsplit\tok\t4ms\tsess\taaa,bbb\tsplit\t\t\n`,
      'utf-8',
    );
    const [row] = parseUsage(dir);
    expect(row.outcome).toBe('split');
    expect(row.reason).toBe('');
    expect(row.note).toBe('');
  });

  test('an over-long note is truncated (not rejected) so the ring stays byte-bounded (issue #128)', () => {
    process.env.NB_MAX_CHARS = '50'; // small, explicit cap for the assertion
    const huge = 'x'.repeat(10_000); // a pasted-stack-trace-sized note
    // logUsage is a best-effort monitoring path — it must NEVER throw, even on a
    // pathological note; a logging failure degrades, it does not crash the op.
    expect(() => logUsage(dir, 's', 'add', true, 1, { note: huge })).not.toThrow();

    const onDisk = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    const storedNote = parseUsage(dir)[0].note;
    // The stored note is bounded by maxChars(): one oversized row cannot bloat
    // the ring past ring-count x per-row cap.
    expect(storedNote.length).toBeLessThanOrEqual(maxChars());
    expect(storedNote.endsWith('…')).toBe(true); // truncation is marked, not silent
    // The whole ROW is bounded too — the note no longer dominates the line. The
    // fixed columns (ISO timestamp, shelf, command, status, ms, session, …) are a
    // small constant, so one row stays within the cap plus a generous header
    // budget — nothing near the 10_000-char input.
    expect(onDisk.trimEnd().length).toBeLessThanOrEqual(maxChars() + 200);
  });

  test('the note cap truncates at EXACTLY maxChars (boundary: at-cap kept, one-over cut)', () => {
    process.env.NB_MAX_CHARS = '50'; // cap of 50 for literal boundary assertions
    // Exactly at the cap: stored byte-identical, no ellipsis (off-by-one guard —
    // a `< cap` or `cap - 1` bound would wrongly truncate this).
    logUsage(dir, 's', 'add', true, 1, { note: 'a'.repeat(50) });
    expect(parseUsage(dir)[0].note).toBe('a'.repeat(50));
    // One over the cap: cut to cap-1 chars + the ellipsis, length === cap exactly.
    logUsage(dir, 's', 'add', true, 1, { note: 'b'.repeat(51) });
    expect(parseUsage(dir)[1].note).toBe('b'.repeat(49) + '…');
    expect(parseUsage(dir)[1].note.length).toBe(50);
  });

  test('a normal short note is stored unchanged (truncation only fires over the cap)', () => {
    process.env.NB_MAX_CHARS = '50';
    logUsage(dir, 's', 'add', true, 1, { note: 'found via grep' });
    expect(parseUsage(dir)[0].note).toBe('found via grep'); // byte-identical, no ellipsis
  });

  test('an over-cap note with tabs/newlines is sanitized THEN capped, staying one 12-column row', () => {
    process.env.NB_MAX_CHARS = '50';
    // Structural chars must collapse to spaces (no column/row injection) AND the
    // result must be capped — this pins the sanitize-before-cap ordering.
    const noisy = 'c\t'.repeat(60) + '\ntail'; // > cap, laden with tabs/newlines
    logUsage(dir, 's', 'add', true, 1, { note: noisy });
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').trimEnd();
    expect(raw.split('\t')).toHaveLength(12); // no injected columns
    const [row] = parseUsage(dir);
    expect(row.note.length).toBeLessThanOrEqual(maxChars());
    expect(row.note.endsWith('…')).toBe(true);
  });

  test('a broad search row\'s entries id-list is truncated so one row stays byte-bounded (issue #264)', () => {
    process.env.NB_MAX_CHARS = '50'; // small, explicit cap for the assertion
    // A `search match` row records the FULL pre-limit surfacedIds — every hit
    // across every matching notebook — so a one-term search over many shelves
    // can write hundreds of ids. Without a cap the usageRing bounds the ROW
    // COUNT but not the BYTES, re-opening the gap #128/#202 closed for the
    // free-text columns.
    const manyIds = Array.from({ length: 500 }, (_, i) => `id${i}`);
    expect(() => logUsage(dir, '-', 'search', true, 1, { entries: manyIds, outcome: 'match' })).not.toThrow();

    const row = parseUsage(dir)[0];
    const stored = row.entries.join(',');
    // The stored id-list is bounded by maxChars(): one broad row cannot bloat
    // the ring past ring-count × per-row cap.
    expect(stored.length).toBeLessThanOrEqual(maxChars());
    expect(stored.length).toBeGreaterThan(0); // some ids survive at cap 50
    // Truncation keeps WHOLE ids from the front (no mangled half-id) and is
    // SILENT — no sentinel token, because the column is iterated per id by the
    // diagnostic consumers and a marker would leak in as a phantom entry id.
    // Every stored token is one of the originals, in order, a prefix of the full
    // list — and NONE is the ellipsis a `note`-style cap would have appended.
    expect(row.entries).toEqual(manyIds.slice(0, row.entries.length));
    expect(row.entries).not.toContain('…');
    // parseUsage round-trips the now-bounded entries (the whole ROW is bounded
    // too — the id-list no longer dominates the line).
    const onDisk = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(onDisk.trimEnd().length).toBeLessThanOrEqual(maxChars() + 200);
  });

  test('a real one-term search over many near-full shelves writes a bounded search row (issue #264 acceptance)', async () => {
    process.env.NB_MAX_CHARS = '40';
    process.env.NB_MAX_LINES = '3'; // tiny shelves so the fixture stays fast
    // Build many shelves each near maxLines, every lesson sharing a term so one
    // search hits most of them and surfaces an id per hit — the pathological
    // broad-match shape the issue describes.
    const shelfCount = 12;
    for (let s = 0; s < shelfCount; s++) {
      for (let l = 0; l < maxLines(); l++) {
        await addEntry(dir, `shelf${s}`, `widget lesson ${s}-${l} about handling`);
      }
    }
    const result = search(dir, 'widget');
    // The search really is broad: its full id-list is far longer than one cap,
    // so truncation genuinely fires on this path (not a no-op assertion).
    expect(result.surfacedIds.join(',').length).toBeGreaterThan(maxChars());
    // Log it exactly as the CLI's `search match` path does (meta.entries =
    // result.surfacedIds) and assert the written row is byte-bounded.
    logUsage(dir, '-', 'search', true, 1, { entries: result.surfacedIds, outcome: 'match' });
    const searchRow = parseUsage(dir).find((r) => r.command === 'search');
    expect(searchRow).toBeDefined();
    expect(searchRow!.entries.join(',').length).toBeLessThanOrEqual(maxChars());
    // Every stored token round-trips as a real surfaced id, whole and in order —
    // and the truncation left no phantom sentinel token behind.
    expect(searchRow!.entries).toEqual(result.surfacedIds.slice(0, searchRow!.entries.length));
    expect(searchRow!.entries).not.toContain('…');
  });

  test('a capped entries list never injects a sentinel token into the per-id diagnostic consumers (issue #264)', () => {
    process.env.NB_MAX_CHARS = '50';
    // A batch `vote` — NOT just `search` — can also overflow the cap, and the
    // vote-reversal / loop detectors iterate `r.entries` per id. Assert the
    // truncated row carries only genuine ids, so no phantom `…` can forge a
    // cross-session vote-reversal for a non-existent entry.
    const manyIds = Array.from({ length: 60 }, (_, i) => `v${i}`);
    logUsage(dir, 's', 'vote', true, 1, { entries: manyIds, outcome: 'up' });
    const row = parseUsage(dir)[0];
    expect(row.entries.join(',').length).toBeLessThanOrEqual(maxChars());
    for (const id of row.entries) expect(manyIds).toContain(id); // every token is a real id
  });

  test('an entries id-list at exactly the cap is kept byte-identical; one over is truncated to whole ids (issue #264 boundary)', () => {
    process.env.NB_MAX_CHARS = '20';
    // Just within the cap: the joined column is 19 ≤ 20, so it is stored whole —
    // this pins the `<= cap` boundary (a `< cap` / `cap - 1` bound would wrongly
    // start dropping ids before the real limit).
    const exact = ['aaaaa', 'bbbbb', 'ccccccc']; // joined = "aaaaa,bbbbb,ccccccc" = 19 ≤ 20
    logUsage(dir, 's', 'split', true, 1, { entries: exact, outcome: 'split' });
    expect(parseUsage(dir)[0].entries).toEqual(exact); // byte-identical, nothing dropped
    // One id too many pushes the join over the cap → the overflowing id is
    // dropped WHOLE (no mangled half-id, no sentinel).
    const over = [...exact, 'eeee']; // joined = 24 > 20
    logUsage(dir, 's', 'split', true, 1, { entries: over, outcome: 'split' });
    const second = parseUsage(dir)[1].entries;
    expect(second.join(',').length).toBeLessThanOrEqual(maxChars());
    expect(second).toEqual(exact); // the first four fit (19 ≤ 20); 'eeee' dropped whole
  });

  test('an entries id-list within the cap is stored byte-identical (issue #264)', () => {
    process.env.NB_MAX_CHARS = '50';
    logUsage(dir, 's', 'split', true, 1, { entries: ['aaa', 'bbb', 'ccc'], outcome: 'split' });
    const row = parseUsage(dir)[0];
    // Sub-cap: unchanged — the common case and old on-disk rows are untouched.
    expect(row.entries).toEqual(['aaa', 'bbb', 'ccc']);
  });
});

describe('usage-log TSV wire format (golden, issue #126)', () => {
  // The usage log is a positional 16-column TSV read back by parseUsage and, for
  // pre-upgrade rings, by any older reader that looks only at the first five
  // columns. The behavioral round-trip tests above all go THROUGH parseUsage, so
  // a reorder or insertion of a column would round-trip cleanly while silently
  // mis-parsing OLD on-disk rows. These tests pin the serialized shape itself —
  // the exact column order and count — as a byte-level fixed point, so any
  // reorder/insert/remove fails here and becomes a deliberate, visible change.

  // The documented column order (notebook.ts logUsage): ts, shelf, command, ok,
  // ms, session, entries, outcome, collided, evicted, reason, note, errorClass,
  // decayed, recovered, misses. `misses` (issue #310) is the current trailing
  // column — appended after `recovered` (#309), itself after `decayed` (#293),
  // itself after `errorClass` (#176) — so a row from before any of them ends
  // earlier and still reads every prior field in place.
  const COLUMN_ORDER = [
    'ts', 'shelf', 'command', 'ok', 'ms', 'session',
    'entries', 'outcome', 'collided', 'evicted', 'reason', 'note', 'errorClass', 'decayed', 'recovered', 'misses',
  ] as const;

  test('a fully-populated row serializes as exactly 16 tab-separated columns in the documented order', () => {
    // Distinct, recognizable value per column so a swap of any two columns is
    // detectable (not just a count change) — generic values would let a reorder
    // pass. ms=1234 and ok=true pin the `1234ms` / `ok` renderings too. The
    // `recovered` column (issue #309) is system-recorded, not a meta field, so we
    // prime the process tally the way withLock does and let logUsage drain it,
    // giving a distinct `2:1` to pin its position and serialization. `misses`
    // (issue #310) is a distinct `3` to pin the trailing column.
    noteRecovery('lock-steal', 2);
    noteRecovery('temp-reap', 1);
    logUsage(dir, 'myshelf', 'merge', true, 1234, {
      session: 'sess-7',
      entries: ['aaa', 'bbb'],
      outcome: 'merged',
      collided: 'ccc',
      evicted: 'ddd:0.5',
      reason: 'duplicate',
      note: 'some note',
      errorClass: 'too_long',
      decayed: 'eee:0',
      misses: 3,
    });

    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true); // rows are newline-terminated
    // Split off the trailing newline only — NOT trimEnd(), which would also eat
    // trailing empty columns (tabs are whitespace) and hide a dropped last column.
    const linesWritten = raw.split('\n').filter((l) => l !== '');
    expect(linesWritten).toHaveLength(1);
    const cols = linesWritten[0].split('\t');

    // Exactly 16 columns — a removed or injected column fails here first (an
    // insertion pushes the width past the 16 names in COLUMN_ORDER, a removal
    // below them).
    expect(cols).toHaveLength(COLUMN_ORDER.length);

    // Zip the row against the documented column NAMES, so the assertion reads as
    // name→value and a reorder shifts a value onto the wrong name (not merely a
    // wrong index). COLUMN_ORDER is thus load-bearing, not decorative.
    const byName = Object.fromEntries(COLUMN_ORDER.map((name, i) => [name, cols[i]]));

    // Column 0 is the ISO-8601 timestamp (dynamic, so matched by shape).
    expect(byName.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // The remaining columns are pinned to their exact literal serialization,
    // keyed by name — a reorder or insertion fails this equality.
    const { ts: _ts, ...rest } = byName;
    expect(rest).toEqual({
      shelf: 'myshelf',
      command: 'merge',
      ok: 'ok', // true → 'ok'
      ms: '1234ms', // Math.round(ms) + 'ms'
      session: 'sess-7',
      entries: 'aaa,bbb', // comma-joined
      outcome: 'merged',
      collided: 'ccc',
      evicted: 'ddd:0.5', // <id>:<finalScore>
      reason: 'duplicate',
      note: 'some note',
      errorClass: 'too_long',
      decayed: 'eee:0', // <id>:<postDockScore> (issue #293)
      recovered: '2:1', // <lockSteals>:<tempReaps> (issue #309)
      misses: '3', // batch-vote partial misses (issue #310)
    });
  });

  test('err status and an empty-meta row still render the fixed 16-column frame', () => {
    // A `show`-shaped call fills no richer meta; the trailing columns must still
    // be present (empty), keeping the frame 16 columns wide — an old reader that
    // slices the first five columns depends on this stable prefix. session is
    // pinned to '' so an ambient NB_SESSION cannot populate column 5. A read-only
    // `show` runs no withLock, so the crash-recovery column (#309) is empty too.
    logUsage(dir, 's', 'show', false, 2, { session: '' });
    // Split on the row's own newline, not trimEnd(), so the trailing empty
    // columns (which are tabs) are preserved and counted.
    const line = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '')[0];
    const cols = line.split('\t');
    expect(cols).toHaveLength(16);
    // The stable 5-column prefix an old reader slices: shelf, command, ok, ms.
    expect(cols.slice(1, 5)).toEqual(['s', 'show', 'err', '2ms']); // ok=false → 'err'
    // session..misses (indices 5..15) are all empty for a bare call.
    expect(cols.slice(5)).toEqual(['', '', '', '', '', '', '', '', '', '', '']);
  });

  test('a legacy 5-column row parses with the newer columns defaulting to blank/empty', () => {
    // The backward-compat contract: a ring written before the richer columns
    // existed holds only ts, shelf, command, ok, ms. It must still parse, with
    // every appended column (session…recovered) defaulting to blank/empty.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      '2026-01-02T03:04:05.000Z\tp\tadd\tok\t5ms\n',
      'utf-8',
    );
    const rows = parseUsage(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ts: '2026-01-02T03:04:05.000Z',
      role: 'p',
      command: 'add',
      ok: true,
      ms: 5,
      session: '',
      entries: [],
      outcome: '',
      collided: '',
      evicted: '',
      reason: '',
      note: '',
      errorClass: '',
      decayed: '',
      recovered: '',
      misses: 0,
    });
  });

  test('a pre-#309 14-column row (through decayed, no recovered/misses) parses with both trailing columns blank', () => {
    // The real on-disk state right after an upgrade: rows written by the #293
    // code end at `decayed` (14 columns). Both newer trailing columns — `recovered`
    // (#309) and `misses` (#310) — must read back blank/0, exactly as every prior
    // trailing-column addition did.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      '2026-01-02T03:04:05.000Z\tp\tadd\tok\t5ms\tsess\taaa\taccepted\t\t\t\t\tother\tbbb:0\n',
      'utf-8',
    );
    const [row] = parseUsage(dir);
    expect(row.decayed).toBe('bbb:0'); // the last column it DID carry is in place
    expect(row.recovered).toBe(''); // defaults blank
    expect(row.misses).toBe(0); // the newest trailing column defaults to 0
  });

  test('a post-#309 15-column row (through recovered, no misses) parses with misses 0', () => {
    // The most likely on-disk shape right after THIS upgrade: rows written by the
    // #309 code end at `recovered` (15 columns). The new trailing `misses` column
    // must read back 0 without disturbing any prior field.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      '2026-01-02T03:04:05.000Z\tp\tvote\tok\t5ms\tsess\taaa\tup\t\t\t\t\t\t\t1:0\n',
      'utf-8',
    );
    const [row] = parseUsage(dir);
    expect(row.recovered).toBe('1:0'); // the last column it DID carry is in place
    expect(row.misses).toBe(0); // the new trailing column defaults to 0
  });

  test('parseUsage pins the READER column order: a hand-typed 16-column row maps each field to its documented position', () => {
    // The writer golden above pins logUsage's serialization; this pins the
    // reader independently. parseUsage destructures positionally, so a reorder
    // of ITS destructuring (e.g. swapping collided/evicted) would not be caught
    // by the legacy test (whose richer columns are all blank). A distinct value
    // per column makes any reader reorder fail this full `toEqual`. The trailing
    // `misses` column (issue #310) parses to an integer (`5` here).
    writeFileSync(
      join(dir, '.nb-usage.log'),
      '2026-01-02T03:04:05.000Z\tmyshelf\tmerge\tok\t1234ms\tsess-7\taaa,bbb\tmerged\tccc\tddd:0.5\tduplicate\tsome note\ttoo_long\teee:0\t2:1\t5\n',
      'utf-8',
    );
    expect(parseUsage(dir)[0]).toEqual({
      ts: '2026-01-02T03:04:05.000Z',
      role: 'myshelf',
      command: 'merge',
      ok: true,
      ms: 1234,
      session: 'sess-7',
      entries: ['aaa', 'bbb'],
      outcome: 'merged',
      collided: 'ccc',
      evicted: 'ddd:0.5',
      reason: 'duplicate',
      note: 'some note',
      errorClass: 'too_long',
      decayed: 'eee:0',
      recovered: '2:1',
      misses: 5,
    });
  });

  test('parseUsage reads a MIXED post-upgrade ring: a legacy 5-column row followed by a full 16-column row', () => {
    // The real on-disk state right after an upgrade: old rows written by the
    // pre-richer-columns code, then new rows with all 16. Both must parse in one
    // file — the legacy row with blank richer columns, the new row fully.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      '2026-01-01T00:00:00.000Z\tp\tadd\tok\t5ms\n' +
        '2026-01-02T03:04:05.000Z\ts\tmerge\terr\t9ms\tsess\taaa\tmerged\tccc\tddd:0.5\tduplicate\tnote\tbad_args\tfff:2\t1:0\t2\n',
      'utf-8',
    );
    const rows = parseUsage(dir);
    expect(rows).toHaveLength(2);
    // Legacy row: richer columns default to blank/empty (misses → 0).
    expect(rows[0]).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      role: 'p',
      command: 'add',
      ok: true,
      ms: 5,
      session: '',
      entries: [],
      outcome: '',
      collided: '',
      evicted: '',
      reason: '',
      note: '',
      errorClass: '',
      decayed: '',
      recovered: '',
      misses: 0,
    });
    // Full row: every richer column is parsed into its field.
    expect(rows[1]).toEqual({
      ts: '2026-01-02T03:04:05.000Z',
      role: 's',
      command: 'merge',
      ok: false,
      ms: 9,
      session: 'sess',
      entries: ['aaa'],
      outcome: 'merged',
      collided: 'ccc',
      evicted: 'ddd:0.5',
      reason: 'duplicate',
      note: 'note',
      errorClass: 'bad_args',
      decayed: 'fff:2',
      recovered: '1:0',
      misses: 2,
    });
  });
});

describe('lock ownership (issue #331)', () => {
  const lock = () => join(dir, '.nb.lock');

  test("a holder whose lock was stolen does not free the thief's live lock on release", async () => {
    await withLock(dir, () => {
      // Simulate: we outlived the stale threshold and thief B took over.
      rmSync(lock(), { recursive: true });
      mkdirSync(lock());
      writeFileSync(join(lock(), 'owner'), 'B.thief-token', 'utf-8');
    });
    expect(existsSync(lock())).toBe(true); // A's finally left B's lock in place
    expect(readFileSync(join(lock(), 'owner'), 'utf-8')).toBe('B.thief-token');
  });

  test('releaseHeldLock also leaves a thief-owned lock alone', async () => {
    await withLock(dir, () => {
      rmSync(lock(), { recursive: true });
      mkdirSync(lock());
      writeFileSync(join(lock(), 'owner'), 'B.thief-token', 'utf-8');
      releaseHeldLock();
    });
    expect(existsSync(lock())).toBe(true);
  });

  test('a normal holder still releases its own lock, owner file and all', async () => {
    await withLock(dir, () => {
      expect(readFileSync(join(lock(), 'owner'), 'utf-8')).toMatch(/^\d+\.[0-9a-f]+$/);
    });
    expect(existsSync(lock())).toBe(false);
  });

  test('two waiters racing one stale lock: only one steals; the loser cannot remove the winner\'s live lock', () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), 'owner'), 'dead.token', 'utf-8');
    const aged = Date.now() / 1000 - 20;
    utimesSync(join(lock(), 'owner'), aged, aged);
    // B and C both observed token 'dead.token'. B steals and re-creates its own lock.
    expect(stealStale(lock(), 'dead.token')).toBe(true);
    mkdirSync(lock());
    writeFileSync(join(lock(), 'owner'), 'B.live-token', 'utf-8');
    // C, acting on its stale observation, must back off.
    expect(stealStale(lock(), 'dead.token')).toBe(false);
    expect(readFileSync(join(lock(), 'owner'), 'utf-8')).toBe('B.live-token');
    expect(existsSync(join(lock(), 'reap'))).toBe(false); // C's mutex dir cleaned up
  });

  test('a stealer excludes a concurrent stealer while its reap mutex is held', () => {
    mkdirSync(lock());
    mkdirSync(join(lock(), 'reap')); // another stealer mid-steal
    expect(stealStale(lock(), null)).toBe(false);
    expect(existsSync(lock())).toBe(true);
  });

  test('a lock whose owner file is fresh is not stolen even if the observer saw a stale mtime (issue #331 TOCTOU)', () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), 'owner'), 'C.live', 'utf-8'); // fresh owner file
    expect(stealStale(lock(), 'C.live', 10_000)).toBe(false);
    expect(readFileSync(join(lock(), 'owner'), 'utf-8')).toBe('C.live');
  });

  test('a stealer that died holding the reap mutex does not wedge the lock forever', () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), 'owner'), 'dead.token', 'utf-8');
    mkdirSync(join(lock(), 'reap'));
    const aged = Date.now() / 1000 - 20;
    utimesSync(join(lock(), 'reap'), aged, aged);
    utimesSync(join(lock(), 'owner'), aged, aged);
    expect(stealStale(lock(), 'dead.token', 10_000)).toBe(false); // clears the aged reap
    expect(stealStale(lock(), 'dead.token', 10_000)).toBe(true); // next attempt steals
  });

  test('release yields to a stealer holding the reap mutex instead of racing it', () => {
    // the holder's release path takes the same mutex; with it held, the lock stays
    mkdirSync(lock());
    writeFileSync(join(lock(), 'owner'), 'x.y', 'utf-8');
    mkdirSync(join(lock(), 'reap'));
    expect(stealStale(lock(), 'x.y', 10_000)).toBe(false);
    expect(existsSync(lock())).toBe(true);
  });

  test('a legacy token-less stale lock is still stolen', async () => {
    mkdirSync(lock());
    const aged = Date.now() / 1000 - 20;
    utimesSync(lock(), aged, aged);
    const r = await addEntry(dir, 'legacy', 'stolen from a token-less lock');
    expect(r.added).toBe(true);
    expect(drainPendingRecovery().lockSteals).toBe(1);
  });
});

describe('crash-recovery observability (issue #309)', () => {
  test('withLock tallies a stale-lock steal as a crash-recovery event, mutation unchanged', async () => {
    // Acceptance: pre-age a lock so the next mutation steals it. The steal must be
    // recorded (the tally) WITHOUT changing the recovery action — the add still lands.
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a crashed nb left the lock dir behind
    const aged = Date.now() / 1000 - 20; // back-date mtime 20s (> 10s default stale threshold)
    utimesSync(lock, aged, aged);
    const r = await addEntry(dir, 'stale', 'written after stealing a stale lock');
    expect(r.added).toBe(true); // recovery behavior is unchanged — the mutation completes
    const drained = drainPendingRecovery();
    expect(drained.lockSteals).toBe(1);
    expect(drained.tempReaps).toBe(0);
    expect(existsSync(lock)).toBe(false); // the stolen lock is still released at the end
  });

  test('reapLeftoverTemps reports the count it removed, tallied as temp-reaps during a mutation', async () => {
    // Acceptance: plant crash debris — a per-pid shelf temp and a usage-log temp a
    // dead writer left — then run a mutation. Both are reaped and counted.
    writeFileSync(join(dir, 'scout.md.99999.tmp'), 'half-written', 'utf-8');
    writeFileSync(join(dir, '.nb-usage.log.99999.tmp'), 'half-written', 'utf-8');
    const r = await addEntry(dir, 'victim', 'a mutation that reaps crash debris');
    expect(r.added).toBe(true);
    const drained = drainPendingRecovery();
    expect(drained.lockSteals).toBe(0);
    expect(drained.tempReaps).toBe(2); // both planted temps reaped
    expect(existsSync(join(dir, 'scout.md.99999.tmp'))).toBe(false);
    expect(existsSync(join(dir, '.nb-usage.log.99999.tmp'))).toBe(false);
  });

  test('reapLeftoverTemps returns 0 when there is no debris and on an unreadable dir', () => {
    expect(reapLeftoverTemps(dir)).toBe(0); // empty dir — nothing to reap
    expect(reapLeftoverTemps(join(dir, 'does-not-exist'))).toBe(0); // unreadable — never throws
  });

  test('logUsage drains the recovery tally into the recovered column; each event counts once', () => {
    noteRecovery('lock-steal', 1);
    noteRecovery('temp-reap', 3);
    logUsage(dir, 'patcher', 'add', true, 1, { outcome: 'accepted' });
    expect(parseUsage(dir)[0].recovered).toBe('1:3'); // <lockSteals>:<tempReaps>
    // The next call drains to blank — the event was attributed to exactly one row.
    logUsage(dir, 'patcher', 'show', true, 1);
    expect(parseUsage(dir)[1].recovered).toBe('');
  });

  test('a non-positive recovery count is ignored and never throws', () => {
    expect(() => noteRecovery('temp-reap', 0)).not.toThrow();
    noteRecovery('lock-steal', 0);
    noteRecovery('temp-reap', -5);
    expect(drainPendingRecovery()).toEqual({ lockSteals: 0, tempReaps: 0 });
  });

  test('nb stats surfaces window-summed crash recovery, deployment-wide (acceptance)', () => {
    const now = Date.now();
    // A steal on one shelf, a double-reap on another, and a clean mutation.
    noteRecovery('lock-steal', 1);
    logUsage(dir, 'patcher', 'add', true, 1);
    noteRecovery('temp-reap', 2);
    logUsage(dir, 'scout', 'merge', true, 1);
    logUsage(dir, 'patcher', 'vote', true, 1); // no recovery
    const rep = stats(dir, { now });
    expect(rep.crashRecovery).toEqual({ lockSteals: 1, tempReaps: 2 });
    // Deployment-wide: a shelf-scoped report shows the SAME totals (the lock and
    // temp debris are dir-global, like the usage ring), not just the shelf's own.
    expect(stats(dir, { shelf: 'scout', now }).crashRecovery).toEqual({ lockSteals: 1, tempReaps: 2 });
    // The field is additive — the schema version does not bump (#172 policy).
    expect(rep.schemaVersion).toBe(1);
  });

  test('a steal and a reap on the same call combine into one recovered pair', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock);
    const aged = Date.now() / 1000 - 20;
    utimesSync(lock, aged, aged);
    writeFileSync(join(dir, 'ghost.md.88888.tmp'), 'half-written', 'utf-8'); // crash-left shelf temp
    await addEntry(dir, 'both', 'stole a lock and reaped a temp in one call');
    // The acquire steals the stale lock; reapLeftoverTemps (run before fn) removes
    // the planted temp — both tallied onto the single call.
    expect(drainPendingRecovery()).toEqual({ lockSteals: 1, tempReaps: 1 });
  });

  test('a mutation whose body throws after a steal still tallies the recovery', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock);
    const aged = Date.now() / 1000 - 20;
    utimesSync(lock, aged, aged);
    // The steal happens during lock acquire, BEFORE fn runs; a throwing fn must
    // not lose the recovery — the next logUsage (the CLI's finally on an error
    // exit) still records it, and the lock is still released on the throw path.
    await expect(withLock(dir, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(drainPendingRecovery().lockSteals).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  test('crash recovery counts a row at the window edge and excludes one just beyond it', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const windowMs = 7 * 86_400_000;
    const mkRow = (ts: string, rec: string): string =>
      [ts, 'p', 'add', 'ok', '1ms', '', '', '', '', '', '', '', '', '', rec].join('\t');
    writeFileSync(
      join(dir, '.nb-usage.log'),
      // Exactly at the window edge (now - windowMs): inside, since the gate is `<=`.
      mkRow(new Date(now - windowMs).toISOString(), '1:0') + '\n' +
        // 1ms beyond the edge: excluded.
        mkRow(new Date(now - windowMs - 1).toISOString(), '9:9') + '\n',
      'utf-8',
    );
    expect(stats(dir, { now, windowMs }).crashRecovery).toEqual({ lockSteals: 1, tempReaps: 0 });
  });

  test('a malformed recovered column contributes 0 and never NaN', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const mkRow = (rec: string): string =>
      ['2026-10-31T11:00:00.000Z', 'p', 'add', 'ok', '1ms', '', '', '', '', '', '', '', '', '', rec].join('\t');
    writeFileSync(
      join(dir, '.nb-usage.log'),
      // 'abc' and 'x:y' are garbage → 0:0; only the well-formed '2:4' contributes.
      [mkRow('abc'), mkRow('x:y'), mkRow('2:4')].join('\n') + '\n',
      'utf-8',
    );
    const cr = stats(dir, { now, windowMs: 7 * 86_400_000 }).crashRecovery;
    expect(Number.isNaN(cr.lockSteals)).toBe(false);
    expect(Number.isNaN(cr.tempReaps)).toBe(false);
    expect(cr).toEqual({ lockSteals: 2, tempReaps: 4 });
  });
});

describe('error-class usage column (issue #176)', () => {
  test('classifyError reads an NbError class and defaults everything else to `other`', () => {
    expect(classifyError(new NbError('too_long', 'x'))).toBe('too_long');
    expect(classifyError(new NbError('ambiguous_selector', 'x'))).toBe('ambiguous_selector');
    expect(classifyError(new NbError('bad_args', 'x'))).toBe('bad_args');
    // A plain Error (or any non-NbError throw) is never guessed from its message.
    expect(classifyError(new Error('lesson too long — looks like too_long but is plain'))).toBe('other');
    expect(classifyError('a bare string throw')).toBe('other');
    expect(classifyError(undefined)).toBe('other');
  });

  test('ERROR_CLASSES is the exact, ordered wire enum (a documented TSV contract)', () => {
    // Pin the exact contents+order, not a self-referential loop: the column is a
    // wire format read by `nb stats` and documented in the README, so adding,
    // removing, or reordering a class is a deliberate, visible change — and
    // `other` (the escape hatch) must always be present and last.
    expect([...ERROR_CLASSES]).toEqual([
      'too_long',
      'ambiguous_selector',
      'no_match',
      'multiline_refused',
      'bad_args',
      'corrupt',
      'unknown_subcommand',
      'other',
    ]);
  });

  test('an NbError keeps the plain-Error message (stderr/behaviour unchanged)', () => {
    const e = new NbError('no_match', 'no entry matches "zzz"');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('no entry matches "zzz"');
    expect(e.errorClass).toBe('no_match');
  });

  test('the error class round-trips through the usage log', () => {
    logUsage(dir, 's', 'add', false, 2, { errorClass: 'too_long' });
    expect(parseUsage(dir)[0].errorClass).toBe('too_long');
  });

  test('a successful call records a blank error class', () => {
    logUsage(dir, 's', 'show', true, 1);
    expect(parseUsage(dir)[0].errorClass).toBe('');
  });

  test('resolveSelector throws a classified NbError: no_match vs ambiguous_selector', async () => {
    await addEntry(dir, 'd', 'alpha lesson one');
    await addEntry(dir, 'd', 'alpha lesson two');
    // No entry matches → no_match.
    await expect(vote(dir, 'd', 'zzzzznope', 1)).rejects.toMatchObject({ errorClass: 'no_match' });
    // A substring matching BOTH entries → ambiguous_selector.
    await expect(vote(dir, 'd', 'alpha', 1)).rejects.toMatchObject({ errorClass: 'ambiguous_selector' });
  });

  test('each converted mutating-op throw carries the right NbError class (per-site, not just one)', async () => {
    process.env.NB_MAX_CHARS = '20';
    const LONG = 'z'.repeat(50);
    // Seed a shelf with two distinct entries so merge/split have real targets.
    await addEntry(dir, 's', 'first real lesson');
    await addEntry(dir, 's', 'second real lesson');
    // Pin ONE throw site per (op, class) so swapping a class string in merge /
    // split / move / describe is caught — not only the vote selector sites.
    // too_long sites:
    await expect(merge(dir, 's', 'first', 'second', LONG)).rejects.toMatchObject({ errorClass: 'too_long' });
    await expect(split(dir, 's', 'first', LONG, 'ok half')).rejects.toMatchObject({ errorClass: 'too_long' });
    await expect(setDescription(dir, 's', LONG)).rejects.toMatchObject({ errorClass: 'too_long' });
    // bad_args sites:
    await expect(merge(dir, 's', 'first', 'first', 'combined lesson')).rejects.toMatchObject({ errorClass: 'bad_args' }); // same entry twice
    await expect(move(dir, 'x', 'x', 'first')).rejects.toMatchObject({ errorClass: 'bad_args' }); // same source/target shelf
    let caught: unknown;
    try { assertSafeShelf('bad/name'); } catch (e) { caught = e; }
    expect(classifyError(caught)).toBe('bad_args'); // an invalid shelf name is bad_args
    // no_match site: an empty shelf has nothing to act on.
    await expect(vote(dir, 'empty-shelf', 'anything', 1)).rejects.toMatchObject({ errorClass: 'no_match' });
    await expect(move(dir, 'empty-shelf', 'dest', 'anything')).rejects.toMatchObject({ errorClass: 'no_match' });
  });

  test('stats breaks a high-error-rate anomaly down by error class (issue #176)', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    // 10 `add` calls: 7 errors (5 too_long, 2 bad_args) + 3 ok → 70% error rate.
    const classes = [
      'too_long', 'too_long', 'too_long', 'too_long', 'too_long', // 5
      'bad_args', 'bad_args', // 2
    ];
    const rows: string[] = [];
    classes.forEach((cls, i) => {
      rows.push(`${new Date(now - i * 1000).toISOString()}\tp\tadd\terr\t2ms\t\t\t\t\t\t\t\t${cls}`);
    });
    for (let i = 0; i < 3; i++) rows.push(`${new Date(now - (i + 10) * 1000).toISOString()}\tp\tadd\tok\t2ms`);
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');

    const rep = stats(dir, { now });
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'add');
    expect(anomaly).toBeDefined();
    // The detail names the dominant class first with its share of the 7 errors.
    expect(anomaly!.detail).toContain('70% errors over 10 calls');
    expect(anomaly!.detail).toContain('too_long 71%'); // 5/7
    expect(anomaly!.detail).toContain('bad_args 29%'); // 2/7
    // The classes are ordered most-common first.
    expect(anomaly!.detail.indexOf('too_long')).toBeLessThan(anomaly!.detail.indexOf('bad_args'));
  });

  test('equal-count error classes break the tie alphabetically (stable line order)', () => {
    process.env.NB_ERR_MIN = '2';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    // Two classes with the SAME count (1 each): without a tie-break the order is
    // Map-insertion; the alphabetical tie-break must put `bad_args` before
    // `no_match` regardless of which was logged first. Log `no_match` FIRST so a
    // dropped tie-break (insertion order) would wrongly print it first.
    const rows = [
      `${new Date(now - 1000).toISOString()}\tp\tvote\terr\t2ms\t\t\t\t\t\t\t\tno_match`,
      `${new Date(now - 2000).toISOString()}\tp\tvote\terr\t2ms\t\t\t\t\t\t\t\tbad_args`,
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'vote')!;
    expect(anomaly.detail).toContain('bad_args 50%, no_match 50%'); // alphabetical, not insertion order
  });

  test('errorCauses breaks each command down by cause and omits commands below the min (issue #223)', () => {
    const now = Date.now();
    const row = (cmd: string, ok: boolean, cls = '', outcome = ''): string =>
      `${new Date(now - Math.random() * 1000).toISOString()}\tp\t${cmd}\t${ok ? 'ok' : 'err'}\t2ms\t\t\t${outcome}\t\t\t\t\t${cls}`;
    const rows = [
      // add: 5 errors (3 too_long, 2 unclassified) + 1 ok
      row('add', false, 'too_long'), row('add', false, 'too_long'), row('add', false, 'too_long'),
      row('add', false), row('add', false), row('add', true),
      // vote: 3 errors, all no_match
      row('vote', false, 'no_match'), row('vote', false, 'no_match'), row('vote', false, 'no_match'),
      // rm: only 2 errors → below ERROR_CAUSE_MIN (3), must be omitted
      row('rm', false, 'bad_args'), row('rm', false, 'bad_args'),
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');

    const causes = stats(dir, { now }).errorCauses;
    expect(causes.map((c) => c.command)).toEqual(['add', 'vote']); // rm omitted; add first (more errors)
    const add = causes.find((c) => c.command === 'add')!;
    expect(add.errors).toBe(5);
    expect(add.breakdown).toEqual([
      { cause: 'too_long', pct: 60 },
      { cause: 'unclassified', pct: 40 },
    ]);
    expect(causes.find((c) => c.command === 'vote')!.breakdown).toEqual([{ cause: 'no_match', pct: 100 }]);
  });

  test('errorCauses falls back to outcome=too-long on a pre-#176 row with no errorClass', () => {
    const now = Date.now();
    // errorClass column blank, but outcome records `too-long` (the shape a binary
    // predating the errorClass column writes) → still classified as too_long.
    const rows = Array.from(
      { length: 3 },
      (_, i) => `${new Date(now - i * 1000).toISOString()}\tp\tadd\terr\t2ms\t\t\ttoo-long`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const add = stats(dir, { now }).errorCauses.find((c) => c.command === 'add')!;
    expect(add.breakdown).toEqual([{ cause: 'too_long', pct: 100 }]);
  });

  test('batch-vote partial misses surface as no_match in the vote error causes (issue #310)', () => {
    const now = Date.now();
    // Two ≥1-landed batch votes, each skipping two stale ids: ok=true SUCCESS rows
    // (not error rows) that each record misses=2. Before #310 these were logged as
    // clean successes, so the vote selector-miss readout was blind to the four
    // stale selectors. Now the four misses must surface as `no_match`, crossing
    // the noise floor (ERROR_CAUSE_MIN=3) the readout applies to every cause.
    logUsage(dir, 'v', 'vote', true, 1, { outcome: 'up', entries: ['aaa'], misses: 2 });
    logUsage(dir, 'v', 'vote', true, 1, { outcome: 'up', entries: ['bbb'], misses: 2 });
    const rep = stats(dir, { now });
    const vote = rep.errorCauses.find((c) => c.command === 'vote')!;
    expect(vote.errors).toBe(4); // 0 error rows + 4 folded partial misses
    expect(vote.breakdown).toEqual([{ cause: 'no_match', pct: 100 }]);
    // The per-command error RATE stays honest: both rows exited 0, so vote's err%
    // is 0 — the misses show only in the cause readout, never inflating the rate.
    expect(rep.perCommand.find((c) => c.command === 'vote')!.errorRate).toBe(0);
  });

  test('partial misses ADD to (not overwrite) existing vote error causes, and stay out of the error rate (issue #310)', () => {
    const now = Date.now();
    // A window mixing real error rows AND a partial-miss success row. The misses
    // must be ADDED to the no_match bucket (not overwrite the other causes), and
    // the error rate must count only the two genuinely-failed calls — never the
    // partial-success row. A fold that overwrote no_match, or that leaked misses
    // into the rate, would fail here. Built via logUsage so the real serializer
    // places every column (rather than hand-counting tabs).
    logUsage(dir, 'v', 'vote', false, 2, { errorClass: 'no_match' }); // a wholly-failed vote
    logUsage(dir, 'v', 'vote', false, 2, { errorClass: 'bad_args' }); // a different failure class
    logUsage(dir, 'v', 'vote', true, 2, { outcome: 'up', entries: ['aaa'], misses: 2 }); // ≥1-landed batch, two stale ids
    const rep = stats(dir, { now });
    const vote = rep.errorCauses.find((c) => c.command === 'vote')!;
    // 2 error rows + 2 folded misses = 4 events; no_match = 1 row + 2 misses = 3.
    expect(vote.errors).toBe(4);
    expect(vote.breakdown).toEqual([
      { cause: 'no_match', pct: 75 }, // 3/4
      { cause: 'bad_args', pct: 25 }, // 1/4
    ]);
    // Error RATE counts only the two failed CALLS out of three (the batch exited 0).
    const perCmd = rep.perCommand.find((c) => c.command === 'vote')!;
    expect(perCmd.errors).toBe(2);
    expect(perCmd.calls).toBe(3);
  });

  test('the error-cause noise floor counts MISS EVENTS, not rows: 2 hidden, 3 surface (issue #310)', () => {
    // The fold must respect ERROR_CAUSE_MIN=3 AND count miss events, not rows.
    // 1 miss → hidden (a prior test). Two separate 1-miss rows (2 events) → still
    // hidden. A single row carrying 3 misses → surfaces with errors=3. This pins
    // the boundary from both sides and proves the floor is on events, not rows.
    const now = Date.now();
    logUsage(dir, 'v', 'vote', true, 1, { outcome: 'up', entries: ['a'], misses: 1 });
    logUsage(dir, 'v', 'vote', true, 1, { outcome: 'up', entries: ['b'], misses: 1 });
    expect(stats(dir, { now }).errorCauses.find((c) => c.command === 'vote')).toBeUndefined(); // 2 events < 3

    logUsage(dir, 'w', 'vote', true, 1, { outcome: 'up', entries: ['c'], misses: 3 });
    const w = stats(dir, { shelf: 'w', now }).errorCauses.find((c) => c.command === 'vote')!;
    expect(w.errors).toBe(3); // one row, three miss events → meets the floor
    expect(w.breakdown).toEqual([{ cause: 'no_match', pct: 100 }]);
  });

  test('a batch vote with ONE partial miss stays below the error-cause noise floor (issue #310)', () => {
    const now = Date.now();
    // A single stale id in an otherwise-landing batch is one miss — below
    // ERROR_CAUSE_MIN (3), so like any stray error it is not yet a named cause.
    // This pins that the fold respects the existing noise gate rather than
    // surfacing every one-off miss.
    logUsage(dir, 'v', 'vote', true, 1, { outcome: 'up', entries: ['aaa'], misses: 1 });
    const rep = stats(dir, { now });
    expect(rep.errorCauses.find((c) => c.command === 'vote')).toBeUndefined();
  });

  test('a corrupt negative `misses` cell cannot subtract from the vote miss aggregation (issue #310)', () => {
    // parseUsage clamps misses to ≥0, so a hand-edited/torn negative cell can
    // never reduce the folded count below the real misses. Here three genuine
    // misses plus a bogus `-5` row must still read as three, not −2.
    const now = Date.now();
    // Columns after outcome(8): collided, evicted, reason, note, errorClass,
    // decayed, recovered, then misses(16) — eight tabs after `up`.
    const row = (misses: string): string =>
      `${new Date(now - Math.random() * 1000).toISOString()}\tv\tvote\tok\t2ms\t\t\tup\t\t\t\t\t\t\t\t${misses}`;
    writeFileSync(join(dir, '.nb-usage.log'), [row('3'), row('-5')].join('\n') + '\n', 'utf-8');
    expect(parseUsage(dir).map((r) => r.misses)).toEqual([3, 0]); // the bogus cell clamps to 0
    const vote = stats(dir, { now }).errorCauses.find((c) => c.command === 'vote')!;
    expect(vote.errors).toBe(3);
  });

  test('pre-#176 error rows (no class) are bucketed as `unclassified`, not a misleading `other`', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    // Five legacy 5-column error rows — written before the error-class column existed.
    const rows = Array.from({ length: 5 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tp\tvote\terr\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'vote');
    expect(anomaly).toBeDefined();
    expect(anomaly!.detail).toContain('unclassified 100%');
    expect(anomaly!.detail).not.toContain('other');
  });

  test('a mixed ring (legacy + classified errors) shares one denominator: the full error count', () => {
    process.env.NB_ERR_MIN = '3';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    // 4 errors: 2 classified too_long, 2 legacy (no class) → each bucket is 50%
    // of the 4-error total, proving `unclassified` sits beside a real class and
    // the denominator is the whole error count, not just the classified rows.
    const rows = [
      `${new Date(now - 1000).toISOString()}\tp\tadd\terr\t2ms\t\t\t\t\t\t\t\ttoo_long`,
      `${new Date(now - 2000).toISOString()}\tp\tadd\terr\t2ms\t\t\t\t\t\t\t\ttoo_long`,
      `${new Date(now - 3000).toISOString()}\tp\tadd\terr\t2ms`, // legacy 5-column
      `${new Date(now - 4000).toISOString()}\tp\tadd\terr\t2ms`, // legacy 5-column
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'add')!;
    expect(anomaly.detail).toContain('too_long 50%');
    expect(anomaly.detail).toContain('unclassified 50%');
  });

  test('the high-error-rate detail and the error-causes readout agree on a mixed-age log (issue #418)', () => {
    process.env.NB_ERR_MIN = '3';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    // 5 failed adds: 2 carry the too_long class, 2 predate the class column but
    // recorded the `too-long` outcome (column 8), 1 is a bare legacy row with
    // neither. Both stats lines must call the first four too_long — before #418
    // the anomaly read the two outcome-only rows as `unclassified` (40/60) while
    // the error-causes readout read them as too_long (80/20).
    const rows = [
      `${new Date(now - 1000).toISOString()}\tp\tadd\terr\t2ms\t\t\t\t\t\t\t\ttoo_long`,
      `${new Date(now - 2000).toISOString()}\tp\tadd\terr\t2ms\t\t\t\t\t\t\t\ttoo_long`,
      `${new Date(now - 3000).toISOString()}\tp\tadd\terr\t2ms\t\t\ttoo-long`,
      `${new Date(now - 4000).toISOString()}\tp\tadd\terr\t2ms\t\t\ttoo-long`,
      `${new Date(now - 5000).toISOString()}\tp\tadd\terr\t2ms`, // legacy 5-column
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    const causes = rep.errorCauses.find((c) => c.command === 'add')!;
    expect(causes.breakdown).toEqual([
      { cause: 'too_long', pct: 80 },
      { cause: 'unclassified', pct: 20 },
    ]);
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'add')!;
    // The anomaly's split is the same split, rendered as text.
    expect(anomaly.detail).toContain(causes.breakdown.map((b) => `${b.cause} ${b.pct}%`).join(', '));
    expect(anomaly.detail).toContain('too_long 80%, unclassified 20%');
  });

  test('a degenerate NB_ERR_RATE=0 flags a zero-error command with the generic phrase, not an empty breakdown', () => {
    // NB_ERR_RATE=0 means "flag at any error rate", so a command with ZERO errors
    // trips the anomaly. There are no error rows to classify, so the detail falls
    // back to the generic phrase rather than a trailing "— " with nothing after.
    process.env.NB_ERR_MIN = '2';
    process.env.NB_ERR_RATE = '0';
    const now = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tp\tshow\tok\t1ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    const anomaly = rep.anomalies.find((a) => a.kind === 'high-error-rate' && a.command === 'show')!;
    expect(anomaly.detail).toContain('broken or not behaving as expected');
    expect(anomaly.detail).not.toMatch(/—\s*$/); // no dangling em-dash with an empty breakdown
  });
});

describe('rm', () => {
  test('removes an entry by substring', async () => {
    await addEntry(dir, 'd', 'keep me');
    await addEntry(dir, 'd', 'delete me');
    const r = await remove(dir, 'd', 'delete');
    expect(r.text).toBe('delete me');
    expect(readEntries(dir, 'd').map((e) => e.text)).toEqual(['keep me']);
  });

  test('removes an entry by its stable id', async () => {
    await addEntry(dir, 'd', 'keep this one');
    await addEntry(dir, 'd', 'drop this one');
    const r = await remove(dir, 'd', entryId('drop this one'));
    expect(r.text).toBe('drop this one');
    expect(readEntries(dir, 'd').map((e) => e.text)).toEqual(['keep this one']);
  });
});

describe('move (score-preserving cross-shelf move, issue #103)', () => {
  test('relocates an entry to another shelf with its score intact', async () => {
    await addEntry(dir, 'thin', 'use execFileSync with array args');
    await vote(dir, 'thin', 'execFileSync', 1);
    await vote(dir, 'thin', 'execFileSync', 1); // score +3 — hard-won vote capital
    const r = await move(dir, 'thin', 'broad', 'execFileSync');
    expect(r.reason).toBe('moved');
    expect(r.score).toBe(3); // carried over, NOT reset to the +1 add floor
    expect(r.fromSize).toBe(0);
    expect(r.toSize).toBe(1);
    expect(readEntries(dir, 'thin')).toHaveLength(0); // gone from the source
    const target = readEntries(dir, 'broad');
    expect(target).toEqual([{ score: 3, text: 'use execFileSync with array args' }]);
  });

  test('preserves the moved entry even when the target is full (admitted like a newcomer)', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'to', 'alpha'); // +1, oldest
    await addEntry(dir, 'to', 'bravo'); // +1
    await addEntry(dir, 'from', 'charlie');
    await vote(dir, 'from', 'charlie', 1);
    await vote(dir, 'from', 'charlie', 1); // charlie -> +3
    const r = await move(dir, 'from', 'to', 'charlie');
    expect(r.reason).toBe('moved');
    expect(r.score).toBe(3);
    const target = readEntries(dir, 'to');
    expect(target).toHaveLength(2); // still at cap
    const moved = target.find((e) => e.text === 'charlie');
    expect(moved?.score).toBe(3); // the moved lesson survived with its score intact
    expect(target.some((e) => e.text === 'alpha')).toBe(false); // the stalest/lowest was evicted
    expect(readEntries(dir, 'from')).toHaveLength(0); // and it left the source
    expect(r.evicted?.text).toBe('alpha');
  });

  test('refuses to move into the same shelf and writes nothing', async () => {
    await addEntry(dir, 's', 'only lesson');
    await expect(move(dir, 's', 's', 'only')).rejects.toThrow(/two different shelves/);
    expect(readEntries(dir, 's')).toHaveLength(1);
  });

  test('refuses a near-duplicate in the target, leaving both shelves untouched', async () => {
    await addEntry(dir, 'from', 'Prefer execFileSync, array args.');
    await vote(dir, 'from', 'execFileSync', 1); // source copy at +2
    await addEntry(dir, 'to', 'prefer execfilesync array args'); // dedup-equal in the target
    const r = await move(dir, 'from', 'to', 'execFileSync');
    expect(r.reason).toBe('duplicate');
    expect(r.collidedId).toBe(entryId('prefer execfilesync array args'));
    expect(readEntries(dir, 'from')).toHaveLength(1); // source still holds it (nothing discarded)
    expect(readEntries(dir, 'from')[0].score).toBe(2);
    expect(readEntries(dir, 'to')).toHaveLength(1); // target unchanged
  });

  test('refuses an ambiguous selector and moves nothing', async () => {
    await addEntry(dir, 'from', 'widget cache warm path');
    await addEntry(dir, 'from', 'widget cache cold path');
    await expect(move(dir, 'from', 'to', 'widget')).rejects.toThrow(/matches 2/);
    expect(readEntries(dir, 'from')).toHaveLength(2); // untouched
    expect(readEntries(dir, 'to')).toHaveLength(0); // nothing created
  });

  test('refuses a selector that matches nothing', async () => {
    await addEntry(dir, 'from', 'some lesson');
    await expect(move(dir, 'from', 'to', 'nonexistent')).rejects.toThrow(/no entry matches/);
    expect(readEntries(dir, 'from')).toHaveLength(1);
  });

  test('refuses to move from an empty / absent source shelf', async () => {
    await expect(move(dir, 'empty', 'to', 'anything')).rejects.toThrow(/is empty/);
    expect(existsSync(join(dir, 'to.md'))).toBe(false); // target never created
  });

  test('the moved entry lands at the fresh (recency) end of the target', async () => {
    await addEntry(dir, 'to', 'first');
    await addEntry(dir, 'to', 'second');
    await addEntry(dir, 'from', 'incoming');
    await move(dir, 'from', 'to', 'incoming');
    // Storage order is least-recently-touched first; a freshly moved entry is a
    // touch, so it must be last on disk.
    expect(readEntries(dir, 'to').map((e) => e.text)).toEqual(['first', 'second', 'incoming']);
  });

  test('round-trips the target notebook description (metadata preserved)', async () => {
    await setDescription(dir, 'to', 'broad lessons for this repo');
    await addEntry(dir, 'from', 'incoming lesson');
    await move(dir, 'from', 'to', 'incoming');
    expect(getDescription(dir, 'to')).toBe('broad lessons for this repo');
  });

  test('writes the TARGET first, so an interrupted SOURCE rewrite leaves a duplicate, never a lost lesson', async () => {
    // Crash-safety invariant (see notebook.ts move): the lesson is persisted in
    // the TARGET before it is dropped from the SOURCE. If the two writes were
    // reordered, an interruption between them would LOSE the lesson instead of
    // duplicating it. Pin the order by injecting a failure on the SECOND write
    // (the source rewrite) and proving the lesson survives in BOTH shelves.
    await addEntry(dir, 'from', 'crash-safety lesson');
    // A second lesson keeps the source non-empty so its rewrite (not a phantom
    // reap, issue #355) is what the injected rename failure interrupts.
    await addEntry(dir, 'from', 'unrelated bystander');
    await vote(dir, 'from', 'crash-safety', 1); // +2: prove score-bearing data, not just presence
    const fromFile = join(dir, 'from.md');
    const toFile = join(dir, 'to.md');
    fsHook.renames = []; // record write order via the atomic-rename seam (deterministic, no real crash)
    fsHook.failRenameTo = fromFile; // make ONLY the source rewrite's rename throw — the target write still commits
    try {
      // The source rewrite fails, so move rejects — but the target write already committed.
      await expect(move(dir, 'from', 'to', 'crash-safety')).rejects.toThrow(/injected rename failure/);
      // The target was written FIRST: its rename ran and committed before the source's.
      expect(fsHook.renames).toEqual([
        `${toFile}.${process.pid}.tmp`, // per-process shelf temp (issue #270)
        `${fromFile}.${process.pid}.tmp`,
      ]);
    } finally {
      fsHook.renames = null; // leave the shared hook as the other tests expect it
      fsHook.failRenameTo = null;
    }
    // Duplicate, not loss: the lesson is present in the target (first write) AND
    // still present in the source (its rewrite never committed) — both carry the
    // full +2 score. Had the writes been reordered, the source rewrite would have
    // failed FIRST and the target would be empty, so this pins the ordering.
    expect(readEntries(dir, 'to')).toEqual([{ score: 2, text: 'crash-safety lesson' }]);
    expect(readEntries(dir, 'from')).toContainEqual({ score: 2, text: 'crash-safety lesson' });
  });
});

describe('shelf safety', () => {
  test('rejects path-traversal and unsafe shelf names', () => {
    expect(() => assertSafeShelf('../etc/passwd')).toThrow();
    expect(() => assertSafeShelf('a/b')).toThrow();
    expect(() => assertSafeShelf('')).toThrow();
    expect(() => assertSafeShelf('patcher')).not.toThrow();
    expect(() => assertSafeShelf('cartographer@some-repo')).not.toThrow();
  });

  test('a `.`-namespaced shelf is first-class (issue #83): it validates and round-trips to one flat file', async () => {
    // The `.` namespace convention groups related notebooks lexically
    // (`review.tests`, `review.correctness`) with no change to `assertSafeShelf`:
    // `.` is already a permitted interior character, so a namespaced shelf is an
    // ordinary shelf, not a special case.
    expect(() => assertSafeShelf('review.tests')).not.toThrow();
    expect(() => assertSafeShelf('review.correctness')).not.toThrow();
    expect(() => assertSafeShelf('a.b.c')).not.toThrow(); // multi-level nesting is fine
    // `@` stays reserved for the existing `shelf@project` scoping and is distinct
    // from the `.` grouping delimiter — the two can coexist in one name.
    expect(() => assertSafeShelf('review.tests@some-repo')).not.toThrow();
    // Still no storage layout change: the namespace lives entirely in the name,
    // so the notebook is a single flat `<shelf>.md` file (no directories).
    await addEntry(dir, 'review.tests', 'a namespaced lesson');
    expect(existsSync(join(dir, 'review.tests.md'))).toBe(true);
    expect(readEntries(dir, 'review.tests').map((e) => e.text)).toEqual(['a namespaced lesson']);
    // The boundary cases the pattern still rejects: a name cannot begin or end
    // with the `.` delimiter, and `..` is barred (path-traversal guard).
    expect(() => assertSafeShelf('.review')).toThrow();
    expect(() => assertSafeShelf('review.')).toThrow();
    expect(() => assertSafeShelf('review..tests')).toThrow();
  });

  test('bounds shelf-name length with a friendly error before it becomes a filename', () => {
    // A 300-char alphanumeric name passes the character pattern but would hit
    // ENAMETOOLONG as `<shelf>.md`; it must throw the friendly length error.
    // `129` passes the character pattern, so only the length guard can reject
    // it — asserting the distinct `too long` diagnostic pins which guard fired.
    expect(() => assertSafeShelf('a'.repeat(300))).toThrow(/invalid shelf name: .* \(too long: 300 chars, max 128\)/);
    // The boundary: 128 chars is allowed, 129 is not.
    expect(() => assertSafeShelf('a'.repeat(128))).not.toThrow();
    expect(() => assertSafeShelf('a'.repeat(129))).toThrow(/too long: 129 chars, max 128/);
    // A realistic long shelf stays legal.
    expect(() => assertSafeShelf('code-review@jeanibarz-agent-notebook')).not.toThrow();
  });

  test('an over-long shelf is rejected by a runtime write before any file is created', async () => {
    // The acceptance criterion is end-to-end: driving an over-long shelf through
    // a real entry point must surface the friendly error instead of a bare
    // `ENAMETOOLONG`, and must not leave a `<shelf>.md` behind.
    const tooLong = 'a'.repeat(300);
    await expect(addEntry(dir, tooLong, 'x')).rejects.toThrow(/invalid shelf name/);
    expect(existsSync(join(dir, `${tooLong}.md`))).toBe(false);
  });

  test('`README` is a reserved shelf name (issue #90): a write command cannot target it', async () => {
    // A `README.md` is the conventional git/backup artifact in a notebook folder,
    // not a notebook — so a write command must never create or rewrite one. The
    // reserve is case-insensitive, matching the `README.md` the filesystem holds.
    expect(() => assertSafeShelf('README')).toThrow(/reserved: a README\.md is not a notebook/);
    expect(() => assertSafeShelf('readme')).toThrow(/reserved/);
    expect(() => assertSafeShelf('ReadMe')).toThrow(/reserved/);
    // The reserve blocks a real write (`nb add README …`) before any file touch.
    await expect(addEntry(dir, 'README', 'x')).rejects.toThrow(/reserved/);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
    // A shelf that merely contains "readme" is still a legitimate notebook.
    expect(() => assertSafeShelf('readme-notes')).not.toThrow();
  });

  test('rejects Windows reserved device names (issue #205): a silent data sink on Windows', async () => {
    // On Windows `CON, PRN, AUX, NUL, COM1-9, LPT1-9` are devices, not files —
    // case-insensitively and even with an extension, so `nul.md` resolves to the
    // NUL device. A shelf stored as `<shelf>.md` named `nul` would make `nb add`
    // write to the null device: the write "succeeds" but the lesson is discarded.
    // Reserve them like `readme` so the failure is a clear error on every platform.
    for (const name of ['nul', 'con', 'prn', 'aux', 'com1', 'com9', 'lpt1', 'lpt9']) {
      expect(() => assertSafeShelf(name)).toThrow(/reserved: a Windows device name/);
    }
    // The reserve is case-insensitive (the device resolves regardless of case).
    expect(() => assertSafeShelf('NUL')).toThrow(/reserved: a Windows device name/);
    expect(() => assertSafeShelf('Com1')).toThrow(/reserved: a Windows device name/);
    // An extension does not rescue it: Windows resolves the device from the segment
    // before the first `.`, so `nul.notes` → `nul.notes.md` → the NUL device too.
    expect(() => assertSafeShelf('nul.notes')).toThrow(/reserved: a Windows device name/);
    expect(() => assertSafeShelf('con.v2')).toThrow(/reserved: a Windows device name/);
    // The rejection is a classified `bad_args` NbError (a user input error), like
    // the other shelf-name guards — not an uncaught internal fault.
    expect(() => assertSafeShelf('nul')).toThrow(expect.objectContaining({ errorClass: 'bad_args' }));
    // The reserve blocks a real write before any file is touched.
    await expect(addEntry(dir, 'nul', 'a lesson')).rejects.toThrow(/reserved: a Windows device name/);
    expect(existsSync(join(dir, 'nul.md'))).toBe(false);

    // A name that merely CONTAINS a reserved device substring is a legitimate
    // notebook — the match is anchored to the WHOLE pre-extension segment, both
    // ends. Suffix matches (`icon`, `bacon`, `mycom1` end in a device name) pin the
    // leading `^`; prefix/substring matches (`console`, `com10`) pin the trailing
    // `$`. These must all stay valid (acceptance criterion).
    for (const name of [
      'console', 'aux-notes', 'communication', 'content', 'com10', 'lpt10', 'nullable', 'conference',
      'icon', 'bacon', 'mycom1',
    ]) {
      expect(() => assertSafeShelf(name)).not.toThrow();
    }
    // Boundary: only COM1-9 / LPT1-9 are reserved — COM0 and LPT0 are NOT Windows
    // devices, so they stay valid and pin the `[1-9]` (not `[0-9]`) digit class.
    expect(() => assertSafeShelf('com0')).not.toThrow();
    expect(() => assertSafeShelf('lpt0')).not.toThrow();
    // A reserved device name only in an interior segment is not reserved (Windows
    // resolves the device from the leading segment only), so `review.con` is fine.
    expect(() => assertSafeShelf('review.con')).not.toThrow();
  });
});

describe('NB_DIR leading-tilde expansion (issue #334)', () => {
  // A process env from Claude Code `settings.json`, systemd, cron or a `.env`
  // file never passes through a shell, so `NB_DIR=~/x` used to be taken
  // verbatim and wrote a literal `~` directory under the CWD. `notebooksDir()`
  // now expands a LEADING `~` itself; every other form is left untouched.
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.NB_DIR;
  });

  test('a bare `~` resolves to the home directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-notebook-home-'));
    try {
      process.env.HOME = home;
      expect(expandHomeDir('~')).toBe(home);
      expect(notebooksDir()).not.toBe(home); // NB_DIR unset → default
      process.env.NB_DIR = '~';
      expect(notebooksDir()).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('`~/x` and `~/` resolve under the home directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-notebook-home-'));
    try {
      process.env.HOME = home;
      expect(expandHomeDir('~/x')).toBe(join(home, 'x'));
      expect(expandHomeDir('~/a/b')).toBe(join(home, 'a', 'b'));
      expect(expandHomeDir('~/')).toBe(join(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('`~user/x`, absolute and relative paths are unchanged', () => {
    expect(expandHomeDir('~user/x')).toBe('~user/x');
    expect(expandHomeDir('/abs/x')).toBe('/abs/x');
    expect(expandHomeDir('rel/x')).toBe('rel/x');
    expect(expandHomeDir('x~y')).toBe('x~y'); // an interior tilde is not a home prefix
    // `nb` must never silently rewrite a relative value; it is used as-is.
    process.env.NB_DIR = '~user/x';
    expect(notebooksDir()).toBe('~user/x');
    process.env.NB_DIR = '/abs/x';
    expect(notebooksDir()).toBe('/abs/x');
  });

  test('a leading `~` reaches addEntry through notebooksDir (no literal ./~ dir)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-notebook-home-'));
    const literal = join(process.cwd(), '~'); // where an unexpanded `~/nb334` would land
    expect(existsSync(literal)).toBe(false); // precondition: nothing stray from an earlier run
    try {
      process.env.HOME = home;
      process.env.NB_DIR = '~/nb334';
      const target = notebooksDir();
      expect(target).toBe(join(home, 'nb334'));
      await addEntry(target, 's', 'tilde test lesson');
      expect(existsSync(join(target, 's.md'))).toBe(true);
      expect(existsSync(literal)).toBe(false); // no literal ~ dir in the cwd
    } finally {
      rmSync(literal, { recursive: true, force: true }); // only reached with content if the fix regresses
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('listShelves', () => {
  test('excludes a README.md so it is not a notebook (issue #90)', () => {
    // A README that backs up the notebook folder (common when the dir is a git
    // repo) must not surface as a shelf — not listed, searched, counted or voted.
    writeFileSync(join(dir, 'README.md'), '# notes\n\nThis folder is backed up with git.\n', 'utf-8');
    writeFileSync(join(dir, 'tips.md'), '+1\trun lint before claiming done\n', 'utf-8');
    expect(listShelves(dir)).toEqual(['tips']);
  });

  test('excludes README.md case-insensitively', () => {
    // On a case-insensitive filesystem (macOS, per the report) the file may be
    // `readme.md`; the exclusion matches regardless of case.
    writeFileSync(join(dir, 'readme.md'), 'lower-case readme\n', 'utf-8');
    writeFileSync(join(dir, 'Readme.md'), 'mixed-case readme\n', 'utf-8');
    writeFileSync(join(dir, 'reviewer.md'), '+1\treal notebook\n', 'utf-8');
    expect(listShelves(dir)).toEqual(['reviewer']);
  });

  describe('only a missing directory is an empty store (issue #383)', () => {
    test('a missing directory yields [] (a clean machine)', () => {
      expect(listShelves(join(dir, 'does-not-exist'))).toEqual([]);
    });

    test('an empty readable directory yields []', () => {
      expect(listShelves(dir)).toEqual([]);
    });

    test('a regular file where the directory should be throws ENOTDIR, naming the path', () => {
      const file = join(dir, 'not-a-dir');
      writeFileSync(file, 'x', 'utf-8');
      let caught: unknown;
      try {
        listShelves(file);
      } catch (e) {
        caught = e;
      }
      expect((caught as NodeJS.ErrnoException).code).toBe('ENOTDIR');
      expect((caught as Error).message).toBe(`cannot read notebooks directory ${JSON.stringify(file)} (ENOTDIR)`);
    });

    test.each(['EACCES', 'EIO'])('a %s listing failure throws with that code instead of returning []', (code) => {
      writeFileSync(join(dir, 'tips.md'), '+1\ta lesson\n', 'utf-8');
      fsHook.failReaddirCode = code;
      expect(() => listShelves(dir)).toThrow(expect.objectContaining({ code, message: expect.stringContaining(`(${code})`) }));
    });

    test('a codeless throw propagates unchanged, not relabeled as a filesystem error', () => {
      fsHook.failReaddirCode = '';
      expect(() => listShelves(dir)).toThrow(TypeError);
      expect(() => listShelves(dir)).toThrow('simulated bug in readdir (no errno)');
    });
  });
});

describe('usage log + stats', () => {
  test('logUsage appends and stats rolls up per command', () => {
    logUsage(dir, 'p', 'add', true, 5);
    logUsage(dir, 'p', 'add', true, 7);
    logUsage(dir, 'p', 'vote', false, 3);
    const rep = stats(dir, { now: Date.now() });
    expect(rep.totalCalls).toBe(3);
    const add = rep.perCommand.find((c) => c.command === 'add')!;
    expect(add.calls).toBe(2);
    const voteStat = rep.perCommand.find((c) => c.command === 'vote')!;
    expect(voteStat.errors).toBe(1);
    expect(voteStat.errorRate).toBe(1);
  });

  test('a tab/CR/LF in a field cannot split the row (rejected-unsafe-shelf regression)', () => {
    // The CLI logs in a `finally` block even when `add` rejected an unsafe shelf,
    // so a raw tab/newline in the shelf once became extra columns/rows and
    // mis-attributed the telemetry. Each field must stay structurally inert.
    const nasty = 'evil\trole\ndrop\rtable';
    logUsage(dir, nasty, 'add\tcmd', false, 4);
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    const rows = raw.split('\n').filter((l) => l !== '');
    expect(rows.length).toBe(1); // the CR/LF did not spawn extra rows
    const cols = rows[0].split('\t');
    expect(cols.length).toBe(16); // five base + five richer + two reason columns + errorClass + decayed + recovered + misses, all tabs collapsed
    expect(cols[1]).toBe('-'); // shelf: not a valid name (issue #375), so never logged raw
    // stats still parses it as one call attributed to the sanitized command.
    const rep = stats(dir, { now: Date.now() });
    expect(rep.totalCalls).toBe(1);
    expect(rep.perCommand.map((c) => c.command)).toEqual(['add cmd']);
  });

  test('a well-formed row is written unchanged (sanitizing is a no-op)', () => {
    // Guards against the sanitizer altering normal rows: only tab/CR/LF change.
    logUsage(dir, 'patcher', 'add', true, 5);
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const [ts, shelf, command, status, ms] = raw.trimEnd().split('\t');
    expect([shelf, command, status, ms]).toEqual(['patcher', 'add', 'ok', '5ms']);
    expect(Number.isNaN(Date.parse(ts))).toBe(false); // ts untouched, still ISO
  });

  test('caps an over-long NB_SESSION to maxChars, same as the note (issue #202)', () => {
    // `session` is caller-influenced free text (a harness sets NB_SESSION), so an
    // over-long value must be truncated like `note` — otherwise it is appended to
    // EVERY row and the ring's row-count bound stops bounding its bytes (#128).
    const long = 's'.repeat(maxChars() + 50);
    logUsage(dir, 'p', 'show', true, 1, { session: long });
    const cols = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').trimEnd().split('\t');
    expect(cols[5].length).toBe(maxChars()); // column 5 is `session`
    expect(cols[5].endsWith('…')).toBe(true); // same ellipsis convention as the note
  });

  test('a short NB_SESSION round-trips byte-identical (issue #202)', () => {
    logUsage(dir, 'p', 'show', true, 1, { session: 'task-42' });
    const cols = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').trimEnd().split('\t');
    expect(cols[5]).toBe('task-42'); // a sub-cap value is untouched
  });

  test('logs an invalid shelf operand as "-" and a valid (even mistyped) name verbatim (issue #375)', () => {
    logUsage(dir, 'this is a lesson I typed but forgot the shelf name', 'add', false, 1);
    logUsage(dir, 'patchr', 'show', true, 1);
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    const rows = raw.trimEnd().split('\n').map((l) => l.split('\t'));
    expect(rows[0][1]).toBe('-');
    expect(rows[1][1]).toBe('patchr');
    expect(raw).not.toContain('forgot the shelf');
  });

  test('caps an over-long command and an over-long shelf operand (issue #375)', () => {
    logUsage(dir, 'p', 'c'.repeat(100_000), false, 1);
    logUsage(dir, 'x'.repeat(100_000), 'show', false, 1);
    const rows = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').trimEnd().split('\n').map((l) => l.split('\t'));
    expect(rows[0][2].length).toBe(maxChars());
    expect(rows[1][1]).toBe('-'); // over MAX_SHELF_LEN is not a valid name
  });

  test('strips control characters from every column of a newly written row (issue #375)', () => {
    logUsage(dir, 'p', 'bad\x1b[5mcmd', false, 1, { session: '\x1b[31mRED\x1b]0;pwn\x07', note: 'n\x1bote' });
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0e-\x1f\x7f-\x9f]/.test(raw)).toBe(false);
    expect(raw).toContain('bad[5mcmd');
  });

  test('a pathological session never makes logUsage throw (issue #202)', () => {
    // Logging is best-effort; truncating must not change its never-throw contract.
    expect(() => logUsage(dir, 'p', 'show', true, 1, { session: 'z'.repeat(100_000) })).not.toThrow();
  });

  test('reports usage-ring occupancy (rows/cap), total and window-independent (issue #206)', () => {
    process.env.NB_USAGE_RING = '5000';
    for (let i = 0; i < 5; i++) logUsage(dir, 'p', 'show', true, 1);
    const wide = stats(dir, { now: Date.now() });
    expect(wide.usageRing).toEqual({ rows: 5, cap: 5000 });
    // Occupancy is TOTAL (not windowed): a window that excludes every row still
    // reports the same 5 rows on disk, so it can't be confused with `totalCalls`.
    const narrow = stats(dir, { now: Date.now() + 10_000_000, windowMs: 1 });
    expect(narrow.totalCalls).toBe(0);
    expect(narrow.usageRing).toEqual({ rows: 5, cap: 5000 });
  });

  test('flags a full ring whose oldest row is newer than the window start (issue #406)', () => {
    process.env.NB_USAGE_RING = '100';
    const now = Date.now();
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`${new Date(now - 2 * 86_400_000 + i * 1000).toISOString()}\ts\tshow\tok\t1`);
    }
    writeFileSync(join(dir, '.nb-usage.log'), lines.join('\n') + '\n');
    const wide = stats(dir, { now, windowMs: 30 * 86_400_000 });
    expect(wide.usageRing).toEqual({
      rows: 100,
      cap: 100,
      oldest: new Date(now - 2 * 86_400_000).toISOString(),
      coversWindow: false,
    });
    // Window inside the retained span: exactly today's shape.
    expect(stats(dir, { now, windowMs: 86_400_000 }).usageRing).toEqual({ rows: 100, cap: 100 });
    // Below capacity: never flagged, even though the window outruns the log.
    process.env.NB_USAGE_RING = '200';
    expect(stats(dir, { now, windowMs: 30 * 86_400_000 }).usageRing).toEqual({ rows: 100, cap: 200 });
  });

  test('usage-ring cap tracks NB_USAGE_RING (issue #206)', () => {
    process.env.NB_USAGE_RING = '100';
    logUsage(dir, 'p', 'show', true, 1);
    expect(stats(dir, { now: Date.now() }).usageRing.cap).toBe(100);
  });

  test('usage log is a bounded ring: a compaction keeps exactly the newest usageRing() rows (issue #135)', () => {
    process.env.NB_USAGE_RING = '100';
    const ring = usageRing(); // 100
    const compactAt = ring + usageRingSlack(); // appends grow the file this far, then one call compacts it
    // Tag each row so we can prove WHICH rows survived. The fast path appends
    // cheaply until the file crosses `compactAt`; that call reads+slices the
    // whole file back down to exactly `ring` newest rows (the rare compaction).
    for (let i = 0; i < compactAt + 1; i++) logUsage(dir, 'p', `c${i}`, true, 1);
    const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
    const cmds = lines.map((l) => l.split('\t')[2]);
    expect(lines.length).toBe(ring); // exactly the cap after overflow — oldest dropped
    expect(cmds[cmds.length - 1]).toBe(`c${compactAt}`); // the newest row is retained…
    expect(cmds[0]).toBe(`c${compactAt + 1 - ring}`); // …and exactly `ring` rows back is the oldest kept
    expect(cmds).not.toContain('c0'); // the very first row was dropped
  });

  test('the append fast-path does not read or parse the whole ring (issue #135)', () => {
    process.env.NB_USAGE_RING = '100';
    const usage = join(dir, '.nb-usage.log');
    const sidecar = join(dir, '.nb-usage.log.count');
    for (let i = 0; i < 50; i++) logUsage(dir, 'p', 'show', true, 1); // fill the ring toward its cap
    fsHook.reads = []; // capture every readFileSync path during the next append
    let reads: string[];
    try {
      logUsage(dir, 'p', 'vote', true, 2); // one more plain under-cap append
    } finally {
      reads = fsHook.reads!;
      fsHook.reads = null;
    }
    expect(reads).not.toContain(usage); // the ring file itself is never read on the hot path…
    expect(reads.every((p) => p === sidecar)).toBe(true); // …only the tiny O(1) sidecar counter is.
    // And the append landed as one more whole row (the rewrite path was not taken).
    const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(51);
  });

  test('a stale sidecar cannot break the hard ring bound — small rows, default ring, one call (issue #135)', () => {
    // No NB_USAGE_RING override: exercise the real default cap (5000). The log
    // already holds far more than the ring, in SMALL rows whose total bytes a
    // byte-only ceiling would miss. The sidecar is stale: it records a tiny,
    // long-gone state, so its byte size no longer matches the grown file.
    const ring = usageRing(); // 5000
    const usage = join(dir, '.nb-usage.log');
    const sidecar = join(dir, '.nb-usage.log.count');
    const rows = Array.from({ length: ring + 2000 }, (_, i) => `${new Date().toISOString()}\tp\tc${i}\tok\t1ms\t\t\t\t\t\t\t`);
    writeFileSync(usage, rows.join('\n') + '\n', 'utf-8');
    writeFileSync(sidecar, '3\t200\n', 'utf-8'); // stale rows AND stale bytes — size no longer matches
    logUsage(dir, 'p', 'heal', true, 1);
    const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(ring); // bound restored in a single call, despite the stale sidecar
    expect(lines[lines.length - 1].split('\t')[2]).toBe('heal'); // the new row is the newest kept
  });

  test('a torn (newline-less) row with a still-valid sidecar is not glued — the size mismatch forces the guarded path (issue #135)', () => {
    process.env.NB_USAGE_RING = '100';
    const usage = join(dir, '.nb-usage.log');
    logUsage(dir, 'p', 'add', true, 1); // establishes the log and a matching sidecar
    // Simulate an ENOSPC/crash that left the last row without its trailing `\n`
    // but did NOT update the sidecar (so its row count still looks valid). The
    // byte size changes, which is what the fast path uses to distrust the count.
    writeFileSync(usage, readFileSync(usage, 'utf-8').replace(/\n$/, ''), 'utf-8');
    logUsage(dir, 'p', 'vote', true, 2); // the next append must start a fresh row, not glue
    const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(2); // two whole rows, not one glued row
    expect(parseUsage(dir)).toHaveLength(2);
    expect(parseUsage(dir).every((r) => r.command.length > 0)).toBe(true);
  });

  test('flags a loop anomaly (many calls in a tight window)', () => {
    process.env.NB_LOOP_N = '5';
    process.env.NB_LOOP_WINDOW_S = '60';
    const base = Date.parse('2026-10-23T10:00:00Z');
    const rows = Array.from({ length: 6 }, (_, i) =>
      `${new Date(base + i * 5000).toISOString()}\tpatcher\tadd\tok\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now: base + 60_000 });
    expect(rep.anomalies.some((a) => a.kind === 'loop' && a.command === 'add')).toBe(true);
  });

  describe('session-aware loop key and typo-proof went-silent (issue #372)', () => {
    const base = Date.parse('2026-10-23T10:00:00Z');
    // ts shelf command status ms session
    const row = (i: number, session: string): string =>
      `${new Date(base + i * 5000).toISOString()}\tp\tlist\tok\t2ms\t${session}`;
    const loops = (rows: string[]) => {
      process.env.NB_LOOP_N = '10';
      process.env.NB_LOOP_WINDOW_S = '120';
      writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
      return stats(dir, { now: base + 120_000 }).anomalies.filter((a) => a.kind === 'loop');
    };

    test('ten calls from ten different sessions are not a loop', () => {
      expect(loops(Array.from({ length: 10 }, (_, i) => row(i, `agent-${i + 1}`)))).toEqual([]);
    });

    test('ten calls from one session still are', () => {
      expect(loops(Array.from({ length: 10 }, (_, i) => row(i, 'agent-1')))).toHaveLength(1);
    });

    test('blank-session rows behave as before', () => {
      expect(loops(Array.from({ length: 10 }, (_, i) => row(i, '')))).toHaveLength(1);
    });

    const silent = (lines: string[]) => {
      const now = Date.parse('2026-10-23T10:00:00Z');
      writeFileSync(join(dir, '.nb-usage.log'), lines.join('\n') + '\n', 'utf-8');
      return stats(dir, { now, windowMs: 48 * 3600_000 }).anomalies.filter(
        (a) => a.kind === 'went-silent',
      );
    };
    const oldTs = new Date(Date.parse('2026-10-23T10:00:00Z') - 216 * 3600_000).toISOString();
    // ts shelf command status ms session entries outcome collided evicted reason note errorClass
    const typo = `${oldTs}\tp\tupvote\tfail\t1ms\t\t\t\t\t\t\t\tunknown_subcommand`;

    test('a mistyped command seen only as unknown_subcommand is never went-silent', () => {
      expect(silent([typo])).toEqual([]);
    });

    test('a real command with history that stops is still went-silent', () => {
      const real = `${oldTs}\tp\tmerge\tok\t4ms`;
      const found = silent([typo, real]);
      expect(found.map((a) => a.command)).toEqual(['merge']);
    });
  });

  test('a retrospective vote-sweep across DISTINCT entries is not flagged as a loop', () => {
    // A retro rapidly votes many different lessons in one session. That is the
    // designed behavior, not a stuck agent — the loop key includes the entry, so
    // distinct targets do not collapse into one hot key.
    process.env.NB_LOOP_N = '5';
    process.env.NB_LOOP_WINDOW_S = '60';
    const base = Date.parse('2026-10-23T10:00:00Z');
    const rows = Array.from(
      { length: 6 },
      (_, i) => `${new Date(base + i * 2000).toISOString()}\tpatcher\tvote\tok\t2ms\tretro1\te${i}\tup`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now: base + 60_000 });
    expect(rep.anomalies.some((a) => a.kind === 'loop')).toBe(false);
  });

  test('hammering the SAME entry still flags a loop (detection survives the entry-keying)', () => {
    process.env.NB_LOOP_N = '5';
    process.env.NB_LOOP_WINDOW_S = '60';
    const base = Date.parse('2026-10-23T10:00:00Z');
    const rows = Array.from(
      { length: 6 },
      (_, i) => `${new Date(base + i * 2000).toISOString()}\tpatcher\tvote\tok\t2ms\tretro1\tsame\tup`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now: base + 60_000 });
    expect(rep.anomalies.some((a) => a.kind === 'loop' && a.command === 'vote')).toBe(true);
  });

  test('search rows still trip the loop even with DISTINCT surfaced ids (issue #114 regression)', () => {
    // Since #114 a `search` row carries the ids it surfaced, so varying-query
    // searches have DISTINCT `entries`. The loop detector must keep treating a
    // search as entry-less (group by shelf+command) so a stuck agent hammering
    // `search` with different queries is still flagged — exactly as before #114.
    process.env.NB_LOOP_N = '5';
    process.env.NB_LOOP_WINDOW_S = '60';
    const base = Date.parse('2026-10-23T10:00:00Z');
    const rows = Array.from(
      { length: 6 },
      // shelf `-`, distinct entries (id0,id1,…) AND distinct queries per row.
      (_, i) => `${new Date(base + i * 2000).toISOString()}\t-\tsearch\tok\t1ms\ts1\tid${i}\tmatch\t\t\t\tquery${i}`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now: base + 60_000 });
    expect(rep.anomalies.some((a) => a.kind === 'loop' && a.command === 'search')).toBe(true);
  });

  test('flags a went-silent anomaly (used historically, silent recently)', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const old = new Date(now - 100 * 3600_000).toISOString(); // 100h ago
    writeFileSync(join(dir, '.nb-usage.log'), `${old}\tp\tmerge\tok\t4ms\n`, 'utf-8');
    const rep = stats(dir, { now, windowMs: 48 * 3600_000 }); // merge not in window
    expect(rep.anomalies.some((a) => a.kind === 'went-silent' && a.command === 'merge')).toBe(true);
  });

  test('flags a high-error-rate anomaly', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = '0.5';
    const now = Date.now();
    const rows: string[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(`${new Date(now - i * 1000).toISOString()}\tp\tvote\t${i < 4 ? 'err' : 'ok'}\t2ms`);
    }
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    expect(rep.anomalies.some((a) => a.kind === 'high-error-rate' && a.command === 'vote')).toBe(true);
  });

  test('no anomalies on quiet, healthy usage', () => {
    logUsage(dir, 'p', 'show', true, 1);
    logUsage(dir, 'p', 'add', true, 2);
    const rep = stats(dir, { now: Date.now() });
    expect(rep.anomalies).toHaveLength(0);
  });

  test('stamps the report with schemaVersion = STATS_SCHEMA_VERSION (issue #172)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const rep = stats(dir, { now: Date.now() });
    // present, an integer, and currently pinned to 1 — a consumer reads this to
    // detect a breaking wire-format change.
    expect(rep.schemaVersion).toBe(STATS_SCHEMA_VERSION);
    expect(rep.schemaVersion).toBe(1);
    expect(Number.isInteger(rep.schemaVersion)).toBe(true);
  });

  test('StatsReport top-level shape is frozen — a new field forces a conscious schemaVersion bump (issue #172)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const rep = stats(dir, { now: Date.now() });
    // Golden shape: the exact set of top-level keys the --json contract emits.
    // Adding/removing/renaming a field makes this fail on purpose — when you do,
    // update this list AND decide whether STATS_SCHEMA_VERSION must bump (any
    // rename/removal/type change is breaking; a purely additive field is not).
    expect(Object.keys(rep).sort()).toEqual(
      [
        'activity',
        'anomalies',
        'crashRecovery',
        'errorCauses',
        'generatedAt',
        'notebookTotals',
        'notebooks',
        'perCommand',
        'conflicts',
        'schemaVersion',
        'signals',
        'skipped',
        'surfacing',
        'totalCalls',
        'usageRing',
        'window',
        'windowStart',
      ].sort(),
    );
  });

  test('labels a sub-hour window in minutes (not rounded to 1h)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const rep = stats(dir, { now: Date.now(), windowMs: 30 * 60_000 });
    expect(rep.window).toBe('30m');
  });

  test('exposes absolute window bounds generatedAt/windowStart as ISO-8601 (issue #132)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const now = Date.parse('2026-10-31T12:00:00Z');
    const windowMs = 7 * 86_400_000;
    const rep = stats(dir, { now, windowMs });
    // valid ISO-8601 instants that round-trip to the sampled values
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
    expect(rep.generatedAt).toMatch(ISO);
    expect(rep.windowStart).toMatch(ISO);
    expect(Date.parse(rep.generatedAt)).toBe(now);
    expect(Date.parse(rep.windowStart)).toBe(now - windowMs);
    // generatedAt - windowStart equals the window duration, and windowStart precedes generatedAt
    expect(Date.parse(rep.generatedAt) - Date.parse(rep.windowStart)).toBe(windowMs);
    expect(Date.parse(rep.windowStart)).toBeLessThan(Date.parse(rep.generatedAt));
  });

  test('stats exposes an ops-per-day activity array summing to totalCalls (issue #106)', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const DAY = 86_400_000;
    // oldest-first target over a 7d window: [1,0,3,8,5,2,0].
    const plan = [1, 0, 3, 8, 5, 2, 0]; // index 0 = oldest 24h bucket
    const rows: string[] = [];
    for (let idx = 0; idx < plan.length; idx++) {
      const fromRight = plan.length - 1 - idx; // 6..0
      for (let k = 0; k < plan[idx]; k++) {
        // place squarely inside the bucket (+0.5 day) so it cannot drift to a neighbour
        rows.push(`${new Date(now - (fromRight + 0.5) * DAY).toISOString()}\tmyshelf\tshow\tok\t3ms\ts1`);
      }
    }
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now, windowMs: 7 * DAY });
    expect(rep.activity).toEqual([1, 0, 3, 8, 5, 2, 0]);
    expect(rep.activity.reduce((a, b) => a + b, 0)).toBe(rep.totalCalls);
    expect(rep.totalCalls).toBe(19);
  });

  test('stats activity is scoped to the requested shelf, not deployment-wide (issue #106)', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const DAY = 86_400_000;
    const rows = [
      // shelf 'a': 2 rows in the newest bucket
      `${new Date(now - 0.5 * DAY).toISOString()}\ta\tshow\tok\t3ms\ts1`,
      `${new Date(now - 0.5 * DAY).toISOString()}\ta\tshow\tok\t3ms\ts1`,
      // shelf 'b': 3 rows (must be excluded when scoped to 'a')
      `${new Date(now - 0.5 * DAY).toISOString()}\tb\tshow\tok\t3ms\ts1`,
      `${new Date(now - 2.5 * DAY).toISOString()}\tb\tshow\tok\t3ms\ts1`,
      `${new Date(now - 2.5 * DAY).toISOString()}\tb\tshow\tok\t3ms\ts1`,
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now, windowMs: 7 * DAY, shelf: 'a' });
    expect(rep.activity).toEqual([0, 0, 0, 0, 0, 0, 2]); // only shelf 'a', newest bucket
    expect(rep.totalCalls).toBe(2);
  });

  test('stats activity has one bucket for a sub-day window and renders empty windows as all-zero (issue #106)', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    // single-day (12h) window → exactly one bucket
    logUsage(dir, 'p', 'show', true, 1);
    const one = stats(dir, { now: Date.now(), windowMs: 12 * 3600_000 });
    expect(one.activity).toHaveLength(1);
    // empty 7d window → seven zero buckets, no crash
    const empty = stats(dir, { now, windowMs: 7 * 86_400_000, shelf: 'nope' });
    expect(empty.activity).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test('a malformed NB_ERR_RATE falls back to the default, not NaN (which would disable detection)', () => {
    process.env.NB_ERR_MIN = '4';
    process.env.NB_ERR_RATE = 'abc';
    const now = Date.now();
    const rows: string[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(`${new Date(now - i * 1000).toISOString()}\tp\tvote\t${i < 4 ? 'err' : 'ok'}\t2ms`);
    }
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const rep = stats(dir, { now });
    expect(rep.anomalies.some((a) => a.kind === 'high-error-rate')).toBe(true);
  });

  test('three appends under cap produce three rows without a compact (issue #45)', () => {
    // The hot path: while the log is under the ring, each call appends its one
    // row in place — it must NOT read-slice-rewrite the whole file (no rename).
    fsHook.renames = []; // capture any atomic-rename temp source
    try {
      logUsage(dir, 'p', 'add', true, 5);
      logUsage(dir, 'p', 'vote', true, 7);
      logUsage(dir, 'p', 'show', false, 3);
      const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
      expect(lines.length).toBe(3); // three distinct rows
      expect(fsHook.renames).toEqual([]); // append-only: not a single compact/rewrite happened
      // Each row is whole and parseable (the append never glued two together).
      const rep = stats(dir, { now: Date.now() });
      expect(rep.totalCalls).toBe(3);
    } finally {
      fsHook.renames = null; // leave the shared hook as the other tests expect it
    }
  });

  test('an append after a crash-truncated row (no trailing newline) does not glue rows (issue #45)', () => {
    // A previous writer crashed mid-row, leaving a line without its final `\n`.
    // The next append must start a fresh row, not concatenate onto the partial.
    const usage = join(dir, '.nb-usage.log');
    writeFileSync(usage, `${new Date().toISOString()}\tp\tadd\tok\t2ms`, 'utf-8'); // NO trailing newline
    logUsage(dir, 'p', 'vote', true, 3);
    const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(2); // two separate rows, not one glued row
    // The pre-existing row is an old five-column one; the fresh append is a
    // ten-column one. Both must parse — proving the append started a clean row
    // and parseUsage tolerates the short legacy row.
    expect(parseUsage(dir)).toHaveLength(2);
    expect(parseUsage(dir).every((r) => r.command.length > 0)).toBe(true);
  });

  test('logUsage compacts through a PER-PROCESS-unique temp path before the atomic rename (issue #32)', () => {
    // The compact path (over-cap) is pinned deterministically: logUsage runs
    // OUTSIDE the .nb.lock spinlock (the CLI calls it from `finally`), so two
    // concurrent nb processes must not share one temp path or one's rename can
    // clobber the other mid-write. The temp source of the atomic rename must
    // carry this process's pid — a revert to the old shared `${file}.tmp` fails.
    process.env.NB_USAGE_RING = '100'; // the clamp floor; fill past the slack, then force one compact
    for (let i = 0; i < 100 + usageRingSlack(); i++) logUsage(dir, 'p', 'show', true, 1); // appends (no rename yet)
    fsHook.renames = []; // opt in to capturing rename source paths
    try {
      logUsage(dir, 'p', 'show', true, 1); // over cap -> compacts via temp+rename
      const usage = join(dir, '.nb-usage.log');
      expect(fsHook.renames).toEqual([`${usage}.${process.pid}.tmp`]);
    } finally {
      fsHook.renames = null; // leave the shared hook as the other tests expect it
    }
  });

  test('logUsage never throws and writes nothing when the log cannot be written (best-effort contract)', () => {
    // Point logUsage at a path that is a FILE, not a directory, so its internal
    // mkdir/write fail. Monitoring is best-effort: it must swallow the failure
    // (never fail a real operation) and leave no usage log behind.
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf-8');
    expect(() => logUsage(asFile, 'p', 'show', true, 1)).not.toThrow();
    expect(existsSync(join(asFile, '.nb-usage.log'))).toBe(false);
  });

  test('cross-process: overlapping usage-log writers leave a parseable file and no stray temp (issue #32) [timing]', async () => {
    // The acceptance scenario, with real OS processes (distinct pids): logUsage
    // runs unlocked, so concurrent `nb` invocations write the usage log at once.
    // A per-process temp keeps each rename atomic — the final file is always one
    // writer's complete content, and every writer's temp is consumed by its own
    // rename (no shared `.nb-usage.log.tmp` left dangling). `nb show` on an empty
    // shelf exits 0 and still appends one usage row via the CLI's `finally`.
    const RING = 100;
    process.env.NB_USAGE_RING = String(RING);
    const slack = usageRingSlack();
    for (let i = 0; i < RING + slack; i++) logUsage(dir, 'seed', 'show', true, 1); // fill past the compaction threshold so each concurrent writer compacts (reads+rewrites) the whole file
    const env = { ...process.env, NB_DIR: dir };
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () =>
        execFileAsync(process.execPath, [CLI, 'show', 'race'], { env }),
      ),
    );
    const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(RING + slack + N); // ring bound (plus bounded slack/concurrency overshoot) holds under contention
    // Every surviving line is a complete, well-formed usage row — no torn/partial
    // line (the corruption a shared temp path could leave).
    for (const l of lines) {
      // Five base columns, then eleven richer ones (session, entries, outcome,
      // collided, evicted, reason, note, errorClass, decayed, recovered, misses)
      // — all empty for a successful `show`, so the row is 16 tab-separated columns.
      expect(l).toMatch(/^[^\t]+\t[^\t]*\t[^\t]+\t(ok|err)\t\d+ms(\t[^\t]*){11}$/);
    }
    // No stray temp file lingered: every writer's rename consumed its own temp.
    expect(readdirSync(dir).filter((f) => f.startsWith('.nb-usage.log.') && f.endsWith('.tmp'))).toEqual([]);
  }, 30_000);

  test('a full ring with a missing sidecar appends in place until cap + slack, without a rewrite (issue #377)', () => {
    const RING = 100;
    process.env.NB_USAGE_RING = String(RING);
    const usage = join(dir, '.nb-usage.log');
    const seed = Array.from({ length: RING }, (_, i) => `${new Date(i * 1000).toISOString()}\tseed\tshow\tok\t1ms`);
    writeFileSync(usage, seed.join('\n') + '\n', 'utf-8'); // exactly at the cap, no .count sidecar
    fsHook.renames = [];
    try {
      logUsage(dir, 'p', 'add', true, 1); // exact path: must append, not compact
      expect(fsHook.renames).toEqual([]);
      const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
      expect(lines.length).toBe(RING + 1);
      expect(lines[0]).toBe(seed[0]); // the oldest row is still there: nothing was dropped
    } finally {
      fsHook.renames = null;
    }
  });

  test('the exact path still compacts back to the hard cap once cap + slack is reached (issue #377)', () => {
    const RING = 100;
    process.env.NB_USAGE_RING = String(RING);
    const usage = join(dir, '.nb-usage.log');
    const total = RING + usageRingSlack();
    const seed = Array.from({ length: total }, (_, i) => `${new Date(i * 1000).toISOString()}\tseed\tshow\tok\t1ms`);
    writeFileSync(usage, seed.join('\n') + '\n', 'utf-8'); // at cap + slack, no sidecar
    logUsage(dir, 'p', 'add', true, 1);
    const lines = readFileSync(usage, 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(RING);
    expect(lines[lines.length - 1]).toContain('\tp\tadd\t'); // the newest row survives
  });

  test('cross-process: concurrent writers on a full ring each leave their row (issue #377) [timing]', async () => {
    const RING = 100;
    process.env.NB_USAGE_RING = String(RING);
    const usage = join(dir, '.nb-usage.log');
    const seed = Array.from({ length: RING }, (_, i) => `${new Date(i * 1000).toISOString()}\tseed\tshow\tok\t1ms`);
    writeFileSync(usage, seed.join('\n') + '\n', 'utf-8'); // at the cap, no sidecar
    const N = 12;
    expect(N).toBeLessThan(usageRingSlack()); // the appends stay below the slack: no compaction may run
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileAsync(process.execPath, [CLI, 'show', 'race'], {
          env: { ...process.env, NB_DIR: dir, NB_SESSION: `s377-${i}` },
        }),
      ),
    );
    const body = readFileSync(usage, 'utf-8');
    for (let i = 0; i < N; i++) expect(body).toContain(`s377-${i}`);
  }, 30_000);
});

describe('sparkline (issue #106)', () => {
  test('empty input renders the empty string', () => {
    expect(sparkline([])).toBe('');
  });

  test('maps 0..max linearly onto the eight block glyphs (the ▁▂▃▄▅▆▇█ identity)', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
  });

  test('an all-zero series renders the floor glyph in every slot (silent reads as the floor)', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
  });

  test('a single nonzero value renders the top glyph (it is its own max)', () => {
    expect(sparkline([5])).toBe('█');
  });

  test('zero-based scaling: a 0 bucket beside nonzero ones is the floor, the max is the top', () => {
    // max = 8; 0→▁, 8→█, 4→round(4/8*7)=round(3.5)=4→▅
    expect(sparkline([0, 8, 4])).toBe('▁█▅');
  });

  test('every nonzero bucket is scaled against the max, not min–max (a near-flat series stays near the top)', () => {
    // min–max scaling would make [6,7,8] read ▁▄█; zero-based keeps all three high.
    expect(sparkline([6, 7, 8])).toBe('▆▇█');
  });
});

describe('sparkline ASCII glyph set (issue #136)', () => {
  const ASCII = '0123456789';

  test('the default (no glyph argument) output is unchanged — still Unicode blocks', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
  });

  test('a passed ASCII ramp conveys relative bar heights (0 floor, max top, exact scaling)', () => {
    // 0→floor, 8→top (9), 4→round(4/8*9)=round(4.5)=5 (relative middle height).
    expect(sparkline([0, 8, 4], ASCII)).toBe('095');
  });

  test('the ASCII render (via the real sparkGlyphs ramp) contains only ASCII, unlike the Unicode run', () => {
    // A varied series through the *production* ramp, not a local literal: this is
    // the acceptance criterion "the activity row contains only ASCII".
    const series = [0, 3, 1, 7, 2, 9, 5];
    const asciiOut = sparkline(series, sparkGlyphs({ NB_ASCII: '1' }));
    expect(/^[\x00-\x7f]*$/.test(asciiOut)).toBe(true);
    // The assertion is meaningful: the SAME series through the Unicode ramp is
    // NOT all-ASCII, so the check above would fail if the ramp leaked blocks.
    const unicodeOut = sparkline(series, sparkGlyphs({ LANG: 'en_US.UTF-8' }));
    expect(/^[\x00-\x7f]*$/.test(unicodeOut)).toBe(false);
  });

  test('ASCII floor: an all-zero (silent) series reads as the floor digit in every slot', () => {
    expect(sparkline([0, 0, 0], ASCII)).toBe('000');
  });

  test('ASCII scales 0..max across the full ramp (monotonic, non-decreasing heights)', () => {
    const out = sparkline([0, 1, 2, 3, 4, 5, 6, 7, 8], ASCII);
    expect(out).toBe('012356789');
    const digits = [...out].map(Number);
    for (let i = 1; i < digits.length; i++) {
      expect(digits[i]).toBeGreaterThanOrEqual(digits[i - 1]);
    }
  });

  test('ASCII empty input renders the empty string', () => {
    expect(sparkline([], ASCII)).toBe('');
  });
});

describe('asciiMode / sparkGlyphs env selection (issue #136)', () => {
  test('NB_ASCII truthy forces ASCII and overrides a UTF-8 locale', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) {
      const env = { NB_ASCII: v, LANG: 'en_US.UTF-8' };
      expect(asciiMode(env)).toBe(true);
      expect(sparkGlyphs(env)).toBe('0123456789');
    }
  });

  test('NB_ASCII falsey forces Unicode and overrides a non-UTF-8 locale', () => {
    for (const v of ['', '0', 'false', 'no', 'off', ' OFF ']) {
      const env = { NB_ASCII: v, LANG: 'C' };
      expect(asciiMode(env)).toBe(false);
      expect(sparkGlyphs(env)).toBe('▁▂▃▄▅▆▇█');
    }
  });

  test('with NB_ASCII unset, a non-UTF-8 locale selects ASCII', () => {
    expect(asciiMode({ LANG: 'C' })).toBe(true);
    expect(asciiMode({ LANG: 'POSIX' })).toBe(true);
    expect(asciiMode({ LANG: 'en_US.ISO-8859-1' })).toBe(true);
    expect(sparkGlyphs({ LC_ALL: 'C' })).toBe('0123456789');
  });

  test('with NB_ASCII unset, a UTF-8 locale keeps the Unicode default (case-insensitive, utf8/utf-8)', () => {
    expect(asciiMode({ LANG: 'en_US.UTF-8' })).toBe(false);
    expect(asciiMode({ LANG: 'en_US.utf8' })).toBe(false);
    expect(asciiMode({ LC_CTYPE: 'fr_FR.UTF-8' })).toBe(false);
    expect(sparkGlyphs({ LANG: 'en_US.UTF-8' })).toBe('▁▂▃▄▅▆▇█');
  });

  test('with no locale vars and no NB_ASCII, defaults to Unicode (absence is not forced ASCII)', () => {
    expect(asciiMode({})).toBe(false);
    expect(sparkGlyphs({})).toBe('▁▂▃▄▅▆▇█');
  });

  test('locale precedence: LC_ALL > LC_CTYPE > LANG', () => {
    // LC_ALL (C) wins over a UTF-8 LANG → ASCII.
    expect(asciiMode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(true);
    // LC_CTYPE (UTF-8) wins over a C LANG → Unicode.
    expect(asciiMode({ LC_CTYPE: 'en_US.UTF-8', LANG: 'C' })).toBe(false);
  });

  test('locale precedence: LC_ALL outranks LC_CTYPE when both are set', () => {
    // LC_ALL (C) wins over a UTF-8 LC_CTYPE → ASCII. Isolates the LC_ALL→LC_CTYPE
    // ordering: swapping the two in the chain would flip this to Unicode.
    expect(asciiMode({ LC_ALL: 'C', LC_CTYPE: 'en_US.UTF-8' })).toBe(true);
  });

  test('an empty LC_ALL is treated as unset and falls through to LANG (POSIX)', () => {
    // `LC_ALL=` is common in real shells; POSIX treats it as unset. The `||`
    // chain falls through to LANG=C → ASCII; a `??` chain would wrongly stop at
    // the empty string and read it as a UTF-8-less-but-also-not-set no-op.
    expect(asciiMode({ LC_ALL: '', LANG: 'C' })).toBe(true);
    expect(asciiMode({ LC_ALL: '', LANG: 'en_US.UTF-8' })).toBe(false);
  });
});

describe('activityByDay (issue #106)', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-10-31T12:00:00Z');

  test('buckets rolling 24h windows oldest-first with the newest 24h on the right', () => {
    const ts = [
      now - 0.5 * DAY, // newest bucket (rightmost)
      now - 0.5 * DAY,
      now - 2.5 * DAY, // index 4 of 7
      now - 6.5 * DAY, // oldest bucket (leftmost)
    ];
    expect(activityByDay(ts, now, 7 * DAY)).toEqual([1, 0, 0, 0, 1, 0, 2]);
  });

  test('bucket count is ceil(windowMs / day), at least one', () => {
    expect(activityByDay([], now, 7 * DAY)).toHaveLength(7);
    expect(activityByDay([], now, 36 * 3600_000)).toHaveLength(2); // ceil(1.5) = 2
    expect(activityByDay([], now, 12 * 3600_000)).toHaveLength(1); // sub-day → 1
    expect(activityByDay([], now, 0)).toHaveLength(1); // max(1, 0)
  });

  test('a timestamp exactly at the window edge lands in the oldest bucket, not off the array', () => {
    // age === windowMs would compute fromRight = 7; it must clamp to the oldest bucket.
    expect(activityByDay([now - 7 * DAY], now, 7 * DAY)).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });

  test('a future (negative-age) timestamp lands in the newest bucket', () => {
    expect(activityByDay([now + 3600_000], now, 7 * DAY)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  test('every timestamp is counted — the buckets sum to the input length', () => {
    const ts = [now - 0.1 * DAY, now - 7 * DAY, now + DAY, now - 3 * DAY];
    const buckets = activityByDay(ts, now, 7 * DAY);
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(ts.length);
  });
});

describe('diagnostic signals (issue #72)', () => {
  // All three signals are read from the usage ring (no new agent action). Rows
  // are logged with explicit sessions so the tests are deterministic regardless
  // of whether NB_SESSION happens to be set in the host environment.

  test('browse-without-use: a show with no vote in the same session is flagged', () => {
    logUsage(dir, 'reviewer', 'show', true, 2, { session: 's1' });
    const rep = stats(dir, { now: Date.now() });
    const sig = rep.signals.find((s) => s.kind === 'browse-without-use' && s.shelf === 'reviewer');
    expect(sig).toBeDefined();
    expect(sig!.session).toBe('s1');
  });

  test('browse-without-use: a vote anywhere in the session suppresses it', () => {
    logUsage(dir, 'reviewer', 'show', true, 2, { session: 's1' });
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's1', entries: ['abc123'], outcome: 'up' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals.some((s) => s.kind === 'browse-without-use' && s.session === 's1')).toBe(false);
  });

  test('browse-without-use: a show with a blank session is skipped (needs NB_SESSION)', () => {
    logUsage(dir, 'reviewer', 'show', true, 2, { session: '' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals.some((s) => s.kind === 'browse-without-use')).toBe(false);
  });

  test('eviction-while-still-voted: the cap evicted an entry whose score was still above the starting +1', () => {
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's2', entries: ['new999'], outcome: 'accepted', evicted: 'vic777:2' });
    const rep = stats(dir, { now: Date.now() });
    const sig = rep.signals.find((s) => s.kind === 'eviction-while-still-voted');
    expect(sig).toMatchObject({ role: 'patcher', entry: 'vic777' });
  });

  test('eviction-while-still-voted: an entry upvoted then voted back down is NOT flagged (the cap doing its job)', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', entries: ['bad111'], outcome: 'up' });
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's2', entries: ['new999'], outcome: 'accepted', evicted: 'bad111:-1' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals.some((s) => s.kind === 'eviction-while-still-voted')).toBe(false);
  });

  test('eviction-while-still-voted: evicting a never-voted entry (still at the starting +1) is NOT flagged', () => {
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', entries: ['new999'], outcome: 'accepted', evicted: 'unv000:1' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals.some((s) => s.kind === 'eviction-while-still-voted')).toBe(false);
  });

  test('vote-reversal: upvoted in one session, downvoted in another', () => {
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's1', entries: ['xy12ab'], outcome: 'up' });
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's2', entries: ['xy12ab'], outcome: 'down' });
    const rep = stats(dir, { now: Date.now() });
    const sig = rep.signals.find((s) => s.kind === 'vote-reversal' && s.entry === 'xy12ab');
    expect(sig).toMatchObject({ role: 'reviewer', entry: 'xy12ab' });
  });

  test('vote-reversal: up and down in the SAME session is not a cross-session reversal', () => {
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's1', entries: ['xy12ab'], outcome: 'up' });
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's1', entries: ['xy12ab'], outcome: 'down' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals.some((s) => s.kind === 'vote-reversal')).toBe(false);
  });

  test('quiet, healthy usage produces no signals', () => {
    logUsage(dir, 'reviewer', 'show', true, 2, { session: 's1' });
    logUsage(dir, 'reviewer', 'vote', true, 1, { session: 's1', entries: ['abc123'], outcome: 'up' });
    const rep = stats(dir, { now: Date.now() });
    expect(rep.signals).toHaveLength(0);
  });

  test('signals are scoped to the shelf when stats is called with one', () => {
    logUsage(dir, 'alpha', 'show', true, 2, { session: 's1' });
    logUsage(dir, 'beta', 'show', true, 2, { session: 's2' });
    const rep = stats(dir, { now: Date.now(), role: 'alpha' });
    expect(rep.signals.length).toBeGreaterThan(0);
    expect(rep.signals.every((s) => s.shelf === 'alpha')).toBe(true);
  });

  test('a signal older than the window is excluded', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const old = new Date(now - 100 * 3600_000).toISOString(); // 100h ago
    // A show row 100h back, with a session but no vote — would be browse-without-use
    // if it were in the window. Twelve columns: base five + session + the rest blank.
    writeFileSync(join(dir, '.nb-usage.log'), `${old}\treviewer\tshow\tok\t2ms\ts1\t\t\t\t\t\t\n`, 'utf-8');
    const rep = stats(dir, { now, windowMs: 48 * 3600_000 });
    expect(rep.signals).toHaveLength(0);
  });
});

describe('surfacing metrics (issue #81)', () => {
  // The named recall-miss / precision-miss rates and the coverage×surfacing
  // readout from §4 of the design rationale. Rows are logged with explicit
  // sessions: every rate is engagement-gated (a session counts only once it
  // shows a vote), so the tests seed a vote to make a session "engaged".

  test('recall-miss, coverage, and precision-miss are the rates §4 defines', () => {
    // Engaged session s1: 2 accepted adds, 1 dedup-blocked add, 1 up + 1 down vote.
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'accepted', entries: ['a1'] });
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'accepted', entries: ['a2'] });
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'dedup-blocked', entries: ['a3'], collided: 'a1' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'down', entries: ['a2'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.engagedSessions).toBe(1);
    expect(sf.addAttempts).toBe(3);
    expect(sf.coverage).toBeCloseTo(2 / 3);
    expect(sf.recallMiss).toBeCloseTo(1 / 3); // the headline alarm
    expect(sf.votesActedOn).toBe(2);
    expect(sf.precisionMiss).toBeCloseTo(0.5); // 1 downvote of 2 votes
  });

  test('a batch vote row counts one vote per landed id (issue #373)', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'down', entries: ['a6'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.upvotes).toBe(5);
    expect(sf.votesActedOn).toBe(6);
    expect(sf.precisionMiss).toBeCloseTo(1 / 6);
  });

  test('a batch downvote counts per id; a legacy row without ids counts once', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'down', entries: ['a1', 'a2'] });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: [] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.votesActedOn).toBe(3);
    expect(sf.upvotes).toBe(1);
    expect(sf.serendipity).toBe(1);
  });

  test('a batch upvote splits pulled vs pushed per id for serendipity (issue #373)', () => {
    logUsage(dir, '-', 'search', true, 1, { session: 's1', outcome: 'match', entries: ['a2'], note: 'q' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1', 'a2', 'a3', 'a4'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.upvotes).toBe(4);
    expect(sf.serendipity).toBeCloseTo(3 / 4);
  });

  test('the engagement gate excludes a session with no vote (not scored as healthy quiet)', () => {
    // s1 has adds but NO vote → not engaged → its adds are not scored.
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'dedup-blocked', entries: ['x'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.addAttempts).toBe(0);
    expect(sf.recallMiss).toBeNull(); // no engaged data → null, never a misleading 0
    expect(sf.readout).toBeNull();
  });

  test('a blank session is skipped (needs NB_SESSION), so no engaged sessions', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: '', outcome: 'up', entries: ['x'] });
    logUsage(dir, 'patcher', 'add', true, 2, { session: '', outcome: 'dedup-blocked', entries: ['y'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.coverage).toBeNull();
    expect(sf.precisionMiss).toBeNull();
  });

  test('empty and too-long adds are malformed input, excluded from attempts', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] }); // engages s1
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'accepted', entries: ['a1'] });
    logUsage(dir, 'patcher', 'add', false, 1, { session: 's1', outcome: 'empty' });
    logUsage(dir, 'patcher', 'add', false, 1, { session: 's1', outcome: 'too-long' });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.addAttempts).toBe(1); // only the accepted one
    expect(sf.coverage).toBe(1);
  });

  test('rejected-full is a genuine attempt (slack between coverage and recall-miss)', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'accepted', entries: ['a1'] });
    logUsage(dir, 'patcher', 'add', true, 2, { session: 's1', outcome: 'rejected-full', entries: ['a2'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.addAttempts).toBe(2);
    expect(sf.coverage).toBe(0.5);
    expect(sf.recallMiss).toBe(0); // no dedup-blocks, yet coverage < 1 — the rejected-full slack
  });

  test('coverage×surfacing readout maps the four quadrants (default thresholds)', () => {
    // Default thresholds: coverage HIGH ≥ 0.5, recall-miss HIGH ≥ 0.2.
    const readoutFor = (accepted: number, blocked: number): string | null => {
      const d = mkdtempSync(join(tmpdir(), 'agent-notebook-sf-'));
      try {
        logUsage(d, 'r', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['v'] });
        for (let i = 0; i < accepted; i++) logUsage(d, 'r', 'add', true, 1, { session: 's1', outcome: 'accepted', entries: [`a${i}`] });
        for (let i = 0; i < blocked; i++) logUsage(d, 'r', 'add', true, 1, { session: 's1', outcome: 'dedup-blocked', entries: [`b${i}`] });
        return stats(d, { now: Date.now() }).surfacing.readout;
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    };
    expect(readoutFor(1, 9)).toBe('surfacing-failure'); // coverage .1 LOW, recall .9 HIGH
    expect(readoutFor(9, 0)).toBe('coverage-building'); // coverage 1.0 HIGH, recall 0 LOW
    expect(readoutFor(6, 4)).toBe('churny'); // coverage .6 HIGH, recall .4 HIGH
  });

  test('healthy quadrant: low coverage AND low recall-miss', () => {
    // 10 attempts: 3 accepted (.3 coverage LOW), 1 dedup-blocked (.1 recall LOW), 6 rejected-full slack.
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['v'] });
    for (let i = 0; i < 3; i++) logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'accepted', entries: [`a${i}`] });
    logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'dedup-blocked', entries: ['b0'] });
    for (let i = 0; i < 6; i++) logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'rejected-full', entries: [`f${i}`] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.coverage).toBeCloseTo(0.3);
    expect(sf.recallMiss).toBeCloseTo(0.1);
    expect(sf.readout).toBe('healthy');
  });

  test('NB_COVERAGE_HI / NB_RECALL_MISS_HI tune the readout thresholds', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['v'] });
    logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'accepted', entries: ['a0'] });
    logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'dedup-blocked', entries: ['b0'] });
    // coverage .5, recall .5. Defaults → both HIGH → churny.
    expect(stats(dir, { now: Date.now() }).surfacing.readout).toBe('churny');
    // Raise both cutoffs above .5 → both LOW → healthy.
    process.env.NB_COVERAGE_HI = '0.9';
    process.env.NB_RECALL_MISS_HI = '0.9';
    expect(stats(dir, { now: Date.now() }).surfacing.readout).toBe('healthy');
  });

  test('a malformed NB_RECALL_MISS_HI falls back to the default (not NaN)', () => {
    process.env.NB_RECALL_MISS_HI = 'abc';
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['v'] });
    logUsage(dir, 'patcher', 'add', true, 1, { session: 's1', outcome: 'dedup-blocked', entries: ['b0'] });
    // recall-miss 1.0 ≥ default 0.2 → HIGH; a NaN cutoff would make every comparison false.
    expect(stats(dir, { now: Date.now() }).surfacing.readout).toBe('surfacing-failure');
  });

  test('surfacing is scoped to the shelf when stats is called with one', () => {
    logUsage(dir, 'alpha', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['v'] });
    logUsage(dir, 'alpha', 'add', true, 1, { session: 's1', outcome: 'dedup-blocked', entries: ['a'] });
    logUsage(dir, 'beta', 'vote', true, 1, { session: 's2', outcome: 'up', entries: ['w'] });
    logUsage(dir, 'beta', 'add', true, 1, { session: 's2', outcome: 'accepted', entries: ['c'] });
    const sf = stats(dir, { now: Date.now(), role: 'alpha' }).surfacing;
    expect(sf.engagedSessions).toBe(1);
    expect(sf.recallMiss).toBe(1); // only alpha's dedup-block counted
  });

  // Serendipity (issue #114): of the upvotes in engaged sessions, the share on
  // lessons that arrived unbidden (push), i.e. NOT returned by a `search` in the
  // same session. A two-sided proxy, published null-when-no-upvotes.
  test('a push-delivered upvote (no same-session search) counts toward serendipity', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.upvotes).toBe(1);
    expect(sf.serendipity).toBe(1); // arrived unbidden
  });

  test('a pull upvote (search returned the id earlier in the session) is excluded from serendipity', () => {
    // The search row is shelf `-` (spans notebooks) and carries the surfaced id.
    logUsage(dir, '-', 'search', true, 1, { session: 's1', outcome: 'match', entries: ['a1'], note: 'q' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.upvotes).toBe(1);
    expect(sf.serendipity).toBe(0); // the agent reached it by search → a pull, not serendipity
  });

  test('mixed: one pulled + one pushed upvote ⇒ serendipity 0.5', () => {
    logUsage(dir, '-', 'search', true, 1, { session: 's1', outcome: 'match', entries: ['a1'], note: 'q' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] }); // pull
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a2'] }); // push (never searched)
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.upvotes).toBe(2);
    expect(sf.serendipity).toBe(0.5);
  });

  test('a search in a DIFFERENT session does not mark an upvote as pulled', () => {
    logUsage(dir, '-', 'search', true, 1, { session: 's2', outcome: 'match', entries: ['a1'], note: 'q' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.serendipity).toBe(1); // s1 never searched a1 → still a push
  });

  test('the engagement gate also governs serendipity: a blank-session upvote is excluded', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: '', outcome: 'up', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.upvotes).toBe(0);
    expect(sf.serendipity).toBeNull(); // no upvotes in engaged sessions → null, never a misleading 0
  });

  test('serendipity is null when there are no upvotes (only a downvote engages the session)', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'down', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now() }).surfacing;
    expect(sf.engagedSessions).toBe(1); // a downvote engages the session
    expect(sf.votesActedOn).toBe(1);
    expect(sf.upvotes).toBe(0);
    expect(sf.serendipity).toBeNull();
  });

  test('scoped `nb stats <shelf>` still detects a pull via the deployment-wide (`-`) search row', () => {
    // The upvote is on `patcher`; the search that pulled it is logged under `-`.
    // A scoped report filters `recent` to patcher (dropping the `-` search), but
    // the pull set is read from the deployment-wide rows, so the pull is still seen.
    logUsage(dir, '-', 'search', true, 1, { session: 's1', outcome: 'match', entries: ['a1'], note: 'q' });
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    const sf = stats(dir, { now: Date.now(), shelf: 'patcher' }).surfacing;
    expect(sf.upvotes).toBe(1);
    expect(sf.serendipity).toBe(0); // classified as a pull despite the scope
  });

  test('a surfacing row older than the window is excluded', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const old = new Date(now - 100 * 3600_000).toISOString();
    // An engaged (voted) session 100h back — excluded by a 48h window.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      `${old}\tpatcher\tvote\tok\t1ms\ts1\tv\tup\t\t\t\t\n` +
        `${old}\tpatcher\tadd\tok\t1ms\ts1\ta\tdedup-blocked\t\t\t\t\n`,
      'utf-8',
    );
    const sf = stats(dir, { now, windowMs: 48 * 3600_000 }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.recallMiss).toBeNull();
  });
});

describe('zero-engagement root-cause diagnosis (issue #105)', () => {
  // diagnoseEngagement splits a "no engaged sessions" window into its root
  // cause(s). Each guard is isolated by a test so a deleted/flipped condition
  // fails a test (mutation-resistant). "Read" is defined twice on purpose:
  // READ_COMMANDS (show/list/search) for the hook check, DELIBERATE (show/search)
  // for the retrospective check — the one place the hook's own `nb list` must not
  // be double-counted.

  // --- diagnoseEngagement unit tests (counts + causes, no stats() wrapper) ---

  test('blank-session rows with no stored lessons yield only the blank-session cause (AC1)', () => {
    // storedLessons = 0 isolates blank-session from injection-hook (which needs
    // lessons to surface); the overlap of the two is pinned by its own test below.
    const d = diagnoseEngagement(
      [usageRow({ command: 'add', session: '', outcome: 'accepted' })],
      0,
    );
    expect(d.blankSessionCalls).toBe(1);
    expect(d.causes).toEqual(['blank-session']);
  });

  test('a deliberate read (show) in a session with no vote is retrospective-not-landing (AC2)', () => {
    const d = diagnoseEngagement(
      [usageRow({ command: 'show', session: 's1', outcome: '' })],
      3,
    );
    expect(d.readOnlySessions).toBe(1);
    expect(d.reads).toBe(1);
    expect(d.causes).toEqual(['retrospective-not-landing']); // NOT injection-hook (reads>0), NOT blank-session (no blank rows)
  });

  test('zero reads with stored lessons is injection-hook (AC3)', () => {
    const d = diagnoseEngagement([], 5);
    expect(d.reads).toBe(0);
    expect(d.causes).toEqual(['injection-hook']);
  });

  test('injection-hook needs stored lessons: zero reads + empty notebook ⇒ no cause', () => {
    // Pins the `storedLessons > 0` guard — with 0 lessons there is nothing to
    // surface, so "hook not wired" must NOT be claimed.
    const d = diagnoseEngagement([], 0);
    expect(d.causes).toEqual([]);
  });

  test("the hook's own `nb list` is a read (hook check) but NOT a deliberate read (retrospective check)", () => {
    // A session with ONLY the auto-injected `nb list` and no vote: reads>0 keeps
    // injection-hook OFF, and list excluded from deliberate reads keeps
    // retrospective OFF — so no cause fires (don't double-count the hook's list).
    const d = diagnoseEngagement(
      [usageRow({ command: 'list', session: 's1', outcome: '' })],
      5,
    );
    expect(d.reads).toBe(1); // list counts as a read → injection-hook off
    expect(d.readOnlySessions).toBe(0); // list is NOT a deliberate read → retrospective off
    expect(d.causes).toEqual([]);
  });

  test('search counts as a deliberate read (retrospective cause)', () => {
    const d = diagnoseEngagement(
      [usageRow({ command: 'search', session: 's1', outcome: 'no-match', note: 'q' })],
      3,
    );
    expect(d.readOnlySessions).toBe(1);
    expect(d.causes).toEqual(['retrospective-not-landing']);
  });

  test('a deliberate read in a BLANK session does not count as a read-only session', () => {
    // Pins the `r.session !== ''` guard on the deliberate-read branch: a blank
    // show is a blank-session cause, never a retrospective one.
    const d = diagnoseEngagement(
      [usageRow({ command: 'show', session: '', outcome: '' })],
      3,
    );
    expect(d.readOnlySessions).toBe(0);
    expect(d.reads).toBe(1); // still a read for the hook check (so injection-hook off)
    expect(d.causes).toEqual(['blank-session']);
  });

  test('two distinct deliberate-read sessions count as two read-only sessions, not more', () => {
    const d = diagnoseEngagement(
      [
        usageRow({ command: 'show', session: 's1', outcome: '' }),
        usageRow({ command: 'search', session: 's1', outcome: 'no-match' }),
        usageRow({ command: 'show', session: 's2', outcome: '' }),
      ],
      3,
    );
    expect(d.readOnlySessions).toBe(2); // s1 (de-duped across its two reads) + s2
  });

  test('a blank-session call with zero reads and stored lessons fires BOTH causes, in order', () => {
    // Overlap: a session-less `add` (no read) with a non-empty notebook — the
    // operator has two real problems; both lines show, blank-session first.
    const d = diagnoseEngagement(
      [usageRow({ command: 'add', session: '', outcome: 'accepted' })],
      5,
    );
    expect(d.causes).toEqual(['blank-session', 'injection-hook']);
  });

  // --- through stats(): engagement gate + JSON field ---

  test('stats() fills engagementDiagnosis only when engagedSessions === 0', () => {
    logUsage(dir, 'patcher', 'vote', true, 1, { session: 's1', outcome: 'up', entries: ['a1'] });
    const engaged = stats(dir, { now: Date.now() }).surfacing;
    expect(engaged.engagedSessions).toBe(1);
    expect(engaged.engagementDiagnosis).toBeNull(); // engaged ⇒ nothing to diagnose
  });

  test('stats() surfaces the retrospective cause for a read-but-never-voted session', () => {
    process.env.NB_SESSION = 's1';
    logUsage(dir, 'patcher', 'show', true, 1, { session: 's1' });
    const sf = stats(dir, { now: Date.now(), shelf: 'patcher' }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.engagementDiagnosis?.causes).toEqual(['retrospective-not-landing']);
    expect(sf.engagementDiagnosis?.readOnlySessions).toBe(1);
  });

  test('stats() surfaces the injection-hook cause: stored lessons, no reads logged', async () => {
    await addEntry(dir, 'patcher', 'a stored lesson'); // populates the notebook WITHOUT a usage row
    const sf = stats(dir, { now: Date.now(), shelf: 'patcher' }).surfacing;
    expect(sf.engagedSessions).toBe(0);
    expect(sf.engagementDiagnosis?.reads).toBe(0);
    expect(sf.engagementDiagnosis?.storedLessons).toBe(1);
    expect(sf.engagementDiagnosis?.causes).toEqual(['injection-hook']);
  });

  test('the diagnosis is deployment-wide: a quiet shelf shows no diagnosis when another shelf is engaged', async () => {
    // Shelf 'beta' has an engaged (voted) session; shelf 'alpha' is quiet. Scoped
    // to alpha, engagedSessions is 0, but the DEPLOYMENT works, so no root-cause
    // diagnosis is emitted (the renderer then keeps the plain generic line).
    await addEntry(dir, 'alpha', 'a lesson'); // alpha has lessons but is never read/voted
    logUsage(dir, 'beta', 'vote', true, 1, { session: 's9', outcome: 'up', entries: ['x'] });
    const sf = stats(dir, { now: Date.now(), shelf: 'alpha' }).surfacing;
    expect(sf.engagedSessions).toBe(0); // alpha itself saw no engagement
    expect(sf.engagementDiagnosis).toBeNull(); // but the deployment is engaged ⇒ no false "hook not wired"
  });

  test("a global `nb list` suppresses injection-hook even when scoped to an unread shelf", async () => {
    // The hook's index read is logged globally (shelf '-'); a shelf-scoped view
    // must still treat it as a read so it does not falsely claim the hook is down.
    await addEntry(dir, 'alpha', 'a lesson');
    logUsage(dir, '-', 'list', true, 1, { session: 's1' }); // the hook's index injection
    const sf = stats(dir, { now: Date.now(), shelf: 'alpha' }).surfacing;
    expect(sf.engagementDiagnosis?.reads).toBe(1); // the global list is seen
    expect(sf.engagementDiagnosis?.causes).not.toContain('injection-hook');
  });

  test('the diagnosis is windowed: a read outside the window does not suppress injection-hook', async () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    const old = new Date(now - 100 * 3600_000).toISOString();
    writeFileSync(join(dir, '.nb-usage.log'), `${old}\tpatcher\tshow\tok\t1ms\ts1\t\t\t\t\t\t\n`, 'utf-8');
    // Stored lesson, but the only read is 100h back → inside a 48h window, reads===0.
    await addEntry(dir, 'patcher', 'lesson');
    const sf = stats(dir, { now, windowMs: 48 * 3600_000, shelf: 'patcher' }).surfacing;
    expect(sf.engagementDiagnosis?.reads).toBe(0);
    expect(sf.engagementDiagnosis?.causes).toContain('injection-hook');
  });
});

describe('entry-level + outcome logging (issue #67)', () => {
  test('parseUsage reads back the five richer columns a call records', () => {
    logUsage(dir, 'patcher', 'add', true, 5, {
      session: 'task-42',
      entries: ['abc123'],
      outcome: 'accepted',
      evicted: 'def456:-2',
    });
    const [row] = parseUsage(dir);
    expect(row.session).toBe('task-42');
    expect(row.entries).toEqual(['abc123']);
    expect(row.outcome).toBe('accepted');
    expect(row.collided).toBe('');
    expect(row.evicted).toBe('def456:-2');
  });

  test('session defaults to NB_SESSION when meta.session is absent', () => {
    process.env.NB_SESSION = 'sess-from-env';
    logUsage(dir, 'p', 'show', true, 1);
    expect(parseUsage(dir)[0].session).toBe('sess-from-env');
  });

  test('session is blank when NB_SESSION is unset (co-access not computable)', () => {
    delete process.env.NB_SESSION;
    logUsage(dir, 'p', 'show', true, 1);
    expect(parseUsage(dir)[0].session).toBe('');
  });

  test('a comma-joined entries field round-trips to a list (merge touches three ids)', () => {
    logUsage(dir, 'p', 'merge', true, 2, { entries: ['aaa', 'bbb', 'ccc'], outcome: 'merged' });
    const [row] = parseUsage(dir);
    expect(row.entries).toEqual(['aaa', 'bbb', 'ccc']);
    expect(row.outcome).toBe('merged');
  });

  test('a tab/CR/LF in NB_SESSION cannot inject an extra column or row', () => {
    process.env.NB_SESSION = 'a\tb\nc';
    logUsage(dir, 'p', 'add', true, 1, { entries: ['id1'], outcome: 'accepted' });
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(raw.split('\n').filter((l) => l !== '')).toHaveLength(1); // one row
    const [row] = parseUsage(dir);
    expect(row.session).toBe('a b c'); // the structural chars collapsed to spaces
    expect(row.entries).toEqual(['id1']); // columns stayed aligned
  });

  test('an old five-column row parses with blank richer fields (backward compatible)', () => {
    // A ring written before this change has only the original five columns.
    writeFileSync(
      join(dir, '.nb-usage.log'),
      `2026-10-23T10:00:00.000Z\tpatcher\tadd\tok\t5ms\n`,
      'utf-8',
    );
    const [row] = parseUsage(dir);
    expect(row.command).toBe('add');
    expect(row.ok).toBe(true);
    expect(row.ms).toBe(5);
    expect(row.session).toBe('');
    expect(row.entries).toEqual([]);
    expect(row.outcome).toBe('');
    expect(row.collided).toBe('');
    expect(row.evicted).toBe('');
  });

  test('a mix of old and new rows parses, and stats still rolls up both', () => {
    const old = `2026-10-23T10:00:00.000Z\tp\tadd\tok\t5ms`; // five columns
    writeFileSync(join(dir, '.nb-usage.log'), old + '\n', 'utf-8');
    logUsage(dir, 'p', 'vote', true, 3, { entries: ['xyz'], outcome: 'up' }); // ten columns
    const rows = parseUsage(dir);
    expect(rows).toHaveLength(2);
    expect(rows[1].outcome).toBe('up');
    const rep = stats(dir, { now: Date.parse('2026-10-23T10:01:00.000Z') });
    expect(rep.totalCalls).toBe(2);
  });

  test('richer-column logging stays inside the bounded ring', () => {
    process.env.NB_USAGE_RING = '100';
    for (let i = 0; i < 150; i++) {
      logUsage(dir, 'p', 'add', true, 1, { entries: [`id${i}`], outcome: 'accepted', session: 's' });
    }
    // Amortized compaction lets the ring overshoot by at most the slack before it
    // is trimmed back, so the row count stays bounded (filled, never unbounded).
    expect(parseUsage(dir).length).toBeGreaterThanOrEqual(usageRing());
    expect(parseUsage(dir).length).toBeLessThanOrEqual(usageRing() + usageRingSlack());
  });

  test('logUsage with meta never throws when the log cannot be written (best-effort holds)', () => {
    const asFile = join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x', 'utf-8');
    expect(() =>
      logUsage(asFile, 'p', 'add', true, 1, { entries: ['id1'], outcome: 'accepted' }),
    ).not.toThrow();
  });

  test('addEntry reports the touched id, and the colliding id on a dedup block', async () => {
    const first = await addEntry(dir, 'p', 'always run the build before vitest');
    expect(first.reason).toBe('added');
    expect(first.id).toBe(entryId('always run the build before vitest'));
    const dup = await addEntry(dir, 'p', 'always run the build before vitest');
    expect(dup.reason).toBe('duplicate');
    expect(dup.collidedId).toBe(first.id); // points at the entry that blocked it
  });

  test('merge reports the two source ids and the merged id', async () => {
    await addEntry(dir, 'p', 'alpha lesson one');
    await addEntry(dir, 'p', 'beta lesson two');
    const r = await merge(dir, 'p', 'alpha', 'beta', 'merged alpha and beta');
    expect(r.sources).toEqual([entryId('alpha lesson one'), entryId('beta lesson two')]);
    expect(r.id).toBe(entryId('merged alpha and beta'));
  });
});

describe('durable writes (issue #15)', () => {
  afterEach(() => {
    fsHook.events = null;
    fsHook.failDirFsync = false;
    fsHook.failBodyFsync = false;
  });

  test('an add round-trips and leaves no temp file behind (rename completed)', async () => {
    await addEntry(dir, 'patcher', 'durable lesson');
    expect(readEntries(dir, 'patcher')).toEqual([{ score: 1, text: 'durable lesson' }]);
    expect(existsSync(join(dir, 'patcher.md'))).toBe(true);
    // The atomic rename consumed the temp file; nothing is left half-written.
    expect(existsSync(join(dir, 'patcher.md.tmp'))).toBe(false);
  });

  test('the atomic-write temp path carries this process pid (issue #270)', async () => {
    // writeEntries renames from `<shelf>.md.<pid>.tmp`, never the fixed
    // `<shelf>.md.tmp`. withLock's single-host mkdir spinlock can declare a slow
    // holder STALE and let a second process steal the lock mid-write (a
    // network-FS fsync stall, heavy load, or a lowered NB_STALE_LOCK_MS); a
    // shared temp would then have both writers open+truncate+write the SAME path,
    // interleaving bytes before either rename and corrupting the notebook. A
    // per-process temp keeps each writer's temp distinct, so the atomic rename
    // degrades a stolen-lock overlap to a lost update, never a torn file. Pin the
    // naming invariant on the real atomic-rename source — a revert to the shared
    // `${file}.tmp` fails here.
    fsHook.renames = []; // capture the atomic-rename source path
    try {
      await addEntry(dir, 'patcher', 'per-process temp lesson');
      const file = join(dir, 'patcher.md');
      expect(fsHook.renames).toEqual([`${file}.${process.pid}.tmp`]);
    } finally {
      fsHook.renames = null; // leave the shared hook as the other tests expect it
    }
  });

  test('fsyncs the body before the rename and the parent directory after it', async () => {
    fsHook.events = [];
    await addEntry(dir, 'patcher', 'ordering lesson');
    // Body flushed, THEN rename, THEN the parent directory flushed.
    expect(fsHook.events).toEqual(['fsync-body', 'rename', 'fsync-dir']);
    expect(readEntries(dir, 'patcher')).toEqual([{ score: 1, text: 'ordering lesson' }]);
  });

  test('a directory-fsync failure is swallowed and the write still succeeds', async () => {
    // Simulate a platform where fsync'ing a directory throws (e.g. Windows):
    // the body fsync still runs for real, only the directory fsync fails.
    fsHook.failDirFsync = true;
    const r = await addEntry(dir, 'patcher', 'survives dir fsync failure');
    expect(r.added).toBe(true);
    expect(readEntries(dir, 'patcher')).toEqual([{ score: 1, text: 'survives dir fsync failure' }]);
  });

  test('a body-fsync failure is NOT swallowed: the write fails and the prior file is untouched', async () => {
    // Establish a committed baseline, then make the body fsync throw on the next write.
    await addEntry(dir, 'patcher', 'first lesson');
    fsHook.failBodyFsync = true;
    await expect(addEntry(dir, 'patcher', 'second lesson')).rejects.toThrow(/body fsync failed/);
    // The rename never ran, so the committed notebook is intact and the new lesson is absent.
    expect(readEntries(dir, 'patcher')).toEqual([{ score: 1, text: 'first lesson' }]);
  });
});

describe('locking (mkdir spinlock)', () => {
  // withLock serializes every mutation behind a `.nb.lock` directory: it spins
  // (20ms) up to an acquire deadline, and steals a lock whose mtime is older
  // than the stale threshold. The deadline is DERIVED as staleLockMs() +
  // lockGraceMs() so it is always >= the steal threshold — otherwise a caller
  // meeting a just-crashed holder's still-fresh lock would give up before the
  // lock aged enough to be stolen (issue #133: the old fixed 2s budget vs 10s
  // threshold). These tests drive that one safety-critical primitive directly —
  // concurrency must not lose an update, a blocked op must wait and then
  // acquire, a crashed holder's lock must be reclaimed within the budget, a
  // genuinely live holder must still make acquisition time out, and the lock
  // must always be released.
  //
  // NOTE on in-process vs. cross-process: withLock's critical section (`fn()`)
  // is synchronous, so Promise.all of several mutations in ONE process can never
  // interleave — the event loop runs each read-modify-write to completion before
  // the next starts, lock or no lock. An in-process "concurrency" test therefore
  // passes even if the lock is deleted and proves nothing. The genuine hazard is
  // several OS processes, so the no-lost-update test spawns real `nb` children.

  test('cross-process: concurrent `nb add` invocations on one shelf all land (no lost update) [timing]', async () => {
    const N = 8; // small, deterministic; ~N*20ms serialization ≪ each child's acquire budget
    const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir };
    delete env.NB_MAX_LINES; // keep the default cap (50); N is well under it, so none is evicted
    // Fire N separate processes at the same shelf simultaneously. Without the
    // lock each reads the same base file and its atomic rename clobbers the
    // others' — a classic lost update, leaving fewer than N lines. The lock
    // serializes them so every distinct lesson survives.
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileAsync(process.execPath, [CLI, 'add', 'race', `cross process lesson ${i}`], { env }),
      ),
    );
    const texts = readEntries(dir, 'race').map((e) => e.text).sort();
    const expected = Array.from({ length: N }, (_, i) => `cross process lesson ${i}`).sort();
    expect(texts).toEqual(expected); // all N present, none lost
  }, 30_000);

  test('cross-process: concurrent writers to one shelf under a steal-prone lock leave a whole, non-torn file and no stray temp (issue #270) [timing]', async () => {
    // The acceptance scenario for #270: overlapping writes to the SAME shelf with
    // the lock made steal-prone (NB_STALE_LOCK_MS at its 100ms floor), so a slow
    // holder can be declared stale and a second process writes while the first is
    // still mid-flight. Before #270 both writers opened and truncated the SAME
    // `race.md.tmp`, so one writer's rename could publish a file spliced from both
    // — a torn notebook. With a per-process temp each writer renames its own
    // complete file atomically: the published notebook is ALWAYS wholly one
    // writer's content (an overlap degrades to a lost update, never corruption),
    // and every writer's temp is consumed by its own rename.
    const N = 10;
    const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir, NB_STALE_LOCK_MS: '100', NB_LOCK_GRACE_MS: '2000' };
    delete env.NB_MAX_LINES; // default cap (50) >> N, so nothing is evicted
    const lessons = Array.from({ length: N }, (_, i) => `issue 270 overlap lesson number ${i}`);
    await Promise.all(
      lessons.map((text) => execFileAsync(process.execPath, [CLI, 'add', 'race', text], { env })),
    );
    // Every surviving line is EXACTLY one writer's lesson — never a splice of two
    // (the corruption a shared temp could publish). A steal may drop a lesson
    // (lost update), so we assert content integrity, not that all N survive.
    const texts = readEntries(dir, 'race').map((e) => e.text);
    expect(texts.length).toBeGreaterThan(0); // at least one writer committed
    for (const t of texts) expect(lessons).toContain(t); // no torn/spliced text
    expect(new Set(texts).size).toBe(texts.length); // no duplicated/half-written rows
    // No stray atomic-write temp lingered: every rename consumed its own per-pid temp.
    const strays = readdirSync(dir).filter((f) => f.startsWith('race.md') && f.endsWith('.tmp'));
    expect(strays).toEqual([]);
  }, 30_000);

  test('an operation blocked by a live lock waits, then acquires once the lock is freed [timing]', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a live lock held by "another process" (fresh mtime → never stolen)
    let releasedAt = 0;
    // Free the lock well within the acquire budget so the spinning op gets it.
    const timer = setTimeout(() => {
      releasedAt = Date.now();
      rmSync(lock, { recursive: true, force: true });
    }, 60);
    const r = await addEntry(dir, 'waiter', 'acquired after the lock was freed');
    clearTimeout(timer);
    expect(r.added).toBe(true);
    // The op resolved only AFTER the release fired: it genuinely spun on the lock
    // rather than ignoring it or stealing a fresh one. (If the lock were removed
    // from withLock, the op would resolve immediately, clearTimeout would cancel
    // the release, and releasedAt would still be 0 — so this fails on regression.)
    expect(releasedAt).toBeGreaterThan(0);
    expect(readEntries(dir, 'waiter')).toEqual([{ score: 1, text: 'acquired after the lock was freed' }]);
  });

  test('reclaims an already-stale .nb.lock (mtime older than the stale threshold) and completes', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a crashed nb process left the lock dir behind
    const agedSeconds = Date.now() / 1000 - 20; // back-date mtime 20s into the past (> 10s default threshold)
    utimesSync(lock, agedSeconds, agedSeconds);
    // The next op must steal the aged lock immediately rather than wait out the deadline.
    const r = await addEntry(dir, 'stale', 'written after stealing a stale lock');
    expect(r.added).toBe(true);
    expect(readEntries(dir, 'stale')).toEqual([{ score: 1, text: 'written after stealing a stale lock' }]);
    // The stolen lock is released again when the operation finishes.
    expect(existsSync(lock)).toBe(false);
  });

  test('a crashed holder’s fresh lock is reclaimed WITHIN the acquire window, not thrown (issue #133) [timing]', async () => {
    // The bug: a crash leaves a fresh `.nb.lock`; with a 2s budget but a 10s
    // steal threshold the next caller gave up before the lock ever aged enough
    // to steal, so every mutation failed with 'locked' for ~10s. With the budget
    // derived as staleMs + grace, the caller waits past staleMs and reclaims it.
    // Shrink the window via env so the real wait is ~150ms, not ~10s.
    process.env.NB_STALE_LOCK_MS = '150';
    process.env.NB_LOCK_GRACE_MS = '2000'; // budget 2150ms ≫ staleMs: the steal branch is reachable
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a crashed nb process left a FRESH lock (mtime = now) and never touches it again
    const started = Date.now();
    const r = await addEntry(dir, 'crashed', 'reclaimed a crashed holder’s fresh lock');
    const waited = Date.now() - started;
    expect(r.added).toBe(true); // reclaimed and wrote, did NOT throw 'locked'
    expect(readEntries(dir, 'crashed')).toEqual([{ score: 1, text: 'reclaimed a crashed holder’s fresh lock' }]);
    // It genuinely spun until the lock went stale (≈staleMs) and stole it — it
    // did not acquire instantly (the lock existed) nor wait out the full budget.
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(2000);
    expect(existsSync(lock)).toBe(false); // the stolen lock is released again
  }, 10_000);

  test('a genuinely live holder that keeps its lock fresh still times out, reporting the DERIVED budget [timing]', async () => {
    // Acceptance #3: the 'locked' error must still fire for a live contender that
    // never releases. A live holder keeps touching the lock, so its mtime never
    // ages past the stale threshold and it is never stolen — unlike a crashed
    // holder whose lock goes stale. Renew far faster than staleMs, past the budget.
    //
    // This also pins the derivation BEHAVIORALLY: the thrown message reports the
    // budget withLock actually used, so asserting it equals staleMs + grace (and
    // is therefore >= staleMs) proves the acquire deadline is derived from the
    // steal threshold — an assertion that, unlike `staleMs + grace >= staleMs`,
    // a revert to a fixed `deadline = now + 2000` would fail.
    process.env.NB_STALE_LOCK_MS = '500';
    process.env.NB_LOCK_GRACE_MS = '100'; // budget 600ms; renew interval 20ms ≪ 500ms so the lock never goes stale
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock);
    const renew = setInterval(() => {
      try {
        const now = Date.now() / 1000;
        utimesSync(lock, now, now); // keep mtime fresh ≪ staleMs so the lock is never stolen
      } catch {
        /* lock removed — stop touching it */
      }
    }, 20);
    try {
      const started = Date.now();
      const err = await addEntry(dir, 'blocked', 'should never be written').then(
        () => { throw new Error('expected addEntry to reject with a lock timeout, but it resolved'); },
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(/notebook is locked/);
      expect(err.message).toContain('within 600ms'); // reports staleMs(500) + grace(100), the derived budget
      expect(Date.now() - started).toBeGreaterThanOrEqual(600); // spun the full derived budget before giving up
    } finally {
      clearInterval(renew);
    }
    expect(existsSync(join(dir, 'blocked.md'))).toBe(false); // the blocked op mutated nothing
  }, 10_000);

  test('releases the lock even when the operation throws (finally path)', async () => {
    // vote on an empty notebook throws INSIDE the locked section; the finally
    // block must still remove .nb.lock so the next op is not blocked forever.
    await expect(vote(dir, 'nobody', 'anything', 1)).rejects.toThrow(/empty/);
    expect(existsSync(join(dir, '.nb.lock'))).toBe(false);
    // Proof the notebook is still usable afterwards (the lock really was freed).
    const r = await addEntry(dir, 'nobody', 'usable after a thrown op released the lock');
    expect(r.added).toBe(true);
  });

  // Issue #263: an unwritable NB_DIR makes `mkdirSync(.nb.lock)` fail with a code
  // OTHER than EEXIST (EACCES/EPERM permission-denied, EROFS read-only mount,
  // ENOSPC full disk). The old catch treated EVERY mkdir error as "lock held" and
  // busy-waited the whole acquire budget (staleMs + grace, the default 12s) before
  // dying with a misleading 'notebook is locked' — when no other process exists and
  // the real cause is a store that simply cannot be written. The acquire loop must
  // instead fail fast and name the real cause. The default budget is left untouched
  // (12s), so a regression that busy-waits would blow well past these assertions.
  for (const code of ['EACCES', 'EROFS', 'ENOSPC'] as const) {
    test(`fails fast (not 'locked') when mkdir(.nb.lock) throws ${code} — unwritable store (issue #263)`, async () => {
      fsHook.failLockMkdirCode = code; // simulate an unwritable NB_DIR for the lock-acquire mkdir
      const started = Date.now();
      const err = await addEntry(dir, 'unwritable', 'should never be written').then(
        () => { throw new Error('expected addEntry to reject on an unwritable store, but it resolved'); },
        (e: unknown) => e as Error,
      );
      const waited = Date.now() - started;
      // Fails fast: well under the ~12s default acquire budget it would have spun
      // through before the fix (a regression would exceed this and the vitest timeout).
      expect(waited).toBeLessThan(1000);
      // Reports the real cause, not the misleading 'notebook is locked'.
      expect(err.message).not.toMatch(/notebook is locked/);
      expect(err.message).toMatch(/not writable/);
      expect(err.message).toContain(code); // surfaces the underlying errno for diagnosis
      const cause = (err as { cause?: NodeJS.ErrnoException }).cause;
      expect(cause?.code).toBe(code); // the ORIGINAL fs error is chained, with its real errno
      expect(existsSync(join(dir, 'unwritable.md'))).toBe(false); // nothing was mutated
      expect(existsSync(join(dir, '.nb.lock'))).toBe(false); // the fast-fail stranded no lock
      // And no lock/state was left behind: once the store is writable again the
      // very next mutation succeeds (a stranded `.nb.lock` would block it instead).
      fsHook.failLockMkdirCode = null;
      const recovered = await addEntry(dir, 'recovered', 'written once the store is writable again');
      expect(recovered.added).toBe(true);
    });
  }
});

describe('reaps an emptied, undescribed phantom shelf (issue #209)', () => {
  test('rm of the last lesson on an undescribed shelf leaves no file on disk', async () => {
    await addEntry(dir, 's', 'x');
    expect(existsSync(join(dir, 's.md'))).toBe(true);
    await remove(dir, 's', 'x');
    // The phantom 0-byte file is reaped, not left for listNotebooks to hide.
    expect(existsSync(join(dir, 's.md'))).toBe(false);
    expect(listNotebooks(dir).rows.map((n) => n.shelf)).not.toContain('s');
  });

  test('a described-but-empty shelf is preserved — the description is a deliberate trigger', async () => {
    await setDescription(dir, 's', 'when to do X');
    // No lessons, but a `# desc:` block makes the file non-empty, so it is kept.
    expect(existsSync(join(dir, 's.md'))).toBe(true);
  });

  test('rm of the last lesson on a DESCRIBED shelf keeps the file (the description survives)', async () => {
    await setDescription(dir, 's', 'trigger');
    await addEntry(dir, 's', 'x');
    await remove(dir, 's', 'x');
    expect(existsSync(join(dir, 's.md'))).toBe(true); // meta block → not a phantom
    expect(getDescription(dir, 's')).toBe('trigger');
  });

  test('reaping an emptied shelf leaves every other shelf intact', async () => {
    await addEntry(dir, 'keep', 'y');
    await addEntry(dir, 'gone', 'x');
    await remove(dir, 'gone', 'x');
    expect(existsSync(join(dir, 'gone.md'))).toBe(false);
    expect(existsSync(join(dir, 'keep.md'))).toBe(true);
    expect(readEntries(dir, 'keep').map((e) => e.text)).toEqual(['y']);
  });
});

describe('reaps a phantom shelf left by move and describe "" (issue #355)', () => {
  test('move of the last lesson off an undescribed shelf removes the source file', async () => {
    await addEntry(dir, 'target', 'a lesson that stays');
    await addEntry(dir, 'src', 'the only lesson');
    const r = await move(dir, 'src', 'target', 'the only');
    expect(r.reason).toBe('moved');
    expect(existsSync(join(dir, 'src.md'))).toBe(false);
    expect(readEntries(dir, 'target')).toHaveLength(2);
    expect(listNotebooks(dir).rows.map((n) => n.shelf)).toEqual(['target']);
  });

  test('move of the last lesson off a DESCRIBED shelf keeps the file and its description', async () => {
    await addEntry(dir, 'target', 'a lesson that stays');
    await addEntry(dir, 'src', 'the only lesson');
    await setDescription(dir, 'src', 'open when testing');
    await move(dir, 'src', 'target', 'the only');
    expect(existsSync(join(dir, 'src.md'))).toBe(true);
    expect(getDescription(dir, 'src')).toBe('open when testing');
  });

  test('describe "" on a shelf with no lessons removes the file', async () => {
    await addEntry(dir, 'target', 'a lesson that stays');
    await addEntry(dir, 'old', 'another only lesson');
    await setDescription(dir, 'old', 'open when testing');
    await move(dir, 'old', 'target', 'another');
    expect(existsSync(join(dir, 'old.md'))).toBe(true); // description keeps it
    await setDescription(dir, 'old', '');
    expect(existsSync(join(dir, 'old.md'))).toBe(false);
  });

  test('describe "" on a shelf that still has lessons keeps the file', async () => {
    await addEntry(dir, 's', 'x');
    await setDescription(dir, 's', 'trigger');
    await setDescription(dir, 's', '');
    expect(readEntries(dir, 's').map((e) => e.text)).toEqual(['x']);
  });

  test('describe "" on a shelf that never existed creates no file', async () => {
    await setDescription(dir, 'ghost', '');
    expect(existsSync(join(dir, 'ghost.md'))).toBe(false);
  });
});

describe('reaps leftover temps on lock acquire (issues #46, #163)', () => {
  // A crash between an atomic write's temp and its rename leaves an orphan in the
  // notebooks dir that nothing else removes. The next locked mutation sweeps this
  // writer's two temp conventions — `<shelf>.md.<pid>.tmp` (writeFileDurable,
  // per-process since #270; the legacy shared `<shelf>.md.tmp` is still swept) and
  // `.nb-usage.log.<pid>.tmp` (usage-log compaction, #163) — and never a real
  // notebook, the live usage log, its `.count` sidecar, or the `.nb.lock`.

  test('a planted shelf.md.tmp is removed by the next locked mutation', async () => {
    const orphan = join(dir, 'shelf.md.tmp');
    writeFileSync(orphan, 'crash debris from an interrupted write', 'utf-8');
    expect(existsSync(orphan)).toBe(true);
    // Any locked mutation triggers the reap — add on an UNRELATED shelf so we prove
    // the sweep is dir-wide, not tied to the shelf being written.
    const r = await addEntry(dir, 'patcher', 'a fresh lesson');
    expect(r.added).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  test('a planted per-process shelf temp `<shelf>.md.<pid>.tmp` is reaped too (issue #270)', async () => {
    // Since #270 a durable notebook write renames from `<shelf>.md.<pid>.tmp`, so
    // a crash between its write and rename leaves that per-process orphan — the
    // common case now, not the legacy `<shelf>.md.tmp`. A FOREIGN pid models a
    // *crashed* writer (not this process) and guards against a regex that only
    // swept the legacy name.
    const orphan = join(dir, 'shelf.md.999999.tmp');
    writeFileSync(orphan, 'crash debris from an interrupted per-process write', 'utf-8');
    expect(existsSync(orphan)).toBe(true);
    const r = await addEntry(dir, 'patcher', 'a fresh lesson');
    expect(r.added).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  test('a `.md.<non-numeric>.tmp` is NOT reaped — the sweep stays pinned to a numeric pid (issue #270)', async () => {
    // process.pid is numeric, so the shelf-temp match is `<shelf>.md.tmp` or
    // `<shelf>.md.<digits>.tmp` — never arbitrary `.md.<anything>.tmp`. A file
    // with a non-numeric middle segment is not this writer's convention (and
    // could belong to another tool), so it must survive. This pins the `\d+`
    // precision: the per-pid widening did not turn the sweep into `.md.*.tmp`.
    const foreign = join(dir, 'shelf.md.backup.tmp');
    writeFileSync(foreign, 'not our temp — a non-numeric middle segment', 'utf-8');
    await addEntry(dir, 'patcher', 'triggers a reap');
    expect(existsSync(foreign)).toBe(true);
  });

  test('real *.md notebooks are never deleted by the reap', async () => {
    await addEntry(dir, 'keepme', 'a committed lesson');
    writeFileSync(join(dir, 'orphan.md.tmp'), 'debris', 'utf-8');
    // A later mutation reaps the .md.tmp but must leave every real notebook intact.
    await addEntry(dir, 'other', 'another lesson');
    expect(existsSync(join(dir, 'orphan.md.tmp'))).toBe(false);
    expect(readEntries(dir, 'keepme')).toEqual([{ score: 1, text: 'a committed lesson' }]);
    expect(existsSync(join(dir, 'keepme.md'))).toBe(true);
  });

  test('an orphaned usage-log temp is reaped by the next locked mutation, log + count survive (issue #163)', async () => {
    // A crash between the compaction's `writeFileSync(tmp)` and its `renameSync`
    // leaves a `.nb-usage.log.<pid>.tmp` orphan. Plant one alongside the live log
    // and its sidecar, then run an UNRELATED locked mutation.
    const usage = join(dir, '.nb-usage.log');
    const count = join(dir, '.nb-usage.log.count');
    // A foreign pid (not this process): the orphan is left by a *crashed* writer,
    // so this models the real scenario and guards against a pid-filtering regression.
    const usageTmp = join(dir, '.nb-usage.log.999999.tmp');
    writeFileSync(usage, 'usage rows\n', 'utf-8');
    writeFileSync(count, '1\t11\n', 'utf-8');
    writeFileSync(usageTmp, 'a usage-log temp mid-compact', 'utf-8');
    await addEntry(dir, 'patcher', 'triggers a reap');
    // The orphan temp is gone; the live log and its `.count` sidecar (no `.tmp`
    // suffix) are untouched.
    expect(existsSync(usageTmp)).toBe(false);
    expect(existsSync(usage)).toBe(true);
    expect(existsSync(count)).toBe(true);
  });

  test('reap removes only the usage-log temp — live log, .count sidecar, and .nb.lock all survive (issue #163)', () => {
    // Direct unit test: the `.nb.lock` directory exists only while a lock is held
    // (withLock rmdirs it on release), so a black-box mutation can't observe its
    // survival — call reapLeftoverTemps under a planted lock instead. This pins
    // the surgical match: only `.nb-usage.log.<pid>.tmp` is removed.
    const usage = join(dir, '.nb-usage.log');
    const count = join(dir, '.nb-usage.log.count');
    const lock = join(dir, '.nb.lock');
    // Foreign pid: the orphan is a crashed writer's, and the match is pid-agnostic.
    const usageTmp = join(dir, '.nb-usage.log.424242.tmp');
    writeFileSync(usage, 'usage rows\n', 'utf-8');
    writeFileSync(count, '1\t11\n', 'utf-8');
    mkdirSync(lock); // the lock is a directory, as withLock creates it
    writeFileSync(usageTmp, 'a usage-log temp mid-compact', 'utf-8');

    reapLeftoverTemps(dir);

    expect(existsSync(usageTmp)).toBe(false);
    expect(existsSync(usage)).toBe(true);
    expect(existsSync(count)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });

  test('a dotfile *.md.tmp is NOT reaped (the dotfile guard, isolated)', async () => {
    // A shelf name never starts with `.` (assertSafeShelf), so `.hidden.md.tmp` is
    // not the shelf-temp convention even though it ends in `.md.tmp`, and it is not
    // the usage-log convention either (it lacks the `.nb-usage.log.` prefix). This
    // isolates the `!name.startsWith('.')` half of the shelf-temp guard: a dotfile
    // that DOES end in `.md.tmp` proves that guard is load-bearing.
    const hidden = join(dir, '.hidden.md.tmp');
    writeFileSync(hidden, 'a dotfile that ends in .md.tmp', 'utf-8');
    await addEntry(dir, 'patcher', 'triggers a reap');
    expect(existsSync(hidden)).toBe(true);
  });

  test('a *.md.tmp in a subdirectory is left untouched (reap is non-recursive)', async () => {
    // readdirSync is not recursive: the reap only sweeps the top level of the
    // notebooks dir, so a `.md.tmp` nested one level down survives.
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const nested = join(sub, 'foo.md.tmp');
    writeFileSync(nested, 'debris in a subdir', 'utf-8');
    await addEntry(dir, 'patcher', 'triggers a reap');
    expect(existsSync(nested)).toBe(true);
  });
});

describe('stats notebook inventory (issue #40)', () => {
  test('empty dir: no notebooks, totals zeroed, cap = maxLines()', async () => {
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([]);
    expect(rep.notebookTotals).toEqual({ roles: 0, shelves: 0, lines: 0, cap: maxLines() });
    // additive: the issue #18 fields stay present and unchanged.
    expect(rep.window).toBe('7d'); // default window when none is passed
    expect(rep.perCommand).toEqual([]);
    expect(rep.anomalies).toEqual([]);
  });

  test('one shelf: its line count and cap are reported, with matching totals', async () => {
    await addEntry(dir, 'patcher', 'prefer execFileSync, array args');
    await addEntry(dir, 'patcher', 'run lint before done');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 2, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null }]);
    expect(rep.notebookTotals).toEqual({ roles: 1, shelves: 1, lines: 2, cap: maxLines() });
  });

  test('a shelf at NB_MAX_LINES reports lines === cap, a sibling stays below it', async () => {
    process.env.NB_MAX_LINES = '3';
    for (const l of ['one', 'two', 'three']) await addEntry(dir, 'full', l); // 3/3 — at cap
    await addEntry(dir, 'spare', 'just one'); // 1/3 — below cap
    const rep = stats(dir, { now: Date.now() });
    // Exact rows (sorted). The full shelf's lines equal its cap — the "about to
    // evict" signal — while the sibling, under the same global cap, stays below.
    expect(rep.notebooks).toEqual([
      { role: 'full', shelf: 'full', lines: 3, cap: 3, adds: 0, addsPerDay: 0, retentionDays: null },
      { role: 'spare', shelf: 'spare', lines: 1, cap: 3, adds: 0, addsPerDay: 0, retentionDays: null },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, shelves: 2, lines: 4, cap: 3 });
  });

  test('multiple shelves are listed sorted, with exact rows and aggregate totals', async () => {
    await addEntry(dir, 'zeta', 'a');
    await addEntry(dir, 'alpha', 'b');
    await addEntry(dir, 'alpha', 'c');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([
      { role: 'alpha', shelf: 'alpha', lines: 2, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null },
      { role: 'zeta', shelf: 'zeta', lines: 1, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, shelves: 2, lines: 3, cap: maxLines() });
  });

  test('a shelf filter scopes the inventory to exactly that notebook (exact match, not prefix)', async () => {
    await addEntry(dir, 'patcher', 'x');
    await addEntry(dir, 'patcher2', 'y'); // a prefix-collision sibling: must NOT leak in
    await addEntry(dir, 'cartographer', 'z');
    const rep = stats(dir, { shelf: 'patcher', now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null }]);
    expect(rep.notebookTotals).toEqual({ roles: 1, shelves: 1, lines: 1, cap: maxLines() });
  });

  test('the deprecated role option still scopes the report, and shelf wins when both are given', async () => {
    await addEntry(dir, 'patcher', 'x');
    await addEntry(dir, 'cartographer', 'z');
    expect(stats(dir, { role: 'patcher', now: Date.now() }).notebooks.map((n) => n.shelf)).toEqual(['patcher']);
    expect(
      stats(dir, { shelf: 'cartographer', role: 'patcher', now: Date.now() }).notebooks.map((n) => n.shelf),
    ).toEqual(['cartographer']);
  });

  test('a shelf filter for a shelf with no notebook yields an empty inventory', async () => {
    await addEntry(dir, 'patcher', 'x');
    const rep = stats(dir, { role: 'nobody', now: Date.now() });
    expect(rep.notebooks).toEqual([]);
    expect(rep.notebookTotals).toEqual({ roles: 0, shelves: 0, lines: 0, cap: maxLines() });
  });

  test('sidecar and stray non-shelf files are not counted as notebooks', async () => {
    await addEntry(dir, 'patcher', 'x'); // a real shelf → patcher.md
    logUsage(dir, 'patcher', 'add', true, 1); // writes the .nb-usage.log sidecar
    writeFileSync(join(dir, 'notes.txt'), 'not a role file', 'utf-8');
    writeFileSync(join(dir, '.hidden.md'), 'a dotfile, not a role', 'utf-8');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null }]);
  });

  test('inventory reflects current on-disk state, not the usage window', async () => {
    await addEntry(dir, 'patcher', 'a lesson');
    // A far-future `now` with a 60s window drops every usage row, but the
    // notebook file is still on disk, so the inventory must still report it.
    const rep = stats(dir, { now: Date.now() + 10 * 86_400_000, windowMs: 60_000 });
    expect(rep.totalCalls).toBe(0);
    expect(rep.perCommand).toEqual([]);
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines(), adds: 0, addsPerDay: 0, retentionDays: null }]);
  });
});

describe('core smoke (full learn cycle)', () => {
  test('a full learn cycle leaves a consistent file', async () => {
    await addEntry(dir, 'cartographer', 'tests: vitest run <file>');
    await addEntry(dir, 'cartographer', 'app entry: src/index.ts');
    await vote(dir, 'cartographer', 'tests', 1);
    expect(existsSync(join(dir, 'cartographer.md'))).toBe(true);
    const entries = readEntries(dir, 'cartographer');
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.text.startsWith('tests'))!.score).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Display ordering — how an entry "moves" when its score changes.
//
// These tests pin down the behavior the project README implies with "nb show
// (highest-scored first)", and correct a common misconception: `add` NEVER
// reorders. A lesson is always appended at the end of file order with score
// +1; the file is stored in insertion order, not score order. An entry only
// appears to "move" because the DISPLAY layer (`render` / `nb show`) sorts a
// copy by score descending, breaking ties by insertion order (oldest first).
// So the thing that moves an entry is a `vote` that changes its score relative
// to its neighbors — the move is in the rendered view, never in the file.
// ---------------------------------------------------------------------------
describe('display ordering ("moving" an entry)', () => {
  // Parse `render` output back into a score+text sequence, in display order, so
  // a test can assert the exact ranking a user would see from `nb show`.
  function displayed(shelf: string): { score: number; text: string }[] {
    const out = render(dir, shelf);
    if (out.includes('is empty')) return [];
    return out.split('\n').map((line) => {
      const m = /^\S+\s+\[([+-]\d+)\]\s+(.*)$/.exec(line);
      if (!m) throw new Error(`unparseable render line: ${JSON.stringify(line)}`);
      return { score: Number.parseInt(m[1], 10), text: m[2] };
    });
  }

  // Seed a notebook so each [text, targetScore] reaches targetScore, inserted
  // in the given file order (so tie-break-by-insertion is deterministic).
  // targetScore must be >= 1 since `add` starts every entry at +1.
  async function seed(shelf: string, specs: [string, number][]): Promise<void> {
    for (const [text] of specs) await addEntry(dir, shelf, text);
    for (const [text, score] of specs) {
      for (let s = 1; s < score; s++) await vote(dir, shelf, entryId(text), 1);
    }
  }

  test('seed helper produces the intended display ranking', async () => {
    // Guards the premise of the tests below: scores [4,2,2,2,1] in file order
    // a,b,c,d,e render as [4,2,2,2,1] (ties a,b,c,d keep insertion order).
    await seed('s', [['a', 4], ['b', 2], ['c', 2], ['d', 2], ['e', 1]]);
    expect(displayed('s')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'b' },
      { score: 2, text: 'c' },
      { score: 2, text: 'd' },
      { score: 1, text: 'e' },
    ]);
  });

  test("upvoting a +2 to +3 lifts it to second place — [+4,+2,+2,+2,+1] -> [+4,+3,+2,+2,+1]", async () => {
    await seed('ex', [['a', 4], ['b', 2], ['c', 2], ['d', 2], ['e', 1]]);
    // Upvote the 4th displayed entry (the last of the three tied +2s = 'd').
    const before = displayed('ex');
    expect(before[3]).toEqual({ score: 2, text: 'd' });

    await vote(dir, 'ex', entryId('d'), 1); // d: +2 -> +3

    // d is now strictly above the remaining +2s, so it jumps to position 2.
    expect(displayed('ex')).toEqual([
      { score: 4, text: 'a' },
      { score: 3, text: 'd' },
      { score: 2, text: 'b' },
      { score: 2, text: 'c' },
      { score: 1, text: 'e' },
    ]);
    // The score sequence matches the user's expectation exactly.
    expect(displayed('ex').map((x) => x.score)).toEqual([4, 3, 2, 2, 1]);
  });

  test('a vote MOVES its entry to the fresh end of storage (recency order); display ranks by score', async () => {
    // Storage is now recency order (least-recently-touched first), so a touch
    // moves its line to the end. Build [a,b,c] by plain adds (no reorder yet).
    await addEntry(dir, 'store', 'a');
    await addEntry(dir, 'store', 'b');
    await addEntry(dir, 'store', 'c');
    expect(readEntries(dir, 'store').map((e) => e.text)).toEqual(['a', 'b', 'c']);

    await vote(dir, 'store', entryId('a'), 1); // touch a -> it moves to the END on disk
    expect(readEntries(dir, 'store').map((e) => e.text)).toEqual(['b', 'c', 'a']);
    expect(readEntries(dir, 'store').find((e) => e.text === 'a')!.score).toBe(2);
    // a is now the highest score, so it still displays on top regardless of position.
    expect(displayed('store')[0]).toEqual({ score: 2, text: 'a' });

    await vote(dir, 'store', entryId('b'), -1); // a DOWNVOTE is a touch too -> b to the end
    expect(readEntries(dir, 'store').map((e) => e.text)).toEqual(['c', 'a', 'b']);
  });

  test('an upvote INTO a tie lands at the BOTTOM of its new tier (insertion-order tie-break, not newest-on-top)', async () => {
    // e: +1 -> +2 joins the b,c,d tier. Because tie-break is insertion order and
    // 'e' was inserted last, it sits *below* b,c,d rather than jumping over them.
    await seed('tie', [['a', 4], ['b', 2], ['c', 2], ['d', 2], ['e', 1]]);
    await vote(dir, 'tie', entryId('e'), 1); // e -> +2
    expect(displayed('tie')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'b' },
      { score: 2, text: 'c' },
      { score: 2, text: 'd' },
      { score: 2, text: 'e' },
    ]);
  });

  test('a downvote moves an entry DOWN past lower-scored neighbors, and (being freshly touched) sits at the BOTTOM of its new tier', async () => {
    await seed('down', [['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
    await vote(dir, 'down', entryId('b'), -1); // b: +3 -> +2, ties with c
    // Ties now break by recency: b was just touched (freshest), so it sits BELOW
    // the untouched c within the +2 tier (not above it as insertion order would).
    expect(displayed('down')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'c' },
      { score: 2, text: 'b' },
      { score: 1, text: 'd' },
    ]);
    await vote(dir, 'down', entryId('b'), -1); // b: +2 -> +1, ties with d; b freshest -> below d
    expect(displayed('down')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'c' },
      { score: 1, text: 'd' },
      { score: 1, text: 'b' },
    ]);
  });

  test('`add` does NOT move an entry: a fresh +1 lesson appends last on disk and ranks by score, not recency', async () => {
    await seed('add', [['established', 3]]); // one high-scored lesson
    await addEntry(dir, 'add', 'brand-new'); // +1, newest

    // On disk: appended at the end (insertion order), NOT promoted to the top.
    expect(readEntries(dir, 'add').map((e) => e.text)).toEqual(['established', 'brand-new']);
    // In the view: ranked below the higher-scored lesson despite being newest.
    expect(displayed('add')).toEqual([
      { score: 3, text: 'established' },
      { score: 1, text: 'brand-new' },
    ]);
  });

  test('a lower-scored older entry stays below a higher-scored newer one after add', async () => {
    // Both start at +1, so the initial tie falls back to insertion order (old
    // above new). Upvoting 'new' to +2 then lets it overtake 'old' — the
    // ranking tracks score first, insertion order only to break ties.
    await addEntry(dir, 'race', 'old'); // +1 (file idx 0)
    await addEntry(dir, 'race', 'new'); // +1 (file idx 1)
    expect(displayed('race').map((x) => x.text)).toEqual(['old', 'new']); // tie -> older first
    await vote(dir, 'race', entryId('new'), 1); // new -> +2, overtakes old
    expect(displayed('race')).toEqual([
      { score: 2, text: 'new' },
      { score: 1, text: 'old' },
    ]);
  });
});

describe('notebook metadata / descriptions (issue #70)', () => {
  test('a leading `# key: value` line is metadata, NOT a score-0 lesson', () => {
    // Backward-compatibility hinge: an entry always starts with `±score\t` (or is
    // a bare tab-less lesson), so a `#`-leading `key:` line is unambiguously the
    // description block and must be skipped by readEntries — never surfaced as a
    // lesson the way a hand-edited bare line (FR-MODEL-003) is.
    writeFileSync(
      join(dir, 'm.md'),
      '# desc: build / test gotchas for this repo\n+3\trun build before test\n',
      'utf-8',
    );
    expect(readEntries(dir, 'm')).toEqual([{ score: 3, text: 'run build before test' }]);
    expect(getDescription(dir, 'm')).toBe('build / test gotchas for this repo');
    expect(readMetaLines(dir, 'm')).toEqual(['# desc: build / test gotchas for this repo']);
  });

  test('a CRLF-normalized notebook keeps its `# desc:` metadata (issue #273)', async () => {
    // On Windows with core.autocrlf=true (or any CRLF hand-edit of a git-versioned
    // notebook), every line of `<shelf>.md` arrives terminated by `\r\n`. The split
    // must tolerate the trailing `\r`: otherwise `# desc: ...\r` fails the
    // `$`-anchored META_RE and the description silently decays into a score-0 lesson.
    writeFileSync(
      join(dir, 'm.md'),
      '# desc: build / test gotchas for this repo\r\n+3\trun build before test\r\n',
      'utf-8',
    );
    // The metadata block is preserved verbatim (no stray `\r`), the entry parses,
    // and the description reads back — identical to the LF case above.
    expect(readShelf(dir, 'm')).toEqual({
      metaLines: ['# desc: build / test gotchas for this repo'],
      entries: [{ score: 3, text: 'run build before test' }],
      conflict: null,
    });
    expect(getDescription(dir, 'm')).toBe('build / test gotchas for this repo');

    // A subsequent mutation round-trips the description rather than demoting it to a
    // lesson, and rewrites the file with clean LF endings (not a mixed-ending file).
    await addEntry(dir, 'm', 'a new lesson');
    expect(getDescription(dir, 'm')).toBe('build / test gotchas for this repo');
    expect(readEntries(dir, 'm')).toEqual([
      { score: 3, text: 'run build before test' },
      { score: 1, text: 'a new lesson' },
    ]);
    expect(readFileSync(join(dir, 'm.md'), 'utf-8')).toBe(
      '# desc: build / test gotchas for this repo\n+3\trun build before test\n+1\ta new lesson\n',
    );
  });

  test('a leading UTF-8 BOM does not break the `# desc:` metadata (issue #299)', () => {
    writeFileSync(join(dir, 'm.md'), '\uFEFF# desc: x\n+3\tlesson\n', 'utf-8');
    expect(getDescription(dir, 'm')).toBe('x');
    expect(readMetaLines(dir, 'm')).toEqual(['# desc: x']);
    expect(readEntries(dir, 'm')).toEqual([{ score: 3, text: 'lesson' }]);
    // BOM + CRLF together, and a BOM before a plain entry (no metadata).
    writeFileSync(join(dir, 'c.md'), '\uFEFF# desc: y\r\n+1\tz\r\n', 'utf-8');
    expect(readShelf(dir, 'c')).toEqual({ metaLines: ['# desc: y'], entries: [{ score: 1, text: 'z' }], conflict: null });
    writeFileSync(join(dir, 'e.md'), '\uFEFF+2\tfirst\n', 'utf-8');
    expect(readEntries(dir, 'e')).toEqual([{ score: 2, text: 'first' }]);
  });

  test('only the LEADING block is metadata; a `# key:` line among entries stays a bare lesson', () => {
    // The metadata block ends at the first entry. A `# foo: bar` line AFTER an
    // entry is an ordinary tab-less lesson (FR-MODEL-003 tolerance), not metadata
    // — so readEntries keeps it and readMetaLines does not claim it.
    writeFileSync(
      join(dir, 'm.md'),
      '# desc: top of file\n+1\tfirst lesson\n# late: not metadata\n',
      'utf-8',
    );
    expect(readMetaLines(dir, 'm')).toEqual(['# desc: top of file']);
    expect(readEntries(dir, 'm')).toEqual([
      { score: 1, text: 'first lesson' },
      { score: 0, text: '# late: not metadata' },
    ]);
  });

  test('a `#` comment that is not `key:` shaped is a bare lesson, not metadata', () => {
    // `# just a note` has no `key:` — it does not match the metadata grammar, so
    // it is a tab-less lesson (score 0), exactly as before this feature existed.
    writeFileSync(join(dir, 'm.md'), '# just a note, not key: value\n', 'utf-8');
    expect(isMetaLine('# just a note, not key: value')).toBe(false);
    expect(getDescription(dir, 'm')).toBeNull();
    expect(readEntries(dir, 'm')).toEqual([{ score: 0, text: '# just a note, not key: value' }]);
  });

  test('setDescription writes a leading `# desc:` line and getDescription reads it', async () => {
    await addEntry(dir, 'r', 'a lesson');
    const res = await setDescription(dir, 'r', 'when debugging the build');
    expect(res).toEqual({ role: 'r', shelf: 'r', desc: 'when debugging the build', set: true });
    expect(getDescription(dir, 'r')).toBe('when debugging the build');
    // The description leads the file; the entry follows.
    expect(readFileSync(join(dir, 'r.md'), 'utf-8')).toBe(
      '# desc: when debugging the build\n+1\ta lesson\n',
    );
  });

  test('getDescription is null when no description is set', async () => {
    await addEntry(dir, 'r', 'a lesson');
    expect(getDescription(dir, 'r')).toBeNull();
  });

  test('the description round-trips through every mutation (add/vote/merge/rm/split)', async () => {
    await setDescription(dir, 'r', 'the trigger line');
    await addEntry(dir, 'r', 'alpha');
    await addEntry(dir, 'r', 'beta');
    await addEntry(dir, 'r', 'gamma');
    expect(getDescription(dir, 'r')).toBe('the trigger line'); // survived three adds
    await vote(dir, 'r', entryId('alpha'), 1);
    expect(getDescription(dir, 'r')).toBe('the trigger line'); // survived a vote
    await merge(dir, 'r', entryId('alpha'), entryId('beta'), 'alpha+beta');
    expect(getDescription(dir, 'r')).toBe('the trigger line'); // survived a merge
    await split(dir, 'r', entryId('gamma'), 'gamma one', 'gamma two');
    expect(getDescription(dir, 'r')).toBe('the trigger line'); // survived a split
    await remove(dir, 'r', entryId('gamma one'));
    expect(getDescription(dir, 'r')).toBe('the trigger line'); // survived a rm
  });

  test('the description survives even when the last entry is removed', async () => {
    await setDescription(dir, 'r', 'keep me');
    await addEntry(dir, 'r', 'only lesson');
    await remove(dir, 'r', entryId('only lesson'));
    expect(readEntries(dir, 'r')).toEqual([]);
    expect(getDescription(dir, 'r')).toBe('keep me'); // metadata outlives an emptied notebook
    expect(readFileSync(join(dir, 'r.md'), 'utf-8')).toBe('# desc: keep me\n');
  });

  test('an over-long description is REJECTED, not truncated', async () => {
    process.env.NB_MAX_CHARS = '30';
    await expect(setDescription(dir, 'r', 'x'.repeat(31))).rejects.toThrow(/31 chars; max is 30/);
    expect(getDescription(dir, 'r')).toBeNull(); // nothing stored
    // Exactly at the cap is accepted.
    const ok = await setDescription(dir, 'r', 'y'.repeat(30));
    expect(ok.desc).toHaveLength(30);
  });

  test('setDescription replaces an existing description in place', async () => {
    await setDescription(dir, 'r', 'first');
    await setDescription(dir, 'r', 'second');
    expect(getDescription(dir, 'r')).toBe('second');
    expect(readMetaLines(dir, 'r')).toEqual(['# desc: second']); // one line, not two
  });

  test('an empty text clears the description (removes the # desc: line)', async () => {
    await setDescription(dir, 'r', 'to be cleared');
    await addEntry(dir, 'r', 'a lesson');
    const res = await setDescription(dir, 'r', '');
    expect(res.desc).toBeNull();
    expect(getDescription(dir, 'r')).toBeNull();
    expect(readFileSync(join(dir, 'r.md'), 'utf-8')).toBe('+1\ta lesson\n'); // no metadata line left
  });

  test('a description with tabs/newlines is flattened to one line before storage', async () => {
    await setDescription(dir, 'r', '  trigger\twith\ntabs  ');
    expect(getDescription(dir, 'r')).toBe('trigger with tabs');
  });

  test('unknown metadata keys are preserved verbatim through a mutation and setDescription', async () => {
    // Forward-compatibility: a future/foreign key we do not understand must
    // round-trip byte-for-byte and never be mistaken for a lesson.
    writeFileSync(
      join(dir, 'r.md'),
      '# owner: jean\n# desc: original\n+1\ta lesson\n',
      'utf-8',
    );
    await addEntry(dir, 'r', 'another lesson'); // a mutation that does not touch metadata
    expect(readMetaLines(dir, 'r')).toEqual(['# owner: jean', '# desc: original']);
    await setDescription(dir, 'r', 'updated'); // changes only `desc`, leaves `owner` verbatim
    expect(readMetaLines(dir, 'r')).toEqual(['# owner: jean', '# desc: updated']);
    expect(getMetaValue(readMetaLines(dir, 'r'), 'owner')).toBe('jean');
    expect(readEntries(dir, 'r').map((e) => e.text)).toEqual(['a lesson', 'another lesson']);
  });

  test('setMetaValue appends a new key, rewrites an existing one, and clears on empty', () => {
    expect(setMetaValue([], 'desc', 'hi')).toEqual(['# desc: hi']);
    expect(setMetaValue(['# owner: jean'], 'desc', 'hi')).toEqual(['# owner: jean', '# desc: hi']);
    expect(setMetaValue(['# desc: old', '# owner: jean'], 'desc', 'new')).toEqual([
      '# desc: new',
      '# owner: jean',
    ]);
    expect(setMetaValue(['# desc: old', '# owner: jean'], 'desc', '')).toEqual(['# owner: jean']);
  });
});

describe('listNotebooks — the notebook index (issue #71)', () => {
  test('summarizes each notebook richest-first, ties broken by name', async () => {
    await addEntry(dir, 'reviewer', 'a');
    await addEntry(dir, 'reviewer', 'b'); // 2 lessons
    await addEntry(dir, 'patcher', 'c'); // 1 lesson
    await addEntry(dir, 'planner', 'd'); // 1 lesson
    const listing = listNotebooks(dir);
    expect(listing.dir).toBe(dir);
    expect(listing.total).toBe(3);
    expect(listing.rows.map((r) => r.shelf)).toEqual(['reviewer', 'patcher', 'planner']); // 2, then 1/1 by name
    expect(listing.rows[0]).toMatchObject({ role: 'reviewer', lessons: 2 });
  });

  test('uses the explicit description when set; auto is null', async () => {
    await addEntry(dir, 'r', 'a lesson');
    await setDescription(dir, 'r', 'the trigger');
    const [row] = listNotebooks(dir).rows;
    expect(row).toEqual({ role: 'r', shelf: 'r', lessons: 1, desc: 'the trigger', auto: null });
  });

  test('falls back to the top-scored lesson (auto) when there is no description', async () => {
    await addEntry(dir, 'r', 'low');
    await addEntry(dir, 'r', 'high');
    await vote(dir, 'r', 'high', 1); // high -> +2, the top-scored lesson
    const [row] = listNotebooks(dir).rows;
    expect(row.desc).toBeNull();
    expect(row.auto).toBe('high');
  });

  test('a bare prefix filters by shelf name (the `.` namespace convention)', async () => {
    await addEntry(dir, 'review.security', 'a');
    await addEntry(dir, 'review.perf', 'b');
    await addEntry(dir, 'patcher', 'c');
    const listing = listNotebooks(dir, { prefix: 'review.' });
    expect(listing.total).toBe(2);
    expect(listing.rows.map((r) => r.shelf).sort()).toEqual(['review.perf', 'review.security']);
  });

  test('the `.` delimiter clusters a namespace and excludes a non-namespaced sibling (issue #83)', async () => {
    // The whole point of the `.` convention: `review.` groups the cluster while
    // the bare `reviewer` notebook — which shares the `review` stem but not the
    // `.` boundary — is correctly left out. This is why the recommended prefix
    // carries the trailing dot.
    await addEntry(dir, 'review.tests', 'a');
    await addEntry(dir, 'review.correctness', 'b');
    await addEntry(dir, 'reviewer', 'c'); // shares "review" but is NOT in the namespace
    await addEntry(dir, 'patcher', 'd');
    const group = listNotebooks(dir, { prefix: 'review.' });
    expect(group.total).toBe(2);
    // Lexical clustering ⇒ a predictable, sorted group (ties broken by name).
    expect(group.rows.map((r) => r.shelf)).toEqual(['review.correctness', 'review.tests']);
    // A sub-namespace prefix scopes further still, no new mechanism needed.
    const sub = listNotebooks(dir, { prefix: 'review.t' });
    expect(sub.rows.map((r) => r.shelf)).toEqual(['review.tests']);
  });

  test('limit bounds the rows (richest-first) but total counts every match', async () => {
    await addEntry(dir, 'aaa', '1');
    await addEntry(dir, 'bbb', '1');
    await addEntry(dir, 'ccc', '1');
    const listing = listNotebooks(dir, { limit: 2 });
    expect(listing.total).toBe(3);
    expect(listing.rows).toHaveLength(2);
    const negative = listNotebooks(dir, { limit: -5 });
    expect(negative.rows).toHaveLength(0); // a negative cap is clamped to 0
    expect(negative.total).toBe(3);
  });

  test('hides a zero-lesson, no-description notebook (phantom debris)', async () => {
    // `nb describe <shelf> ""` on a fresh shelf, or `rm` of the last lesson, leaves
    // an empty file with no metadata and no entries — nothing to discover.
    await setDescription(dir, 'phantom', ''); // clears nothing → empty file, no desc
    await addEntry(dir, 'real', 'a lesson');
    const listing = listNotebooks(dir);
    expect(listing.rows.map((r) => r.shelf)).toEqual(['real']);
    expect(listing.total).toBe(1);
  });

  test('keeps a described-but-empty notebook (a deliberate trigger)', async () => {
    await setDescription(dir, 'placeholder', 'open me when onboarding');
    const listing = listNotebooks(dir);
    expect(listing.total).toBe(1);
    expect(listing.rows[0]).toEqual({
      role: 'placeholder',
      shelf: 'placeholder',
      lessons: 0,
      desc: 'open me when onboarding',
      auto: null,
    });
  });

  test('an absent notebooks dir yields an empty listing, not an error', () => {
    const listing = listNotebooks(join(dir, 'does-not-exist'));
    expect(listing.total).toBe(0);
    expect(listing.rows).toEqual([]);
  });
});

describe('search — the demoted keyword fallback (issue #82)', () => {
  test('AND over terms: an entry must contain every term (case-insensitive)', async () => {
    await addEntry(dir, 'reviewer', 'run the Build before vitest');
    await addEntry(dir, 'reviewer', 'build the docs separately');
    const r = search(dir, 'build vitest');
    expect(r.terms).toEqual(['build', 'vitest']);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].shelf).toBe('reviewer');
    expect(r.groups[0].hits.map((h) => h.text)).toEqual(['run the Build before vitest']);
    expect(r.groups[0].hits[0].matched).toBe(2);
    expect(r.groups[0].hits[0].id).toBe(entryId('run the Build before vitest'));
  });

  test('--any is OR: an entry matching a single term is a hit', async () => {
    await addEntry(dir, 'reviewer', 'use a fresh worktree');
    await addEntry(dir, 'patcher', 'files need a lock');
    const and = search(dir, 'worktree lock');
    expect(and.groups).toHaveLength(0); // no single entry has both terms
    const or = search(dir, 'worktree lock', { any: true });
    expect(or.groups.map((g) => g.shelf).sort()).toEqual(['patcher', 'reviewer']);
  });

  test('ranks hits by terms-matched, then score, then file order', async () => {
    await addEntry(dir, 'r', 'alpha beta gamma'); // 3 terms (added first)
    await addEntry(dir, 'r', 'alpha beta'); // 2 terms
    await addEntry(dir, 'r', 'alpha only'); // 1 term, will be upvoted
    await vote(dir, 'r', 'alpha only', 1); // score +2, but fewer terms matched
    const r = search(dir, 'alpha beta gamma', { any: true });
    expect(r.groups[0].hits.map((h) => h.text)).toEqual([
      'alpha beta gamma', // 3 matched — wins despite score +1
      'alpha beta', // 2 matched
      'alpha only', // 1 matched, even though its score is higher
    ]);
  });

  test('matches the description too, and surfaces a notebook on a description-only hit', async () => {
    await addEntry(dir, 'patcher', 'prefer execFileSync over execSync');
    await setDescription(dir, 'patcher', 'concurrency and locking gotchas');
    const r = search(dir, 'concurrency');
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].descMatched).toBe(true);
    expect(r.groups[0].hits).toHaveLength(0); // no entry contains "concurrency"
    expect(r.groups[0].desc).toBe('concurrency and locking gotchas');
  });

  test('a description hit AND an entry hit both show (descMatched true with hits)', async () => {
    await addEntry(dir, 'patcher', 'the lock is a mkdir spinlock');
    await setDescription(dir, 'patcher', 'locking gotchas');
    const r = search(dir, 'lock');
    expect(r.groups[0].descMatched).toBe(true);
    expect(r.groups[0].hits).toHaveLength(1);
  });

  test('prefix scopes to the `.` namespace; description-only groups sort after groups with hits', async () => {
    await addEntry(dir, 'review.security', 'sanitize every lock input');
    await addEntry(dir, 'review.perf', 'cache the lock lookup');
    await addEntry(dir, 'patcher', 'lock files need a spinlock');
    const scoped = search(dir, 'lock', { prefix: 'review.' });
    expect(scoped.groups.map((g) => g.shelf).sort()).toEqual(['review.perf', 'review.security']);
    expect(scoped.groups.some((g) => g.shelf === 'patcher')).toBe(false);
  });

  test('description-only matches rank after entry-hit matches', async () => {
    await addEntry(dir, 'withhit', 'this lesson mentions deadlock twice: deadlock');
    await setDescription(dir, 'desconly', 'deadlock recovery notes');
    const r = search(dir, 'deadlock');
    expect(r.groups.map((g) => g.shelf)).toEqual(['withhit', 'desconly']); // hits first, desc-only last
  });

  test('limit bounds the returned groups to the top-ranked N, after ranking (issue #186)', async () => {
    // Three notebooks all match "lock" with an entry hit; relevance tie-breaks by
    // shelf name, so the bounded set is the first N in that deterministic order.
    await addEntry(dir, 'aaa', 'the lock is held');
    await addEntry(dir, 'bbb', 'release the lock');
    await addEntry(dir, 'ccc', 'lock contention');
    const full = search(dir, 'lock');
    expect(full.groups.map((g) => g.shelf)).toEqual(['aaa', 'bbb', 'ccc']);
    const bounded = search(dir, 'lock', { limit: 2 });
    expect(bounded.groups.map((g) => g.shelf)).toEqual(['aaa', 'bbb']); // top-2, same ranking
  });

  test('limit leaves total and surfacedIds on the FULL result; groups alone are bounded (#186, #114)', async () => {
    await addEntry(dir, 'aaa', 'the lock is held');
    await addEntry(dir, 'bbb', 'release the lock');
    await addEntry(dir, 'ccc', 'lock contention');
    const r = search(dir, 'lock', { limit: 1 });
    expect(r.groups).toHaveLength(1); // only the display is capped
    expect(r.total).toBe(3); // the gap-sensor still sees all three matches
    // Every matching id is surfaced, including the two in the elided groups.
    expect(r.surfacedIds.sort()).toEqual(
      [entryId('the lock is held'), entryId('release the lock'), entryId('lock contention')].sort(),
    );
  });

  test('limit 0 returns no groups yet still reports the match (total>0) — the gap-sensor stays intact', async () => {
    await addEntry(dir, 'r', 'a stored lesson about locks');
    const r = search(dir, 'locks', { limit: 0 });
    expect(r.groups).toEqual([]); // nothing printed
    expect(r.total).toBe(1); // but it WAS a match — a limit can never fabricate a no-match
    expect(r.surfacedIds).toEqual([entryId('a stored lesson about locks')]);
  });

  test('a negative limit clamps to 0 (no groups), never a backwards slice', async () => {
    await addEntry(dir, 'r', 'a stored lesson about locks');
    const r = search(dir, 'locks', { limit: -5 });
    expect(r.groups).toEqual([]);
    expect(r.total).toBe(1);
  });

  test('omitting limit is unbounded — every matching notebook is returned', async () => {
    for (const shelf of ['a', 'b', 'c', 'd', 'e']) await addEntry(dir, shelf, 'lock lesson');
    const r = search(dir, 'lock');
    expect(r.groups).toHaveLength(5);
    expect(r.total).toBe(5);
  });

  test('an empty / whitespace query yields no terms and no groups (never throws)', async () => {
    await addEntry(dir, 'r', 'something');
    expect(search(dir, '   ')).toEqual({ terms: [], groups: [], total: 0, surfacedIds: [], skipped: [], conflicts: [] });
    expect(search(dir, '')).toEqual({ terms: [], groups: [], total: 0, surfacedIds: [], skipped: [], conflicts: [] });
  });

  test('no match returns an empty group list (the gap-sensor case)', async () => {
    await addEntry(dir, 'r', 'a stored lesson');
    const r = search(dir, 'absent-keyword');
    expect(r.terms).toEqual(['absent-keyword']);
    expect(r.groups).toEqual([]);
  });
});

describe('stats add rate, retention window and add-burst (issue #353)', () => {
  const addRows = (shelf: string, session: string, n: number): void => {
    for (let i = 0; i < n; i++) logUsage(dir, shelf, 'add', true, 1, { session, outcome: 'accepted', entries: [`e${i}`] });
  };

  test('a full shelf reports adds, adds/day and cap ÷ adds/day as its retention window', async () => {
    process.env.NB_MAX_LINES = '3';
    for (const l of ['one', 'two', 'three']) await addEntry(dir, 'full', l); // 3/3
    addRows('full', 's1', 7); // 7 accepted adds over a 7d window → 1/day
    const n = stats(dir, { now: Date.now() }).notebooks.find((x) => x.shelf === 'full')!;
    expect(n.adds).toBe(7);
    expect(n.addsPerDay).toBe(1);
    expect(n.retentionDays).toBe(3); // cap 3 ÷ 1 per day
  });

  test('retention is null (not 0 or Infinity) for a full shelf with no adds, and for a shelf below its cap', async () => {
    process.env.NB_MAX_LINES = '2';
    writeFileSync(join(dir, 'full.md'), '1\ta\n1\tb\n', 'utf-8'); // at cap, written outside nb so no usage rows
    writeFileSync(join(dir, 'part.md'), '1\tc\n', 'utf-8');
    addRows('part', 's1', 4); // adds, but below cap
    const rep = stats(dir, { now: Date.now() });
    const full = rep.notebooks.find((x) => x.shelf === 'full')!;
    const part = rep.notebooks.find((x) => x.shelf === 'part')!;
    expect([full.adds, full.retentionDays]).toEqual([0, null]);
    expect([part.adds, part.retentionDays]).toEqual([4, null]);
  });

  test('only accepted adds on THAT shelf inside the window count', async () => {
    process.env.NB_MAX_LINES = '2';
    writeFileSync(join(dir, 'a.md'), '1\tx\n1\ty\n', 'utf-8');
    logUsage(dir, 'a', 'add', true, 1, { session: 's', outcome: 'accepted', entries: ['1'] });
    logUsage(dir, 'a', 'add', true, 1, { session: 's', outcome: 'dedup-blocked' });
    logUsage(dir, 'a', 'vote', true, 1, { session: 's', outcome: 'up', entries: ['1'] });
    logUsage(dir, 'b', 'add', true, 1, { session: 's', outcome: 'accepted', entries: ['2'] });
    expect(stats(dir, { now: Date.now() }).notebooks.find((x) => x.shelf === 'a')!.adds).toBe(1);
    // Outside the window: the same row, observed 30 days later with a 7d window, no longer counts.
    expect(stats(dir, { now: Date.now() + 30 * 86_400_000 }).notebooks.find((x) => x.shelf === 'a')!.adds).toBe(0);
  });

  test('add-burst fires only ABOVE NB_ADD_BURST_N, per (session, shelf)', () => {
    process.env.NB_ADD_BURST_N = '3';
    addRows('s-exact', 'at-threshold', 3); // exactly N: not a burst
    addRows('s-over', 'burst', 4); // N+1: a burst
    addRows('x', 'split', 2);
    addRows('y', 'split', 2); // 4 in one session but 2 per shelf: not a burst
    const sigs = stats(dir).signals.filter((g) => g.kind === 'add-burst');
    expect(sigs.map((g) => [g.shelf, g.session])).toEqual([['s-over', 'burst']]);
    expect(sigs[0].detail).toContain('4 accepted adds');
  });

  test('add-burst ignores blank sessions, non-accepted adds, and respects the default threshold', () => {
    addRows('s', '', 40); // blank session cannot be grouped
    for (let i = 0; i < 40; i++) logUsage(dir, 's', 'add', true, 1, { session: 'dup', outcome: 'dedup-blocked' });
    addRows('s', 'ok', 15); // default N is 15: exactly 15 is not a burst
    expect(stats(dir).signals.some((g) => g.kind === 'add-burst')).toBe(false);
    addRows('s', 'ok', 1);
    expect(stats(dir).signals.filter((g) => g.kind === 'add-burst')).toHaveLength(1);
  });
});

describe('failed-search → add gap signal (issue #82)', () => {
  // The gap-sensor: a no-match search followed by an accepted add in the SAME
  // session is a coverage gap. logUsage writes the rows a real run would; stats
  // reads them back as a `failed-search` DiagnosticSignal.
  test('a no-match search then an accepted add in one session flags a gap, labelled by the query', () => {
    logUsage(dir, '-', 'search', true, 1, { session: 's1', outcome: 'no-match', note: 'rate limiting' });
    logUsage(dir, 'reviewer', 'add', true, 1, { session: 's1', outcome: 'accepted', entries: ['abc123'] });
    const sig = stats(dir).signals.find((s) => s.kind === 'failed-search');
    expect(sig).toBeDefined();
    expect(sig!.shelf).toBe('reviewer');
    expect(sig!.session).toBe('s1');
    expect(sig!.entry).toBe('abc123');
    expect(sig!.detail).toContain('rate limiting');
  });

  test('a MATCHED search then an add is NOT a gap', () => {
    logUsage(dir, 's2', 'search', true, 1, { session: 's2', outcome: 'match', note: 'build' });
    logUsage(dir, 'reviewer', 'add', true, 1, { session: 's2', outcome: 'accepted', entries: ['def456'] });
    expect(stats(dir).signals.some((s) => s.kind === 'failed-search')).toBe(false);
  });

  test('an add BEFORE the failed search (not after) is not attributed as a gap', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    // Write rows then rewrite timestamps so the add precedes the search in-session.
    logUsage(dir, 'reviewer', 'add', true, 1, { session: 's3', outcome: 'accepted', entries: ['aaa111'] });
    logUsage(dir, '-', 'search', true, 1, { session: 's3', outcome: 'no-match', note: 'late query' });
    const file = join(dir, '.nb-usage.log');
    const rows = readFileSync(file, 'utf-8').trimEnd().split('\n');
    // Force add (row 0) earlier than search (row 1).
    const withTs = [
      rows[0].replace(/^[^\t]+/, new Date(base).toISOString()),
      rows[1].replace(/^[^\t]+/, new Date(base + 1000).toISOString()),
    ];
    writeFileSync(file, withTs.join('\n') + '\n');
    expect(stats(dir).signals.some((s) => s.kind === 'failed-search')).toBe(false);
  });

  test('the gap signal needs a session on both rows (blank session is skipped)', () => {
    logUsage(dir, '-', 'search', true, 1, { session: '', outcome: 'no-match', note: 'q' });
    logUsage(dir, 'reviewer', 'add', true, 1, { session: '', outcome: 'accepted', entries: ['zzz999'] });
    expect(stats(dir).signals.some((s) => s.kind === 'failed-search')).toBe(false);
  });
});

// issue #166 — `notebookExists` lets a caller tell a never-created shelf apart
// from an existing but empty one (both of which `readEntries` returns `[]` for).
describe('notebookExists / showJson exists flag (issue #166)', () => {
  test('false for a never-created shelf, true once the file exists', async () => {
    expect(notebookExists(dir, 'ghost')).toBe(false); // nothing written yet
    expect(readEntries(dir, 'ghost')).toEqual([]); // same empty read as an empty shelf

    // A describe-only shelf writes the file (metadata, no lessons): it now exists
    // though it holds no entries — exactly the case `render()` calls "(… empty)".
    await setDescription(dir, 'ghost', 'd');
    expect(notebookExists(dir, 'ghost')).toBe(true);
    expect(readEntries(dir, 'ghost')).toEqual([]);

    // An added lesson keeps it existing.
    await addEntry(dir, 'ghost', 'a lesson');
    expect(notebookExists(dir, 'ghost')).toBe(true);
  });

  test('showJson carries exists: false for a missing shelf, true for a describe-only one', async () => {
    expect(showJson(dir, 'ghost').exists).toBe(false);
    await setDescription(dir, 'ghost', 'd');
    const sh = showJson(dir, 'ghost');
    expect(sh.exists).toBe(true);
    expect(sh.entries).toEqual([]); // additive flag, entries stays empty
  });
});

describe('showJson key + showJsonMany batch (issue #286)', () => {
  test('each entry carries the dedupKey normal form as `key`', async () => {
    await addEntry(dir, 'alpha', 'Use execFileSync, NOT execSync!');
    const sh = showJson(dir, 'alpha');
    expect(sh.entries[0].key).toBe(dedupKey('Use execFileSync, NOT execSync!'));
    expect(sh.entries[0].key).toBe('use execfilesync not execsync');
    // Equality-only: entries share a `key` iff they share an `id` (both hash the
    // same normal form), so key-equality is exactly the exact-dupe relation.
    await addEntry(dir, 'beta', 'use execfilesync not execsync');
    const b = showJson(dir, 'beta');
    expect(b.entries[0].key).toBe(sh.entries[0].key);
    expect(b.entries[0].id).toBe(sh.entries[0].id);
  });

  test('showJsonMany returns one ShowResult per shelf, in order, missing → exists:false', async () => {
    await addEntry(dir, 'alpha', 'alpha lesson');
    await setDescription(dir, 'alpha', 'A');
    await addEntry(dir, 'beta', 'beta lesson');
    const batch = showJsonMany(dir, ['alpha', 'ghost', 'beta']);
    expect(batch.map((s) => s.shelf)).toEqual(['alpha', 'ghost', 'beta']);
    expect(batch[0]).toMatchObject({ description: 'A', exists: true });
    expect(batch[0].entries[0]).toMatchObject({ text: 'alpha lesson', key: 'alpha lesson' });
    expect(batch[1]).toMatchObject({ shelf: 'ghost', exists: false, entries: [] });
    expect(batch[2].entries[0]).toMatchObject({ text: 'beta lesson' });
  });

  test('showJsonMany on an empty list yields an empty array (no shelves asked, none returned)', () => {
    expect(showJsonMany(dir, [])).toEqual([]);
  });

  test('showJsonMany reads a repeated shelf once per occurrence, verbatim (no implicit dedup)', async () => {
    await addEntry(dir, 'alpha', 'alpha lesson');
    const batch = showJsonMany(dir, ['alpha', 'alpha']);
    expect(batch).toHaveLength(2);
    expect(batch[0]).toEqual(batch[1]);
  });
});

describe('staleCandidates (nb stale — cull candidates, issue #240)', () => {
  test('ranks lowest score first, ties broken by stalest (file order)', async () => {
    // add a,b,c,d (all +1, file order a,b,c,d), then lift a to +3 and b to +2.
    // A vote moves the touched entry to the fresh end, so c and d (never voted)
    // stay the stalest +1 floor, c before d.
    for (const t of ['a', 'b', 'c', 'd']) await addEntry(dir, 's', t);
    await vote(dir, 's', entryId('a'), 1); // a -> +2
    await vote(dir, 's', entryId('a'), 1); // a -> +3
    await vote(dir, 's', entryId('b'), 1); // b -> +2
    const r = staleCandidates(dir, 's');
    // scores a+3, b+2, c+1, d+1 → stale order: c,d (both +1, c staler), b(+2), a(+3).
    expect(r.entries.map((e) => e.text)).toEqual(['c', 'd', 'b', 'a']);
    expect(r.entries.map((e) => e.score)).toEqual([1, 1, 2, 3]);
    expect(r.total).toBe(4);
    expect(r.exists).toBe(true);
  });

  test('a negatively-scored (downvoted) lesson sorts to the very top of the cull list', async () => {
    for (const t of ['keep', 'bad']) await addEntry(dir, 's', t);
    await vote(dir, 's', entryId('bad'), -1); // bad: +1 -> 0
    await vote(dir, 's', entryId('bad'), -1); // bad: 0 -> -1
    const r = staleCandidates(dir, 's');
    expect(r.entries[0]).toMatchObject({ text: 'bad', score: -1 });
  });

  test('--limit caps the list but total reflects the whole shelf', async () => {
    for (const t of ['a', 'b', 'c']) await addEntry(dir, 's', t);
    const r = staleCandidates(dir, 's', 2);
    expect(r.entries).toHaveLength(2);
    expect(r.total).toBe(3);
    // limit 0 returns an empty list but still reports the full total.
    expect(staleCandidates(dir, 's', 0).entries).toEqual([]);
    expect(staleCandidates(dir, 's', 0).total).toBe(3);
  });

  test('is strictly read-only — scores and file order are untouched', async () => {
    for (const t of ['a', 'b', 'c']) await addEntry(dir, 's', t);
    await vote(dir, 's', entryId('b'), 1);
    const before = readEntries(dir, 's').map((e) => ({ score: e.score, text: e.text }));
    staleCandidates(dir, 's');
    staleCandidates(dir, 's', 1);
    const after = readEntries(dir, 's').map((e) => ({ score: e.score, text: e.text }));
    expect(after).toEqual(before); // no reorder, no score change, nothing removed
  });

  test('a missing shelf is exists:false/empty; a describe-only shelf is exists:true/empty (issue #166)', async () => {
    const miss = staleCandidates(dir, 'ghost');
    expect(miss.exists).toBe(false);
    expect(miss.entries).toEqual([]);
    expect(miss.total).toBe(0);
    await setDescription(dir, 'ghost', 'a trigger with no lessons');
    const empty = staleCandidates(dir, 'ghost');
    expect(empty.exists).toBe(true);
    expect(empty.total).toBe(0);
    expect(empty.entries).toEqual([]);
  });
});

describe('single-pass shelf read — list/search/show read each file once (issue #201)', () => {
  // Count how many times each `<shelf>.md` is read via readFileSync. Only shelf
  // files end in `.md`; the usage log (`.nb-usage.log`) and its `.count` sidecar
  // never match, so this isolates the per-shelf disk reads the issue targets.
  const countShelfReads = (reads: string[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const p of reads) {
      const m = /([^/\\]+)\.md$/.exec(p);
      if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    return counts;
  };

  // Seed three shelves, each with a `# desc:` line AND entries, so both the
  // metadata read and the entries read have real work to do (the double-read
  // the old code paid). `lint` appears in each so a single `search` term hits all.
  const seedShelves = async (): Promise<void> => {
    for (const s of ['alpha', 'beta', 'gamma']) {
      await addEntry(dir, s, `first ${s} lesson`);
      await addEntry(dir, s, `second ${s} lesson about lint`);
      await setDescription(dir, s, `when working on ${s}`);
    }
  };

  // Run `fn` with the readFileSync spy on, returning its result and read paths.
  const withReadSpy = async <T>(fn: () => T | Promise<T>): Promise<{ result: T; reads: string[] }> => {
    fsHook.reads = [];
    try {
      const result = await fn();
      return { result, reads: fsHook.reads! };
    } finally {
      fsHook.reads = null;
    }
  };

  test('listNotebooks reads each shelf file exactly once', async () => {
    await seedShelves();
    const { result, reads } = await withReadSpy(() => listNotebooks(dir));
    expect(result.rows.map((r) => r.shelf)).toEqual(['alpha', 'beta', 'gamma']);
    expect(countShelfReads(reads)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
  });

  test('search reads each shelf file exactly once', async () => {
    await seedShelves();
    const { result, reads } = await withReadSpy(() => search(dir, 'lint'));
    expect(result.groups.map((g) => g.shelf)).toEqual(['alpha', 'beta', 'gamma']);
    expect(countShelfReads(reads)).toEqual({ alpha: 1, beta: 1, gamma: 1 });
  });

  test('showJson reads the shelf file exactly once', async () => {
    await seedShelves();
    const { result, reads } = await withReadSpy(() => showJson(dir, 'alpha'));
    expect(result.description).toBe('when working on alpha');
    // Exact entries (id/score/text/order), so a wrong read wouldn't slip past a
    // mere length check.
    expect(result.entries).toEqual([
      { id: entryId('first alpha lesson'), score: 1, text: 'first alpha lesson', key: 'first alpha lesson' },
      {
        id: entryId('second alpha lesson about lint'),
        score: 1,
        text: 'second alpha lesson about lint',
        key: 'second alpha lesson about lint',
      },
    ]);
    expect(countShelfReads(reads)).toEqual({ alpha: 1 });
  });

  test('the `nb show` CLI branch (no --json) reads the shelf file exactly once', async () => {
    // The actual changed call site (cli.ts show branch) — it used to read twice
    // (getDescription then render→readEntries). Drive it in-process so the fs spy
    // sees its reads; swallow its stdout/stderr and point NB_DIR at the temp dir.
    await seedShelves();
    const savedDir = process.env.NB_DIR;
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.env.NB_DIR = dir;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      const { result, reads } = await withReadSpy(() => runNbCli(['show', 'alpha']));
      expect(result).toBe(0); // exit 0
      expect(countShelfReads(reads)).toEqual({ alpha: 1 });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      if (savedDir === undefined) delete process.env.NB_DIR;
      else process.env.NB_DIR = savedDir;
    }
  });

  test('readShelf keeps a mid-file `# key:` line out of metadata and as a score-0 lesson (FR-MODEL-003)', () => {
    const shelf = 'midmeta';
    // Hand-written file: a two-line leading metadata block, a scored entry, then a
    // `# key:`-shaped line sitting AMONG the entries. Only the leading run is
    // metadata; the mid-file line must stay an ordinary score-0 lesson. Literal
    // expectations (not a comparison to readMetaLines/readEntries, which now
    // delegate to readShelf) so a regression that flipped `inMeta` back on would
    // fail here.
    writeFileSync(
      join(dir, `${shelf}.md`),
      '# desc: leading description\n' +
        '# owner: alice\n' +
        '+2\ta real lesson\n' +
        '# notakey: a mid-file pseudo-meta line\n',
      'utf-8',
    );
    const { metaLines, entries } = readShelf(dir, shelf);
    expect(metaLines).toEqual(['# desc: leading description', '# owner: alice']);
    expect(entries).toEqual([
      { score: 2, text: 'a real lesson' },
      { score: 0, text: '# notakey: a mid-file pseudo-meta line' },
    ]);
  });

  test('readShelf returns empty metadata and entries for a never-created shelf', () => {
    expect(readShelf(dir, 'never-created')).toEqual({ metaLines: [], entries: [], conflict: null });
  });

  test('readShelf treats an ENOENT between existsSync and readFileSync as an empty shelf (issue #300)', () => {
    writeFileSync(join(dir, 'raced.md'), '# desc: x\n1\tlesson\n');
    fsHook.failReadOnceCode = 'ENOENT';
    expect(readShelf(dir, 'raced')).toEqual({ metaLines: [], entries: [], conflict: null });
    expect(fsHook.failReadOnceCode).toBeNull(); // the injected failure was actually consumed
  });

  test('readShelf still propagates non-ENOENT read errors (issue #300)', () => {
    writeFileSync(join(dir, 'denied.md'), '# desc: x\n1\tlesson\n');
    fsHook.failReadOnceCode = 'EACCES';
    expect(() => readShelf(dir, 'denied')).toThrow(/EACCES/);
  });

  test('renderEntries renders ids+scores highest-first, with the empty line verbatim', async () => {
    await addEntry(dir, 'r', 'first lesson');
    await addEntry(dir, 'r', 'second lesson'); // equal +1 scores → insertion-order tie-break
    // Literal expected output pins the format (two-space gaps, `[+N]` sign,
    // score-desc order) directly, not by comparison to `render` (which now
    // delegates to `renderEntries`).
    expect(renderEntries('r', readEntries(dir, 'r'))).toBe(
      `${entryId('first lesson')}  [+1]  first lesson\n` +
        `${entryId('second lesson')}  [+1]  second lesson`,
    );
    // No entries → the exact empty-notebook line the `show` command prints for an
    // existing-but-empty shelf.
    expect(renderEntries('empty-shelf', [])).toBe('(notebook for shelf "empty-shelf" is empty)');
  });
});

describe('one unreadable shelf does not abort list/search (issue #332)', () => {
  // A directory named `<shelf>.md` makes readFileSync throw EISDIR — the same
  // shape a root-owned/chmod'd file (EACCES) or an EIO read produces, and the
  // reproduction the issue cites. `show` must still fail loudly for it; the two
  // cross-shelf scans must degrade to a reported skip and keep the healthy rows.
  const seedHealthy = async (): Promise<void> => {
    await addEntry(dir, 'alpha', 'a lesson about lint');
    await addEntry(dir, 'beta', 'another lesson about lint');
  };

  test('listNotebooks skips an unreadable shelf, keeps the rest, and reports it', async () => {
    await seedHealthy();
    mkdirSync(join(dir, 'weird.md'));
    const listing = listNotebooks(dir);
    expect(listing.rows.map((r) => r.shelf)).toEqual(['alpha', 'beta']);
    expect(listing.total).toBe(2);
    expect(listing.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
  });

  test('search skips an unreadable shelf, keeps the rest, and reports it', async () => {
    await seedHealthy();
    mkdirSync(join(dir, 'weird.md'));
    const result = search(dir, 'lint');
    expect(result.groups.map((g) => g.shelf)).toEqual(['alpha', 'beta']);
    expect(result.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
  });

  test('a healthy store reports no skipped shelves (byte-identical path)', async () => {
    await seedHealthy();
    expect(listNotebooks(dir).skipped).toEqual([]);
    expect(search(dir, 'lint').skipped).toEqual([]);
  });

  test('an unreadable-by-permission shelf (EACCES) is skipped with its real errno', async (ctx) => {
    // The issue's motivating case is EACCES on a root-owned / chmod'd file after
    // `sudo nb`, which EISDIR does not exercise. A root-owned file is still
    // readable by root, so skip there where chmod cannot deny access.
    if (process.getuid?.() === 0) ctx.skip();
    await seedHealthy();
    writeFileSync(join(dir, 'denied.md'), '1\tlesson about lint\n');
    chmodSync(join(dir, 'denied.md'), 0o000);
    try {
      expect(listNotebooks(dir).skipped).toEqual([{ shelf: 'denied', code: 'EACCES' }]);
      expect(search(dir, 'lint').skipped).toEqual([{ shelf: 'denied', code: 'EACCES' }]);
      expect(stats(dir, { now: Date.now() }).skipped).toEqual([{ shelf: 'denied', code: 'EACCES' }]);
    } finally {
      chmodSync(join(dir, 'denied.md'), 0o600);
    }
  });

  test('show still fails loudly for the unreadable shelf (no silent hide)', async () => {
    mkdirSync(join(dir, 'weird.md'));
    expect(() => showJson(dir, 'weird')).toThrow(/EISDIR/);
  });
});

describe('one unreadable shelf does not abort the stats inventory (issue #332)', () => {
  // `stats` is the health scan an operator (and nb-janitor) runs to find out why
  // memory is unhealthy — so it too must survive a damaged store, reporting the
  // casualty instead of aborting the whole report (the issue's motivating case).
  test('stats skips the unreadable shelf, keeps every healthy one, and reports it', async () => {
    await addEntry(dir, 'alpha', 'a lesson about lint');
    await addEntry(dir, 'beta', 'another lesson about lint');
    mkdirSync(join(dir, 'weird.md'));
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks.map((n) => n.shelf)).toEqual(['alpha', 'beta']);
    expect(rep.notebookTotals).toEqual({ roles: 2, shelves: 2, lines: 2, cap: maxLines() });
    expect(rep.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
  });

  test('a healthy store reports no skipped shelves in stats (byte-identical path)', async () => {
    await addEntry(dir, 'alpha', 'a lesson');
    expect(stats(dir, { now: Date.now() }).skipped).toEqual([]);
  });
});

describe('skipUnreadable only swallows real errno read failures (issue #332)', () => {
  // Finding: guarding EVERY throw converts a parser/programming bug (no errno
  // `code`) into a silent "shelf skipped, code EUNKNOWN" and a success exit — the
  // opposite of the issue's "surface it, never silent". A codeless throw must
  // propagate unchanged; only a throw carrying an errno becomes a skip.
  test('a codeless throw propagates out of listNotebooks instead of being hidden', async () => {
    await addEntry(dir, 'alpha', 'a lesson');
    writeFileSync(join(dir, 'weird.md'), '1\tlesson\n');
    fsHook.failCodelessRead = true;
    expect(() => listNotebooks(dir)).toThrow(TypeError);
  });
});

describe('single shelf read per mutation — add/vote/voteMany/merge/split read the file once (issue #251)', () => {
  // The mutation hot path used to read each shelf twice: once for entries
  // (readEntries) and again for the metadata block inside writeEntries
  // (readMetaLines). Reading once via readShelf and passing metaLines through
  // collapses that to a single read, exactly as remove() already did (issue #209).
  // These tests pin BOTH halves of the fix: one shelf read per mutation, and a
  // byte-for-byte-preserved metadata block (no observable behavior change).

  // Count readFileSync hits per `<shelf>.md`. Only shelf files end in `.md`; the
  // usage log and its `.count` sidecar never match, so this isolates the per-shelf
  // disk reads the issue targets.
  const countShelfReads = (reads: string[]): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const p of reads) {
      const m = /([^/\\]+)\.md$/.exec(p);
      if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    return counts;
  };

  // Run `fn` with the readFileSync spy on, returning its result and read paths.
  const withReadSpy = async <T>(fn: () => T | Promise<T>): Promise<{ result: T; reads: string[] }> => {
    fsHook.reads = [];
    try {
      const result = await fn();
      return { result, reads: fsHook.reads! };
    } finally {
      fsHook.reads = null;
    }
  };

  // The shelf file's leading `# key:` metadata block as raw bytes (every line up
  // to the first non-metadata line) — what a mutation must round-trip untouched.
  const metaBlock = (shelf: string): string => {
    const out: string[] = [];
    for (const line of readFileSync(join(dir, `${shelf}.md`), 'utf-8').split('\n')) {
      if (line.startsWith('# ')) out.push(line);
      else break;
    }
    return out.join('\n');
  };

  // Seed a shelf with a TWO-line metadata block (a known `# desc:` key plus an
  // unknown `# owner:` key, to exercise the forward-compatible round-trip of an
  // unrecognized key) AND real entries, so both the metadata and the entries read
  // have work to do — the double read the old code paid on every mutation.
  const seed = async (shelf: string, ...lessons: string[]): Promise<void> => {
    for (const l of lessons) await addEntry(dir, shelf, l);
    await setDescription(dir, shelf, `when working on ${shelf}`);
    const file = join(dir, `${shelf}.md`);
    // Prepend an unknown metadata key by hand (setDescription only writes `# desc:`).
    writeFileSync(file, '# owner: alice\n' + readFileSync(file, 'utf-8'), 'utf-8');
  };

  test('addEntry reads the shelf once and preserves the metadata block', async () => {
    await seed('add', 'first add lesson');
    const meta = metaBlock('add');
    expect(meta).toBe('# owner: alice\n# desc: when working on add');
    const { result, reads } = await withReadSpy(() => addEntry(dir, 'add', 'a brand new lesson'));
    expect(result.added).toBe(true);
    expect(result.size).toBe(2); // the new lesson joined the seeded one
    expect(countShelfReads(reads)).toEqual({ add: 1 }); // one read, not two
    expect(metaBlock('add')).toBe(meta); // byte-for-byte metadata round-trip
    // The new lesson is on disk alongside the original — behavior is unchanged.
    expect(readEntries(dir, 'add').map((e) => e.text)).toEqual(['first add lesson', 'a brand new lesson']);
  });

  test('vote reads the shelf once and preserves the metadata block', async () => {
    await seed('vote', 'a votable lesson');
    const meta = metaBlock('vote');
    const { result, reads } = await withReadSpy(() => vote(dir, 'vote', 'a votable lesson', 1));
    expect(result).toEqual({ text: 'a votable lesson', score: 2 }); // +1 applied
    expect(countShelfReads(reads)).toEqual({ vote: 1 });
    expect(metaBlock('vote')).toBe(meta);
    // Re-read from disk: the bumped score must have been PERSISTED, not just
    // returned (a return-value-only check can't see a write that dropped it).
    expect(readEntries(dir, 'vote')).toEqual([{ score: 2, text: 'a votable lesson' }]);
  });

  test('voteMany reads the shelf once and preserves the metadata block', async () => {
    await seed('votemany', 'lesson one', 'lesson two');
    const meta = metaBlock('votemany');
    const { result, reads } = await withReadSpy(() => voteMany(dir, 'votemany', ['lesson one', 'lesson two'], 1));
    expect(result.map((r) => r.score)).toEqual([2, 2]); // both bumped under one read+write
    expect(countShelfReads(reads)).toEqual({ votemany: 1 });
    expect(metaBlock('votemany')).toBe(meta);
    // Both bumped scores must be PERSISTED (not just reported), with the touched
    // entries kept in their fresh-end order.
    expect(readEntries(dir, 'votemany')).toEqual([
      { score: 2, text: 'lesson one' },
      { score: 2, text: 'lesson two' },
    ]);
  });

  test('merge reads the shelf once and preserves the metadata block', async () => {
    await seed('merge', 'alpha lesson', 'beta lesson');
    const meta = metaBlock('merge');
    const { result, reads } = await withReadSpy(() => merge(dir, 'merge', 'alpha lesson', 'beta lesson', 'merged lesson'));
    expect(result.added).toBe(true);
    expect(result.size).toBe(1); // 2 → 1
    expect(countShelfReads(reads)).toEqual({ merge: 1 });
    expect(metaBlock('merge')).toBe(meta);
    expect(readEntries(dir, 'merge').map((e) => e.text)).toEqual(['merged lesson']);
  });

  test('split reads the shelf once and preserves the metadata block', async () => {
    await seed('split', 'overloaded lesson');
    const meta = metaBlock('split');
    const { result, reads } = await withReadSpy(() => split(dir, 'split', 'overloaded lesson', 'first half', 'second half'));
    expect(result.size).toBe(2); // 1 → 2
    expect(countShelfReads(reads)).toEqual({ split: 1 });
    expect(metaBlock('split')).toBe(meta);
    expect(readEntries(dir, 'split').map((e) => e.text)).toEqual(['first half', 'second half']);
  });
});

describe('shelf terminology (role kept as a deprecated alias)', () => {
  test('listShelves is the same function as the deprecated listRoles', async () => {
    expect(listRoles).toBe(listShelves);
    await addEntry(dir, 'alpha', 'a');
    await addEntry(dir, 'beta', 'b');
    expect(listShelves(dir)).toEqual(['alpha', 'beta']);
    expect(listRoles(dir)).toEqual(listShelves(dir));
  });

  test('assertSafeShelf is the same function as the deprecated assertSafeRole', () => {
    expect(assertSafeRole).toBe(assertSafeShelf);
    expect(() => assertSafeShelf('../escape')).toThrow(/invalid shelf name/);
  });

  test('every JSON-facing object carries `shelf` equal to `role`', async () => {
    await addEntry(dir, 'patcher', 'run lint');
    await setDescription(dir, 'patcher', 'when patching');
    const sh = showJson(dir, 'patcher');
    expect(sh.shelf).toBe(sh.role);
    const [row] = listNotebooks(dir).rows;
    expect(row.shelf).toBe(row.role);
    const [grp] = search(dir, 'lint').groups;
    expect(grp.shelf).toBe(grp.role);
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks[0].shelf).toBe(rep.notebooks[0].role);
    expect(rep.notebookTotals.shelves).toBe(rep.notebookTotals.roles);
  });
});

// RFC 0118 — direct, behavioral unit tests for the exported window helpers.
// The CLI `--since` path (src/cli.test.ts) only asserts the rendered window
// label, so each multiplier, both default-fallback branches, and both sides of
// `isValidWindow` are otherwise unpinned. Assertions are input→output only, to
// stay decoupled from the shared WINDOW_RE and the internal ms constants.
describe('window helpers (parseWindowMs / isValidWindow)', () => {
  const DAY_MS = 24 * 3600_000;

  describe('parseWindowMs', () => {
    test.each([
      ['7d', 604_800_000], // d multiplier (86_400_000)
      ['12h', 43_200_000], // h multiplier (3_600_000)
      ['30m', 1_800_000], // m multiplier (60_000)
    ])('%s parses to %d ms', (raw, expected) => {
      expect(parseWindowMs(raw)).toBe(expected);
    });

    test('falsy input falls back to the 7-day default', () => {
      // Pins the `if (!raw)` short-circuit branch specifically.
      expect(parseWindowMs(undefined)).toBe(7 * DAY_MS);
      expect(parseWindowMs('')).toBe(7 * DAY_MS);
    });

    test('an unrecognized window falls back to the 7-day default', () => {
      // `'7days'` matches no WINDOW_RE unit — pins the `if (!m)` branch, which
      // is a different return from the falsy branch above.
      expect(parseWindowMs('7days')).toBe(7 * DAY_MS);
      expect(parseWindowMs('abc')).toBe(7 * DAY_MS);
    });

    test('surrounding whitespace is trimmed before parsing', () => {
      expect(parseWindowMs('  12h  ')).toBe(43_200_000);
    });
  });

  describe('isValidWindow', () => {
    test.each(['7d', '12h', '30m', ' 7d '])('accepts %s', (raw) => {
      expect(isValidWindow(raw)).toBe(true);
    });

    test.each([
      ['7days', 'a plausible mistype the --since guard exists for'],
      ['', 'empty string'],
      ['abc', 'no digit/unit'],
      ['7', 'digit without a unit'],
    ])('rejects %s (%s)', (raw) => {
      expect(isValidWindow(raw)).toBe(false);
    });

    test('rejects undefined', () => {
      expect(isValidWindow(undefined)).toBe(false);
    });

    test('the 7d / 7days split the CLI warning depends on holds', () => {
      // The load-bearing pair: the guard must accept the real window and reject
      // the mistype that parseWindowMs would otherwise silently coerce to 7d.
      expect(isValidWindow('7d')).toBe(true);
      expect(isValidWindow('7days')).toBe(false);
    });
  });
});

describe('env-tunable clamps (boundary + garbage)', () => {
  // Every NB_* numeric tunable is read at call time through clampInt or
  // clampRate (notebook.ts). The behavioral cap tests elsewhere set these vars
  // only to valid, in-range values; these tests pin the clamp CONTRACT itself —
  // an out-of-range value is clamped to the stated bound, and a non-numeric
  // value falls back to the default (never NaN, which would silently disable the
  // thing the tunable gates). A regression in a clamp bound, or a NaN leak, is
  // invisible to the in-range tests but fails here. The asserted bounds mirror
  // the clampInt/clampRate arguments in notebook.ts exactly; afterEach already
  // restores every NB_* var touched here.

  describe('clampInt-backed integer caps', () => {
    // [label, getter, env var, lo, hi, default] — mirrors notebook.ts maxLines
    // (1/5000, dflt 50), maxChars (20/2000, dflt 200), usageRing (100/100000,
    // dflt 5000). Only the exported getters are driven directly.
    const INT_GETTERS: ReadonlyArray<[string, () => number, string, number, number, number]> = [
      ['maxLines', maxLines, 'NB_MAX_LINES', 1, 5000, 50],
      ['maxChars', maxChars, 'NB_MAX_CHARS', 20, 2000, 200],
      ['usageRing', usageRing, 'NB_USAGE_RING', 100, 100000, 5000],
    ];

    describe.each(INT_GETTERS)('%s', (_label, getter, envVar, lo, hi, dflt) => {
      test(`below-min (${lo - 1}) clamps up to lo (${lo})`, () => {
        process.env[envVar] = String(lo - 1);
        expect(getter()).toBe(lo);
      });

      test(`above-max (${hi + 1}) clamps down to hi (${hi})`, () => {
        process.env[envVar] = String(hi + 1);
        expect(getter()).toBe(hi);
      });

      test(`a non-numeric value falls back to the default (${dflt}), never NaN`, () => {
        process.env[envVar] = 'abc';
        const v = getter();
        expect(v).toBe(dflt);
        expect(Number.isNaN(v)).toBe(false);
      });

      // clampInt parses with parseInt, and parseInt('') is NaN — so an empty
      // string takes the default path, unlike clampRate's Number('') === 0 (see
      // the nearThreshold block below). Pins that the two helpers diverge here.
      test(`an empty string falls back to the default (${dflt}), never NaN`, () => {
        process.env[envVar] = '';
        const v = getter();
        expect(v).toBe(dflt);
        expect(Number.isNaN(v)).toBe(false);
      });

      // parseInt accepts a numeric PREFIX and silently drops the rest: '1e3' → 1,
      // '12.9' → 12, '50abc' → 50. Using such a value would be a silent rewrite
      // (an operator asking for 1000 getting 1), so a partial parse must fall
      // back to the DEFAULT, not be honored as-if (issue #336 round 2).
      test.each(['1e3', '12.9', '50abc', '1,000', '0x10'])(
        'a partially-numeric value (%s) falls back to the default, never a truncated parse',
        (raw) => {
          process.env[envVar] = raw;
          expect(getter()).toBe(dflt);
        },
      );
    });
  });

  describe('clampRate-backed rate (nearThreshold)', () => {
    // nearThreshold reads NB_NEAR_DUP through clampRate → [0, 1], default 0.5
    // (notebook.ts). clampRate uses Number(), so fractional and signed values
    // parse, unlike the parseInt path above.
    test('below 0 clamps up to 0', () => {
      process.env.NB_NEAR_DUP = '-0.5';
      expect(nearThreshold()).toBe(0);
    });

    test('above 1 clamps down to 1', () => {
      process.env.NB_NEAR_DUP = '1.5';
      expect(nearThreshold()).toBe(1);
    });

    test('a non-numeric value falls back to the default (0.5), never NaN', () => {
      process.env.NB_NEAR_DUP = 'abc';
      const v = nearThreshold();
      expect(v).toBe(0.5);
      expect(Number.isNaN(v)).toBe(false);
    });

    // Number('') === 0 (finite), so unlike the parseInt-backed int getters an
    // empty string is NOT garbage to clampRate — it clamps to 0, the floor. This
    // pins the divergence so a future author doesn't assume '' → default here.
    test('an empty string is finite (Number("") === 0) and clamps to 0, not the default', () => {
      process.env.NB_NEAR_DUP = '';
      expect(nearThreshold()).toBe(0);
    });
  });

  describe('resolveIntEnv status (issue #336)', () => {
    // The status is what `nb config` reports; it must be honest about a
    // REWRITTEN value, not merely a missing one. A whole integer is honored;
    // leading/trailing whitespace is harmless; a partial parse is not honored.
    test('a whole integer is honored; surrounding whitespace is tolerated', () => {
      expect(resolveIntEnv('123', 50, 1, 5000)).toEqual({ value: 123, status: 'honored' });
      expect(resolveIntEnv(' 42 ', 50, 1, 5000)).toEqual({ value: 42, status: 'honored' });
    });

    test('an out-of-range whole integer is clamped, never ignored', () => {
      expect(resolveIntEnv('999999', 50, 1, 5000)).toEqual({ value: 5000, status: 'clamped' });
      expect(resolveIntEnv('0', 50, 1, 5000)).toEqual({ value: 1, status: 'clamped' });
    });

    test.each(['1e3', '12.9', '50abc', '1,000', '0x10', 'abc', ''])(
      'a value parseInt would truncate (%j) reads ignored with the default, never honored',
      (raw) => {
        expect(resolveIntEnv(raw, 50, 1, 5000)).toEqual({ value: 50, status: 'ignored' });
      },
    );
  });
});

describe('git merge-conflict markers are detected, never rewritten (issue #333)', () => {
  // A git-versioned notebook that hits a `git merge`/`pull` conflict parses its
  // `<<<<<<<`, `=======` and `>>>>>>>` lines as score-0 lessons, and the next
  // mutation used to bake them in as real lessons — silently "resolving" the
  // conflict. Reads must still work (with the marker surfaced) and every mutation
  // must refuse, leaving the file byte-identical.
  const marked = (): string =>
    '+1\tfoo lesson\n<<<<<<< HEAD\n+2\tmine\n=======\n+3\ttheirs\n>>>>>>> branch\n';
  const seed = (name = 'g'): string => {
    const file = join(dir, `${name}.md`);
    writeFileSync(file, marked());
    return file;
  };

  test('the three marker shapes are recognized, a mid-line ======= or tab-less line is not', () => {
    expect(isConflictMarker('<<<<<<< HEAD')).toBe(true);
    expect(isConflictMarker('<<<<<<<')).toBe(true);
    expect(isConflictMarker('=======')).toBe(true);
    expect(isConflictMarker('>>>>>>> branch')).toBe(true);
    expect(isConflictMarker('>>>>>>>')).toBe(true);
    // Not markers: the ordinary hand-edited line and a lesson containing `=======`.
    expect(isConflictMarker('a hand-edited line with no score')).toBe(false);
    expect(isConflictMarker('some ======= text mid-line')).toBe(false);
    expect(isConflictMarker('======= trailing')).toBe(false);
    expect(isConflictMarker(' <<<<<<< HEAD')).toBe(false);
  });

  test('readShelf reports the first marker but still parses the stored lessons', async () => {
    seed();
    const { conflict, entries } = readShelf(dir, 'g');
    expect(conflict).toBe('<<<<<<< HEAD');
    expect(entries.map((e) => e.text)).toEqual(['foo lesson', '<<<<<<< HEAD', 'mine', '=======', 'theirs', '>>>>>>> branch']);
  });

  test('a shelf holding only a tab-less line or a mid-line ======= is not a conflict', async () => {
    writeFileSync(join(dir, 'clean.md'), 'a hand-edited line\n1\ta lesson with ======= inside\n');
    expect(readShelf(dir, 'clean').conflict).toBeNull();
    // And it stays mutable.
    await addEntry(dir, 'clean', 'new one');
    expect(readEntries(dir, 'clean').map((e) => e.text)).toContain('new one');
  });

  test('add refuses with a handled `corrupt` error and leaves the file byte-identical', async () => {
    const file = seed();
    const before = readFileSync(file, 'utf-8');
    await expect(addEntry(dir, 'g', 'new one')).rejects.toMatchObject({ errorClass: 'corrupt' });
    await expect(addEntry(dir, 'g', 'new one')).rejects.toThrow(/shelf "g".*<<<<<<< HEAD/s);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  test('every mutation refuses (vote/voteMany/merge/split/rm/move/describe) and drops nothing', async () => {
    const file = seed();
    const other = join(dir, 'h.md');
    writeFileSync(other, '+1\tother lesson\n');
    const before = readFileSync(file, 'utf-8');
    const beforeOther = readFileSync(other, 'utf-8');
    const calls: Array<() => Promise<unknown>> = [
      () => vote(dir, 'g', 'foo', 1),
      () => voteMany(dir, 'g', ['foo'], 1),
      () => merge(dir, 'g', 'foo', 'mine', 'merged'),
      () => split(dir, 'g', 'foo', 'a', 'b'),
      () => remove(dir, 'g', 'foo'),
      () => move(dir, 'h', 'g', 'other'),
      () => move(dir, 'g', 'h', 'foo'),
      () => setDescription(dir, 'g', 'a description'),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ errorClass: 'corrupt' });
    }
    expect(readFileSync(file, 'utf-8')).toBe(before);
    expect(readFileSync(other, 'utf-8')).toBe(beforeOther);
  });

  test('cross-shelf scans surface conflicted shelves additively and keep them', async () => {
    seed();
    await addEntry(dir, 'ok', 'a clean lesson');
    const listing = listNotebooks(dir);
    expect(listing.conflicts).toEqual([{ shelf: 'g', marker: '<<<<<<< HEAD' }]);
    expect(listing.rows.map((r) => r.shelf)).toEqual(['g', 'ok']);
    const hits = search(dir, 'lesson');
    expect(hits.conflicts).toEqual([{ shelf: 'g', marker: '<<<<<<< HEAD' }]);
    expect(stats(dir, { now: Date.now() }).conflicts).toEqual([{ shelf: 'g', marker: '<<<<<<< HEAD' }]);
  });

  test('a healthy store reports no conflicts', async () => {
    await addEntry(dir, 'ok', 'a clean lesson');
    expect(listNotebooks(dir).conflicts).toEqual([]);
    expect(search(dir, 'clean').conflicts).toEqual([]);
    expect(stats(dir, { now: Date.now() }).conflicts).toEqual([]);
  });
});

describe('case-variant shelf guard (#337)', () => {
  test('add refuses a new shelf differing only by case, names the existing one, creates no file', async () => {
    await addEntry(dir, 'Foo', 'first');
    await expect(addEntry(dir, 'foo', 'second')).rejects.toThrow(/differs only by case.*"Foo".*`Foo`/);
    expect(readdirSync(dir).filter((n) => n.endsWith('.md'))).toEqual(['Foo.md']);
  });

  test('add to the exact existing name, and to a name with no case-variant, is unchanged', async () => {
    await addEntry(dir, 'Foo', 'first');
    expect((await addEntry(dir, 'Foo', 'second')).added).toBe(true);
    expect((await addEntry(dir, 'bar', 'third')).added).toBe(true);
    expect(readEntries(dir, 'Foo')).toHaveLength(2);
  });

  test('an existing colliding pair is left alone: both names stay writable', async () => {
    writeFileSync(join(dir, 'Foo.md'), '1\told\n');
    writeFileSync(join(dir, 'foo.md'), '1\tolder\n');
    if (readdirSync(dir).filter((n) => n.endsWith('.md')).length < 2) return; // case-insensitive host
    expect((await addEntry(dir, 'foo', 'more')).added).toBe(true);
    expect((await addEntry(dir, 'Foo', 'more')).added).toBe(true);
  });

  test('move into a new case-variant target is refused and writes nothing; into the exact name works', async () => {
    await addEntry(dir, 'Target', 'keep');
    await addEntry(dir, 'src', 'lesson one');
    await expect(move(dir, 'src', 'target', 'lesson one')).rejects.toThrow(/differs only by case.*"Target"/);
    expect(readEntries(dir, 'src')).toHaveLength(1);
    expect(readEntries(dir, 'Target')).toHaveLength(1);
    expect((await move(dir, 'src', 'Target', 'lesson one')).reason).toBe('moved');
  });

  test('describe refuses to create a case-variant shelf', async () => {
    await addEntry(dir, 'Foo', 'first');
    await expect(setDescription(dir, 'FOO', 'x')).rejects.toThrow(/differs only by case/);
    expect(readdirSync(dir).filter((n) => n.endsWith('.md'))).toEqual(['Foo.md']);
  });
});
