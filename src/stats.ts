/**
 * `nb stats` (issue #478 moved it here from `notebook.ts`): a strictly read-only
 * report over the usage log (`usage.ts`) and the shelves. It aggregates the
 * windowed usage rows into per-command counts, anomalies, engagement signals and
 * an activity sparkline, and reads each shelf to size the notebook.
 *
 * It never takes the mutation lock and never writes. Nothing in the cap-and-vote
 * mechanism (`notebook.ts`) depends on this module. Its thresholds are tunables
 * declared in `notebook.ts`, next to every other `NB_*` knob, so `nb config`
 * lists them from one registry.
 */
import {
  addBurstN,
  coverageHi,
  errMin,
  errRate,
  isValidShelfName,
  listShelves,
  loopN,
  loopWindowSec,
  maxLines,
  readEntries,
  readShelf,
  recallMissHi,
  silentHours,
  skipUnreadable,
  usageRing,
} from './notebook.js';
import type { ConflictShelf, SkippedShelf } from './notebook.js';
import { parseUsage } from './usage.js';
import type { UsageRow } from './usage.js';

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
 *     was voted that session. One pair is weak evidence (an agent may open three
 *     shelves and vote only the one that helped); a shelf whose voted share stays
 *     low over several sessions is the one whose description may over-promise.
 *     A shelf with no notebook file is never flagged (issue #480).
 *   - `eviction-while-still-voted`: the cap evicted (on an `add`, `merge` or `split`) an entry upvoted in the window
 *     (final score 0 or above), or whose score was still above the +1 a new lesson starts at → a lesson agents found useful was lost. A full shelf is normal; only
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
  /**
   * `browse-without-use` only (issue #480): the shelf's totals over the window —
   * `shown` is the number of sessions that showed it, `voted` how many of those
   * also voted on one of its entries. Every pair for one shelf carries the same
   * two numbers, so `voted / shown` is the shelf's voted share.
   */
  shown?: number;
  voted?: number;
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
   * add to a full shelf evicts one line, so a lesson that never gets a vote lasts about
   * `cap` adds at most. A vote buys more time: each point is one more dock the
   * lesson can absorb before it reaches the bottom score (issue #437). `null` when the shelf is below its cap or took no
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
   * `SkippedShelf`. A shelf-scoped report with no voting session in the window also
   * lists an unreadable shelf outside its scope, which the engagement diagnosis's
   * store-wide lesson count had to skip (issue #482).
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
   *
   * `oldest` (ISO timestamp of the oldest retained row) and `coversWindow: false`
   * are present ONLY when the ring is at capacity and that row is newer than the
   * window start (issue #406): the log no longer reaches back as far as the
   * requested `--since`, so the per-day add rates and retention estimates are
   * computed over a longer span than is recorded. Otherwise the shape is exactly
   * `{ rows, cap }`.
   */
  usageRing: { rows: number; cap: number; oldest?: string; coversWindow?: false };
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
 *
 * A shelf outside the scope that cannot be read counts 0 lessons and is appended
 * to `skipped` (unless already there), the same as the unscoped inventory does, so one
 * damaged file elsewhere in the store cannot abort `nb stats <shelf>` and the skip
 * is still reported (issue #482, FR-LIST-006). A codeless throw still propagates
 * (see `skipUnreadable`).
 */
function globalStoredLessons(
  dir: string,
  notebooks: NotebookStat[],
  scope: string | undefined,
  skipped: SkippedShelf[],
): number {
  if (!scope) return notebooks.reduce((sum, n) => sum + n.lines, 0);
  let total = 0;
  for (const shelf of listShelves(dir).filter(isValidShelfName)) {
    const read = skipUnreadable(shelf, () => readEntries(dir, shelf));
    if (read.error) {
      if (!skipped.some((s) => s.shelf === shelf)) skipped.push(read.error);
      continue;
    }
    total += read.value!.length;
  }
  return total;
}

/**
 * The cause token for one error row, shared by the two places `nb stats` names a
 * cause — the per-command `error causes` readout (issue #223) and the
 * `high-error-rate` anomaly detail (issue #176) — so both lines report the same
 * split for the same rows (issue #418). A row's cause is its `errorClass`; a row
 * written before that column existed has none, so it falls back to `outcome` for
 * the one outcome that is an error (`too-long` → `too_long`), and anything else
 * reads `unclassified`.
 */
function errorCause(r: UsageRow): string {
  return r.errorClass || (r.outcome === 'too-long' ? 'too_long' : 'unclassified');
}

/**
 * Summarize a set of error rows as a `cause pct%` breakdown, most-common first
 * (issue #176) — e.g. `too_long 78%, bad_args 14%, other 8%`. Percentages are
 * rounded whole numbers of the error total, so they may not sum to exactly 100%
 * (an honest rounding artefact, not a bug). Each row's cause comes from
 * `errorCause`: a pre-#176 row with no class and no error outcome is bucketed as
 * `unclassified` — kept distinct from a genuine `other` so a freshly-upgraded
 * window reads "unclassified 100%" (wait for data) rather than a misleading
 * "other 100%" ([DP-5]). Ties break by label for a stable line.
 */
function errorClassBreakdown(errRows: UsageRow[]): string {
  const counts = new Map<string, number>();
  for (const r of errRows) {
    const key = errorCause(r);
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

  // Every shelf with a notebook file, read once (unscoped). browse-without-use
  // (issue #480) skips shelves absent from it; the inventory below narrows it to
  // the scope. A shelf whose file is unreadable is still listed here — it exists.
  const existingShelves = new Set(listShelves(dir));

  const byCmd = new Map<string, UsageRow[]>();
  for (const r of recent) {
    const arr = byCmd.get(r.command) ?? [];
    arr.push(r);
    byCmd.set(r.command, arr);
  }
  // Per-command error-cause breakdown (issue #223): name the lever behind each
  // command's err% so `add` over-cap rejections and `vote` selector misses are
  // surfaced in the header, not only when the high-error-rate anomaly fires. A
  // row's cause comes from `errorCause` — the same resolver the anomaly detail
  // uses — so `add`'s dominant cause reads correctly even on an older log.
  // A couple of stray errors (e.g. a one-off unknown-subcommand guess) is noise,
  // not a rate; only a handful is a pattern worth naming. This keeps the readout
  // to the commands that actually have an err% worth diagnosing (add, vote).
  const ERROR_CAUSE_MIN = 3;
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
    // Issue #372: a non-blank session is part of the key, so N agents each making
    // one call inside the window are not reported as one stuck agent. Blank-session
    // rows keep the original grouping.
    const k = `${r.role}\u0000${r.command}\u0000${target}\u0000${r.session}`;
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
    // Issue #372: a mistyped command is logged under the typed token; it is not a
    // real command that broke, so it never counts as "used historically".
    if (r.errorClass === 'unknown_subcommand') continue;
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
  //     of its entries that session. The unit is the (session, shelf) pair, so it
  //     needs NB_SESSION — rows with a blank session can't be grouped and are
  //     skipped (FR-USAGE-002: "co-access is then not computed"). Only a vote on
  //     THAT shelf counts as use; a vote on another shelf in the same session does
  //     not. A shelf with no notebook file is skipped (issue #480): `nb show` of a
  //     never-created shelf exits 0, but there is no description or lesson to
  //     fault. Such a show is logged with outcome `no-shelf` and skipped even if
  //     the shelf was created later; rows from before that outcome existed fall
  //     back to the file check at report time. Each pair also carries the shelf's
  //     window totals (`shown` / `voted` sessions) so a reader can rank shelves by
  //     voted share instead of by raw unvoted count.
  {
    const browsed = new Map<string, { shown: boolean; voted: boolean }>(); // session \u0000 shelf
    for (const r of recent) {
      if (r.session === '') continue;
      if (r.command !== 'show' && !(r.command === 'vote' && (r.outcome === 'up' || r.outcome === 'down'))) continue;
      if (r.command === 'show' && r.outcome === 'no-shelf') continue;
      if (!existingShelves.has(r.role)) continue;
      const k = `${r.session}\u0000${r.role}`;
      const cur = browsed.get(k) ?? { shown: false, voted: false };
      if (r.command === 'show') cur.shown = true;
      else cur.voted = true;
      browsed.set(k, cur);
    }
    // Per-shelf totals over the pairs that were SHOWN: `voted` counts only
    // sessions that both showed and voted the shelf, so the share is ≤ 100%.
    const totals = new Map<string, { shown: number; voted: number }>();
    for (const [k, v] of browsed) {
      if (!v.shown) continue;
      const shelf = k.split('\u0000')[1];
      const t = totals.get(shelf) ?? { shown: 0, voted: 0 };
      t.shown++;
      if (v.voted) t.voted++;
      totals.set(shelf, t);
    }
    for (const [k, v] of browsed) {
      if (!v.shown || v.voted) continue;
      const [session, shelf] = k.split('\u0000');
      const t = totals.get(shelf)!;
      signals.push({
        kind: 'browse-without-use',
        role: shelf,
        shelf,
        session,
        shown: t.shown,
        voted: t.voted,
        detail: `shown in session "${session}" but no entry was voted that session`,
      });
    }
  }

  // (B) eviction-while-still-voted: an `add`, `merge` or `split` evicted one or more entries (its
  //     `evicted` column is a comma-separated list of `<id>:<score>` pairs —
  //     usually one, but a cap decrease can evict many at once, issue #306)
  //     whose final score was still above the +1 a new lesson starts at, or that
  //     was upvoted in the window and left at 0 or above (issue #438) → a
  //     lesson agents voted up, and that had not aged or been voted back down,
  //     was lost. Every such pair is counted, so a mass eviction surfaces each
  //     still-voted loss, not just the first. Evicting an entry at +1 or below is
  //     the cap doing its job. A trailing `+<dropped>` token (the overflow marker
  //     `formatEvictedUsage` appends when the list is too long to record in full)
  //     carries no per-entry score, so it is skipped here.
  {
    const seen = new Set<string>(); // dedup repeat evictions of the same shelf+id
    const EVICTING_COMMANDS = new Set(['add', 'merge', 'split']);
    // Issue #438: on a full shelf the staleness dock lowers a stale lesson a point
    // per add, so an upvoted lesson usually leaves at +1 or 0 and the above-+1 test
    // alone almost never fires. Also count an entry that received an `up` vote in
    // the window, provided it did not end below 0 (a net-downvoted entry leaving is
    // the cap doing its job). The count is a lower bound: votes older than the log's
    // window are invisible.
    const upvotes = new Map<string, number>(); // shelf \u0000 id → `up` votes in the window
    for (const r of recent) {
      if (r.command !== 'vote' || r.outcome !== 'up') continue;
      for (const id of r.entries) {
        const k = `${r.role}\u0000${id}`;
        upvotes.set(k, (upvotes.get(k) ?? 0) + 1);
      }
    }
    for (const r of recent) {
      // `add`, `merge` and `split` file their row under the shelf that evicted
      // (issue #455). `move` is left out: its row is filed under the SOURCE shelf
      // while the eviction happens in the target, so it cannot be attributed here.
      if (!EVICTING_COMMANDS.has(r.command) || r.evicted === '') continue;
      for (const pair of r.evicted.split(',')) {
        if (pair.startsWith('+')) continue; // `+<dropped>` overflow marker — count only, no per-entry score
        const [evictedId, scoreRaw] = pair.split(':');
        if (!evictedId) continue;
        const k = `${r.role}\u0000${evictedId}`;
        const ups = upvotes.get(k) ?? 0;
        const score = Number(scoreRaw);
        if (!(score > 1) && !(ups > 0 && score >= 0)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        const upNote = ups > 0 ? ` after ${ups} upvote${ups === 1 ? '' : 's'} in the window` : '';
        signals.push({
          kind: 'eviction-while-still-voted',
          role: r.role,
          shelf: r.role,
          entry: evictedId,
          detail: `entry ${evictedId} was evicted by the cap with score ${scoreRaw}${upNote} — if this repeats, the cap may be too tight for shelf "${r.role}"`,
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
      // A batch vote (`nb vote <shelf> id1,id2 +1`) logs ONE row listing every
      // landed id; count one vote per id (issue #373). A row with no ids (legacy)
      // still counts once.
      const ids = r.entries.length > 0 ? r.entries : [''];
      if (r.outcome === 'up') {
        for (const id of ids) {
          up++;
          // Pushed (candidate serendipity) unless a search in THIS session returned
          // this entry id — then the agent reached it by search, i.e. a pull.
          const pulled = id !== '' && (searchedBySession.get(r.session)?.has(id) ?? false);
          if (!pulled) pushUp++;
        }
      } else if (r.outcome === 'down') down += ids.length;
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
  const inventoryShelves = scope ? [...existingShelves].filter((r) => r === scope) : [...existingShelves];
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
      ? diagnoseEngagement(recentAll, globalStoredLessons(dir, notebooks, scope, skipped))
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

  // Window-coverage note (issue #406): same condition as nb-janitor's #275 guard —
  // ring at capacity AND the oldest retained row newer than the window start.
  const ringCap = usageRing();
  const ringReport: StatsReport['usageRing'] = { rows: parsed.length, cap: ringCap };
  if (parsed.length >= ringCap) {
    let oldest: number | null = null;
    for (const r of parsed) {
      const t = Date.parse(r.ts);
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest !== null && oldest > now - windowMs) {
      ringReport.oldest = new Date(oldest).toISOString();
      ringReport.coversWindow = false;
    }
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
    usageRing: ringReport,
    // Crash-recovery readout (issue #309): deployment-wide, window-scoped counts
    // of the two silent recovery events, so "are agents crashing mid-write?" is
    // answerable from `nb stats`. Shown even at {0,0} (healthy) — see the field doc.
    crashRecovery: { lockSteals: crashLockSteals, tempReaps: crashTempReaps },
  };
}
