import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
// The built CLI, used to drive REAL cross-process contention on the mkdir lock
// (the actual hazard: several `nb` invocations mutating one role at once).
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
  addEntry,
  assertSafeRole,
  dedupKey,
  entryId,
  logUsage,
  maxChars,
  maxLines,
  merge,
  readEntries,
  remove,
  render,
  sanitizeLesson,
  stats,
  vote,
} from './notebook.js';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-'));
});
afterEach(() => {
  for (const k of ['NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_USAGE_RING', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S', 'NB_SILENT_H', 'NB_ERR_MIN', 'NB_ERR_RATE']) {
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

  test('rejects a new lesson when full and every entry outranks it', async () => {
    process.env.NB_MAX_LINES = '2';
    await addEntry(dir, 'r', 'alpha');
    await addEntry(dir, 'r', 'bravo');
    await vote(dir, 'r', 'alpha', 1);
    await vote(dir, 'r', 'bravo', 1); // both +2 (non-hex substrings, unambiguous)
    const res = await addEntry(dir, 'r', 'charlie'); // +1 is the strict lowest -> not stored
    expect(res.added).toBe(false);
    expect(res.reason).toBe('rejected-full');
    expect(readEntries(dir, 'r').map((e) => e.text).sort()).toEqual(['alpha', 'bravo']);
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
        const role = `rt-${n++}`;
        const add = await addEntry(dir, role, text);
        expect(add.added).toBe(true); // stored at the +1 default
        // Drive the score to `target`; each vote re-formats and re-parses the
        // whole file, so reaching a non-default score already round-trips it.
        const id = entryId(text);
        const steps = target - 1;
        for (let i = 0; i < Math.abs(steps); i++) await vote(dir, role, id, steps >= 0 ? 1 : -1);
        // format -> parse recovers the exact entry.
        expect(readEntries(dir, role)).toEqual([{ score: target, text }]);
        exercised++;
      }
    }
    // Make the `continue` guard loud: if a case were ever silently skipped the
    // loop would weaken without failing, so assert the full matrix ran.
    expect(exercised).toBe(RAW_LESSONS.length * SCORES.length);
  });

  test('re-formatting a parsed notebook is a byte-for-byte fixed point', async () => {
    // A true fixed point is parse→format→parse→format, not just two reads.
    // Drive a no-op mutation (vote up, then back down) so the whole file is
    // re-serialised twice, then assert the bytes and entries never drifted.
    await addEntry(dir, 'fp', 'alpha lesson');
    await addEntry(dir, 'fp', 'beta lesson');
    const before = readFileSync(join(dir, 'fp.md'), 'utf-8');
    await vote(dir, 'fp', entryId('alpha lesson'), 1); // rewrites the whole file via formatLine
    await vote(dir, 'fp', entryId('alpha lesson'), -1); // back to the original scores
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

describe('role safety', () => {
  test('rejects path-traversal and unsafe role names', () => {
    expect(() => assertSafeRole('../etc/passwd')).toThrow();
    expect(() => assertSafeRole('a/b')).toThrow();
    expect(() => assertSafeRole('')).toThrow();
    expect(() => assertSafeRole('patcher')).not.toThrow();
    expect(() => assertSafeRole('cartographer@some-repo')).not.toThrow();
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

  test('a tab/CR/LF in a field cannot split the row (rejected-unsafe-role regression)', () => {
    // The CLI logs in a `finally` block even when `add` rejected an unsafe role,
    // so a raw tab/newline in the role once became extra columns/rows and
    // mis-attributed the telemetry. Each field must stay structurally inert.
    const nasty = 'evil\trole\ndrop\rtable';
    logUsage(dir, nasty, 'add\tcmd', false, 4);
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    const rows = raw.split('\n').filter((l) => l !== '');
    expect(rows.length).toBe(1); // the CR/LF did not spawn extra rows
    const cols = rows[0].split('\t');
    expect(cols.length).toBe(5); // exactly five columns, tabs collapsed
    expect(cols[1]).toBe('evil role drop table'); // role: tab+CR+LF all collapsed to single spaces
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
    const [ts, role, command, status, ms] = raw.trimEnd().split('\t');
    expect([role, command, status, ms]).toEqual(['patcher', 'add', 'ok', '5ms']);
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
    expect(lines.every((l) => l.split('\t').length === 5)).toBe(true);
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
    // role exits 0 and still appends one usage row via the CLI's `finally`.
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
      expect(l).toMatch(/^[^\t]+\t[^\t]*\t[^\t]+\t(ok|err)\t\d+ms$/);
    }
    // No stray temp file lingered: every writer's rename consumed its own temp.
    expect(readdirSync(dir).filter((f) => f.startsWith('.nb-usage.log.') && f.endsWith('.tmp'))).toEqual([]);
  }, 30_000);
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

  test('cross-process: concurrent `nb add` invocations on one role all land (no lost update)', async () => {
    const N = 8; // small, deterministic; ~N*20ms serialization ≪ each child's 2s acquire budget
    const env = { ...process.env, NB_DIR: dir };
    delete env.NB_MAX_LINES; // keep the default 200-line cap so none of the N is evicted
    // Fire N separate processes at the same role simultaneously. Without the
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
    // The blocked op mutated nothing: no role file was created.
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
  // A crash between writeFileDurable's `<role>.md.tmp` and its rename leaves an
  // orphaned temp in the notebooks dir that nothing else removes. The next locked
  // mutation sweeps it — only this writer's `*.md.tmp` convention, never a real
  // notebook or the usage log.

  test('a planted role.md.tmp is removed by the next locked mutation', async () => {
    const orphan = join(dir, 'role.md.tmp');
    writeFileSync(orphan, 'crash debris from an interrupted write', 'utf-8');
    expect(existsSync(orphan)).toBe(true);
    // Any locked mutation triggers the reap — add on an UNRELATED role so we prove
    // the sweep is dir-wide, not tied to the role being written.
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
    // A role name never starts with `.` (assertSafeRole), so `.hidden.md.tmp` is
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
    expect(rep.notebookTotals).toEqual({ roles: 0, lines: 0, cap: maxLines() });
    // additive: the issue #18 fields stay present and unchanged.
    expect(rep.window).toBe('7d'); // default window when none is passed
    expect(rep.perCommand).toEqual([]);
    expect(rep.anomalies).toEqual([]);
  });

  test('one role: its line count and cap are reported, with matching totals', async () => {
    await addEntry(dir, 'patcher', 'prefer execFileSync, array args');
    await addEntry(dir, 'patcher', 'run lint before done');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', lines: 2, cap: maxLines() }]);
    expect(rep.notebookTotals).toEqual({ roles: 1, lines: 2, cap: maxLines() });
  });

  test('a role at NB_MAX_LINES reports lines === cap, a sibling stays below it', async () => {
    process.env.NB_MAX_LINES = '3';
    for (const l of ['one', 'two', 'three']) await addEntry(dir, 'full', l); // 3/3 — at cap
    await addEntry(dir, 'spare', 'just one'); // 1/3 — below cap
    const rep = stats(dir, { now: Date.now() });
    // Exact rows (sorted). The full role's lines equal its cap — the "about to
    // evict" signal — while the sibling, under the same global cap, stays below.
    expect(rep.notebooks).toEqual([
      { role: 'full', lines: 3, cap: 3 },
      { role: 'spare', lines: 1, cap: 3 },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, lines: 4, cap: 3 });
  });

  test('multiple roles are listed sorted, with exact rows and aggregate totals', async () => {
    await addEntry(dir, 'zeta', 'a');
    await addEntry(dir, 'alpha', 'b');
    await addEntry(dir, 'alpha', 'c');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([
      { role: 'alpha', lines: 2, cap: maxLines() },
      { role: 'zeta', lines: 1, cap: maxLines() },
    ]);
    expect(rep.notebookTotals).toEqual({ roles: 2, lines: 3, cap: maxLines() });
  });

  test('a role filter scopes the inventory to exactly that notebook (exact match, not prefix)', async () => {
    await addEntry(dir, 'patcher', 'x');
    await addEntry(dir, 'patcher2', 'y'); // a prefix-collision sibling: must NOT leak in
    await addEntry(dir, 'cartographer', 'z');
    const rep = stats(dir, { role: 'patcher', now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', lines: 1, cap: maxLines() }]);
    expect(rep.notebookTotals).toEqual({ roles: 1, lines: 1, cap: maxLines() });
  });

  test('a role filter for a role with no notebook yields an empty inventory', async () => {
    await addEntry(dir, 'patcher', 'x');
    const rep = stats(dir, { role: 'nobody', now: Date.now() });
    expect(rep.notebooks).toEqual([]);
    expect(rep.notebookTotals).toEqual({ roles: 0, lines: 0, cap: maxLines() });
  });

  test('sidecar and stray non-role files are not counted as notebooks', async () => {
    await addEntry(dir, 'patcher', 'x'); // a real role → patcher.md
    logUsage(dir, 'patcher', 'add', true, 1); // writes the .nb-usage.log sidecar
    writeFileSync(join(dir, 'notes.txt'), 'not a role file', 'utf-8');
    writeFileSync(join(dir, '.hidden.md'), 'a dotfile, not a role', 'utf-8');
    const rep = stats(dir, { now: Date.now() });
    expect(rep.notebooks).toEqual([{ role: 'patcher', lines: 1, cap: maxLines() }]);
  });

  test('inventory reflects current on-disk state, not the usage window', async () => {
    await addEntry(dir, 'patcher', 'a lesson');
    // A far-future `now` with a 60s window drops every usage row, but the
    // notebook file is still on disk, so the inventory must still report it.
    const rep = stats(dir, { now: Date.now() + 10 * 86_400_000, windowMs: 60_000 });
    expect(rep.totalCalls).toBe(0);
    expect(rep.perCommand).toEqual([]);
    expect(rep.notebooks).toEqual([{ role: 'patcher', lines: 1, cap: maxLines() }]);
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
  function displayed(role: string): { score: number; text: string }[] {
    const out = render(dir, role);
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
  async function seed(role: string, specs: [string, number][]): Promise<void> {
    for (const [text] of specs) await addEntry(dir, role, text);
    for (const [text, score] of specs) {
      for (let s = 1; s < score; s++) await vote(dir, role, entryId(text), 1);
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

  test('voting reorders only the DISPLAY; the stored file order is unchanged', async () => {
    await seed('store', [['a', 4], ['b', 2], ['c', 2], ['d', 2], ['e', 1]]);
    const fileBefore = readEntries(dir, 'store').map((e) => e.text);
    expect(fileBefore).toEqual(['a', 'b', 'c', 'd', 'e']); // insertion order

    await vote(dir, 'store', entryId('d'), 1); // d moves UP in the view...

    // ...but the file is still in insertion order: 'd' did not move on disk.
    expect(readEntries(dir, 'store').map((e) => e.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(readEntries(dir, 'store').find((e) => e.text === 'd')!.score).toBe(3);
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

  test('a downvote moves an entry DOWN past lower-scored neighbors', async () => {
    await seed('down', [['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
    await vote(dir, 'down', entryId('b'), -1); // b: +3 -> +2, ties with c (b older -> above c)
    expect(displayed('down')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'b' },
      { score: 2, text: 'c' },
      { score: 1, text: 'd' },
    ]);
    await vote(dir, 'down', entryId('b'), -1); // b: +2 -> +1, now below c and ties with d (b older)
    expect(displayed('down')).toEqual([
      { score: 4, text: 'a' },
      { score: 2, text: 'c' },
      { score: 1, text: 'b' },
      { score: 1, text: 'd' },
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
