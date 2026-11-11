import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNbCli, readBoundedStream, settleCliExit, installPipeGuards, closestCommand, closestShelf, KNOWN_COMMANDS, KNOWN_FLAGS } from './cli.js';
import { drainPendingRecovery, entryId, parseUsage, usageFile } from './notebook.js';
import type { IntTunable, RateTunable } from './notebook.js';

const PKG_VERSION: string = createRequire(import.meta.url)('../package.json').version;

// Repo root resolved from this test file (src/cli.test.ts → ..), mirroring how
// `../package.json` is loaded above. The terminology guards below read the
// SOURCE README.md and cli.ts from here — the user-facing surface issue #140
// migrated off the removed term "role".
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let dir: string;
const SAVED = { ...process.env };
// Every NB_* env var this suite reads or sets. Hoisted to one list so the
// clean-baseline `beforeEach` and the restore-to-parent `afterEach` can never
// drift apart (issue #230).
const MANAGED_ENV = [
  'NB_DIR',
  'NB_MAX_LINES',
  'NB_MAX_CHARS',
  'NB_ROLE',
  'NB_LOOP_N',
  'NB_LOOP_WINDOW_S',
  'NB_SESSION',
  'NB_COVERAGE_HI',
  'NB_RECALL_MISS_HI',
] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-cli-'));
  // Establish a clean baseline: clear every managed NB_* var so an ambient
  // value the host exported (most often NB_SESSION — agents and CI-adjacent
  // tooling set it) cannot leak into a test that assumes it is unset. NB_DIR is
  // then pointed at this test's temp dir below (issue #230).
  for (const k of MANAGED_ENV) delete process.env[k];
  process.env.NB_DIR = dir;
  // Reset the process-global crash-recovery tally (issue #309) so a steal/reap in
  // one in-process CLI run can never leak its count into a later test's usage row.
  drainPendingRecovery();
});
afterEach(() => {
  for (const k of MANAGED_ENV) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run runNbCli with stdout/stderr captured. When `stdin` is provided, it is fed
 * to the CLI through the injectable stdin reader (used by `nb add <shelf> -`), so
 * the stdin path is exercised without touching the real `process.stdin`.
 */
async function run(
  argv: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string) => ((out += s), true);
  process.stderr.write = (s: string) => ((err += s), true);
  const reader = stdin === undefined ? undefined : async () => stdin;
  try {
    const code = await runNbCli(argv, reader);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('runNbCli', () => {
  test('a forgotten shelf never writes the lesson text into the usage log (issue #375)', async () => {
    const r = await run(['add', 'a lesson I typed but forgot the shelf name']);
    expect(r.code).toBe(1);
    const raw = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(raw).not.toContain('forgot the shelf');
    expect(raw.trimEnd().split('\t').slice(1, 3)).toEqual(['-', 'add']);
  });

  test('nb stats prints no control characters from a legacy usage row (issue #375)', async () => {
    const ts = new Date().toISOString();
    writeFileSync(join(dir, '.nb-usage.log'), `${ts}\tp\tbad\x1b[5mcmd\terr\t1ms\t\x1b[31mRED\x07\n`);
    const r = await run(['stats']);
    expect(r.out).toContain('bad[5mcmd');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(r.out)).toBe(false);
  });

  test('--help and no-args print usage and exit 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb — the Agent Notebook');
  });

  test('--help appends a `help` usage row so the not-wired symptom is visible to stats (issue #250)', async () => {
    // help/version used to return before the shared logUsage, so a harness that
    // only ever ran `nb --help` left NO trace in the usage ring — exactly the
    // signal `nb stats` exists to surface. Every alias canonicalises to `help`.
    for (const flag of ['--help', '-h', 'help']) {
      await run([flag]);
    }
    // No-args prints the same usage, so it logs under `help` too.
    await run([]);
    const helpRows = parseUsage(dir).filter((r) => r.command === 'help');
    expect(helpRows.length).toBe(4);
    for (const row of helpRows) {
      expect(row.ok).toBe(true); // help never fails
      expect(row.role).toBe('-'); // no shelf involved
    }
  });

  test('--version appends a `version` usage row under one canonical command (issue #250)', async () => {
    for (const flag of ['--version', '-v', 'version']) {
      await run([flag]);
    }
    const versionRows = parseUsage(dir).filter((r) => r.command === 'version');
    expect(versionRows.length).toBe(3);
    expect(versionRows.every((r) => r.ok && r.role === '-')).toBe(true);
    // Each `nb` call appends exactly one row — never zero (the old bug) and
    // never two — so the "every call appends one line" invariant holds.
    expect(parseUsage(dir).length).toBe(3);
  });

  test('--help/--version still succeed when NB_DIR is unwritable (logging stays best-effort, issue #250)', async () => {
    // The usage-row logging must never break `--help`/`--version` on a read-only
    // system (the issue's stated risk). Point NB_DIR at a path *under a regular
    // file*, so the log's `mkdirSync(dir, { recursive: true })` fails with
    // ENOTDIR — a deterministic, cross-platform write failure that needs no
    // chmod. `logUsage` must swallow it and the command must still exit 0.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.NB_DIR = join(blocker, 'nb'); // mkdir under a file → ENOTDIR

    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('nb — the Agent Notebook');
    expect(help.err).toBe(''); // the swallowed log error never reaches stderr

    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.out).toBe(`nb (agent-notebook) ${PKG_VERSION}\n`);
    expect(version.err).toBe('');
  });

  test('add then show round-trips a lesson', async () => {
    expect((await run(['add', 'patcher', 'prefer execFileSync, array args'])).code).toBe(0);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('prefer execFileSync, array args');
    expect(show.out).toMatch(/^[0-9a-f]{6}\s+\[\+1\]\s+prefer execFileSync/m); // stable id + score
  });

  test('add announces a created shelf on stderr and names overlapping shelves (issue #354)', async () => {
    const first = await run(['add', 'flaky-ci-debugging', 'rerun with --verbose']);
    expect(first.code).toBe(0);
    expect(first.out).toBe('added — 1 line\n'); // stdout unchanged
    expect(first.err).toBe('note: created new shelf "flaky-ci-debugging"\n'); // no overlap → no names
    // Adding to an existing shelf says nothing.
    expect((await run(['add', 'flaky-ci-debugging', 'second lesson'])).err).toBe('');
    // Two shared words (ci, debugging) → named, with the consolidating nb move.
    const second = await run(['add', 'ci-debugging-tips', 'pin the runner image']);
    expect(second.code).toBe(0);
    expect(second.err).toMatch(/created new shelf "ci-debugging-tips"; existing shelves with overlapping names: flaky-ci-debugging — .*nb move ci-debugging-tips flaky-ci-debugging [0-9a-f]{6}\n/);
    // One shared word is not enough.
    expect((await run(['add', 'ci-other', 'x lesson'])).err).toBe('note: created new shelf "ci-other"\n');
    // JSON carries it too.
    const j = JSON.parse((await run(['add', '--json', 'debugging.ci.notes', 'json lesson'])).out);
    expect(j.created).toBe(true);
    expect(j.similarShelves).toEqual(['ci-debugging-tips', 'flaky-ci-debugging']);
  });

  test('add pluralises the line count: "1 line" on the first add, "2 lines" on the second (issue #142)', async () => {
    const first = await run(['add', 'patcher', 'alpha lesson']);
    expect(first.code).toBe(0);
    expect(first.out).toBe('added — 1 line\n'); // singular, not "1 lines"

    const second = await run(['add', 'patcher', 'beta lesson']);
    expect(second.code).toBe(0);
    expect(second.out).toBe('added — 2 lines\n'); // plural
  });

  test('show --json emits { shelf, description, entries } ordered highest-score-first (issue #87)', async () => {
    // Two lessons; vote the second one up so score ordering differs from insertion order.
    await run(['add', 'patcher', 'alpha lesson']);
    await run(['add', 'patcher', 'beta lesson']);
    const betaId = entryId('beta lesson');
    await run(['vote', 'patcher', betaId, '+1']); // beta: +2, alpha: +1
    await run(['describe', 'patcher', 'bug-fix lessons']);

    const r = await run(['show', 'patcher', '--json']);
    expect(r.code).toBe(0);
    // Exactly one JSON object on stdout, nothing else.
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.role).toBe('patcher');
    expect(parsed.description).toBe('bug-fix lessons');
    // Highest score first (beta +2 before alpha +1); each entry carries
    // id/score/text and the dedupKey normal form `key` (issue #286).
    expect(parsed.entries).toEqual([
      { id: betaId, score: 2, text: 'beta lesson', key: 'beta lesson' },
      { id: entryId('alpha lesson'), score: 1, text: 'alpha lesson', key: 'alpha lesson' },
    ]);
    // The ids match what the human `show` prints, and the order matches render()
    // (skipping the leading `# desc:` header line that the human output carries).
    const plain = await run(['show', 'patcher']);
    const plainIds = plain.out
      .trim()
      .split('\n')
      .filter((l) => /^[0-9a-f]{6}\s/.test(l))
      .map((l) => l.split(/\s+/)[0]);
    expect(plainIds).toEqual(parsed.entries.map((e: { id: string }) => e.id));
  });

  test('show --json on a never-created notebook yields { description: null, entries: [], exists: false } and exits 0 (issues #87, #166)', async () => {
    const r = await run(['show', 'solo', '--json']);
    expect(r.code).toBe(0);
    // `solo` was never created, so `exists` is false; `entries` stays `[]` for
    // backward compatibility (issue #166 adds `exists`, it does not change `entries`).
    expect(JSON.parse(r.out)).toEqual({ role: 'solo', shelf: 'solo', description: null, entries: [], exists: false });
  });

  // issue #286 — `nb show a b c --json` is a batch read: one ShowResult per shelf
  // in one process, and each entry carries the dedupKey normal form `key` so the
  // caller composes its own context (shelf selection, scope precedence, budget)
  // and drops *exact* cross-shelf duplicates itself. No similarity dropping here.
  describe('show --json batch + per-entry key (issue #286)', () => {
    test('each entry carries its dedupKey normal form as `key` (case/punctuation-folded, distinct from the raw text)', async () => {
      // A lesson whose normal form differs from its text — uppercase + punctuation.
      await run(['add', 'patcher', 'Use execFileSync, NOT execSync!']);
      const r = await run(['show', 'patcher', '--json']);
      expect(r.code).toBe(0);
      const [entry] = JSON.parse(r.out).entries as Array<{ text: string; key: string }>;
      expect(entry.text).toBe('Use execFileSync, NOT execSync!');
      // dedupKey: lowercase, punctuation → space, whitespace collapsed.
      expect(entry.key).toBe('use execfilesync not execsync');
    });

    test('two entries with an equal `key` are exact dupes the caller can drop — even across shelves', async () => {
      // Same lesson modulo case/punctuation lives on two different shelves.
      await run(['add', 'alpha', 'Fail open is UNSAFE.']);
      await run(['add', 'beta', 'fail open is unsafe']);
      const r = await run(['show', 'alpha', 'beta', '--json']);
      expect(r.code).toBe(0);
      const [a, b] = JSON.parse(r.out) as Array<{ entries: Array<{ key: string }> }>;
      // Identical normal form → identical `key`: the caller drops the cross-shelf dupe.
      expect(a.entries[0].key).toBe(b.entries[0].key);
      expect(a.entries[0].key).toBe('fail open is unsafe');
    });

    test('≥2 shelves → a per-shelf ShowResult[] in order, one consistent read', async () => {
      await run(['add', 'alpha', 'alpha one']);
      await run(['describe', 'alpha', 'A shelf']);
      await run(['add', 'beta', 'beta one']);
      const r = await run(['show', 'alpha', 'beta', '--json']);
      expect(r.code).toBe(0);
      // Exactly one JSON value (the array) on stdout, nothing else.
      expect(r.out.trim().split('\n')).toHaveLength(1);
      const arr = JSON.parse(r.out);
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toHaveLength(2);
      expect(arr.map((s: { shelf: string }) => s.shelf)).toEqual(['alpha', 'beta']); // given order
      expect(arr[0].description).toBe('A shelf');
      expect(arr[0].entries[0]).toMatchObject({ text: 'alpha one', key: 'alpha one' });
      expect(arr[1].entries[0]).toMatchObject({ text: 'beta one', key: 'beta one' });
    });

    test('a single shelf stays a lone object (not a one-element array) — backward compatible', async () => {
      await run(['add', 'alpha', 'only lesson']);
      const r = await run(['show', 'alpha', '--json']);
      const parsed = JSON.parse(r.out);
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed.shelf).toBe('alpha');
    });

    test('a named shelf with no file reports exists:false in the batch (never a silent empty)', async () => {
      await run(['add', 'alpha', 'alpha one']);
      const r = await run(['show', 'alpha', 'ghost', '--json']);
      expect(r.code).toBe(0);
      const [a, ghost] = JSON.parse(r.out) as Array<{ shelf: string; exists: boolean; entries: unknown[] }>;
      expect(a).toMatchObject({ shelf: 'alpha', exists: true });
      expect(ghost).toMatchObject({ shelf: 'ghost', exists: false, entries: [] });
    });

    test('human-mode batch renders each shelf block in given order, blank-line separated', async () => {
      await run(['add', 'alpha', 'alpha lesson']);
      await run(['add', 'beta', 'beta lesson']);
      const r = await run(['show', 'alpha', 'beta']);
      expect(r.code).toBe(0);
      // Both shelves' lessons appear (the pre-#286 path showed only the first)…
      expect(r.out).toContain('alpha lesson');
      expect(r.out).toContain('beta lesson');
      expect(r.out).toContain('nb vote alpha');
      expect(r.out).toContain('nb vote beta');
      // …in the given order (not reversed)…
      expect(r.out.indexOf('alpha lesson')).toBeLessThan(r.out.indexOf('beta lesson'));
      // …with a blank line between the two blocks (the alpha vote hint, then an
      // empty line, then beta's id line).
      expect(r.out).toMatch(/nb vote alpha[^\n]*\n\n[0-9a-f]{6}\s+\[\+1\]\s+beta lesson/);
    });

    test('human-mode batch reports a missing shelf on stderr while still rendering the present ones', async () => {
      await run(['add', 'alpha', 'alpha lesson']);
      const r = await run(['show', 'alpha', 'ghost']);
      expect(r.code).toBe(0); // not found is not an error (DP-5)
      expect(r.out).toContain('alpha lesson');
      expect(r.err).toContain('no notebook for shelf "ghost"');
      // The missing shelf must NOT be rendered as a notebook on stdout — not even
      // the "(… is empty)" line, which is reserved for an existing empty shelf.
      expect(r.out).not.toContain('ghost');
    });

    test('human-mode batch with a missing FIRST shelf still renders the later present ones', async () => {
      await run(['add', 'beta', 'beta lesson']);
      const r = await run(['show', 'ghost', 'beta']);
      expect(r.code).toBe(0);
      expect(r.err).toContain('no notebook for shelf "ghost"');
      expect(r.out).toContain('beta lesson');
    });

    test('near-but-not-equal lessons are KEPT with different keys — no similarity dropping (criterion 3)', async () => {
      // These share a first word and most trigrams but have DISTINCT normal forms,
      // so a similarity-based dedup would wrongly collapse them. The contract is
      // exact-key equality only: both survive, in both shelves, with different keys.
      await run(['add', 'alpha', 'alpha one']);
      await run(['add', 'beta', 'alpha one two']);
      const r = await run(['show', 'alpha', 'beta', '--json']);
      const [a, b] = JSON.parse(r.out) as Array<{ entries: Array<{ key: string }> }>;
      expect(a.entries).toHaveLength(1);
      expect(b.entries).toHaveLength(1);
      expect(a.entries[0].key).toBe('alpha one');
      expect(b.entries[0].key).toBe('alpha one two');
      expect(a.entries[0].key).not.toBe(b.entries[0].key);
    });

    test('an EXACT cross-shelf dupe is retained in BOTH shelves (nb never drops across shelves)', async () => {
      await run(['add', 'alpha', 'same lesson']);
      await run(['add', 'beta', 'same lesson']);
      const r = await run(['show', 'alpha', 'beta', '--json']);
      const [a, b] = JSON.parse(r.out) as Array<{ entries: Array<{ key: string }> }>;
      // Dropping the dupe is the CALLER's job; nb returns both so the caller decides.
      expect(a.entries).toHaveLength(1);
      expect(b.entries).toHaveLength(1);
      expect(a.entries[0].key).toBe(b.entries[0].key);
    });

    test('--json may precede or sit between the shelf operands', async () => {
      await run(['add', 'alpha', 'alpha one']);
      await run(['add', 'beta', 'beta one']);
      for (const argv of [
        ['show', '--json', 'alpha', 'beta'],
        ['show', 'alpha', '--json', 'beta'],
      ]) {
        const r = await run(argv);
        expect(r.code).toBe(0);
        const arr = JSON.parse(r.out);
        expect(Array.isArray(arr)).toBe(true);
        expect(arr.map((s: { shelf: string }) => s.shelf)).toEqual(['alpha', 'beta']);
      }
    });

    test('an invalid shelf name anywhere in a batch fails the whole call atomically (exit 1, no partial JSON)', async () => {
      await run(['add', 'alpha', 'alpha one']);
      // `showJsonMany` validates each shelf as it reads it and throws before any
      // output is written, so a bad shelf aborts the batch with nothing on stdout.
      const r = await run(['show', 'alpha', '../escape', '--json']);
      expect(r.code).toBe(1);
      // Structured error on stdout (the --json throw contract), never a partial array.
      expect(r.out).not.toContain('"shelf":"alpha"');
    });

    test('a bare `nb show` with no shelf still errors', async () => {
      const r = await run(['show']);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/missing <shelf>/);
    });
  });

  // issue #240 (#223-F3) — `nb stale` surfaces cull candidates (the order
  // eviction would drop them in) so the retro can downvote/rm the weakest.
  describe('nb stale — cull candidates (issue #240)', () => {
    // Seed four lessons, then lift two so the +1 floor (c, d) sorts to the top.
    async function seedShelf(): Promise<void> {
      for (const t of ['a', 'b', 'c', 'd']) await run(['add', 's', t]);
      await run(['vote', 's', entryId('a'), '+1']);
      await run(['vote', 's', entryId('a'), '+1']); // a -> +3
      await run(['vote', 's', entryId('b'), '+1']); // b -> +2
    }

    test('lists candidates most-disposable-first with an N-of-M, cull-by-id footer', async () => {
      await seedShelf();
      const r = await run(['stale', 's']);
      expect(r.code).toBe(0);
      const lessonLines = r.out.split('\n').filter((l) => /^[0-9a-f]{6}\s/.test(l));
      expect(lessonLines.map((l) => l.replace(/^[0-9a-f]{6}\s+\[[^\]]+\]\s+/, ''))).toEqual(['c', 'd', 'b', 'a']);
      expect(r.out).toMatch(/most disposable first/);
      expect(r.out).toContain('showing 4 of 4');
      expect(r.out).toContain('nb vote s <id> -1');
      expect(r.out).toContain('nb rm s <id> --reason obsolete');
    });

    test('--limit caps the printed list and the footer says "N of total"', async () => {
      await seedShelf();
      const r = await run(['stale', 's', '--limit', '2']);
      expect(r.code).toBe(0);
      expect(r.out.split('\n').filter((l) => /^[0-9a-f]{6}\s/.test(l))).toHaveLength(2);
      expect(r.out).toContain('showing 2 of 4');
    });

    test('a bad --limit warns on stderr and falls back to the default (stdout stays clean)', async () => {
      await seedShelf();
      const r = await run(['stale', 's', '--limit', 'abc']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/unrecognized --limit 'abc'/);
      expect(r.out).not.toContain('--limit'); // the warning never leaks to stdout
    });

    test('--json emits a lone StaleResult object, same ranking, no comment lines', async () => {
      await seedShelf();
      const r = await run(['stale', 's', '--json']);
      expect(r.code).toBe(0);
      expect(r.out.trim().split('\n')).toHaveLength(1);
      const parsed = JSON.parse(r.out);
      expect(parsed.shelf).toBe('s');
      expect(parsed.total).toBe(4);
      expect(parsed.exists).toBe(true);
      expect(parsed.entries.map((e: { text: string }) => e.text)).toEqual(['c', 'd', 'b', 'a']);
    });

    test('a never-created shelf prints "no notebook" on stderr, exit 0, nothing on stdout', async () => {
      const r = await run(['stale', 'ghostshelf']);
      expect(r.code).toBe(0); // not found is not an error (DP-5, like `show`)
      expect(r.err).toContain('no notebook for shelf "ghostshelf"');
      expect(r.out).toBe('');
    });

    test('it is read-only: a `show` after `stale` is byte-identical to before', async () => {
      await seedShelf();
      const before = await run(['show', 's']);
      await run(['stale', 's']);
      await run(['stale', 's', '--limit', '1']);
      const after = await run(['show', 's']);
      expect(after.out).toBe(before.out); // no reorder, no score change
    });
  });

  // issue #166 — `nb show` must tell a never-created shelf (e.g. a typo) apart
  // from a real empty notebook, so a mistake is never reported as "empty" (DP-5).
  describe('show distinguishes a missing shelf from an empty one (issue #166)', () => {
    test('a never-created shelf prints a distinct "no notebook" line on stderr, exit 0, no "is empty"', async () => {
      const r = await run(['show', 'typoshelf']);
      expect(r.code).toBe(0); // not found is not an error
      expect(r.err).toContain('no notebook for shelf "typoshelf"');
      expect(r.err).toContain('nb list'); // points the reader at how to find real shelves
      expect(r.out).not.toContain('is empty'); // the misleading message is gone
      expect(r.out).toBe(''); // nothing on stdout for an absent shelf
    });

    test('a describe-only (existing but empty) shelf still prints "(… is empty)" on stdout — distinct from missing', async () => {
      await run(['describe', 'drafts', 'where half-baked lessons go']); // creates the file, no lessons
      const r = await run(['show', 'drafts']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('# desc: where half-baked lessons go');
      expect(r.out).toContain('(notebook for shelf "drafts" is empty)'); // reserved for an existing empty shelf
      expect(r.err).not.toContain('no notebook for shelf'); // NOT the missing-shelf path
    });

    test('a populated shelf is unaffected — it prints its lessons, not either empty-state line', async () => {
      await run(['add', 'drafts', 'keep lessons under 200 chars']);
      const r = await run(['show', 'drafts']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('keep lessons under 200 chars');
      expect(r.out).not.toContain('is empty');
      expect(r.err).not.toContain('no notebook for shelf');
    });

    test('--json: a describe-only shelf reports exists:true with entries:[], a never-created one exists:false', async () => {
      await run(['describe', 'drafts', 'd']); // existing but empty
      const existing = JSON.parse((await run(['show', 'drafts', '--json'])).out);
      expect(existing.exists).toBe(true);
      expect(existing.entries).toEqual([]);

      const missing = JSON.parse((await run(['show', 'ghost', '--json'])).out);
      expect(missing.exists).toBe(false);
      expect(missing.entries).toEqual([]);
    });
  });

  test('show prints a copy-paste vote hint with the shelf filled in (issue #223)', async () => {
    await run(['add', 'patcher', 'a fine lesson']);
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('# vote by id: nb vote patcher <id> +1|-1');
    expect(show.out).toContain('nb vote patcher <id1,id2,…> +1'); // batch form advertised
    // The hint is a `#` comment line, so the json-vs-plain id filter ignores it
    // and it can never be parsed back as a lesson.
    expect(show.out).toMatch(/^#/m);
  });

  test('the vote hint is suppressed under --json and on an empty/missing notebook', async () => {
    // --json stays a lone ShowResult object (no trailing hint line).
    await run(['add', 'patcher', 'a fine lesson']);
    const j = await run(['show', 'patcher', '--json']);
    expect(j.out.trim().split('\n')).toHaveLength(1);
    expect(j.out).not.toContain('vote by id');
    // A never-created shelf prints no hint (nothing to vote on).
    const missing = await run(['show', 'ghostshelf']);
    expect(missing.out).not.toContain('vote by id');
  });

  test('vote by the id shown in `show` succeeds', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const show = await run(['show', 'patcher']);
    const id = show.out.trim().split('\n')[0].split(/\s+/)[0]; // first token of the top line
    const v = await run(['vote', 'patcher', id, '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('vote adjusts the score shown', async () => {
    await run(['add', 'patcher', 'run lint before done']);
    const v = await run(['vote', 'patcher', 'lint', '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('vote accepts -1 and the ++/-- delta aliases through the CLI', async () => {
    // The CLI vote tests otherwise only drive +1 success and an invalid delta.
    // parseDelta also accepts `-1`, `++`, and `--`; exercise those branches end
    // to end so a break in the alias/negative parsing is caught at the CLI layer.
    await run(['add', 'patcher', 'tune this lesson']); // starts at +1
    const up = await run(['vote', 'patcher', 'tune', '++']); // alias for +1
    expect(up.code).toBe(0);
    expect(up.out).toContain('[+2]');
    const down = await run(['vote', 'patcher', 'tune', '-1']); // explicit -1
    expect(down.code).toBe(0);
    expect(down.out).toContain('[+1]');
    const down2 = await run(['vote', 'patcher', 'tune', '--']); // alias for -1
    expect(down2.code).toBe(0);
    expect(down2.out).toContain('[+0]'); // signed-zero formatting from fmt()
  });

  // issue #277 — `--json` was stripped from the WHOLE argv (operands included),
  // and there was no `--` end-of-options terminator, so an operand that equals a
  // known flag failed with a baffling "missing <lesson>". The fix adds a POSIX
  // `--` terminator: every token after the first `--` is a literal operand.
  describe('nb `--` end-of-options terminator (issue #277)', () => {
    // Read back a single shelf's stored entry texts, highest-score first, via the
    // structured `show --json` so the assertions never regex the human output.
    async function texts(shelf: string): Promise<string[]> {
      const r = await run(['show', shelf, '--json']);
      return (JSON.parse(r.out).entries as Array<{ text: string }>).map((e) => e.text);
    }

    test('add stores a literal `--json` operand after `--` instead of stripping it', async () => {
      // The exact failing case from the issue: record a glossary line that is
      // literally `--json`. Pre-fix this threw `missing <lesson>`; now `--`
      // passes it through verbatim.
      const r = await run(['add', 'glossary', '--', '--json']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('added — 1 line'); // human output => `--json` was NOT taken as the output flag
      expect(await texts('glossary')).toEqual(['--json']);
    });

    test('a `--json` operand after `--` is not the output flag, yet a real `--json` before `--` still is', async () => {
      // `--json` before `--` still selects structured output; the one after `--`
      // is the literal lesson. Both honored in a single call.
      const r = await run(['add', 'glossary', '--json', '--', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out); // output flag honored => one JSON object
      expect(parsed.reason).toBe('added');
      expect(await texts('glossary')).toEqual(['--json']); // literal lesson stored
    });

    test('operands after `--` are shielded from `--reason`/`--note` extraction', async () => {
      // A lesson that is literally `--reason` would otherwise be swallowed by the
      // reason/note parser; after `--` it is a plain operand. A real `--note`
      // before `--` is still consumed as the log note, not stored.
      expect((await run(['add', 'glossary', '--', '--reason'])).code).toBe(0);
      const r = await run(['add', 'glossary', '--note', 'escaping a flag', '--', '--json']);
      expect(r.code).toBe(0);
      expect((await texts('glossary')).sort()).toEqual(['--json', '--reason']);
    });

    test('describe accepts a literal `--json` description after `--`', async () => {
      await run(['add', 'glossary', 'seed lesson']);
      const d = await run(['describe', 'glossary', '--', '--json']);
      expect(d.code).toBe(0);
      expect(JSON.parse((await run(['show', 'glossary', '--json'])).out).description).toBe('--json');
    });

    test('a bare trailing `--` is a literal operand, not a terminator (vote downvote alias preserved)', async () => {
      // `vote`'s `--` downvote alias is a bare trailing `--`; the terminator must
      // only fire when a token follows, so this stays a downvote, and a trailing
      // `--` to `add` stores the literal `--` lesson exactly as before the fix.
      await run(['add', 'patcher', 'trailer lesson']);
      const v = await run(['vote', 'patcher', 'trailer', '--']);
      expect(v.code).toBe(0);
      expect(v.out).toContain('[+0]'); // downvoted from +1
      const a = await run(['add', 'patcher', '--']);
      expect(a.code).toBe(0);
      expect(await texts('patcher')).toContain('--');
    });

    test('search reads a flag-shaped query after `--` literally, not as its own `--any`/`--limit` flag', async () => {
      // The per-command parsers (`--any`, `--limit`) run on the pre-`--` region,
      // so a query that is literally `--any` or `--limit` after `--` is searched
      // for, not consumed — pre-fix these threw "missing query" / "--limit needs
      // a value". The `--any` OR-mode flag before `--` still works.
      await run(['add', 'kb', 'mentions --any and --limit flags']);
      const q1 = await run(['search', '--', '--any']);
      expect(q1.code).toBe(0);
      expect(q1.out).toContain('"--any"'); // the query echoed, AND-mode (not OR)
      expect(q1.out).toContain('mentions --any and --limit flags');
      const q2 = await run(['search', '--', '--limit']);
      expect(q2.code).toBe(0);
      expect(q2.out).toContain('"--limit"');
      const flag = await run(['search', 'mentions', '--any']); // real OR-mode flag, no `--`
      expect(flag.code).toBe(0);
      expect(flag.out).toContain('(OR over 1 term)');
    });

    test('list takes a flag-shaped prefix after `--` literally instead of erroring on `--limit`', async () => {
      // Pre-fix `nb list -- --limit` threw "--limit needs a value"; now `--limit`
      // is a literal prefix (matching nothing), a clean exit-0 empty result.
      const r = await run(['list', '--', '--limit']);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('needs a value');
    });

    test('without a `--` terminator, a bare `--json` operand still reads as the flag (behavior preserved)', async () => {
      // The ambiguous bare form is unchanged: `--json` with nothing to
      // disambiguate is still the output flag, so `add` reports the missing
      // lesson. Escaping it is exactly what `--` is for.
      const r = await run(['add', 'glossary', '--json']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('missing <lesson> argument');
    });
  });

  // issue #267 — a mistyped or misplaced `--flag` used to be silently ignored
  // (or absorbed as a positional), so `nb stats --exitcode >/dev/null || alert`
  // (a typo of `--exit-code`) ran WITHOUT the health gate and still exited 0 —
  // the #129 cron monitor silently stopped firing. Unknown long options are now
  // refused up front (exit 1, message on stderr, nearest-option hint).
  describe('nb unknown-flag rejection (issue #267)', () => {
    test('the motivating case: `nb stats --exitcode` is refused, not silently run exit 0', async () => {
      const r = await run(['stats', '--exitcode']);
      expect(r.code).toBe(1); // a non-zero exit so `|| alert` fires on the typo
      expect(r.code).not.toBe(0); // the pre-fix silent-degrade bug
      expect(r.err).toMatch(/unknown option "--exitcode" for `nb stats`/);
      expect(r.err).toMatch(/Did you mean `--exit-code`\?/); // nearest-option hint
      expect(r.out).toBe(''); // nothing printed; the command never ran
    });

    test('the correctly-spelled `--exit-code` is still accepted (regression guard)', async () => {
      // A fresh notebook dir has no anomalies, so the gate passes with exit 0;
      // the point is the real flag is NOT caught by the unknown-flag guard.
      const r = await run(['stats', '--exit-code']);
      expect(r.err).not.toContain('unknown option');
      expect([0, 3]).toContain(r.code); // 0 (no anomalies) or 3 (anomalies), never 1
    });

    test('a valid flag with a value is accepted and its value is not mistaken for an option', async () => {
      const r = await run(['stats', '--since', '7d']);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('unknown option'); // `7d` is a value, not a flag
    });

    test('an unknown flag on a read command (`show`) is refused before it needs a shelf', async () => {
      const r = await run(['show', 'reviewer', '--verbose']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/unknown option "--verbose" for `nb show`/);
    });

    test('a flag valid elsewhere but not for this command is refused (no cross-command bleed)', async () => {
      // `--since` is a `stats` flag; on `show` it is unknown and was silently
      // dropped (and `reviewer` taken as the shelf) before the fix.
      const r = await run(['show', 'reviewer', '--since', '7d']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/unknown option "--since" for `nb show`/);
    });

    test('a mutation flag typo (`--resaon`) is refused and points at `--reason`', async () => {
      await run(['add', 'glossary', 'a seed lesson']);
      const r = await run(['add', 'glossary', 'another lesson', '--resaon', 'dup']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/unknown option "--resaon" for `nb add`/);
      expect(r.err).toMatch(/Did you mean `--reason`\?/);
    });

    test('a far-off unknown flag is still refused, with NO misleading suggestion', async () => {
      const r = await run(['show', 'reviewer', '--zzzzzz']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/unknown option "--zzzzzz" for `nb show`/);
      expect(r.err).not.toContain('Did you mean'); // nothing close enough to suggest
    });

    test('a flag-shaped VALUE of a value-taking flag is not mistaken for an unknown option', async () => {
      // `--note`/`--reason`/`--limit`/`--since` consume their following token, so
      // a note that is literally `--exitcode` must be stored, never rejected.
      const r = await run(['add', 'glossary', 'noted lesson', '--note', '--exitcode']);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('unknown option');
    });

    test('the `--` terminator still shields a flag-shaped token from the guard (issue #277 interop)', async () => {
      // After `--`, every token is a literal operand, so `nb stats -- --exitcode`
      // is NOT an unknown-flag error — it is the documented escape hatch.
      const r = await run(['stats', '--', '--exitcode']);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('unknown option');
    });

    test('stats honors the `--` terminator: `-- --json` stays human, `-- --exit-code` skips the gate (issue #302)', async () => {
      const r = await run(['stats', '--', '--json']);
      expect(r.code).toBe(0);
      expect(() => JSON.parse(r.out)).toThrow();
      const g = await run(['stats', '--', '--exit-code']);
      expect(g.code).toBe(0);
      expect(g.out).not.toMatch(/^\{/);
    });

    test('a bare trailing `--` (vote downvote alias) is never treated as an unknown flag', async () => {
      await run(['add', 'patcher', 'downvote me']);
      const r = await run(['vote', 'patcher', 'downvote', '--']); // `--` == -1
      expect(r.code).toBe(0);
      expect(r.err).not.toContain('unknown option');
      expect(r.out).toContain('[+0]'); // downvoted from +1
    });

    test('an unknown COMMAND with a flag still takes the exit-2 unknown-command path, not exit 1', async () => {
      // The flag guard must not mask (or downgrade) the unknown-command error.
      const r = await run(['frobnicate', '--json']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^nb: unknown command "frobnicate"\./);
    });

    test('an unknown flag under --json emits the structured error contract (issue #266 interop)', async () => {
      const r = await run(['stats', '--exitcode', '--json']);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.out)).toMatchObject({
        ok: false,
        command: 'stats',
        error: { class: 'bad_args' },
      });
      expect(r.err).toMatch(/unknown option "--exitcode"/); // prose still on stderr
    });

    test('KNOWN_FLAGS has a row for every dispatched command (drift guard)', () => {
      // Every KNOWN_COMMANDS entry except help/version (which return before the
      // switch) MUST have a KNOWN_FLAGS row, or that command silently opts out of
      // unknown-flag validation. Mirrors the KNOWN_COMMANDS dispatch drift guard.
      const needRow = KNOWN_COMMANDS.filter((c) => c !== 'help' && c !== 'version');
      const missing = needRow.filter((c) => !(c in KNOWN_FLAGS));
      expect(missing).toEqual([]);
      // And no phantom rows for commands that do not exist.
      const phantom = Object.keys(KNOWN_FLAGS).filter((c) => !(KNOWN_COMMANDS as readonly string[]).includes(c));
      expect(phantom).toEqual([]);
      // Anti-vacuous: the guard is meaningless if either list resolved empty.
      expect(needRow.length).toBeGreaterThan(0);
    });

    test('behavioral drift guard: every command rejects a nonsense `--flag`', async () => {
      // Independently of the KNOWN_FLAGS table, prove each real command actually
      // runs the guard: a nonsense flag must exit 1 with "unknown option".
      for (const cmd of KNOWN_COMMANDS) {
        if (cmd === 'help' || cmd === 'version') continue; // return before the switch
        const r = await run([cmd, '--definitely-not-a-real-flag']);
        expect(r.code, `\`nb ${cmd} --definitely-not-a-real-flag\` should be refused`).toBe(1);
        expect(r.err).toContain('unknown option "--definitely-not-a-real-flag"');
      }
    });

    test('acceptance guard: each list-like command still ACCEPTS its real `--limit`', async () => {
      // The rejection guards prove a nonsense flag dies; this proves the real
      // `--limit` row is not over-zealously rejected. Without it, emptying the
      // `ls`/`shelves`/`roles`/`stale` row to [] would silently break `--limit`
      // there and no test would notice (the rejection loop can't catch it).
      await run(['add', 'reviewer', 'a seed lesson']); // a shelf to list/cull
      for (const cmd of ['list', 'ls', 'shelves', 'roles', 'stale']) {
        const argv = cmd === 'stale' ? [cmd, 'reviewer', '--limit', '2'] : [cmd, '--limit', '2'];
        const r = await run(argv);
        expect(r.code, `\`nb ${argv.join(' ')}\` should accept --limit`).toBe(0);
        expect(r.err).not.toContain('unknown option');
      }
    });

    test('no cross-command bleed into empty-row commands (`vote`/`config`)', async () => {
      // `vote`, `config`, `completion` accept only `--json`; a flag valid on
      // another command must still be unknown here. Pins the empty rows so a
      // regression that leaks `--reason`/`--limit` into them is caught.
      await run(['add', 'patcher', 'bleed check']);
      const v = await run(['vote', 'patcher', 'bleed', '+1', '--reason', 'dup']);
      expect(v.code).toBe(1);
      expect(v.err).toMatch(/unknown option "--reason" for `nb vote`/);
      const c = await run(['config', '--limit', '3']);
      expect(c.code).toBe(1);
      expect(c.err).toMatch(/unknown option "--limit" for `nb config`/);
    });

    test('value flags other than --note also consume a flag-shaped value (no false "unknown option")', async () => {
      // Pins every VALUE_FLAGS entry, not only `--note`: the token after a
      // value-taking flag is its value and must never be re-examined as an
      // option. (Whether the command then succeeds, warns-and-defaults, or
      // throws "needs a value" is its own concern — the invariant under test is
      // that NONE of them is ever mis-reported as an unknown option.)
      const r1 = await run(['add', 'glossary', 'reasoned lesson', '--reason', '--exitcode']);
      expect(r1.code).toBe(0); // `--reason` stores arbitrary text, incl. flag-shaped
      expect(r1.err).not.toContain('unknown option');
      // `--since`'s flag-shaped value is forgivingly defaulted (warned), never an
      // unknown option; the real `--exit-code` after it is still honored.
      const r2 = await run(['stats', '--since', '--exit-code']);
      expect(r2.err).not.toContain('unknown option');
      // `--limit`'s value token is consumed by the guard; the command then throws
      // its own "needs a value" — still never an "unknown option" rejection.
      const r3 = await run(['search', 'needle', '--limit', '--any']);
      expect(r3.err).not.toContain('unknown option');
    });

    test('a rejected flag aborts BEFORE the mutation runs (no partial write)', async () => {
      // The guard must fire before dispatch: a typo'd flag on `add` must NOT
      // store the lesson. Guards against the guard being moved after the write.
      await run(['add', 'glossary', 'the only real lesson']);
      const r = await run(['add', 'glossary', 'should never be stored', '--resaon', 'dup']);
      expect(r.code).toBe(1);
      const shown = await run(['show', 'glossary', '--json']);
      const texts = (JSON.parse(shown.out).entries as Array<{ text: string }>).map((e) => e.text);
      expect(texts).toEqual(['the only real lesson']); // the rejected lesson never landed
    });
  });

  test('a comma-separated id list votes every entry at once', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    await run(['add', 'patcher', 'gamma three']);
    const idA = entryId('alpha one');
    const idG = entryId('gamma three');
    const v = await run(['vote', 'patcher', `${idA},${idG}`, '+1']);
    expect(v.code).toBe(0);
    // One output line per landed vote, both at +2; beta untouched.
    expect(v.out).toContain('alpha one');
    expect(v.out).toContain('gamma three');
    expect(v.out).not.toContain('beta two');
    expect((v.out.match(/\[\+2\]/g) ?? [])).toHaveLength(2);
  });

  test('batch vote is best-effort: a stale id is reported on stderr, the rest land', async () => {
    await run(['add', 'patcher', 'alpha one']);
    const idA = entryId('alpha one');
    const v = await run(['vote', 'patcher', `${idA},ffffff`, '+1']);
    expect(v.code).toBe(0); // one landed → success
    expect(v.out).toContain('[+2]');
    expect(v.err).toContain('ffffff');
  });

  test('batch vote exits non-zero when NO id resolves', async () => {
    await run(['add', 'patcher', 'alpha one']);
    const v = await run(['vote', 'patcher', 'ffffff,eeeeee', '+1']);
    expect(v.code).toBe(1);
    expect(v.err).toContain('ffffff');
    expect(v.err).toContain('eeeeee');
  });

  test('an all-fail batch logs a BLANK outcome (not up/down), like a single failed vote', async () => {
    // Regression guard: stats() keys vote engagement on the outcome column, not
    // the ok flag, so an all-fail batch that stamped outcome='up' would count a
    // phantom upvote and mark the session engaged. The failure row must carry a
    // blank outcome and no entries, exactly as the single-vote no-match path does.
    await run(['add', 'patcher', 'alpha one']);
    await run(['vote', 'patcher', 'ffffff,eeeeee', '+1']); // both stale → nothing lands
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('vote');
    expect(row.ok).toBe(false);
    expect(row.outcome).toBe('');
    expect(row.entries).toEqual([]);
  });

  test('a partially-landed batch records the stale-id miss count and keeps exit 0 (issue #310)', async () => {
    // Acceptance (#310): one good + two stale ids. The row must exit 0 (success),
    // record only the landed id, AND stamp misses=2 so `nb stats` can count the
    // two laundered selector misses in its vote error causes. Before #310 this
    // row logged a clean success with no trace of the two stale ids.
    await run(['add', 'patcher', 'alpha one']);
    const idA = entryId('alpha one');
    const v = await run(['vote', 'patcher', `${idA},ffffff,eeeeee`, '+1']);
    expect(v.code).toBe(0); // one landed → exit unchanged
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('vote');
    expect(row.ok).toBe(true);
    expect(row.outcome).toBe('up');
    expect(row.entries).toEqual([idA]); // only the landed id
    expect(row.misses).toBe(2); // the two stale ids are counted, not laundered
    expect(row.errorClass).toBe(''); // a dedicated counter, NOT errorClass (keeps exit 0)
  });

  test('an all-fail batch records NO miss count (issue #310 leaves the no_match path untouched)', async () => {
    // The all-fail path keeps its errorClass=no_match / exit-1 behavior; it does
    // NOT also stamp the partial-miss counter (that is only for a ≥1-landed batch).
    await run(['add', 'patcher', 'alpha one']);
    const v = await run(['vote', 'patcher', 'ffffff,eeeeee', '+1']);
    expect(v.code).toBe(1);
    const row = parseUsage(dir).at(-1)!;
    expect(row.ok).toBe(false);
    expect(row.errorClass).toBe('no_match');
    expect(row.misses).toBe(0); // the miss counter is reserved for partial successes
  });

  test('a fully-landed batch records no misses (issue #310)', async () => {
    // No stale ids → the miss counter stays 0, so the vote error causes see nothing.
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const idA = entryId('alpha one');
    const idB = entryId('beta two');
    const v = await run(['vote', 'patcher', `${idA},${idB}`, '+1']);
    expect(v.code).toBe(0);
    expect(parseUsage(dir).at(-1)!.misses).toBe(0);
  });

  test('partial-batch misses surface end-to-end in `nb stats` vote error causes (issue #310)', async () => {
    // Full wiring through the real CLI: two ≥1-landed batch votes each skip two
    // stale ids (4 misses total, over the ERROR_CAUSE_MIN noise floor). Both
    // exit 0, yet `nb stats` must now name the laundered selector misses as
    // no_match under the vote command — proving logUsage writes and parseUsage
    // reads the new column, and stats folds it into the cause readout.
    await run(['add', 'patcher', 'alpha one']);
    const idA = entryId('alpha one');
    const v1 = await run(['vote', 'patcher', `${idA},ffffff,eeeeee`, '+1']);
    const v2 = await run(['vote', 'patcher', `${idA},dddddd,cccccc`, '+1']);
    expect(v1.code).toBe(0);
    expect(v2.code).toBe(0);
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const vote = JSON.parse(s.out).errorCauses.find((c: { command: string }) => c.command === 'vote');
    expect(vote).toBeDefined();
    expect(vote.errors).toBe(4); // 0 error rows + 4 folded partial misses
    expect(vote.breakdown).toEqual([{ cause: 'no_match', pct: 100 }]);
  });

  test('a landed batch logs outcome=up and the touched ids', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const idA = entryId('alpha one');
    const idB = entryId('beta two');
    await run(['vote', 'patcher', `${idA},${idB}`, '+1']);
    const row = parseUsage(dir).at(-1)!;
    expect(row.ok).toBe(true);
    expect(row.outcome).toBe('up');
    expect(row.entries).toEqual([idA, idB]);
  });

  test('--json on a batch emits the per-id result array', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const idA = entryId('alpha one');
    const idB = entryId('beta two');
    const v = await run(['vote', 'patcher', `${idA},${idB}`, '+1', '--json']);
    expect(v.code).toBe(0);
    const parsed = JSON.parse(v.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((r: { id: string }) => r.id)).toEqual([idA, idB]);
    expect(parsed.every((r: { score: number }) => r.score === 2)).toBe(true);
  });

  test('a text selector containing a comma is NOT treated as an id list', async () => {
    // Guards the id-only batch rule: "build, then test" has a comma but is not a
    // list of bare hex ids, so it must resolve as a single substring selector.
    await run(['add', 'patcher', 'build, then test the change']);
    const v = await run(['vote', 'patcher', 'build, then test', '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
    expect(v.out).toContain('build, then test the change');
  });

  test('stats --since labels the window and returns 0', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '30m']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 30m');
  });

  test('a valid --since emits no warning', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '12h']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 12h');
    expect(s.err).toBe('');
  });

  test('a malformed --since warns naming the format and the window used, then proceeds', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days']);
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since '7days'");
    expect(s.err).toContain('Nd/Nh/Nm'); // names the accepted format
    expect(s.err).toContain('showing 7d'); // names the window actually used
    expect(s.err.trimEnd().split('\n')).toHaveLength(1); // one line, per the acceptance criteria
    expect(s.out).toContain('window 7d'); // falls back to the default and still reports
  });

  test('--since with no value warns, renders empty quotes, and still resolves the shelf', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since']); // --since is the final arg
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since ''"); // empty-quote fallback for a missing value
    expect(s.err).toContain('showing 7d');
    expect(s.out).toContain('window 7d');
    expect(s.out).toContain('shelf patcher'); // shelf still parsed despite the dangling flag
  });

  test('the human stats table renders a detected anomaly line (with the shelf suffix)', async () => {
    // The --json path and the library's anomaly detection are both covered, but
    // the HUMAN table's anomaly rendering in renderStats (the `anomalies:` header
    // and the `[kind] command (shelf X): detail` line, including the conditional
    // shelf suffix) had no test. Seed a tight loop of calls into the usage log,
    // then run `nb stats` WITHOUT --json and assert the rendered anomaly line, so
    // a regression in that user-facing formatting is caught.
    process.env.NB_LOOP_N = '3';
    process.env.NB_LOOP_WINDOW_S = '120';
    const now = Date.now();
    const rows = Array.from({ length: 4 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tpatcher\tadd\tok\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']); // default table path (no --json)
    expect(s.code).toBe(0);
    expect(s.out).toContain('  anomalies:'); // the header branch, not the "none" line
    expect(s.out).toContain('[loop] add (shelf patcher):'); // kind, command, and the conditional shelf suffix
    expect(s.out).not.toContain('anomalies: none');
    // The per-command table row is rendered too (the `add` command summary line).
    expect(s.out).toMatch(/^\s*add\s+\d+\s+\d+%/m);
  });

  test('the human stats table renders the error-causes block with the upgrade hint (issue #223)', async () => {
    const now = Date.now();
    const mk = (cmd: string, cls = '', outcome = ''): string =>
      `${new Date(now - Math.random() * 1000).toISOString()}\tpatcher\t${cmd}\terr\t2ms\t\t\t${outcome}\t\t\t\t\t${cls}`;
    const rows = [
      mk('add', 'too_long'), mk('add', 'too_long'), mk('add', 'too_long'), // 3 → meets the min
      mk('vote'), mk('vote'), mk('vote'), // 3 unclassified → triggers the upgrade hint
    ];
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('  error causes:');
    expect(s.out).toMatch(/add\s+too_long 100%\s+\(3 err\)/);
    expect(s.out).toMatch(/vote\s+unclassified 100%\s+\(3 err\)/);
    expect(s.out).toContain('upgrade nb'); // the hint, since vote errors are unclassified
  });

  test('the human stats table shows the usage-ring occupancy line (issue #206)', async () => {
    // The ring's own fill (how full the monitoring log is) must be visible in the
    // human table, not only in --json — the analogue of the notebook inventory.
    process.env.NB_USAGE_RING = '5000';
    const now = Date.now();
    const rows = Array.from({ length: 3 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tpatcher\tshow\tok\t1ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('usage ring: 3/5000 rows');
  });

  test('a clean ring reports zero crash recovery, shown not omitted, with no warning marker (issue #309)', async () => {
    await run(['add', 'patcher', 'a lesson with no crash in sight']);
    const s = await run(['stats']);
    expect(s.code).toBe(0);
    // Zero is shown (plural wording) so "measured, healthy" isn't read as "not
    // measured", and the ⚠ marker only appears when something was actually recovered.
    expect(s.out).toContain('crash recovery: 0 stale locks stolen, 0 leftover temps reaped (window)');
    expect(s.out).not.toContain('⚠ crashes recovered');
  });

  test('a mutation over a stale lock + crash-left temp surfaces in nb stats (issue #309)', async () => {
    // End-to-end acceptance: pre-age the lock and plant a per-pid shelf temp so the
    // next real `nb add` steals the lock and reaps the temp; the recovery must then
    // show up in both the human stats table and --json, without failing the add.
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // a crashed nb left the lock behind
    const aged = Date.now() / 1000 - 20; // > 10s default stale threshold
    utimesSync(lock, aged, aged);
    writeFileSync(join(dir, 'scout.md.99999.tmp'), 'half-written', 'utf-8'); // crash-left temp

    const add = await run(['add', 'patcher', 'a lesson added after crash recovery']);
    expect(add.code).toBe(0); // recovery did not break the mutation

    const human = await run(['stats']);
    expect(human.code).toBe(0);
    // Singular wording at a count of 1, and the warning marker flags the nonzero.
    expect(human.out).toContain('crash recovery: 1 stale lock stolen, 1 leftover temp reaped (window)  ⚠ crashes recovered');

    const js = await run(['stats', '--json']);
    expect(JSON.parse(js.out).crashRecovery).toEqual({ lockSteals: 1, tempReaps: 1 });
  });

  // --exit-code (issue #129): the opt-in health gate. Seed a tight loop of calls
  // so the window holds a `loop` anomaly, exactly as the anomaly-render test does,
  // and assert the exit code across the three cases. Exit 3 is deliberate: it is
  // distinct from 1 (handled error) and 2 (unknown command).
  function seedLoop(): void {
    process.env.NB_LOOP_N = '3';
    process.env.NB_LOOP_WINDOW_S = '120';
    const now = Date.now();
    const rows = Array.from({ length: 4 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tpatcher\tadd\tok\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
  }

  test('stats --exit-code exits 3 when the window holds an anomaly', async () => {
    seedLoop();
    const s = await run(['stats', 'patcher', '--exit-code']);
    expect(s.out).toContain('  anomalies:'); // the anomaly is present and printed
    expect(s.out).not.toContain('anomalies: none');
    expect(s.code).toBe(3); // non-zero, and distinct from 1/2
  });

  test('stats --exit-code exits 0 when the window holds no anomaly', async () => {
    // A single healthy `add` with the default loop threshold → no anomaly.
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--exit-code']);
    expect(s.out).toContain('anomalies: none');
    expect(s.code).toBe(0);
  });

  test('stats WITHOUT --exit-code still exits 0 even when an anomaly is present (no breaking change)', async () => {
    seedLoop();
    const s = await run(['stats', 'patcher']); // same anomalous window, no flag
    expect(s.out).toContain('  anomalies:'); // the anomaly is still detected and printed
    expect(s.out).not.toContain('anomalies: none');
    expect(s.code).toBe(0); // default behavior unchanged: always 0
  });

  test('stats --exit-code composes with --json (JSON on stdout, exit 3 on anomaly)', async () => {
    seedLoop();
    const s = await run(['stats', 'patcher', '--exit-code', '--json']);
    const rep = JSON.parse(s.out);
    expect(rep.anomalies.length).toBeGreaterThanOrEqual(1);
    expect(s.code).toBe(3);
  });

  test('stats --exit-code composes with --since (exit 3 on the filtered window)', async () => {
    seedLoop(); // rows are seconds old, so a 30m window still holds the loop
    const s = await run(['stats', 'patcher', '--since', '30m', '--exit-code']);
    expect(s.out).toContain('window 30m');
    expect(s.code).toBe(3);
  });

  test('an exit-3 stats run still logs its own call as ok (ok=true precedes the early return)', async () => {
    // The anomaly exit returns 3 from inside the try, BEFORE the `ok = true` after
    // the switch. The stats case sets `ok = true` itself so the finally's logUsage
    // records the call as a success — otherwise the self-logged `stats` row would
    // read as an error and feed the high-error-rate detector. Guard that here: run
    // --exit-code to exit 3, then assert every `stats` row in the log is `ok`.
    seedLoop();
    const s = await run(['stats', 'patcher', '--exit-code']);
    expect(s.code).toBe(3);
    const statsRows = parseUsage(dir).filter((r) => r.command === 'stats');
    expect(statsRows.length).toBeGreaterThanOrEqual(1); // the call self-logged
    expect(statsRows.every((r) => r.ok)).toBe(true); // ...and as a success, not an error
  });

  test('the human stats table renders the ops-per-day activity sparkline line (issue #106)', async () => {
    // Seed a known pattern: the OLDEST 24h bucket (≈6.5 days ago) is the busiest.
    // The `stats` call self-logs one row into the NEWEST bucket, so only the
    // rightmost glyph can shift — the leftmost (busiest) glyph and the line
    // format stay deterministic.
    const now = Date.now();
    const DAY = 86_400_000;
    const rows: string[] = [];
    for (let k = 0; k < 8; k++) rows.push(`${new Date(now - 6.5 * DAY).toISOString()}\tpatcher\tshow\tok\t2ms\ts1`);
    rows.push(`${new Date(now - 2.5 * DAY).toISOString()}\tpatcher\tshow\tok\t2ms\ts1`);
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']); // default table path (no --json)
    expect(s.code).toBe(0);
    // One `activity` line: 7 block glyphs for a 7d window + the "(7d, N ops)" label.
    expect(s.out).toMatch(/^ {2}activity {2}[▁▂▃▄▅▆▇█]{7} {2}\(7d, \d+ ops\)$/m);
    // The oldest bucket is the busiest (8 ops) → its glyph is the top block.
    const activityLine = s.out.split('\n').find((l) => l.includes('activity'))!;
    expect(activityLine).toContain('█'); // the busiest bucket renders as the full block
    expect(/activity {2}█/.test(activityLine)).toBe(true); // ...and it is the leftmost (oldest) glyph
  });

  test('stats --json exposes the per-day activity array (issue #106)', async () => {
    await run(['add', 'patcher', 'x']); // one `add` row; the stats read happens before stats self-logs
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out);
    expect(Array.isArray(rep.activity)).toBe(true);
    expect(rep.activity).toHaveLength(7); // default 7d window → 7 rolling-24h buckets
    expect(rep.activity.reduce((a: number, b: number) => a + b, 0)).toBe(rep.totalCalls);
    expect(rep.activity.at(-1)).toBe(1); // the single `add` is in the newest bucket
  });

  test('--json emits a single valid StatsReport object on stdout', async () => {
    await run(['add', 'patcher', 'x']); // records one `add` usage row
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out); // parses => valid JSON, exactly one object
    // Exactly one usage row exists at read time (the single `add`; this `stats`
    // row is logged only afterwards), so the counts are deterministic — assert
    // the concrete values, not just their types, or a miscount regression hides.
    expect(rep.window).toBe('7d'); // default window with no --since
    expect(rep.totalCalls).toBe(1);
    expect(rep.anomalies).toEqual([]); // one healthy call => no anomalies
    expect(rep.perCommand).toHaveLength(1); // only `add` recorded
    const add = rep.perCommand.find((c: { command: string }) => c.command === 'add');
    expect(add).toMatchObject({
      command: 'add',
      calls: 1,
      errors: 0,
      errorRate: 0,
      // latency is timing-dependent, but it must be a finite, non-negative number.
      p50ms: expect.any(Number),
      p95ms: expect.any(Number),
      lastUsed: expect.any(String),
    });
    expect(add.p50ms).toBeGreaterThanOrEqual(0);
    expect(add.lastUsed).not.toBe(''); // a real ISO timestamp was recorded
    expect(s.out).not.toContain('nb usage —'); // the human table is NOT emitted
  });

  // Issue #204: the README's "Machine-readable `nb stats`" section documents the
  // StatsReport shape as the one `--json` contract promised "stable". Drift there
  // is a silent broken promise — #132 added `generatedAt`/`windowStart` but the
  // documented shape string omitted them. Guard the shape against the REAL emitted
  // report (not a hand-copied key list) so any future added/renamed top-level field
  // must be reflected in the README or this fails.
  test('README documents every StatsReport top-level key, field-for-field (issue #204)', async () => {
    await run(['add', 'patcher', 'x']); // one row so a real report is emitted
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const emittedKeys = Object.keys(JSON.parse(s.out)).sort();

    // Extract the documented shape list from the README's StatsReport interface note.
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const m = readme.match(/exported `StatsReport` interface \(`\{([^}]*)\}`\)/);
    expect(m).not.toBeNull();
    const documentedKeys = m![1]
      .split(',')
      .map((f) => f.trim().replace(/\[\]$/, '')) // drop the `[]` array marker
      .filter(Boolean)
      .sort();

    // Round-trip: the documented shape and the emitted object carry the SAME keys —
    // neither a field the code emits but the README omits (the #204 gap), nor a
    // phantom field the README lists but the code never emits.
    expect(documentedKeys).toEqual(emittedKeys);
    // The two bounds #132 added are present (regression-pins the specific gap).
    expect(documentedKeys).toContain('generatedAt');
    expect(documentedKeys).toContain('windowStart');
  });

  test('--json composes with --since and a shelf, warning on stderr while stdout stays pure JSON', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days', '--json']); // bad window + shelf + json
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since '7days'"); // still warns on a bad window
    const rep = JSON.parse(s.out); // stdout is pure JSON despite the warning on stderr
    expect(rep.window).toBe('7d'); // bad window falls back to the default
  });

  test('without --json the default table path is unchanged; --json diverges only when asked', async () => {
    await run(['add', 'patcher', 'x']);
    const plain = await run(['stats', 'patcher', '--since', '30m']);
    const json = await run(['stats', 'patcher', '--since', '30m', '--json']);
    expect(plain.out).toContain('nb usage —'); // default path still renders the table
    expect(plain.out).toContain('window 30m');
    expect(() => JSON.parse(plain.out)).toThrow(); // the table is not JSON
    expect(plain.out).not.toBe(json.out); // the flag is the only thing that changes output
  });

  test('stats table shows the notebook inventory with a FULL marker at cap (issue #40)', async () => {
    process.env.NB_MAX_LINES = '2';
    await run(['add', 'patcher', 'alpha']);
    await run(['add', 'patcher', 'bravo']); // patcher now at cap 2/2
    await run(['add', 'scout', 'solo']); // scout below cap 1/2
    const s = await run(['stats']);
    expect(s.code).toBe(0);
    const out = s.out.split('\n').map((l) => l.trim());
    expect(out).toContain('notebooks: 2 shelves, 3 lines (cap 2/shelf)');
    // Whole-row, line-anchored assertions (^…$ on one line) so a regex can never
    // match across rows or treat 1/2 as a prefix of 1/20.
    expect(out.some((l) => /^patcher\s+2\/2\s+FULL\s+2 adds \(0\.29\/day\), ~7d retention$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\s+1\/2\s+1 add \(0\.14\/day\)$/.test(l))).toBe(true); // below cap: no marker
  });

  test('stats table says "notebooks: none" when no shelf has a notebook', async () => {
    const s = await run(['stats']); // only the stats call itself is logged; no notebook files
    expect(s.code).toBe(0);
    expect(s.out).toContain('notebooks: none');
    expect(s.out).not.toContain('FULL');
  });

  test('stats <shelf> scopes the table inventory to that shelf (singular header)', async () => {
    await run(['add', 'patcher', 'a']);
    await run(['add', 'scout', 'b']); // a second shelf that must be excluded
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    const out = s.out.split('\n').map((l) => l.trim());
    expect(out).toContain('notebooks: 1 shelf, 1 lines (cap 50/shelf)'); // singular "shelf"
    expect(out.some((l) => /^patcher\s+1\/50\s+1 add \(0\.14\/day\)$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\b/.test(l))).toBe(false); // the other shelf is not listed
  });

  test('stats --json includes per-shelf lines and the maxLines cap (issue #40)', async () => {
    process.env.NB_MAX_LINES = '5';
    await run(['add', 'patcher', 'one']);
    await run(['add', 'patcher', 'two']);
    const s = await run(['stats', '--json']);
    expect(s.code).toBe(0);
    const report = JSON.parse(s.out);
    // old fields stay present and well-typed (additive contract)
    expect(report).toHaveProperty('window');
    expect(typeof report.totalCalls).toBe('number');
    expect(Array.isArray(report.perCommand)).toBe(true);
    expect(Array.isArray(report.anomalies)).toBe(true);
    // new inventory fields
    expect(report.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 2, cap: 5, adds: 2, addsPerDay: 0.29, retentionDays: null }]);
    expect(report.notebookTotals).toEqual({ roles: 1, shelves: 1, lines: 2, cap: 5 });
    expect(Array.isArray(report.signals)).toBe(true); // diagnostic signals (issue #72), additive
  });

  test('the human stats table renders a browse-without-use signal (issue #72)', async () => {
    // A show of a notebook in a session with no vote on it that session is the
    // browse-without-use signal. Drive it through the CLI with NB_SESSION set, so
    // the rendered `signals:` section (not the "none" line) is exercised.
    process.env.NB_SESSION = 'sess-A';
    await run(['add', 'reviewer', 'a lesson worth reading']);
    await run(['show', 'reviewer']); // browsed, but never voted this session
    const s = await run(['stats', 'reviewer']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('  signals:'); // the header branch, not the "none" line
    expect(s.out).toContain('[browse-without-use] shelf reviewer');
    expect(s.out).not.toContain('signals: none');
  });

  test('stats --json carries the browse-without-use signal (issue #72)', async () => {
    process.env.NB_SESSION = 'sess-B';
    await run(['show', 'solo']); // browse with no vote
    const s = await run(['stats', '--json']);
    const rep = JSON.parse(s.out);
    expect(rep.signals.some((x: { kind: string; shelf: string }) => x.kind === 'browse-without-use' && x.shelf === 'solo')).toBe(true);
  });

  test('the human stats table says "signals: none" when there is nothing to report', async () => {
    const s = await run(['stats']); // only the stats call itself is logged
    expect(s.out).toContain('signals: none');
  });

  test('the human stats table renders the surfacing metrics and readout (issue #81)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'alpha lesson']); // accepted
    await run(['vote', 'patcher', 'alpha', '+1']); // engages s1
    await run(['add', 'patcher', 'alpha lesson']); // dedup-blocked (same dedup key)
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('surfacing: 1 engaged session');
    expect(s.out).toContain('coverage');
    expect(s.out).toContain('recall-miss');
    expect(s.out).toContain('precision-miss');
    expect(s.out).toContain('serendipity'); // issue #114
    // 1 accepted + 1 dedup-blocked ⇒ coverage .5 (HIGH) × recall .5 (HIGH) ⇒ churny.
    expect(s.out).toContain('readout: churny');
  });

  test('serendipity: a bare upvote is push-delivered (1.0), a searched-then-voted upvote is a pull (0.0) — issue #114', async () => {
    process.env.NB_SESSION = 'push-sess';
    await run(['add', 'patcher', 'bounded voted plain text memory']); // accepted
    await run(['vote', 'patcher', 'bounded', '+1']); // upvote, NO prior search → push
    const pushJson = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(pushJson.surfacing.upvotes).toBe(1);
    expect(pushJson.surfacing.serendipity).toBe(1); // arrived unbidden
    // The human table flags it as an approximate proxy, not a bound.
    const table = await run(['stats', 'patcher']);
    expect(table.out).toContain('serendipity');
    expect(table.out).toContain('arrived unbidden');
    expect(table.out).toMatch(/serendipity\s+~/); // the `~` approximate marker

    // A different session that PULLS the same lesson via `search` first, then
    // upvotes it: the upvote is a pull, so serendipity is 0 for that session.
    process.env.NB_SESSION = 'pull-sess';
    const searched = await run(['search', 'bounded']); // surfaces the entry, logs its id
    expect(searched.code).toBe(0);
    await run(['vote', 'patcher', 'bounded', '+1']); // upvote AFTER the search → pull
    const pullJson = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    // Deployment-wide pull evidence: the search row is shelf `-` yet the scoped
    // `nb stats patcher` still classifies the pull-session upvote correctly.
    expect(pullJson.surfacing.upvotes).toBe(2); // both sessions' upvotes counted
    expect(pullJson.surfacing.serendipity).toBe(0.5); // 1 push of 2 upvotes
  });

  test('nb search records the surfaced entry ids in the usage row (issue #114 provenance)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'retry with exponential backoff']); // accepted
    await run(['search', 'retry']);
    const searchRow = parseUsage(dir).at(-1)!;
    expect(searchRow.command).toBe('search');
    expect(searchRow.outcome).toBe('match');
    expect(searchRow.entries).toEqual([entryId('retry with exponential backoff')]);
    // A no-match search stays entry-less (keeps the failed-search gap-sensor intact).
    await run(['search', 'nonexistentterm']);
    const noMatch = parseUsage(dir).at(-1)!;
    expect(noMatch.outcome).toBe('no-match');
    expect(noMatch.entries).toEqual([]);
  });

  test('stats --json carries the surfacing metrics object (issue #81)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'alpha lesson']); // accepted
    await run(['vote', 'patcher', 'alpha', '+1']); // engages s1, one upvote
    await run(['add', 'patcher', 'alpha lesson']); // dedup-blocked
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out);
    expect(rep.surfacing).toEqual({
      engagedSessions: 1,
      addAttempts: 2,
      coverage: 0.5,
      recallMiss: 0.5,
      votesActedOn: 1,
      precisionMiss: 0, // one upvote, zero downvotes
      upvotes: 1, // the single upvote (issue #114 — serendipity denominator)
      serendipity: 1, // that upvote had no same-session search → push-delivered
      readout: 'churny',
      engagementDiagnosis: null, // engaged ⇒ no zero-engagement breakdown (issue #105)
    });
  });

  test('the human stats table reports no engaged sessions when NB_SESSION is unset (issue #81)', async () => {
    delete process.env.NB_SESSION; // no session → the engagement gate finds nothing to score
    await run(['add', 'patcher', 'a lesson']);
    const s = await run(['stats', 'patcher']);
    // With NB_SESSION unset the zero-engagement line now names the blank-session
    // root cause (issue #105) rather than the old generic message.
    expect(s.out).toContain('surfacing: no engaged sessions — NB_SESSION was unset');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagedSessions).toBe(0);
    expect(json.surfacing.recallMiss).toBeNull(); // null, shown as — in the table, never a misleading 0%
    expect(json.surfacing.engagementDiagnosis.causes).toContain('blank-session');
  });

  test('zero-engagement table names the retrospective-not-landing cause (issue #105)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'a lesson']); // populates the notebook (not a read, not a vote)
    await run(['show', 'patcher']); // a deliberate read in s1, but no vote follows
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain("opened a notebook but cast no vote");
    expect(s.out).not.toContain('injection hook'); // a read happened ⇒ hook cause must be off
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual(['retrospective-not-landing']);
  });

  test("zero engagement with no identifiable cause falls back to the generic line (issue #105)", async () => {
    // NB_SESSION set (no blank-session), only the hook's global `nb list` ran (a
    // read ⇒ no injection-hook; not a deliberate read ⇒ no retrospective): none
    // of the three causes applies, so the original generic line is kept.
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'a lesson']);
    await run(['list']); // the hook's index read (global shelf '-')
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain('surfacing: no engaged sessions in this window (set NB_SESSION');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual([]);
  });

  test('zero-engagement table names the injection-hook cause when nothing read (issue #105)', async () => {
    process.env.NB_SESSION = 's1'; // session set ⇒ not the blank-session cause
    await run(['add', 'patcher', 'a lesson']); // stored lesson, but `add` is not a read
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain('the SessionStart injection hook is probably not wired');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual(['injection-hook']);
  });

  test('unknown command exits 2', async () => {
    const r = await run(['frobnicate', 'patcher']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });

  test('a typo of a real command suggests the nearest one, keeping exit 2 and the --help pointer', async () => {
    const r = await run(['stat']);
    expect(r.code).toBe(2); // exit code is unchanged by the suggestion
    expect(r.err).toContain('unknown command "stat"'); // prefix preserved
    expect(r.err).toContain('Did you mean `stats`?');
    expect(r.err).toContain('nb --help'); // pointer preserved
  });

  test('a far-off unknown command gives no suggestion (no overconfident guess)', async () => {
    const r = await run(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command "frobnicate"');
    expect(r.err).not.toContain('Did you mean');
    expect(r.err).toContain('nb --help');
  });

  test('a missing required argument exits 1', async () => {
    const r = await run(['show']); // no shelf
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <shelf>');
  });

  test('a bad vote direction exits 1', async () => {
    await run(['add', 'patcher', 'x']);
    const r = await run(['vote', 'patcher', 'x', '2']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('+1 or -1');
  });

  test('--version (and -v / version) print the real package version', async () => {
    // Assert the exact package.json version, not just "a semver" — this also
    // catches a silent fallback (e.g. 0.0.0) if version resolution breaks.
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    for (const flag of ['--version', '-v', 'version']) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(`nb (agent-notebook) ${PKG_VERSION}\n`);
    }
  });

  test('an over-long add exits 1, is not stored, and tells the agent to retry', async () => {
    process.env.NB_MAX_CHARS = '25';
    const r = await run(['add', 'patcher', 'z'.repeat(60)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too long/i);
    expect(r.err).toMatch(/retry/i);
    // The overflow count (length 60 - cap 25 = 35) is reported so the re-draft
    // trims exactly that much instead of guessing (issue #239).
    expect(r.err).toMatch(/35 over the 25 limit/);
    expect(r.err).toMatch(/trim at least 35/);
    const show = await run(['show', 'patcher']);
    // Nothing was stored, so the shelf was never created: `show` reports it as
    // missing (issue #166), not as a real empty notebook.
    expect(show.err).toContain('no notebook for shelf "patcher"');
    expect(show.out).toBe('');
  });

  test('add past the cap always LOGS the aging dock but PRINTS it only when the pre-dock score was > 1 (issue #293)', async () => {
    process.env.NB_MAX_LINES = '2';
    // Routine +1 -> 0 dock: logged, but the human line stays quiet.
    await run(['add', 'q', 'alpha lesson one']);
    await run(['add', 'q', 'beta lesson two']);
    await run(['vote', 'q', 'beta', '-1']); // beta -> 0, evicted next
    const quiet = await run(['add', 'q', 'gamma lesson three']);
    expect(quiet.out).toMatch(/\(evicted lowest-scored: \[\+0\] beta lesson two\)/);
    expect(quiet.out).not.toMatch(/aged stalest/);
    const quietRow = parseUsage(dir).filter((r) => r.command === 'add').pop()!;
    expect(quietRow.decayed).toBe(`${entryId('alpha lesson one')}:0`);

    // Voted-up line (+3) docked to +2: printed AND logged.
    process.env.NB_MAX_LINES = '2';
    await run(['add', 'w', 'stale high lesson']);
    await run(['vote', 'w', 'stale high', '1']);
    await run(['vote', 'w', 'stale high', '1']); // +3
    await run(['add', 'w', 'filler lesson']);
    const loud = await run(['add', 'w', 'newcomer lesson']);
    expect(loud.out).toMatch(/\(evicted lowest-scored: \[\+1\] filler lesson\)/);
    expect(loud.out).toMatch(/\(aged stalest −1 → \[\+2\] stale high lesson\)/);
    const loudRow = parseUsage(dir).filter((r) => r.role === 'w' && r.command === 'add').pop()!;
    expect(loudRow.decayed).toBe(`${entryId('stale high lesson')}:2`);
    expect(loudRow.evicted).toBe(`${entryId('filler lesson')}:1`);
  });

  test('add past NB_MAX_LINES evicts the lowest-scored entry and names it in the output', async () => {
    // Drive the CLI's eviction branch end to end: with a tiny cap, a third `add`
    // must evict the lowest-scored existing entry AND report it in the `added`
    // line — the exact feedback an agent relies on to know its memory changed.
    // notebook.test.ts covers the library eviction; this covers the CLI message
    // (a wrong count, a missing evicted suffix, or the wrong entry would be a
    // user-facing regression that the library-level tests do not catch).
    process.env.NB_MAX_LINES = '2';
    // Vote down the SECOND (younger) entry so the lowest-scored entry is NOT the
    // oldest — otherwise a FIFO-eviction regression (drop oldest, ignore score)
    // would still pass. alpha stays +1 (oldest), beta drops to 0 (lowest-scored).
    expect((await run(['add', 'patcher', 'alpha lesson one'])).code).toBe(0); // +1, oldest
    expect((await run(['add', 'patcher', 'beta lesson two'])).code).toBe(0); // +1 — notebook now full at the cap of 2
    expect((await run(['vote', 'patcher', 'beta', '-1'])).code).toBe(0); // beta → 0, now the lowest-scored but NOT the oldest
    const r = await run(['add', 'patcher', 'gamma lesson three']); // over the cap → must evict beta, not the older alpha
    expect(r.code).toBe(0);
    // Stable message (fixed single-space template, not padded whitespace): the
    // resulting size stays at the cap and the evicted lowest-scored entry is
    // named with its score.
    expect(r.out).toMatch(/added — 2 lines \(evicted lowest-scored: \[\+0\] beta lesson two\)/);
    // The eviction really happened by score, not by age: beta is gone while the
    // older alpha survives alongside the newest entry, and the cap held.
    const show = await run(['show', 'patcher']);
    expect(show.out).not.toContain('beta lesson two');
    expect(show.out).toContain('alpha lesson one');
    expect(show.out).toContain('gamma lesson three');
  });

  test('add on a cap LOWERED below a full shelf reports all evictions in the message and the usage row (issue #306)', async () => {
    // Fill a shelf to 50 under the default cap, then lower NB_MAX_LINES to 10 and
    // add once: that one add trims the shelf all the way down (50 + 1 − 10 = 41
    // evictions). Before #306 both the `added` line and the usage `evicted`
    // column surfaced only ONE of those 41, hiding the scale of the loss.
    process.env.NB_MAX_LINES = '50';
    for (let i = 0; i < 50; i++) {
      expect((await run(['add', 'patcher', `lesson number ${i}`])).code).toBe(0);
    }
    process.env.NB_MAX_LINES = '10';
    const r = await run(['add', 'patcher', 'the newcomer lesson']);
    expect(r.code).toBe(0);
    // The message names the primary evicted entry AND the count of the rest
    // (41 evicted − 1 named = 40 more), instead of silently dropping 40 lessons.
    expect(r.out).toMatch(/added — 10 lines \(evicted lowest-scored: .* \+40 more lines\)/);

    // The usage row's `evicted` column records the full loss, byte-bounded with a
    // count-preserving marker, not a single entry.
    const row = parseUsage(dir).filter((x) => x.command === 'add').at(-1)!;
    const tokens = row.evicted.split(',');
    const markers = tokens.filter((t) => t.startsWith('+'));
    expect(markers).toHaveLength(1);
    const dropped = Number(markers[0].slice(1));
    const pairs = tokens.filter((t) => !t.startsWith('+'));
    expect(pairs.length + dropped).toBe(41); // every eviction accounted for
    expect(pairs.length).toBeGreaterThan(1); // not under-reported to one
  });

  test('merge consolidates two entries into one, reflected by show', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const m = await run(['merge', 'patcher', 'alpha', 'beta', 'merged lesson alpha+beta']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('merged two entries into one');
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('merged lesson alpha+beta');
    expect(show.out).not.toContain('alpha lesson one');
    expect(show.out).not.toContain('beta lesson two');
  });

  test('merge with a missing argument exits 1', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const r = await run(['merge', 'patcher', 'alpha', 'beta']); // no merged lesson
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <merged lesson>');
  });

  test('rm deletes an entry, reflected by show', async () => {
    await run(['add', 'patcher', 'keep this lesson']);
    await run(['add', 'patcher', 'drop this lesson']);
    const r = await run(['rm', 'patcher', 'drop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed');
    expect(r.out).toContain('drop this lesson');
    const show = await run(['show', 'patcher']);
    expect(show.out).not.toContain('drop this lesson');
    expect(show.out).toContain('keep this lesson');
  });

  test('rm with a missing argument exits 1', async () => {
    const r = await run(['rm', 'patcher']); // no id|query selector
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <id|query>');
  });

  test('NB_DIR with a leading ~ is expanded by nb itself (issue #334)', async () => {
    // A harness (settings.json `env`, systemd, cron) sets NB_DIR without a
    // shell expanding the tilde. nb must expand it, so the notebook lands in
    // $HOME/x — not a literal `./~` directory under whatever the CWD is — and
    // `nb path`/`nb config` report the expanded absolute path.
    const tmpHome = mkdtempSync(join(tmpdir(), 'agent-notebook-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'agent-notebook-cwd-'));
    const savedHome = process.env.HOME;
    const savedCwd = process.cwd();
    try {
      process.env.HOME = tmpHome;
      process.env.NB_DIR = '~/x';
      process.chdir(cwd);
      expect((await run(['add', 's', 'tilde test lesson'])).code).toBe(0);
      const expected = join(tmpHome, 'x');
      expect(existsSync(join(expected, 's.md'))).toBe(true);
      expect(existsSync(join(cwd, '~'))).toBe(false);
      expect((await run(['path'])).out).toBe(`${expected}\n`);
      expect((await run(['path', '--usage'])).out).toBe(`${usageFile(expected)}\n`);
      expect((await run(['config'])).out).toMatch(
        new RegExp(`^NB_DIR=${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(env\\)$`, 'm'),
      );
      // The usage log lands under the expanded dir, not the literal `~` one.
      expect(parseUsage(expected).length).toBeGreaterThan(0);
    } finally {
      process.chdir(savedCwd);
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('path with no shelf prints the notebooks dir (respecting NB_DIR)', async () => {
    const r = await run(['path']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${dir}\n`); // bare path, pipeable into cat/$(...)
  });

  test('path <shelf> prints the resolved absolute shelf file path', async () => {
    const r = await run(['path', 'reviewer']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${join(dir, 'reviewer.md')}\n`);
    expect(r.out.trimEnd()).toMatch(/\/reviewer\.md$/);
  });

  test('path with an unsafe shelf name is rejected by the existing safe-shelf check', async () => {
    const r = await run(['path', '../escape']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid shelf name/);
  });

  test('path --usage prints the resolved usage-log path (issue #169)', async () => {
    const r = await run(['path', '--usage']);
    expect(r.code).toBe(0);
    // Output is the usageFile() layout under the active notebooks dir — not a
    // path reconstructed in the test — so this stays correct if the resolution
    // logic moves, while the regex below independently pins the current literal
    // filename as the documented contract. Bare path, pipeable into tail -F/$(...).
    expect(r.out).toBe(`${usageFile(dir)}\n`);
    expect(r.out.trimEnd()).toMatch(/\/\.nb-usage\.log$/);
    // Clean stdout-only: a flag is never routed to the shelf branch, so nothing
    // (not even an "invalid shelf name" error) lands on stderr.
    expect(r.err).toBe('');
  });

  test('path with an unrecognized --flag is rejected, never silently treated as the dir (issue #169, #267)', async () => {
    // `--usage`/`--json` are the ONLY recognized flags; any other `--`-prefixed
    // token is refused up front by the central unknown-flag guard (issue #267)
    // rather than quietly printing the notebooks dir. The message names the
    // offending option (not a confusing "invalid shelf name"), and `--usage`
    // still cannot collide with a shelf literally named `--usage` — such a name
    // is unreachable.
    const r = await run(['path', '--bogus']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown option "--bogus" for `nb path`/);
  });

  describe('path --json (issue #185)', () => {
    test('path --json emits {dir, shelf:null, path:null}, NOT a shelf named --json', async () => {
      const r = await run(['path', '--json']);
      expect(r.code).toBe(0);
      // Regression: `--json` must be consumed as the flag, never taken as a
      // shelf literally named `--json` (which printed `<dir>/--json.md`).
      expect(r.out).not.toContain('--json.md');
      expect(JSON.parse(r.out)).toEqual({ dir, shelf: null, path: null });
      expect(r.err).toBe(''); // one object on stdout only
    });

    test('path <shelf> --json emits {dir, shelf, path} for the resolved file', async () => {
      const r = await run(['path', 'reviewer', '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({
        dir,
        shelf: 'reviewer',
        path: join(dir, 'reviewer.md'),
      });
      expect(r.err).toBe('');
    });

    test('--json before the shelf is parsed the same (flag order is irrelevant)', async () => {
      const r = await run(['path', '--json', 'reviewer']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({
        dir,
        shelf: 'reviewer',
        path: join(dir, 'reviewer.md'),
      });
    });

    test('path --usage --json carries the usage-log path in the object (shelf:null)', async () => {
      const r = await run(['path', '--usage', '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ dir, shelf: null, path: usageFile(dir) });
      expect(r.err).toBe('');
    });

    test('--json leaves the bare (non-JSON) outputs byte-for-byte unchanged', async () => {
      // The three acceptance cases without --json must be exactly as before.
      expect((await run(['path'])).out).toBe(`${dir}\n`);
      expect((await run(['path', 'reviewer'])).out).toBe(`${join(dir, 'reviewer.md')}\n`);
      expect((await run(['path', '--usage'])).out).toBe(`${usageFile(dir)}\n`);
    });

    test('--json does not disable the safe-shelf guard (still exit 1) and now emits a structured error on stdout (issue #266)', async () => {
      const r = await run(['path', '../escape', '--json']);
      expect(r.code).toBe(1); // the guard still fires — exit is unchanged
      expect(r.err).toMatch(/invalid shelf name/); // the English line still goes to stderr
      // Previously stdout was empty on this throw path, so a --json consumer got
      // nothing to branch on. It now carries the structured error (issue #266).
      expect(JSON.parse(r.out)).toEqual({
        ok: false,
        command: 'path',
        error: {
          class: 'bad_args',
          message: 'invalid shelf name: "../escape" (allowed: letters, digits, . _ @ -)',
        },
      });
    });
  });

  describe('config — effective (post-clamp) tunables (issue #188)', () => {
    // The getters read live env, so clear every tunable var first for a
    // deterministic default baseline, then restore the environment after. (The
    // outer afterEach only resets a subset; this block touches more of them.)
    const TUNABLES = [
      'NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_NEAR_DUP', 'NB_USAGE_RING',
      'NB_STALE_LOCK_MS', 'NB_LOCK_GRACE_MS', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S',
      'NB_SILENT_H', 'NB_ERR_MIN', 'NB_ADD_BURST_N', 'NB_ERR_RATE', 'NB_COVERAGE_HI', 'NB_RECALL_MISS_HI',
    ];
    const savedTunables: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of TUNABLES) {
        savedTunables[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(() => {
      for (const k of TUNABLES) {
        if (savedTunables[k] === undefined) delete process.env[k];
        else process.env[k] = savedTunables[k];
      }
    });

    // Every tunable config must surface, with its built-in default value. This
    // list is the acceptance criterion: cap, char cap, near-dup threshold, usage
    // ring + slack, lock timings, and the stats anomaly/readout thresholds.
    const DEFAULTS: Array<[string, string]> = [
      ['maxLines', '50'], ['maxChars', '200'], ['nearThreshold', '0.5'],
      ['usageRing', '5000'], ['usageRingSlack', '312'], ['staleLockMs', '10000'],
      ['lockGraceMs', '2000'], ['loopN', '10'], ['loopWindowSec', '120'],
      ['silentHours', '48'], ['errMin', '5'], ['addBurstN', '15'], ['errRate', '0.3'],
      ['coverageHi', '0.5'], ['recallMissHi', '0.2'],
    ];

    test('prints every effective tunable as name=value (defaults), one line each, exit 0', async () => {
      const r = await run(['config']);
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      for (const [name, value] of DEFAULTS) {
        expect(r.out).toContain(`${name}=${value}`);
      }
      // The numeric block is exactly one line per tunable, then a blank-line
      // separator and the three string env rows (issue #312) — nothing extra.
      const [numericBlock, envBlock] = r.out.trimEnd().split('\n\n');
      expect(numericBlock.split('\n')).toHaveLength(DEFAULTS.length);
      expect(envBlock.split('\n').map((l) => l.split('=')[0])).toEqual([
        'NB_DIR',
        'NB_SESSION',
        'NB_ASCII',
      ]);
    });

    test('each default line is tagged (default); the derived one is tagged derived', async () => {
      const r = await run(['config']);
      expect(r.out).toMatch(/^maxLines=50\s+\(default\)$/m);
      expect(r.out).toMatch(/^usageRingSlack=312\s+\(derived from usageRing\)$/m);
    });

    test('--json emits one object keyed by tunable name, each { value, source, env }', async () => {
      const r = await run(['config', '--json']);
      expect(r.code).toBe(0);
      expect(r.out.trim().split('\n')).toHaveLength(1); // exactly one JSON object on stdout
      const obj = JSON.parse(r.out);
      // The 15 numeric rows keep their exact keys; issue #312 adds ONE new
      // top-level `environment` key (a new section, not a changed row shape) and
      // issue #336 adds the informational `unrecognized` array. Nothing else.
      expect(Object.keys(obj).sort()).toEqual([...DEFAULTS.map(([n]) => n), 'environment', 'unrecognized'].sort());
      expect(obj.maxLines).toEqual({ value: 50, source: 'default', env: 'NB_MAX_LINES', status: null, rawValue: null });
      // The derived value has no env var of its own.
      expect(obj.usageRingSlack).toEqual({ value: 312, source: 'derived', env: null, status: null, rawValue: null });
      // Values are real numbers, not stringified — a supervisor can branch on them.
      expect(typeof obj.errRate.value).toBe('number');
      expect(obj.errRate.value).toBe(0.3);
    });

    test('an env override is reflected in the value and tagged (env NB_*)', async () => {
      process.env.NB_MAX_LINES = '123';
      expect((await run(['config'])).out).toMatch(/^maxLines=123\s+\(env NB_MAX_LINES\)$/m);
      const j = JSON.parse((await run(['config', '--json'])).out);
      expect(j.maxLines).toEqual({ value: 123, source: 'env', env: 'NB_MAX_LINES', status: 'honored', rawValue: '123' });
    });

    test('an out-of-range env override prints the POST-CLAMP value, still source=env (DP-5)', async () => {
      process.env.NB_MAX_CHARS = '99999'; // above the 2000 ceiling → clamped
      const j = JSON.parse((await run(['config', '--json'])).out);
      expect(j.maxChars).toEqual({ value: 2000, source: 'env', env: 'NB_MAX_CHARS', status: 'clamped', rawValue: '99999' });
      expect((await run(['config'])).out).toMatch(/^maxChars=2000\s+\(env NB_MAX_CHARS: clamped to 2000 from 99999\)$/m);
    });

    test('a NON-NUMERIC env clamps back to the default value yet still reads source=env (DP-5)', async () => {
      // The subtle half of DP-5: `clampInt('abc', …)` falls back to the default
      // (50), so value EQUALS the default — but the var IS set, so source must be
      // `env`, derived from `process.env`, not inferred from value-vs-default. A
      // mutation computing source by comparing value to the default would pass
      // every other test but fail this one.
      process.env.NB_MAX_LINES = 'abc';
      const j = JSON.parse((await run(['config', '--json'])).out);
      expect(j.maxLines).toEqual({ value: 50, source: 'env', env: 'NB_MAX_LINES', status: 'ignored', rawValue: 'abc' });
      expect((await run(['config'])).out).toMatch(/^maxLines=50\s+\(env NB_MAX_LINES: ignored "abc", not an integer; using default\)$/m);
    });

    test('a blank env var reads source=env, not default, matching the value the getter yields (DP-5)', async () => {
      // A var set to the empty string IS set: `clampRate` resolves '' to 0 (via
      // Number('')), the value the hot path uses. Tagging that `default` would
      // print `errRate=0 (default)` while the real default is 0.3 — the exact
      // misleading value/tag pair FR-CONFIG-001 forbids. source must read `env`.
      process.env.NB_ERR_RATE = '';
      const j = JSON.parse((await run(['config', '--json'])).out);
      expect(j.errRate).toEqual({ value: 0, source: 'env', env: 'NB_ERR_RATE', status: 'honored', rawValue: '' });
      expect((await run(['config'])).out).toMatch(/^errRate=0\s+\(env NB_ERR_RATE\)$/m);
    });

    test('config reuses the live getter, so a set stats threshold is surfaced (no drift)', async () => {
      process.env.NB_LOOP_N = '7';
      const j = JSON.parse((await run(['config', '--json'])).out);
      expect(j.loopN).toEqual({ value: 7, source: 'env', env: 'NB_LOOP_N', status: 'honored', rawValue: '7' });
    });

    test('config mutates nothing — no shelf file is created or changed', async () => {
      // Pre-seed a real shelf and snapshot its bytes, so this guards against a
      // regression that MODIFIES an existing notebook — not just the near-trivial
      // "creates no file in an empty dir" case (a `config` that rewrote a shelf
      // would slip past that).
      await run(['add', 'seeded', 'a durable lesson']);
      const file = join(dir, 'seeded.md');
      const before = readFileSync(file, 'utf8');
      const filesBefore = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

      await run(['config']);
      await run(['config', '--json']);

      // The pre-seeded shelf is byte-identical, and config added no new shelf.
      // (.nb-usage.log is the only side effect, shared by every read command.)
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dir).filter((f) => f.endsWith('.md')).sort()).toEqual(filesBefore);
    });

    describe('per-variable status + unrecognized NB_* scan (issue #336)', () => {
      // A fresh `NB_*` name that no shipping code reads, used to prove an
      // unrecognized var is listed. Cleaned up so it can't leak into other tests.
      const TYPO = 'NB_MAX_LINE';
      afterEach(() => {
        delete process.env[TYPO];
      });

      test('an unparseable value reads status=ignored with the raw value, annotated in both outputs', async () => {
        process.env.NB_MAX_LINES = 'abc';
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.maxLines).toEqual({
          value: 50, source: 'env', env: 'NB_MAX_LINES', status: 'ignored', rawValue: 'abc',
        });
        expect((await run(['config'])).out).toMatch(
          /^maxLines=50\s+\(env NB_MAX_LINES: ignored "abc", not an integer; using default\)$/m,
        );
      });

      test('an out-of-range value reads status=clamped with the raw value, annotated in both outputs', async () => {
        process.env.NB_NEAR_DUP = '2'; // rate ceiling is 1
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.nearThreshold).toEqual({
          value: 1, source: 'env', env: 'NB_NEAR_DUP', status: 'clamped', rawValue: '2',
        });
        expect((await run(['config'])).out).toMatch(
          /^nearThreshold=1\s+\(env NB_NEAR_DUP: clamped to 1 from 2\)$/m,
        );
      });

      test('a misspelled NB_* var is listed as not-read-by-nb with a nearest-name suggestion, both outputs', async () => {
        process.env[TYPO] = '9';
        const human = (await run(['config'])).out;
        // Tagged "not read by nb" (other tooling may legitimately set NB_*), with
        // the typo hint — padded to the historical tag width so the block keeps
        // its shape.
        expect(human).toMatch(
          new RegExp(`^${TYPO}\\s+\\(not read by nb — did you mean NB_MAX_LINES\\?\\)\\s*$`, 'm'),
        );
        // Informational only: stderr clean, exit 0.
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.unrecognized).toContainEqual({ name: TYPO, suggestion: 'NB_MAX_LINES' });
      });

      test('an NB_* var with no close match is still listed, without a suggestion (issue #336)', async () => {
        // The spec promises EVERY unread NB_* var is surfaced; a name far from
        // any real knob (or one another tool owns) must not be dropped just
        // because closestMatch found nothing — that is the invisible case the
        // scan exists to expose.
        const FAR = 'NB_FAKE_TUNE_XYZ';
        process.env[FAR] = '1';
        try {
          const human = (await run(['config'])).out;
          expect(human).toMatch(new RegExp(`^${FAR}\\s+\\(not read by nb\\)\\s*$`, 'm'));
          const j = JSON.parse((await run(['config', '--json'])).out);
          expect(j.unrecognized).toContainEqual({ name: FAR, suggestion: null });
        } finally {
          delete process.env[FAR];
        }
      });

      test('a var read by the shipped example tooling is never flagged as unknown or mis-suggested', async () => {
        // examples/ ships scripts that legitimately read these (guarded by
        // src/env-docs.test.ts); a user who exports them while following the
        // setup docs must not be told nb does not know them, and must not get a
        // confident, wrong `did you mean NB_DIR?` for NB_BIN.
        const SHIPPED = [
          'NB_BIN',
          'NB_RETRO_TTL_DAYS',
          'NB_GIT_AUTOCOMMIT',
          'NB_BACKUP_PUSH_TIMEOUT',
          'NB_BACKUP_GIT_LOCK_WAIT',
        ];
        for (const v of SHIPPED) process.env[v] = 'x';
        try {
          const human = (await run(['config'])).out;
          const j = JSON.parse((await run(['config', '--json'])).out);
          for (const v of SHIPPED) {
            expect(human).not.toContain(v);
            expect(j.unrecognized.map((u: { name: string }) => u.name)).not.toContain(v);
          }
          // A real typo is still caught alongside them.
          process.env[TYPO] = '9';
          const j2 = JSON.parse((await run(['config', '--json'])).out);
          expect(j2.unrecognized).toContainEqual({ name: TYPO, suggestion: 'NB_MAX_LINES' });
        } finally {
          for (const v of SHIPPED) delete process.env[v];
        }
      });

      test('an honored in-range value has status=honored and no human status note', async () => {
        process.env.NB_MAX_LINES = '123';
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.maxLines).toEqual({
          value: 123, source: 'env', env: 'NB_MAX_LINES', status: 'honored', rawValue: '123',
        });
        // No clamped/ignored suffix — the honored line is the plain pre-#336 form.
        expect((await run(['config'])).out).toMatch(/^maxLines=123\s+\(env NB_MAX_LINES\)$/m);
      });

      test('an unset tunable has status=rawValue=null (source default) and no status note', async () => {
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.maxLines).toEqual({
          value: 50, source: 'default', env: 'NB_MAX_LINES', status: null, rawValue: null,
        });
        // The derived row also carries null status/rawValue (it has no env var).
        expect(j.usageRingSlack.status).toBeNull();
        expect(j.usageRingSlack.rawValue).toBeNull();
      });

      test('the registry stays in lockstep with every getter (same value for honored/clamped/ignored)', async () => {
        // The registry duplicates each getter's default + clamp so `nb config`
        // can report a status. This pins them together: for each tunable, set a
        // representative honored, clamped-high, clamped-low and garbage value and
        // assert the JSON's `value` matches the exported getter's value exactly.
        // A drifted default, clamp bound or parse rule fails here rather than
        // silently printing a value the hot path never uses (the #116 drift).
        const { maxLines, maxChars, nearThreshold, usageRing, staleLockMs, lockGraceMs,
          loopN, loopWindowSec, silentHours, errMin, addBurstN, errRate, coverageHi, recallMissHi } = await import('./notebook.js');
        const cases: Array<[string, () => number, string, string[]]> = [
          ['maxLines', maxLines, 'NB_MAX_LINES', ['3', '999999', '0', 'abc']],
          ['maxChars', maxChars, 'NB_MAX_CHARS', ['50', '999999', '0', 'x']],
          ['nearThreshold', nearThreshold, 'NB_NEAR_DUP', ['0.4', '9', '-3', 'no']],
          ['usageRing', usageRing, 'NB_USAGE_RING', ['500', '9999999', '1', 'z']],
          ['staleLockMs', staleLockMs, 'NB_STALE_LOCK_MS', ['5000', '9999999', '1', 'q']],
          ['lockGraceMs', lockGraceMs, 'NB_LOCK_GRACE_MS', ['100', '9999999', '-1', 'q']],
          ['loopN', loopN, 'NB_LOOP_N', ['5', '999999', '1', 'q']],
          ['loopWindowSec', loopWindowSec, 'NB_LOOP_WINDOW_S', ['60', '9999999', '1', 'q']],
          ['silentHours', silentHours, 'NB_SILENT_H', ['24', '9999999', '0', 'q']],
          ['errMin', errMin, 'NB_ERR_MIN', ['3', '9999999', '0', 'q']],
          ['addBurstN', addBurstN, 'NB_ADD_BURST_N', ['3', '9999999', '0', 'q']],
          ['errRate', errRate, 'NB_ERR_RATE', ['0.1', '9', '-1', 'q']],
          ['coverageHi', coverageHi, 'NB_COVERAGE_HI', ['0.1', '9', '-1', 'q']],
          ['recallMissHi', recallMissHi, 'NB_RECALL_MISS_HI', ['0.1', '9', '-1', 'q']],
        ];
        for (const [name, getter, envVar, raws] of cases) {
          for (const raw of raws) {
            process.env[envVar] = raw;
            const j = JSON.parse((await run(['config', '--json'])).out);
            expect(j[name].value, `${name} with ${envVar}=${raw}`).toBe(getter());
            delete process.env[envVar];
          }
        }
      });

      test('a moved int bound is caught: probes at the live lo-1/lo/hi/hi+1, not fixed literals', async () => {
        // The fixed-literal matrix above can miss a moved bound (a value that is
        // out of range for both old and new ceilings clamps identically). Derive
        // the probes from the tunable's OWN declared bounds so shifting a bound
        // in notebook.ts is exercised the moment it moves — the regression guard
        // for issue #336 review finding 1.
        const nb = await import('./notebook.js');
        const specs: Array<[string, () => number, IntTunable | RateTunable]> = [
          ['maxLines', nb.maxLines, nb.MAX_LINES],
          ['maxChars', nb.maxChars, nb.MAX_CHARS],
          ['usageRing', nb.usageRing, nb.USAGE_RING],
          ['staleLockMs', nb.staleLockMs, nb.STALE_LOCK_MS],
          ['lockGraceMs', nb.lockGraceMs, nb.LOCK_GRACE_MS],
          ['loopN', nb.loopN, nb.LOOP_N],
          ['loopWindowSec', nb.loopWindowSec, nb.LOOP_WINDOW_S],
          ['silentHours', nb.silentHours, nb.SILENT_H],
          ['errMin', nb.errMin, nb.ERR_MIN],
          ['addBurstN', nb.addBurstN, nb.ADD_BURST_N],
        ];
        for (const [name, getter, t] of specs) {
          const spec = t as IntTunable;
          const probes = [spec.lo - 1, spec.lo, spec.hi, spec.hi + 1].map(String);
          for (const raw of probes) {
            process.env[spec.env] = raw;
            const j = JSON.parse((await run(['config', '--json'])).out);
            expect(j[name].value, `${name} with ${spec.env}=${raw}`).toBe(getter());
            delete process.env[spec.env];
          }
        }
      });

      test('every documented NB_* tunable is recognized (never listed unknown)', async () => {
        // The registry must cover every `NB_*` tunable the README documents — the
        // one place the user-facing set is written down (and the home the #164
        // env-docs guard already pins). Drive the assertion from the DOCUMENTED
        // set (`documented → surfaced`), not the other way round: a new knob
        // added to the README but forgotten in TUNABLE_REGISTRY is absent from
        // `surfaced`, so a `surfaced → documented` loop would never inspect it
        // and the omission it was written to catch would slip through.
        const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
        const documented = new Set(readme.match(/NB_[A-Z_]+/g) ?? []);
        // Vars documented only because the shipped examples/ tooling reads them
        // are legitimately not nb's own config (see SHIPPED_TOOL_ENV_VARS), so
        // they are excluded from the tunable set this test requires to surface.
        // `NB_MAX_LINE` is the deliberate typo the docs use to illustrate the
        // unknown-var block, not a real knob.
        const EXAMPLE_ONLY = new Set([
          'NB_BIN',
          'NB_RETRO_TTL_DAYS',
          'NB_GIT_AUTOCOMMIT',
          'NB_BACKUP_PUSH_TIMEOUT',
          'NB_BACKUP_GIT_LOCK_WAIT',
          'NB_MAX_LINE',
        ]);
        // The registry's live view is the `--json` output: every numeric row's
        // `env` plus every `environment` key.
        const j0 = JSON.parse((await run(['config', '--json'])).out);
        const surfaced = new Set<string>([
          ...Object.values(j0)
            .filter((v): v is { env: string | null } => !!v && typeof v === 'object' && 'env' in v)
            .map((v) => v.env)
            .filter((e): e is string => e !== null),
          ...Object.keys(j0.environment),
        ]);
        const names = new Set<string>(j0.unrecognized.map((u: { name: string }) => u.name));
        // Every documented tunable must be surfaced by `nb config` and must not
        // be reported unknown...
        const missing = [...documented].filter((v) => !EXAMPLE_ONLY.has(v) && !surfaced.has(v)).sort();
        expect(missing, `documented but not surfaced by nb config: ${missing.join(', ')}`).toEqual([]);
        // ...and, the other direction, a surfaced var must be documented and
        // never reported unknown.
        for (const v of surfaced) {
          expect(documented.has(v), `${v} is surfaced but missing from the README`).toBe(true);
          expect(names.has(v), `${v} is read but reported unknown`).toBe(false);
        }
      });
    });

    // The three behavior-critical STRING env vars (issue #312). These are not in
    // TUNABLES, so manage NB_SESSION / NB_ASCII explicitly here; NB_DIR is already
    // set to the per-test temp dir by the outer beforeEach.
    describe('string env section — NB_DIR / NB_SESSION / NB_ASCII (issue #312)', () => {
      // Also pin the locale: with NB_ASCII unset, asciiMode() falls back to
      // LC_ALL/LC_CTYPE/LANG, so a `C`/`POSIX` CI locale would otherwise flip the
      // default NB_ASCII value and make the "unset" assertion flaky. Force a
      // UTF-8 locale for a deterministic `off` baseline.
      const STRING_VARS = ['NB_SESSION', 'NB_ASCII', 'LC_ALL', 'LC_CTYPE', 'LANG'];
      const savedStrings: Record<string, string | undefined> = {};
      beforeEach(() => {
        for (const k of STRING_VARS) {
          savedStrings[k] = process.env[k];
          delete process.env[k];
        }
        process.env.LANG = 'C.UTF-8';
      });
      afterEach(() => {
        for (const k of STRING_VARS) {
          if (savedStrings[k] === undefined) delete process.env[k];
          else process.env[k] = savedStrings[k];
        }
      });

      test('unset NB_SESSION/NB_ASCII read (default) with empty/off values; set NB_DIR reads (env)', async () => {
        const r = await run(['config']);
        expect(r.code).toBe(0);
        // NB_DIR is set to the temp dir by the harness → (env) with that path.
        expect(r.out).toMatch(new RegExp(`^NB_DIR=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(env\\)$`, 'm'));
        // Unset NB_SESSION → empty value, (default). Unset NB_ASCII → off, (default).
        expect(r.out).toMatch(/^NB_SESSION=\s+\(default\)$/m);
        expect(r.out).toMatch(/^NB_ASCII=off\s+\(default\)$/m);
        // The same unset state in --json: source 'default' under `environment`.
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.environment.NB_SESSION).toEqual({ value: '', source: 'default' });
        expect(j.environment.NB_ASCII).toEqual({ value: 'off', source: 'default' });
      });

      test('an unset NB_DIR reads (default) with the home-relative default path', async () => {
        // NB_DIR unset → notebooksDir() falls back to <home>/.agent-notebook/
        // notebooks. The harness always sets NB_DIR, so override HOME to a temp
        // dir (os.homedir() honors $HOME on POSIX) and clear NB_DIR, so the
        // fallback resolves INTO the temp home — the usage-log side effect lands
        // there, not in the real home — then restore both.
        const savedDir = process.env.NB_DIR;
        const savedHome = process.env.HOME;
        const tmpHome = mkdtempSync(join(tmpdir(), 'agent-notebook-home-'));
        try {
          delete process.env.NB_DIR;
          process.env.HOME = tmpHome;
          const expected = join(tmpHome, '.agent-notebook', 'notebooks');
          const r = await run(['config']);
          expect(r.out).toMatch(
            new RegExp(`^NB_DIR=${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\(default\\)$`, 'm'),
          );
          const j = JSON.parse((await run(['config', '--json'])).out);
          expect(j.environment.NB_DIR).toEqual({ value: expected, source: 'default' });
        } finally {
          if (savedDir === undefined) delete process.env.NB_DIR;
          else process.env.NB_DIR = savedDir;
          if (savedHome === undefined) delete process.env.HOME;
          else process.env.HOME = savedHome;
          rmSync(tmpHome, { recursive: true, force: true });
        }
      });

      test('NB_ASCII unset under a non-UTF-8 locale defaults to on, still tagged (default)', async () => {
        // The locale-driven branch of asciiMode(): with NB_ASCII unset and a set,
        // non-UTF-8 locale (C), rendering is ASCII — value `on`, but the SOURCE is
        // still (default) because NB_ASCII itself is unset (the mode came from the
        // locale, not the var). This is the useful "ascii is on, and here's why"
        // diagnostic the numeric rows can't express.
        process.env.LANG = 'C';
        expect((await run(['config'])).out).toMatch(/^NB_ASCII=on\s+\(default\)$/m);
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.environment.NB_ASCII).toEqual({ value: 'on', source: 'default' });
      });

      test('a set NB_SESSION is surfaced with its value and tagged (env)', async () => {
        process.env.NB_SESSION = 'task-42';
        expect((await run(['config'])).out).toMatch(/^NB_SESSION=task-42\s+\(env\)$/m);
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.environment.NB_SESSION).toEqual({ value: 'task-42', source: 'env' });
      });

      test('NB_ASCII truthy forces on and reads (env); a falsey value forces off yet still reads (env)', async () => {
        process.env.NB_ASCII = '1';
        expect((await run(['config'])).out).toMatch(/^NB_ASCII=on\s+\(env\)$/m);
        process.env.NB_ASCII = '0';
        const j = JSON.parse((await run(['config', '--json'])).out);
        // Falsey → effective off, but the var IS set, so source stays env (DP-5).
        expect(j.environment.NB_ASCII).toEqual({ value: 'off', source: 'env' });
        expect((await run(['config'])).out).toMatch(/^NB_ASCII=off\s+\(env\)$/m);
      });

      test('--json nests the string vars under `environment`, keyed by var name, { value, source }', async () => {
        process.env.NB_SESSION = 'sess-1';
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(Object.keys(j.environment).sort()).toEqual(['NB_ASCII', 'NB_DIR', 'NB_SESSION']);
        expect(j.environment.NB_DIR).toEqual({ value: dir, source: 'env' });
        expect(j.environment.NB_SESSION).toEqual({ value: 'sess-1', source: 'env' });
        // Values are strings, so a supervisor reads NB_DIR without regex-parsing
        // the human lines.
        expect(typeof j.environment.NB_DIR.value).toBe('string');
      });

      test('a blank NB_SESSION reads (env), not (default) — a set-but-empty var IS set (DP-5)', async () => {
        process.env.NB_SESSION = '';
        const j = JSON.parse((await run(['config', '--json'])).out);
        expect(j.environment.NB_SESSION).toEqual({ value: '', source: 'env' });
        expect((await run(['config'])).out).toMatch(/^NB_SESSION=\s+\(env\)$/m);
      });

      test('the new env section does not disturb the numeric rows, even with a numeric override set', async () => {
        // Guard the acceptance criterion "existing numeric rows are unchanged":
        // the numeric block (everything before the blank-line separator) must be
        // identical whether or not the string env vars are set, and an env
        // override (NB_MAX_LINES) must still flow through untouched.
        process.env.NB_MAX_LINES = '7';
        const withEnvUnset = (await run(['config'])).out.split('\n\n')[0];
        process.env.NB_SESSION = 'sess-x';
        process.env.NB_ASCII = '1';
        const withEnvSet = (await run(['config'])).out.split('\n\n')[0];
        // Setting the STRING vars leaves the numeric block byte-identical...
        expect(withEnvSet).toBe(withEnvUnset);
        // ...and the numeric override still appears with its (env) tag.
        expect(withEnvSet).toMatch(/^maxLines=7\s+\(env NB_MAX_LINES\)$/m);
        expect(withEnvSet.split('\n')).toHaveLength(DEFAULTS.length);
        delete process.env.NB_MAX_LINES;
      });
    });
  });

  describe('list / ls / shelves — the notebook index (issue #71)', () => {
    test('empty/absent notebooks dir prints a friendly note on stderr, empty stdout, exit 0', async () => {
      const r = await run(['list']);
      expect(r.code).toBe(0);
      expect(r.out).toBe(''); // stdout stays empty so a pipe sees nothing
      expect(r.err).toMatch(/no notebooks yet/);
    });

    test('one richest-first line per notebook: name, lesson count, description', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['add', 'reviewer', 'another lesson']);
      await run(['add', 'patcher', 'b lesson']);
      await run(['describe', 'patcher', 'when fixing a reproduced bug']);
      const r = await run(['list']);
      expect(r.code).toBe(0);
      const lines = r.out.trimEnd().split('\n');
      expect(lines[0]).toBe(`agent-notebook notebooks — 2 in ${dir}`);
      // reviewer (2 lessons) outranks patcher (1) — richest first.
      expect(lines[1]).toContain('reviewer');
      expect(lines[1]).toMatch(/reviewer\s+2\s+/);
      expect(lines[2]).toContain('patcher');
      expect(lines[2]).toContain('when fixing a reproduced bug'); // explicit desc, no (auto)
      expect(lines[2]).not.toContain('(auto)');
    });

    test('ties in lesson count are broken by name, ascending', async () => {
      await run(['add', 'planner', 'x']);
      await run(['add', 'patcher', 'y']);
      await run(['add', 'reviewer', 'z']);
      const r = await run(['list']);
      const shelves = r.out.trimEnd().split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]);
      expect(shelves).toEqual(['patcher', 'planner', 'reviewer']);
    });

    test('a notebook with no description falls back to its top-scored lesson, marked (auto)', async () => {
      await run(['add', 'reviewer', 'low priority lesson']);
      await run(['add', 'reviewer', 'the important one']);
      await run(['vote', 'reviewer', 'important', '+1']); // make it the top-scored lesson
      const r = await run(['list']);
      const row = r.out.trimEnd().split('\n')[1];
      expect(row).toContain('the important one');
      expect(row).toContain('(auto)');
      expect(row).not.toContain('low priority lesson');
    });

    test('ls and shelves are aliases of list (identical output)', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['add', 'patcher', 'b lesson']);
      const list = await run(['list']);
      const ls = await run(['ls']);
      const roles = await run(['roles']);
      expect(ls.out).toBe(list.out);
      expect(roles.out).toBe(list.out);
    });

    test('a bare prefix filters by name (the `.` namespace convention)', async () => {
      await run(['add', 'review.security', 'a']);
      await run(['add', 'review.perf', 'b']);
      await run(['add', 'patcher', 'c']);
      const r = await run(['list', 'review.']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`2 matching "review." in ${dir}`);
      expect(r.out).toContain('review.security');
      expect(r.out).toContain('review.perf');
      expect(r.out).not.toContain('patcher');
    });

    test('a prefix that matches nothing prints a friendly note on stderr, exit 0', async () => {
      await run(['add', 'patcher', 'c']);
      const r = await run(['list', 'review.']);
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/no notebooks matching "review\."/);
    });

    test('--limit bounds the rows and the header reads "shown of total"', async () => {
      await run(['add', 'aaa', '1']);
      await run(['add', 'bbb', '1']);
      await run(['add', 'ccc', '1']);
      const r = await run(['list', '--limit', '2']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`2 of 3 in ${dir}`);
      expect(r.out.trimEnd().split('\n')).toHaveLength(3); // header + 2 rows
    });

    test('an unparseable --limit warns on stderr and falls back to the default', async () => {
      await run(['add', 'reviewer', 'a']);
      const r = await run(['list', '--limit', 'abc']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/unrecognized --limit 'abc'/);
      expect(r.out).toContain('reviewer'); // still listed with the default limit
    });

    test('--json emits the raw NotebookListing and nothing else on stdout', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['describe', 'reviewer', 'the trigger']);
      const r = await run(['list', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out);
      expect(parsed.dir).toBe(dir);
      expect(parsed.total).toBe(1);
      expect(parsed.rows[0]).toEqual({ role: 'reviewer', shelf: 'reviewer', lessons: 1, desc: 'the trigger', auto: null });
    });

    describe('one unreadable shelf does not abort list (issue #332)', () => {
      // A directory named `<shelf>.md` reproduces an EISDIR read failure (the
      // issue's own reproduction); EACCES from a root-owned/chmod'd file is the
      // same class. `list` must still exit 0, show every healthy shelf, and
      // report the casualty + errno on stderr, while `show` stays loud.
      test('exits 0, lists the rest, and reports the skipped shelf on stderr', async () => {
        await run(['add', 'alpha', 'a lesson']);
        await run(['add', 'beta', 'b lesson']);
        mkdirSync(join(dir, 'weird.md'));
        const r = await run(['list']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('alpha');
        expect(r.out).toContain('beta');
        expect(r.out).not.toContain('weird');
        expect(r.err).toContain('skipped shelf "weird"');
        expect(r.err).toContain('EISDIR');
      });

      test('--json stays byte-identical on a healthy store (no skipped field)', async () => {
        await run(['add', 'reviewer', 'a lesson']);
        const r = await run(['list', '--json']);
        const parsed = JSON.parse(r.out);
        expect(parsed).not.toHaveProperty('skipped');
        expect(Object.keys(parsed)).toEqual(['dir', 'total', 'rows']);
      });

      test('--json surfaces the skipped shelf additively when one is unreadable', async () => {
        await run(['add', 'alpha', 'a lesson']);
        mkdirSync(join(dir, 'weird.md'));
        const r = await run(['list', '--json']);
        expect(r.code).toBe(0);
        const parsed = JSON.parse(r.out);
        expect(parsed.rows.map((x: { shelf: string }) => x.shelf)).toEqual(['alpha']);
        expect(parsed.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
      });

      test('show of the unreadable shelf still fails loudly with a clear error', async () => {
        mkdirSync(join(dir, 'weird.md'));
        const r = await run(['show', 'weird']);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/EISDIR/);
      });

      test('a prefix whose only match is the skipped shelf says so, not "no match"', async () => {
        await run(['add', 'alpha', 'a lesson']);
        mkdirSync(join(dir, 'weird.md'));
        const r = await run(['list', 'weird']);
        expect(r.code).toBe(0);
        expect(r.err).toContain('skipped shelf "weird"');
        expect(r.err).toContain('no readable notebooks matching "weird"');
        expect(r.err).not.toContain('no notebooks matching "weird" — run');
      });
    });

    describe('an unreadable notebooks directory is not an empty store (issue #383)', () => {
      // Only a missing NB_DIR (ENOENT) means "no notebooks yet". A directory that
      // exists but cannot be listed must fail loudly, so a session-start hook can
      // tell "nb list failed" apart from "the store is empty".
      const EMPTY = 'no notebooks yet';

      test('a missing directory still reports "no notebooks yet" and exits 0', async () => {
        process.env.NB_DIR = join(dir, 'missing');
        const r = await run(['list']);
        expect(r.code).toBe(0);
        expect(r.err).toContain(EMPTY);
      });

      test('an empty readable directory still reports "no notebooks yet" and exits 0', async () => {
        const r = await run(['list']);
        expect(r.code).toBe(0);
        expect(r.err).toContain(EMPTY);
      });

      test('a regular file where the directory should be: list/search/stats exit 1 naming ENOTDIR', async () => {
        const file = join(dir, 'not-a-dir');
        writeFileSync(file, 'x', 'utf-8');
        process.env.NB_DIR = file;
        for (const argv of [['list'], ['search', 'lint'], ['stats']]) {
          const r = await run(argv);
          expect(r.code, argv.join(' ')).toBe(1);
          expect(r.err).toBe(`nb ${argv[0]}: cannot read notebooks directory ${JSON.stringify(file)} (ENOTDIR)\n`);
          expect(r.err).not.toContain(EMPTY);
        }
      });

      test('--json list carries a structured error naming the errno', async () => {
        const file = join(dir, 'not-a-dir');
        writeFileSync(file, 'x', 'utf-8');
        process.env.NB_DIR = file;
        const r = await run(['list', '--json']);
        expect(r.code).toBe(1);
        const parsed = JSON.parse(r.out);
        expect(parsed.ok).toBe(false);
        expect(parsed.command).toBe('list');
        expect(parsed.error.message).toContain('(ENOTDIR)');
      });

      // Root reads a chmod 000 directory anyway, so the permission case only
      // reproduces for an unprivileged user.
      test.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
        'a directory without read permission: list exits 1 naming EACCES',
        async () => {
          writeFileSync(join(dir, 'tips.md'), '+1\trun lint before claiming done\n', 'utf-8');
          const locked = join(dir, 'locked');
          mkdirSync(locked);
          chmodSync(locked, 0o000);
          process.env.NB_DIR = locked;
          try {
            const r = await run(['list']);
            expect(r.code).toBe(1);
            expect(r.err).toContain('cannot read notebooks directory');
            expect(r.err).toContain('(EACCES)');
            expect(r.err).not.toContain(EMPTY);
          } finally {
            chmodSync(locked, 0o700);
          }
        },
      );
    });

    describe('one unreadable shelf does not abort the stats inventory (issue #332)', () => {
      test('stats exits 0, lists the healthy shelves, and reports the skipped shelf on stderr', async () => {
        await run(['add', 'alpha', 'a lesson']);
        mkdirSync(join(dir, 'weird.md'));
        const r = await run(['stats']);
        expect(r.code).toBe(0);
        expect(r.out).toContain('alpha');
        expect(r.out).not.toContain('weird');
        expect(r.err).toContain('nb stats: skipped shelf "weird"');
        expect(r.err).toContain('EISDIR');
      });

      test('--json stats carries the skipped field additively', async () => {
        await run(['add', 'alpha', 'a lesson']);
        const healthy = JSON.parse((await run(['stats', '--json'])).out);
        expect(healthy.skipped).toEqual([]);
        mkdirSync(join(dir, 'weird.md'));
        const damaged = JSON.parse((await run(['stats', '--json'])).out);
        expect(damaged.notebooks.map((n: { shelf: string }) => n.shelf)).toEqual(['alpha']);
        expect(damaged.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
      });
    });

    test('a zero-lesson, no-description notebook is hidden (phantom debris)', async () => {
      // `nb describe <shelf> ""` on a fresh shelf writes an empty file with no
      // metadata and no entries — nothing to discover. It must not appear.
      await run(['describe', 'phantom', '']);
      await run(['add', 'real', 'a lesson']);
      const r = await run(['list']);
      expect(r.out).toContain('real');
      expect(r.out).not.toContain('phantom');
      expect(r.out).toContain(`1 in ${dir}`); // only the real notebook counts
    });

    test('a described-but-empty notebook IS shown (a deliberate trigger)', async () => {
      await run(['describe', 'placeholder', 'open me when onboarding a new repo']);
      const r = await run(['list']);
      expect(r.code).toBe(0);
      const row = r.out.trimEnd().split('\n')[1];
      expect(row).toContain('placeholder');
      expect(row).toMatch(/placeholder\s+0\s+/); // zero lessons, still listed
      expect(row).toContain('open me when onboarding a new repo');
      expect(row).not.toContain('(auto)'); // the trigger is the explicit description
    });

    test('excludes the .nb-usage.log / .nb.lock sidecars and stray non-.md files', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      writeFileSync(join(dir, 'notes.txt'), 'not a notebook');
      const r = await run(['list']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('reviewer');
      expect(r.out).not.toContain('nb-usage');
      expect(r.out).not.toContain('nb.lock');
      expect(r.out).not.toContain('notes');
    });

    describe('a long description is truncated to one bounded row, not wrapped (issue #211)', () => {
      // A full-width (maxChars = 200) description/trigger, printed raw, wraps across
      // terminal lines and shatters the aligned `name  count  desc` columns. The
      // human renderer must cut it to a sane fixed width with a trailing ellipsis.
      const longDesc = 'A'.repeat(100) + 'B'.repeat(100); // 200 chars, well over the 80-col cap

      // Pin the ellipsis glyph so these assertions don't flake on the host locale:
      // `asciiMode()` flips to the `...` fallback when NB_ASCII is unset AND the
      // locale is non-UTF-8 (e.g. `LANG=C` in a minimal CI container). Forcing
      // NB_ASCII='0' keeps the Unicode-ellipsis tests deterministic; the one ASCII
      // test below sets '1' and afterEach restores the original either way.
      let prevAscii: string | undefined;
      beforeEach(() => {
        prevAscii = process.env.NB_ASCII;
        process.env.NB_ASCII = '0';
      });
      afterEach(() => {
        if (prevAscii === undefined) delete process.env.NB_ASCII;
        else process.env.NB_ASCII = prevAscii;
      });

      test('nb list shows the description ellipsized and never prints the hidden tail', async () => {
        await run(['describe', 'reviewer', longDesc]);
        const r = await run(['list']);
        expect(r.code).toBe(0);
        const row = r.out.trimEnd().split('\n')[1];
        // One bounded row: the first 79 chars + a single-char ellipsis, and the
        // dropped `B…` tail never reaches the terminal.
        expect(row).toContain('A'.repeat(79) + '…');
        expect(row).not.toContain('B');
        expect(row).not.toContain('A'.repeat(80)); // the 80th char is the ellipsis, not another A
      });

      test('the (auto) top-lesson trigger is truncated the same way', async () => {
        await run(['add', 'reviewer', longDesc]); // no desc set → the lesson is the (auto) trigger
        const r = await run(['list']);
        const row = r.out.trimEnd().split('\n')[1];
        expect(row).toContain('A'.repeat(79) + '…');
        expect(row).toContain('(auto)'); // the tag still follows the bounded trigger
        expect(row).not.toContain('B');
      });

      test('a description exactly at the 80-col cap is printed in full, no ellipsis', async () => {
        const exact = 'A'.repeat(80); // == the cap: the early-return (<=) path, untouched
        await run(['describe', 'reviewer', exact]);
        const r = await run(['list']);
        const row = r.out.trimEnd().split('\n')[1];
        expect(row).toContain(exact);
        expect(row).not.toContain('…'); // nothing was cut, so no ellipsis is appended
      });

      test('one char over the cap is cut to 79 chars + ellipsis', async () => {
        const over = 'A'.repeat(81); // 81 > 80: the first over-width length
        await run(['describe', 'reviewer', over]);
        const r = await run(['list']);
        const row = r.out.trimEnd().split('\n')[1];
        expect(row).toContain('A'.repeat(79) + '…');
        expect(row).not.toContain('A'.repeat(80)); // the 80th A was dropped for the ellipsis
      });

      test('a short description is printed verbatim', async () => {
        await run(['describe', 'reviewer', 'a short trigger']);
        const r = await run(['list']);
        const row = r.out.trimEnd().split('\n')[1];
        expect(row).toContain('a short trigger');
        expect(row).not.toContain('…');
      });

      test('under NB_ASCII the ellipsis is the three-dot fallback, still within the cap', async () => {
        process.env.NB_ASCII = '1'; // afterEach restores the original
        await run(['describe', 'reviewer', longDesc]);
        const r = await run(['list']);
        const row = r.out.trimEnd().split('\n')[1];
        expect(row).toContain('A'.repeat(77) + '...'); // 77 chars + 3-dot ellipsis = 80
        expect(row).not.toContain('A'.repeat(78)); // reject a width+1 blowout (A×78 + '...')
        expect(row).not.toContain('…');
        expect(row).not.toContain('B');
      });

      test('--json still emits the full, untruncated description', async () => {
        await run(['describe', 'reviewer', longDesc]);
        const r = await run(['list', '--json']);
        const parsed = JSON.parse(r.out);
        expect(parsed.rows[0].desc).toBe(longDesc); // all 200 chars, nothing clipped
      });
    });
  });

  describe('add <shelf> - reads the lesson from stdin (issue #38)', () => {
    test('happy path: a single piped line is stored and prints the usual added line', async () => {
      // The acceptance criterion: `printf '%s\n' 'run lint first' | nb add reviewer -`.
      const r = await run(['add', 'reviewer', '-'], 'run lint first\n');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 line\n'); // the usual message, same as a quoted arg
      expect(r.err).toBe('note: created new shelf "reviewer"\n'); // only the new-shelf advisory (#354)
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('run lint first'); // stored verbatim, trailing newline stripped
    });

    test('a piped line with no trailing newline is stored just the same', async () => {
      const r = await run(['add', 'reviewer', '-'], 'no trailing newline');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 line\n');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('no trailing newline');
    });

    test('multi-line stdin is REFUSED (exit 1) and nothing is stored, not flattened', async () => {
      // One entry = one line: sanitizeLesson would otherwise collapse the two
      // lines into one space-joined entry, silently losing the boundary. The CLI
      // must reject it before addEntry ever sees it.
      const r = await run(['add', 'reviewer', '-'], 'line one\nline two\n');
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/multi-line/i);
      expect(r.err).toMatch(/one entry = one line/i);
      const show = await run(['show', 'reviewer']);
      expect(show.err).toContain('no notebook for shelf "reviewer"'); // not stored → shelf never created (issue #166)
      expect(show.out).not.toContain('line one line two'); // and definitely not flattened
    });

    test('CRLF and lone-CR line breaks are refused too, not flattened to a space', async () => {
      // sanitizeLesson collapses \r just like \n, so every line-ending
      // convention (LF, CRLF, old-Mac CR) must trigger the multi-line refusal —
      // otherwise a two-line paste would silently store one run-together entry.
      for (const raw of ['one\r\ntwo\r\n', 'alpha\rbeta\n']) {
        const r = await run(['add', 'reviewer', '-'], raw);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/multi-line/i);
      }
      const show = await run(['show', 'reviewer']);
      expect(show.err).toContain('no notebook for shelf "reviewer"'); // none stored → never created (issue #166)
    });

    test('a single trailing CRLF is stripped, leaving the clean line', async () => {
      const r = await run(['add', 'reviewer', '-'], 'windows line\r\n');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 line\n');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('windows line');
      expect(show.out).not.toContain('\r'); // the trailing CR was stripped, not stored
    });

    test('empty stdin falls through to the empty-lesson skip (exit 0), not a crash', async () => {
      const r = await run(['add', 'reviewer', '-'], '');
      expect(r.code).toBe(0);
      expect(r.out).toContain('skipped (empty lesson)');
      const show = await run(['show', 'reviewer']);
      expect(show.err).toContain('no notebook for shelf "reviewer"'); // empty lesson skipped → never created (issue #166)
    });

    test('--json composes with the stdin operand', async () => {
      // --json is stripped before positional parsing, so `-` is still args[2].
      const r = await run(['add', 'reviewer', '-', '--json'], 'piped with json\n');
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(JSON.parse(r.out)).toEqual({ added: true, reason: 'added', evicted: null, evictedAll: [], decayed: null, size: 1, created: true, id: entryId('piped with json') });
    });
  });

  describe('--json on add/vote/rm/merge (issue #41)', () => {
    // A supervisor should branch on `reason`/`score` without regex-parsing the
    // English line, exactly as `stats --json` already allows for monitoring.
    /** stdout must be exactly one parseable JSON object and nothing else. */
    function parseOnly(out: string): unknown {
      expect(out.endsWith('\n')).toBe(true);
      expect(out.trimEnd().includes('\n')).toBe(false); // single line, no stray prose
      return JSON.parse(out);
    }

    test('add --json prints a parseable AddResult and nothing else (exit 0)', async () => {
      const r = await run(['add', 'patcher', 'prefer execFileSync', '--json']);
      expect(r.code).toBe(0);
      expect(r.err).toBe(''); // warnings/errors would be on stderr; there are none
      expect(parseOnly(r.out)).toEqual({ added: true, reason: 'added', evicted: null, evictedAll: [], decayed: null, size: 1, created: true, id: entryId('prefer execFileSync') });
    });

    test('add --json on a duplicate emits reason:"duplicate" and stays exit 0', async () => {
      await run(['add', 'patcher', 'same lesson']);
      const r = await run(['add', 'patcher', 'same lesson', '--json']);
      expect(r.code).toBe(0); // a duplicate is a skip, not a failure
      expect(parseOnly(r.out)).toMatchObject({ added: false, reason: 'duplicate', size: 1 });
    });

    test('add --json on a too-long lesson emits reason:"too-long" on stdout but still exits 1', async () => {
      process.env.NB_MAX_CHARS = '25';
      const r = await run(['add', 'patcher', 'z'.repeat(60), '--json']);
      expect(r.code).toBe(1); // exit code unchanged from the text path
      expect(parseOnly(r.out)).toMatchObject({ added: false, reason: 'too-long', length: 60, overflow: 35 }); // overflow = 60 - 25 (issue #239)
      const show = await run(['show', 'patcher']);
      expect(show.err).toContain('no notebook for shelf "patcher"'); // not stored → shelf never created (issue #166)
    });

    test('vote --json prints a parseable VoteResult', async () => {
      await run(['add', 'patcher', 'run lint before done']);
      const r = await run(['vote', 'patcher', 'lint', '+1', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toEqual({ text: 'run lint before done', score: 2 });
    });

    test('rm --json prints the removed entry', async () => {
      await run(['add', 'patcher', 'delete me']);
      const r = await run(['rm', 'patcher', 'delete me', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toEqual({ text: 'delete me', score: 1 });
    });

    test('merge --json prints the resulting AddResult', async () => {
      await run(['add', 'patcher', 'alpha lesson']);
      await run(['add', 'patcher', 'beta lesson']);
      const r = await run(['merge', 'patcher', 'alpha', 'beta', 'alpha+beta merged', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toMatchObject({ added: true, reason: 'added', size: 1 });
    });

    test('the flag is positional-order-independent and leaves the shelf/lesson intact', async () => {
      // --json between the shelf and the lesson must be stripped before positional
      // parsing, so the lesson is not swallowed and the shelf still resolves.
      const r = await run(['add', 'patcher', '--json', 'a lesson in the middle']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toMatchObject({ added: true, reason: 'added', size: 1 });
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('a lesson in the middle'); // stored verbatim, flag not captured
    });

    test('without --json the English lines are unchanged', async () => {
      const r = await run(['add', 'patcher', 'plain text path']);
      expect(r.out).toBe('added — 1 line\n');
    });
  });

  describe('--json completes the machine contract on throw + defaulted-flag paths (issue #266)', () => {
    /** stdout must be exactly one parseable JSON object and nothing else. */
    function parseOnly(out: string): unknown {
      expect(out.endsWith('\n')).toBe(true);
      expect(out.trimEnd().includes('\n')).toBe(false); // single line, no stray prose
      return JSON.parse(out);
    }

    test('a bad_args throw emits {ok:false, command, error:{class,message}} on stdout, keeps the English line on stderr, exit 1', async () => {
      const r = await run(['add', '--json']); // missing <shelf> (and <lesson>)
      expect(r.code).toBe(1); // exit unchanged from the prose path
      expect(parseOnly(r.out)).toEqual({
        ok: false,
        command: 'add',
        error: { class: 'bad_args', message: 'missing <shelf> argument' },
      });
      // The human line is byte-for-byte what it always was (stderr is untouched).
      expect(r.err).toBe('nb add: missing <shelf> argument\n');
    });

    test('a no_match throw carries error.class="no_match" so a supervisor branches on the class, not the prose', async () => {
      // vote on a shelf that was never created → requireExistingShelf throws no_match.
      const r = await run(['vote', 'ghostshelf', 'anything', '+1', '--json']);
      expect(r.code).toBe(1);
      const obj = parseOnly(r.out) as { ok: boolean; command: string; error: { class: string; message: string } };
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe('vote');
      expect(obj.error.class).toBe('no_match'); // the branch key — never regex-parsed prose
      expect(obj.error.message).toContain('no notebook for shelf "ghostshelf"');
      expect(r.err).toContain('no notebook for shelf "ghostshelf"'); // stderr still carries the prose
    });

    test('an ambiguous_selector throw is reported with its own class', async () => {
      await run(['add', 'patcher', 'alpha one']);
      await run(['add', 'patcher', 'alpha two']);
      const r = await run(['vote', 'patcher', 'alpha', '+1', '--json']); // matches both
      expect(r.code).toBe(1);
      const obj = parseOnly(r.out) as { error: { class: string } };
      expect(obj.error.class).toBe('ambiguous_selector');
    });

    test('an unknown subcommand emits a structured unknown_subcommand error on stdout and keeps exit 2', async () => {
      const r = await run(['upvote', '--json']); // not a real command
      expect(r.code).toBe(2); // distinct from the 1 a handled error returns
      const obj = parseOnly(r.out) as { ok: boolean; command: string; error: { class: string; message: string } };
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe('upvote');
      expect(obj.error.class).toBe('unknown_subcommand');
      expect(r.err).toMatch(/^nb: unknown command "upvote"\./); // bare `nb:` prefix unchanged
    });

    test('without --json the throw paths are byte-for-byte unchanged (no JSON leaks to stdout)', async () => {
      const bad = await run(['add']); // missing <shelf>, no --json
      expect(bad.code).toBe(1);
      expect(bad.out).toBe(''); // stdout stays empty on the human path
      expect(bad.err).toBe('nb add: missing <shelf> argument\n');

      const unknown = await run(['upvote']); // unknown command, no --json
      expect(unknown.code).toBe(2);
      expect(unknown.out).toBe('');
      expect(unknown.err).toMatch(/^nb: unknown command "upvote"\./);
    });

    test('a silently-defaulted --since adds a machine-readable warning on stderr under --json while stdout stays a pure StatsReport', async () => {
      await run(['add', 'patcher', 'x']);
      const r = await run(['stats', 'patcher', '--since', '7days', '--json']);
      expect(r.code).toBe(0); // a defaulted flag is forgiving, not an error
      const rep = JSON.parse(r.out) as { window: string }; // stdout is still ONE bare StatsReport
      expect(rep.window).toBe('7d');
      // The prose line is preserved (existing behavior/tests rely on it) AND a
      // structured warning is now emitted so a --json consumer can branch on it.
      expect(r.err).toContain("unrecognized --since '7days'");
      const warnLine = r.err.trimEnd().split('\n').find((l) => l.startsWith('{'));
      expect(warnLine).toBeDefined();
      expect(JSON.parse(warnLine as string)).toEqual({
        warning: { class: 'defaulted_flag', command: 'stats', flag: '--since', value: '7days', usedDefault: '7d' },
      });
    });

    // One case per --limit call site of warnDefaultedFlag (search / list / stale),
    // so a regression at any single site is caught (the helper has four callers;
    // --since is covered above). Each asserts true channel separation: the bare
    // result object stays alone on stdout and the structured warning is ONLY on
    // stderr — `JSON.parse not.toThrow` alone would not prove the warning stayed
    // off stdout.
    test.each([
      { command: 'search', argv: ['search', 'lint', '--limit', 'abc', '--json'], usedDefault: 50 }, // SEARCH_DEFAULT_LIMIT
      { command: 'list', argv: ['list', '--limit', 'abc', '--json'], usedDefault: 50 }, // LIST_DEFAULT_LIMIT
      { command: 'stale', argv: ['stale', 'patcher', '--limit', 'abc', '--json'], usedDefault: 10 }, // STALE_DEFAULT_LIMIT
    ])('a silently-defaulted --limit is flagged under --json for $command (stdout stays a pure result)', async ({ command, argv, usedDefault }) => {
      await run(['add', 'patcher', 'run lint before done']);
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(() => JSON.parse(r.out)).not.toThrow(); // stdout is the bare result object
      expect(r.out.trimEnd().includes('\n')).toBe(false); // exactly one object on stdout
      expect(r.out).not.toContain('defaulted_flag'); // channel separation: the warning never leaks to stdout
      expect(r.err).toContain("unrecognized --limit 'abc'"); // prose preserved on stderr
      const warnLine = r.err.trimEnd().split('\n').find((l) => l.startsWith('{'));
      expect(JSON.parse(warnLine as string)).toEqual({
        warning: { class: 'defaulted_flag', command, flag: '--limit', value: 'abc', usedDefault },
      });
    });

    test('a generic (non-NbError) throw — e.g. an EACCES-style write failure — is reported as class "other"', async () => {
      // The EACCES path the issue names is any throw the catch classifies as
      // `other`. Force a deterministic, cross-platform write failure: point NB_DIR
      // under a regular file so the notebook mkdir fails with ENOTDIR (a plain
      // Error, not an NbError). Under --json it must still yield a structured
      // error object on stdout keyed `other`, exit 1.
      const blocker = join(dir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      process.env.NB_DIR = join(blocker, 'nb'); // mkdir under a file → ENOTDIR
      const r = await run(['add', 'patcher', 'a lesson', '--json']);
      expect(r.code).toBe(1);
      const obj = parseOnly(r.out) as { ok: boolean; command: string; error: { class: string } };
      expect(obj.ok).toBe(false);
      expect(obj.command).toBe('add');
      expect(obj.error.class).toBe('other'); // a non-NbError classifies as other, never guessed from prose
      expect(r.err).toMatch(/^nb add: /); // the English line still goes to stderr
    });

    test('WITHOUT --json a defaulted flag stays a single prose line — no JSON warning leaks to stderr', async () => {
      await run(['add', 'patcher', 'x']);
      const r = await run(['stats', 'patcher', '--since', 'nope']); // no --json
      expect(r.code).toBe(0);
      expect(r.err).toContain("unrecognized --since 'nope'");
      expect(r.err.trimEnd().split('\n')).toHaveLength(1); // exactly one line, no structured warning
      expect(r.err).not.toContain('defaulted_flag');
    });
  });

  describe('usage log records entry ids + outcome (issue #67)', () => {
    test('add logs the accepted outcome and the touched entry id', async () => {
      await run(['add', 'patcher', 'prefer execFileSync, array args']);
      const [row] = parseUsage(dir);
      expect(row.command).toBe('add');
      expect(row.ok).toBe(true);
      expect(row.outcome).toBe('accepted');
      expect(row.entries).toEqual([entryId('prefer execFileSync, array args')]);
    });

    test('a duplicate add logs dedup-blocked and the colliding entry id', async () => {
      await run(['add', 'patcher', 'run lint before done']);
      await run(['add', 'patcher', 'run lint before done']);
      const dupRow = parseUsage(dir).at(-1)!;
      expect(dupRow.outcome).toBe('dedup-blocked');
      expect(dupRow.collided).toBe(entryId('run lint before done'));
    });

    test('a resembling add still stores the lesson, warns on stderr, and logs the accepted row with the near-match id (FR-ADD-008)', async () => {
      process.env.NB_NEAR_DUP = '0.4';
      await run(['add', 'patcher', 'run lint before claiming done']);
      const nearId = entryId('run lint before claiming done');
      const r = await run(['add', 'patcher', 'run lint before claiming complete']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('added —'); // the lesson WAS stored (stdout, pipe-clean)
      expect(r.err).toContain('resembles'); // the advisory went to stderr
      expect(r.err).toContain(nearId);
      expect(r.err).toContain('nb merge');
      // The accepted row carries the resemblance as the measurable near-dup
      // signal — read it NOW, before any later command appends its own row.
      const row = parseUsage(dir).at(-1)!;
      expect(row.outcome).toBe('accepted');
      expect(row.collided).toBe(nearId);
      // Both lessons are kept — the advisory never blocks.
      expect((await run(['show', 'patcher'])).out).toContain('run lint before claiming complete');
      delete process.env.NB_NEAR_DUP;
    });

    test('a resembling add --json carries nearId; a dissimilar add does not warn', async () => {
      process.env.NB_NEAR_DUP = '0.4';
      await run(['add', 'patcher', 'run lint before claiming done']);
      const j = await run(['add', 'patcher', 'run lint before claiming complete', '--json']);
      expect(JSON.parse(j.out).nearId).toBe(entryId('run lint before claiming done'));
      const far = await run(['add', 'patcher', 'rotate the TLS certificate yearly']);
      expect(far.err).not.toContain('resembles');
      delete process.env.NB_NEAR_DUP;
    });

    test('vote logs the direction and the voted entry id', async () => {
      await run(['add', 'patcher', 'alpha lesson']);
      await run(['vote', 'patcher', 'alpha', '+1']);
      const voteRow = parseUsage(dir).at(-1)!;
      expect(voteRow.command).toBe('vote');
      expect(voteRow.outcome).toBe('up');
      expect(voteRow.entries).toEqual([entryId('alpha lesson')]);
    });

    test('NB_SESSION is threaded onto every row the call writes', async () => {
      process.env.NB_SESSION = 'cli-session-7';
      await run(['add', 'patcher', 'session threaded lesson']);
      expect(parseUsage(dir).at(-1)!.session).toBe('cli-session-7');
    });

    test('an over-length add logs errorClass too_long and exits 1 (issue #176)', async () => {
      process.env.NB_MAX_CHARS = '20';
      const r = await run(['add', 'patcher', 'x'.repeat(50)]);
      expect(r.code).toBe(1); // the add was rejected, not stored
      const row = parseUsage(dir).at(-1)!;
      expect(row.ok).toBe(false);
      expect(row.errorClass).toBe('too_long');
    });

    test('an over-length add --json also logs too_long (same class on both exit paths)', async () => {
      process.env.NB_MAX_CHARS = '20';
      const r = await run(['add', 'patcher', 'y'.repeat(50), '--json']);
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('too_long');
    });

    test('an ambiguous vote selector logs errorClass ambiguous_selector (issue #176)', async () => {
      await run(['add', 'patcher', 'alpha first lesson']);
      await run(['add', 'patcher', 'alpha second lesson']);
      const r = await run(['vote', 'patcher', 'alpha', '+1']); // matches both
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('ambiguous_selector');
    });

    test('a vote selector that matches nothing logs errorClass no_match', async () => {
      await run(['add', 'patcher', 'only lesson']);
      const r = await run(['vote', 'patcher', 'zzzznope', '+1']);
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('no_match');
    });

    test('a bad vote direction logs errorClass bad_args', async () => {
      await run(['add', 'patcher', 'only lesson']);
      const r = await run(['vote', 'patcher', 'only', 'sideways']);
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('bad_args');
    });

    test('a missing argument logs errorClass bad_args', async () => {
      const r = await run(['add']); // missing <shelf>
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('bad_args');
    });

    test('multi-line stdin to `add -` logs errorClass multiline_refused', async () => {
      const r = await run(['add', 'patcher', '-'], 'line one\nline two\n');
      expect(r.code).toBe(1);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('multiline_refused');
    });

    test('an unknown command logs errorClass unknown_subcommand (agents guessing names)', async () => {
      const r = await run(['upvote', 'patcher', 'alpha']);
      expect(r.code).toBe(2);
      expect(parseUsage(dir).at(-1)!.errorClass).toBe('unknown_subcommand');
    });

    test('a non-NbError failure falls back to errorClass other (catch-path classifyError)', async () => {
      // Make `weird.md` a DIRECTORY so `show weird` reads it with readFileSync and
      // throws a plain EISDIR Error — NOT an NbError — exercising the catch block's
      // `meta.errorClass ??= classifyError(e)` fallback to `other`. NB_DIR itself
      // stays a real directory, so the finally's logUsage still records the row.
      mkdirSync(join(dir, 'weird.md'));
      const r = await run(['show', 'weird']);
      expect(r.code).toBe(1);
      const row = parseUsage(dir).at(-1)!;
      expect(row.ok).toBe(false);
      expect(row.errorClass).toBe('other');
    });

    test('a successful command logs a blank error class', async () => {
      await run(['add', 'patcher', 'a fine lesson']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.ok).toBe(true);
      expect(row.errorClass).toBe('');
    });

    test('a read-only command (show) logs blank richer fields', async () => {
      await run(['show', 'patcher']);
      const [row] = parseUsage(dir);
      expect(row.command).toBe('show');
      expect(row.entries).toEqual([]);
      expect(row.outcome).toBe('');
      expect(row.session).toBe('');
    });

    // Hermeticity regression (issue #230): an ambient NB_SESSION — exported by
    // the host before the suite started, as agents and CI-adjacent tooling do —
    // must NOT leak into a test that assumes a blank session. `beforeAll` sets
    // it to mimic that ambient value; the clean-baseline `beforeEach` clears it,
    // so a blank-session assertion still holds. Remove the clearing and this
    // test reproduces the original spurious failure.
    describe('with an ambient NB_SESSION pre-set before the suite runs', () => {
      const PRESET = 'ambient-session-from-host';
      let savedSession: string | undefined;
      beforeAll(() => {
        savedSession = process.env.NB_SESSION;
        process.env.NB_SESSION = PRESET;
      });
      afterAll(() => {
        if (savedSession === undefined) delete process.env.NB_SESSION;
        else process.env.NB_SESSION = savedSession;
      });

      test('a read-only command still logs a blank session (no ambient leak)', async () => {
        await run(['show', 'patcher']);
        const [row] = parseUsage(dir);
        expect(row.session).toBe('');
      });
    });
  });

  describe('split (issue #68)', () => {
    test('splits one entry into two, reflected by show', async () => {
      await run(['add', 'patcher', 'build then test the change']);
      const s = await run(['split', 'patcher', 'build', 'build the change', 'test the change after building']);
      expect(s.code).toBe(0);
      expect(s.out).toContain('split one entry into two');
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('build the change');
      expect(show.out).toContain('test the change after building');
      expect(show.out).not.toContain('build then test the change');
    });

    test('a missing lesson argument exits 1', async () => {
      await run(['add', 'patcher', 'overloaded entry here']);
      const r = await run(['split', 'patcher', 'overloaded', 'only one half']); // no second lesson
      expect(r.code).toBe(1);
      expect(r.err).toContain('missing <lessonB>');
    });

    test('an over-length half exits 1 and leaves the notebook unchanged', async () => {
      process.env.NB_MAX_CHARS = '30';
      await run(['add', 'patcher', 'overloaded entry']);
      const r = await run(['split', 'patcher', 'overloaded', 'short half', 'z'.repeat(50)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('max is 30');
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('overloaded entry'); // original intact
    });

    test('--json prints the SplitResult (source + two ids)', async () => {
      await run(['add', 'patcher', 'alpha and beta crammed in']);
      const r = await run(['split', 'patcher', 'alpha', 'alpha half of it', 'beta half of it', '--json']);
      expect(r.code).toBe(0);
      const obj = JSON.parse(r.out.trim());
      expect(obj.size).toBe(2);
      expect(obj.source).toBe(entryId('alpha and beta crammed in'));
      expect(obj.ids).toEqual([entryId('alpha half of it'), entryId('beta half of it')]);
    });

    test('logs the split outcome, the source+produced ids, and a recognized reason', async () => {
      await run(['add', 'patcher', 'two lessons in one line']);
      await run(['split', 'patcher', 'two lessons', 'first lesson alone', 'second lesson alone', '--reason', 'overloaded']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('split');
      expect(row.outcome).toBe('split');
      expect(row.reason).toBe('overloaded');
      expect(row.entries).toEqual([
        entryId('two lessons in one line'),
        entryId('first lesson alone'),
        entryId('second lesson alone'),
      ]);
    });

    test('an unrecognized reason is logged as other with the code kept in the note', async () => {
      await run(['add', 'patcher', 'overloaded compound lesson']);
      await run(['split', 'patcher', 'overloaded', 'half one here', 'half two here', '--reason', 'redundant', '--note', 'felt mixed']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.reason).toBe('other');
      expect(row.note).toBe('redundant: felt mixed');
    });

    test('--reason without a value exits 1 (never silently dropped)', async () => {
      await run(['add', 'patcher', 'overloaded compound lesson']);
      const r = await run(['split', 'patcher', 'overloaded', 'half one here', 'half two here', '--reason']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('--reason needs a value');
    });
  });

  describe('operation reasons on add/merge/rm (issue #69)', () => {
    test('merge logs a recognized reason (duplicate)', async () => {
      await run(['add', 'patcher', 'run the build first']);
      await run(['add', 'patcher', 'build before running tests']);
      const m = await run(['merge', 'patcher', 'run the build', 'build before', 'run the build before tests', '--reason', 'duplicate']);
      expect(m.code).toBe(0);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('merge');
      expect(row.outcome).toBe('merged');
      expect(row.reason).toBe('duplicate');
    });

    test('rm logs a recognized reason (obsolete) and the removed id', async () => {
      await run(['add', 'patcher', 'use the --cache flag always']);
      const r = await run(['rm', 'patcher', 'cache flag', '--reason', 'obsolete', '--note', 'flag was removed in v3']);
      expect(r.code).toBe(0);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('rm');
      expect(row.outcome).toBe('removed');
      expect(row.reason).toBe('obsolete');
      expect(row.note).toBe('flag was removed in v3');
      expect(row.entries).toEqual([entryId('use the --cache flag always')]);
    });

    test('rm with an unrecognized code is logged as other, code kept in the note', async () => {
      await run(['add', 'patcher', 'a lesson to drop']);
      await run(['rm', 'patcher', 'lesson to drop', '--reason', 'stale', '--note', 'no longer relevant']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.reason).toBe('other');
      expect(row.note).toBe('stale: no longer relevant');
    });

    test('add records a free-text note with an empty reason (no enum yet)', async () => {
      await run(['add', 'patcher', 'prefer execFileSync over execSync', '--note', 'learned from a shell-injection bug']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('add');
      expect(row.outcome).toBe('accepted');
      expect(row.reason).toBe('');
      expect(row.note).toBe('learned from a shell-injection bug');
    });

    test('merge --reason without a value exits 1 (never silently dropped)', async () => {
      await run(['add', 'patcher', 'first lesson line']);
      await run(['add', 'patcher', 'second lesson line']);
      const r = await run(['merge', 'patcher', 'first lesson', 'second lesson', 'merged line', '--reason']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('--reason needs a value');
    });
  });
});

describe('nb move (score-preserving cross-shelf move, issue #103)', () => {
  test('moves an entry to another shelf keeping its score, and reports both sizes', async () => {
    await run(['add', 'thin', 'use execFileSync with array args']);
    await run(['vote', 'thin', 'execFileSync', '+1']); // score +2
    const m = await run(['move', 'thin', 'broad', 'execFileSync']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('moved [+2]');
    expect(m.out).toContain('"thin" now 0');
    expect(m.out).toContain('"broad" now 1');
    // the score survived the move — `show` on the target prints [+2], not the +1 add floor
    const show = await run(['show', 'broad']);
    expect(show.out).toMatch(/\[\+2\]\s+use execFileSync with array args/);
    // the undescribed source emptied by the move is reaped (issue #355), not left as a 0-byte file
    expect((await run(['show', 'thin'])).err).toContain('no notebook for shelf "thin"');
  });

  test('--json emits a MoveResult with the preserved score', async () => {
    await run(['add', 'from', 'portable lesson']);
    await run(['vote', 'from', 'portable', '+1']); // +2
    const m = await run(['move', '--json', 'from', 'to', 'portable']);
    expect(m.code).toBe(0);
    const r = JSON.parse(m.out);
    expect(r.reason).toBe('moved');
    expect(r.score).toBe(2);
    expect(r.id).toBe(entryId('portable lesson'));
    expect(r.fromSize).toBe(0);
    expect(r.toSize).toBe(1);
  });

  test('a near-duplicate in the target is skipped (exit 0), leaving the source intact', async () => {
    await run(['add', 'from', 'prefer execFileSync, array args']);
    await run(['add', 'to', 'prefer execfilesync array args']); // dedup-equal
    const m = await run(['move', 'from', 'to', 'execFileSync']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('skipped');
    expect((await run(['show', 'from'])).out).toContain('prefer execFileSync');
  });

  test('moving into the same shelf exits 1', async () => {
    await run(['add', 's', 'only lesson']);
    const m = await run(['move', 's', 's', 'only']);
    expect(m.code).toBe(1);
    expect(m.err).toContain('two different shelves');
  });

  test('a missing operand exits 1', async () => {
    await run(['add', 'from', 'x']);
    const m = await run(['move', 'from', 'to']); // no selector
    expect(m.code).toBe(1);
    expect(m.err).toContain('missing <id|query>');
  });

  test('logs the move attributed to the source shelf, with the recognized reason', async () => {
    process.env.NB_SESSION = 'cli-move-1';
    await run(['add', 'from', 'a durable lesson']);
    await run(['move', 'from', 'to', 'durable', '--reason', 'consolidate']);
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('move');
    expect(row.role).toBe('from'); // attributed to the source shelf
    expect(row.outcome).toBe('moved');
    expect(row.reason).toBe('consolidate');
    expect(row.entries).toEqual([entryId('a durable lesson')]);
  });

  test('an unrecognized move reason is logged as other, code kept in the note', async () => {
    await run(['add', 'from', 'another lesson']);
    await run(['move', 'from', 'to', 'another', '--reason', 'tidying', '--note', 'end of sprint']);
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('move');
    expect(row.reason).toBe('other');
    expect(row.note).toBe('tidying: end of sprint');
  });
});

// The CLI entrypoint is `settleCliExit(runNbCli(...))`. `runNbCli` try/catches
// every handled command error and resolves with an exit code, so no input makes
// the real promise reject today — the `.catch` guards against a *future* bug in
// the wrapper. These tests drive `settleCliExit` directly with synthetic
// promises to prove the contract: a rejection yields exit code 1 + a stderr
// line (so a crash can't look like success — DP-5), and a resolution forwards
// the code (so the happy path keeps exiting 0).
describe('settleCliExit', () => {
  // Mutating process.exitCode would otherwise leak into vitest's own exit; each
  // test captures stderr and restores both exitCode and stderr.write afterwards.
  async function withSettle(
    result: Promise<number>,
  ): Promise<{ exitCode: typeof process.exitCode; err: string }> {
    const savedExit = process.exitCode;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = '';
    process.stderr.write = (s: string) => ((err += s), true);
    try {
      await settleCliExit(result);
      return { exitCode: process.exitCode, err };
    } finally {
      process.stderr.write = origErr;
      process.exitCode = savedExit;
    }
  }

  test('a rejected promise sets exit code 1 and writes a stderr line', async () => {
    const { exitCode, err } = await withSettle(Promise.reject(new Error('boom in the wrapper')));
    expect(exitCode).toBe(1);
    expect(err).toContain('boom in the wrapper');
    expect(err).toMatch(/^nb: fatal:/);
  });

  test('a non-Error rejection is stringified, still exit 1', async () => {
    const { exitCode, err } = await withSettle(Promise.reject('plain string failure'));
    expect(exitCode).toBe(1);
    expect(err).toContain('plain string failure');
  });

  test('an Error with no stack falls back to its message', async () => {
    const stackless = new Error('no-stack failure');
    stackless.stack = undefined;
    const { exitCode, err } = await withSettle(Promise.reject(stackless));
    expect(exitCode).toBe(1);
    expect(err).toContain('no-stack failure');
  });

  test('a resolved promise forwards the exit code and writes nothing to stderr', async () => {
    const zero = await withSettle(Promise.resolve(0));
    expect(zero.exitCode).toBe(0);
    expect(zero.err).toBe('');

    const two = await withSettle(Promise.resolve(2));
    expect(two.exitCode).toBe(2);
    expect(two.err).toBe('');
  });
});

// A reader that closes a pipe early (`nb show <shelf> | head -1`, `| grep -q`,
// quitting a pager) makes the next stdout write fail with EPIPE. Without a guard
// that is an uncaught async error — a `write EPIPE` stack trace on stderr and an
// abnormal exit — which is noise for interactive use and trips piping scripts.
// `installPipeGuards` turns a broken pipe into a clean exit while keeping any
// other stream error loud. The unit tests drive the handler with a fake emitter
// (no need to tear down the runner's real stdout); the end-to-end test proves
// the whole thing against a real `| head -1` pipe on the built CLI.
describe('installPipeGuards — stdout broken-pipe guard (issue #246)', () => {
  const CLI_JS = join(REPO_ROOT, 'dist', 'cli.js');
  const BASH_PRESENT = ((): boolean => {
    try {
      execFileSync('bash', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test('EPIPE on a guarded stream exits cleanly and is not re-thrown', () => {
    const stream = new EventEmitter();
    let cleanExits = 0;
    installPipeGuards([stream], () => {
      cleanExits += 1;
    });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // A listener is present, so emit() routes to our handler rather than
    // re-throwing; the benign broken pipe must NOT propagate as an error.
    expect(() => stream.emit('error', epipe)).not.toThrow();
    expect(cleanExits).toBe(1); // routed to the clean-exit path exactly once
  });

  test('a non-EPIPE stream error still surfaces loudly (re-thrown, not swallowed)', () => {
    const stream = new EventEmitter();
    let cleanExits = 0;
    installPipeGuards([stream], () => {
      cleanExits += 1;
    });
    const eacces = Object.assign(new Error('write EACCES'), { code: 'EACCES' });
    // A real write failure must keep throwing — the guard is scoped to EPIPE so
    // genuine errors are never silently turned into a success exit.
    expect(() => stream.emit('error', eacces)).toThrow(/EACCES/);
    expect(cleanExits).toBe(0); // the clean-exit path was NOT taken
  });

  test('every passed stream is guarded (stdout and stderr both covered)', () => {
    const a = new EventEmitter();
    const b = new EventEmitter();
    let cleanExits = 0;
    installPipeGuards([a, b], () => {
      cleanExits += 1;
    });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => a.emit('error', epipe)).not.toThrow();
    expect(() => b.emit('error', epipe)).not.toThrow();
    expect(cleanExits).toBe(2);
  });

  test('defaults to guarding BOTH process.stdout and process.stderr', () => {
    // No-args call exercises the default stream list — the real entrypoint wiring
    // lives under `/* c8 ignore */`, so without this a regression that dropped
    // `process.stderr` from the default would go uncaught. Record the pre-existing
    // listeners, install, assert exactly one new `error` listener landed on each
    // stream, then remove precisely those so the default `process.exit()` handler
    // can never fire during the rest of the suite.
    const stdoutBefore = process.stdout.listeners('error');
    const stderrBefore = process.stderr.listeners('error');
    installPipeGuards();
    const added = (s: NodeJS.EventEmitter, before: unknown[]): unknown[] =>
      s.listeners('error').filter((l) => !before.includes(l));
    try {
      expect(added(process.stdout, stdoutBefore)).toHaveLength(1);
      expect(added(process.stderr, stderrBefore)).toHaveLength(1);
    } finally {
      for (const l of added(process.stdout, stdoutBefore)) {
        process.stdout.removeListener('error', l as (...a: unknown[]) => void);
      }
      for (const l of added(process.stderr, stderrBefore)) {
        process.stderr.removeListener('error', l as (...a: unknown[]) => void);
      }
    }
  });

  // End-to-end acceptance (issue #246): the real built CLI piped into `head -1`.
  // Needs bash + the built dist/cli.js (pretest builds it); `skipIf` so a host
  // missing either shows the skip in the report rather than a silent green pass.
  test.skipIf(!BASH_PRESENT || !existsSync(CLI_JS))(
    '`nb show <shelf> | head -1` exits 0 with no EPIPE on stderr',
    () => {
      // The shelf must render larger than the OS pipe buffer (~64 KiB) so the
      // single `show` write can't complete before `head -1` reads its line and
      // closes the pipe — only then does the deferred flush hit EPIPE and exercise
      // the guard. A tiny shelf would be fully buffered and never trigger it. Write
      // the shelf file directly (storage format `<score>\t<text>`) to keep it fast.
      const bigDir = mkdtempSync(join(tmpdir(), 'agent-notebook-epipe-'));
      try {
        const lines: string[] = [];
        for (let i = 0; i < 3000; i++) lines.push(`+1\t#${i} ${'x'.repeat(180)}`);
        writeFileSync(join(bigDir, 'big.md'), lines.join('\n') + '\n');

        // `set -o pipefail` so the pipeline's status reflects nb's OWN exit (not
        // head's 0): an unguarded EPIPE crash would make nb exit non-zero and turn
        // this status to 1. nb's stderr propagates through the inherited fd.
        const r = spawnSync(
          'bash',
          ['-c', `set -o pipefail; node ${JSON.stringify(CLI_JS)} show big | head -1`],
          { env: { ...process.env, NB_DIR: bigDir }, encoding: 'utf8' },
        );

        expect(r.stderr).not.toMatch(/EPIPE/); // no uncaught broken-pipe crash
        expect(r.status).toBe(0); // clean exit, not 1 from an uncaught EPIPE error
        expect(r.stdout.split('\n').filter(Boolean).length).toBe(1); // head got its one line
      } finally {
        rmSync(bigDir, { recursive: true, force: true });
      }
    },
  );
});

describe('nb describe (issue #70)', () => {
  test('sets a description, then prints it back with no text operand', async () => {
    const set = await run(['describe', 'patcher', 'build / test gotchas for this repo']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('description set for shelf "patcher"');
    const get = await run(['describe', 'patcher']);
    expect(get.code).toBe(0);
    expect(get.out).toBe('build / test gotchas for this repo\n'); // bare line, pipe-friendly
  });

  test('`nb show` prints the description as a header above the lessons', async () => {
    await run(['add', 'patcher', 'run build before test']);
    await run(['describe', 'patcher', 'when debugging CI']);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out.split('\n')[0]).toBe('# desc: when debugging CI'); // header first
    expect(show.out).toContain('run build before test');
  });

  test('a notebook with no description shows no header (unchanged output)', async () => {
    await run(['add', 'patcher', 'a lesson']);
    const show = await run(['show', 'patcher']);
    expect(show.out.startsWith('#')).toBe(false);
    expect(show.out).toContain('a lesson');
  });

  test('reading a description that is not set warns on stderr (exit 0)', async () => {
    const get = await run(['describe', 'ghost']);
    expect(get.code).toBe(0);
    expect(get.out).toBe('');
    expect(get.err).toContain('no description set for shelf "ghost"');
  });

  test('an over-long description is rejected (exit 1), never truncated', async () => {
    process.env.NB_MAX_CHARS = '20';
    const r = await run(['describe', 'patcher', 'x'.repeat(21)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/21 chars; max is 20/);
    expect((await run(['describe', 'patcher'])).err).toContain('no description set'); // nothing stored
  });

  test('the description round-trips through a later `add`', async () => {
    await run(['describe', 'patcher', 'the trigger']);
    await run(['add', 'patcher', 'a lesson']);
    expect((await run(['describe', 'patcher'])).out).toBe('the trigger\n');
  });

  test('an empty text operand clears the description', async () => {
    await run(['describe', 'patcher', 'temporary']);
    const clear = await run(['describe', 'patcher', '']);
    expect(clear.code).toBe(0);
    expect(clear.out).toContain('description cleared');
    expect((await run(['describe', 'patcher'])).err).toContain('no description set');
  });

  test('--json emits a structured result for both set and read', async () => {
    const set = await run(['describe', 'patcher', 'json trigger', '--json']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toEqual({ role: 'patcher', shelf: 'patcher', desc: 'json trigger', set: true });
    const get = await run(['describe', 'patcher', '--json']);
    expect(JSON.parse(get.out)).toEqual({ role: 'patcher', shelf: 'patcher', desc: 'json trigger', set: false });
  });

  test('describe set is recorded in the usage log with a described outcome', async () => {
    await run(['describe', 'patcher', 'logged trigger']);
    const rows = parseUsage(dir).filter((r) => r.command === 'describe');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)!.outcome).toBe('described');
    expect(rows.at(-1)!.ok).toBe(true);
  });

  // Issue #91: `describe` must strip `--reason`/`--note` before reading its text
  // operand, like the other mutating commands — otherwise an option placed before
  // the text is silently stored as the description (a DP-5 violation).
  test('a --reason before the text is stripped, never stored as the description', async () => {
    const set = await run(['describe', 'patcher', '--reason', 'other', 'real text']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('description set for shelf "patcher": real text');
    expect((await run(['describe', 'patcher'])).out).toBe('real text\n'); // the real text, not "--reason"
  });

  test('describe logs a stripped --reason/--note (bucketed to other, code kept in note)', async () => {
    await run(['describe', 'patcher', '--reason', 'triage', '--note', 'from a hook', 'the trigger']);
    const row = parseUsage(dir).filter((r) => r.command === 'describe').at(-1)!;
    expect(row.outcome).toBe('described');
    expect(row.reason).toBe('other'); // describe has no enum yet, so any code buckets to other
    expect(row.note).toBe('triage: from a hook'); // original code preserved for mining
  });

  test('--reason/--note after the text are also consumed, not treated as a second operand', async () => {
    const set = await run(['describe', 'patcher', 'the trigger', '--note', 'why']);
    expect(set.code).toBe(0);
    expect((await run(['describe', 'patcher'])).out).toBe('the trigger\n');
  });

  test('describe --reason without a value exits 1 (never silently dropped)', async () => {
    const r = await run(['describe', 'patcher', 'some text', '--reason']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--reason needs a value');
  });

  test('only a --reason and no text operand still reads, not sets (description stays unset)', async () => {
    const r = await run(['describe', 'patcher', '--reason', 'other']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('no description set for shelf "patcher"'); // read path, nothing stored
  });

  // Issue #190: `describe <shelf> -` reads the description from stdin, the same
  // escape hatch `add <shelf> -` offers — so an agent can pipe a long or
  // punctuation-heavy description without shell-quoting it.
  describe('describe <shelf> - reads the description from stdin (issue #190)', () => {
    test('happy path: a single piped line is stored as the description', async () => {
      // The acceptance criterion: `printf 'my trigger' | nb describe patcher -`.
      const r = await run(['describe', 'patcher', '-'], 'my trigger');
      expect(r.code).toBe(0);
      expect(r.out).toContain('description set for shelf "patcher": my trigger');
      expect(r.err).toBe('');
      expect((await run(['describe', 'patcher'])).out).toBe('my trigger\n'); // stored verbatim
    });

    test('a trailing newline is stripped, leaving the clean description', async () => {
      const r = await run(['describe', 'patcher', '-'], 'piped trigger\n');
      expect(r.code).toBe(0);
      expect((await run(['describe', 'patcher'])).out).toBe('piped trigger\n'); // no stray newline
    });

    test('multi-line stdin is REFUSED (exit 1) and nothing is stored, not flattened', async () => {
      // Same contract as `add -`: a one-line field must not silently absorb a
      // second piped line (sanitizeDesc would collapse the break into a space).
      const r = await run(['describe', 'patcher', '-'], 'line one\nline two\n');
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/multi-line/i);
      expect((await run(['describe', 'patcher'])).err).toContain('no description set'); // not stored
    });

    test('a lone-CR / CRLF multi-line is refused too, not flattened to a space', async () => {
      // `readOneLine` collapses \r like \n, so every line-ending convention must
      // trigger the same refusal — mirrors the `add -` CRLF test (issue #38).
      for (const raw of ['one\r\ntwo\r\n', 'alpha\rbeta']) {
        const r = await run(['describe', 'patcher', '-'], raw);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/multi-line/i);
      }
      expect((await run(['describe', 'patcher'])).err).toContain('no description set'); // none stored
    });

    test('--json composes with the stdin operand', async () => {
      // --json is stripped before positional parsing, so `-` is still args[2].
      const r = await run(['describe', 'patcher', '-', '--json'], 'json piped\n');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ role: 'patcher', shelf: 'patcher', desc: 'json piped', set: true });
    });

    test('empty stdin clears the description (an empty operand, same as `""`)', async () => {
      // Deliberate difference from `add -` (which skips an empty lesson, since a
      // notebook cannot hold an empty entry): an empty description is a valid
      // state, so piping nothing is an empty operand and clears — consistent with
      // `describe <shelf> ""`. Pinned so the choice is explicit, not accidental.
      await run(['describe', 'patcher', 'temporary']);
      const r = await run(['describe', 'patcher', '-'], '');
      expect(r.code).toBe(0);
      expect(r.out).toContain('description cleared');
      expect((await run(['describe', 'patcher'])).err).toContain('no description set');
    });

    test('the literal empty-string operand still clears (not confused with stdin)', async () => {
      await run(['describe', 'patcher', 'temporary']);
      const clear = await run(['describe', 'patcher', '']); // `""`, not `-`
      expect(clear.code).toBe(0);
      expect(clear.out).toContain('description cleared');
      expect((await run(['describe', 'patcher'])).err).toContain('no description set');
    });

    test('no operand still prints the current description (read path intact)', async () => {
      await run(['describe', 'patcher', 'the trigger']);
      const get = await run(['describe', 'patcher']);
      expect(get.code).toBe(0);
      expect(get.out).toBe('the trigger\n');
    });
  });
});

describe('nb search — the demoted keyword fallback (issue #82)', () => {
  test('groups hits by notebook and prints each lesson id so the agent can vote it later', async () => {
    await run(['add', 'reviewer', 'run the build before vitest']);
    await run(['add', 'patcher', 'build the sandbox image first']);
    const r = await run(['search', 'build']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('reviewer');
    expect(r.out).toContain('patcher');
    expect(r.out).toContain('run the build before vitest');
    // Each hit line leads with the entry's stable id, as `nb show` does.
    expect(r.out).toMatch(/^\s+[0-9a-f]{6}\s+\[\+1\]\s+run the build before vitest/m);
  });

  test('the output names itself the secondary path (surfacing is primary)', async () => {
    await run(['add', 'reviewer', 'a lesson about locks']);
    const r = await run(['search', 'locks']);
    expect(r.out.toLowerCase()).toContain('secondary');
  });

  test('an unreadable shelf is skipped and reported, not fatal (issue #332)', async () => {
    await run(['add', 'alpha', 'a lesson about lint']);
    await run(['add', 'beta', 'another lesson about lint']);
    mkdirSync(join(dir, 'weird.md'));
    const r = await run(['search', 'lint']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('alpha');
    expect(r.out).toContain('beta');
    expect(r.err).toContain('skipped shelf "weird"');
    expect(r.err).toContain('EISDIR');
  });

  test('a skip-caused no-match is not logged as a coverage gap (issue #332)', async () => {
    // A no-match that exists only because a shelf was skipped must not key the
    // `failed-search → add` gap-sensor (which pairs on outcome `no-match`).
    await run(['add', 'alpha', 'a lesson about lint']);
    mkdirSync(join(dir, 'weird.md'));
    await run(['search', 'nostringmatchesanywhere']);
    const row = parseUsage(dir).filter((r) => r.command === 'search').at(-1)!;
    expect(row.outcome).not.toBe('no-match');
    expect(row.outcome).toBe('skipped');
  });

  test('--json search omits skipped on a healthy store and includes it otherwise (issue #332)', async () => {
    await run(['add', 'alpha', 'a lesson about lint']);
    const healthy = JSON.parse((await run(['search', 'lint', '--json'])).out);
    expect(healthy).not.toHaveProperty('skipped');
    mkdirSync(join(dir, 'weird.md'));
    const damaged = JSON.parse((await run(['search', 'lint', '--json'])).out);
    expect(damaged.skipped).toEqual([{ shelf: 'weird', code: 'EISDIR' }]);
  });

  test('AND by default; --any switches to OR', async () => {
    await run(['add', 'reviewer', 'fresh worktree off origin main']);
    await run(['add', 'patcher', 'a mkdir spinlock guards the file']);
    const and = await run(['search', 'worktree spinlock']);
    expect(and.err).toContain('no lessons match'); // no single entry has both
    const or = await run(['search', 'worktree spinlock', '--any']);
    expect(or.code).toBe(0);
    expect(or.out).toContain('reviewer');
    expect(or.out).toContain('patcher');
  });

  test('a bare prefix operand scopes the search by shelf name', async () => {
    await run(['add', 'review.security', 'sanitize the lock input']);
    await run(['add', 'patcher', 'the lock is a spinlock']);
    const scoped = await run(['search', 'lock', 'review.']);
    expect(scoped.out).toContain('review.security');
    expect(scoped.out).not.toContain('\n  patcher');
  });

  test('a no-match search exits 0 (not an error), writes nothing to stdout, and notes the gap on stderr', async () => {
    await run(['add', 'reviewer', 'a stored lesson']);
    const r = await run(['search', 'absent-keyword']);
    expect(r.code).toBe(0); // found nothing is success, like a dedup-blocked add
    expect(r.out).toBe('');
    expect(r.err).toContain('no lessons match');
    expect(r.err.toLowerCase()).toContain('coverage gap');
  });

  test('--json emits the raw SearchResult', async () => {
    await run(['add', 'reviewer', 'run the build before vitest']);
    const r = await run(['search', 'vitest', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.terms).toEqual(['vitest']);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].shelf).toBe('reviewer');
    expect(parsed.groups[0].hits[0].id).toBe(entryId('run the build before vitest'));
  });

  describe("a long shelf description doesn't blow out the group line (issue #211)", () => {
    const longDesc = 'A'.repeat(100) + 'B'.repeat(100); // 200 chars, over the 80-col cap

    // Pin the Unicode ellipsis so the assertion doesn't flake under a non-UTF-8
    // host locale (NB_ASCII unset + LANG=C would flip asciiMode() to `...`).
    let prevAscii: string | undefined;
    beforeEach(() => {
      prevAscii = process.env.NB_ASCII;
      process.env.NB_ASCII = '0';
    });
    afterEach(() => {
      if (prevAscii === undefined) delete process.env.NB_ASCII;
      else process.env.NB_ASCII = prevAscii;
    });

    test('the human shelf line ellipsizes the description', async () => {
      await run(['add', 'reviewer', 'findme marker lesson']);
      await run(['describe', 'reviewer', longDesc]);
      const r = await run(['search', 'findme']);
      expect(r.code).toBe(0);
      const shelfLine = r.out.split('\n').find((l) => l.includes('reviewer'))!;
      expect(shelfLine).toContain('A'.repeat(79) + '…');
      expect(shelfLine).not.toContain('A'.repeat(80)); // reject a width+1 blowout (A×80 + '…')
      expect(shelfLine).not.toContain('B');
    });

    test('--json still emits the full, untruncated shelf description', async () => {
      await run(['add', 'reviewer', 'findme marker lesson']);
      await run(['describe', 'reviewer', longDesc]);
      const r = await run(['search', 'findme', '--json']);
      const parsed = JSON.parse(r.out);
      expect(parsed.groups[0].desc).toBe(longDesc); // all 200 chars, nothing clipped
    });
  });

  test('--limit N bounds the printed notebook groups and the header reads "N of total" (issue #186)', async () => {
    await run(['add', 'aaa', 'the lock is held']);
    await run(['add', 'bbb', 'release the lock']);
    await run(['add', 'ccc', 'lock contention']);
    const r = await run(['search', 'lock', '--limit', '2']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('in 2 of 3 notebooks'); // capped, and says so
    expect(r.out).toContain('aaa'); // top-2 by the deterministic ranking
    expect(r.out).toContain('bbb');
    expect(r.out).not.toContain('\n  ccc'); // the third group is elided
  });

  test('--limit never turns a real match into a no-match gap, and surfaced ids stay full (#186, #114)', async () => {
    await run(['add', 'aaa', 'the lock is held']);
    await run(['add', 'bbb', 'release the lock']);
    await run(['add', 'ccc', 'lock contention']);
    // A limit smaller than the match count — even 0 — must still log a `match`.
    await run(['search', 'lock', '--limit', '0']);
    const row = parseUsage(dir).filter((x) => x.command === 'search').at(-1)!;
    expect(row.outcome).toBe('match'); // the gap-sensor is computed on the FULL result
    expect(row.entries.sort()).toEqual(
      [entryId('the lock is held'), entryId('release the lock'), entryId('lock contention')].sort(),
    );
  });

  test('--limit 0 that hides a real match reports "matched but hidden", NOT a coverage gap', async () => {
    await run(['add', 'reviewer', 'a lesson about locks']);
    const r = await run(['search', 'locks', '--limit', '0']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(''); // nothing printed — all groups hidden
    // The stderr note must NOT emit the real gap message (it WAS a match, logged as `match`).
    expect(r.err).not.toContain('recorded as a possible coverage gap');
    expect(r.err).toMatch(/1 notebook match(es)? "locks".*but --limit hid them all/);
  });

  test('--json reflects the bounded group set while total/surfacedIds stay on the full result (issue #186)', async () => {
    await run(['add', 'aaa', 'the lock is held']);
    await run(['add', 'bbb', 'release the lock']);
    await run(['add', 'ccc', 'lock contention']);
    const r = await run(['search', 'lock', '--limit', '1', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.groups).toHaveLength(1); // bounded
    expect(parsed.total).toBe(3); // full match count
    expect(parsed.surfacedIds).toHaveLength(3); // full provenance
  });

  test('an unparseable --limit warns on stderr and falls back to the default (like `list`)', async () => {
    await run(['add', 'reviewer', 'a lesson about locks']);
    const r = await run(['search', 'locks', '--limit', 'abc']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/unrecognized --limit 'abc'.*showing 50/); // names the default it fell back to
    expect(r.out).toContain('reviewer'); // still shown with the default bound
  });

  test('--limit composes with --any and a positional prefix without being read as the prefix', async () => {
    await run(['add', 'review.security', 'sanitize the lock input']);
    await run(['add', 'review.perf', 'cache the lock lookup']);
    await run(['add', 'patcher', 'the lock is a spinlock']);
    const r = await run(['search', 'lock', 'review.', '--any', '--limit', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('in 1 of 2 notebooks'); // scoped to review.*, then bounded to 1
    expect(r.out).not.toContain('patcher'); // prefix still scoped, not swallowed by --limit
  });

  test('the search is logged with a match/no-match outcome and the query in note (the gap-sensor row)', async () => {
    await run(['add', 'reviewer', 'a lesson about caching']);
    await run(['search', 'caching']);
    await run(['search', 'nothing-here']);
    const rows = parseUsage(dir).filter((r) => r.command === 'search');
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('match');
    expect(rows[0].note).toBe('caching');
    expect(rows[1].outcome).toBe('no-match');
    expect(rows[1].note).toBe('nothing-here');
    expect(rows[0].role).toBe('-'); // spans notebooks, like `list`
  });

  test('a missing query argument is a handled error (exit 1)', async () => {
    const r = await run(['search']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <query>');
  });

  test('a whitespace-only query logs no-terms (not no-match), so it is never a false coverage gap', async () => {
    process.env.NB_SESSION = 'cli-blank';
    const r = await run(['search', '   ']);
    expect(r.code).toBe(0);
    const row = parseUsage(dir).filter((x) => x.command === 'search').at(-1)!;
    expect(row.outcome).toBe('no-terms'); // not 'no-match' — the gap-sensor keys on no-match
    // A following add in the same session must NOT be flagged as a failed-search gap.
    await run(['add', 'reviewer', 'a lesson added after an empty search']);
    await run(['vote', 'reviewer', 'added after', '+1']);
    const stats = await run(['stats', '--json']);
    const signals = JSON.parse(stats.out).signals as { kind: string }[];
    expect(signals.some((s) => s.kind === 'failed-search')).toBe(false);
  });

  test('end-to-end: a failed CLI search then an add in the same session surfaces a failed-search signal', async () => {
    process.env.NB_SESSION = 'cli-gap';
    await run(['search', 'retry backoff']); // no notebooks yet → no-match
    await run(['add', 'reviewer', 'use exponential backoff on retries']);
    await run(['vote', 'reviewer', 'backoff', '+1']); // engagement, and exercises the normal path
    const stats = await run(['stats', '--json']);
    const report = JSON.parse(stats.out);
    const gap = report.signals.find((s: { kind: string }) => s.kind === 'failed-search');
    expect(gap).toBeDefined();
    expect(gap.shelf).toBe('reviewer');
    expect(gap.detail).toContain('retry backoff');
  });
});

describe('shelf terminology (role kept as a deprecated alias)', () => {
  test('show/list/search/stats --json carry `shelf` equal to the deprecated `role`', async () => {
    await run(['add', 'reviewer', 'check the lock file']);
    await run(['describe', 'reviewer', 'when reviewing']);

    const show = JSON.parse((await run(['show', 'reviewer', '--json'])).out);
    expect(show.shelf).toBe('reviewer');
    expect(show.shelf).toBe(show.role);

    const list = JSON.parse((await run(['list', '--json'])).out);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].shelf).toBe(list.rows[0].role);
    expect(list.rows[0].shelf).toBe('reviewer');

    const search = JSON.parse((await run(['search', 'lock', '--json'])).out);
    expect(search.groups).toHaveLength(1);
    expect(search.groups[0].shelf).toBe(search.groups[0].role);
    expect(search.groups[0].shelf).toBe('reviewer');

    const st = JSON.parse((await run(['stats', '--json'])).out);
    expect(st.notebooks).toHaveLength(1);
    expect(st.notebooks[0].shelf).toBe(st.notebooks[0].role);
    expect(st.notebooks[0].shelf).toBe('reviewer');
    expect(st.notebookTotals.shelves).toBe(st.notebookTotals.roles);
    expect(st.notebookTotals.shelves).toBe(1);
  });

  test('`nb shelves` and `nb roles` print exactly what `nb list` prints', async () => {
    await run(['add', 'reviewer', 'a lesson']);
    await run(['add', 'patcher', 'another lesson']);
    const list = await run(['list']);
    const shelves = await run(['shelves']);
    const roles = await run(['roles']);
    expect(shelves.code).toBe(0);
    expect(shelves.out).toBe(list.out);
    expect(roles.out).toBe(list.out);
    expect(list.out).toContain('reviewer');
    const json = await run(['shelves', '--json']);
    expect(JSON.parse(json.out)).toEqual(JSON.parse((await run(['list', '--json'])).out));
  });

  test('help documents <shelf> and `nb shelves`, not <role>', async () => {
    const r = await run(['--help']);
    expect(r.out).toContain('<shelf>');
    expect(r.out).toContain('nb shelves');
    expect(r.out).not.toContain('<role>');
  });

  // Issue #140: "role" was removed in favour of "shelf", but the guard above
  // only covers the rendered --help. These two assert the other two user-facing
  // surfaces the issue names — README.md and the cli.ts SOURCE (its command
  // comments and storage-path line) — so the old vocabulary cannot silently
  // return there either. They forbid the live `<role>` placeholder and the
  // `<role>.md` storage path, NOT the bare word "role": a surviving `role`/
  // `roles`/`listRoles` mention is allowed only as an explicitly-labelled
  // deprecated alias, exactly as the acceptance criteria permit.
  test('README teaches <shelf> as the live command vocabulary, never the removed <role> (issue #140)', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/nb show\s+<shelf>/); // the Usage block uses <shelf>
    expect(readme).toContain('notebooks/<shelf>.md'); // and the storage path
    expect(readme).not.toContain('<role>'); // the removed placeholder never returns
    expect(readme).not.toContain('<role>.md'); // nor the old storage path
  });

  test('the cli.ts source — command comments and storage-path line — uses <shelf>, never <role> (issue #140)', () => {
    const cliSrc = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
    expect(cliSrc).toContain('notebooks/<shelf>.md'); // the storage-path line
    expect(cliSrc).not.toContain('<role>'); // no <role> in comments, HELP, or anywhere in source
  });

  // Issue #139: the README's one-line "who this is for" must stay consistent
  // in-product. Guard the rendered --help AND the README source so the shared
  // developer-audience description cannot silently drift out of either surface.
  // Two separate tests isolate each surface — a single combined check could let
  // one surface regress undetected (the notebook's mutation-robustness lesson).
  const AUDIENCE_LINE =
    'developers who run AI agents and want them to carry a few durable lessons across runs';

  test('help echoes the README developer-audience one-liner (issue #139)', async () => {
    const r = await run(['--help']);
    expect(r.out).toContain(AUDIENCE_LINE);
  });

  test('README states the developer-audience one-liner that --help echoes (issue #139)', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain(AUDIENCE_LINE);
  });

  // Issue #167: the README 'Programmatic use' snippet is the only API surface a
  // library consumer reads. It omitted `move` (a headline score-preserving
  // feature, #103) and the description/showJson/stats API, so those real exports
  // were invisible to docs readers and invited re-implementing add+rm (which
  // loses score). Guard each one inside the Programmatic-use fenced block so it
  // can't silently fall out again — assert the demonstrated *call*, not just the
  // word, so an incidental mention elsewhere doesn't satisfy the check.
  test('README Programmatic use demonstrates move/describe/showJson/stats (issue #167)', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const block = /## Programmatic use\n\n```ts\n([\s\S]*?)\n```/.exec(readme);
    expect(block).not.toBeNull();
    const snippet = block![1];
    for (const call of [
      'await move(dir,',
      'await setDescription(dir,',
      'getDescription(dir,',
      'showJson(dir,',
      'stats(dir,',
    ]) {
      expect(snippet).toContain(call);
    }
    // ...and they are imported from the package, not just called.
    for (const sym of ['move', 'setDescription', 'getDescription', 'showJson', 'stats']) {
      expect(snippet).toMatch(new RegExp(`^\\s*${sym},\\s*$`, 'm'));
    }
  });

  test('help states the line cap as 50 (matching maxLines and the README), not the stale 200 (issue #116)', async () => {
    const r = await run(['--help']);
    expect(r.out).toContain('at most 50 lines');
    expect(r.out).not.toContain('at most 200 lines');
  });

  test('help lists failed-search alongside the other three diagnostic signals (issue #116)', async () => {
    const r = await run(['--help']);
    // All four signals `nb stats` emits are documented...
    for (const kind of ['browse-without-use', 'eviction-while-still-voted', 'vote-reversal', 'failed-search']) {
      expect(r.out).toContain(kind);
    }
    // ...and failed-search is listed in the diagnostic-signals bullet itself, not only in the
    // `nb search` description where the token already appeared. Pin the specific entry text.
    expect(r.out).toContain('and failed-search (a search returned nothing');
  });
});

// Issue #131: the HELP constant is hand-maintained and must stay in sync with
// the command dispatch switch. Issue #116 was exactly this drift (help said cap
// 200 when it was 50, and omitted a signal). The point-check help tests above
// assert specific tokens reactively; none asserts that the FULL command set is
// documented, so a newly-added command that forgets its HELP line would ship
// undocumented with no failing test. These guards derive BOTH sets
// programmatically — the dispatched commands from the `switch (cmd)` block in
// the cli.ts source, the documented commands from the rendered `nb --help`
// usage block — and assert they cover the same command set, in BOTH directions,
// so the NEXT command that forgets its help entry (or a help line with no
// dispatch) turns the suite red. Matching is on the command TOKEN, not exact
// phrasing, so wording/alignment changes to HELP never make the guard brittle.
describe('HELP ↔ dispatch drift guard (issue #131)', () => {
  // Read the SOURCE, mirroring the issue-#140 terminology guards above, because
  // the command set is not enumerable at runtime.
  const cliSrc = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');

  // cli.ts has exactly ONE `switch` — the command dispatch (`switch (cmd)`) — so
  // every `case` label in the file is a dispatched command. That invariant is
  // what makes "scan every case label" a sound way to enumerate the switch; it
  // is pinned by its own test below, so a second switch added later fails loudly
  // and forces this guard to be revisited rather than silently miscounting.
  const switchCount = [...cliSrc.matchAll(/\bswitch\s*\(/g)].length;

  // Dispatched command set = the `case '<cmd>':` labels (aliases included:
  // list/ls/shelves/roles). Quote-agnostic (', ", or `) so a case written with a
  // different quote style is still captured and still required to be documented.
  const dispatched = [...cliSrc.matchAll(/case\s+(['"`])([^'"`]+)\1\s*:/g)].map((m) => m[2]);
  const dispatchedSet = new Set(dispatched);

  // A few commands are dispatched by `if (cmd === '…')` BEFORE the switch
  // (`--help`/`--version` and their short aliases). Scan just that early-exit
  // region (from the `cmd` binding to the `notebooksDir()` call) so a NEW
  // pre-switch command cannot slip past the guard merely by not being a switch
  // case — the #116-class drift the issue targets is "a dispatched command with
  // no HELP line", regardless of HOW it is dispatched.
  const fnStart = cliSrc.indexOf('const cmd = (argv[0]');
  const preSwitchRegion = cliSrc.slice(
    fnStart,
    cliSrc.indexOf('const dir = notebooksDir()', fnStart),
  );
  const preSwitchCmds = [...preSwitchRegion.matchAll(/cmd === '([^']+)'/g)].map((m) => m[1]);
  // The short aliases HELP deliberately omits — the long `--help`/`--version`
  // are the documented forms. Listed explicitly so a NEW pre-switch command is
  // never silently waved through: it must be documented, or added here on purpose.
  const UNDOCUMENTED_PRESWITCH_ALIASES = new Set(['-h', 'help', '-v', 'version']);

  // Documented command set = the first token after `nb` on each line of the
  // rendered `nb --help` usage block (sliced at the `notes:` section so prose
  // mentions of commands are never parsed as usage). The non-emptiness
  // assertions stop a parser regression from letting the guards pass vacuously.
  async function documentedTokens(): Promise<string[]> {
    const out = (await run(['--help'])).out;
    const start = out.indexOf('usage:');
    expect(start).not.toBe(-1); // there must be a usage block, else parsing is vacuous
    const notes = out.indexOf('notes:');
    const usage = out.slice(start, notes === -1 ? out.length : notes);
    // Only usage lines begin (after indentation) with `nb`; note lines start
    // with `- ` or a backtick, so this anchored match captures usage tokens only.
    const tokens = [...usage.matchAll(/^\s+nb\s+(\S+)/gm)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0); // never let an empty parse pass vacuously
    return tokens;
  }

  test('cli.ts has exactly one command-dispatch switch, with no duplicate case labels', () => {
    // The invariant the `case`-scan relies on; a second switch must revisit this guard.
    expect(switchCount).toBe(1);
    expect(dispatched.length).toBe(dispatchedSet.size);
  });

  test('every dispatched command is documented in HELP (a new command without a HELP line fails this)', async () => {
    const documented = new Set(await documentedTokens());
    // Named per-command so a failure says exactly which command lost its help line.
    const undocumented = dispatched.filter((cmd) => !documented.has(cmd));
    expect(undocumented).toEqual([]);
  });

  test('every subcommand documented in HELP is actually dispatched (no phantom help line)', async () => {
    // A `-`-prefixed token is a flag (checked separately), not a word subcommand.
    const documentedSubcommands = (await documentedTokens()).filter((t) => !t.startsWith('-'));
    const undispatched = documentedSubcommands.filter((cmd) => !dispatchedSet.has(cmd));
    expect(undispatched).toEqual([]);
  });

  test('every pre-switch command (`--help`/`--version` & aliases) is documented or a known omitted alias', async () => {
    const documented = new Set(await documentedTokens());
    expect(preSwitchCmds.length).toBeGreaterThan(0); // the region must still parse
    const orphans = preSwitchCmds.filter(
      (cmd) => !documented.has(cmd) && !UNDOCUMENTED_PRESWITCH_ALIASES.has(cmd),
    );
    expect(orphans).toEqual([]);
  });

  // The spec (docs/requirements.md FR-CLI-001) is the authoritative command
  // list, so it must name every dispatched command too (issue #340). Matches on
  // command NAMES as whole tokens within the FR-CLI-001 paragraph, not prose.
  test('every dispatched command is named in the FR-CLI-001 paragraph of requirements.md', () => {
    const spec = readFileSync(join(REPO_ROOT, 'docs', 'requirements.md'), 'utf8');
    const start = spec.indexOf('**FR-CLI-001');
    expect(start).not.toBe(-1);
    const end = spec.indexOf('<a id="fr-cli-002">', start);
    expect(end).toBeGreaterThan(start);
    const para = spec.slice(start, end);
    const missing = dispatched.filter(
      (cmd) => !new RegExp('(^|[^\\w-])' + cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])').test(para),
    );
    expect(missing).toEqual([]);
  });

  // Anti-vacuous-pass anchor: if the `case` parser silently returned an empty set
  // the equality guards above could pass trivially, so pin that the derived
  // dispatched set actually captured the full known current command set
  // (show/add/vote/merge/split/rm/move/describe/search/stats/path/list + the list
  // aliases). New commands only grow this set, so the `toContain` floor stays
  // green as commands evolve — it asserts coverage, not an exact ceiling.
  test('the derived dispatched set covers the full known current command set', () => {
    for (const cmd of [
      'show', 'add', 'vote', 'merge', 'split', 'rm', 'move',
      'describe', 'search', 'stats', 'path', 'list', 'ls', 'shelves', 'roles',
    ]) {
      expect(dispatched).toContain(cmd);
    }
  });

  // The flag "commands" HELP documents (`nb --help`, `nb --version`) are
  // dispatched before the switch, not as cases, so the subcommand guards skip
  // them. Assert the long forms are present and that EVERY documented flag is a
  // real, working entrypoint (exit 0) — a phantom `nb --bogus` help line would
  // hit the unknown-command default and exit 2, so this also guards the reverse
  // direction for flags without pinning an exact, brittle flag set.
  test('every documented flag command is a real working entrypoint', async () => {
    const flags = (await documentedTokens()).filter((t) => t.startsWith('-'));
    expect(flags).toContain('--help');
    expect(flags).toContain('--version');
    for (const flag of flags) {
      expect((await run([flag])).code).toBe(0);
    }
  });
});

describe('closestCommand (did-you-mean, issue #171)', () => {
  test('a one-edit typo resolves to the nearest command', () => {
    expect(closestCommand('stat')).toBe('stats'); // insertion
    expect(closestCommand('lis')).toBe('list'); // deletion; canonical beats `ls` alias
    expect(closestCommand('serach')).toBe('search'); // transposition (two edits)
    expect(closestCommand('mov')).toBe('move');
    expect(closestCommand('desribe')).toBe('describe');
  });

  test('the prefix branch resolves an abbreviation only at >= 3 chars (past the edit budget)', () => {
    // `desc`/`sea` are too far for an edit-distance match, so ONLY the prefix
    // branch can resolve them — which pins that it fires at all.
    expect(closestCommand('desc')).toBe('describe'); // 4 chars, clean prefix of `describe`
    expect(closestCommand('sea')).toBe('search'); // 3 chars (edit distance 3) — the inclusive boundary
    // A 2-char prefix of real commands (`show`/`shelves`) must NOT resolve: it
    // is below the length gate AND too far for an edit match. This pins `>= 3`
    // against a loosening mutation (e.g. `>= 1`), which would wrongly yield `show`.
    expect(closestCommand('sh')).toBeUndefined();
  });

  test('a far-off or too-short input yields no suggestion', () => {
    expect(closestCommand('frobnicate')).toBeUndefined();
    expect(closestCommand('xyzzy')).toBeUndefined();
    expect(closestCommand('')).toBeUndefined();
    expect(closestCommand('x')).toBeUndefined(); // a lone char must not match a 2-letter alias
  });

  test('an exact command is not "suggested" as a correction of itself', () => {
    // A known command short-circuits to undefined (it is not a typo to recover
    // from, and never reaches the unknown-command path anyway).
    expect(closestCommand('stats')).toBeUndefined();
  });

  // Drift guard: the suggestion table must stay in sync with the dispatch, or a
  // newly added command would silently never be suggested. Mirror the source
  // scan the HELP-drift guard uses to enumerate dispatched commands.
  test('KNOWN_COMMANDS covers every dispatched command', () => {
    const cliSrc = readFileSync(join(REPO_ROOT, 'src', 'cli.ts'), 'utf8');
    const dispatched = [...cliSrc.matchAll(/case\s+(['"`])([^'"`]+)\1\s*:/g)].map((m) => m[2]);
    expect(dispatched.length).toBeGreaterThan(0); // never pass vacuously
    const known = new Set<string>(KNOWN_COMMANDS);
    const missing = dispatched.filter((cmd) => !known.has(cmd));
    expect(missing).toEqual([]);
  });

  test('every KNOWN_COMMANDS entry is a real entrypoint (not a phantom)', async () => {
    // A word command that is NOT dispatched would hit the unknown-command
    // default and exit 2; a real one never does. `help`/`version` are the
    // pre-switch word forms, also real entrypoints.
    for (const cmd of KNOWN_COMMANDS) {
      expect((await run([cmd])).code).not.toBe(2);
    }
  });
});

describe('closestShelf (shelf did-you-mean, issue #200)', () => {
  test('a one-edit typo resolves to the nearest existing shelf', () => {
    expect(closestShelf('reviewr', ['patcher', 'reviewer'])).toBe('reviewer'); // deletion
    expect(closestShelf('patchr', ['patcher', 'reviewer'])).toBe('patcher'); // deletion
    expect(closestShelf('ptacher', ['patcher', 'reviewer'])).toBe('patcher'); // transposition (two edits)
  });

  test('the prefix branch resolves an abbreviation only at >= 3 chars', () => {
    // `rev` is too far for an edit-distance match (distance 5 to `reviewer`), so
    // ONLY the prefix branch can resolve it — pinning that the branch fires.
    expect(closestShelf('rev', ['reviewer', 'patcher'])).toBe('reviewer');
    // A 2-char input is below the length gate AND too far for an edit match, so
    // it must NOT resolve — guards `>= 3` against a loosening mutation (`>= 1`),
    // which would wrongly yield `reviewer` from its `re` prefix.
    expect(closestShelf('re', ['reviewer', 'patcher'])).toBeUndefined();
  });

  test('a far-off, too-short, or empty-set input yields no suggestion', () => {
    expect(closestShelf('frobnicate', ['patcher', 'reviewer'])).toBeUndefined();
    expect(closestShelf('x', ['ab', 'cd'])).toBeUndefined(); // a lone char must not match
    expect(closestShelf('anything', [])).toBeUndefined(); // no shelves exist yet
    expect(closestShelf('', ['patcher'])).toBeUndefined();
  });

  test('the edit-distance budget is capped at <= 2 — a distance-3 input does not resolve', () => {
    // `reviewing` is edit distance 3 from `reviewer` (long enough that the
    // length-swamp guard passes) and is NOT a prefix of any candidate, so ONLY
    // the `<= 2` gate can reject it. This pins the UPPER bound against a
    // loosening mutation (`<= 2` → `<= 3`), which would wrongly yield `reviewer`.
    // Mirrors the prefix-branch negative above, applied to the Levenshtein branch.
    expect(closestShelf('reviewing', ['patcher', 'reviewer'])).toBeUndefined();
  });

  test('a match whose distance equals the input length does not resolve (length-swamp guard)', () => {
    // `xy` is edit distance 2 from both `ab` and `cd` — i.e. distance === length.
    // The strict `bestDist < needle.length` guard must reject it; this pins that
    // strict `<` against a `<=` mutation, which would wrongly yield `ab`.
    expect(closestShelf('xy', ['ab', 'cd'])).toBeUndefined();
  });

  test('an existing shelf name is not "suggested" as a correction of itself', () => {
    expect(closestShelf('patcher', ['patcher', 'reviewer'])).toBeUndefined();
  });

  test('ties resolve to the earlier (already sorted) candidate', () => {
    // `listShelves` returns a sorted list; `ax` sits one edit from both `aa` and
    // `az`, and the strict `<` keeps the first — so the suggestion is stable.
    expect(closestShelf('ax', ['aa', 'az'])).toBe('aa');
  });
});

// Issue #200 — a mutation (vote/rm/split/move) on a shelf that was never created
// must read as a typo ("no notebook"), with a nearest-shelf did-you-mean, NOT as
// a real empty notebook ("is empty"). It extends the #166 exists-vs-empty split
// (previously `show`-only) to the mutating commands, reusing the #171
// closest-match pattern over shelf names.
describe('mutations distinguish a missing shelf from an empty one (issue #200)', () => {
  test('vote on a never-created shelf says "no notebook", not "is empty", and exits 1', async () => {
    const r = await run(['vote', 'missingshelf', 'x', '+1']);
    expect(r.code).toBe(1); // a mutation on nothing is still an error (unlike read-only `show`)
    expect(r.err).toContain('no notebook for shelf "missingshelf"');
    expect(r.err).not.toContain('is empty'); // the misleading message is gone
  });

  test('vote names the nearest existing shelf when one is close (did-you-mean)', async () => {
    await run(['add', 'patcher', 'prefer execFileSync, array args']); // a real shelf to be near
    const r = await run(['vote', 'pather', 'x', '+1']); // typo of `patcher`
    expect(r.code).toBe(1);
    expect(r.err).toContain('no notebook for shelf "pather"');
    expect(r.err).toContain('did you mean "patcher"?');
  });

  test('no shelf is suggested when none is close — the reader is pointed at `nb list`', async () => {
    await run(['add', 'patcher', 'some lesson']); // exists but nowhere near the typo
    const r = await run(['vote', 'zzzzzz', 'x', '+1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no notebook for shelf "zzzzzz"');
    expect(r.err).not.toContain('did you mean');
    expect(r.err).toContain('nb list'); // still points the reader at how to find real shelves
  });

  test('an existing-but-empty shelf still reports "is empty" — the #166 distinction preserved', async () => {
    await run(['describe', 'drafts', 'where half-baked lessons go']); // creates the file, no lessons
    const r = await run(['vote', 'drafts', 'x', '+1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('notebook for shelf "drafts" is empty'); // the core empty throw still fires
    expect(r.err).not.toContain('no notebook for shelf'); // NOT the missing-shelf path
  });

  test('rm/split/move on an existing-but-empty shelf also still report "is empty", not "no notebook"', async () => {
    // The guard is shared, but pin every command so a future change that wrongly
    // intercepted an existing-empty shelf for rm/split/move (not just vote) is
    // caught. Each must fall through to the core "is empty" throw.
    await run(['describe', 'drafts', 'where half-baked lessons go']); // existing file, no lessons
    for (const argv of [
      ['rm', 'drafts', 'x'],
      ['split', 'drafts', 'x', 'half one', 'half two'],
      ['move', 'drafts', 'target', 'x'], // `drafts` is the (empty) SOURCE
    ]) {
      const r = await run(argv);
      expect(r.code).toBe(1);
      expect(r.err).toContain('is empty'); // core empty throw, not the missing-shelf path
      expect(r.err).not.toContain('no notebook for shelf');
    }
  });

  test('rm and split on a never-created shelf take the same "no notebook" path', async () => {
    const rm = await run(['rm', 'missingshelf', 'x']);
    expect(rm.code).toBe(1);
    expect(rm.err).toContain('no notebook for shelf "missingshelf"');
    expect(rm.err).not.toContain('is empty');

    const split = await run(['split', 'missingshelf', 'x', 'half one', 'half two']);
    expect(split.code).toBe(1);
    expect(split.err).toContain('no notebook for shelf "missingshelf"');
    expect(split.err).not.toContain('is empty');
  });

  test('move guards the SOURCE shelf (never-created) but still auto-creates a new target', async () => {
    // Missing source → the typo path.
    const missingSrc = await run(['move', 'missingsrc', 'target', 'x']);
    expect(missingSrc.code).toBe(1);
    expect(missingSrc.err).toContain('no notebook for shelf "missingsrc"');
    expect(missingSrc.err).not.toContain('is empty');

    // A real source + a never-created target still succeeds: move creates the
    // target like `add`, so the guard must NOT block a missing target.
    await run(['add', 'patcher', 'relocate me']);
    const ok = await run(['move', 'patcher', 'brandnewtarget', 'relocate me']);
    expect(ok.code).toBe(0);
    expect((await run(['show', 'brandnewtarget'])).out).toContain('relocate me');
  });

  test('a real-shelf mutation is unaffected — the guard only fires on a missing shelf', async () => {
    await run(['add', 'patcher', 'alpha lesson']);
    const r = await run(['vote', 'patcher', 'alpha', '+1']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[+2] alpha lesson'); // vote landed and scored, exactly as before
    expect(r.err).toBe('');
  });
});

// Issue #341: `stats` takes a shelf operand but (unlike the mutations, #200, and
// `show`, #166) never validated it, so a typo produced a plausible, empty report
// indistinguishable from a real shelf with no recent activity — a wrong
// conclusion in a command meant to surface unused shelves. The fix is advisory
// only: one stderr note (with a did-you-mean when close), stdout/exit unchanged.
describe('stats names a shelf that does not exist (issue #341)', () => {
  test('a typo prints a did-you-mean stderr note while stdout stays the normal report', async () => {
    await run(['add', 'patcher', 'some lesson']); // a real shelf to be near
    const r = await run(['stats', 'pather']); // typo of `patcher`
    expect(r.code).toBe(0); // advisory only — never an error
    expect(r.err).toContain('nb stats: no shelf named "pather"');
    expect(r.err).toContain('did you mean "patcher"?');
    // stdout is byte-identical to today: the report still renders normally.
    expect(r.out).toContain('nb usage — shelf pather, window 7d');
  });

  test('no suggestion when no shelf is close, but the missing-shelf note still prints', async () => {
    await run(['add', 'patcher', 'some lesson']);
    const r = await run(['stats', 'zzzzzz']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('nb stats: no shelf named "zzzzzz"');
    expect(r.err).not.toContain('did you mean');
  });

  test('an existing shelf prints no note', async () => {
    await run(['add', 'patcher', 'some lesson']);
    const r = await run(['stats', 'patcher']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  test('a retired shelf with historical rows is not flagged (only "no rows" is a typo signal)', async () => {
    await run(['add', 'retired', 'an old lesson']); // leaves a usage row under `retired`
    rmSync(join(dir, 'retired.md')); // shelf file removed, history remains
    const r = await run(['stats', 'retired']);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('no shelf named');
    expect(r.out).toContain('nb usage — shelf retired'); // historical call is still reported
  });

  test('the note repeats on every `stats <typo>` call, not just the first (stats logs its own row)', async () => {
    await run(['add', 'patcher', 'some lesson']);
    for (let i = 0; i < 3; i++) {
      const r = await run(['stats', 'pather']);
      expect(r.code).toBe(0);
      expect(r.err).toContain('nb stats: no shelf named "pather" — did you mean "patcher"?');
    }
  });

  test('a retired shelf still gets no note after repeated stats calls', async () => {
    await run(['add', 'retired', 'an old lesson']);
    rmSync(join(dir, 'retired.md'));
    for (let i = 0; i < 3; i++) {
      const r = await run(['stats', 'retired']);
      expect(r.err).not.toContain('no shelf named');
    }
  });

  test('--json stdout stays a single valid StatsReport object while the note goes to stderr', async () => {
    await run(['add', 'patcher', 'some lesson']);
    const r = await run(['stats', 'pather', '--json']);
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out) as { window: string; totalCalls: number };
    expect(rep.window).toBe('7d');
    expect(typeof rep.totalCalls).toBe('number');
    expect(r.err).toContain('nb stats: no shelf named "pather"');
  });
});

// Issue #335: lessons and descriptions are free text printed to a terminal and
// injected into agent context, so no raw control / bidi / zero-width byte may reach
// stdout from `show`, `list` or `search` — including from a shelf file written
// before the sanitizer existed.
describe('printed output carries no raw control bytes (issue #335)', () => {
  // eslint-disable-next-line no-control-regex
  const bad = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;

  test('show/list/search never print an ESC, even for a pre-existing shelf file', async () => {
    await run(['add', 's', 'ansi \u001b[31mred\u001b[0m \u001b]0;title\u0007 injected']);
    await run(['describe', 's', 'desc \u001b[31mred']);
    writeFileSync(join(dir, 'old.md'), '+1\tlegacy \u001b[31mred\u001b[0m \u200bz\u202ew line\n', 'utf-8');
    for (const args of [['show', 's'], ['show', 'old'], ['list'], ['search', 'red'], ['show', 'old', '--json']]) {
      const r = await run(args);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(bad);
      expect(r.err).not.toMatch(bad);
    }
    expect((await run(['show', 'old'])).out).toContain('legacy [31mred[0m zw line');
  });
});

// Issue #187: `nb completion <bash|zsh>` prints a static, dependency-free
// completion script. These guard the acceptance criteria — each shell prints a
// valid, sourceable script and exits 0; the script completes the known command
// set; the shipped examples/completion/ scripts never drift from the emitter;
// and no runtime dependency is introduced.
describe('nb completion (shell completion, issue #187)', () => {
  // `<shell> -n` is a parse-only (no-exec) syntax check reading the script from
  // stdin. It proves the emitted script is actually sourceable, not just
  // non-empty. Guarded on the shell being present so the suite stays green on a
  // host without zsh (and, defensively, without bash).
  function shellPresent(shell: string): boolean {
    try {
      execFileSync(shell, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  test('bash: prints a sourceable script and exits 0', async () => {
    const r = await run(['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.err).toBe(''); // clean stdout-only emission
    // The registration line is what makes it a completion script, not just text.
    expect(r.out).toContain('complete -F _nb_complete nb');
    expect(r.out).toContain('compgen -W');
    if (shellPresent('bash')) {
      // `bash -n` throws (non-zero exit) on any syntax error.
      expect(() => execFileSync('bash', ['-n'], { input: r.out })).not.toThrow();
    }
  });

  test('zsh: prints a sourceable script and exits 0', async () => {
    const r = await run(['completion', 'zsh']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out.startsWith('#compdef nb')).toBe(true);
    expect(r.out).toContain('compdef _nb nb');
    // Dual-mode guard so a file installed on $fpath as `_nb` also works, not just
    // the `eval`/source path (funcstack idiom).
    expect(r.out).toContain('funcstack[1]');
    if (shellPresent('zsh')) {
      expect(() => execFileSync('zsh', ['-n'], { input: r.out })).not.toThrow();
    }
  });

  test('the completion script completes the full known command set', async () => {
    const out = (await run(['completion', 'bash'])).out;
    // Every dispatched/known command must be offerable at the subcommand
    // position, so a new command added to KNOWN_COMMANDS is completed too.
    for (const cmd of KNOWN_COMMANDS) {
      expect(out).toContain(cmd);
    }
    // The new command completes itself (anti-regression on the interpolation).
    expect(out).toMatch(/compgen -W "[^"]*\bcompletion\b[^"]*"/);
  });

  test('the script wires dynamic shelf completion via `nb list`, guarded', async () => {
    const out = (await run(['completion', 'bash'])).out;
    // Shelf names come from `nb list`, and the lookup swallows stderr/failure so
    // it can never hang or error the shell (the issue's load-bearing risk).
    expect(out).toContain('nb list 2>/dev/null');
    // `show` (the acceptance-criteria example) is among the shelf-completing cmds.
    expect(out).toMatch(/case "\$cmd" in[\s\S]*\bshow\b/);
  });

  test('bash: sourcing the script completes commands and shelf names end-to-end', async () => {
    // The behavioral guard the string-match tests above can't give: it sources
    // the real emitted script and drives `_nb_complete` with stubbed COMP_WORDS,
    // so a broken awk shelf-parse or a wrong COMP_CWORD index would turn it red.
    // Needs bash (present on the Linux dev/CI host) and the built CLI (pretest
    // builds dist/); skip cleanly where either is absent rather than fail.
    const cliJs = join(REPO_ROOT, 'dist', 'cli.js');
    if (!shellPresent('bash') || !existsSync(cliJs)) return;
    await run(['add', 'alpha', 'first lesson']);
    await run(['add', 'beta', 'second lesson']);
    const script = (await run(['completion', 'bash'])).out;
    // Stub `nb` to the built CLI (so `nb list` inside the script hits our temp
    // NB_DIR), source the script, then simulate three TAB positions.
    const harness = [
      `nb() { node ${JSON.stringify(cliJs)} "$@"; }`,
      script,
      '_sim() { COMP_WORDS=("$@"); COMP_CWORD=$(( $# - 1 )); _nb_complete; echo "${COMPREPLY[*]}"; }',
      '_sim nb ""', // subcommand position → commands
      '_sim nb show ""', // shelf position → shelf names
      '_sim nb add alpha ""', // lesson position → nothing
    ].join('\n');
    const result = execFileSync('bash', ['-c', harness], {
      env: { ...process.env, NB_DIR: dir },
      encoding: 'utf8',
    });
    const [cmdsLine, shelvesLine, lessonLine] = result.split('\n');
    const cmds = cmdsLine.split(/\s+/).filter(Boolean);
    expect(cmds).toContain('show'); // nb <TAB> offers the command set
    expect(cmds).toContain('completion');
    expect(shelvesLine.split(/\s+/).filter(Boolean).sort()).toEqual(['alpha', 'beta']); // nb show <TAB>
    expect(lessonLine.trim()).toBe(''); // free-text operand position offers nothing (no stale leak)
  });

  test('a missing shell is a bad-args error (exit 1), not an unknown command (exit 2)', async () => {
    const r = await run(['completion']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/shell/);
  });

  test('an unsupported shell exits 1 and names the supported shells', async () => {
    const r = await run(['completion', 'fish']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/bash/);
    expect(r.err).toMatch(/zsh/);
  });

  test('the shipped examples/completion/ scripts match the emitter (no drift)', async () => {
    const bash = (await run(['completion', 'bash'])).out;
    const zsh = (await run(['completion', 'zsh'])).out;
    const shippedBash = readFileSync(join(REPO_ROOT, 'examples', 'completion', 'nb.bash'), 'utf8');
    const shippedZsh = readFileSync(join(REPO_ROOT, 'examples', 'completion', 'nb.zsh'), 'utf8');
    // Byte-for-byte: regenerate with `node dist/cli.js completion <shell> >
    // examples/completion/nb.<shell>` if this fails.
    expect(shippedBash).toBe(bash);
    expect(shippedZsh).toBe(zsh);
  });

  test('introduces no runtime dependency (completion is static text)', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe('readBoundedStream (issue #304)', () => {
  async function* gen(chunks: string[], seen: { n: number }) {
    for (const c of chunks) {
      seen.n++;
      yield Buffer.from(c);
    }
  }

  test('a normal single line (with trailing newline) is returned unchanged', async () => {
    const seen = { n: 0 };
    expect(await readBoundedStream(gen(['run lint ', 'first\n'], seen), 100)).toBe('run lint first\n');
  });

  test('an endless newline-less stream throws too_long without draining it', async () => {
    const seen = { n: 0 };
    async function* endless() {
      for (;;) {
        seen.n++;
        yield Buffer.alloc(1024, 'a');
      }
    }
    await expect(readBoundedStream(endless(), 4096)).rejects.toMatchObject({ errorClass: 'too_long' });
    expect(seen.n).toBe(5);
  });

  test('stops reading once a second line appears (no further chunks pulled)', async () => {
    const seen = { n: 0 };
    const out = await readBoundedStream(gen(['one\n', 'two', 'three', 'four'], seen), 100);
    expect(out).toBe('one\ntwo');
    expect(seen.n).toBe(2);
  });

  test('a CR split from its LF across chunks is still a single line', async () => {
    const seen = { n: 0 };
    expect(await readBoundedStream(gen(['one\r', '\n'], seen), 100)).toBe('one\r\n');
  });
});

describe('a git merge-conflicted shelf warns on reads and refuses mutations (issue #333)', () => {
  // A `git merge`/`pull` conflict on a git-versioned notebook leaves `<<<<<<<`,
  // `=======` and `>>>>>>>` lines in `<shelf>.md`. Reads must keep working (the
  // lessons print as before, plus one stderr warning) and every mutation must
  // refuse with exit 1 and leave the file byte-identical — otherwise the next
  // write would bake the markers in as real lessons and erase the conflict.
  const MARKED = '+1\tfoo lesson\n<<<<<<< HEAD\n+2\tmine\n=======\n+3\ttheirs\n>>>>>>> branch\n';
  const seed = (shelf = 'g'): string => {
    const file = join(dir, `${shelf}.md`);
    writeFileSync(file, MARKED);
    return file;
  };

  test('show prints the stored lessons plus one stderr warning; stdout is unchanged and exit 0', async () => {
    seed();
    const r = await run(['show', 'g']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('foo lesson');
    expect(r.out).toContain('<<<<<<< HEAD');
    expect(r.err).toContain('shelf "g"');
    expect(r.err).toContain('<<<<<<< HEAD');
    expect(r.err.split('\n').filter((l) => l.includes('merge-conflict marker'))).toHaveLength(1);
  });

  test('show --json stdout is unchanged and valid, warning on stderr', async () => {
    seed();
    const r = await run(['show', 'g', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.entries.map((e: { text: string }) => e.text)).toContain('foo lesson');
    expect(r.err).toContain('merge-conflict marker');
  });

  test('list / search / stale still print, warn once, and exit 0', async () => {
    seed();
    await run(['add', 'ok', 'a clean lesson']);
    for (const argv of [['list'], ['search', 'foo'], ['stale', 'g']]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.err).toContain('shelf "g"');
      expect(r.err).toContain('merge-conflict marker');
    }
    const list = await run(['list', '--json']);
    const parsed = JSON.parse(list.out);
    expect(parsed.conflicts).toEqual([{ shelf: 'g', marker: '<<<<<<< HEAD' }]);
    expect(parsed.rows.map((x: { shelf: string }) => x.shelf)).toContain('g');
    expect(list.err).toContain('merge-conflict marker');
    const search = await run(['search', 'foo', '--json']);
    expect(JSON.parse(search.out).conflicts).toEqual([{ shelf: 'g', marker: '<<<<<<< HEAD' }]);
    expect(search.err).toContain('shelf "g"');
    expect(search.err).toContain('merge-conflict marker');
  });

  test('list --json stays byte-identical on a healthy store (no conflicts field)', async () => {
    await run(['add', 'ok', 'a clean lesson']);
    const r = await run(['list', '--json']);
    expect(JSON.parse(r.out)).not.toHaveProperty('conflicts');
    expect(Object.keys(JSON.parse(r.out))).toEqual(['dir', 'total', 'rows']);
  });

  test('a mid-line ======= or a tab-less hand-edited line is not a conflict', async () => {
    writeFileSync(join(dir, 'clean.md'), 'a hand-edited line\n1\ta lesson with ======= inside\n');
    const show = await run(['show', 'clean']);
    expect(show.code).toBe(0);
    expect(show.err).not.toContain('merge-conflict');
    const add = await run(['add', 'clean', 'new one']);
    expect(add.code).toBe(0);
  });

  test('every mutation exits 1, names the shelf and marker, and leaves the file byte-identical', async () => {
    const file = seed();
    writeFileSync(join(dir, 'h.md'), '+1\tother lesson\n');
    const before = readFileSync(file, 'utf-8');
    const id = entryId('foo lesson');
    const id2 = entryId('mine');
    const mutations: string[][] = [
      ['add', 'g', 'new one'],
      ['vote', 'g', id, '+1'],
      ['merge', 'g', id, id2, 'merged'],
      ['split', 'g', id, 'a', 'b'],
      ['rm', 'g', id],
      ['move', 'h', 'g', entryId('other lesson')],
      ['describe', 'g', 'a description'],
    ];
    for (const argv of mutations) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain('shelf "g"');
      expect(r.err).toContain('merge-conflict marker');
      expect(readFileSync(file, 'utf-8')).toBe(before);
    }
  });

  test('the refusal is logged with errorClass corrupt (issue #333)', async () => {
    seed();
    const r = await run(['add', 'g', 'new one']);
    expect(r.code).toBe(1);
    expect(parseUsage(dir).at(-1)!.errorClass).toBe('corrupt');
  });
});

describe('nb doctor (issue #338)', () => {
  const shelf = (name: string, body: string) => writeFileSync(join(dir, `${name}.md`), body, 'utf-8');
  const codes = async (extra: string[] = []) => {
    const r = await run(['doctor', '--json', ...extra]);
    return { r, findings: JSON.parse(r.out).findings as Array<{ code: string; shelf: string; line?: number }> };
  };

  test('a clean directory prints a one-line OK summary and exits 0, even with --exit-code', async () => {
    await run(['add', 'alpha', 'a lesson']);
    const r = await run(['doctor', '--exit-code']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('nb doctor: OK — 1 shelf checked, no problems found\n');
  });

  test('an empty/absent directory is OK', async () => {
    const r = await run(['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK');
  });

  test('--json on a clean directory emits {schemaVersion, shelves, findings: []}', async () => {
    await run(['add', 'alpha', 'a lesson']);
    const r = await run(['doctor', '--json']);
    expect(JSON.parse(r.out)).toEqual({ schemaVersion: 1, shelves: 1, findings: [] });
  });

  test('a shelf-less or nonexistent directory says nothing was checked, in both outputs, and still exits 0 (issue #381)', async () => {
    const empty = await run(['doctor', '--exit-code']);
    expect(empty.code).toBe(0);
    expect(empty.out).toBe('nb doctor: OK — 0 shelves checked (the notebooks directory holds no shelf), no problems found\n');
    expect(JSON.parse((await run(['doctor', '--json', '--exit-code'])).out)).toEqual({ schemaVersion: 1, shelves: 0, findings: [] });
    rmSync(dir, { recursive: true, force: true });
    const gone = await run(['doctor', '--exit-code']);
    expect(gone.code).toBe(0);
    expect(gone.out).toContain('0 shelves checked (the notebooks directory does not exist)');
    expect(JSON.parse((await run(['doctor', '--json', '--exit-code'])).out).shelves).toBe(0);
  });

  test('conflict marker: reported once with its line; a mid-line ======= is not a marker', async () => {
    shelf('a', '# desc: d\n+1\tfine ======= ok\n<<<<<<< HEAD\n+1\tx\n=======\n+1\ty\n>>>>>>> other\n');
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'conflict-marker')).toEqual([
      expect.objectContaining({ shelf: 'a', line: 3 }),
    ]);
  });

  test('bad-score: tab-less and non-numeric-score lines are flagged; meta, blank lines and +N/-N/N are not', async () => {
    shelf('a', '# desc: d\n+2\tgood\n-1\tgood too\n0\tzero\n\nno tab here\nabc\tbad score\n');
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'bad-score').map((f) => f.line)).toEqual([6, 7]);
  });

  test('control-char: an escape or bidi override is flagged with its line', async () => {
    shelf('a', '+1\tclean\n+1\tbad \u001b[31mred\n+1\tbidi ‮ text\n');
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'control-char').map((f) => f.line)).toEqual([2, 3]);
  });

  test('lesson-too-long: only a lesson over NB_MAX_CHARS is flagged', async () => {
    process.env.NB_MAX_CHARS = '20';
    shelf('a', `+1\t${'x'.repeat(20)}\n+1\t${'y'.repeat(21)}\n`);
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'lesson-too-long').map((f) => f.line)).toEqual([2]);
  });

  test('shelf-over-cap: only a shelf with more lessons than NB_MAX_LINES is flagged', async () => {
    process.env.NB_MAX_LINES = '2';
    shelf('full', '+1\ta\n+1\tb\n');
    shelf('over', '+1\ta\n+1\tb\n+1\tc\n');
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'shelf-over-cap').map((f) => f.shelf)).toEqual(['over']);
  });

  test('empty-file: a 0-byte shelf is flagged and produces no other finding for it', async () => {
    shelf('hollow', '');
    const { findings } = await codes();
    expect(findings).toEqual([expect.objectContaining({ code: 'empty-file', shelf: 'hollow' })]);
  });

  test('case-collision: both shelves are named (skipped where the filesystem aliases case)', async () => {
    shelf('Foo', '+1\ta\n');
    shelf('foo', '+1\tb\n');
    if (readdirSync(dir).filter((n) => n.endsWith('.md')).length < 2) return; // case-insensitive FS
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'case-collision').map((f) => f.shelf).sort()).toEqual(['Foo', 'foo']);
  });

  test('leftover-temp: shelf and usage-log temps are flagged; the live usage log and a dotfile are not', async () => {
    shelf('a', '+1\tx\n');
    writeFileSync(join(dir, 'a.md.123.tmp'), 'x');
    writeFileSync(join(dir, '.nb-usage.log.456.tmp'), 'x');
    writeFileSync(join(dir, '.nb-usage.log'), '');
    writeFileSync(join(dir, '.x.md.tmp'), 'x');
    writeFileSync(join(dir, 'live.md.789.tmp'), 'x'); // fresh: a live writer mid atomic-write
    const old = new Date(Date.now() - 3_600_000);
    for (const n of ['a.md.123.tmp', '.nb-usage.log.456.tmp', '.nb-usage.log', '.x.md.tmp']) utimesSync(join(dir, n), old, old);
    const { findings } = await codes();
    expect(findings.filter((f) => f.code === 'leftover-temp').map((f) => f.shelf)).toEqual([
      '.nb-usage.log.456.tmp',
      'a.md.123.tmp',
    ]);
  });

  test('stale-lock: an old .nb.lock is flagged, a fresh one is not', async () => {
    mkdirSync(join(dir, '.nb.lock'));
    expect((await codes()).findings.map((f) => f.code)).not.toContain('stale-lock');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, '.nb.lock'), old, old);
    expect((await codes()).findings.map((f) => f.code)).toContain('stale-lock');
  });

  test('--exit-code exits 3 on a finding; without it the exit is 0; --json keeps stdout pure', async () => {
    shelf('a', 'no tab\n');
    expect((await run(['doctor'])).code).toBe(0);
    const r = await run(['doctor', '--json', '--exit-code']);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).findings).toHaveLength(1);
    const h = await run(['doctor', '--exit-code']);
    expect(h.out).toContain('bad-score  a:1');
  });

  test('is read-only: shelf bytes and mtimes are unchanged and the lock is never created', async () => {
    shelf('a', '<<<<<<< x\nno tab\n');
    const file = join(dir, 'a.md');
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(file, old, old);
    const before = { m: statSync(file).mtimeMs, b: readFileSync(file, 'utf-8') };
    await run(['doctor', '--exit-code']);
    expect({ m: statSync(file).mtimeMs, b: readFileSync(file, 'utf-8') }).toEqual(before);
    expect(existsSync(join(dir, '.nb.lock'))).toBe(false);
  });

  test('never takes the lock: with a fresh .nb.lock held it returns at once and leaves it in place', async () => {
    shelf('a', '+1\tx\n');
    mkdirSync(join(dir, '.nb.lock'));
    const t0 = Date.now();
    const r = await run(['doctor']);
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000); // a mutation would spin on the held lock
    expect(existsSync(join(dir, '.nb.lock'))).toBe(true);
  });

  test('unreadable: a shelf that cannot be read is reported rather than aborting the scan', async () => {
    shelf('ok', 'no tab\n');
    mkdirSync(join(dir, 'd.md')); // reading a directory fails with EISDIR
    const { findings } = await codes();
    expect(findings.map((f) => f.code).sort()).toEqual(['bad-score', 'unreadable']);
  });

  test('an empty-text entry is not a lesson (not counted toward the cap, not flagged)', async () => {
    process.env.NB_MAX_LINES = '1';
    shelf('a', '+1\tone\n+1\t\n');
    expect((await codes()).findings).toEqual([]);
  });

  test('a leniently-parsed score like `3x` is flagged without claiming it loads as 0', async () => {
    shelf('a', '3x\tfoo\n');
    const r = await run(['doctor']);
    expect(r.out).toContain('bad-score  a:1');
    expect(r.out).not.toContain('loads as score 0');
  });

  test('an unknown flag is refused (flag validation row exists)', async () => {
    const r = await run(['doctor', '--exitcode']);
    expect(r.code).not.toBe(0);
  });
});

describe('surplus operands are rejected, not silently dropped (issue #378)', () => {
  const stored = (shelfName: string): string => {
    const f = join(dir, `${shelfName}.md`);
    return existsSync(f) ? readFileSync(f, 'utf-8') : '';
  };

  test('an unquoted lesson is refused naming the surplus word, and nothing is written', async () => {
    const r = await run(['add', 's', 'run', 'lint', 'first']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unexpected extra argument "lint"');
    expect(r.err).toContain('quote');
    expect(stored('s')).toBe('');
  });

  test.each([
    ['merge', ['merge', 's', 'a', 'b', 'merged', 'text']],
    ['split', ['split', 's', 'a', 'x', 'y', 'z']],
    ['describe', ['describe', 's', 'two', 'words']],
    ['rm', ['rm', 's', 'two', 'words']],
    ['vote', ['vote', 's', 'id', '+1', 'extra']],
    ['move', ['move', 's', 't', 'id', 'extra']],
  ])('%s rejects a surplus operand and leaves the shelf untouched', async (_n, argv) => {
    await run(['add', 's', 'alpha lesson']);
    await run(['add', 's', 'beta lesson']);
    const before = stored('s');
    const r = await run(argv);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unexpected extra argument');
    expect(stored('s')).toBe(before);
  });

  test('a repeated --note or --reason is refused and stores nothing', async () => {
    const a = await run(['add', 't', '--note', 'a', '--note', 'b', 'real lesson']);
    expect(a.code).toBe(1);
    expect(a.err).toContain('--note given more than once');
    expect(stored('t')).toBe('');
    const d = await run(['describe', 's', '--reason', 'a', '--reason', 'b', 'text']);
    expect(d.code).toBe(1);
    expect(d.err).toContain('--reason given more than once');
  });

  test('operands after -- are counted but stay literal', async () => {
    const ok = await run(['add', 's', '--', '--json']);
    expect(ok.code).toBe(0);
    expect(stored('s')).toContain('--json');
    const bad = await run(['add', 's', '--', 'one', 'two']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('unexpected extra argument "two"');
  });

  test('a trailing -- on vote is still a downvote; show and search keep their multi-operand forms', async () => {
    await run(['add', 's', 'alpha lesson']);
    const id = entryId('alpha lesson');
    expect((await run(['vote', 's', id, '--'])).code).toBe(0);
    await run(['add', 'u', 'other lesson']);
    expect((await run(['show', 's', 'u'])).code).toBe(0);
    expect((await run(['search', 'alpha', 's'])).code).toBe(0);
  });

  test('--json rejection is a structured bad_args object and exit 1', async () => {
    const r = await run(['add', 's', 'run', 'lint', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { class: 'bad_args' } });
  });
});
