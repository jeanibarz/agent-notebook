/**
 * The usage log (issue #478 moved it here from `notebook.ts`): one terse TSV row
 * per `nb` call, appended to `<dir>/.nb-usage.log`, a bounded ring of
 * `NB_USAGE_RING` rows. It is the notebook's self-monitoring input, read back by
 * `nb stats` (`stats.ts`); it never holds a lesson, only ids, outcome tokens and
 * bounded codes.
 *
 * Nothing in the cap-and-vote mechanism (`notebook.ts`) depends on this module.
 * The CLI calls `logUsage` once per command, after the command has finished.
 * Crash-recovery counts reach it through `drainPendingRecovery`, the tally that
 * core's lock and temp-file recovery paths fill.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeShelf,
  drainPendingRecovery,
  entryId,
  maxChars,
  preserveMode,
  sanitizeLesson,
  stripControlChars,
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
  /** Outcome token: `accepted`/`dedup-blocked`/`rejected-full`/`empty`/`too-long` (add), `up`/`down` (vote), `removed` (rm), `merged` (merge), `split` (split), `moved`/`move-blocked` (move; `move-blocked` = the target already held a near-duplicate), `match`/`no-match`/`no-terms`/`no-shelf` (search, with the query in `note` and, for a `match`, the surfaced ids in `entries` — issue #114; `no-terms` = the query had no searchable tokens, so it is NOT a coverage gap; `no-shelf` = the prefix operand matched no shelf name, so nothing was searched and it is NOT a coverage gap either); `''` otherwise. */
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
      `${new Date().toISOString()}\t${usageShelfField(shelf)}\t${capNote(sanitizeUsageField(command))}\t${ok ? 'ok' : 'err'}\t${Math.round(ms)}ms` +
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

    if (lines.length < compactAt) {
      // Still under cap + slack: append in place (no rewrite, no rename). This is
      // the same threshold as the fast path — a stale sidecar on a full ring must
      // not rewrite the log on every overlapping call and drop a concurrent
      // writer's row (issue #377). Record the now-known count+size. Guard the trailing newline — a previous
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
    preserveMode(file, tmp);
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
