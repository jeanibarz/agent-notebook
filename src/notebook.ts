// Agent Notebook — a bounded, voted, plain-text memory, one file per shelf (a group of lessons that surface together).
//
// The design in one breath: each shelf is a notebook file of one-line
// lessons, hard-capped so it can never rot. One entry = one line
// `<score>\t<lesson>`; at most MAX_LINES entries; each lesson at most
// MAX_CHARS characters. The agent votes +1/-1 at task end. A touch (a vote of
// either sign, an add, or a merge/split's new lesson) moves its line to the END
// of the file, so storage order is least-recently-touched first — the top line
// is the stalest. When the file is full and takes a new lesson, the newcomer is
// always admitted, the stalest line is docked one point (the aging that frees
// once-useful-now-quiet lessons without needing a downvote to arrive), and the
// LOWEST-scored line is evicted (ties → stalest), so harmful and stale lines
// leave first while hard-earned ones stay. No embeddings, no scheduler, no
// decay curve over wall-clock time — see docs/eviction-and-aging.md.
//
// Everything here is plain fs over one small file under a mkdir spinlock, so
// a call is a millisecond and offline.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmdirSync, unlinkSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * One int tunable's `NB_*` var, built-in default and clamp bound — declared
 * ONCE here and consumed by BOTH the hot-path getter and `nb config`'s registry
 * (issue #336). Keeping a single copy is what makes the #116/#131 "the printed
 * value can never drift" property structural rather than a test that must
 * happen to probe a moved bound.
 */
export interface IntTunable {
  env: string;
  dflt: number;
  lo: number;
  hi: number;
}

/** A rate tunable clamps to [0, 1]; only the default differs per knob. */
export interface RateTunable {
  env: string;
  dflt: number;
}

export const MAX_LINES: IntTunable = { env: 'NB_MAX_LINES', dflt: 50, lo: 1, hi: 5000 };
export const MAX_CHARS: IntTunable = { env: 'NB_MAX_CHARS', dflt: 200, lo: 20, hi: 2000 };
export const NEAR_DUP: RateTunable = { env: 'NB_NEAR_DUP', dflt: 0.5 };
export const USAGE_RING: IntTunable = { env: 'NB_USAGE_RING', dflt: 5000, lo: 100, hi: 100000 };
export const STALE_LOCK_MS: IntTunable = { env: 'NB_STALE_LOCK_MS', dflt: 10_000, lo: 100, hi: 600_000 };
export const LOCK_GRACE_MS: IntTunable = { env: 'NB_LOCK_GRACE_MS', dflt: 2_000, lo: 0, hi: 600_000 };
export const LOOP_N: IntTunable = { env: 'NB_LOOP_N', dflt: 10, lo: 2, hi: 1000 };
export const LOOP_WINDOW_S: IntTunable = { env: 'NB_LOOP_WINDOW_S', dflt: 120, lo: 5, hi: 86_400 };
export const SILENT_H: IntTunable = { env: 'NB_SILENT_H', dflt: 48, lo: 1, hi: 24 * 365 };
export const ERR_MIN: IntTunable = { env: 'NB_ERR_MIN', dflt: 5, lo: 1, hi: 10_000 };
export const ADD_BURST_N: IntTunable = { env: 'NB_ADD_BURST_N', dflt: 15, lo: 1, hi: 100_000 };
export const ERR_RATE: RateTunable = { env: 'NB_ERR_RATE', dflt: 0.3 };

/** The coverage×surfacing readout thresholds (issue #81). A rate ≥ its HIGH cutoff reads as "HIGH" on that axis; both default to a deliberately blunt split, tunable via env. */
export const DEFAULT_COVERAGE_HI = 0.5;
export const DEFAULT_RECALL_MISS_HI = 0.2;
export const COVERAGE_HI: RateTunable = { env: 'NB_COVERAGE_HI', dflt: DEFAULT_COVERAGE_HI };
export const RECALL_MISS_HI: RateTunable = { env: 'NB_RECALL_MISS_HI', dflt: DEFAULT_RECALL_MISS_HI };

/** Resolve an int tunable from env live — the SAME three numbers the getter uses, so the getter and `nb config` cannot drift. */
export function resolveIntTunable(t: IntTunable): number {
  return resolveIntEnv(process.env[t.env], t.dflt, t.lo, t.hi).value;
}
export function resolveRateTunable(t: RateTunable): number {
  return resolveRateEnv(process.env[t.env], t.dflt).value;
}

/** Hard caps, read at call time so they can be tuned by env without a code change (and set per-test). */
export function maxLines(): number {
  return resolveIntTunable(MAX_LINES);
}
export function maxChars(): number {
  return resolveIntTunable(MAX_CHARS);
}
/**
 * Trigram-Jaccard similarity at/above which an *accepted* add also emits a
 * non-blocking near-duplicate advisory (see `similarity`/`addEntry`). It never
 * blocks an add (DP-5: a fuzzy match must never cause a silent loss); a lower
 * value surfaces more "did you mean to merge?" hints, and `0` disables the
 * advisory entirely. The default is a deliberately conservative starting
 * point — the honest way to tune it is offline from the `merge{duplicate}`
 * labels the log already records.
 */
export function nearThreshold(): number {
  return resolveRateTunable(NEAR_DUP);
}
/** The usage log is itself a bounded ring (monitoring can't grow unbounded either). */
export function usageRing(): number {
  return resolveIntTunable(USAGE_RING);
}

/**
 * How many rows past the ring cap the usage log is allowed to grow before a
 * compaction trims it back (issue #135). The append fast-path tracks an
 * approximate line count in a tiny sidecar so it never reads the whole ring; a
 * small slack lets several appends pass between the rare read+rewrite
 * compactions, making the common `nb` call O(1) instead of O(ring). It is a
 * fraction of the ring (floored to a small minimum so a tiny ring still gets
 * meaningful amortization), so the peak overshoot — and how far `stats` can
 * briefly over-count — stays a few percent of the ring.
 */
export function usageRingSlack(): number {
  return Math.max(16, Math.floor(usageRing() / 16));
}

/**
 * Lock timing (ms), read at call time so a test can shrink the whole window via
 * env. A `.nb.lock` whose holder has not touched it for `NB_STALE_LOCK_MS` is
 * treated as abandoned by a crashed nb process and stolen; the acquire budget
 * is DERIVED (see `withLock`) as this threshold plus `NB_LOCK_GRACE_MS`, never
 * set independently. The derivation keeps the acquire deadline >= the stale
 * threshold: without it (the prior 2s budget vs 10s steal threshold) a caller
 * that met a just-crashed holder's still-fresh lock gave up — threw
 * 'notebook is locked' — before the lock ever aged enough to be stolen, so
 * every mutation hard-failed for ~10s after a crash instead of self-healing.
 * The threshold stays far above fn()'s real hold time (a few ms of file I/O),
 * so a slow-but-live holder is never robbed.
 */
export function staleLockMs(): number {
  return resolveIntTunable(STALE_LOCK_MS);
}
/** Extra budget, past the stale threshold, to notice and steal an abandoned lock before giving up. */
export function lockGraceMs(): number {
  return resolveIntTunable(LOCK_GRACE_MS);
}

// `nb stats` anomaly/readout thresholds, read at call time and clamped exactly
// like the caps above. `stats()` calls these getters instead of re-reading the
// env inline, so `nb config` can print each effective (post-clamp) value from
// the SAME source the detector uses — the surfaced value can never drift from
// the value `nb` actually runs under (the #116-class drift the #131 guard and
// issue #188 exist to prevent). The native unit matches the `NB_*` name
// (`…_S` → seconds, `…_H` → hours); `stats()` scales to ms at the call site.
/** Loop anomaly: how many same-shelf+command+target calls inside the window trip it. */
export function loopN(): number {
  return resolveIntTunable(LOOP_N);
}
/** Loop anomaly: the window, in seconds (`stats()` multiplies by 1000 to compare timestamps). */
export function loopWindowSec(): number {
  return resolveIntTunable(LOOP_WINDOW_S);
}
/** Went-silent anomaly: silence threshold, in hours (`stats()` multiplies by 3_600_000). */
export function silentHours(): number {
  return resolveIntTunable(SILENT_H);
}
/** High-error-rate anomaly: minimum calls before the failure fraction is judged. */
export function errMin(): number {
  return resolveIntTunable(ERR_MIN);
}
/** `add-burst` signal (issue #353): a session with MORE than this many accepted adds to one shelf is flagged. */
export function addBurstN(): number {
  return resolveIntTunable(ADD_BURST_N);
}
/** High-error-rate anomaly: minimum failure fraction (0–1); a bad value falls back to the default, never NaN (which would disable detection). */
export function errRate(): number {
  return resolveRateTunable(ERR_RATE);
}
/** Surfacing readout ([FR-STATS-004]): coverage ≥ this reads as novel-adds HIGH. */
export function coverageHi(): number {
  return resolveRateTunable(COVERAGE_HI);
}
/** Surfacing readout ([FR-STATS-004]): recall-miss ≥ this reads as dedup-blocks HIGH. */
export function recallMissHi(): number {
  return resolveRateTunable(RECALL_MISS_HI);
}

/**
 * How a numeric env tunable's raw value was turned into the effective value `nb`
 * runs with (issue #336). `default` — the var is unset, so the built-in default
 * applies. `honored` — the var is set to a parseable in-range value and used
 * as-is. `clamped` — the var is set to a parseable value outside the bound and
 * `nb` silently used the nearest bound instead. `ignored` — the var is set but
 * unparseable (e.g. `abc` or a partially-numeric `1e3`/`12.9`/`50abc`, which
 * `parseInt` would truncate), so `nb` silently used the default.
 *
 * This is what lets `nb config` distinguish "the setting you exported is in
 * force" from "it was rewritten" from "it was thrown away" — the whole point of
 * an introspection command ([DP-5](#dp-5)).
 */
export type TunableStatus = 'default' | 'honored' | 'clamped' | 'ignored';

/** A raw env value resolved against its default and bounds, plus how it was resolved. */
export interface ResolvedInt {
  value: number;
  status: TunableStatus;
}

/**
 * The status-aware form of an int clamp: resolve `raw` against `dflt`/`lo`/`hi` and
 * report WHETHER the raw value was honored, clamped, ignored (unparseable) or
 * absent (default). The getters that `nb config` reports call this; the plain
 * `resolveIntTunable` above wraps it for the hot path.
 */
export function resolveIntEnv(raw: string | undefined, dflt: number, lo: number, hi: number): ResolvedInt {
  if (raw === undefined) return { value: dflt, status: 'default' };
  // Only a WHOLE integer is honored. `parseInt` accepts a numeric prefix and
  // silently drops the rest (`1e3`→1, `12.9`→12, `50abc`→50), so a user who
  // meant 1000 would get a cap of 1 — the "rewritten value reads as honored"
  // failure #336 exists to eliminate. Treat a partial parse as unparseable.
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return { value: dflt, status: 'ignored' };
  const n = Number.parseInt(trimmed, 10);
  const value = Math.min(hi, Math.max(lo, n));
  return { value, status: value === n ? 'honored' : 'clamped' };
}

/**
 * The status-aware form of a rate clamp: resolve a rate `raw` against `dflt` and
 * the [0, 1] bounds, reporting how the raw value was resolved (see
 * {@link TunableStatus}). An empty string is parsed by `Number('')` as `0`, so it
 * is honored (clamped to the floor), not ignored — the divergence from
 * `parseInt`-backed ints the clamp tests already pin.
 */
export function resolveRateEnv(raw: string | undefined, dflt: number): ResolvedInt {
  if (raw === undefined) return { value: dflt, status: 'default' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: dflt, status: 'ignored' };
  const value = Math.min(1, Math.max(0, n));
  return { value, status: value === n ? 'honored' : 'clamped' };
}

/** One notebook line. `score` is a running vote sum; `text` is a single ≤MAX_CHARS lesson. */
export interface Entry {
  score: number;
  text: string;
}

/** A shelf name is a path segment; reject anything that could escape the notebooks dir. */
const SAFE_SHELF = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/;

/**
 * Max shelf-name length. A shelf becomes the `<shelf>.md` filename, so an
 * unbounded name hits the filesystem's `ENAMETOOLONG` with a bare Node stack
 * instead of a notebook error. 128 fits `shelf@owner-repo` plus a suffix and
 * stays well under typical 255-byte filename limits.
 */
const MAX_SHELF_LEN = 128;

/**
 * Shelf names we refuse to own, case-insensitively. `README` is reserved because
 * a `README.md` is the conventional backup/git artifact in a notebook folder, not
 * a notebook — treating it as a shelf would list, search, count and (worse) let a
 * write command rewrite it (issue #90). Reserving the name here rejects a direct
 * `<shelf>` target (`nb add README …`, `nb vote README …`); `listShelves` separately
 * filters a `README.md` already on disk out of the index.
 */
const RESERVED_SHELVES = new Set(['readme']);

/**
 * Windows reserved device basenames (issue #205). On Windows `CON, PRN, AUX, NUL,
 * COM1-9, LPT1-9` are devices, not files — case-insensitively, and even carrying an
 * extension: `nul.md` resolves to the NUL device, not a `nul.md` file. A shelf is
 * stored as `<shelf>.md`, so a shelf named `nul` would make `nb add nul "lesson"`
 * write to the null device: the write "succeeds", the lesson is discarded, and
 * `nb show nul` reads back empty — a silent, unrecoverable memory loss. We reject
 * these names up front, like `readme`, so the failure is a clear error on every
 * platform instead of a Windows-only data sink.
 *
 * The match is against the segment before the first `.` (Windows resolves the device
 * from that leading segment regardless of trailing extensions, so `nul.notes` → the
 * NUL device too), and it is anchored to the whole segment — `console`, `aux-notes`
 * and `com10` contain a reserved substring but are not reserved names, and stay valid.
 */
const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function assertSafeShelf(shelf: string): void {
  if (shelf.length > MAX_SHELF_LEN) {
    throw new NbError(
      'bad_args',
      `invalid shelf name: ${JSON.stringify(shelf)} (too long: ${shelf.length} chars, max ${MAX_SHELF_LEN})`,
    );
  }
  if (!SAFE_SHELF.test(shelf) || shelf.includes('..')) {
    throw new NbError('bad_args', `invalid shelf name: ${JSON.stringify(shelf)} (allowed: letters, digits, . _ @ -)`);
  }
  if (RESERVED_SHELVES.has(shelf.toLowerCase())) {
    throw new NbError('bad_args', `invalid shelf name: ${JSON.stringify(shelf)} (reserved: a README.md is not a notebook)`);
  }
  if (WINDOWS_RESERVED_DEVICE.test(shelf.split('.')[0]!)) {
    throw new NbError(
      'bad_args',
      `invalid shelf name: ${JSON.stringify(shelf)} (reserved: a Windows device name — ${shelf.split('.')[0]!.toUpperCase()} resolves to a device, not a file)`,
    );
  }
}

/** @deprecated use assertSafeShelf — same function, kept so existing callers keep working. */
export const assertSafeRole = assertSafeShelf;

/**
 * Expand a leading `~` (optionally followed by `/`, or `\` on Windows) to the
 * home directory. Deliberately narrow (issue #334): only `~` and `~/…` (and
 * `~\…` on Windows) expand — `~user/…` is left untouched, as is any value with
 * no leading `~`. A process env supplied by `settings.json`, systemd or cron
 * never passes through a shell, so `NB_DIR=~/x` would otherwise create a
 * literal `~` directory under the current working directory.
 */
export function expandHomeDir(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (process.platform === 'win32' && value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** The notebooks directory. `NB_DIR` overrides (with a leading `~` expanded); default `~/.agent-notebook/notebooks`. */
export function notebooksDir(): string {
  return process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? expandHomeDir(process.env.NB_DIR)
    : join(homedir(), '.agent-notebook', 'notebooks');
}

/**
 * Refuse to CREATE a shelf whose name differs only by case from an existing one
 * (issue #337). `Foo.md` and `foo.md` coexist on Linux but are one file on the
 * default macOS/Windows filesystems, so a git-synced notebook would collide on
 * checkout, or a write to `foo` would land in `Foo`. Only creation is guarded:
 * an exact-name match (the shelf already exists) and any name with no
 * case-variant behave as before, and already-colliding pairs are left alone.
 * Uses the directory listing rather than `existsSync`, so it also fires on a
 * case-insensitive host where `foo.md` would otherwise "exist" by aliasing.
 */
function assertNoCaseVariant(dir: string, shelf: string): void {
  const shelves = listShelves(dir);
  if (shelves.includes(shelf)) return;
  const lower = shelf.toLowerCase();
  const variant = shelves.find((o) => o.toLowerCase() === lower);
  if (variant === undefined) return;
  throw new NbError(
    'bad_args',
    `shelf ${JSON.stringify(shelf)} differs only by case from the existing shelf ${JSON.stringify(variant)} — ` +
      `they would collide on a case-insensitive filesystem (macOS/Windows); did you mean \`${variant}\`?`,
  );
}

function shelfFile(dir: string, shelf: string): string {
  assertSafeShelf(shelf);
  return join(dir, `${shelf}.md`);
}

/**
 * Resolved path of the usage ring, `<dir>/.nb-usage.log`. Exported so a
 * supervisor can tail (`tail -F` — compaction replaces the file via rename) or
 * back up the log via `nb path --usage` (or this helper) instead of hard-coding
 * the filename — the same coupling `nb path` was added to remove (issue #14,
 * #169). The filename may change; always resolve it through here.
 */
export function usageFile(dir: string): string {
  return join(dir, '.nb-usage.log');
}

/**
 * Sidecar recording the usage log's row count AND its byte size as of this
 * process's last write, so the append fast-path can decide append-vs-compact
 * without reading and splitting the whole ring on every `nb` call (issue #135).
 *
 * The byte size is the integrity check: the fast path trusts the row count only
 * when the log's current size exactly equals the recorded size — i.e. nothing
 * has touched the file since we wrote it. Any out-of-band change (a concurrent
 * writer, a hand-edit, a crash that truncated a row) moves the size, so the
 * stale count is distrusted and the call falls to the exact read+compact path,
 * which re-derives the true count, re-applies the trailing-newline guard, and
 * restores the hard ring bound — in a single call, at any ring size.
 *
 * It is a tiny dotfile next to the log — not a `*.md` shelf (`listShelves`/stats
 * skip dotfiles) and, lacking a `.tmp` suffix, not matched by either reap
 * convention (shelf `*.md[.<pid>].tmp` or usage-log `.nb-usage.log.*.tmp`), so it
 * is never surfaced or deleted.
 */
function usageCountFile(dir: string): string {
  return join(dir, '.nb-usage.log.count');
}

/** Read the sidecar `{ rows, bytes }`, or `undefined` if it is missing or unparseable. */
function readUsageState(dir: string): { rows: number; bytes: number } | undefined {
  try {
    const [rowsRaw, bytesRaw] = readFileSync(usageCountFile(dir), 'utf-8').trim().split('\t');
    const rows = Number.parseInt(rowsRaw ?? '', 10);
    const bytes = Number.parseInt(bytesRaw ?? '', 10);
    if (!Number.isFinite(rows) || rows < 0 || !Number.isFinite(bytes) || bytes < 0) return undefined;
    return { rows, bytes };
  } catch {
    return undefined; // missing/unreadable — the caller falls back to the exact read.
  }
}

/** The log's byte size, or -1 if it cannot be stat'd — which never equals a recorded size, so the fast path falls back to the exact read instead of dropping the row on a race/ENOENT. */
function usageSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/** Best-effort sidecar write; a failed/stale sidecar just forces the next call down the exact read path. */
function writeUsageState(dir: string, rows: number, bytes: number): void {
  try {
    writeFileSync(usageCountFile(dir), `${rows}\t${bytes}\n`, 'utf-8');
  } catch {
    /* best-effort: the sidecar is only an optimisation; the exact path re-derives it. */
  }
}

// ---------------------------------------------------------------------------
// line (de)serialisation
// ---------------------------------------------------------------------------

/**
 * The characters that must never reach a terminal or an agent's context: C0
 * controls other than the whitespace ones (tab, LF, VT, FF, CR — the `\s` pass turns
 * those into a space, so a form feed still separates words) including ESC, NUL
 * and BEL; DEL; C1 controls (U+0080–U+009F, from which a raw ESC byte can be
 * re-formed); bidi embedding/override/isolate marks (U+202A–202E, U+2066–2069)
 * that make a line read differently from what it contains; and invisible
 * zero-width characters (U+200B, U+2060, U+FEFF) that defeat the exact-duplicate
 * check. U+200D (ZWJ) and the variation selectors are deliberately KEPT so emoji
 * ZWJ sequences survive (issue #335).
 */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Drop the terminal-manipulating / invisible characters ({@link CONTROL_CHARS_RE})
 * without otherwise touching the text. Applied on write (via {@link sanitizeLesson})
 * AND on every render path, so a shelf file stored before this rule existed can
 * never emit a raw escape either.
 */
export function stripControlChars(raw: string): string {
  return raw.replace(CONTROL_CHARS_RE, '');
}

/** {@link stripControlChars} that passes `null` through — for the optional description value. */
function stripControlCharsNullable(raw: string | null): string | null {
  return raw === null ? null : stripControlChars(raw);
}

/**
 * Flatten a lesson to a single whitespace-collapsed line with no tab (our field
 * separator), dropping control/invisible/bidi characters ({@link stripControlChars}).
 * Does NOT truncate: the caller enforces the length cap by rejecting an over-long
 * write (addEntry/merge), so the agent can retry with a shorter *complete* lesson
 * instead of silently storing a cut-off, possibly useless one.
 */
export function sanitizeLesson(raw: string): string {
  return stripControlChars(raw)
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recognize a git merge-conflict marker line (issue #333): a line-start `<<<<<<<`
 * or `>>>>>>>` followed by a space or the end of the line, or a bare `=======`
 * (nothing else on it). Anchored, so a lesson that merely contains `=======`
 * mid-line, or the ordinary hand-edited tab-less line, is not a marker. A shelf
 * that holds one came from an unresolved `git merge`/`pull` on a git-versioned
 * notebook, and rewriting it would bake the markers in as lessons — so reads
 * warn and mutations refuse instead.
 */
const CONFLICT_MARKER_RE = /^(?:<<<<<<<|>>>>>>>)(?: |$)|^=======$/;

/** True when `line` is a git merge-conflict marker (see {@link CONFLICT_MARKER_RE}). */
export function isConflictMarker(line: string): boolean {
  return CONFLICT_MARKER_RE.test(line);
}

function parseLine(line: string): Entry | null {
  if (line.trim() === '') return null;
  const tab = line.indexOf('\t');
  if (tab === -1) {
    // Tolerate a hand-edited line with no score: treat it as score 0.
    return { score: 0, text: sanitizeLesson(line) };
  }
  const score = Number.parseInt(line.slice(0, tab), 10);
  return { score: Number.isFinite(score) ? score : 0, text: sanitizeLesson(line.slice(tab + 1)) };
}

function formatLine(e: Entry): string {
  const s = e.score >= 0 ? `+${e.score}` : `${e.score}`;
  return `${s}\t${e.text}`;
}

/** Dedup key: case/punctuation-insensitive, whitespace-collapsed. Conservative — equality only. */
export function dedupKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space, so "shell-safety" == "shell safety"
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Character-trigram Jaccard similarity of two lessons' normal forms, in [0,1].
 * Deterministic, offline, zero-dependency, sub-millisecond on bounded lessons —
 * it is NOT embeddings, semantic search, or a learned/vector ranker ([NG-001]):
 * a cheap lexical overlap used ONLY to raise a *non-blocking* advisory, never to
 * block, reject, or rank. Trigrams are robust to word reordering and small
 * morphological changes ("claiming"/"claim"), which the exact-normal-form dedup
 * key misses.
 */
export function similarity(a: string, b: string): number {
  const ta = trigrams(dedupKey(a));
  const tb = trigrams(dedupKey(b));
  // `trigrams` pads its input, so each set holds ≥1 element even for an empty
  // string; the Jaccard denominator (|A|+|B|−|A∩B| ≥ max(|A|,|B|) ≥ 1) is thus
  // never zero and needs no guard.
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** The set of character trigrams of `s`, padded so boundary characters still form trigrams. */
function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const t = `  ${s} `;
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

// ---------------------------------------------------------------------------
// notebook metadata (leading `# key: value` comment lines)
// ---------------------------------------------------------------------------

/**
 * A metadata line: a *leading* `# key: value` comment at the very top of a
 * notebook file (e.g. `# desc: build/test gotchas for this repo`). It carries
 * notebook-level context — a one-line description an agent reads to decide
 * whether to open the notebook — WITHOUT adding a field to a lesson ([NG-004]):
 * the lesson stays a plain string, and metadata is just optional comment lines
 * the file already round-trips. The key is lowercase, starting with a letter;
 * the value is the rest of the line. An entry always starts with `±score\t` (or
 * is a bare score-0 lesson with no `#`), so a `#`-leading `key:` line is
 * unambiguous and backward-compatible — existing notebooks have no `#` lines.
 */
const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;

/** True when `line` is a notebook metadata line (`# key: value`). */
export function isMetaLine(line: string): boolean {
  return META_RE.test(line);
}

/**
 * The LEADING block of metadata lines of a shelf file, verbatim (the raw strings,
 * `#` included). Only the maximal run of `# key: value` lines at the very top is
 * metadata; the first non-metadata line (an entry) ends the block, so a `# key:`
 * line that somehow sits *among* entries stays an ordinary score-0 lesson
 * ([FR-MODEL-003]) — exactly how `readEntries` treats it. Returning the raw
 * lines (not a parsed map) lets a mutation re-emit unknown keys byte-for-byte
 * (forward-compatible), rewriting only the key it actually changes.
 */
export function readMetaLines(dir: string, shelf: string): string[] {
  return readShelf(dir, shelf).metaLines;
}

/** The value of metadata `key` within a set of raw metadata lines, or `null` if absent. */
export function getMetaValue(lines: string[], key: string): string | null {
  for (const line of lines) {
    const m = META_RE.exec(line);
    if (m && m[1] === key) return m[2];
  }
  return null;
}

/**
 * Return `lines` with metadata `key` set to `value`, order preserved: an existing
 * key is rewritten in place, a new key is appended. An empty `value` REMOVES the
 * key (so `nb describe <shelf> ""` clears the description rather than storing an
 * empty `# desc:` line). Only the touched key is re-canonicalized to `# key:
 * value`; every other line is left verbatim, so unknown keys round-trip
 * unchanged ([NG-004] forward-compatibility).
 */
export function setMetaValue(lines: string[], key: string, value: string): string[] {
  const out: string[] = [];
  let seen = false;
  for (const line of lines) {
    const m = META_RE.exec(line);
    if (m && m[1] === key) {
      seen = true;
      if (value !== '') out.push(`# ${key}: ${value}`); // empty value → drop (clear)
    } else {
      out.push(line);
    }
  }
  if (!seen && value !== '') out.push(`# ${key}: ${value}`);
  return out;
}

// ---------------------------------------------------------------------------
// locking (tiny mkdir spinlock — single-host, serial CLI calls, rare contention)
// ---------------------------------------------------------------------------

// The `.nb.lock` directory this process currently owns, or null when it owns
// none. Set only once THIS process's atomic `mkdirSync(lock)` wins the create
// (below) — never for a stale lock we steal, and never for a fresh lock we are
// still spinning on — so it is a true ownership flag a SIGINT/SIGTERM handler can
// consult (via `releaseHeldLock`) to reap only a lock we actually own.
//
// A single slot suffices because withLock is never nested and never runs
// concurrently with itself: its critical section is synchronous (no `await`
// between acquire and release) and every caller awaits one mutation at a time, so
// at most one lock is owned at any instant. withLock's `finally` still releases
// its OWN `lock` path directly rather than through this flag, so the normal
// release never depends on the flag's value — even a hypothetical future nested
// withLock on a different dir could not strand the outer lock. The flag is only a
// hint for the signal handler, never the sole release path. (issue #247)
let heldLock: string | null = null;
// Owner token of `heldLock` (issue #331): `<pid>.<random nonce>`, written to
// `<lock>/owner` right after the mkdir wins. Release and steal compare it, so a
// holder that outlived the stale threshold can never free the thief's live lock.
let heldToken: string | null = null;

const OWNER_FILE = 'owner';
const REAP_DIR = 'reap';

/** The owner token recorded in a lock dir, or null if none (legacy/crash-before-write/vanished). */
function readOwner(lock: string): string | null {
  try {
    return readFileSync(join(lock, OWNER_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/** Empty and remove a lock dir. Throws if the dir is already gone. */
function removeLockDir(lock: string): void {
  try { unlinkSync(join(lock, OWNER_FILE)); } catch { /* legacy lock has none */ }
  try { rmdirSync(join(lock, REAP_DIR)); } catch { /* no stealer mid-flight */ }
  rmdirSync(lock);
}

/**
 * Remove `lock` only if it still carries OUR token; a stolen lock is left to its
 * thief. `token === null` means our owner-file write failed (e.g. ENOSPC), so
 * ownership cannot be proven — fall back to the pre-#331 unconditional release
 * rather than strand the lock. The check-and-remove runs under the lock's `reap`
 * mutex (the same one stealers take), so a stealer cannot interleave between our
 * token check and our rmdir; if a stealer holds it, we were judged stale and the
 * stealer finishes the job.
 */
function releaseOwned(lock: string, token: string | null): void {
  if (token === null) {
    try { removeLockDir(lock); } catch { /* already gone */ }
    return;
  }
  const reap = join(lock, REAP_DIR);
  let haveMutex = false;
  // A stealer holds `reap` only for microseconds, so retry briefly rather than
  // leak a live lock when it backs off (it leaves the lock for us to release).
  for (let i = 0; i < 20 && !haveMutex; i++) {
    try {
      mkdirSync(reap);
      haveMutex = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ENOENT: lock already gone. Anything but EEXIST (ENOSPC/EDQUOT/EACCES…)
      // means `reap` cannot be created at all: release without the mutex rather
      // than strand the lock (as the pre-#331 unconditional rmdir would not).
      if (code === 'ENOENT') return;
      if (code !== 'EEXIST') break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    if (readOwner(lock) !== token) {
      if (haveMutex) { try { rmdirSync(reap); } catch { /* gone */ } }
      return;
    }
    removeLockDir(lock);
  } catch {
    if (haveMutex) { try { rmdirSync(reap); } catch { /* gone */ } }
  }
}

/**
 * Release the `.nb.lock` this process owns, if any, and clear the ownership flag.
 * A no-op when this process owns no lock, so the SIGINT/SIGTERM handler that calls
 * it (see cli.ts) can never remove another live `nb`'s lock nor a fresh lock we are
 * only spinning on. The flag is cleared before the `rmdir`, so it is idempotent and
 * safe to call more than once.
 *
 * This is the signal handler's release path. withLock's own `finally` releases its
 * lock directly; this helper exists only so an interrupt can promptly reap a lock
 * the process still owns instead of leaving it for the next caller's ~12s
 * stale-steal (issue #247).
 */
export function releaseHeldLock(): void {
  const lock = heldLock;
  const token = heldToken;
  if (lock === null) return;
  heldLock = null; // clear first so a second call is a no-op
  heldToken = null;
  releaseOwned(lock, token);
}

// ---------------------------------------------------------------------------
// Crash-recovery accounting (issue #309)
// ---------------------------------------------------------------------------
// Two recovery paths each mean a previous `nb` died mid-mutation: withLock's
// stale-lock steal (a crash WHILE holding the lock) and reapLeftoverTemps'
// leftover-temp reap (a crash mid atomic-write). Both were entirely silent — no
// log, no counter, no `stats` signal — so an operator running `nb` from agent
// hooks could not answer "are my agents crashing mid-write and losing updates?".
//
// We make recovery observable WITHOUT changing the recovery actions: a tiny
// module-level tally counts the two events, and the next `logUsage` in THIS
// process drains the tally onto the usage row it is about to write. A mutation
// always logs exactly one usage row (from the CLI's `finally`, AFTER its
// withLock has resolved — same single-threaded process, so the tally is counted
// before it is drained), so the count rides an existing monitoring row: no extra
// row, no new pseudo-command, and `perCommand`/`totalCalls`/`activity` stay about
// real commands. `stats` then sums the column across the window into a
// deployment-wide crash-recovery readout. The accounting is best-effort end to
// end: the tally never throws, and a dropped count loses at most one monitoring
// observation — never a lesson and never the recovery itself.
let pendingRecovery: { lockSteals: number; tempReaps: number } = { lockSteals: 0, tempReaps: 0 };

/**
 * Tally a crash-recovery event for this process's next usage row (issue #309):
 * a stale lock stolen (`lock-steal`) or `n` leftover temps reaped (`temp-reap`).
 * Best-effort — never throws, and a non-positive count is ignored. Exported so a
 * test can prime the tally the same way the recovery paths do.
 */
export function noteRecovery(kind: 'lock-steal' | 'temp-reap', n = 1): void {
  if (!(n > 0)) return;
  if (kind === 'lock-steal') pendingRecovery.lockSteals += n;
  else pendingRecovery.tempReaps += n;
}

/**
 * Read-and-reset the pending crash-recovery tally. `logUsage` calls this exactly
 * once per row, so each recovery event is attributed to exactly one row and never
 * double-counted. Exported for tests, which also call it to reset the module
 * tally between cases.
 */
export function drainPendingRecovery(): { lockSteals: number; tempReaps: number } {
  const drained = pendingRecovery;
  pendingRecovery = { lockSteals: 0, tempReaps: 0 };
  return drained;
}

export async function withLock<T>(dir: string, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.nb.lock');
  const staleMs = staleLockMs();
  // Acquire budget is the stale threshold plus a grace margin, so the deadline
  // is always >= the threshold. A caller that meets a freshly-crashed holder's
  // lock therefore waits long enough for it to age past staleMs and reclaim it,
  // instead of giving up first (the fixed 2s-vs-10s mismatch, issue #133).
  const budgetMs = staleMs + lockGraceMs();
  const deadline = Date.now() + budgetMs;
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  let ownToken: string | null = token;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: succeeds only if it did not exist
      heldLock = lock; // we now own this lock (the signal handler may reap it)
      try {
        writeFileSync(join(lock, OWNER_FILE), token, 'utf-8');
        heldToken = token;
      } catch (werr) {
        if ((werr as NodeJS.ErrnoException)?.code === 'ENOENT') {
          // The lock dir was removed under us (a racing stealer): we do NOT hold
          // the lock. Do not run fn or release anything — re-acquire.
          heldLock = null;
          heldToken = null;
          continue;
        }
        heldToken = null; // cannot prove ownership; release falls back to unconditional
      }
      ownToken = heldToken;
      break;
    } catch (err) {
      // EEXIST is the ONLY code that means "the lock is genuinely held": the
      // `.nb.lock` dir already exists, so another nb process owns it and the
      // stale-steal / wait-and-retry path below is the right response. Any other
      // code means the lock dir itself cannot be created — EACCES/EPERM on a
      // permission-denied store, EROFS on a read-only mount, ENOSPC on a full
      // disk, ENOENT on a vanished NB_DIR. Busy-waiting the whole acquire budget
      // (staleMs + grace, ~10s+) would only delay an inevitable failure and then
      // report a misleading 'notebook is locked' when no other process exists.
      // Fail fast with the real cause instead (issue #263).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw new Error(
          `cannot acquire notebook lock at ${lock}: notebook directory is not writable (${code ?? String(err)})`,
          { cause: err },
        );
      }
      // Stale-lock recovery: a crashed nb process can leave .nb.lock behind.
      // Steal it once its holder has been silent longer than the stale threshold.
      try {
        // Read the token BEFORE the mtime: a stale mtime that follows a token read
        // can only belong to that same lock generation (a replacement lock is
        // fresh), so the (token, stale) pair is consistent (issue #331).
        const observed = readOwner(lock);
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          if (stealStale(lock, observed, staleMs)) {
            // A stale lock we just stole is evidence its holder crashed while
            // holding it — tally the steal (issue #309), only after a confirmed
            // removal so a lost race never counts a phantom steal.
            noteRecovery('lock-steal');
            continue;
          }
        }
      } catch {
        /* lock vanished between mkdir and stat — just retry */
      }
      if (Date.now() > deadline) {
        throw new Error(`notebook is locked (another nb process did not release within ${budgetMs}ms)`);
      }
      await sleep(20);
    }
  }
  try {
    // Reaping a crash-left temp is the second sign a prior nb died mid-write —
    // tally the count so recovery is observable (issue #309). reapLeftoverTemps
    // reports how many it removed; noteRecovery ignores a zero.
    noteRecovery('temp-reap', reapLeftoverTemps(dir));
    return fn();
  } finally {
    // Release THIS invocation's own lock directly and unconditionally, and clear
    // the ownership flag if it still names this lock. Removing `lock` itself
    // (rather than whatever `heldLock` points at) keeps the normal path correct
    // regardless of the flag: a signal handler that already reaped and nulled it,
    // or a hypothetical future nested withLock, cannot strand this lock.
    if (heldLock === lock) {
      heldLock = null;
      heldToken = null;
    }
    // Ownership-checked (issue #331): if we outlived the stale threshold and a
    // thief took the lock, its token differs and we leave its live lock alone.
    releaseOwned(lock, ownToken);
  }
}

/**
 * Steal a stale lock without racing other stealers (issue #331). Stealers
 * serialize on a `reap` subdirectory INSIDE the lock dir, so the mutex belongs to
 * one lock generation: if the lock was already stolen and recreated, the mutex
 * we win is the new holder's, and the re-check under it (same owner token, mtime
 * still stale) fails, so we back off instead of removing a live lock. Returns
 * true only when this call removed the stale lock.
 */
export function stealStale(lock: string, observed: string | null, staleMs = staleLockMs()): boolean {
  const reap = join(lock, REAP_DIR);
  try {
    mkdirSync(reap);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EEXIST') {
      // `reap` cannot be created (ENOSPC/EDQUOT/EACCES, or the lock vanished):
      // do not wedge — fall back to a token-checked removal without the mutex.
      try {
        if (readOwner(lock) !== observed) return false;
        removeLockDir(lock);
        return true;
      } catch {
        return false;
      }
    }
    // Another stealer/releaser is mid-flight — unless it died holding `reap`,
    // which would wedge the lock forever. An aged `reap` is crash debris: clear it.
    try {
      if (Date.now() - statSync(reap).mtimeMs > staleMs) rmdirSync(reap);
    } catch { /* gone or raced — retry */ }
    return false;
  }
  try {
    // The lock-dir mtime cannot be re-checked here (creating `reap` just bumped
    // it). A token-bearing lock is re-proven stale via its owner file's mtime,
    // which `reap` does not touch; the unique token pins the generation. A
    // token-less lock (legacy / just-created) can only be confirmed token-less.
    let stale = true;
    if (observed !== null) {
      try {
        stale = Date.now() - statSync(join(lock, OWNER_FILE)).mtimeMs > staleMs;
      } catch {
        stale = false;
      }
    }
    if (readOwner(lock) !== observed || !stale) {
      try { rmdirSync(reap); } catch { /* lock gone */ }
      return false;
    }
    removeLockDir(lock);
    return true;
  } catch {
    try { rmdirSync(reap); } catch { /* already gone */ }
    return false;
  }
}

// A shelf's atomic-write temp: the legacy shared `<shelf>.md.tmp` (pre-#270) or
// the per-process `<shelf>.md.<pid>.tmp` (issue #270). `<pid>` is always numeric
// (process.pid), so the optional `\d+\.` segment matches the per-process name
// without widening the sweep to arbitrary `.md.<anything>.tmp` debris.
const SHELF_TMP_RE = /\.md\.(?:\d+\.)?tmp$/;

/**
 * Reap orphaned temp files left behind by a crashed writer. This writer leaves
 * two temp conventions in the notebooks dir, each from an interrupted atomic
 * write-then-rename; if the process dies before the rename, the temp lingers
 * forever (nothing else removes it), cluttering directory listings, backups, and
 * a git-tracked notebooks dir (SHELF_TMP_RE matches a shelf temp of either form):
 *   - `<shelf>.md.<pid>.tmp` from a durable notebook write (writeFileDurable,
 *     per-process since issue #270; the legacy `<shelf>.md.tmp` from a pre-#270
 *     writer is still swept for upgrade safety), renamed over `<shelf>.md`;
 *   - `.nb-usage.log.<pid>.tmp` from a usage-log compaction (issue #163), renamed
 *     over `.nb-usage.log`.
 * We sweep both here under the just-acquired mkdir lock, which serializes every
 * mutation — so a shelf temp we see is dead crash debris, never a rename in
 * flight. A usage-log temp is different: it is written OUTSIDE this lock (from the
 * CLI's finally block), so in a rare window we may reap one a live writer created
 * but has not yet renamed. That is deliberately acceptable and strictly bounded:
 * the writer's `renameSync` then fails with ENOENT, which it already swallows
 * (usage logging is best-effort), costing at most that one compaction's monitoring
 * row — never a lost lesson and never corruption, since the rename is atomic. The
 * case we actually care about is the common one: a crashed writer's leftover temp
 * that nothing else removes.
 * Scope is deliberately narrow to this writer's own conventions:
 *   - shelf temps: only `<shelf>.md.tmp` or `<shelf>.md.<pid>.tmp` (SHELF_TMP_RE),
 *     and never a dotfile — a shelf name never starts with `.` (assertSafeShelf),
 *     so a `.x.md.tmp` is not ours to remove;
 *   - usage-log temps: only names of the exact form `<basename>.*.tmp` where
 *     `<basename>` is the usage log's (`.nb-usage.log`) — so never the live log
 *     itself, never its `.nb-usage.log.count` sidecar (no `.tmp` suffix), never
 *     the `.nb.lock`;
 *   - only the top level of `dir` (readdirSync is not recursive).
 * Best-effort: any failure (a racing unlink, a permission error) is swallowed so
 * a stale temp can never block a real mutation.
 *
 * Returns the number of temps actually removed, so the caller can surface it as a
 * crash-recovery signal (issue #309) — a nonzero reap is evidence a prior writer
 * died mid atomic-write. The count is best-effort: the rare benign case this
 * function's own contract notes (reaping a live writer's usage-log temp a moment
 * before its rename) is counted too, which can at most over-report by that one
 * bounded event — acceptable for a monitoring hint, and never affecting a lesson.
 */
export function reapLeftoverTemps(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // dir unreadable — nothing to reap
  }
  // `.nb-usage.log.` — the live log's basename plus the dot that precedes the
  // per-pid segment, so the live log and its `.count` sidecar never match.
  const usageTmpPrefix = `${basename(usageFile(dir))}.`;
  let reaped = 0;
  for (const name of names) {
    const isShelfTemp = !name.startsWith('.') && SHELF_TMP_RE.test(name);
    const isUsageTemp = name.startsWith(usageTmpPrefix) && name.endsWith('.tmp');
    if (!isShelfTemp && !isUsageTemp) continue;
    try {
      unlinkSync(join(dir, name));
      reaped++; // count only a temp we actually removed (issue #309)
    } catch {
      /* already gone or not removable — reaping is best-effort */
    }
  }
  return reaped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

/**
 * Whether a shelf has a notebook file on disk. A read of a nonexistent shelf is
 * not an error anywhere (`readEntries` returns `[]`), but the two cases — a shelf
 * that exists and holds no lessons vs. one that was never created (e.g. a typo) —
 * must be told apart so `nb show` never calls a missing shelf "empty" (DP-5,
 * issue #166). Callers branch on this to pick the message; the read paths stay
 * unchanged and keep exit 0.
 */
export function notebookExists(dir: string, shelf: string): boolean {
  return existsSync(shelfFile(dir, shelf));
}

export function readEntries(dir: string, shelf: string): Entry[] {
  return readShelf(dir, shelf).entries;
}

/** A shelf's full contents from a single disk read: its leading metadata block and its entries. */
export interface ShelfContents {
  /** The leading `# key: value` block, verbatim — identical to {@link readMetaLines}. */
  metaLines: string[];
  /** The parsed entries after the metadata block — identical to {@link readEntries}. */
  entries: Entry[];
  /**
   * The first git merge-conflict marker line found in the file, or `null` for a
   * clean shelf (issue #333). Read commands warn and mutation commands refuse
   * when it is set — the file is the output of an unresolved `git merge`, and
   * rewriting it would persist the markers as real lessons.
   */
  conflict: string | null;
}

/**
 * Read a shelf file ONCE and return both its leading metadata block and its
 * entries, split in a single scan. `readEntries` and `readMetaLines` each open
 * and parse `<shelf>.md` on their own, so a caller that needs both — the
 * discovery hot path `listNotebooks`, `search`, `showJson`, and the `show`
 * command — otherwise reads and parses the same file twice per shelf (issue
 * #201, against the "a call is a millisecond" promise). This collapses that to
 * one `readFileSync` + one scan with byte-identical semantics: the leading run
 * of `# key:` lines is the metadata (exactly {@link readMetaLines}'s
 * leading-block-only rule), and from the first non-metadata line every line
 * parses as an entry (exactly {@link readEntries}), so a mid-file `# key:` line
 * stays a tolerated score-0 lesson ([FR-MODEL-003]). A missing file yields empty
 * metadata and entries, never an error.
 */
export function readShelf(dir: string, shelf: string): ShelfContents {
  const file = shelfFile(dir, shelf);
  if (!existsSync(file)) return { metaLines: [], entries: [], conflict: null };
  const metaLines: string[] = [];
  const entries: Entry[] = [];
  let conflict: string | null = null;
  // One scan splits the file: the leading run of `# key:` lines is metadata, and
  // the first non-metadata line flips `inMeta` so every remaining line parses as
  // an entry — matching readMetaLines (leading block) and readEntries (the rest).
  // Split on `\r?\n` so a CRLF-normalized file (Windows core.autocrlf=true, or any
  // CRLF hand-edit of a git-versioned notebook) parses identically to an LF one:
  // without stripping the trailing `\r`, `# desc: x\r` fails the `$`-anchored
  // META_RE and the description silently becomes a score-0 lesson (issue #273).
  // Strip one leading UTF-8 BOM (U+FEFF) first: a BOM-adding editor makes the first
  // line `\uFEFF# desc: x`, which fails the `^#` META_RE and would demote the
  // description to a junk score-0 lesson (issue #299).
  let inMeta = true;
  // Reads are lock-free, so a concurrent `nb rm` can unlink a phantom (empty,
  // undescribed) shelf between the existsSync above and this read. Treat that
  // ENOENT as the same "missing shelf → empty" contract; other errors propagate
  // (issue #300).
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { metaLines: [], entries: [], conflict: null };
    throw err;
  }
  for (const line of (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/)) {
    // A merge-conflict marker is not a lesson (issue #333): record the first one
    // so callers can warn/refuse, but still parse the line below so show/list
    // output stays what a read would have produced before the guard.
    if (conflict === null && isConflictMarker(line)) conflict = line;
    if (inMeta && META_RE.test(line)) {
      metaLines.push(line);
      continue;
    }
    inMeta = false;
    const e = parseLine(line);
    if (e && e.text !== '') entries.push(e);
  }
  return { metaLines, entries, conflict };
}

/**
 * Write a notebook, preserving its leading metadata block. `metaLines` lets a
 * caller pass the block through instead of having it re-read here: a caller that
 * is itself changing the metadata (e.g. `setDescription`) passes the new block,
 * and every single-shelf mutation (`add`/`vote`/`merge`/`split`/`rm`) passes the
 * block it already read via `readShelf`, so the mutation reads the shelf once
 * rather than twice (issue #251). A caller that omits it (e.g. `move`, which
 * writes two shelves) falls back to re-reading the existing block from disk under
 * the lock and re-emitting it unchanged. Either way the description round-trips
 * byte-for-byte. The metadata leads the file; the entries follow in recency order
 * — least-recently-touched first, a touch moving its entry to the end ([DP-3]). A
 * file with metadata but no entries is still written (its block survives an
 * emptied notebook), and only a notebook with neither becomes the empty string.
 */
function writeEntries(dir: string, shelf: string, entries: Entry[], metaLines?: string[]): void {
  const file = shelfFile(dir, shelf);
  const meta = metaLines ?? readMetaLines(dir, shelf);
  const lines = [...meta, ...entries.map(formatLine)];
  if (lines.length === 0) {
    // Phantom reap (issues #209, #355): no lesson and no metadata would persist
    // as a 0-byte `<shelf>.md` — debris `listNotebooks` HIDES ([FR-LIST-004]) but
    // nothing ever removes, so it lingers in the dir, backups, and git history.
    // Unlink instead, centrally, so every mutation that can empty a shelf
    // (`rm`, `move`, `describe <shelf> ""`) reaps it. Callers hold the lock, so no
    // concurrent writer's in-flight temp is at risk. A shelf that keeps a
    // `# desc:` line never gets here. If the unlink fails for a reason other than
    // "already absent", fall through and write the empty file as before.
    try {
      unlinkSync(file);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    }
  }
  const body = lines.join('\n');
  // Per-process-unique temp path (issue #270). withLock serializes writers on a
  // healthy host, but its single-host mkdir spinlock can declare a slow holder
  // STALE and let a second process steal the lock while the first is still alive
  // (a network-FS fsync stall, heavy load, or a lowered NB_STALE_LOCK_MS). With a
  // fixed `${file}.tmp` the two overlapping writers would open, truncate, and
  // write the SAME temp, interleaving bytes before either rename — corrupting the
  // notebook. The pid keeps each writer's temp distinct, so the atomic rename
  // degrades a stolen-lock overlap to a lost update (last rename wins), never a
  // torn file. reapLeftoverTemps sweeps both this and the legacy name.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileDurable(file, tmp, lines.length ? body + '\n' : '');
}

/**
 * Write `data` to `tmp`, flush it to stable storage, then atomically rename it
 * over `file` and flush the parent directory so the rename itself survives a
 * crash or power-loss. The rename alone is atomic but not durable: without the
 * fsyncs the data and/or the rename can still be lost after the call returns,
 * which would let `nb add` report success for a lesson that never reached disk.
 */
function writeFileDurable(file: string, tmp: string, data: string): void {
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data, 'utf-8');
    fsyncSync(fd); // body hits stable storage before the rename
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file); // atomic replace
  fsyncDir(dirname(file)); // make the rename itself durable
}

/**
 * Best-effort fsync of a directory so a rename within it is durable. Opening or
 * fsync'ing a directory is unsupported on some platforms (e.g. Windows) and
 * throws there; a failure must never fail the write, since the rename is still
 * atomic — we only lose the extra crash-durability guarantee.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    /* platform does not support directory fsync; the rename is still atomic */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The outcome of applying the cap to an over-full entry list. */
interface CapResult {
  /** The surviving entries, in their original (recency) order. */
  kept: Entry[];
  /** Entries removed to get back to `maxLines` (empty when nothing was evicted). */
  evicted: Entry[];
  /** The stalest entry whose score was docked by the aging step, or `null` when no eviction occurred. Same object as in `kept`/`evicted`, already mutated. */
  decayed: Entry | null;
}

/**
 * Enforce the `maxLines` cap after `entries` has grown past it, applying the
 * recency-ordered aging policy (see docs/eviction-and-aging.md). `entries` is in
 * storage order — least-recently-touched first, so index 0 is the stalest — and
 * the last `protectedCount` entries are the lesson(s) this call just created/
 * touched (a new add, a merge's result, a split's two halves).
 *
 * Fires ONLY when over cap; a sub-cap list is returned untouched, so a notebook
 * that has never filled behaves exactly as before. When over cap:
 *   1. NEWCOMERS ALWAYS STAY — a protected entry is never evicted or decayed.
 *   2. EVICTION (quality first) — remove the lowest-scored entries, ties →
 *      stalest (lowest index), evicting a protected entry only if the cap cannot
 *      be met otherwise. Doing this BEFORE the decay matters: it keeps the dock
 *      in step 3 from ever pushing a merely-stale line below an explicitly
 *      worse-scored (e.g. downvoted) one and evicting the wrong lesson.
 *   3. STALENESS DECAY (anti-immortality) — dock 1 from the stalest surviving
 *      evictable entry (the topmost non-protected line that was NOT evicted). A
 *      lesson that stops being re-voted drifts to the top as others are touched
 *      and loses a point each time the full notebook takes a new lesson, until it
 *      is re-voted (which moves it back to the fresh end, full protection) or
 *      finally evicted — the self-supplied downward pressure that replaces the
 *      downvotes that rarely arrive, aimed at the stale, not the active. Without
 *      it a once-upvoted line could never fall (nothing below it ever leaves).
 */
function enforceCap(entries: Entry[], protectedCount: number): CapResult {
  const cap = maxLines();
  if (entries.length <= cap) return { kept: entries, evicted: [], decayed: null };

  const protectedStart = entries.length - protectedCount; // last `protectedCount` are newcomers
  const isProtected = (i: number): boolean => i >= protectedStart;

  // 2) Evict worst-first: non-protected before protected, then lowest score,
  // then stalest (lowest index). Drop as many as needed to reach the cap.
  const dropCount = entries.length - cap;
  const order = entries
    .map((_, i) => i)
    .sort((a, b) => {
      const pa = isProtected(a) ? 1 : 0;
      const pb = isProtected(b) ? 1 : 0;
      return pa - pb || entries[a].score - entries[b].score || a - b;
    });
  const dropIdx = new Set(order.slice(0, dropCount));
  const kept: Entry[] = [];
  const keptIdx: number[] = [];
  const evicted: Entry[] = [];
  entries.forEach((e, i) => {
    if (dropIdx.has(i)) evicted.push(e);
    else {
      kept.push(e);
      keptIdx.push(i);
    }
  });

  // 3) Dock the stalest SURVIVING evictable line — the first kept entry whose
  // original index was non-protected (topmost = least-recently-touched survivor).
  let decayed: Entry | null = null;
  const pos = keptIdx.findIndex((i) => i < protectedStart);
  if (pos !== -1) {
    kept[pos].score -= 1;
    decayed = kept[pos];
  }
  return { kept, evicted, decayed };
}

// ---------------------------------------------------------------------------
// public operations
// ---------------------------------------------------------------------------

export interface AddResult {
  added: boolean;
  reason: 'added' | 'duplicate' | 'empty' | 'too-long';
  /**
   * The first (stalest) entry the cap removed, or `null` when nothing was
   * evicted. Kept for the common single-eviction display path; for the FULL set
   * (a cap decrease can evict many at once — issue #306) read `evictedAll`.
   */
  evicted: Entry | null;
  /**
   * EVERY entry this operation evicted, in storage order (stalest first). Holds
   * one entry in the ordinary over-cap add, but many when `NB_MAX_LINES` was
   * lowered below a full shelf's size so the next add trims it all the way down.
   * Empty when nothing was evicted. `evicted` is `evictedAll[0] ?? null`.
   */
  evictedAll: Entry[];
  /** The stalest survivor the aging step docked −1 (already mutated, so `score` is the POST-dock value), or `null` when no cap overflow occurred. */
  decayed: Entry | null;
  size: number;
  /** For 'too-long': the length of the submitted lesson, so the caller can report it. */
  length?: number;
  /** For 'too-long': how many characters the lesson is over `maxChars` (`length - maxChars`, always ≥ 1), so the caller can tell the agent exactly how much to trim instead of guessing (issue #239). */
  overflow?: number;
  /** Stable id this result concerns: the added/merged entry, or the submitted lesson on a duplicate/rejection. Absent for 'empty'. Lets the usage log record which entry a call touched. */
  id?: string;
  /** For 'duplicate': the id of the existing entry that blocked the add (the colliding entry). */
  collidedId?: string;
  /** For an *accepted* add that closely resembles (but is not an exact-normal-form duplicate of) an existing entry: that entry's id. The add still succeeds — this is a non-blocking advisory, not a block. Absent when nothing was near. */
  nearId?: string;
  /** The text of the `nearId` entry, so the caller can show it in the advisory. */
  nearText?: string;
  /** For an *accepted* add: true when this add created the shelf (it did not exist before). Absent otherwise. */
  created?: true;
  /** When `created`: up to 3 existing shelves sharing at least two name words with the new one (non-blocking advisory; absent when none). */
  similarShelves?: string[];
  /** For merge: the ids of the two source entries consumed into the merged one. */
  sources?: [string, string];
}

/** Lowercased name words of a shelf, split on `-` and `.` (the namespace separator). */
function nameWords(shelf: string): Set<string> {
  return new Set(shelf.toLowerCase().split(/[-.]/).filter((w) => w !== ''));
}

/**
 * Existing shelves that share at least two name words with `shelf` — a purely
 * lexical check (no similarity engine), most shared words first, then name
 * order, capped at `cap`. Catches two sessions coining different descriptive
 * names for the same subject, which edit distance does not.
 */
export function overlappingShelves(dir: string, shelf: string, cap = 3): string[] {
  const mine = nameWords(shelf);
  return listShelves(dir)
    .filter((o) => o !== shelf)
    .map((o) => ({ o, n: [...nameWords(o)].filter((w) => mine.has(w)).length }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n || (a.o < b.o ? -1 : a.o > b.o ? 1 : 0))
    .slice(0, cap)
    .map((x) => x.o);
}

export function addEntry(dir: string, shelf: string, lesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    const text = sanitizeLesson(lesson);
    assertSafeShelf(shelf);
    assertNoCaseVariant(dir, shelf);
    // One scan for entries AND the metadata block, passed through to writeEntries
    // below so the mutation reads the shelf once, not twice (issue #251).
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    if (text === '') return { added: false, reason: 'empty', evicted: null, evictedAll: [], decayed: null, size: entries.length };
    const id = entryId(text);
    const cap = maxChars();
    if (text.length > cap) {
      // Reject rather than truncate: a cut-off lesson is often useless, so the
      // agent should retry with a shorter *complete* one. Report the overflow
      // (`length - cap`) so the retry trims exactly that much rather than
      // guessing how far over it was (issue #239).
      return { added: false, reason: 'too-long', evicted: null, evictedAll: [], decayed: null, size: entries.length, length: text.length, overflow: text.length - cap, id };
    }
    const key = dedupKey(text);
    const collider = entries.find((e) => dedupKey(e.text) === key);
    if (collider) {
      return { added: false, reason: 'duplicate', evicted: null, evictedAll: [], decayed: null, size: entries.length, id, collidedId: entryId(collider.text) };
    }
    // Not an exact-normal-form duplicate (which would have hard-blocked above),
    // but it may still closely *resemble* an existing entry — a paraphrase the
    // literal dedup key cannot catch. Find the most similar one at/above the
    // threshold and attach it so the CLI can raise a NON-blocking advisory. The
    // add proceeds either way (DP-5: a fuzzy match must never cause a silent
    // loss). This also leaves a measurable signal: an accepted add that carried
    // a near-match is a candidate paraphrase-miss.
    const thr = nearThreshold();
    let near: Entry | null = null;
    if (thr > 0) {
      // `thr === 0` disables the advisory (otherwise every add would "resemble"
      // something). The threshold is inclusive (`s >= thr`); among entries that
      // clear it the most similar wins, and a tie resolves to the FIRST in
      // storage order (`s > nearSim`, seeded below threshold) — the earliest,
      // more-established lesson, deterministically.
      let nearSim = -1;
      for (const e of entries) {
        const s = similarity(text, e.text);
        if (s >= thr && s > nearSim) {
          near = e;
          nearSim = s;
        }
      }
    }
    const newEntry: Entry = { score: 1, text };
    entries.push(newEntry); // newcomer lands at the fresh end — storage is recency order
    // Creating a shelf is the one outcome of `add` the agent is not otherwise
    // told about (issue #354). Decide before the write, which creates the file.
    const created = !notebookExists(dir, shelf);
    const similar = created ? overlappingShelves(dir, shelf) : [];
    // Newcomer is protected: a full notebook admits it, ages its stalest line,
    // and evicts the lowest-scored one (never the newcomer). See enforceCap.
    const { kept, evicted, decayed } = enforceCap(entries, 1);
    writeEntries(dir, shelf, kept, metaLines);
    return {
      added: true,
      reason: 'added',
      evicted: evicted[0] ?? null,
      evictedAll: evicted,
      decayed,
      size: kept.length,
      id,
      ...(near ? { nearId: entryId(near.text), nearText: near.text } : {}),
      ...(created ? { created: true as const } : {}),
      ...(similar.length > 0 ? { similarShelves: similar } : {}),
    };
  });
}

/** Entries in DISPLAY order (score desc, then file order — stalest first within a score tie), each tagged with its file-order index. */
function ordered(entries: Entry[]): { e: Entry; idx: number }[] {
  return entries.map((e, idx) => ({ e, idx })).sort((a, b) => b.e.score - a.e.score || a.idx - b.idx);
}

/**
 * A short STABLE id for an entry, derived from its deduped content — not its
 * position. `nb show` prints it and `vote`/`rm`/`merge` accept it, so an agent
 * can promote/demote a specific lesson precisely, and the id does not shift when
 * other lessons are added or reordered between `show` and `vote` (the fragility
 * that made display-order numeric ids unreliable in practice). Collisions
 * between distinct entries are improbable at 6 hex (~16M space); if one ever
 * occurred, that id would simply resolve to neither (ambiguous) and the agent
 * falls back to a text substring — a vote never lands on the wrong lesson.
 */
export function entryId(text: string): string {
  return createHash('sha1').update(dedupKey(text)).digest('hex').slice(0, 6);
}

/** A compact "id  text" list of candidate entries, for an actionable selector error. */
function listHint(items: Entry[], cap = 10): string {
  if (items.length === 0) return '  (none)';
  const lines = items
    .slice(0, cap)
    .map((e) => `  ${entryId(e.text)}  ${e.text.slice(0, 60)}${e.text.length > 60 ? '…' : ''}`);
  if (items.length > cap) lines.push(`  …(${items.length - cap} more — run \`nb show\`)`);
  return lines.join('\n');
}

/**
 * Resolve a selector to a FILE-ORDER index, acting ONLY on a unique match so a
 * vote/rm/merge never lands on the wrong lesson. Order: (1) if the selector is a
 * hex token that UNIQUELY identifies one entry id (exact or prefix), use it;
 * (2) otherwise a case-insensitive text substring, if it uniquely matches one
 * entry. A hex selector that matches zero OR several ids falls through to the
 * substring step (so hex-looking words like "add"/"cafe" resolve as text). If
 * neither step finds exactly one entry, refuse with an error that lists the
 * candidate ids. Numeric position ids are gone: they shifted under reordering
 * and caused mis-votes.
 */
function selectIndex(entries: Entry[], selector: string): number {
  const sel = selector.trim();
  // 1) stable id — use only when it UNIQUELY identifies one entry.
  if (/^[0-9a-f]+$/i.test(sel)) {
    const low = sel.toLowerCase();
    const byId = entries.map((e, i) => ({ e, i })).filter((x) => entryId(x.e.text).startsWith(low));
    if (byId.length === 1) return byId[0].i;
    // 0 or >1 id matches: ambiguous/none as an id — fall through to text match.
  }
  // 2) case-insensitive substring of the lesson text — use only when unique.
  const q = sel.toLowerCase();
  const matches = entries.map((e, i) => ({ e, i })).filter((x) => x.e.text.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0].i;
  // Refuse ambiguity/no-match — but LIST the candidates with their ids so the
  // caller re-votes the real lesson by id instead of re-guessing a keyword
  // (the observed failure: agents vote by a topic word absent from the text).
  if (matches.length === 0) {
    throw new NbError('no_match', `no entry matches ${JSON.stringify(selector)}. Pick the one you mean by its id:\n${listHint(entries)}`);
  }
  throw new NbError('ambiguous_selector', `"${selector}" matches ${matches.length} entries — pick one by its id:\n${listHint(matches.map((x) => x.e))}`);
}

export interface VoteResult {
  text: string;
  score: number;
}

export function vote(dir: string, shelf: string, selector: string, delta: number): Promise<VoteResult> {
  return withLock(dir, () => {
    if (delta !== 1 && delta !== -1) throw new NbError('bad_args', 'vote delta must be +1 or -1');
    // One scan for entries AND the metadata block, passed through to writeEntries
    // below so the mutation reads the shelf once, not twice (issue #251).
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    if (entries.length === 0) throw new NbError('no_match', `notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    entries[idx].score += delta;
    // A vote is a touch: move the entry to the fresh END so storage stays in
    // recency order (least-recently-touched first). Both signs count — a
    // downvote is engagement too. Score is the PRIMARY eviction key, so a low
    // score is what makes a lesson a target; position is only the TIEBREAK, and
    // ties (rows at the +1/0 floor) are common — on a score tie the fresher line
    // survives, so a downvoted-then-touched line IS shielded relative to an
    // equally-scored staler one.
    const [touched] = entries.splice(idx, 1);
    entries.push(touched);
    writeEntries(dir, shelf, entries, metaLines);
    return { text: touched.text, score: touched.score };
  });
}

/** One selector's outcome in a `voteMany` batch (best-effort: one failure never aborts the rest). */
export interface VoteManyItem {
  /** The selector as submitted (so the caller can pair a failure back to its input). */
  selector: string;
  /** The entry's stable id when the vote landed; absent on a failed selector. */
  id?: string;
  /** The entry's full text when the vote landed; absent on a failed selector. */
  text?: string;
  /** The entry's score AFTER the vote; absent on a failed selector. */
  score?: number;
  /** The failure message when this selector did not resolve to exactly one entry; absent on success. */
  error?: string;
}

/**
 * Apply ONE delta to SEVERAL entries of a shelf under a single lock and a single
 * write — the batch form of `vote`, for an end-of-session retro that promotes or
 * demotes a handful of lessons at once (N calls → 1). Best-effort: each selector
 * is resolved independently against the pre-vote array, and a selector that
 * matches zero or several entries is recorded as a failed item WITHOUT aborting
 * the others — so one stale id never loses the whole sweep. Nothing is written
 * if no selector resolved. All selectors are resolved BEFORE any score changes,
 * so the indices never shift mid-batch; the touched entries are then moved to the
 * fresh end in submission order, preserving the recency ordering `vote` keeps.
 * A selector repeated in the same call resolves to the same entry and so votes it
 * more than once (the caller asked for that); callers that want idempotence
 * de-duplicate before calling.
 */
export function voteMany(dir: string, shelf: string, selectors: string[], delta: number): Promise<VoteManyItem[]> {
  return withLock(dir, () => {
    if (delta !== 1 && delta !== -1) throw new NbError('bad_args', 'vote delta must be +1 or -1');
    if (selectors.length === 0) throw new NbError('bad_args', 'vote needs at least one id');
    // One scan for entries AND the metadata block, passed through to writeEntries
    // below so the mutation reads the shelf once, not twice (issue #251).
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    if (entries.length === 0) throw new NbError('no_match', `notebook for shelf "${shelf}" is empty`);
    const results: VoteManyItem[] = [];
    // Resolve every selector against the ORIGINAL array first (indices are only
    // stable before we start moving touched entries to the end). A resolution
    // failure is captured as an item, not thrown, so the rest of the batch runs.
    const hits: { idx: number; selector: string }[] = [];
    for (const selector of selectors) {
      try {
        hits.push({ idx: selectIndex(entries, selector), selector });
      } catch (err) {
        results.push({ selector, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (hits.length === 0) {
      // Every selector failed — write nothing and let the caller report each
      // failure (the CLI exits non-zero because no vote landed).
      return results;
    }
    // Apply the deltas by index (no mutation of positions yet), then reorder the
    // touched entries to the fresh end in first-touch order — the same recency
    // invariant `vote` maintains, extended to a batch. A selector repeated in the
    // batch votes its entry again (score moves per occurrence) but the row is
    // moved to the end ONCE, so the file never gains a duplicate line.
    for (const { idx } of hits) entries[idx].score += delta;
    const seen = new Set<number>();
    const touchedOrder: number[] = [];
    for (const { idx } of hits) {
      if (!seen.has(idx)) {
        seen.add(idx);
        touchedOrder.push(idx);
      }
    }
    const rest = entries.filter((_, i) => !seen.has(i));
    const reordered = [...rest, ...touchedOrder.map((i) => entries[i])];
    writeEntries(dir, shelf, reordered, metaLines);
    for (const { idx, selector } of hits) {
      const e = entries[idx];
      results.push({ selector, id: entryId(e.text), text: e.text, score: e.score });
    }
    return results;
  });
}

export function merge(dir: string, shelf: string, selA: string, selB: string, mergedLesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    // One scan for entries AND the metadata block, passed through to writeEntries
    // below so the mutation reads the shelf once, not twice (issue #251).
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    const ia = selectIndex(entries, selA);
    const ib = selectIndex(entries, selB);
    if (ia === ib) throw new NbError('bad_args', 'merge needs two different entries');
    const sources: [string, string] = [entryId(entries[ia].text), entryId(entries[ib].text)];
    const text = sanitizeLesson(mergedLesson);
    if (text === '') throw new NbError('bad_args', 'merged lesson is empty');
    if (text.length > maxChars()) {
      throw new NbError('too_long', `merged lesson is ${text.length} chars; max is ${maxChars()} — shorten it`);
    }
    // Keep the usefulness: the merged line inherits the higher of the two scores.
    const score = Math.max(entries[ia].score, entries[ib].score);
    const remaining = entries.filter((_, i) => i !== ia && i !== ib);
    // Drop an existing duplicate of the merged text so merge never creates one.
    const key = dedupKey(text);
    const deduped = remaining.filter((e) => dedupKey(e.text) !== key);
    deduped.push({ score, text }); // merged lesson is a fresh touch → fresh end
    // merge consolidates (2 → 1) so it never grows past the cap; enforceCap is a
    // harmless no-op here unless the cap was lowered, in which case the merged
    // lesson is protected like any newcomer.
    const { kept, evicted, decayed } = enforceCap(deduped, 1);
    writeEntries(dir, shelf, kept, metaLines);
    return { added: true, reason: 'added', evicted: evicted[0] ?? null, evictedAll: evicted, decayed, size: kept.length, id: entryId(text), sources };
  });
}

export interface SplitResult {
  /** Notebook size after the split (post-trim). */
  size: number;
  /** Stable id of the original (overloaded) entry that was split out and removed. */
  source: string;
  /** Stable ids of the two entries the split produced, in A,B order. */
  ids: [string, string];
  /** The first (stalest) entry the split's growth (1 → 2) pushed out to stay under cap, or `null`. For the FULL set after a cap decrease, read `evictedAll` (issue #306). */
  evicted: Entry | null;
  /** EVERY entry the split evicted, in storage order (stalest first); one in the ordinary case, many when `NB_MAX_LINES` was lowered below the shelf's size. Empty when none. `evicted` is `evictedAll[0] ?? null`. */
  evictedAll: Entry[];
  /** The stalest survivor the aging step docked −1 (post-dock score), or `null`. */
  decayed: Entry | null;
}

/**
 * The reverse of `merge`: replace one overloaded entry with two, each inheriting
 * the original entry's score. Symmetric with `merge` — it reuses the same
 * selector resolution and the same reject-don't-truncate cap discipline, and it
 * never creates a duplicate: the two halves must differ from each other and from
 * every surviving entry, otherwise the whole split is refused (so the original
 * stays intact). The split is atomic — on any rejection nothing is written.
 */
export function split(
  dir: string,
  shelf: string,
  selector: string,
  lessonA: string,
  lessonB: string,
): Promise<SplitResult> {
  return withLock(dir, () => {
    // One scan for entries AND the metadata block, passed through to writeEntries
    // below so the mutation reads the shelf once, not twice (issue #251).
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    if (entries.length === 0) throw new NbError('no_match', `notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    const original = entries[idx];
    const score = original.score; // both halves inherit the overloaded entry's score

    const textA = sanitizeLesson(lessonA);
    const textB = sanitizeLesson(lessonB);
    for (const [which, text] of [['A', textA], ['B', textB]] as const) {
      if (text === '') throw new NbError('bad_args', `split lesson ${which} is empty`);
      if (text.length > maxChars()) {
        // Reject rather than truncate, exactly as merge/add do: a cut-off lesson
        // is often useless, so the agent retries with a shorter *complete* one.
        throw new NbError('too_long', `split lesson ${which} is ${text.length} chars; max is ${maxChars()} — shorten it`);
      }
    }
    const keyA = dedupKey(textA);
    const keyB = dedupKey(textB);
    if (keyA === keyB) {
      throw new NbError('bad_args', 'the two split lessons are duplicates of each other — split into two distinct lessons');
    }
    // Everything except the entry being split; the split must not duplicate any
    // of these. The original is leaving, so a half may legitimately echo it.
    const remaining = entries.filter((_, i) => i !== idx);
    for (const [which, key, text] of [['A', keyA, textA], ['B', keyB, textB]] as const) {
      const collider = remaining.find((e) => dedupKey(e.text) === key);
      if (collider) {
        throw new NbError(
          'bad_args',
          `split lesson ${which} ("${text}") duplicates an existing entry (${entryId(collider.text)}) — a split never creates a duplicate`,
        );
      }
    }
    remaining.push({ score, text: textA }, { score, text: textB }); // both halves fresh → fresh end
    // split grows by one (1 → 2); if that overflows a full notebook both halves
    // are protected (admitted) and the stalest OTHER line ages/evicts.
    const { kept, evicted, decayed } = enforceCap(remaining, 2);
    writeEntries(dir, shelf, kept, metaLines);
    return { size: kept.length, source: entryId(original.text), ids: [entryId(textA), entryId(textB)], evicted: evicted[0] ?? null, evictedAll: evicted, decayed };
  });
}

export function remove(dir: string, shelf: string, selector: string): Promise<VoteResult> {
  return withLock(dir, () => {
    // Read entries AND the metadata block in one scan: the reap below must tell a
    // described-but-empty notebook (kept) from a true phantom (reaped), issue #209.
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    if (entries.length === 0) throw new NbError('no_match', `notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    const [gone] = entries.splice(idx, 1);
    // An emptied UNDESCRIBED shelf is reaped by writeEntries (issues #209, #355).
    writeEntries(dir, shelf, entries, metaLines);
    return { text: gone.text, score: gone.score };
  });
}

export interface MoveResult {
  /** `moved` on success; `duplicate` when the target already holds the lesson (nothing was written). */
  reason: 'moved' | 'duplicate';
  /** The moved lesson's text. */
  text: string;
  /** The moved entry's score — carried across intact (the whole point of `move`). */
  score: number;
  /** Stable id of the moved entry (same in both shelves — the id is content-derived). */
  id: string;
  /** Source shelf's entry count after the move (unchanged on `duplicate`). */
  fromSize: number;
  /** Target shelf's entry count after the move (unchanged on `duplicate`). */
  toSize: number;
  /** The first (stalest) target entry the insert pushed out to stay under cap, or `null`. For the FULL set after a cap decrease, read `evictedAll` (issue #306). */
  evicted: Entry | null;
  /** EVERY entry the move evicted from the target, in storage order (stalest first); one in the ordinary case, many when `NB_MAX_LINES` was lowered below the target's size. Empty when none. `evicted` is `evictedAll[0] ?? null`. */
  evictedAll: Entry[];
  /** The stalest target entry the aging step docked −1 (post-dock score), or `null`. */
  decayed: Entry | null;
  /** For `duplicate`: the id of the existing target entry that blocked the move. */
  collidedId?: string;
}

/**
 * Move one entry from `fromShelf` to `toShelf` WITH ITS SCORE INTACT — the
 * score-preserving cross-shelf relocation that `add`+`rm` cannot express (add
 * always enters at the +1 floor, discarding hard-won vote capital). It is the
 * tool-owned inverse of "shelves are chosen by situation": when two situations
 * turn out to be one, their shelves can be consolidated without the tool
 * resetting scores (issue #103).
 *
 * The entry lands in the target as a PROTECTED newcomer at the fresh end, exactly
 * like `add` — so a full target admits it, ages/evicts its stalest OTHER line, and
 * never drops the lesson just moved (no loss of a voted lesson), while its score
 * is carried over unchanged (the aging step only docks a stale *survivor*, never
 * the protected newcomer). The move is refused, writing NOTHING to either shelf,
 * when: the source and target are the same shelf; the source is empty; the
 * selector is absent/ambiguous (same unique-match rule as vote/rm/merge, so a
 * move never relocates the wrong lesson); or the target already holds a
 * near-duplicate (same dedup rule as `add`/`merge` — a move never creates a
 * duplicate). On success the TARGET is written first (the lesson is persisted
 * there before it leaves the source), so an interruption between the two writes
 * duplicates the lesson across shelves rather than losing it.
 */
export function move(dir: string, fromShelf: string, toShelf: string, selector: string): Promise<MoveResult> {
  return withLock(dir, () => {
    assertSafeShelf(fromShelf);
    assertSafeShelf(toShelf);
    if (fromShelf === toShelf) {
      throw new NbError('bad_args', `move needs two different shelves (source and target are both "${fromShelf}")`);
    }
    const sourceRead = readShelf(dir, fromShelf);
    assertNotConflicted(fromShelf, sourceRead.conflict);
    const source = sourceRead.entries;
    if (source.length === 0) throw new NbError('no_match', `notebook for shelf "${fromShelf}" is empty`);
    const idx = selectIndex(source, selector);
    const moving = source[idx];
    const id = entryId(moving.text);
    assertNoCaseVariant(dir, toShelf);
    const targetRead = readShelf(dir, toShelf);
    assertNotConflicted(toShelf, targetRead.conflict);
    const target = targetRead.entries;
    const key = dedupKey(moving.text);
    const collider = target.find((e) => dedupKey(e.text) === key);
    if (collider) {
      // The target already holds this lesson — refuse and write NOTHING, so the
      // source copy stays intact and the caller can `rm`/`vote` it deliberately
      // rather than silently discarding one of the two. Same dedup rule as `add`.
      return {
        reason: 'duplicate',
        text: moving.text,
        score: moving.score,
        id,
        fromSize: source.length,
        toSize: target.length,
        evicted: null,
        evictedAll: [],
        decayed: null,
        collidedId: entryId(collider.text),
      };
    }
    // Insert with the score intact as a protected newcomer at the fresh end; a full
    // target then ages/evicts its stalest OTHER line, never this one (see enforceCap).
    const moved: Entry = { score: moving.score, text: moving.text };
    target.push(moved);
    const { kept, evicted, decayed } = enforceCap(target, 1);
    // Write the TARGET first (lesson now persisted there), then drop it from the
    // source. An interruption between the two leaves a duplicate, never a loss.
    writeEntries(dir, toShelf, kept);
    const remaining = source.filter((_, i) => i !== idx);
    writeEntries(dir, fromShelf, remaining);
    return {
      reason: 'moved',
      text: moved.text,
      score: moved.score,
      id,
      fromSize: remaining.length,
      toSize: kept.length,
      evicted: evicted[0] ?? null,
      evictedAll: evicted,
      decayed,
    };
  });
}

/** The `desc` metadata key: a notebook's optional one-line description/trigger. */
export const DESC_KEY = 'desc';

/**
 * The handled refusal a MUTATION raises when its shelf holds a git merge-conflict
 * marker (issue #333). The shelf read as-is for a read command, but rewriting it
 * (add/vote/merge/split/rm/move/describe) would persist the marker lines as real
 * lessons and erase the signal that a merge still needs resolving — so the write
 * is refused, the file is left byte-identical, and the message names the shelf and
 * the first offending line so the caller can run `git merge` / fix the file first.
 * Classified `corrupt` in the usage log so `nb stats` can surface it.
 */
function assertNotConflicted(shelf: string, conflict: string | null): void {
  if (conflict === null) return;
  throw new NbError(
    'corrupt',
    `notebook for shelf "${shelf}" contains a git merge-conflict marker (${JSON.stringify(conflict)}) — ` +
      `resolve the merge conflict in ${shelf}.md first; refusing to rewrite it`,
  );
}

export interface DescribeResult {
  /** @deprecated use shelf */
  role: string;
  shelf: string;
  /** The description after the call: the new text when set, or the current text when read. `null` when none is set. */
  desc: string | null;
  /** True when this call wrote a new description; false for a read-only query. */
  set: boolean;
}

/**
 * Read a notebook's one-line description (the `# desc:` metadata value), or
 * `null` if none is set. Read-only and lock-free — it only inspects the leading
 * metadata block.
 */
export function getDescription(dir: string, shelf: string): string | null {
  return getMetaValue(readMetaLines(dir, shelf), DESC_KEY);
}

/**
 * Set (or clear) a notebook's one-line description, stored as a leading
 * `# desc: <text>` metadata line. The text is sanitized to one line and capped
 * exactly like a lesson — an over-`maxChars` description is REJECTED, not
 * truncated ([DP-5] / [FR-ADD-004]), so the agent rewrites a shorter *complete*
 * line. An empty (post-sanitize) text clears the description. Every other
 * metadata key and all entries are preserved verbatim (round-trip), and the
 * write goes through the same durable, locked path as any mutation.
 */
export function setDescription(dir: string, shelf: string, text: string): Promise<DescribeResult> {
  return withLock(dir, () => {
    const clean = sanitizeLesson(text);
    if (clean.length > maxChars()) {
      // Reject rather than truncate, exactly as add/merge/split do.
      throw new NbError('too_long', `description is ${clean.length} chars; max is ${maxChars()} — shorten it`);
    }
    assertSafeShelf(shelf);
    assertNoCaseVariant(dir, shelf);
    const { metaLines, entries, conflict } = readShelf(dir, shelf);
    assertNotConflicted(shelf, conflict);
    const meta = setMetaValue(metaLines, DESC_KEY, clean);
    writeEntries(dir, shelf, entries, meta);
    return { role: shelf, shelf, desc: clean === '' ? null : clean, set: true };
  });
}

/** One entry in a {@link ShowResult}: its stable id, current score, and lesson text. */
export interface ShowEntry {
  id: string;
  score: number;
  text: string;
  /**
   * The `dedupKey` normal form of `text` (issue #286) — the one value a consumer
   * cannot reproduce without reimplementing nb's normalization. Two entries with
   * an EQUAL `key` are exact duplicates the caller can drop itself, so a harness
   * composing context from several shelves can strip exact cross-shelf dupes
   * without a round-trip into nb. Equality-only on purpose: it is never a
   * similarity, ranking, or near-dup signal ([NG-001]). Distinct from `id`, which
   * is a hash of the same normal form — `key` is the readable form the caller
   * compares on; two entries share a `key` iff they share an `id`.
   */
  key: string;
}

/**
 * The structured form of `nb show`: the shelf, its one-line description (or
 * `null` when none is set), and its entries highest-score-first with an
 * insertion-order tie-break — the exact order `render()` prints.
 */
export interface ShowResult {
  /** @deprecated use shelf */
  role: string;
  shelf: string;
  description: string | null;
  entries: ShowEntry[];
  /**
   * Whether the shelf file exists on disk. An additive field (issue #166): it
   * lets a consumer tell a never-created shelf (`exists: false`) from an existing
   * one that holds no lessons (`exists: true`, `entries: []`), which both yield an
   * empty `entries` array. Kept distinct from `entries` so the array stays
   * backward-compatible.
   */
  exists: boolean;
}

/**
 * The machine-readable sibling of `render()`, for `nb show <shelf> --json`. It
 * reuses the same `ordered(readEntries(...))` ordering and the same stable
 * `entryId`, so an agent recovers each entry's id/score/text without
 * regex-parsing the human output `render()` produces. An empty notebook yields
 * an empty `entries` array and a `null` description — never an error. The
 * additive `exists` flag distinguishes a never-created shelf from an existing
 * empty one (issue #166), both of which have `entries: []`.
 */
export function showJson(dir: string, shelf: string): ShowResult {
  // One read for both entries and description (issue #201): the structured show
  // used to read the shelf twice (readEntries + getDescription→readMetaLines).
  const { metaLines, entries } = readShelf(dir, shelf);
  const ord = ordered(entries);
  return {
    role: shelf,
    shelf,
    description: stripControlCharsNullable(getMetaValue(metaLines, DESC_KEY)),
    entries: ord.map((x) => ({
      id: entryId(x.e.text),
      score: x.e.score,
      text: stripControlChars(x.e.text),
      key: dedupKey(x.e.text),
    })),
    exists: notebookExists(dir, shelf),
  };
}

/**
 * Batch form of {@link showJson} for `nb show <a> <b> <c> --json` (issue #286):
 * one {@link ShowResult} per shelf, in the given order, produced in a single
 * process so a caller composes its own context from several shelves in one
 * consistent snapshot instead of spawning nb N times. A named shelf with no file
 * yields `exists: false` (never a silent empty), and each entry carries its
 * `key` so the caller drops *exact* cross-shelf duplicates itself. nb does NO
 * cross-shelf dedup, ordering, scope precedence, or budgeting here — those are
 * caller policy ([NG-007]); a repeated shelf in `shelves` is read (and returned)
 * once per occurrence, verbatim.
 */
export function showJsonMany(dir: string, shelves: string[]): ShowResult[] {
  return shelves.map((shelf) => showJson(dir, shelf));
}

/** One cull candidate in a {@link StaleResult}: its stable id, current score, and lesson text. */
export interface StaleEntry {
  id: string;
  score: number;
  text: string;
}

/**
 * The structured form of `nb stale`: the shelf, its total lesson count (before
 * `limit`, so a caller can render "N of M"), the cull candidates most-disposable
 * first, and the `exists` flag that tells a never-created shelf from an existing
 * empty one (issue #166), both of which have `entries: []`.
 */
export interface StaleResult {
  shelf: string;
  /** Total lessons on the shelf BEFORE `limit` — so a caller can say "showing N of total". */
  total: number;
  /** Cull candidates, most-disposable first: lowest score, ties → stalest (lowest file index). Truncated to `limit`. */
  entries: StaleEntry[];
  /** Whether the shelf file exists on disk (issue #166), so `exists: false` + `entries: []` is a missing shelf, not an empty one. */
  exists: boolean;
}

/**
 * Rank a shelf's lessons by eviction priority — the order {@link enforceCap}
 * would drop them in when a notebook overflows: **lowest score first, ties
 * broken by stalest** (lowest file index = least-recently-touched). It mirrors
 * `enforceCap` step 2's comparator minus the newcomer protection, because every
 * lesson is a candidate here, and is strictly read-only: it never changes a
 * score or removes anything.
 *
 * Its job is to revive the dormant curation loop (issue #240, spun off from the
 * #223 audit's F3/F4): eviction only ever acts at the 50-line cap, so on a
 * sub-cap shelf nothing is ever culled and a wrong `+1` lesson persists forever.
 * `nb stale` surfaces the same ranking on ANY shelf so the retrospective can
 * downvote or `rm` the weakest lessons by id. `limit` caps the list (most
 * disposable first); `undefined` returns all. A missing/empty shelf yields an
 * empty `entries` array, never an error.
 */
export function staleCandidates(dir: string, shelf: string, limit?: number): StaleResult {
  const entries = readEntries(dir, shelf);
  const ranked = entries
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => a.e.score - b.e.score || a.idx - b.idx);
  const capped = limit === undefined ? ranked : ranked.slice(0, Math.max(0, limit));
  return {
    shelf,
    total: entries.length,
    entries: capped.map((x) => ({ id: entryId(x.e.text), score: x.e.score, text: stripControlChars(x.e.text) })),
    exists: notebookExists(dir, shelf),
  };
}

/** Render a notebook for injection / `show`: a stable id + score, highest score first (most useful on top). */
export function render(dir: string, shelf: string): string {
  return renderEntries(shelf, readEntries(dir, shelf));
}

/**
 * Render a shelf's already-read entries — the single-read core of {@link render}.
 * `render` reads the file itself; a caller that already holds the entries (the
 * `show` command, which reads the shelf once via {@link readShelf}) calls this
 * directly so it does not re-read the file (issue #201). Output is byte-identical
 * to the old inline rendering, including the "(… is empty)" line for no entries.
 */
export function renderEntries(shelf: string, entries: Entry[]): string {
  const ord = ordered(entries);
  if (ord.length === 0) return `(notebook for shelf "${shelf}" is empty)`;
  return ord
    .map((x) => {
      const s = x.e.score >= 0 ? `+${x.e.score}` : `${x.e.score}`;
      return `${entryId(x.e.text)}  [${s}]  ${stripControlChars(x.e.text)}`;
    })
    .join('\n');
}

/**
 * The shelves that have a notebook, as sorted file stems. A shelf file is
 * `<shelf>.md`; the sidecar `.nb-usage.log` and `.nb.lock` share the directory
 * and are excluded by keeping only non-dotfile `*.md` entries (dotfiles like a
 * hypothetical `.foo.md` are skipped too — a shelf name never starts with `.`,
 * per `assertSafeShelf`). A `README.md` (case-insensitive) is excluded too: it is
 * the conventional git/backup artifact in a notebook folder, not a notebook
 * (issue #90) — the reserved name keeps a write command from ever creating one.
 * An absent/empty notebooks dir yields `[]` (not an error), so `nb list` can
 * report "no notebooks yet" and exit 0 on a clean machine.
 */
export function listShelves(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // dir does not exist yet (nothing has been written)
  }
  return names
    .filter((n) => !n.startsWith('.') && n.endsWith('.md') && n.toLowerCase() !== 'readme.md')
    .map((n) => n.slice(0, -'.md'.length))
    .sort();
}

/** @deprecated use listShelves — same function, kept so existing callers keep working. */
export const listRoles = listShelves;

/** One row of the notebook index (`nb list`): a notebook's name, lesson count, and the one-line trigger used to decide whether to open it. */
export interface NotebookSummary {
  /** @deprecated use shelf */
  role: string;
  shelf: string;
  /** Stored lesson count (what the cap counts and `trim` evicts against); `0` for a described-but-empty notebook. */
  lessons: number;
  /** The explicit `# desc:` description, or `null` when none is set. */
  desc: string | null;
  /** When `desc` is `null`, the top-scored lesson used as an `(auto)` fallback trigger; `null` when the notebook has no lessons. */
  auto: string | null;
}

/**
 * A shelf that a cross-shelf scan (`listNotebooks` / `search`) could not read and
 * therefore skipped (issue #332). `code` is the errno code from the filesystem
 * (e.g. `EACCES`, `EISDIR`, `EIO`); `ENOENT` never appears because `readShelf`
 * already treats it as an empty shelf. Only a throw carrying a real errno `code`
 * is skipped — a codeless throw (a parser bug) still propagates, so this field
 * never invents a non-errno token. Surfaced so one unreadable file cannot
 * silently vanish from the index: `nb list`/`nb search`/`nb stats` report it on
 * stderr and in `--json`, while still succeeding for every healthy shelf.
 */
export interface SkippedShelf {
  /** The shelf whose `<shelf>.md` failed to read. */
  shelf: string;
  /** The errno code of the read failure (`EACCES`, `EISDIR`, `EIO`, …). */
  code: string;
}

/**
 * A shelf whose file holds an unresolved git merge-conflict marker (issue #333).
 * A read command still reads it exactly as before (so `show`/`list`/`search`/
 * `stale` output is unchanged and `--json` stays valid) but names it in one
 * stderr warning; a mutation refuses instead of rewriting the markers in as real
 * lessons. `marker` is the first offending line, so the caller can say WHICH line
 * (and thus which side of a merge) needs resolving.
 */
export interface ConflictShelf {
  /** The shelf whose `<shelf>.md` holds a conflict marker. */
  shelf: string;
  /** The first merge-conflict marker line found in the file. */
  marker: string;
}

/**
 * Run `fn` for one shelf, returning `undefined` (and the errno code) instead of
 * throwing when the read fails with anything but `ENOENT` (which `readShelf`
 * already swallows as an empty shelf). Shared by the two cross-shelf scans so a
 * single unreadable file degrades to a reported skip rather than aborting the
 * whole index (issue #332). Single-shelf commands keep calling `readShelf`
 * directly, so an explicitly named bad shelf still fails loudly.
 */
function skipUnreadable<T>(shelf: string, fn: () => T): { value?: T; error?: SkippedShelf } {
  try {
    return { value: fn() };
  } catch (err) {
    // Only a filesystem read failure is a skippable shelf: the error carries an
    // errno `code` (EACCES/EISDIR/EIO/…). Anything else — a parser TypeError on
    // malformed input with no `code`, an out-of-memory, a programming bug — is a
    // real defect, not a damaged file, so it must keep propagating rather than
    // become a silent "shelf skipped" (the issue's intent is to surface a broken
    // file, never to swallow a code bug).
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (typeof code !== 'string' || code === '') throw err;
    return { error: { shelf, code } };
  }
}

export interface ListOptions {
  /** Keep only notebooks whose shelf name starts with this prefix (the `.` namespace convention, e.g. `review.`). An empty/absent prefix keeps all. */
  prefix?: string;
  /** Cap the number of rows returned (richest-first), so discovery cost stays flat as notebooks grow. `undefined` → no cap; a negative cap is treated as `0`. */
  limit?: number;
}

export interface NotebookListing {
  dir: string;
  /** Matching notebooks after the prefix + empty-notebook filters, BEFORE `limit` — so a caller can render "showing N of total". */
  total: number;
  /** The rows actually returned: richest-first (by lesson count), ties by name, truncated to `limit`. */
  rows: NotebookSummary[];
  /**
   * Shelves whose file could not be read and were skipped (issue #332), so one
   * unreadable `<shelf>.md` does not abort the whole index. Empty on a healthy
   * store, so the field is absent from healthy output's spirit (always `[]` here,
   * but the CLI omits it when empty).
   */
  skipped: SkippedShelf[];
  /**
   * Shelves whose file holds a git merge-conflict marker (issue #333), so the
   * index row is still shown (the lessons read as before) but the CLI warns on
   * stderr that the shelf must be resolved. Empty on a healthy store, so the
   * `--json` field is emitted only when non-empty (healthy output is unchanged).
   */
  conflicts: ConflictShelf[];
}

/**
 * The notebook index (issue #71): one richest-first summary row per notebook —
 * name, lesson count, and a one-line description (the `# desc:` trigger, or the
 * top-scored lesson as an `(auto)` fallback). This is level 1 of progressive
 * disclosure: an agent reads it to decide WHICH notebook to open without reading
 * any notebook's lessons. Richest-first (more lessons ⇒ more worth reusing),
 * ties broken by name for determinism. `prefix` filters by the `.`-namespace
 * convention; `limit` bounds the output.
 *
 * A zero-lesson notebook with NO description is hidden: it is phantom debris (an
 * `nb describe <shelf> ""` that left an empty file, or an `rm` of the last
 * lesson) with nothing to discover. A described-but-empty notebook is a
 * deliberate trigger and is kept, so an agent can see a placeholder it set up.
 */
export function listNotebooks(dir: string, opts: ListOptions = {}): NotebookListing {
  const prefix = opts.prefix ?? '';
  const skipped: SkippedShelf[] = [];
  const conflicts: ConflictShelf[] = [];
  const matches = listShelves(dir)
    .filter((shelf) => shelf.startsWith(prefix))
    .map((shelf): NotebookSummary | null => {
      // One read per shelf for both the lesson count and the description (issue
      // #201): the index used to read each file twice (readEntries + getDescription).
      // A non-ENOENT read failure skips just this shelf and is reported (issue
      // #332) so one unreadable file cannot take down the whole index.
      const read = skipUnreadable(shelf, () => readShelf(dir, shelf));
      if (read.error) {
        skipped.push(read.error);
        return null;
      }
      const { metaLines, entries, conflict } = read.value!;
      if (conflict !== null) conflicts.push({ shelf, marker: conflict });
      const desc = stripControlCharsNullable(getMetaValue(metaLines, DESC_KEY));
      // Fall back to the top-scored lesson only when there is no explicit
      // description; `ordered` is score-desc with an insertion-order tie-break.
      const auto = desc === null && entries.length > 0 ? stripControlChars(ordered(entries)[0].e.text) : null;
      return { role: shelf, shelf, lessons: entries.length, desc, auto };
    })
    .filter((n): n is NotebookSummary => n !== null)
    .filter((n) => n.lessons > 0 || n.desc !== null);
  matches.sort((a, b) => b.lessons - a.lessons || a.shelf.localeCompare(b.shelf));
  const { limit } = opts;
  const rows = limit != null ? matches.slice(0, Math.max(0, limit)) : matches;
  return { dir, total: matches.length, rows, skipped, conflicts };
}

// ---------------------------------------------------------------------------
// search — the demoted keyword fallback (issue #82)
// ---------------------------------------------------------------------------

/** One matching lesson in a `search` result: its stable id, score, text, and how many query terms it matched. */
export interface SearchHit {
  /** Stable entry id — printed so the agent can `vote`/`rm` it later. */
  id: string;
  /** The entry's current vote score. */
  score: number;
  /** The lesson text. */
  text: string;
  /** How many DISTINCT query terms appear in this entry's text (the first rank key). */
  matched: number;
}

/** One notebook's slice of a `search` result: its matching lessons (and whether the query hit its description). */
export interface SearchGroup {
  /** @deprecated use shelf */
  role: string;
  shelf: string;
  /** The notebook's `# desc:` description (also searched), or `null` when none is set. */
  desc: string | null;
  /** True when the query matched the notebook's description — so a notebook surfaces even with zero entry hits. */
  descMatched: boolean;
  /** Matching entries, best-first: more terms matched, then higher score, then file order. */
  hits: SearchHit[];
}

export interface SearchOptions {
  /** Scope to notebooks whose shelf name starts with this prefix (the `.` namespace convention). Empty/absent → all. */
  prefix?: string;
  /** OR-over-terms instead of the default AND (a hit needs every term). */
  any?: boolean;
  /**
   * Cap the number of notebook `groups` returned, after ranking — so `search`
   * stays bounded as notebooks grow, exactly as `--limit` bounds `nb list`
   * (issue #186). Absent → unbounded (the CLI supplies its own default). A
   * negative value clamps to `0`. Only `groups` is bounded: `total` and
   * `surfacedIds` are always the FULL pre-limit result, so the limit never
   * perturbs the gap-sensor outcome or #114 surfacing provenance.
   */
  limit?: number;
}

export interface SearchResult {
  /** The lowercased, whitespace-split query terms actually searched; empty when the query had no word tokens. */
  terms: string[];
  /** Matching notebooks, most-relevant-first (by their best hit); description-only matches sort last. Bounded to `opts.limit` (issue #186); empty on no match. */
  groups: SearchGroup[];
  /**
   * Total matching notebooks BEFORE `limit` (mirrors `NotebookListing.total`).
   * The `failed-search → add` gap-sensor keys on `total > 0`, NOT on
   * `groups.length`, so a small `--limit` (even `0`) can never flip a real
   * match into a `no-match` in the usage log (issue #186, preserving #114).
   */
  total: number;
  /**
   * Every entry id surfaced across the FULL pre-`limit` result, best-first —
   * the #114 surfacing provenance the usage log records. Kept on the full
    * result so the serendipity proxy stays independent of the display `limit`
    * and keeps its documented conservative (one-sided) bias (issue #186).
    */
  surfacedIds: string[];
  /**
   * Shelves whose file could not be read and were skipped (issue #332), so one
   * unreadable `<shelf>.md` does not abort the whole search. Empty on a healthy
   * store.
   */
  skipped: SkippedShelf[];
  /**
   * Shelves in scope whose file holds a git merge-conflict marker (issue #333);
   * their lessons are still searched (a read is never refused) but the CLI warns
   * on stderr. Empty on a healthy store.
   */
  conflicts: ConflictShelf[];
}

/**
 * Keyword scan across every notebook's entries and description — the **demoted
 * fallback** of [NG-007]: surfacing (injection + the index) is the primary path,
 * and this exists for genuine known-item lookup and, just as valuably, as a
 * *gap-sensor* (a `no-match` search the CLI logs so a `failed-search → add` can be
 * read back as a coverage gap). Deliberately keyword-only — plain lowercased
 * substring over terms, no embeddings or similarity ranking ([NG-001]); a whole
 * notebook is ≤`maxLines` short lines, so scanning them all is instant ([DP-6]).
 *
 * The query is split on whitespace into terms; a term matches as a case-insensitive
 * substring. Default is AND (an entry must contain every term); `any` makes it OR.
 * An entry is a hit on its own text; the description is matched separately, so a
 * notebook whose description matches surfaces (with any entry hits) even when no
 * single entry contains the terms. Hits rank by terms-matched, then score, then
 * file order; groups rank by their best hit (description-only matches last), ties
 * by shelf name — all deterministic.
 */
export function search(dir: string, query: string, opts: SearchOptions = {}): SearchResult {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (terms.length === 0) return { terms: [], groups: [], total: 0, surfacedIds: [], skipped: [], conflicts: [] };
  const prefix = opts.prefix ?? '';
  const needAll = !opts.any;
  const isHit = (matched: number): boolean => (needAll ? matched === terms.length : matched >= 1);
  const countTerms = (hay: string): number => {
    const low = hay.toLowerCase();
    return terms.reduce((n, t) => (low.includes(t) ? n + 1 : n), 0);
  };

  const groups: SearchGroup[] = [];
  const skipped: SkippedShelf[] = [];
  const conflicts: ConflictShelf[] = [];
  for (const shelf of listShelves(dir).filter((r) => r.startsWith(prefix))) {
    // One read per shelf for both entries and description (issue #201): the
    // keyword scan used to read each file twice (readEntries + getDescription).
    // A non-ENOENT read failure skips just this shelf and is reported (issue
    // #332) so one unreadable file cannot take down the whole search.
    const read = skipUnreadable(shelf, () => readShelf(dir, shelf));
    if (read.error) {
      skipped.push(read.error);
      continue;
    }
    const { metaLines, entries, conflict } = read.value!;
    if (conflict !== null) conflicts.push({ shelf, marker: conflict });
    const desc = stripControlCharsNullable(getMetaValue(metaLines, DESC_KEY));
    // Tag each hit with its file-order index so equal (matched, score) hits keep a
    // stable, insertion-order sequence ([DP-3]); the index is dropped from output.
    const tagged = entries
      .map((e, idx) => ({ e, idx, matched: countTerms(e.text) }))
      .filter((x) => isHit(x.matched));
    const descMatched = desc !== null && isHit(countTerms(desc));
    if (tagged.length === 0 && !descMatched) continue;
    tagged.sort((a, b) => b.matched - a.matched || b.e.score - a.e.score || a.idx - b.idx);
    groups.push({
      role: shelf,
      shelf,
      desc,
      descMatched,
      hits: tagged.map((x) => ({ id: entryId(x.e.text), score: x.e.score, text: stripControlChars(x.e.text), matched: x.matched })),
    });
  }

  // Most-relevant notebook first: best hit's term-match count, then its score; a
  // description-only match (no hits) ranks as 0 and sorts last. Ties by shelf name.
  groups.sort((a, b) => {
    const am = a.hits[0]?.matched ?? 0;
    const bm = b.hits[0]?.matched ?? 0;
    const as = a.hits.length ? a.hits[0].score : -Infinity;
    const bs = b.hits.length ? b.hits[0].score : -Infinity;
    return bm - am || bs - as || a.shelf.localeCompare(b.shelf);
  });

  // The gap-sensor outcome (`total`) and #114 surfacing provenance
  // (`surfacedIds`) are computed on the FULL ranked result; only the returned
  // `groups` are bounded. So `--limit 0` still reports a `match` and still
  // records which ids the query reached — the limit shapes output, never the log.
  const total = groups.length;
  const surfacedIds = groups.flatMap((g) => g.hits.map((h) => h.id));
  const bounded = opts.limit != null ? groups.slice(0, Math.max(0, opts.limit)) : groups;
  return { terms, groups: bounded, total, surfacedIds, skipped, conflicts };
}

// ---------------------------------------------------------------------------
// usage log + monitoring
// ---------------------------------------------------------------------------

/**
 * The fixed, small error-class enum (issue #176). When a command exits non-zero
 * the usage log records ONE of these terse tokens so `nb stats` can split a
 * high-error-rate anomaly by cause (over-length vs misuse vs ambiguous selector)
 * instead of flagging an undiagnosable "41% errors". It is deliberately a closed
 * enum of code-chosen tokens — never free text, never user input, never a lesson
 * or a PII-bearing message — consistent with the log's terse TSV contract and the
 * data-protection rule that only bounded, non-user values enter the log. `other`
 * is the escape hatch (and the growth thermostat, like `REASON_ENUMS`): an error
 * that is not yet classified falls here rather than inventing a speculative code.
 */
export const ERROR_CLASSES = [
  'too_long', // a lesson/description/split/merge over the char cap was rejected
  'ambiguous_selector', // a selector matched >1 entry — the caller must pick by id
  'no_match', // a selector matched no entry (and no notebook/shelf to act on)
  'multiline_refused', // `add … -` was piped more than one line
  'bad_args', // a missing/malformed argument or flag, or an invalid shelf name
  'corrupt', // a mutation refused because the shelf holds a git merge-conflict marker (issue #333)
  'unknown_subcommand', // an unknown `nb` command (agents guessing names)
  'other', // anything not (yet) classified — the escape hatch
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/**
 * An error that carries its `ErrorClass` so the CLI's log-write path can record a
 * bounded cause WITHOUT parsing the (user-influenced, drift-prone) message. The
 * message is unchanged from a plain `Error`, so existing stderr output and tests
 * are byte-identical — only the extra `errorClass` field is new. Thrown at the
 * semantically-meaningful sites (selector resolution, over-length rejection,
 * argument validation); everything else stays a plain `Error` and classifies as
 * `other` via `classifyError`.
 */
export class NbError extends Error {
  readonly errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string) {
    super(message);
    this.name = 'NbError';
    this.errorClass = errorClass;
  }
}

/**
 * Map a thrown value to its `ErrorClass`. An `NbError` reports its own class; any
 * other throw (a plain `Error`, a lock timeout, an unexpected bug) is `other` —
 * so the log never guesses a cause from message text. The CLI calls this in its
 * catch block to fill the usage row's error-class column for a non-zero exit.
 */
export function classifyError(e: unknown): ErrorClass {
  return e instanceof NbError ? e.errorClass : 'other';
}

export interface UsageRow {
  ts: string;
  role: string;
  command: string;
  ok: boolean;
  ms: number;
  /** Session id (from `NB_SESSION`) the call ran under; `''` when unset. */
  session: string;
  /** Stable id(s) of the entry/entries the call touched — or, for a `search`, the ids it SURFACED (issue #114, for serendipity provenance); `[]` when none. */
  entries: string[];
  /** Outcome token: `accepted`/`dedup-blocked`/`rejected-full`/`empty`/`too-long` (add), `up`/`down` (vote), `removed` (rm), `merged` (merge), `split` (split), `moved`/`move-blocked` (move; `move-blocked` = the target already held a near-duplicate), `match`/`no-match`/`no-terms` (search, with the query in `note` and, for a `match`, the surfaced ids in `entries` — issue #114; `no-terms` = the query had no searchable tokens, so it is NOT a coverage gap); `''` otherwise. */
  outcome: string;
  /** For a `dedup-blocked` add: the id of the existing entry that blocked it; `''` otherwise. */
  collided: string;
  /** For an add that evicted: `<id>:<finalScore>` of the entry that left; `''` otherwise. */
  evicted: string;
  /** Per-operation reason code (e.g. `overloaded`/`other` for split); `''` when none was given. */
  reason: string;
  /** Optional free-text note accompanying the reason; `''` when none. */
  note: string;
  /** Terse error-class token (`ERROR_CLASSES`) when the call exited non-zero; `''` on success and on pre-#176 rows. */
  errorClass: string;
  /** For a write that aged a line (issue #293): `<id>:<postDockScore>` of the stalest survivor docked −1 by the cap's anti-immortality step; `''` otherwise and on pre-#293 rows. */
  decayed: string;
  /** Crash recovery performed during this call (issue #309): `<lockSteals>:<tempReaps>` — stale locks stolen and leftover temps reaped while acquiring the lock, each count a sign a prior nb died mid-write; `''` when none (the common case) and on pre-#309 rows. */
  recovered: string;
  /** Batch-vote partial selector misses (issue #310): the count of ids that did NOT resolve in a ≥1-landed batch `vote`. That call exits 0 (`ok=true`) so its misses never reach the err-rate table; recording the count here lets `nb stats` fold them into the vote error-cause readout instead of laundering "voting on ids that no longer exist" out of it. `0` when none (the common case) and on pre-#310 rows. Trailing column. */
  misses: number;
}

/**
 * The richer per-call fields `logUsage` records beyond ts/shelf/command/ok/ms.
 * All optional: the caller fills only what its command produced (a `show` fills
 * none), and `session` defaults to `NB_SESSION`. This is deliberately a log
 * schema, not a notebook one — it leaves the lesson a plain string ([NG-004]),
 * so none of this adds a field to an entry.
 */
export interface UsageMeta {
  /** Overrides `NB_SESSION`; mainly for tests. Absent → read `process.env.NB_SESSION`. */
  session?: string;
  /** Stable ids the call touched (added/voted/removed, or merge's sources + result), or the ids a `search` surfaced (issue #114). */
  entries?: string[];
  /** Outcome token (see `UsageRow.outcome`). */
  outcome?: string;
  /** Colliding entry id for a `dedup-blocked` add. */
  collided?: string;
  /** `<id>:<finalScore>` of an evicted entry. */
  evicted?: string;
  /** Per-operation reason code (validated/normalized via `normalizeReason`). */
  reason?: string;
  /** Optional free-text note accompanying the reason. */
  note?: string;
  /**
   * Error class to record when this call exited non-zero (issue #176). Set only
   * by the CLI's failure paths — on a success it is absent and the column is
   * blank. A fixed enum value (`ErrorClass`), never free text.
   */
  errorClass?: ErrorClass;
  /** `<id>:<postDockScore>` of the line the cap's aging step docked −1. */
  decayed?: string;
  /**
   * Batch-vote partial selector-miss count to record (issue #310): set only by
   * the CLI's ≥1-landed batch-`vote` path when some ids were stale. A
   * non-negative integer; absent or `0` → the column is blank. Deliberately
   * NOT `errorClass` — a ≥1-landed batch still exits 0, so this is a success-row
   * signal, not an error class.
   */
  misses?: number;
}

/**
 * Per-operation reason vocabularies — a *seed-and-grow* enum: each mutating op
 * starts with only the distinction we already need plus an `other` escape hatch,
 * and the vocabulary grows from mined `other` free text rather than from
 * predefined speculative categories (the `other` rate is the growth thermostat).
 * The mechanism now spans every mutating op: `merge` and `rm` carry their own
 * seeds, `split` keeps its original one, and `add` is intentionally ABSENT — it
 * is free-text-only for now (`--note`) so its enum can emerge from mined notes
 * rather than be guessed. An op with no entry here has an empty vocabulary, so
 * any code it is given is bucketed as `other` (keeping the code in the note),
 * which is exactly the emergent-vocabulary path `normalizeReason` takes.
 */
export const REASON_ENUMS: Record<string, readonly string[]> = {
  merge: ['duplicate', 'other'],
  rm: ['wrong', 'obsolete', 'other'],
  split: ['overloaded', 'other'],
  move: ['consolidate', 'other'],
};

/**
 * Normalize an optional (operation, reason-code, note) into the `{reason, note}`
 * pair the usage log records. The reason is OPTIONAL — an empty code yields an
 * empty reason (forcing it would breed filler, the same anti-Goodhart rule as
 * "never force writes"). An UNRECOGNIZED code is accepted as `other` rather than
 * rejected, preserving the original code at the front of the note so an offline
 * process can mine recurring `other`s and promote them into real enum codes.
 */
export function normalizeReason(
  op: string,
  rawCode: string | undefined,
  rawNote: string | undefined,
): { reason: string; note: string } {
  const note = sanitizeLesson(rawNote ?? '');
  const code = (rawCode ?? '').trim().toLowerCase();
  if (code === '') return { reason: '', note }; // no reason supplied — optional
  const vocab = REASON_ENUMS[op] ?? [];
  if (vocab.includes(code)) return { reason: code, note };
  // Unrecognized → bucket as `other`, keeping the original code so it is not lost.
  const keep = code === 'other' ? '' : code;
  const merged = keep ? (note ? `${keep}: ${note}` : keep) : note;
  return { reason: 'other', note: merged };
}

/**
 * Collapse the TSV-structural characters (tab, CR, LF) in a single usage-log
 * field to spaces so an attacker-influenced value cannot inject an extra
 * column or an extra row. A well-formed field — a shelf like `patcher`, a
 * command like `add`, an `NB_SESSION` like `task-42` — contains none of these,
 * so it is left byte-identical.
 */
function sanitizeUsageField(raw: string): string {
  return raw.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Cap the free-text usage-log note at `maxChars()`. The usage ring bounds the
 * ROW COUNT (`usageRing`, default 5000) but NOT a row's byte size, and the
 * `--note` is the one unbounded free-text field — the other columns are ids,
 * enum reasons, or short tokens. Without a per-note cap, a single huge note
 * (e.g. a pasted stack trace) makes the on-disk log grow far past the implied
 * budget, so the count bound no longer bounds the bytes (issue #128). The note
 * is a best-effort diagnostic annotation, never authoritative memory (unlike a
 * lesson, which `addEntry` REJECTS when over-cap), so we TRUNCATE rather than
 * reject — keeping `logUsage`'s never-throw contract — and mark the cut with a
 * trailing ellipsis that stays within the cap. A sub-cap note is returned
 * byte-identical. Reuses `maxChars()` (the lesson/description cap) so one knob
 * bounds every per-item length; after this the log is bounded by
 * ring-count x per-row cap. Also applied to the equally caller-influenced
 * `session` column (issue #202), so no single free-text field can bloat a row.
 */
function capNote(note: string): string {
  const cap = maxChars();
  if (note.length <= cap) return note;
  return note.slice(0, cap - 1) + '…';
}

/**
 * Cap the usage-log `entries` id-list column so one broad row cannot blow the
 * ring's byte budget. Every other usage column is a single id, a short enum
 * token, or the already-capped `--note` (#128/#202), but a `search match` row
 * records the FULL pre-`limit` `surfacedIds` — every hit across every matching
 * notebook — so a one-term `search` over many near-full shelves writes an
 * unbounded list, and the ring's row-COUNT bound (`usageRing`) no longer bounds
 * its BYTES (issue #264, completing the per-field caps of #128/#202). Applied to
 * every command's `entries` (a large batch `vote` can overflow it too), so one
 * knob (`maxChars()`) bounds every per-row field and the whole log stays bounded
 * by ring-count × per-row cap. Like `capNote` this TRUNCATES rather than rejects,
 * keeping `logUsage`'s never-throw contract; a within-cap list is returned
 * byte-identical (joined exactly as before), so the common case and old on-disk
 * rows are unchanged.
 *
 * We keep as many WHOLE ids from the front as fit — never a mangled half-id a
 * reader could mistake for a real entry. Unlike `capNote`, truncation is
 * deliberately SILENT: `note` is read back as one free-text string, but
 * `entries` is split on `,` and ITERATED per id by the diagnostic consumers
 * (vote-reversal, loop detection, serendipity in `stats`/`diagnoseSignals`), so
 * any trailing sentinel token would leak in as a phantom entry id and, on a
 * capped batch vote, forge a cross-session `vote-reversal` for that phantom. The
 * byte bound is what the ring budget needs; the dropped tail ids only weaken the
 * best-effort pull/co-access signals (already lossy proxies — ring churn drops
 * the same evidence), never correctness.
 */
function capEntries(ids: string[]): string {
  const cap = maxChars();
  const joined = ids.join(',');
  if (joined.length <= cap) return joined;
  const kept: string[] = [];
  let len = 0;
  for (const id of ids) {
    const extra = (kept.length === 0 ? 0 : 1) + id.length; // comma separator + id
    if (len + extra > cap) break;
    kept.push(id);
    len += extra;
  }
  return kept.join(',');
}

/**
 * Encode the entries an operation evicted into the usage log's `evicted`
 * column: a comma-separated list of `<id>:<finalScore>` pairs, one per evicted
 * entry, in storage order (stalest first). A single eviction — the ordinary
 * over-cap add — yields exactly `<id>:<finalScore>`, byte-identical to the
 * pre-#306 format, so old rows, the `eviction-while-still-voted` diagnostic's
 * per-pair parse, and the common case are unchanged. A cap DECREASE can evict
 * many at once (e.g. `NB_MAX_LINES` 50→10 on a full shelf ⇒ 41 evictions);
 * recording only the first under-reported that loss and blinded the still-voted
 * signal to its scale (issue #306).
 *
 * Bounded by `maxChars()` — the same per-row byte budget `capNote`/`capEntries`
 * enforce — so a mass eviction cannot blow the usage ring's budget. When the
 * full list overflows, it keeps as many WHOLE pairs from the front as fit and
 * appends a trailing `+<dropped>` marker, so the TOTAL evicted count stays
 * recoverable (listed pairs + dropped) even under truncation. Unlike the shared
 * `entries` column (iterated by several diagnostics, so `capEntries` must
 * truncate SILENTLY lest a sentinel read back as a phantom id), this column has
 * a single consumer — the eviction-while-still-voted signal — which skips the
 * `+<dropped>` token, so the count-preserving marker is safe here.
 */
export function formatEvictedUsage(evicted: Entry[]): string {
  if (evicted.length === 0) return '';
  const budget = maxChars();
  const pairs = evicted.map((e) => `${entryId(e.text)}:${e.score}`);
  const full = pairs.join(',');
  if (full.length <= budget) return full;
  // Overflow: list whole pairs from the front while a `+<dropped>` marker for
  // the remainder still fits, then emit that marker so the count is never lost.
  const listed: string[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const dropped = pairs.length - (i + 1);
    const candidate = [...listed, pairs[i]].join(',');
    const withMarker = dropped > 0 ? `${candidate},+${dropped}` : candidate;
    if (withMarker.length > budget) break;
    listed.push(pairs[i]);
  }
  const dropped = pairs.length - listed.length;
  if (dropped === 0) return listed.join(','); // defensive: full didn't fit, so unreachable
  const prefix = listed.length ? `${listed.join(',')},` : '';
  return `${prefix}+${dropped}`;
}

export function logUsage(
  dir: string,
  shelf: string,
  command: string,
  ok: boolean,
  ms: number,
  meta: UsageMeta = {},
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = usageFile(dir);
    // `shelf`, `command`, and every meta field are caller-supplied (and
    // `session` comes from an env var a hook sets); sanitize each so a tab/CR/LF
    // cannot split the row or shift a column and mis-align parseUsage. The richer
    // columns are appended AFTER the original five, so an old reader that
    // looks only at the first five still parses, and an old row missing them
    // round-trips as blank (backward-compatible — see parseUsage). `errorClass`
    // is the newest column and goes LAST (issue #176), so a pre-#176 row — which
    // ends at `note` — reads it as blank rather than mis-aligning any prior field.
    // `session` (from NB_SESSION, which a harness sets) is caller-influenced
    // free text, exactly like `note` — not a short fixed token — so it is capped
    // to the same per-field length (issue #202). #128 capped only `note`, calling
    // it "the one unbounded free-text field", but a long NB_SESSION is appended to
    // EVERY row, so without this the ring's row-count bound no longer bounds its
    // bytes. Truncated (never rejected) so `logUsage` keeps its never-throw
    // contract, with the same trailing-ellipsis convention as the note.
    const session = capNote(sanitizeUsageField(meta.session ?? process.env.NB_SESSION ?? ''));
    const entries = capEntries((meta.entries ?? []).map(sanitizeUsageField));
    const outcome = sanitizeUsageField(meta.outcome ?? '');
    const collided = sanitizeUsageField(meta.collided ?? '');
    const evicted = sanitizeUsageField(meta.evicted ?? '');
    const reason = sanitizeUsageField(meta.reason ?? '');
    const note = capNote(sanitizeUsageField(meta.note ?? ''));
    // A fixed enum token (never user text), but sanitize anyway for uniformity so
    // no column can ever be split — it is a no-op on a well-formed enum value.
    const errorClass = sanitizeUsageField(meta.errorClass ?? '');
    const decayed = sanitizeUsageField(meta.decayed ?? '');
    // Crash-recovery column (issue #309): drain the tally that withLock's
    // stale-lock steal and reapLeftoverTemps' temp reap filled during this same
    // process's mutation, and record it as `<lockSteals>:<tempReaps>` — blank in
    // the common no-recovery case, so an old reader and old rows are unchanged.
    // Drained exactly once here (read-and-reset), so each event is counted on one
    // row; the two counts are machine-generated integers, so no sanitize is
    // needed (no caller text can reach this column).
    const rec = drainPendingRecovery();
    const recovered = rec.lockSteals > 0 || rec.tempReaps > 0 ? `${rec.lockSteals}:${rec.tempReaps}` : '';
    // Batch-vote partial misses (issue #310): the count of stale ids skipped by a
    // ≥1-landed batch `vote`. That call exits 0 (`ok=true`) so its misses never
    // reach the err-rate table; recording them lets `nb stats` fold them into the
    // vote error-cause readout. A machine-generated non-negative integer (no
    // caller text, so no sanitize), blank in the common no-miss case so an old
    // reader and old rows are unchanged.
    const misses = meta.misses && meta.misses > 0 ? String(Math.round(meta.misses)) : '';
    const line =
      `${new Date().toISOString()}\t${sanitizeUsageField(shelf)}\t${sanitizeUsageField(command)}\t${ok ? 'ok' : 'err'}\t${Math.round(ms)}ms` +
      `\t${session}\t${entries}\t${outcome}\t${collided}\t${evicted}\t${reason}\t${note}\t${errorClass}\t${decayed}\t${recovered}\t${misses}`;
    const ring = usageRing();
    const compactAt = ring + usageRingSlack();

    // Fast path — the hot path on nearly every `nb` call. The sidecar records the
    // log's row count AND byte size as of our last write, so we decide
    // append-vs-compact WITHOUT reading or splitting the whole ring (issue #135):
    // on a busy deployment the ring sits near its 5000-row cap, and re-reading
    // hundreds of KB to record one line blew the "a call is a millisecond" budget.
    //
    // We trust the row count ONLY when the log's current size exactly equals the
    // recorded size — proof that nothing has touched the file since we wrote it,
    // so the count is accurate AND the file still ends with the `\n` we wrote (no
    // row can be glued). Any out-of-band change — a concurrent writer, a
    // hand-edit, an ENOSPC/crash-torn partial row — moves the size, so we fall
    // through to the exact path, which re-derives the count, re-applies the
    // trailing-newline guard, and restores the ring bound in that single call.
    // The append here is O(1) and touches neither the preceding rows nor the
    // inode (no rewrite, no rename).
    const state = readUsageState(dir);
    if (state !== undefined && state.rows < compactAt && usageSize(file) === state.bytes) {
      const buf = `${line}\n`;
      appendFileSync(file, buf, 'utf-8');
      writeUsageState(dir, state.rows + 1, state.bytes + Buffer.byteLength(buf));
      return;
    }

    // Exact path: the sidecar was missing, stale, says we have reached the
    // threshold, or the file changed out of band — so read the real rows and
    // re-derive the count+size. This runs on the first write, the rare compaction
    // (once per ~slack appends), and whenever a stale estimate needs healing —
    // never on the common append.
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const lines = existing.split('\n').filter((l) => l !== '');

    if (lines.length < ring) {
      // Still under the hard cap: append in place (no rewrite, no rename) and
      // record the now-known count+size. Guard the trailing newline — a previous
      // writer may have crashed mid-row leaving no final `\n`, and a blind append
      // would glue our row onto theirs.
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const buf = `${sep}${line}\n`;
      appendFileSync(file, buf, 'utf-8');
      writeUsageState(dir, lines.length + 1, Buffer.byteLength(existing) + Buffer.byteLength(buf));
      return;
    }

    // At/over cap: compact. Slice to the newest `ring` rows (oldest dropped) and
    // atomically replace the file — the only path that rewrites the previous
    // bytes, now reached only on the rare compaction rather than every call.
    lines.push(line);
    const kept = lines.slice(lines.length - ring);
    const body = kept.join('\n') + '\n';
    // Per-process-unique temp path: this log write runs OUTSIDE the .nb.lock
    // (it is called from the CLI's finally block), so two concurrent nb
    // processes would otherwise write and rename the same `${file}.tmp` and
    // clobber each other mid-write. The pid keeps each writer's temp distinct;
    // the rename is still atomic, so a reader sees one whole file or the other.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, file);
    writeUsageState(dir, kept.length, Buffer.byteLength(body));
  } catch {
    /* monitoring is best-effort; never fail a real operation because the log write failed */
  }
}

export function parseUsage(dir: string): UsageRow[] {
  const file = usageFile(dir);
  if (!existsSync(file)) return [];
  const rows: UsageRow[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    // Positional parse, tolerant of old five-column rows: the richer columns
    // (session…recovered) are undefined on a pre-upgrade row and default to
    // blank/empty, so a ring written before this change still reads cleanly.
    // `misses` (issue #310) is the current trailing column, appended after
    // `recovered` (#309), itself after `decayed` (#293); a row from before any of
    // them ends earlier, so the missing trailing columns are undefined here and
    // default to `''`/`0`.
    const [ts, shelf, command, status, msRaw, session, entriesRaw, outcome, collided, evicted, reason, note, errorClass, decayed, recovered, misses] =
      line.split('\t');
    if (!ts || !command) continue;
    rows.push({
      ts,
      role: shelf ?? '',
      command: command ?? '',
      ok: status === 'ok',
      ms: Number.parseInt((msRaw ?? '0').replace(/ms$/, ''), 10) || 0,
      session: session ?? '',
      entries: entriesRaw ? entriesRaw.split(',').filter((x) => x !== '') : [],
      outcome: outcome ?? '',
      collided: collided ?? '',
      evicted: evicted ?? '',
      reason: reason ?? '',
      note: note ?? '',
      errorClass: errorClass ?? '',
      decayed: decayed ?? '',
      recovered: recovered ?? '',
      // Blank/absent (pre-#310 rows and the common no-miss case) → 0. Clamped to
      // ≥0 so a corrupt/hand-edited negative cell can never subtract from the
      // vote miss-count aggregation (it is only ever written as a non-negative
      // count).
      misses: Math.max(0, Number.parseInt(misses ?? '', 10) || 0),
    });
  }
  return rows;
}

export interface CommandStat {
  command: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50ms: number;
  p95ms: number;
  lastUsed: string;
}

/**
 * Per-command error-cause readout (issue #223). The per-command table shows each
 * command's error *rate*; this names the *cause* so the two most actionable rates
 * — `add` over-the-cap rejections and `vote` selector-resolution failures — are
 * surfaced in the header instead of being buried behind the high-error-rate
 * anomaly threshold. Each `cause` is an `errorClass` token (issue #176) when the
 * row recorded one; a row that predates that column falls back to its `outcome`
 * (so `add`'s `too-long` still shows on a pre-#176 log) and otherwise reads
 * `unclassified` — a hint to upgrade `nb` so error classes get recorded.
 */
export interface ErrorCause {
  command: string;
  /** Total miss events for this command in the window (the breakdown's denominator): error rows plus, for `vote`, the batch partial selector misses (issue #310) that each exit 0 yet skip a stale id. */
  errors: number;
  /** Dominant-first cause → share of this command's errors, as an integer percent. */
  breakdown: { cause: string; pct: number }[];
}

export interface Anomaly {
  kind: 'loop' | 'went-silent' | 'high-error-rate';
  command: string;
  /** @deprecated use shelf */
  role?: string;
  shelf?: string;
  detail: string;
}

/**
 * A *free diagnostic signal* (issue #72): a memory-quality observation read
 * straight from the usage ring, costing no new agent action. Unlike `Anomaly`
 * (command health) this is about the notebook itself — its descriptions, cap
 * pressure, and whether a lesson is aimed right — so it carries a `shelf` (the
 * notebook) and optionally the `entry` id or `session` the signal concerns.
 *
 * The three kinds, all implied by behavior the agent already performs:
 *   - `browse-without-use`: a notebook was `show`n in a session but nothing in it
 *     was voted that session → its description may over-promise.
 *   - `eviction-while-still-voted`: the cap evicted an entry whose score was still
 *     above the +1 a new lesson starts at → a lesson agents found useful was lost. A full shelf is normal; only
 *     repeated still-voted evictions suggest the cap is too tight for that shelf.
 *   - `vote-reversal`: the same entry was upvoted in one session and downvoted in
 *     another → the lesson may be correct but mis-aimed.
 *   - `failed-search`: a `search` returned nothing and a lesson was then added in the
 *     same session (issue #82) → a coverage gap the notebook lacked, labelled by the
 *     agent's own query. This is the `failed-search → add` gap-sensor the demoted
 *     `nb search` fallback unlocks (the coverage signal deferred from #72). The
 *     `search` row is logged under shelf `-` (it spans notebooks), so this signal is
 *     observable only in an UNSCOPED `stats` report — `stats({shelf})` filters to one
 *     shelf and cannot pair the cross-notebook search with the add.
 *   - `add-burst` (issue #353): one session accepted more than `NB_ADD_BURST_N` adds
 *     into one shelf. On a full shelf each add evicts a line, so a burst shortens the
 *     retention window of everything already there; the first remedy is fewer adds
 *     per session, not a bigger cap or another shelf.
 */
export interface DiagnosticSignal {
  kind: 'browse-without-use' | 'eviction-while-still-voted' | 'vote-reversal' | 'failed-search' | 'add-burst';
  /** @deprecated use shelf */
  role: string;
  /** The shelf the signal concerns. */
  shelf: string;
  /** Human-readable one-line explanation. */
  detail: string;
  /** `browse-without-use` / `failed-search` / `add-burst`: the session the signal concerns. */
  session?: string;
  /** `eviction-while-still-voted` / `vote-reversal`: the entry id involved. */
  entry?: string;
}

/**
 * One shelf's notebook occupancy. `lines` is the stored lesson count (what the
 * cap counts and `enforceCap` evicts against); `cap` is `maxLines()` at call
 * time. A shelf is "about to evict" when `lines` approaches `cap`; `lines === cap`
 * means the next distinct add evicts the lowest-scored lesson (and ages the
 * stalest survivor), so a supervisor can see memory pressure without listing files.
 */
export interface NotebookStat {
  /** @deprecated use shelf */
  role: string;
  shelf: string;
  lines: number;
  cap: number;
  /** Accepted `add` rows for this shelf inside the stats window (issue #353), read from the usage log. */
  adds: number;
  /** `adds` per day of the window (`adds ÷ window days`). Not adjusted for a shelf younger than the window. */
  addsPerDay: number;
  /**
   * Estimated retention window of a FULL shelf, in days: `cap ÷ addsPerDay` — each
   * add to a full shelf evicts one line, so an untouched lesson lasts about `cap`
   * adds whatever its score. `null` when the shelf is below its cap or took no
   * adds in the window (no rate to divide by) — never a misleading 0 or Infinity.
   */
  retentionDays: number | null;
}

export interface NotebookTotals {
  /** @deprecated use shelves */
  roles: number;
  shelves: number;
  lines: number;
  cap: number;
}

/**
 * The named **surfacing metrics** (issue #81): the recall-miss / precision-miss
 * rates and the coverage×surfacing readout that §4 of the design rationale
 * defines, turned into numbers `nb stats` reports. Every rate is derived from
 * the usage ring alone — the entry-level columns of [FR-USAGE-002] — so it adds
 * no field to a lesson ([NG-004]) and costs the agent no extra action.
 *
 * Two robustness properties make the rates trustworthy:
 *   - **Conditioned on *attempts*, not sessions.** Each rate's denominator is a
 *     count of add/vote *events*, so a lazy agent that rarely writes is simply a
 *     small sample, never a deflated "healthy 0%".
 *   - **Gated on *engagement*.** Only sessions that show a vote (the agent both
 *     has the tool wired up AND is instructed to use it) feed the rates; a
 *     session with no vote is excluded as a setup/plumbing problem rather than
 *     scored as "healthy quiet" (the engagement gate of §4).
 *
 * A rate is `null` — never a misleading `0` ([DP-5]) — when its denominator is
 * empty (no engaged sessions, or no add attempts / votes within them).
 */
export interface SurfacingMetrics {
  /** Sessions that showed engagement — at least one `up`/`down` vote. The gate under every rate below; `0` means nothing here is scored (e.g. `NB_SESSION` was never set). */
  engagedSessions: number;
  /** Genuine add attempts in engaged sessions: `accepted` + `dedup-blocked` + `rejected-full` (a real, within-cap, non-empty lesson whose fate the notebook decided; `empty`/`too-long` are malformed input, excluded). `rejected-full` is historical — the always-admit policy no longer emits it, but it stays counted so pre-upgrade logs still read correctly. The denominator for `coverage` and `recallMiss`. */
  addAttempts: number;
  /** **Coverage** — novel-add rate = accepted adds ÷ `addAttempts`. High early (a young notebook filling gaps) is expected, not a fault. `null` when `addAttempts` is 0. */
  coverage: number | null;
  /** **Surfacing recall-miss** (the headline alarm) — dedup-block rate = blocked adds ÷ `addAttempts`: the agent re-derived something already stored. `null` when `addAttempts` is 0. */
  recallMiss: number | null;
  /** Vote actions (`up` + `down`) on pushed lessons in engaged sessions — the denominator for `precisionMiss`. */
  votesActedOn: number;
  /** **Surfacing precision-miss** — downvote rate on *pushed* lessons = downvotes ÷ `votesActedOn`. Read beside `recallMiss` so "surface everything" cannot look free. Every delivered lesson is currently treated as pushed (per [NG-007]); now that `nb search` exists, narrowing this to non-search-delivered lessons is a possible future refinement, not yet implemented. `null` when `votesActedOn` is 0. */
  precisionMiss: number | null;
  /** Upvotes (`up`) on pushed lessons in engaged sessions — the denominator for `serendipity`. A SUBSET of `votesActedOn` (which also counts downvotes), so the serendipity sample size cannot be recovered from `votesActedOn`; it is exposed so a reader can tell `serendipity: 1.0` over one upvote from the same ratio over fifty ([DP-5]). */
  upvotes: number;
  /**
   * **Serendipity** (issue #114) — the positive goal of [DP-8]: of the upvotes in
   * engaged sessions, the share on lessons that **arrived unbidden** = push-delivered
   * upvotes ÷ `upvotes`. "Push-delivered" is inferred as *the upvoted entry was NOT
   * returned by any `search` in the same session* (search rows carry their surfaced
   * ids since this issue). Read beside `recallMiss`/`precisionMiss`, its two failure
   * modes. `null` when `upvotes` is 0.
   *
   * HONEST LIMIT — this is a two-sided **proxy, NOT a bound** ([DP-5]): it both
   * over-counts push (an agent-chosen `show`-pull or in-session recall is
   * indistinguishable from an injection — those stay in the numerator) and
   * under-counts it (a pushed lesson that *also* surfaced in a same-session search
   * is scored a pull). The biases point opposite ways and are of unknown relative
   * size, and ring churn (an evicted search row, or an `entryId` changed by a
   * merge/split/reword between search and vote) silently drops pull evidence. So the
   * number is an approximate direction-of-travel indicator, never read as
   * "true serendipity ≤ x". The clean one-sided signal waits on a positive push
   * record from the session-start injection hook (RFC 0114 §Design decision; the
   * cross-repo #73 injection contract).
   */
  serendipity: number | null;
  /** The coverage×surfacing 2×2 readout — `healthy` / `surfacing-failure` / `coverage-building` / `churny` — a heuristic hint, not a verdict. `null` when there is not enough data (no add attempts) to place it. */
  readout: 'healthy' | 'surfacing-failure' | 'coverage-building' | 'churny' | null;
  /**
   * Root-cause breakdown of a window with **no engagement anywhere** (issue
   * #105). The single "no engaged sessions" message hides three very different
   * deployment-level failures; this splits them. It is deployment-wide, so it is
   * `null` whenever ANY session cast a vote in the window (a vote on any shelf
   * means the setup works) — including every shelf-scoped `nb stats <shelf>`
   * whose own shelf is quiet but whose deployment is healthy. See
   * `EngagementDiagnosis`.
   */
  engagementDiagnosis: EngagementDiagnosis | null;
}

/**
 * Why a window has **no engaged sessions** (issue #105), derived from the same
 * windowed, shelf-scoped usage rows as the rates above — a read, not a new field
 * ([NG-004]). Three operational failures collapse into "no engaged sessions",
 * each with a different fix; the counts here let `nb stats` name the one(s) in
 * play. Only populated when `SurfacingMetrics.engagedSessions === 0`.
 *
 * All counts are **deployment-wide** (the window, every shelf), because the
 * three fixes — `NB_SESSION`, the retrospective nudge, the SessionStart hook —
 * are deployment-level, not per-shelf. "Read" is defined twice on purpose (the
 * risk the issue flags — "don't double-count the hook's own `nb list`"):
 *   - `reads` counts `show`/`list`/`search` — ANY read, so `0` means even the
 *     SessionStart hook's auto-injected `nb list` never ran (the hook cause).
 *   - `readOnlySessions` counts only `show`/`search` — a *deliberate* open of
 *     notebook content, EXCLUDING the hook's automatic `nb list`, so a session
 *     where the hook injected the index but the agent never opened a notebook is
 *     not mislabelled as "used the notebook but skipped the retrospective".
 */
export interface EngagementDiagnosis {
  /** Recent rows whose `session` was blank (`NB_SESSION` unset) — they can never form a session, so they can never be "engaged". */
  blankSessionCalls: number;
  /** Distinct NON-blank sessions that `show`/`search`ed a notebook (deliberate reads, excluding the hook's auto `nb list`) but — since this is only populated when nothing engaged — cast no vote. */
  readOnlySessions: number;
  /** `show`/`list`/`search` rows in the window (any read, across all shelves). `0` with stored lessons ⇒ the injection hook probably never ran. */
  reads: number;
  /** Lessons currently stored across ALL notebooks (deployment-wide); gates the hook diagnosis (nothing to surface anywhere ⇒ no "hook not wired" claim). */
  storedLessons: number;
  /**
   * The applicable root causes, in report order (≤ 3):
   *   - `blank-session` — `blankSessionCalls > 0`: export `NB_SESSION`.
   *   - `retrospective-not-landing` — `readOnlySessions > 0`: the vote nudge isn't landing.
   *   - `injection-hook` — `reads === 0 && storedLessons > 0`: the SessionStart hook isn't wired.
   * Empty when `engagedSessions === 0` but none apply (e.g. an empty notebook
   * with no activity) — the renderer then keeps the generic line.
   */
  causes: ('blank-session' | 'retrospective-not-landing' | 'injection-hook')[];
}

/**
 * The current `StatsReport` wire-format version (issue #172). Starts at `1` and
 * is a single integer so a consumer can detect a breaking change in the `--json`
 * contract without diffing every field.
 *
 * Bump policy — increment by exactly 1 on any **breaking** change: removing or
 * renaming a field, changing a field's type or meaning, or changing an array's
 * ordering that a consumer relies on. Do **not** bump for a purely **additive**
 * change — adding a field, or a new `anomalies`/`signals` kind — which is how
 * this report has grown (issues #18, #40, #72, #81, #106, #132). When you bump,
 * update the README's "Machine-readable `nb stats`" section alongside the number.
 */
export const STATS_SCHEMA_VERSION = 1;

export interface StatsReport {
  /**
   * Wire-format version of this report (issue #172). See `STATS_SCHEMA_VERSION`
   * for the value and the bump policy. A consumer compares it to the version it
   * was written against to detect a breaking change in the `--json` contract.
   */
  schemaVersion: number;
  window: string;
  /** ISO-8601 instant the report was generated (the report's `now`). */
  generatedAt: string;
  /** ISO-8601 instant the window opens (`generatedAt - window`). */
  windowStart: string;
  totalCalls: number;
  perCommand: CommandStat[];
  /**
   * Per-command error-cause breakdown (issue #223), dominant-first and only for
   * commands that had ≥1 error in the window. Additive to the report — every
   * field above is unchanged. It names the lever behind each command's `err%`
   * (e.g. `add`: `too_long`, `vote`: `no_match`/`ambiguous_selector`) so the two
   * headline rates are not buried behind the high-error-rate anomaly threshold.
   * See `ErrorCause`.
   */
  errorCauses: ErrorCause[];
  anomalies: Anomaly[];
  /**
   * Notebook inventory (issue #40): per-shelf line counts and the `maxLines()`
   * cap, plus `notebookTotals`. Additive to the report from issue #18 / PR #24 —
   * `window`/`perCommand`/`anomalies` are unchanged. When `stats` is called with
   * a `shelf`, only that shelf's notebook is listed (empty if it has none).
   */
  notebooks: NotebookStat[];
  notebookTotals: NotebookTotals;
  /**
   * Shelves the notebook inventory could not read and therefore omitted (issue
   * #332) — the same `{shelf, code}` skip `nb list`/`nb search` report, so the
   * operator's health scan survives one damaged file instead of aborting. Additive
   * to the report (`notebooks`/`notebookTotals` count only the healthy shelves; the
   * CLI prints one stderr line per entry); `STATS_SCHEMA_VERSION` does not bump. See
   * `SkippedShelf`.
   */
  skipped: SkippedShelf[];
  /**
   * Shelves whose notebook file holds a git merge-conflict marker (issue #333),
   * the inventory analogue of `skipped`: the shelf is still counted (its lessons
   * read as stored) but the CLI warns on stderr that it must be resolved. Additive
   * to the report; `STATS_SCHEMA_VERSION` does not bump. Empty on a healthy store.
   */
  conflicts: ConflictShelf[];
  /**
   * Free diagnostic signals (issue #72): memory-quality observations derived
   * from the same windowed, shelf-scoped usage rows as `anomalies`, but about the
   * notebook (descriptions, cap pressure, mis-aimed lessons) rather than command
   * health. Additive to the report — `window`/`perCommand`/`anomalies`/
   * `notebooks`/`notebookTotals` are unchanged. See `DiagnosticSignal`.
   */
  signals: DiagnosticSignal[];
  /**
   * The named surfacing metrics (issue #81): recall-miss / precision-miss rates
   * and the coverage×surfacing readout, engagement-gated, computed from the same
   * windowed, shelf-scoped usage rows. Additive to the report — every field above
   * is unchanged. See `SurfacingMetrics`.
   */
  surfacing: SurfacingMetrics;
  /**
   * Ops-per-day activity (issue #106): one count per rolling-24h bucket over the
   * window, **oldest bucket first** (last entry = the 24h ending at `now`).
   * Bucketed from the same windowed, scoped rows as `perCommand`, so
   * `activity.length` is the bucket count and `sum(activity) === totalCalls`.
   * The human table renders it as a `sparkline(...)`. Additive — every field
   * above is unchanged. See `activityByDay` / `sparkline` and RFC 0106.
   */
  activity: number[];
  /**
   * Usage-ring occupancy (issue #206): how full the monitoring log itself is —
   * `rows` is the total row count on disk, `cap` is `usageRing()`. Unlike
   * `totalCalls` (which is windowed and shelf-scoped), this is TOTAL occupancy
   * across the whole ring, so an operator can see the log is near its
   * compaction point (and therefore about to drop the oldest history on the next
   * trim) — the analogue, for the log, of the `notebooks` inventory's cap
   * pressure (issue #40). Read from the `parseUsage` the report already does, so
   * it costs no extra ring read. Additive — every field above is unchanged, and
   * `STATS_SCHEMA_VERSION` does not bump (#172 additive-field policy).
   */
  usageRing: { rows: number; cap: number };
  /**
   * Crash-recovery readout (issue #309): how many times, in the window, a `nb`
   * mutation found and cleaned up evidence that a PREVIOUS `nb` died mid-write —
   * `lockSteals` is stale `.nb.lock`s stolen (a crash while holding the lock) and
   * `tempReaps` is leftover `*.md.<pid>.tmp` / `.nb-usage.log.<pid>.tmp` files
   * reaped (a crash mid atomic-write). Both were silent before this issue, so an
   * operator could not tell whether agents were crashing mid-mutation and losing
   * updates; a nonzero count is exactly that evidence. Summed from the usage ring's
   * `recovered` column, so it costs no extra read and adds no field to a lesson
   * ([NG-004]). Like `usageRing` this is **deployment-wide** — the lock and the
   * temp debris are shared across every shelf — so it is NOT narrowed by a
   * `[<shelf>]` scope, only by the window. A clean deployment reports `{ 0, 0 }`,
   * shown (not omitted) so "measured, healthy" is never confused with "not
   * measured" ([DP-5]). Additive — every field above is unchanged, and
   * `STATS_SCHEMA_VERSION` does not bump (#172 additive-field policy).
   */
  crashRecovery: { lockSteals: number; tempReaps: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Accepted `--since` window shape: a count followed by d (days), h (hours), or m (minutes). */
const WINDOW_RE = /^(\d+)([dhm])$/;

/**
 * True when `raw` is a window `parseWindowMs` recognizes (Nd/Nh/Nm). Lets the
 * CLI tell a mistyped `--since` (which would silently fall back to the default)
 * apart from a genuinely valid one, so it can warn instead of misleading.
 */
export function isValidWindow(raw: string | undefined): boolean {
  return raw != null && WINDOW_RE.test(raw.trim());
}

/** The eight Unicode block glyphs, low→high, that `sparkline` scales counts over. */
const SPARK_GLYPHS = '▁▂▃▄▅▆▇█';

/**
 * ASCII ramp, low→high, for the plain-text sparkline fallback (issue #136).
 * Digits keep the row greppable (you can grep a specific bar height) and still
 * convey relative height — `0` is the floor, `9` the busiest bucket. Used in a
 * non-UTF-8 locale or when `NB_ASCII` is set; see `asciiMode` / `sparkGlyphs`.
 */
const SPARK_ASCII = '0123456789';

/**
 * Render a count series as a one-line sparkline (issue #106; ASCII fallback
 * #136). Pure and zero-dependency — no chart library, no network, no env read.
 *
 * `glyphs` is the low→high ramp to scale over, so the ASCII/Unicode choice is a
 * parameter rather than a second code path. It defaults to the Unicode blocks,
 * keeping the one-argument call unchanged.
 *
 * Scaling is **zero-based**, not min–max: each bar is proportional to the
 * busiest bucket (`max`), so a **silent (0-op) bucket always reads as the floor
 * glyph** (`▁`, or `0` in ASCII) and the busiest as the top (`█`, or `9`). For a
 * *count* plot (the "went quiet" question) a zero must read as the floor;
 * min–max scaling would both stretch a nearly flat series and make a 0-op bucket
 * indistinguishable from a nonzero minimum. The identity this yields:
 * `sparkline([0,1,2,3,4,5,6,7])` → `▁▂▃▄▅▆▇█`. See RFC 0106.
 *
 * `[]` → `''`; an all-zero (or all-equal-at-0) series → all floor glyphs.
 */
export function sparkline(counts: number[], glyphs: string = SPARK_GLYPHS): string {
  // `Math.max(...[])` is `-Infinity` (≤ 0), so this one branch also covers the
  // empty series — `''.repeat(0)` is `''` — with no separate length guard.
  const max = Math.max(...counts);
  if (max <= 0) return glyphs[0].repeat(counts.length);
  // 0 → index 0 (floor); max → index (len-1) (top). For 0 ≤ c ≤ max the index is
  // always within [0, glyphs.length-1], so no clamp is needed.
  return counts.map((c) => glyphs[Math.round((c / max) * (glyphs.length - 1))]).join('');
}

/**
 * Whether the activity sparkline should use the ASCII ramp instead of Unicode
 * blocks (issue #136). An explicit `NB_ASCII` is authoritative: any truthy value
 * forces ASCII, any falsey one (`''`, `0`, `false`, `no`, `off`) forces Unicode,
 * overriding locale autodetection. With `NB_ASCII` unset, the effective locale
 * (`LC_ALL` → `LC_CTYPE` → `LANG`, first set wins) decides: a locale that is set
 * but does not name UTF-8 (e.g. `C`, `POSIX`, `en_US.ISO-8859-1`) selects ASCII;
 * an unset or UTF-8 locale keeps the Unicode default.
 */
export function asciiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NB_ASCII !== undefined) {
    const v = env.NB_ASCII.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !!locale && !/utf-?8/i.test(locale);
}

/**
 * The sparkline glyph ramp for the current environment (issue #136): the ASCII
 * digits when `asciiMode` is on, else the Unicode blocks. Kept out of
 * `sparkline` so that function stays pure and env-free.
 */
export function sparkGlyphs(env: NodeJS.ProcessEnv = process.env): string {
  return asciiMode(env) ? SPARK_ASCII : SPARK_GLYPHS;
}

/** One rolling-24h bucket in ms, for the activity sparkline. */
const ACTIVITY_BUCKET_MS = 86_400_000;

/**
 * Bucket call timestamps into **rolling 24-hour windows counting back from
 * `now`** (issue #106) — NOT calendar days, so there is no local-vs-UTC
 * question; the only inputs are `now` and each row's epoch ms. Returns the
 * per-bucket counts **oldest-first** (index 0 = the oldest 24h, last index =
 * the most recent 24h ending at `now`).
 *
 * Bucket count is `max(1, ceil(windowMs / DAY))`, so a `7d` window yields 7
 * buckets and any sub-day window yields 1. A timestamp is placed by its age
 * `now − ts`: a negative age (clock skew / future row) lands in the newest
 * bucket and an age at/over the window edge in the oldest, so **every** input
 * timestamp is counted — `sum(result) === tsList.length`. Callers pass the
 * already-windowed, scoped rows, so that sum equals the report's `totalCalls`.
 */
export function activityByDay(tsList: number[], now: number, windowMs: number): number[] {
  const nBuckets = Math.max(1, Math.ceil(windowMs / ACTIVITY_BUCKET_MS));
  const buckets = new Array<number>(nBuckets).fill(0);
  for (const t of tsList) {
    const age = now - t;
    const fromRight = Math.min(nBuckets - 1, Math.floor(Math.max(0, age) / ACTIVITY_BUCKET_MS));
    buckets[nBuckets - 1 - fromRight]++;
  }
  return buckets;
}

/** Parse a window like `7d`, `12h`, `30m` into milliseconds. Default 7 days. */
export function parseWindowMs(raw: string | undefined): number {
  if (!raw) return 7 * 24 * 3600_000;
  const m = WINDOW_RE.exec(raw.trim());
  if (!m) return 7 * 24 * 3600_000;
  const n = Number.parseInt(m[1], 10);
  return n * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
}

/** Reads for the injection-hook check (cause 3): ANY read, so the hook's auto `nb list` counts. */
const READ_COMMANDS = new Set(['show', 'list', 'search']);
/** Deliberate reads for the retrospective check (cause 2): opening content, EXCLUDING the hook's auto `nb list`. */
const DELIBERATE_READ_COMMANDS = new Set(['show', 'search']);

/**
 * Split a **zero-engagement** window into its root cause(s) (issue #105). Called
 * only when there is no engagement anywhere in the window; returns the counts
 * plus the ordered `causes[]` the renderer turns into up to three actionable
 * lines.
 *
 * `recent` is the windowed but **deployment-wide (NOT shelf-scoped)** row set,
 * and `storedLessons` is the total across **all** notebooks — because the three
 * remedies are deployment-level: `NB_SESSION`, the SessionStart hook, and the
 * retrospective nudge are not per-shelf, and the hook's own `nb list` is logged
 * globally (shelf `-`), so a shelf-scoped view would miss it and falsely report
 * "hook not wired". `storedLessons` gates the hook cause — no lessons anywhere,
 * no "hook not wired" claim. See `EngagementDiagnosis` for the two deliberately
 * different "read" definitions and why they avoid double-counting that `nb list`.
 */
export function diagnoseEngagement(recent: UsageRow[], storedLessons: number): EngagementDiagnosis {
  let blankSessionCalls = 0;
  let reads = 0;
  const readOnly = new Set<string>(); // distinct non-blank sessions with a deliberate read
  for (const r of recent) {
    if (r.session === '') blankSessionCalls++;
    if (READ_COMMANDS.has(r.command)) reads++;
    if (r.session !== '' && DELIBERATE_READ_COMMANDS.has(r.command)) readOnly.add(r.session);
  }
  const readOnlySessions = readOnly.size;
  const causes: EngagementDiagnosis['causes'] = [];
  if (blankSessionCalls > 0) causes.push('blank-session');
  if (readOnlySessions > 0) causes.push('retrospective-not-landing');
  if (reads === 0 && storedLessons > 0) causes.push('injection-hook');
  return { blankSessionCalls, readOnlySessions, reads, storedLessons, causes };
}

/**
 * Total lessons across ALL notebooks, for the deployment-wide engagement
 * diagnosis (issue #105) — the hook cause asks "are there lessons to surface
 * *anywhere*". Reuses the already-built per-shelf `notebooks` when `stats` is
 * unscoped (then it already covers every shelf); otherwise sums each shelf
 * afresh. Only called on the zero-engagement path, so the extra reads are rare.
 */
function globalStoredLessons(dir: string, notebooks: NotebookStat[], scope: string | undefined): number {
  if (!scope) return notebooks.reduce((sum, n) => sum + n.lines, 0);
  return listShelves(dir).reduce((sum, shelf) => sum + readEntries(dir, shelf).length, 0);
}

/**
 * Summarize a set of error rows as a `class pct%` breakdown, most-common first
 * (issue #176) — e.g. `too_long 78%, bad_args 14%, other 8%`. Percentages are
 * rounded whole numbers of the error total, so they may not sum to exactly 100%
 * (an honest rounding artefact, not a bug). A pre-#176 error row carries no class
 * (`errorClass === ''`); it is bucketed as `unclassified` — kept distinct from a
 * genuine `other` so a freshly-upgraded window reads "unclassified 100%" (wait
 * for data) rather than a misleading "other 100%" ([DP-5]). Ties break by label
 * for a stable line.
 */
function errorClassBreakdown(errRows: UsageRow[]): string {
  const counts = new Map<string, number>();
  for (const r of errRows) {
    const key = r.errorClass || 'unclassified';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = errRows.length;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${cls} ${Math.round((n / total) * 100)}%`)
    .join(', ');
}

/**
 * Monitoring without a monitoring system: read the usage ring, roll up per
 * command, and flag the three anomalies that matter — an agent looping on a
 * command (stuck), a command that went silent (it probably broke), and a
 * command erroring often (not behaving as expected).
 */
export function stats(
  dir: string,
  opts: {
    shelf?: string;
    /** @deprecated use `shelf`; honoured when `shelf` is absent */
    role?: string;
    windowMs?: number;
    now?: number;
  } = {},
): StatsReport {
  const scope = opts.shelf ?? opts.role;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 7 * 24 * 3600_000;
  const parsed = parseUsage(dir);
  const inWindow = (r: UsageRow): boolean => now - Date.parse(r.ts) <= windowMs;
  // Deployment-wide (unscoped) windowed rows: the engagement diagnosis (issue
  // #105) reads these, since NB_SESSION / the hook / the retrospective nudge are
  // deployment-level and the hook's `nb list` is logged globally (shelf `-`).
  const recentAll = parsed.filter(inWindow);
  const all = scope ? parsed.filter((r) => r.role === scope) : parsed;
  const recent = all.filter(inWindow);

  const byCmd = new Map<string, UsageRow[]>();
  for (const r of recent) {
    const arr = byCmd.get(r.command) ?? [];
    arr.push(r);
    byCmd.set(r.command, arr);
  }
  // Per-command error-cause breakdown (issue #223): name the lever behind each
  // command's err% so `add` over-cap rejections and `vote` selector misses are
  // surfaced in the header, not only when the high-error-rate anomaly fires. A
  // row's cause is its `errorClass` (issue #176); a pre-#176 row falls back to
  // `outcome` for the one outcome that is an error (`too-long` → `too_long`), so
  // `add`'s dominant cause reads correctly even on an older log; anything else is
  // `unclassified`.
  // A couple of stray errors (e.g. a one-off unknown-subcommand guess) is noise,
  // not a rate; only a handful is a pattern worth naming. This keeps the readout
  // to the commands that actually have an err% worth diagnosing (add, vote).
  const ERROR_CAUSE_MIN = 3;
  const errorCause = (r: UsageRow): string =>
    r.errorClass || (r.outcome === 'too-long' ? 'too_long' : 'unclassified');
  const errorCauses: ErrorCause[] = [...byCmd.entries()]
    .map(([command, rows]): ErrorCause => {
      const errRows = rows.filter((r) => !r.ok);
      const counts = new Map<string, number>();
      for (const r of errRows) counts.set(errorCause(r), (counts.get(errorCause(r)) ?? 0) + 1);
      // Fold in batch-vote partial misses (issue #310): a ≥1-landed batch `vote`
      // exits 0 (`ok=true`), so it is NOT an error row, yet each stale id it
      // skipped is a genuine selector miss the err-rate table can't see. Count
      // each as a `no_match` cause — the same class a wholly-failed vote stamps —
      // so the vote selector-miss readout is no longer blind to them. `misses` is
      // only ever recorded on vote rows, so this is a no-op for every other
      // command. The per-command error *rate* (perCommand) is untouched: it keeps
      // counting error ROWS, so a batch that limped to exit 0 stays a success
      // there — only this cause readout surfaces the laundered misses.
      let partialMisses = 0;
      for (const r of rows) partialMisses += r.misses;
      if (partialMisses > 0) counts.set('no_match', (counts.get('no_match') ?? 0) + partialMisses);
      const errors = errRows.length + partialMisses;
      const breakdown = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([cause, n]) => ({ cause, pct: Math.round((n / errors) * 100) }));
      return { command, errors, breakdown };
    })
    .filter((e) => e.errors >= ERROR_CAUSE_MIN)
    .sort((a, b) => b.errors - a.errors || a.command.localeCompare(b.command));

  const perCommand: CommandStat[] = [...byCmd.entries()]
    .map(([command, rows]) => {
      const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
      const errors = rows.filter((r) => !r.ok).length;
      const lastUsed = rows.map((r) => r.ts).sort().at(-1) ?? '';
      return {
        command,
        calls: rows.length,
        errors,
        errorRate: rows.length ? errors / rows.length : 0,
        p50ms: percentile(lat, 50),
        p95ms: percentile(lat, 95),
        lastUsed,
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const anomalies: Anomaly[] = [];

  // (1) loop: same shelf+command on the SAME target ≥ LOOP_N times inside
  //     LOOP_WINDOW_MS. The key includes the touched entry id(s) so a legitimate
  //     retrospective — many rapid `vote`s across DISTINCT entries in one session
  //     — is not mistaken for a stuck agent, while hammering a single entry (or a
  //     repeated entry-less call such as `show <shelf>`) still trips it. Entry-less
  //     calls share the empty target, preserving the original shelf+command grouping.
  const LOOP_N = loopN();
  const LOOP_WINDOW_MS = loopWindowSec() * 1000;
  const byShelfCmd = new Map<string, number[]>();
  for (const r of recent) {
    // A `search` row carries the surfaced entry ids since issue #114 (for the
    // serendipity provenance join), but the loop detector must keep treating it
    // as entry-less: searches are grouped by shelf+command so a stuck agent
    // hammering `search` with VARYING queries still trips the loop, exactly as
    // before #114. Only the serendipity computation reads a search row's entries.
    const target = r.command === 'search' ? '' : r.entries.slice().sort().join(',');
    const k = `${r.role}\u0000${r.command}\u0000${target}`;
    const arr = byShelfCmd.get(k) ?? [];
    arr.push(Date.parse(r.ts));
    byShelfCmd.set(k, arr);
  }
  for (const [k, tsList] of byShelfCmd) {
    const sortedTs = tsList.sort((a, b) => a - b);
    for (let i = 0; i + LOOP_N - 1 < sortedTs.length; i++) {
      if (sortedTs[i + LOOP_N - 1] - sortedTs[i] <= LOOP_WINDOW_MS) {
        const [shelf, command] = k.split('\u0000');
        anomalies.push({
          kind: 'loop',
          command,
          role: shelf,
          shelf,
          detail: `${LOOP_N}+ calls within ${Math.round(LOOP_WINDOW_MS / 1000)}s — the agent may be stuck/looping`,
        });
        break;
      }
    }
  }

  // (2) went-silent: a command used historically but not at all in the recent window.
  const SILENT_MS = silentHours() * 3600_000;
  const lastSeen = new Map<string, number>();
  for (const r of all) {
    const t = Date.parse(r.ts);
    lastSeen.set(r.command, Math.max(lastSeen.get(r.command) ?? 0, t));
  }
  for (const [command, last] of lastSeen) {
    const age = now - last;
    if (age > SILENT_MS && !byCmd.has(command)) {
      anomalies.push({
        kind: 'went-silent',
        command,
        detail: `last used ${Math.round(age / 3600_000)}h ago, 0 calls in the window — it may have broken or been abandoned`,
      });
    }
  }

  // (3) high-error-rate: enough calls and a high failure fraction.
  const ERR_MIN = errMin();
  const ERR_RATE = errRate(); // bad value → default, not NaN (which disables detection)
  for (const c of perCommand) {
    if (c.calls >= ERR_MIN && c.errorRate >= ERR_RATE) {
      // Break the rate down by error class (issue #176) so the anomaly names a
      // lever: `too_long 78%, bad_args 14%, other 8%` tells the operator the
      // single likely cause instead of a dead-end "broken". Falls back to the
      // generic phrase only when there are no error rows to classify (a
      // degenerate NB_ERR_RATE=0 config flags a 0-error command).
      const errRows = (byCmd.get(c.command) ?? []).filter((r) => !r.ok);
      const breakdown = errRows.length
        ? errorClassBreakdown(errRows)
        : 'broken or not behaving as expected';
      anomalies.push({
        kind: 'high-error-rate',
        command: c.command,
        detail: `${Math.round(c.errorRate * 100)}% errors over ${c.calls} calls — ${breakdown}`,
      });
    }
  }

  // Free diagnostic signals (issue #72): three memory-quality observations read
  // straight from the windowed, shelf-scoped `recent` rows — no new agent action.
  // Each is implied by behavior the agent already performs for its own reasons.
  const signals: DiagnosticSignal[] = [];

  // (A) browse-without-use: a notebook `show`n in a session with no `vote` on any
  //     of its entries that session → the description may over-promise. The unit
  //     is the (session, shelf) pair, so it needs NB_SESSION — rows with a blank
  //     session can't be grouped and are skipped (FR-USAGE-002: "co-access is
  //     then not computed"). A vote anywhere in the session counts as use.
  {
    const browsed = new Map<string, { shown: boolean; voted: boolean }>(); // session \u0000 shelf
    for (const r of recent) {
      if (r.session === '') continue;
      if (r.command !== 'show' && !(r.command === 'vote' && (r.outcome === 'up' || r.outcome === 'down'))) continue;
      const k = `${r.session}\u0000${r.role}`;
      const cur = browsed.get(k) ?? { shown: false, voted: false };
      if (r.command === 'show') cur.shown = true;
      else cur.voted = true;
      browsed.set(k, cur);
    }
    for (const [k, v] of browsed) {
      if (!v.shown || v.voted) continue;
      const [session, shelf] = k.split('\u0000');
      signals.push({
        kind: 'browse-without-use',
        role: shelf,
        shelf,
        session,
        detail: `shown in session "${session}" but no entry was voted that session — the notebook's description may over-promise`,
      });
    }
  }

  // (B) eviction-while-still-voted: an `add` evicted one or more entries (its
  //     `evicted` column is a comma-separated list of `<id>:<score>` pairs —
  //     usually one, but a cap decrease can evict many at once, issue #306)
  //     whose final score was still above the +1 a new lesson starts at → a
  //     lesson agents voted up, and that had not aged or been voted back down,
  //     was lost. Every such pair is counted, so a mass eviction surfaces each
  //     still-voted loss, not just the first. Evicting an entry at +1 or below is
  //     the cap doing its job. A trailing `+<dropped>` token (the overflow marker
  //     `formatEvictedUsage` appends when the list is too long to record in full)
  //     carries no per-entry score, so it is skipped here.
  {
    const seen = new Set<string>(); // dedup repeat evictions of the same shelf+id
    for (const r of recent) {
      if (r.command !== 'add' || r.evicted === '') continue;
      for (const pair of r.evicted.split(',')) {
        if (pair.startsWith('+')) continue; // `+<dropped>` overflow marker — count only, no per-entry score
        const [evictedId, scoreRaw] = pair.split(':');
        if (!evictedId || !(Number(scoreRaw) > 1)) continue;
        const k = `${r.role}\u0000${evictedId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        signals.push({
          kind: 'eviction-while-still-voted',
          role: r.role,
          shelf: r.role,
          entry: evictedId,
          detail: `entry ${evictedId} was evicted by the cap with score ${scoreRaw} — if this repeats, the cap may be too tight for shelf "${r.role}"`,
        });
      }
    }
  }

  // (C) vote-reversal across sessions: the same entry upvoted in one session and
  //     downvoted in a DIFFERENT session → correct but mis-aimed. Needs a session
  //     on both votes; same-session reversals don't count (not "across sessions").
  {
    const ups = new Map<string, Set<string>>(); // id → sessions it was upvoted in
    const downs = new Map<string, Set<string>>(); // id → sessions it was downvoted in
    const shelfOf = new Map<string, string>(); // id → shelf, for reporting
    for (const r of recent) {
      if (r.command !== 'vote' || r.session === '') continue;
      const target = r.outcome === 'up' ? ups : r.outcome === 'down' ? downs : null;
      if (!target) continue;
      for (const id of r.entries) {
        let s = target.get(id);
        if (!s) { s = new Set(); target.set(id, s); }
        s.add(r.session);
        shelfOf.set(id, r.role);
      }
    }
    for (const [id, upSessions] of ups) {
      const downSessions = downs.get(id);
      if (!downSessions) continue;
      // Reversal "across sessions" ⇔ some up-session differs from some down-session.
      const crossSession = [...upSessions].some((u) => [...downSessions].some((d) => d !== u));
      if (!crossSession) continue;
      signals.push({
        kind: 'vote-reversal',
        role: shelfOf.get(id) ?? '',
        shelf: shelfOf.get(id) ?? '',
        entry: id,
        detail: `entry ${id} was upvoted and downvoted in different sessions — it may be correct but mis-aimed`,
      });
    }
  }

  // (D) failed-search → add: within one session a `search` returned nothing
  //     (`no-match`, its query kept in `note`) and a lesson was then ACCEPTED by
  //     `add` → the agent searched, found nothing, and had to add it: a coverage
  //     gap the notebook lacked, labelled by the agent's own query (issue #82 —
  //     the gap-sensor the demoted `nb search` fallback unlocks). Needs a session
  //     on both rows; `recent` is not guaranteed ts-sorted, so order within a
  //     session before pairing. One signal per (session, added-entry) pair.
  {
    const bySession = new Map<string, UsageRow[]>();
    for (const r of recent) {
      if (r.session === '') continue;
      const arr = bySession.get(r.session) ?? [];
      arr.push(r);
      bySession.set(r.session, arr);
    }
    const seen = new Set<string>(); // dedup repeat (session, added-entry) pairs
    for (const [session, rowsRaw] of bySession) {
      const rows = [...rowsRaw].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      let lastFailedQuery: string | null = null;
      for (const r of rows) {
        if (r.command === 'search' && r.outcome === 'no-match') {
          lastFailedQuery = r.note !== '' ? r.note : '(query not recorded)';
        } else if (r.command === 'add' && r.outcome === 'accepted' && lastFailedQuery !== null) {
          const addId = r.entries[0] ?? '';
          const k = `${session}\u0000${addId}`;
          if (seen.has(k)) continue;
          seen.add(k);
          signals.push({
            kind: 'failed-search',
            role: r.role,
            shelf: r.role,
            session,
            entry: addId !== '' ? addId : undefined,
            detail: `a search for "${lastFailedQuery}" returned nothing, then a lesson was added to "${r.role}" in the same session — a coverage gap the notebook did not hold`,
          });
        }
      }
    }
  }

  // (E) add-burst (issue #353): a session accepted MORE than `NB_ADD_BURST_N` adds
  //     into one shelf. Counts the `accepted` add rows the usage log already holds,
  //     per (session, shelf) — the unit that shortens THAT shelf's retention window.
  //     Needs a session (a blank one cannot be grouped, as in (A)/(D)).
  {
    const burstN = addBurstN();
    const perSessionShelf = new Map<string, number>(); // session \u0000 shelf → accepted adds
    for (const r of recent) {
      if (r.command !== 'add' || r.outcome !== 'accepted' || r.session === '') continue;
      const k = `${r.session}\u0000${r.role}`;
      perSessionShelf.set(k, (perSessionShelf.get(k) ?? 0) + 1);
    }
    for (const [k, n] of perSessionShelf) {
      if (n <= burstN) continue;
      const [session, shelf] = k.split('\u0000');
      signals.push({
        kind: 'add-burst',
        role: shelf,
        shelf,
        session,
        detail: `${n} accepted adds in one session (threshold ${burstN}) — on a full shelf each add evicts a line, so a burst shortens how long the other lessons survive; add fewer, better lessons per session`,
      });
    }
  }

  // Deterministic order so renderers and tests see a stable sequence.
  const sigOrder: Record<DiagnosticSignal['kind'], number> = {
    'browse-without-use': 0,
    'eviction-while-still-voted': 1,
    'vote-reversal': 2,
    'failed-search': 3,
    'add-burst': 4,
  };
  signals.sort(
    (a, b) =>
      sigOrder[a.kind] - sigOrder[b.kind] ||
      a.shelf.localeCompare(b.shelf) ||
      (a.entry ?? a.session ?? '').localeCompare(b.entry ?? b.session ?? ''),
  );

  // Surfacing metrics (issue #81): the NAMED recall-miss / precision-miss rates
  // and the coverage×surfacing readout of §4, engagement-gated. The gate: a
  // session counts only once it shows a vote (the agent is both wired up AND
  // instructed), so a vote-less session — a setup/plumbing gap — is excluded
  // rather than mis-scored as "healthy quiet". Rows with a blank session can't be
  // attributed to a session and are skipped (same as the session-scoped signals).
  const engaged = new Set<string>();
  for (const r of recent) {
    if (r.command === 'vote' && r.session !== '' && (r.outcome === 'up' || r.outcome === 'down')) {
      engaged.add(r.session);
    }
  }
  // Serendipity provenance (issue #114): which entry ids each session PULLED via
  // `search`. Built from the deployment-wide `recentAll`, NOT the (possibly
  // shelf-scoped) `recent`, because a `search` row is logged under shelf `-` and
  // would be filtered out of a scoped `recent` — so a scoped `nb stats <shelf>`
  // could not see the cross-notebook search that marks one of its upvotes a pull.
  // (Same deployment-wide-reads precedent as the engagement diagnosis of #105.)
  const searchedBySession = new Map<string, Set<string>>();
  for (const r of recentAll) {
    if (r.command !== 'search' || r.session === '' || r.entries.length === 0) continue;
    let set = searchedBySession.get(r.session);
    if (!set) {
      set = new Set<string>();
      searchedBySession.set(r.session, set);
    }
    for (const id of r.entries) set.add(id);
  }

  let accepted = 0;
  let dedupBlocked = 0;
  let rejectedFull = 0;
  let up = 0;
  let down = 0;
  let pushUp = 0; // upvotes with NO same-session search-pull evidence (serendipity numerator, #114)
  for (const r of recent) {
    if (r.session === '' || !engaged.has(r.session)) continue;
    if (r.command === 'add') {
      if (r.outcome === 'accepted') accepted++;
      else if (r.outcome === 'dedup-blocked') dedupBlocked++;
      else if (r.outcome === 'rejected-full') rejectedFull++;
    } else if (r.command === 'vote') {
      if (r.outcome === 'up') {
        up++;
        // Pushed (candidate serendipity) unless a search in THIS session returned
        // this entry id — then the agent reached it by search, i.e. a pull.
        const pulled = searchedBySession.get(r.session)?.has(r.entries[0] ?? '') ?? false;
        if (!pulled) pushUp++;
      } else if (r.outcome === 'down') down++;
    }
  }
  const addAttempts = accepted + dedupBlocked + rejectedFull;
  const votesActedOn = up + down;
  // Rates are null (not a misleading 0 — DP-5) when their denominator is empty.
  const coverage = addAttempts ? accepted / addAttempts : null;
  const recallMiss = addAttempts ? dedupBlocked / addAttempts : null;
  const precisionMiss = votesActedOn ? down / votesActedOn : null;
  // Serendipity (issue #114): share of upvotes on push-delivered (= not
  // search-pulled) lessons. A two-sided proxy, not a bound — see `SurfacingMetrics.serendipity`.
  const serendipity = up ? pushUp / up : null;
  const coverageHiThr = coverageHi();
  const recallMissHiThr = recallMissHi();
  // The 2×2: novel-adds (coverage) LOW/HIGH × dedup-blocks (recall-miss) LOW/HIGH.
  let readout: SurfacingMetrics['readout'] = null;
  if (coverage !== null && recallMiss !== null) {
    const coverageHigh = coverage >= coverageHiThr;
    const recallHigh = recallMiss >= recallMissHiThr;
    readout = coverageHigh
      ? (recallHigh ? 'churny' : 'coverage-building')
      : (recallHigh ? 'surfacing-failure' : 'healthy');
  }
  const window =
    windowMs % 86_400_000 === 0
      ? `${windowMs / 86_400_000}d`
      : windowMs % 3_600_000 === 0
        ? `${windowMs / 3_600_000}h`
        : `${Math.round(windowMs / 60_000)}m`;

  // Notebook inventory (issue #40). Independent of the usage window — it is the
  // current on-disk state, not a time slice. Scoped to the requested shelf when given,
  // mirroring the per-command filtering above. `cap` is read once so every row
  // and the total report the same value. Computed before the surfacing object so
  // its line total can gate the engagement diagnosis below (issue #105).
  const cap = maxLines();
  const inventoryShelves = scope ? listShelves(dir).filter((r) => r === scope) : listShelves(dir);
  // `stats` is the scan an operator runs to find out WHY memory is unhealthy, and
  // the janitor drives it from the same directory — so it must survive a damaged
  // store exactly like `list`/`search` (issue #332). Skip (and report) only the
  // unreadable shelf so the healthy inventory still prints; a codeless throw still
  // propagates (see `skipUnreadable`).
  const skipped: SkippedShelf[] = [];
  const conflicts: ConflictShelf[] = [];
  const notebooks: NotebookStat[] = [];
  // Accepted adds per shelf over the window (issue #353) — the pace the cap acts at.
  const acceptedAdds = new Map<string, number>();
  for (const r of recent) {
    if (r.command === 'add' && r.outcome === 'accepted') acceptedAdds.set(r.role, (acceptedAdds.get(r.role) ?? 0) + 1);
  }
  const windowDays = windowMs / 86_400_000;
  for (const shelf of inventoryShelves) {
    const read = skipUnreadable(shelf, () => readShelf(dir, shelf));
    if (read.error) {
      skipped.push(read.error);
      continue;
    }
    if (read.value!.conflict !== null) conflicts.push({ shelf, marker: read.value!.conflict });
    const lineCount = read.value!.entries.length;
    const adds = acceptedAdds.get(shelf) ?? 0;
    const addsPerDay = adds / windowDays;
    notebooks.push({
      role: shelf,
      shelf,
      lines: lineCount,
      cap,
      adds,
      addsPerDay: Math.round(addsPerDay * 100) / 100,
      retentionDays: lineCount >= cap && adds > 0 ? Math.max(0.1, Math.round((cap / addsPerDay) * 10) / 10) : null, // floor 0.1d: never a misleading 0
    });
  }
  const notebookTotals: NotebookTotals = {
    roles: notebooks.length,
    shelves: notebooks.length,
    lines: notebooks.reduce((sum, n) => sum + n.lines, 0),
    cap,
  };

  // Zero-engagement root-cause split (issue #105). Deployment-wide, NOT
  // shelf-scoped: gated on global engagement (a vote on ANY shelf means the setup
  // works, so no deployment-level diagnosis), and fed the global windowed rows +
  // the total lessons across all notebooks (see `diagnoseEngagement`). This is
  // why a shelf-scoped `nb stats <shelf>` whose shelf is quiet but whose
  // deployment is healthy shows the plain "no engaged sessions" line, not a
  // false "hook not wired".
  const engagedAll = new Set<string>();
  for (const r of recentAll) {
    if (r.command === 'vote' && r.session !== '' && (r.outcome === 'up' || r.outcome === 'down')) {
      engagedAll.add(r.session);
    }
  }
  const engagementDiagnosis =
    engagedAll.size === 0
      ? diagnoseEngagement(recentAll, globalStoredLessons(dir, notebooks, scope))
      : null;

  const surfacing: SurfacingMetrics = {
    engagedSessions: engaged.size,
    addAttempts,
    coverage,
    recallMiss,
    votesActedOn,
    precisionMiss,
    upvotes: up,
    serendipity,
    readout,
    engagementDiagnosis,
  };

  // Ops-per-day activity sparkline (issue #106): bucket the same windowed,
  // scoped `recent` rows into rolling-24h buckets anchored at `now`, so the
  // array sums to `totalCalls` and the human renderer can draw one activity line.
  const activity = activityByDay(
    recent.map((r) => Date.parse(r.ts)),
    now,
    windowMs,
  );

  // Crash-recovery readout (issue #309): sum the per-row `recovered` column —
  // `<lockSteals>:<tempReaps>`, blank when none — across the DEPLOYMENT-WIDE
  // windowed rows (`recentAll`, not the shelf-scoped `recent`). A stolen stale
  // lock and a reaped leftover temp are dir-global recovery events: the `.nb.lock`
  // and the `*.tmp` debris are shared by every shelf, and the operator's "are my
  // agents crashing mid-write?" question is a deployment question, not a per-shelf
  // one — so this mirrors `usageRing` in staying unscoped (only the window
  // applies). A blank/old/malformed column parses as 0 and is skipped.
  let crashLockSteals = 0;
  let crashTempReaps = 0;
  for (const r of recentAll) {
    if (!r.recovered) continue;
    const [s, t] = r.recovered.split(':');
    crashLockSteals += Number.parseInt(s ?? '', 10) || 0;
    crashTempReaps += Number.parseInt(t ?? '', 10) || 0;
  }

  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    window,
    generatedAt: new Date(now).toISOString(),
    windowStart: new Date(now - windowMs).toISOString(),
    totalCalls: recent.length,
    perCommand,
    errorCauses,
    anomalies,
    notebooks,
    notebookTotals,
    skipped,
    conflicts,
    signals,
    surfacing,
    activity,
    // Total ring occupancy (issue #206): the full on-disk row count, NOT the
    // windowed `recent`/`totalCalls`, so it reads as "how full is the log" rather
    // than "how busy was the window". Reuses the `parsed` array already read — no
    // second ring scan (the #206 risk note).
    usageRing: { rows: parsed.length, cap: usageRing() },
    // Crash-recovery readout (issue #309): deployment-wide, window-scoped counts
    // of the two silent recovery events, so "are agents crashing mid-write?" is
    // answerable from `nb stats`. Shown even at {0,0} (healthy) — see the field doc.
    crashRecovery: { lockSteals: crashLockSteals, tempReaps: crashTempReaps },
  };
}
