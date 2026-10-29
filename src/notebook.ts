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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Hard caps, read at call time so they can be tuned by env without a code change (and set per-test). */
export function maxLines(): number {
  return clampInt(process.env.NB_MAX_LINES, 50, 1, 5000);
}
export function maxChars(): number {
  return clampInt(process.env.NB_MAX_CHARS, 200, 20, 2000);
}
/** The usage log is itself a bounded ring (monitoring can't grow unbounded either). */
export function usageRing(): number {
  return clampInt(process.env.NB_USAGE_RING, 5000, 100, 100000);
}

function clampInt(raw: string | undefined, dflt: number, lo: number, hi: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** Clamp an env-supplied rate to [0, 1]; a missing/non-numeric value falls back to the default (never NaN, which would break the LOW/HIGH comparison). Mirrors the NB_ERR_RATE handling. */
function clampRate(raw: string | undefined, dflt: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
}

/** The coverage×surfacing readout thresholds (issue #81). A rate ≥ its HIGH cutoff reads as "HIGH" on that axis; both default to a deliberately blunt split, tunable via env. */
export const DEFAULT_COVERAGE_HI = 0.5;
export const DEFAULT_RECALL_MISS_HI = 0.2;

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

export function assertSafeShelf(shelf: string): void {
  if (shelf.length > MAX_SHELF_LEN) {
    throw new Error(
      `invalid shelf name: ${JSON.stringify(shelf)} (too long: ${shelf.length} chars, max ${MAX_SHELF_LEN})`,
    );
  }
  if (!SAFE_SHELF.test(shelf) || shelf.includes('..')) {
    throw new Error(`invalid shelf name: ${JSON.stringify(shelf)} (allowed: letters, digits, . _ @ -)`);
  }
  if (RESERVED_SHELVES.has(shelf.toLowerCase())) {
    throw new Error(`invalid shelf name: ${JSON.stringify(shelf)} (reserved: a README.md is not a notebook)`);
  }
}

/** @deprecated use assertSafeShelf — same function, kept so existing callers keep working. */
export const assertSafeRole = assertSafeShelf;

/** The notebooks directory. `NB_DIR` overrides; default `~/.agent-notebook/notebooks`. */
export function notebooksDir(): string {
  return process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? process.env.NB_DIR
    : join(homedir(), '.agent-notebook', 'notebooks');
}

function shelfFile(dir: string, shelf: string): string {
  assertSafeShelf(shelf);
  return join(dir, `${shelf}.md`);
}

function usageFile(dir: string): string {
  return join(dir, '.nb-usage.log');
}

// ---------------------------------------------------------------------------
// line (de)serialisation
// ---------------------------------------------------------------------------

/**
 * Flatten a lesson to a single whitespace-collapsed line with no tab (our field
 * separator). Does NOT truncate: the caller enforces the length cap by rejecting
 * an over-long write (addEntry/merge), so the agent can retry with a shorter
 * *complete* lesson instead of silently storing a cut-off, possibly useless one.
 */
export function sanitizeLesson(raw: string): string {
  return raw.replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  const file = shelfFile(dir, shelf);
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (META_RE.test(line)) out.push(line);
    else break; // first entry (or blank) ends the leading metadata block
  }
  return out;
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

async function withLock<T>(dir: string, fn: () => T): Promise<T> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.nb.lock');
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock); // atomic: succeeds only if it did not exist
      break;
    } catch {
      // Stale-lock recovery: a crashed nb process can leave .nb.lock behind.
      // If the lock dir is older than the whole acquire budget, steal it.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        /* lock vanished between mkdir and stat — just retry */
      }
      if (Date.now() > deadline) {
        throw new Error('notebook is locked (another nb process did not release within 2s)');
      }
      await sleep(20);
    }
  }
  try {
    reapLeftoverTemps(dir);
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* best-effort release */
    }
  }
}

/**
 * Reap orphaned notebook temp files left behind by a crashed writer. A durable
 * notebook write goes to `<shelf>.md.tmp` and is renamed over `<shelf>.md`
 * (writeFileDurable); if the process dies between creating that temp and the
 * rename, the `.md.tmp` orphan lingers in the notebooks dir forever — nothing
 * else removes it, and it clutters directory listings, backups, and a
 * git-tracked notebooks dir. We sweep it here, under the just-acquired mkdir
 * lock, which serializes every mutation — so any `*.md.tmp` we see is dead
 * crash debris, never a rename in flight by a live writer. Scope is deliberately
 * narrow to this writer's own convention:
 *   - only `*.md.tmp` — never a real `*.md` notebook, never the usage log or its
 *     per-pid `.nb-usage.log.<pid>.tmp` temp (a dotfile, excluded below too);
 *   - only the top level of `dir` (readdirSync is not recursive);
 *   - never a dotfile — a shelf name never starts with `.` (assertSafeShelf), so a
 *     `.x.md.tmp` is not ours to remove.
 * Best-effort: any failure (a racing unlink, a permission error) is swallowed so
 * a stale temp can never block a real mutation.
 */
function reapLeftoverTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir unreadable — nothing to reap
  }
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.md.tmp')) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* already gone or not removable — reaping is best-effort */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// read / write
// ---------------------------------------------------------------------------

export function readEntries(dir: string, shelf: string): Entry[] {
  const file = shelfFile(dir, shelf);
  if (!existsSync(file)) return [];
  const out: Entry[] = [];
  // Skip the leading `# key: value` metadata block (notebook descriptions etc.):
  // those lines are notebook-level context, not lessons, so they must not become
  // score-0 entries. The block ends at the first non-metadata line; from there,
  // every line parses as an entry exactly as before (a mid-file `# key:` line
  // stays a tolerated bare lesson — see readMetaLines / FR-MODEL-003).
  let inMeta = true;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (inMeta && META_RE.test(line)) continue;
    inMeta = false;
    const e = parseLine(line);
    if (e && e.text !== '') out.push(e);
  }
  return out;
}

/**
 * Write a notebook, preserving its leading metadata block. `metaLines` lets a
 * caller that is itself changing the metadata (e.g. `setDescription`) pass the
 * new block; every other mutation omits it, so the existing block is re-read
 * from disk under the lock and re-emitted unchanged — which is how the
 * description round-trips through `add`/`vote`/`merge`/`split`/`rm`. The metadata
 * leads the file; the entries follow in recency order — least-recently-touched
 * first, a touch moving its entry to the end ([DP-3]). A file with
 * metadata but no entries is still written (its block survives an emptied
 * notebook), and only a notebook with neither becomes the empty string.
 */
function writeEntries(dir: string, shelf: string, entries: Entry[], metaLines?: string[]): void {
  const file = shelfFile(dir, shelf);
  const meta = metaLines ?? readMetaLines(dir, shelf);
  const lines = [...meta, ...entries.map(formatLine)];
  const body = lines.join('\n');
  const tmp = `${file}.tmp`;
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
  evicted: Entry | null;
  size: number;
  /** For 'too-long': the length of the submitted lesson, so the caller can report it. */
  length?: number;
  /** Stable id this result concerns: the added/merged entry, or the submitted lesson on a duplicate/rejection. Absent for 'empty'. Lets the usage log record which entry a call touched. */
  id?: string;
  /** For 'duplicate': the id of the existing entry that blocked the add (the colliding entry). */
  collidedId?: string;
  /** For merge: the ids of the two source entries consumed into the merged one. */
  sources?: [string, string];
}

export function addEntry(dir: string, shelf: string, lesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    const text = sanitizeLesson(lesson);
    const entries = readEntries(dir, shelf);
    if (text === '') return { added: false, reason: 'empty', evicted: null, size: entries.length };
    const id = entryId(text);
    if (text.length > maxChars()) {
      // Reject rather than truncate: a cut-off lesson is often useless, so the
      // agent should retry with a shorter *complete* one.
      return { added: false, reason: 'too-long', evicted: null, size: entries.length, length: text.length, id };
    }
    const key = dedupKey(text);
    const collider = entries.find((e) => dedupKey(e.text) === key);
    if (collider) {
      return { added: false, reason: 'duplicate', evicted: null, size: entries.length, id, collidedId: entryId(collider.text) };
    }
    const newEntry: Entry = { score: 1, text };
    entries.push(newEntry); // newcomer lands at the fresh end — storage is recency order
    // Newcomer is protected: a full notebook admits it, ages its stalest line,
    // and evicts the lowest-scored one (never the newcomer). See enforceCap.
    const { kept, evicted } = enforceCap(entries, 1);
    writeEntries(dir, shelf, kept);
    return { added: true, reason: 'added', evicted: evicted[0] ?? null, size: kept.length, id };
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
    throw new Error(`no entry matches ${JSON.stringify(selector)}. Pick the one you mean by its id:\n${listHint(entries)}`);
  }
  throw new Error(`"${selector}" matches ${matches.length} entries — pick one by its id:\n${listHint(matches.map((x) => x.e))}`);
}

export interface VoteResult {
  text: string;
  score: number;
}

export function vote(dir: string, shelf: string, selector: string, delta: number): Promise<VoteResult> {
  return withLock(dir, () => {
    if (delta !== 1 && delta !== -1) throw new Error('vote delta must be +1 or -1');
    const entries = readEntries(dir, shelf);
    if (entries.length === 0) throw new Error(`notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    entries[idx].score += delta;
    // A vote is a touch: move the entry to the fresh END so storage stays in
    // recency order (least-recently-touched first). Both signs count — a
    // downvote is engagement too; the low score, not the position, is what makes
    // a lesson an eviction target, so moving it to fresh never shields it.
    const [touched] = entries.splice(idx, 1);
    entries.push(touched);
    writeEntries(dir, shelf, entries);
    return { text: touched.text, score: touched.score };
  });
}

export function merge(dir: string, shelf: string, selA: string, selB: string, mergedLesson: string): Promise<AddResult> {
  return withLock(dir, () => {
    const entries = readEntries(dir, shelf);
    const ia = selectIndex(entries, selA);
    const ib = selectIndex(entries, selB);
    if (ia === ib) throw new Error('merge needs two different entries');
    const sources: [string, string] = [entryId(entries[ia].text), entryId(entries[ib].text)];
    const text = sanitizeLesson(mergedLesson);
    if (text === '') throw new Error('merged lesson is empty');
    if (text.length > maxChars()) {
      throw new Error(`merged lesson is ${text.length} chars; max is ${maxChars()} — shorten it`);
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
    const { kept, evicted } = enforceCap(deduped, 1);
    writeEntries(dir, shelf, kept);
    return { added: true, reason: 'added', evicted: evicted[0] ?? null, size: kept.length, id: entryId(text), sources };
  });
}

export interface SplitResult {
  /** Notebook size after the split (post-trim). */
  size: number;
  /** Stable id of the original (overloaded) entry that was split out and removed. */
  source: string;
  /** Stable ids of the two entries the split produced, in A,B order. */
  ids: [string, string];
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
    const entries = readEntries(dir, shelf);
    if (entries.length === 0) throw new Error(`notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    const original = entries[idx];
    const score = original.score; // both halves inherit the overloaded entry's score

    const textA = sanitizeLesson(lessonA);
    const textB = sanitizeLesson(lessonB);
    for (const [which, text] of [['A', textA], ['B', textB]] as const) {
      if (text === '') throw new Error(`split lesson ${which} is empty`);
      if (text.length > maxChars()) {
        // Reject rather than truncate, exactly as merge/add do: a cut-off lesson
        // is often useless, so the agent retries with a shorter *complete* one.
        throw new Error(`split lesson ${which} is ${text.length} chars; max is ${maxChars()} — shorten it`);
      }
    }
    const keyA = dedupKey(textA);
    const keyB = dedupKey(textB);
    if (keyA === keyB) {
      throw new Error('the two split lessons are duplicates of each other — split into two distinct lessons');
    }
    // Everything except the entry being split; the split must not duplicate any
    // of these. The original is leaving, so a half may legitimately echo it.
    const remaining = entries.filter((_, i) => i !== idx);
    for (const [which, key, text] of [['A', keyA, textA], ['B', keyB, textB]] as const) {
      const collider = remaining.find((e) => dedupKey(e.text) === key);
      if (collider) {
        throw new Error(
          `split lesson ${which} ("${text}") duplicates an existing entry (${entryId(collider.text)}) — a split never creates a duplicate`,
        );
      }
    }
    remaining.push({ score, text: textA }, { score, text: textB }); // both halves fresh → fresh end
    // split grows by one (1 → 2); if that overflows a full notebook both halves
    // are protected (admitted) and the stalest OTHER line ages/evicts.
    const { kept } = enforceCap(remaining, 2);
    writeEntries(dir, shelf, kept);
    return { size: kept.length, source: entryId(original.text), ids: [entryId(textA), entryId(textB)] };
  });
}

export function remove(dir: string, shelf: string, selector: string): Promise<VoteResult> {
  return withLock(dir, () => {
    const entries = readEntries(dir, shelf);
    if (entries.length === 0) throw new Error(`notebook for shelf "${shelf}" is empty`);
    const idx = selectIndex(entries, selector);
    const [gone] = entries.splice(idx, 1);
    writeEntries(dir, shelf, entries);
    return { text: gone.text, score: gone.score };
  });
}

/** The `desc` metadata key: a notebook's optional one-line description/trigger. */
export const DESC_KEY = 'desc';

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
      throw new Error(`description is ${clean.length} chars; max is ${maxChars()} — shorten it`);
    }
    const entries = readEntries(dir, shelf);
    const meta = setMetaValue(readMetaLines(dir, shelf), DESC_KEY, clean);
    writeEntries(dir, shelf, entries, meta);
    return { role: shelf, shelf, desc: clean === '' ? null : clean, set: true };
  });
}

/** One entry in a {@link ShowResult}: its stable id, current score, and lesson text. */
export interface ShowEntry {
  id: string;
  score: number;
  text: string;
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
}

/**
 * The machine-readable sibling of `render()`, for `nb show <shelf> --json`. It
 * reuses the same `ordered(readEntries(...))` ordering and the same stable
 * `entryId`, so an agent recovers each entry's id/score/text without
 * regex-parsing the human output `render()` produces. An empty notebook yields
 * an empty `entries` array and a `null` description — never an error.
 */
export function showJson(dir: string, shelf: string): ShowResult {
  const ord = ordered(readEntries(dir, shelf));
  return {
    role: shelf,
    shelf,
    description: getDescription(dir, shelf),
    entries: ord.map((x) => ({ id: entryId(x.e.text), score: x.e.score, text: x.e.text })),
  };
}

/** Render a notebook for injection / `show`: a stable id + score, highest score first (most useful on top). */
export function render(dir: string, shelf: string): string {
  const ord = ordered(readEntries(dir, shelf));
  if (ord.length === 0) return `(notebook for shelf "${shelf}" is empty)`;
  return ord
    .map((x) => {
      const s = x.e.score >= 0 ? `+${x.e.score}` : `${x.e.score}`;
      return `${entryId(x.e.text)}  [${s}]  ${x.e.text}`;
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
 * An absent/empty notebooks dir yields `[]` (not an error), so `nb shelves` can
 * report "no shelves yet" and exit 0 on a clean machine.
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
  const matches = listShelves(dir)
    .filter((shelf) => shelf.startsWith(prefix))
    .map((shelf): NotebookSummary => {
      const entries = readEntries(dir, shelf);
      const desc = getDescription(dir, shelf);
      // Fall back to the top-scored lesson only when there is no explicit
      // description; `ordered` is score-desc with an insertion-order tie-break.
      const auto = desc === null && entries.length > 0 ? ordered(entries)[0].e.text : null;
      return { role: shelf, shelf, lessons: entries.length, desc, auto };
    })
    .filter((n) => n.lessons > 0 || n.desc !== null);
  matches.sort((a, b) => b.lessons - a.lessons || a.shelf.localeCompare(b.shelf));
  const { limit } = opts;
  const rows = limit != null ? matches.slice(0, Math.max(0, limit)) : matches;
  return { dir, total: matches.length, rows };
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
}

export interface SearchResult {
  /** The lowercased, whitespace-split query terms actually searched; empty when the query had no word tokens. */
  terms: string[];
  /** Matching notebooks, most-relevant-first (by their best hit); description-only matches sort last. Empty on no match. */
  groups: SearchGroup[];
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
  if (terms.length === 0) return { terms: [], groups: [] };
  const prefix = opts.prefix ?? '';
  const needAll = !opts.any;
  const isHit = (matched: number): boolean => (needAll ? matched === terms.length : matched >= 1);
  const countTerms = (hay: string): number => {
    const low = hay.toLowerCase();
    return terms.reduce((n, t) => (low.includes(t) ? n + 1 : n), 0);
  };

  const groups: SearchGroup[] = [];
  for (const shelf of listShelves(dir).filter((r) => r.startsWith(prefix))) {
    const entries = readEntries(dir, shelf);
    const desc = getDescription(dir, shelf);
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
      hits: tagged.map((x) => ({ id: entryId(x.e.text), score: x.e.score, text: x.e.text, matched: x.matched })),
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
  return { terms, groups };
}

// ---------------------------------------------------------------------------
// usage log + monitoring
// ---------------------------------------------------------------------------

export interface UsageRow {
  ts: string;
  role: string;
  command: string;
  ok: boolean;
  ms: number;
  /** Session id (from `NB_SESSION`) the call ran under; `''` when unset. */
  session: string;
  /** Stable id(s) of the entry/entries the call touched; `[]` when none. */
  entries: string[];
  /** Outcome token: `accepted`/`dedup-blocked`/`rejected-full`/`empty`/`too-long` (add), `up`/`down` (vote), `removed` (rm), `merged` (merge), `match`/`no-match`/`no-terms` (search, with the query in `note`; `no-terms` = the query had no searchable tokens, so it is NOT a coverage gap); `''` otherwise. */
  outcome: string;
  /** For a `dedup-blocked` add: the id of the existing entry that blocked it; `''` otherwise. */
  collided: string;
  /** For an add that evicted: `<id>:<finalScore>` of the entry that left; `''` otherwise. */
  evicted: string;
  /** Per-operation reason code (e.g. `overloaded`/`other` for split); `''` when none was given. */
  reason: string;
  /** Optional free-text note accompanying the reason; `''` when none. */
  note: string;
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
  /** Stable ids the call touched (added/voted/removed, or merge's sources + result). */
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
    // cannot split the row or shift a column and mis-align parseUsage. The five
    // richer columns are appended AFTER the original five, so an old reader that
    // looks only at the first five still parses, and an old row missing them
    // round-trips as blank (backward-compatible — see parseUsage).
    const session = sanitizeUsageField(meta.session ?? process.env.NB_SESSION ?? '');
    const entries = (meta.entries ?? []).map(sanitizeUsageField).join(',');
    const outcome = sanitizeUsageField(meta.outcome ?? '');
    const collided = sanitizeUsageField(meta.collided ?? '');
    const evicted = sanitizeUsageField(meta.evicted ?? '');
    const reason = sanitizeUsageField(meta.reason ?? '');
    const note = sanitizeUsageField(meta.note ?? '');
    const line =
      `${new Date().toISOString()}\t${sanitizeUsageField(shelf)}\t${sanitizeUsageField(command)}\t${ok ? 'ok' : 'err'}\t${Math.round(ms)}ms` +
      `\t${session}\t${entries}\t${outcome}\t${collided}\t${evicted}\t${reason}\t${note}`;
    const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    const lines = existing.split('\n').filter((l) => l !== '');
    const ring = usageRing();

    if (lines.length < ring) {
      // Under cap (the hot path on nearly every `nb` call): append the one new
      // row in place instead of reading-slicing-rewriting the whole ring
      // (issue #45). Monitoring sits on a path whose budget is "a call is a
      // millisecond", so we must not rewrite thousands of unchanged bytes — nor
      // churn an inode via rename — just to record one line. appendFileSync is a
      // single write that never touches the preceding bytes.
      //
      // Guard the trailing newline: if a previous writer crashed mid-row the
      // file may lack a final `\n`, and a blind append would glue our row onto
      // the end of theirs. Prefix a newline in that case so each row stays whole.
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      appendFileSync(file, `${sep}${line}\n`, 'utf-8');
      return;
    }

    // At/over cap: compact. Slice to the newest `ring` rows (oldest dropped) and
    // atomically replace the file — this is the only path that rewrites the
    // previous bytes, and it runs only when a plain append would exceed the ring.
    lines.push(line);
    const kept = lines.slice(lines.length - ring);
    // Per-process-unique temp path: this log write runs OUTSIDE the .nb.lock
    // (it is called from the CLI's finally block), so two concurrent nb
    // processes would otherwise write and rename the same `${file}.tmp` and
    // clobber each other mid-write. The pid keeps each writer's temp distinct;
    // the rename is still atomic, so a reader sees one whole file or the other.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8');
    renameSync(tmp, file);
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
    // (session…evicted) are undefined on a pre-upgrade row and default to
    // blank/empty, so a ring written before this change still reads cleanly.
    const [ts, shelf, command, status, msRaw, session, entriesRaw, outcome, collided, evicted, reason, note] =
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
 *   - `eviction-while-still-voted`: the cap evicted an entry that had been voted
 *     on → the cap may be too tight for that shelf (a candidate to split).
 *   - `vote-reversal`: the same entry was upvoted in one session and downvoted in
 *     another → the lesson may be correct but mis-aimed.
 *   - `failed-search`: a `search` returned nothing and a lesson was then added in the
 *     same session (issue #82) → a coverage gap the notebook lacked, labelled by the
 *     agent's own query. This is the `failed-search → add` gap-sensor the demoted
 *     `nb search` fallback unlocks (the coverage signal deferred from #72). The
 *     `search` row is logged under shelf `-` (it spans notebooks), so this signal is
 *     observable only in an UNSCOPED `stats` report — `stats({shelf})` filters to one
 *     shelf and cannot pair the cross-notebook search with the add.
 */
export interface DiagnosticSignal {
  kind: 'browse-without-use' | 'eviction-while-still-voted' | 'vote-reversal' | 'failed-search';
  /** @deprecated use shelf */
  role: string;
  /** The shelf the signal concerns. */
  shelf: string;
  /** Human-readable one-line explanation. */
  detail: string;
  /** `browse-without-use`: the session the notebook was browsed in. */
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
  /** The coverage×surfacing 2×2 readout — `healthy` / `surfacing-failure` / `coverage-building` / `churny` — a heuristic hint, not a verdict. `null` when there is not enough data (no add attempts) to place it. */
  readout: 'healthy' | 'surfacing-failure' | 'coverage-building' | 'churny' | null;
}

export interface StatsReport {
  window: string;
  totalCalls: number;
  perCommand: CommandStat[];
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

/** Parse a window like `7d`, `12h`, `30m` into milliseconds. Default 7 days. */
export function parseWindowMs(raw: string | undefined): number {
  if (!raw) return 7 * 24 * 3600_000;
  const m = WINDOW_RE.exec(raw.trim());
  if (!m) return 7 * 24 * 3600_000;
  const n = Number.parseInt(m[1], 10);
  return n * (m[2] === 'd' ? 86_400_000 : m[2] === 'h' ? 3_600_000 : 60_000);
}

/**
 * Monitoring without a monitoring system: read the usage ring, roll up per
 * command, and flag the three anomalies that matter — an agent looping on a
 * command (stuck), a command that went silent (it probably broke), and a
 * command erroring often (not behaving as expected).
 */
export function stats(
  dir: string,
  opts: { role?: string; windowMs?: number; now?: number } = {},
): StatsReport {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? 7 * 24 * 3600_000;
  const all = parseUsage(dir).filter((r) => (opts.role ? r.role === opts.role : true));
  const recent = all.filter((r) => now - Date.parse(r.ts) <= windowMs);

  const byCmd = new Map<string, UsageRow[]>();
  for (const r of recent) {
    const arr = byCmd.get(r.command) ?? [];
    arr.push(r);
    byCmd.set(r.command, arr);
  }
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

  // (1) loop: same shelf+command ≥ LOOP_N times inside LOOP_WINDOW_MS.
  const LOOP_N = clampInt(process.env.NB_LOOP_N, 10, 2, 1000);
  const LOOP_WINDOW_MS = clampInt(process.env.NB_LOOP_WINDOW_S, 120, 5, 86_400) * 1000;
  const byShelfCmd = new Map<string, number[]>();
  for (const r of recent) {
    const k = `${r.role}\u0000${r.command}`;
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
  const SILENT_MS = clampInt(process.env.NB_SILENT_H, 48, 1, 24 * 365) * 3600_000;
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
  const ERR_MIN = clampInt(process.env.NB_ERR_MIN, 5, 1, 10_000);
  const rawRate = Number(process.env.NB_ERR_RATE);
  const ERR_RATE = Number.isFinite(rawRate) ? Math.min(1, Math.max(0, rawRate)) : 0.3; // bad value → default, not NaN (which disables detection)
  for (const c of perCommand) {
    if (c.calls >= ERR_MIN && c.errorRate >= ERR_RATE) {
      anomalies.push({
        kind: 'high-error-rate',
        command: c.command,
        detail: `${Math.round(c.errorRate * 100)}% errors over ${c.calls} calls — broken or not behaving as expected`,
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

  // (B) eviction-while-still-voted: an `add` evicted an entry (its `evicted`
  //     column is `<id>:<score>`) whose id was voted on → the cap may be too
  //     tight for that shelf (a candidate to split the shelf).
  {
    const votedIds = new Set<string>();
    for (const r of recent) {
      if (r.command === 'vote' && (r.outcome === 'up' || r.outcome === 'down')) {
        for (const id of r.entries) votedIds.add(id);
      }
    }
    const seen = new Set<string>(); // dedup repeat evictions of the same shelf+id
    for (const r of recent) {
      if (r.command !== 'add' || r.evicted === '') continue;
      const evictedId = r.evicted.split(':')[0];
      if (!evictedId || !votedIds.has(evictedId)) continue;
      const k = `${r.role}\u0000${evictedId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      signals.push({
        kind: 'eviction-while-still-voted',
        role: r.role,
        shelf: r.role,
        entry: evictedId,
        detail: `entry ${evictedId} was evicted by the cap but had been voted on — the cap may be too tight for shelf "${r.role}" (consider splitting it)`,
      });
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

  // Deterministic order so renderers and tests see a stable sequence.
  const sigOrder: Record<DiagnosticSignal['kind'], number> = {
    'browse-without-use': 0,
    'eviction-while-still-voted': 1,
    'vote-reversal': 2,
    'failed-search': 3,
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
  let accepted = 0;
  let dedupBlocked = 0;
  let rejectedFull = 0;
  let up = 0;
  let down = 0;
  for (const r of recent) {
    if (r.session === '' || !engaged.has(r.session)) continue;
    if (r.command === 'add') {
      if (r.outcome === 'accepted') accepted++;
      else if (r.outcome === 'dedup-blocked') dedupBlocked++;
      else if (r.outcome === 'rejected-full') rejectedFull++;
    } else if (r.command === 'vote') {
      if (r.outcome === 'up') up++;
      else if (r.outcome === 'down') down++;
    }
  }
  const addAttempts = accepted + dedupBlocked + rejectedFull;
  const votesActedOn = up + down;
  // Rates are null (not a misleading 0 — DP-5) when their denominator is empty.
  const coverage = addAttempts ? accepted / addAttempts : null;
  const recallMiss = addAttempts ? dedupBlocked / addAttempts : null;
  const precisionMiss = votesActedOn ? down / votesActedOn : null;
  const coverageHi = clampRate(process.env.NB_COVERAGE_HI, DEFAULT_COVERAGE_HI);
  const recallMissHi = clampRate(process.env.NB_RECALL_MISS_HI, DEFAULT_RECALL_MISS_HI);
  // The 2×2: novel-adds (coverage) LOW/HIGH × dedup-blocks (recall-miss) LOW/HIGH.
  let readout: SurfacingMetrics['readout'] = null;
  if (coverage !== null && recallMiss !== null) {
    const coverageHigh = coverage >= coverageHi;
    const recallHigh = recallMiss >= recallMissHi;
    readout = coverageHigh
      ? (recallHigh ? 'churny' : 'coverage-building')
      : (recallHigh ? 'surfacing-failure' : 'healthy');
  }
  const surfacing: SurfacingMetrics = {
    engagedSessions: engaged.size,
    addAttempts,
    coverage,
    recallMiss,
    votesActedOn,
    precisionMiss,
    readout,
  };

  const window =
    windowMs % 86_400_000 === 0
      ? `${windowMs / 86_400_000}d`
      : windowMs % 3_600_000 === 0
        ? `${windowMs / 3_600_000}h`
        : `${Math.round(windowMs / 60_000)}m`;

  // Notebook inventory (issue #40). Independent of the usage window — it is the
  // current on-disk state, not a time slice. Scoped to `opts.role` when given,
  // mirroring the per-command filtering above. `cap` is read once so every row
  // and the total report the same value.
  const cap = maxLines();
  const inventoryShelves = opts.role ? listShelves(dir).filter((r) => r === opts.role) : listShelves(dir);
  const notebooks: NotebookStat[] = inventoryShelves.map((shelf) => ({
    role: shelf,
    shelf,
    lines: readEntries(dir, shelf).length,
    cap,
  }));
  const notebookTotals: NotebookTotals = {
    roles: notebooks.length,
    shelves: notebooks.length,
    lines: notebooks.reduce((sum, n) => sum + n.lines, 0),
    cap,
  };

  return { window, totalCalls: recent.length, perCommand, anomalies, notebooks, notebookTotals, signals, surfacing };
}
