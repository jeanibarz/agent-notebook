/**
 * The usage log (issue #478 moved it here from `notebook.ts`): one terse TSV row
 * per `nb` call, appended to `<dir>/.nb-usage.log`, a bounded ring of
 * `NB_USAGE_RING` rows. It is the notebook's self-monitoring input, read back by
 * `nb stats` (`stats.ts`); it never holds a lesson, only ids, outcome tokens and
 * bounded codes.
 *
 * Nothing in the cap-and-vote mechanism (`notebook.ts`) depends on this module.
 * The CLI calls `appendUsage` once per command, after the command has finished.
 * Crash-recovery counts reach it through `drainPendingRecovery`, the tally that
 * core's lock and temp-file recovery paths fill.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import {
  assertSafeShelf,
  drainPendingRecovery,
  entryId,
  escapeDiskName,
  maxChars,
  releaseLock,
  sanitizeLesson,
  stripControlChars,
  tryAcquireLock,
  usageFile,
  usageRing,
  usageRingSlack,
} from './notebook.js';
import type { Entry, ErrorClass } from './notebook.js';

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
  /** Outcome token: `accepted`/`dedup-blocked`/`rejected-full`/`empty`/`too-long` (add), `up`/`down` (vote), `removed` (rm), `merged` (merge), `split` (split), `moved`/`move-blocked` (move; `move-blocked` = the target already held a near-duplicate), `no-shelf` (show of a shelf with no notebook file, issue #480), `off` (a text `list` that printed the switched-off line in place of the index, issue #514), `match`/`no-match`/`no-terms`/`no-shelf` (search, with the query in `note` and, for a `match`, the surfaced ids in `entries` — issue #114; `no-terms` = the query had no searchable tokens, so it is NOT a coverage gap; `no-shelf` = the prefix operand matched no shelf name, so nothing was searched and it is NOT a coverage gap either); `''` otherwise. */
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
  /** The `nb` version that wrote the row (issue #558); `''` on a row written before it, and on every row but `brief` and `retro`. Trailing column 17. */
  version: string;
  /** The project key of a `brief`/`retro` row given `--hook` (issue #558, `projectRecordKey`); `''` otherwise and on old rows. Trailing column 18. */
  project: string;
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
  /**
   * The `nb` version to record (issue #558). Set only by `brief` and `retro`: when
   * it is present the row gains two trailing columns, `version` and `project`;
   * when absent the row is byte-identical to before. Cleaned to `[0-9A-Za-z.+-]`
   * and capped at 32 characters, never cut with `…`.
   */
  version?: string;
  /** The project key (`projectRecordKey`), recorded with `version`, only when `--hook` was given. Cleaned to `[0-9A-Za-z.:?_-]`, capped at 80, never cut with `…`. */
  project?: string;
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
  // Also drop terminal-manipulating control characters (issue #375): `nb stats`
  // renders these fields, so an ESC/BEL in a command, session or note must never
  // be stored. A well-formed field has none, so it stays byte-identical.
  return stripControlChars(raw.replace(/[\t\r\n]+/g, ' '));
}

/**
 * The usage-log `shelf` column (issue #375). The CLI records its first operand
 * before validating it, so a forgotten shelf (`nb add "<lesson>"`) would write the
 * lesson text into the log. Only a syntactically valid shelf name is recorded; any
 * other operand becomes `-`. A valid-but-mistyped name stays visible.
 */
function usageShelfField(shelf: string): string {
  try {
    assertSafeShelf(shelf);
    return shelf;
  } catch {
    return '-';
  }
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

// ---------------------------------------------------------------------------
// Which files the usage log uses (issue #576, FR-USAGE-005)
// ---------------------------------------------------------------------------

/**
 * Why a usage file was refused: it is a symbolic link, a folder, or something that
 * is not a file at all (a FIFO, a device, a socket). nb never opens a refused file,
 * so a FIFO cannot block a call and a device cannot be read without end.
 */
export type UsageRefusal = 'link' | 'folder' | 'special';

/** The stat fields `usageFileState` needs; an `lstat` result has them. */
export interface UsageStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number | bigint;
}

/**
 * The one rule for every usage file — the log, its `.count` sidecar and the older
 * generation `.nb-usage.log.1` — shared by the writer, `parseUsage` (`nb stats`,
 * `nb status`) and the log check of `nb status`. `st` is an `lstat` result (so a
 * link is seen as a link) or `null` when the path does not exist. Only a regular
 * file is used; a hard link is a regular file.
 */
export function usageFileState(st: UsageStat | null): 'absent' | 'file' | { refused: UsageRefusal } {
  if (st === null) return 'absent';
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return { refused: 'link' };
  if (st.isDirectory()) return { refused: 'folder' };
  return { refused: 'special' };
}

/**
 * The most bytes a usage-log read takes, and the byte size at which the live file
 * is rotated even before it holds `usageRing` rows (issue #576). A row's caps count
 * characters, not bytes, so a multibyte session can make one row 4 KB at
 * `NB_MAX_CHARS=2000`; the real average is about 110 bytes. 1 KiB a row, kept
 * between 1 and 64 MiB: 5 MiB at the default ring.
 */
export function usageByteBudget(): number {
  return Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, usageRing() * 1024));
}

/**
 * The live file's size at which a call stops appending (and says so), reached only
 * when rotations keep failing: twice `usageByteBudget()`. `nb status` uses the same
 * number, so the two never disagree about a log that is too large.
 */
export function usageTooLargeBytes(): number {
  return 2 * usageByteBudget();
}

/** The older generation of the ring (issue #576): the live file is renamed to it when it fills. */
export function usagePrevFile(dir: string): string {
  return `${usageFile(dir)}.1`;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

type Opened = { fd: number; created: boolean } | { refused: UsageRefusal } | 'absent';

function lstatOrNull(path: string): UsageStat | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw e;
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // nothing to release
  }
}

/**
 * Open a usage file without ever blocking or following a link (issue #576). The
 * path is `lstat`ed first and anything but a regular file is refused unopened;
 * the open adds `O_NONBLOCK` and `O_NOFOLLOW` (both missing on Windows, where an
 * `lstat` after the open re-checks the path); and the open descriptor must be a
 * regular file — a FIFO with a reader, `/dev/zero` and a folder all open, so this
 * last check is the one that keeps them out. `'append'` and `'write'` create an
 * absent file with `O_EXCL` and `mode()` (asked only then); a file that appears
 * meanwhile is opened on a second try.
 * Other errors (ENOENT of the folder, EACCES…) are thrown.
 */
function openUsageFile(path: string, how: 'read' | 'append' | 'write', mode: () => number = () => 0o666): Opened {
  for (let attempt = 0; ; attempt++) {
    const st = lstatOrNull(path);
    const state = usageFileState(st);
    if (state !== 'absent' && state !== 'file') return state;
    if (state === 'absent' && how === 'read') return 'absent';
    const base =
      how === 'read' ? fsConstants.O_RDONLY : how === 'append' ? fsConstants.O_RDWR | fsConstants.O_APPEND : fsConstants.O_WRONLY;
    const create = state === 'absent';
    let fd: number;
    try {
      fd = create
        ? openSync(path, base | O_NOFOLLOW | O_NONBLOCK | fsConstants.O_CREAT | fsConstants.O_EXCL, mode())
        : openSync(path, base | O_NOFOLLOW | O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST' && attempt === 0) continue; // created by another call meanwhile
      if (code === 'ENOENT' && !create && attempt === 0) continue; // removed meanwhile
      if (code === 'ELOOP') return { refused: 'link' };
      if (code === 'EISDIR') return { refused: 'folder' };
      if (code === 'ENXIO') return { refused: 'special' };
      throw e;
    }
    try {
      if (!fstatSync(fd).isFile()) {
        closeQuietly(fd);
        return { refused: 'special' };
      }
      if (O_NOFOLLOW === 0) {
        // Gone now means renamed meanwhile (a rotation): the descriptor, a regular
        // file, is still the one we checked, so keep it, as on POSIX.
        const again = usageFileState(lstatOrNull(path));
        if (again !== 'file' && again !== 'absent') {
          closeQuietly(fd);
          return again;
        }
      }
    } catch (e) {
      closeQuietly(fd);
      throw e;
    }
    return { fd, created: create };
  }
}

/** Read `[start, start + len)` of `fd` into a buffer; a short file gives a shorter buffer. */
function readRange(fd: number, start: number, len: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, len));
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/**
 * The rows of the live file, counted without building a string (issue #576): the
 * newline bytes of a file of at most `budget` bytes; a larger file counts as at
 * least `ring` rows (it is rotated anyway). A last row without its `\n` counts.
 */
function countRows(fd: number, size: number, ring: number, budget: number): number {
  if (size === 0) return 0;
  if (size > budget) return ring;
  const buf = readRange(fd, 0, size);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return buf.length > 0 && buf[buf.length - 1] !== 0x0a ? n + 1 : n;
}

/** Whether the file's last byte is a newline (an empty file counts as one). */
function endsWithNewline(fd: number, size: number): boolean {
  if (size === 0) return true;
  const last = readRange(fd, size - 1, 1);
  return last.length === 0 || last[0] === 0x0a;
}

// ---------------------------------------------------------------------------
// The `.count` sidecar (issue #135)
// ---------------------------------------------------------------------------

/**
 * Sidecar recording the live file's row count AND its byte size as of this
 * process's last write, so the hot path decides when to rotate without reading
 * the ring (issue #135). The count is trusted only when the file's size still
 * equals the recorded size; any other change (a concurrent writer, a hand edit, a
 * torn row) falls back to counting. An optional third column (issue #576) is the
 * live file's size at which the next rotation may be tried after one failed or
 * found the lock busy; an older nb reads only the first two.
 *
 * It is a dotfile next to the log — not a `*.md` shelf, and, lacking a `.tmp`
 * suffix, never reaped. It is read and written through `openUsageFile`, so a
 * sidecar planted as a link never redirects the write (issue #576: before, one
 * `nb list` overwrote a link's target).
 */
function usageCountFile(dir: string): string {
  return join(dir, '.nb-usage.log.count');
}

interface UsageState {
  rows: number;
  bytes: number;
  retryAt: number;
}

/** Read the sidecar, or `undefined` if it is missing, refused or unparseable. */
function readUsageState(dir: string): UsageState | undefined {
  let fd: number | undefined;
  try {
    const o = openUsageFile(usageCountFile(dir), 'read');
    if (typeof o === 'string' || 'refused' in o) return undefined;
    fd = o.fd;
    const [rowsRaw, bytesRaw, retryRaw] = readRange(fd, 0, 64).toString('utf-8').trim().split('\t');
    const rows = Number.parseInt(rowsRaw ?? '', 10);
    const bytes = Number.parseInt(bytesRaw ?? '', 10);
    const retryAt = Number.parseInt(retryRaw ?? '', 10);
    if (!Number.isFinite(rows) || rows < 0 || !Number.isFinite(bytes) || bytes < 0) return undefined;
    return { rows, bytes, retryAt: Number.isFinite(retryAt) && retryAt > 0 ? retryAt : 0 };
  } catch {
    return undefined; // the caller falls back to counting
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

/** Best-effort sidecar write; a refused or failed write only makes the next call count. */
function writeUsageState(dir: string, s: UsageState): void {
  let fd: number | undefined;
  try {
    const o = openUsageFile(usageCountFile(dir), 'write');
    if (typeof o === 'string' || 'refused' in o) return;
    fd = o.fd;
    ftruncateSync(fd, 0);
    writeSync(fd, `${s.rows}\t${s.bytes}${s.retryAt > 0 ? `\t${s.retryAt}` : ''}\n`, 0, 'utf-8');
  } catch {
    /* best-effort: the sidecar is only an optimisation */
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * What `appendUsage` did with the row (issue #576): written; not written because the
 * own folder is missing (`noCreate`); refused because a usage file is not a regular
 * file, or because the live file has grown past `usageTooLargeBytes()` (the CLI
 * prints one line for these two); or failed for any other reason (silent, as a
 * read-only store always was).
 */
export type AppendResult =
  | 'written'
  | 'no-folder'
  | 'failed'
  | { refused: UsageRefusal; path: string }
  | { tooLarge: true; path: string };

export function logUsage(
  dir: string,
  shelf: string,
  command: string,
  ok: boolean,
  ms: number,
  meta: UsageMeta = {},
): void {
  appendUsage(dir, shelf, command, ok, ms, meta);
}

/** Crash recovery tallied by core (issue #309): stale locks stolen, leftover temps reaped. */
type Recovery = { lockSteals: number; tempReaps: number };

/**
 * The usage row for a call, without its trailing newline. `rec` is the crash-recovery
 * tally `appendUsage` drained for this row; `at` is when the row was first built, so a
 * row built again after a rotation keeps its time.
 */
function usageLine(shelf: string, command: string, ok: boolean, ms: number, meta: UsageMeta, rec: Recovery, at: Date): string {
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
  // Crash-recovery column (issue #309): the tally that withLock's stale-lock
  // steal and reapLeftoverTemps' temp reap filled during this same process's
  // mutation (and a rotation's steal, issue #585), recorded as
  // `<lockSteals>:<tempReaps>` — blank in the common no-recovery case, so an old
  // reader and old rows are unchanged. `appendUsage` drains it (read-and-reset),
  // so each event is counted on one row; the two counts are machine-generated
  // integers, so no sanitize is needed (no caller text can reach this column).
  const recovered = rec.lockSteals > 0 || rec.tempReaps > 0 ? `${rec.lockSteals}:${rec.tempReaps}` : '';
  // Batch-vote partial misses (issue #310): the count of stale ids skipped by a
  // ≥1-landed batch `vote`. That call exits 0 (`ok=true`) so its misses never
  // reach the err-rate table; recording them lets `nb stats` fold them into the
  // vote error-cause readout. A machine-generated non-negative integer (no
  // caller text, so no sanitize), blank in the common no-miss case so an old
  // reader and old rows are unchanged.
  const misses = meta.misses && meta.misses > 0 ? String(Math.round(meta.misses)) : '';
  // Trailing columns 17 and 18 (issue #558): only a row whose caller passed a
  // `version` (`brief`, `retro`) carries them; every other row stays byte-identical.
  // Neither is cut with `…` nor subject to `NB_MAX_CHARS`: a cleaned value is
  // short by construction, and a cap here is a hard cut of a token.
  const record =
    meta.version === undefined
      ? ''
      : `\t${meta.version.replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32)}\t${(meta.project ?? '').replace(/[^0-9A-Za-z.:?_-]/g, '').slice(0, 80)}`;
  const line =
    `${at.toISOString()}\t${usageShelfField(shelf)}\t${capNote(sanitizeUsageField(command))}\t${ok ? 'ok' : 'err'}\t${Math.round(ms)}ms` +
    `\t${session}\t${entries}\t${outcome}\t${collided}\t${evicted}\t${reason}\t${note}\t${errorClass}\t${decayed}\t${recovered}\t${misses}${record}`;
  return line;
}

/** The mode a new live file takes: that of the older generation, when there is one (#459). */
function generationMode(dir: string): number | undefined {
  try {
    const st = lstatSync(usagePrevFile(dir));
    return st.isFile() ? st.mode & 0o777 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Open the live file for appending; a file this call creates takes the older
 * generation's mode (through `fchmod`, so the umask cannot narrow it), as a
 * compaction kept the mode before (issue #459).
 */
function openLive(dir: string): Opened {
  let mode: number | undefined;
  const o = openUsageFile(usageFile(dir), 'append', () => (mode = generationMode(dir)) ?? 0o666);
  if (typeof o !== 'string' && 'fd' in o && o.created && mode !== undefined) {
    try {
      fchmodSync(o.fd, mode);
    } catch {
      /* chmod unsupported: keep the umask default */
    }
  }
  return o;
}

/**
 * Rotate the ring (issue #576): rename the live file to `.nb-usage.log.1`, dropping
 * the older generation, so a row written meanwhile — even by a call that opened the
 * live file before the rename — lands in a file that readers still read. Under a
 * try-once `.nb.lock` (`tryAcquireLock`: no wait), the live file is counted again
 * and rotated only if it still needs it, so a second rotator, which counted the
 * file a moment before the first renamed it, does not rotate a fresh file over the
 * full one. `holds()` just before the rename stops a rotator whose lock was taken
 * from it as stale. `true` when this call rotated or found the file already rotated;
 * `false` when the lock was busy or the rename failed.
 */
function rotateUsage(dir: string, ring: number, budget: number, rowBytes: number): boolean {
  const h = tryAcquireLock(dir);
  if (h === null) return false;
  try {
    usageTestHook?.('locked');
    const o = openUsageFile(usageFile(dir), 'read');
    if (typeof o === 'string' || 'refused' in o) return true; // gone, or refused: nothing to rotate
    let due: boolean;
    try {
      const size = fstatSync(o.fd).size;
      due = countRows(o.fd, size, ring, budget) + 1 >= ring || size + rowBytes >= budget;
    } finally {
      closeQuietly(o.fd);
    }
    if (!due) return true; // another call rotated it already
    if (!h.holds()) return false;
    renameSync(usageFile(dir), usagePrevFile(dir));
    return true;
  } catch {
    return false; // Windows EPERM/EBUSY, `.1` is a folder…: tried again later
  } finally {
    releaseLock(h);
  }
}

/** A test seam of the rotation (issue #576). Internal: not on the package root. */
let usageTestHook: ((point: 'locked') => void) | undefined;
export function setUsageTestHook(fn: ((point: 'locked') => void) | undefined): void {
  usageTestHook = fn;
}

/**
 * `logUsage`, plus a no-create mode for the CLI (issue #551) and a result (issue
 * #576). With `noCreate` the folder is never created, so a row for a project's own
 * notebook cannot re-create the folder that `nb place shared` removed; the result
 * is then `no-folder` and the caller logs elsewhere. Never throws. Internal: not
 * on the package root.
 *
 * The ring is two generations (issue #576): appends go to `.nb-usage.log` with no
 * lock; when it would reach `usageRing` rows (or `usageByteBudget()` bytes) one
 * call renames it to `.nb-usage.log.1` (see `rotateUsage`) and the row goes to a
 * new live file. Readers keep the newest `usageRing` rows of the two.
 */
export function appendUsage(
  dir: string,
  shelf: string,
  command: string,
  ok: boolean,
  ms: number,
  meta: UsageMeta = {},
  opts: { noCreate?: boolean } = {},
): AppendResult {
  // Checked before the tally is drained, so the crash-recovery counts are not
  // drained into a row that cannot be written.
  if (opts.noCreate === true && !existsSync(dir)) return 'no-folder';
  let fd: number | undefined;
  try {
    if (opts.noCreate !== true) mkdirSync(dir, { recursive: true });
    const file = usageFile(dir);
    const at = new Date();
    let rec = drainPendingRecovery();
    let line = usageLine(shelf, command, ok, ms, meta, rec, at);
    const ring = usageRing();
    const budget = usageByteBudget();
    const rowBytes = Buffer.byteLength(line) + 1;

    let o = openLive(dir);
    if (o === 'absent') return 'failed'; // not reachable in append mode
    if ('refused' in o) return { refused: o.refused, path: file };
    fd = o.fd;

    // The row count: the sidecar's when the file's size still matches it, else counted.
    const state = readUsageState(dir);
    let size = fstatSync(fd).size;
    let trusted = state !== undefined && state.bytes === size;
    let rows = trusted ? state!.rows : countRows(fd, size, ring, budget);
    let retryAt = state?.retryAt ?? 0;

    // Rotate before appending, so the row goes to the new live file. A failed or
    // busy rotation is tried again `usageRingSlack()` rows later (by size, which
    // keeps growing whatever the count says); without a readable sidecar, every
    // call tries. A log already past the size cap tries on every call, so a cause
    // that went away (a `.1` folder removed) ends the refusals at once.
    const tooLarge = usageTooLargeBytes();
    if ((rows + 1 >= ring || size + rowBytes >= budget) && (size >= retryAt || size >= tooLarge)) {
      const rotated = rotateUsage(dir, ring, budget, rowBytes);
      // A stale `.nb.lock` the rotation stole (issue #585) is tallied after the row
      // was built: drain again, whatever the rotation's result, and build the row
      // again with both counts. Only a call that tried to rotate gets here.
      const late = drainPendingRecovery();
      if (late.lockSteals > 0 || late.tempReaps > 0) {
        rec = { lockSteals: rec.lockSteals + late.lockSteals, tempReaps: rec.tempReaps + late.tempReaps };
        line = usageLine(shelf, command, ok, ms, meta, rec, at);
      }
      if (rotated) {
        closeQuietly(fd);
        fd = undefined;
        o = openLive(dir);
        if (o === 'absent') return 'failed';
        if ('refused' in o) return { refused: o.refused, path: file };
        fd = o.fd;
        size = fstatSync(fd).size;
        rows = countRows(fd, size, ring, budget);
        trusted = false; // the sidecar described the old file
        retryAt = 0;
      } else {
        retryAt = size + usageRingSlack() * rowBytes;
      }
    }
    if (size >= tooLarge) {
      writeUsageState(dir, { rows, bytes: size, retryAt });
      // Name the file that blocks the rotation when it is the older generation: a
      // folder there (a rename replaces a link or a FIFO), as `nb status` says.
      const prev = usageFileState(lstatOrNull(usagePrevFile(dir)));
      if (typeof prev === 'object' && prev.refused === 'folder') return { refused: 'folder', path: usagePrevFile(dir) };
      return { tooLarge: true, path: file };
    }
    // A previous writer may have crashed mid-row, leaving no final `\n`: a blind
    // append would glue our row onto theirs. A trusted sidecar proves the file
    // still ends with the `\n` we wrote.
    const lead = !trusted && !endsWithNewline(fd, size) ? '\n' : '';
    const buf = Buffer.from(`${lead}${line}\n`, 'utf-8');
    writeSync(fd, buf, 0, buf.length);
    writeUsageState(dir, { rows: rows + 1, bytes: size + buf.length, retryAt });
    return 'written';
  } catch (e) {
    // The folder went away between the check above and the write: the caller logs elsewhere.
    if (opts.noCreate === true && (e as NodeJS.ErrnoException)?.code === 'ENOENT' && !existsSync(dir)) return 'no-folder';
    /* monitoring is best-effort; never fail a real operation because the log write failed */
    return 'failed';
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

/**
 * The one line a call prints on stderr when its usage row was not written because
 * of what a usage file is (issue #576), or `null`. Written for a person who may not
 * know the words, and for an assistant to pass on. The path is escaped, with the
 * home folder shown as `~`.
 */
export function usageNotice(result: AppendResult, home: string): string | null {
  if (typeof result === 'string') return null;
  let shown = result.path;
  if (home !== '' && isAbsolute(home) && home !== sep && shown.startsWith(home + sep)) shown = `~${shown.slice(home.length)}`;
  shown = escapeDiskName(shown.length > 512 ? `${shown.slice(0, 512)}...` : shown);
  const head = `nb (the notebook): this use of the notebook was not recorded in its usage log, because ${shown}`;
  if ('tooLarge' in result) {
    return `${head} has grown past ${Math.round(usageTooLargeBytes() / (1024 * 1024))} MB and the notebook could not start a new one. Your lessons are not in that file; delete it and the notebook starts a new log.`;
  }
  const what =
    result.refused === 'link'
      ? 'is a shortcut (symbolic link) instead of a normal file. Your lessons are not in that file. Delete the link itself, not what it points to, and the notebook starts a new log.'
      : result.refused === 'folder'
        ? 'is a folder instead of a normal file. Your lessons are not in it; look inside it before you delete it, and the notebook starts a new log.'
        : 'is a special system file instead of a normal file. Your lessons are not in it; delete it and the notebook starts a new log.';
  return `${head} ${what} If it keeps coming back, a sync app (iCloud Drive, Dropbox) may be changing the notebook folder.`;
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

/** Options of `parseUsage`. */
export interface ParseUsageOptions {
  /**
   * Read at most `maxBytes` of the two generations together (issue #558), for a
   * reader that must stay small (`nb status`). Without it the budget is
   * `usageByteBudget()` (issue #576). Either way only regular files are read, every
   * open is non-blocking, the first, possibly partial, line of a cut read is dropped,
   * and it never throws.
   */
  maxBytes?: number;
}

/** The text of the last `maxBytes` of `fd`, dropping a first partial line when the read is cut. */
function tailText(fd: number, maxBytes: number): string {
  const size = fstatSync(fd).size;
  const len = Math.min(size, Math.max(0, Math.floor(maxBytes)));
  if (len === 0) return '';
  const start = size - len;
  const text = readRange(fd, start, len).toString('utf-8');
  if (start === 0) return text;
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}

function openForRead(path: string): number | undefined {
  try {
    const o = openUsageFile(path, 'read');
    return typeof o === 'string' || 'refused' in o ? undefined : o.fd;
  } catch {
    return undefined;
  }
}

/**
 * The usage rows, oldest first: the newest `usageRing` rows of the older generation
 * and the live file (issue #576). The live file is opened first and `.1` second, and
 * `.1` is skipped when it is the same file (a rotation happened between the two
 * opens), so no row is read twice. A refused file (a link, a FIFO, a folder…) gives
 * no rows. Never throws.
 */
export function parseUsage(dir: string, opts: ParseUsageOptions = {}): UsageRow[] {
  const budget = opts.maxBytes ?? usageByteBudget();
  const ring = usageRing();
  const live = openForRead(usageFile(dir));
  const prev = openForRead(usagePrevFile(dir));
  try {
    let liveText = '';
    let prevText = '';
    let used = 0;
    if (live !== undefined) {
      try {
        liveText = tailText(live, budget);
        used = Buffer.byteLength(liveText);
      } catch {
        liveText = '';
      }
    }
    const liveRows = parseRows(liveText);
    if (prev !== undefined && liveRows.length < ring && used < budget) {
      try {
        const a = live === undefined ? null : fstatSync(live, { bigint: true });
        const b = fstatSync(prev, { bigint: true });
        if (a === null || a.ino !== b.ino || a.dev !== b.dev) prevText = tailText(prev, budget - used);
      } catch {
        prevText = '';
      }
    }
    const rows = prevText === '' ? liveRows : parseRows(prevText).concat(liveRows);
    return rows.length > ring ? rows.slice(rows.length - ring) : rows;
  } finally {
    if (live !== undefined) closeQuietly(live);
    if (prev !== undefined) closeQuietly(prev);
  }
}

function parseRows(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    // Positional parse, tolerant of old five-column rows: the richer columns
    // (session…recovered) are undefined on a pre-upgrade row and default to
    // blank/empty, so a ring written before this change still reads cleanly.
    // `misses` (issue #310) is the current trailing column, appended after
    // `recovered` (#309), itself after `decayed` (#293); a row from before any of
    // them ends earlier, so the missing trailing columns are undefined here and
    // default to `''`/`0`.
    const [ts, shelf, command, status, msRaw, session, entriesRaw, outcome, collided, evicted, reason, note, errorClass, decayed, recovered, misses, version, project] =
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
      version: version ?? '',
      project: project ?? '',
    });
  }
  return rows;
}
