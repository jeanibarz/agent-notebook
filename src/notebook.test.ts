import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, readdirSync } from 'node:fs';
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
const fsHook = vi.hoisted(() => ({ events: null as string[] | null, renames: null as string[] | null, failDirFsync: false, failBodyFsync: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
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
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
  };
});

import {
  activityByDay,
  addEntry,
  assertSafeRole,
  assertSafeShelf,
  dedupKey,
  diagnoseEngagement,
  entryId,
  similarity,
  getDescription,
  getMetaValue,
  isMetaLine,
  listNotebooks,
  listRoles,
  listShelves,
  logUsage,
  maxChars,
  maxLines,
  merge,
  move,
  normalizeReason,
  parseUsage,
  readEntries,
  readMetaLines,
  remove,
  render,
  sanitizeLesson,
  search,
  setDescription,
  setMetaValue,
  showJson,
  sparkline,
  split,
  stats,
  vote,
} from './notebook.js';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-'));
});
afterEach(() => {
  for (const k of ['NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_USAGE_RING', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S', 'NB_SILENT_H', 'NB_ERR_MIN', 'NB_ERR_RATE', 'NB_SESSION', 'NB_COVERAGE_HI', 'NB_RECALL_MISS_HI']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
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
    // always the lowest). The per-add staleness dock on the stalest survivor pulls
    // it down one point each add until it finally reaches the bottom and is evicted.
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
  });
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

  test('format→parse recovers every (score, lesson) pair through the on-disk codec', async () => {
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
    expect(cols.length).toBe(12); // five base + five richer + two reason columns, all tabs collapsed
    expect(cols[1]).toBe('evil role drop table'); // shelf: tab+CR+LF all collapsed to single spaces
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

  test('usage log is a bounded ring (oldest dropped)', () => {
    process.env.NB_USAGE_RING = '100';
    for (let i = 0; i < 150; i++) logUsage(dir, 'p', 'show', true, 1);
    const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(100);
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

  test('labels a sub-hour window in minutes (not rounded to 1h)', () => {
    logUsage(dir, 'p', 'show', true, 1);
    const rep = stats(dir, { now: Date.now(), windowMs: 30 * 60_000 });
    expect(rep.window).toBe('30m');
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
    process.env.NB_USAGE_RING = '100'; // the clamp floor; fill it, then force one compact
    for (let i = 0; i < 100; i++) logUsage(dir, 'p', 'show', true, 1); // appends (no rename yet)
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

  test('cross-process: overlapping usage-log writers leave a parseable file and no stray temp (issue #32)', async () => {
    // The acceptance scenario, with real OS processes (distinct pids): logUsage
    // runs unlocked, so concurrent `nb` invocations write the usage log at once.
    // A per-process temp keeps each rename atomic — the final file is always one
    // writer's complete content, and every writer's temp is consumed by its own
    // rename (no shared `.nb-usage.log.tmp` left dangling). `nb show` on an empty
    // shelf exits 0 and still appends one usage row via the CLI's `finally`.
    const RING = 100;
    process.env.NB_USAGE_RING = String(RING);
    for (let i = 0; i < RING; i++) logUsage(dir, 'seed', 'show', true, 1); // fill the ring so each writer trims+rewrites the whole file
    const env = { ...process.env, NB_DIR: dir };
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () =>
        execFileAsync(process.execPath, [CLI, 'show', 'race'], { env }),
      ),
    );
    const lines = readFileSync(join(dir, '.nb-usage.log'), 'utf-8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(RING); // ring bound holds under contention
    // Every surviving line is a complete, well-formed usage row — no torn/partial
    // line (the corruption a shared temp path could leave).
    for (const l of lines) {
      // Five base columns, the five richer ones, then the two reason columns (all empty for a `show`).
      expect(l).toMatch(/^[^\t]+\t[^\t]*\t[^\t]+\t(ok|err)\t\d+ms(\t[^\t]*){7}$/);
    }
    // No stray temp file lingered: every writer's rename consumed its own temp.
    expect(readdirSync(dir).filter((f) => f.startsWith('.nb-usage.log.') && f.endsWith('.tmp'))).toEqual([]);
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
      [{ ts: 't', role: 'r', command: 'add', ok: true, ms: 1, session: '', entries: [], outcome: 'accepted', collided: '', evicted: '', reason: '', note: '' }],
      0,
    );
    expect(d.blankSessionCalls).toBe(1);
    expect(d.causes).toEqual(['blank-session']);
  });

  test('a deliberate read (show) in a session with no vote is retrospective-not-landing (AC2)', () => {
    const d = diagnoseEngagement(
      [{ ts: 't', role: 'r', command: 'show', ok: true, ms: 1, session: 's1', entries: [], outcome: '', collided: '', evicted: '', reason: '', note: '' }],
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
      [{ ts: 't', role: 'r', command: 'list', ok: true, ms: 1, session: 's1', entries: [], outcome: '', collided: '', evicted: '', reason: '', note: '' }],
      5,
    );
    expect(d.reads).toBe(1); // list counts as a read → injection-hook off
    expect(d.readOnlySessions).toBe(0); // list is NOT a deliberate read → retrospective off
    expect(d.causes).toEqual([]);
  });

  test('search counts as a deliberate read (retrospective cause)', () => {
    const d = diagnoseEngagement(
      [{ ts: 't', role: 'r', command: 'search', ok: true, ms: 1, session: 's1', entries: [], outcome: 'no-match', collided: '', evicted: '', reason: '', note: 'q' }],
      3,
    );
    expect(d.readOnlySessions).toBe(1);
    expect(d.causes).toEqual(['retrospective-not-landing']);
  });

  test('a deliberate read in a BLANK session does not count as a read-only session', () => {
    // Pins the `r.session !== ''` guard on the deliberate-read branch: a blank
    // show is a blank-session cause, never a retrospective one.
    const d = diagnoseEngagement(
      [{ ts: 't', role: 'r', command: 'show', ok: true, ms: 1, session: '', entries: [], outcome: '', collided: '', evicted: '', reason: '', note: '' }],
      3,
    );
    expect(d.readOnlySessions).toBe(0);
    expect(d.reads).toBe(1); // still a read for the hook check (so injection-hook off)
    expect(d.causes).toEqual(['blank-session']);
  });

  test('two distinct deliberate-read sessions count as two read-only sessions, not more', () => {
    const d = diagnoseEngagement(
      [
        { ts: 't', role: 'r', command: 'show', ok: true, ms: 1, session: 's1', entries: [], outcome: '', collided: '', evicted: '', reason: '', note: '' },
        { ts: 't', role: 'r', command: 'search', ok: true, ms: 1, session: 's1', entries: [], outcome: 'no-match', collided: '', evicted: '', reason: '', note: '' },
        { ts: 't', role: 'r', command: 'show', ok: true, ms: 1, session: 's2', entries: [], outcome: '', collided: '', evicted: '', reason: '', note: '' },
      ],
      3,
    );
    expect(d.readOnlySessions).toBe(2); // s1 (de-duped across its two reads) + s2
  });

  test('a blank-session call with zero reads and stored lessons fires BOTH causes, in order', () => {
    // Overlap: a session-less `add` (no read) with a non-empty notebook — the
    // operator has two real problems; both lines show, blank-session first.
    const d = diagnoseEngagement(
      [{ ts: 't', role: 'r', command: 'add', ok: true, ms: 1, session: '', entries: [], outcome: 'accepted', collided: '', evicted: '', reason: '', note: '' }],
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
    expect(parseUsage(dir)).toHaveLength(100);
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
  // (20ms) up to a 2s acquire deadline, and steals a lock whose mtime is older
  // than the 10s stale threshold. These tests drive that one safety-critical
  // primitive directly — concurrency must not lose an update, a blocked op must
  // wait and then acquire, an aged lock must be reclaimed, a live lock must make
  // acquisition time out, and the lock must always be released.
  //
  // NOTE on in-process vs. cross-process: withLock's critical section (`fn()`)
  // is synchronous, so Promise.all of several mutations in ONE process can never
  // interleave — the event loop runs each read-modify-write to completion before
  // the next starts, lock or no lock. An in-process "concurrency" test therefore
  // passes even if the lock is deleted and proves nothing. The genuine hazard is
  // several OS processes, so the no-lost-update test spawns real `nb` children.

  test('cross-process: concurrent `nb add` invocations on one shelf all land (no lost update)', async () => {
    const N = 8; // small, deterministic; ~N*20ms serialization ≪ each child's 2s acquire budget
    const env = { ...process.env, NB_DIR: dir };
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

  test('an operation blocked by a live lock waits, then acquires once the lock is freed', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a live lock held by "another process" (fresh mtime → never stolen)
    let releasedAt = 0;
    // Free the lock well within the 2s acquire budget so the spinning op gets it.
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

  test('reclaims a stale .nb.lock (mtime older than the 10s stale threshold) and completes', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a crashed nb process left the lock dir behind
    const agedSeconds = Date.now() / 1000 - 20; // back-date mtime 20s into the past (> 10s threshold)
    utimesSync(lock, agedSeconds, agedSeconds);
    // The next op must steal the aged lock rather than wait out the 2s deadline.
    const r = await addEntry(dir, 'stale', 'written after stealing a stale lock');
    expect(r.added).toBe(true);
    expect(readEntries(dir, 'stale')).toEqual([{ score: 1, text: 'written after stealing a stale lock' }]);
    // The stolen lock is released again when the operation finishes.
    expect(existsSync(lock)).toBe(false);
  });

  test('a fresh (non-stale) lock is NOT stolen: acquisition times out after ~2s', async () => {
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a live lock held by another process (recent mtime → never stolen)
    const started = Date.now();
    // withLock spins for its 2s budget, never steals the fresh lock, then throws.
    await expect(addEntry(dir, 'blocked', 'should never be written')).rejects.toThrow(/locked/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    // The blocked op mutated nothing: no shelf file was created.
    expect(existsSync(join(dir, 'blocked.md'))).toBe(false);
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
});

describe('reaps leftover *.md.tmp on lock acquire (issue #46)', () => {
  // A crash between writeFileDurable's `<shelf>.md.tmp` and its rename leaves an
  // orphaned temp in the notebooks dir that nothing else removes. The next locked
  // mutation sweeps it — only this writer's `*.md.tmp` convention, never a real
  // notebook or the usage log.

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

  test('real *.md notebooks are never deleted by the reap', async () => {
    await addEntry(dir, 'keepme', 'a committed lesson');
    writeFileSync(join(dir, 'orphan.md.tmp'), 'debris', 'utf-8');
    // A later mutation reaps the .md.tmp but must leave every real notebook intact.
    await addEntry(dir, 'other', 'another lesson');
    expect(existsSync(join(dir, 'orphan.md.tmp'))).toBe(false);
    expect(readEntries(dir, 'keepme')).toEqual([{ score: 1, text: 'a committed lesson' }]);
    expect(existsSync(join(dir, 'keepme.md'))).toBe(true);
  });

  test('the usage log and its per-pid temp are not reaped (dotfile / not *.md.tmp)', async () => {
    const usage = join(dir, '.nb-usage.log');
    const usageTmp = join(dir, `.nb-usage.log.${process.pid}.tmp`);
    writeFileSync(usage, 'usage rows', 'utf-8');
    writeFileSync(usageTmp, 'a usage-log temp mid-compact', 'utf-8');
    await addEntry(dir, 'patcher', 'triggers a reap');
    // Neither the log nor its temp matches the `*.md.tmp` convention (and both are
    // dotfiles), so the reap leaves them untouched.
    expect(existsSync(usage)).toBe(true);
    expect(existsSync(usageTmp)).toBe(true);
  });

  test('a dotfile *.md.tmp is NOT reaped (the dotfile guard, isolated)', async () => {
    // A shelf name never starts with `.` (assertSafeShelf), so `.hidden.md.tmp` is
    // not our convention even though it ends in `.md.tmp`. This isolates the
    // `name.startsWith('.')` half of the guard: unlike the usage-log temp (which
    // is excluded by the suffix check too), only a dotfile that DOES end in
    // `.md.tmp` can prove the dotfile branch is load-bearing.
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
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 2, cap: maxLines() }]);
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
      { role: 'full', shelf: 'full', lines: 3, cap: 3 },
      { role: 'spare', shelf: 'spare', lines: 1, cap: 3 },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, shelves: 2, lines: 4, cap: 3 });
  });

  test('multiple shelves are listed sorted, with exact rows and aggregate totals', async () => {
    await addEntry(dir, 'zeta', 'a');
    await addEntry(dir, 'alpha', 'b');
    await addEntry(dir, 'alpha', 'c');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([
      { role: 'alpha', shelf: 'alpha', lines: 2, cap: maxLines() },
      { role: 'zeta', shelf: 'zeta', lines: 1, cap: maxLines() },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, shelves: 2, lines: 3, cap: maxLines() });
  });

  test('a shelf filter scopes the inventory to exactly that notebook (exact match, not prefix)', async () => {
    await addEntry(dir, 'patcher', 'x');
    await addEntry(dir, 'patcher2', 'y'); // a prefix-collision sibling: must NOT leak in
    await addEntry(dir, 'cartographer', 'z');
    const rep = stats(dir, { shelf: 'patcher', now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines() }]);
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
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines() }]);
  });

  test('inventory reflects current on-disk state, not the usage window', async () => {
    await addEntry(dir, 'patcher', 'a lesson');
    // A far-future `now` with a 60s window drops every usage row, but the
    // notebook file is still on disk, so the inventory must still report it.
    const rep = stats(dir, { now: Date.now() + 10 * 86_400_000, windowMs: 60_000 });
    expect(rep.totalCalls).toBe(0);
    expect(rep.perCommand).toEqual([]);
    expect(rep.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 1, cap: maxLines() }]);
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

  test('an empty / whitespace query yields no terms and no groups (never throws)', async () => {
    await addEntry(dir, 'r', 'something');
    expect(search(dir, '   ')).toEqual({ terms: [], groups: [] });
    expect(search(dir, '')).toEqual({ terms: [], groups: [] });
  });

  test('no match returns an empty group list (the gap-sensor case)', async () => {
    await addEntry(dir, 'r', 'a stored lesson');
    const r = search(dir, 'absent-keyword');
    expect(r.terms).toEqual(['absent-keyword']);
    expect(r.groups).toEqual([]);
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
