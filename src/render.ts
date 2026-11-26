/**
 * The read-side report renderers for the CLI (issue #493 moved them here from
 * `cli.ts`): the human text of `nb list`, `nb search` and `nb stats`, the
 * stderr lines for a skipped (unreadable or misnamed) shelf and for a shelf
 * holding a git merge-conflict marker, and the small formatters they use
 * (`fmt`, `pct`, `plural`; `cli.ts` imports `fmt` and `plural` too).
 *
 * Each function returns strings and `cli.ts` decides which stream they go to;
 * none writes. Only `renderList` reads the notebooks directory (through
 * `listNotebooks`), and the `asciiMode` checks read `NB_ASCII` and the locale.
 * The `--json` paths do not come through here, and the confirmation lines that
 * mutations (add, vote, merge, split) print stay inline in `cli.ts`, so this
 * module covers read-side reports only.
 */
import {
  INVALID_NAME_CODE,
  listNotebooks,
  escapeDiskName,
  stripControlChars,
  type ConflictShelf,
  type NotebookSummary,
  type SearchResult,
  type SkippedShelf,
} from './notebook.js';
import { asciiMode, sparkGlyphs, sparkline, type EngagementDiagnosis, type StatsReport } from './stats.js';

export function fmt(score: number): string {
  return score >= 0 ? `+${score}` : `${score}`;
}

/** Render a surfacing rate as a right-aligned whole percent, or `—` when it is `null` (no data — never a misleading 0%, DP-5). */
function pct(rate: number | null): string {
  return (rate === null ? '—' : `${Math.round(rate * 100)}%`).padStart(4);
}

/** Pluralize `word` for `n` by appending `s` unless `n === 1`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Turn the zero-engagement diagnosis (issue #105) into up to three terse,
 * actionable `surfacing:` lines — one per applicable root cause, in the order
 * `diagnoseEngagement` emits them. Returns `[]` when there is nothing to
 * diagnose (no diagnosis object, or `engagedSessions > 0`, or none of the three
 * causes applies), so the caller can fall back to the generic line.
 */
function engagementDiagnosisLines(diag: EngagementDiagnosis | null): string[] {
  if (!diag) return [];
  const out: string[] = [];
  for (const cause of diag.causes) {
    if (cause === 'blank-session') {
      out.push(
        `  surfacing: no engaged sessions — NB_SESSION was unset on ${plural(diag.blankSessionCalls, 'call')}, ` +
          `so none could group into a session; export NB_SESSION (then vote) to measure`,
      );
    } else if (cause === 'retrospective-not-landing') {
      out.push(
        `  surfacing: no engaged sessions — ${plural(diag.readOnlySessions, 'session')} opened a notebook but cast no vote; ` +
          `the end-of-task retrospective nudge isn't landing`,
      );
    } else if (cause === 'injection-hook') {
      out.push(
        `  surfacing: no engaged sessions — notebooks hold ${plural(diag.storedLessons, 'lesson')} but had 0 reads in this window; ` +
          `the SessionStart injection hook is probably not wired`,
      );
    }
  }
  return out;
}

/** One-line gloss per coverage×surfacing readout quadrant (issue #81, §4 of the design rationale). */
const READOUT_GLOSS: Record<'healthy' | 'surfacing-failure' | 'coverage-building' | 'churny', string> = {
  healthy: 'covers and surfaces',
  'surfacing-failure': 'content present but not reaching the agent',
  'coverage-building': 'a young notebook filling gaps',
  churny: 'gaps and poor surfacing',
};

/**
 * Fixed display width for the trigger/description column in the human `nb list`
 * and `nb search` renderers (issue #211). Deterministic — a sane fixed width, no
 * terminal probing — so the output is stable and testable.
 */
const DESC_COL_WIDTH = 80;

/**
 * Bound a one-line trigger/description to `width` display chars for the human
 * renderers so a long (up to `maxChars()` = 200) description or top lesson can't
 * wrap and shatter the aligned `name  count  desc` columns of `nb list` / the
 * shelf lines of `nb search` (issue #211). Over-width text is cut and closed with
 * an ellipsis — `…`, or `...` under `asciiMode` (the non-UTF-8 / `NB_ASCII`
 * fallback, issue #136) — and the result (ellipsis included) never exceeds
 * `width`. The `--json` paths (`listNotebooks` / `search`) are untouched and keep
 * emitting the full, untruncated text.
 */
function truncateCol(text: string, width: number = DESC_COL_WIDTH): string {
  if (text.length <= width) return text;
  const ell = asciiMode() ? '...' : '…';
  return text.slice(0, Math.max(0, width - ell.length)) + ell;
}

/**
 * Render the notebook index for `nb list`/`ls`/`shelves`/`roles`. Returns `{out, err}` so
 * the caller writes the body to stdout (pipe-clean) and a friendly empty-state
 * note to stderr, exactly like `nb roles` did. One header line, then one row per
 * notebook: `  <name>  <count>  <description>`, name left-padded and count
 * right-aligned so the columns line up. A notebook with no `# desc:` shows its
 * top-scored lesson instead, suffixed `(auto)`. The header reads `N` when every
 * match is shown, or `shown of total` when `--limit` truncated the list. A long
 * description/trigger is bounded by `truncateCol` so it can't wrap the row.
 */
export function renderList(
  dir: string,
  prefix: string | undefined,
  limit: number,
  explicitLimit = false,
): { out: string; err: string } {
  const listing = listNotebooks(dir, { prefix, limit });
  // Report any shelf skipped for an unreadable file (issue #332) on stderr, so
  // the success path still lists every healthy shelf but never hides the loss.
  const skipErr = renderSkipped('list', listing.skipped) + renderConflicts('list', listing.conflicts);
  if (listing.total === 0) {
    // A prefix the user explicitly scoped to may have matched ONLY a skipped
    // shelf (issue #332): report that it is unreadable, not "no notebooks
    // matching", so an error on a named shelf is never hidden (FR-LIST-006).
    const onlySkipped = prefix && listing.skipped.length > 0;
    const err = onlySkipped
      ? `no readable notebooks matching "${prefix}" — the matching shelf(s) were skipped (see above)\n`
      : prefix
        ? `no notebooks matching "${prefix}" — run \`nb list\` to see them all\n`
        : 'no notebooks yet — add one with `nb add <shelf> "<lesson>"`\n';
    return { out: '', err: skipErr + err };
  }
  return { out: formatListing(listing.rows, listing.total, { dir, prefix, explicitLimit }).join('\n') + '\n', err: skipErr };
}

/**
 * The lines of a non-empty `nb list` text index: the header, one row per
 * notebook, and the #407 footer when a default cap left shelves out. Shared by
 * `renderList` and `nb brief` (issue #538), which passes `clean` to make every
 * value it places in the text safe for a model (a control character or line
 * separator can then never start a line of its own) and `footer` to replace the
 * footer with its own cut line. `clean` runs before padding and truncation, so
 * the columns still line up.
 */
export function formatListing(
  rows: readonly NotebookSummary[],
  total: number,
  opts: {
    dir: string;
    prefix?: string;
    explicitLimit?: boolean;
    clean?: (s: string) => string;
    /** A footer line to print instead of the #407 one; `null` prints none. */
    footer?: string | null;
  },
): string[] {
  const clean = opts.clean ?? ((s: string) => s);
  const { prefix } = opts;
  const shown = rows.length;
  const countClause = shown < total ? `${shown} of ${total}` : `${total}`;
  const match = prefix ? ` matching "${prefix}"` : '';
  const lines = [`agent-notebook notebooks — ${countClause}${match} in ${clean(opts.dir)}`];
  const names = rows.map((r) => clean(r.shelf));
  const nameWidth = names.reduce((w, n) => Math.max(w, n.length), 0);
  const countWidth = rows.reduce((w, r) => Math.max(w, String(r.lessons).length), 0);
  rows.forEach((r, i) => {
    const trigger = r.desc ?? r.auto; // explicit description, else the (auto) top lesson
    const descPart = trigger ? `  ${truncateCol(clean(trigger))}${r.desc === null ? '  (auto)' : ''}` : '';
    lines.push(`  ${names[i]!.padEnd(nameWidth)}  ${String(r.lessons).padStart(countWidth)}${descPart}`);
  });
  if (opts.footer !== undefined) {
    if (opts.footer !== null) lines.push(opts.footer);
    return lines;
  }
  // A default-capped list drops the shelves with the FEWEST lessons — which are
  // the newest ones — so say so (issue #407). Flush-left and `#`-led, like
  // `nb show`'s footer, so consumers that read the indented rows are unaffected;
  // an explicit `--limit` is the caller's own choice and prints no footer.
  if (!opts.explicitLimit && shown < total) {
    const left = total - shown;
    const scope = prefix ? ` ${prefix}` : '';
    lines.push(
      `# ${left} more notebook${left === 1 ? '' : 's'} not shown (the fewest lessons, usually the newest) — ` +
        `nb list${scope} --limit ${total}`,
    );
  }
  return lines;
}

/**
 * Render a `nb search` result for the human path. Returns `{out, err}` so a match
 * writes to stdout (pipe-clean) and a no-match writes a friendly note to stderr
 * (keeping stdout empty), exactly like `nb list`. A no-match is not an error — the
 * note reminds the reader that search is the secondary path AND that the miss was
 * recorded as a possible coverage gap. On a match: one header line (term count and
 * AND/OR mode), then per notebook a shelf line (with its description when set, and a
 * `(description match)` tag when only the description matched) followed by one
 * indented `<id>  [score]  <text>` line per hit — the id so the agent can `vote` it.
 */
export function renderSearch(
  query: string,
  any: boolean,
  result: SearchResult,
  prefix?: string,
  noShelf = false,
): { out: string; err: string } {
  const mode = any ? 'OR' : 'AND';
  // Name any shelf skipped for an unreadable file (issue #332) — a search over a
  // damaged store still returns every healthy hit, but never silently drops one.
  const skipErr = renderSkipped('search', result.skipped) + renderConflicts('search', result.conflicts);
  // A no-match is only a genuine coverage gap when every shelf in scope was
  // actually searched: if a skipped (unreadable) shelf exists, the miss may be
  // hiding a hit in it, so the note must not claim a gap (issue #332).
  const skippedNote =
    result.skipped.length > 0
      ? ` — note: ${result.skipped.length} shelf${result.skipped.length === 1 ? '' : 's'} could not be read and ` +
        `weren't searched (see above)\n`
      : '';
  const scope = prefix !== undefined ? ` in shelves starting with "${prefix}"` : '';
  if (result.groups.length === 0 && noShelf && result.terms.length > 0) {
    return {
      out: '',
      err:
        skipErr +
        `nb search: no shelf name starts with "${prefix}", so nothing was searched (not a coverage gap). ` +
        `To search every shelf for several words, quote them as one query: nb search "${query} ${prefix}"\n`,
    };
  }
  if (result.groups.length === 0) {
    // Three distinct empty renders, only ONE of which is the logged coverage gap.
    // Key the gap message on `result.total` (the FULL pre-limit count), NOT on the
    // bounded `groups.length`: otherwise `--limit 0` on a real match would print
    // "no lessons match … recorded as a possible coverage gap" while the usage log
    // correctly recorded a `match` — telling the user the opposite of the truth.
    const err =
      result.terms.length === 0
        ? `nb search: no searchable terms in "${query}"\n`
        : result.total === 0
          ? skippedNote
            ? `no lessons match "${query}" (${mode})${scope} in the readable shelves${skippedNote}`
            : `no lessons match "${query}" (${mode})${scope} — search is the secondary path (lessons are surfaced to you, ` +
              `not searched); this miss was recorded as a possible coverage gap\n`
          : `${result.total} notebook${result.total === 1 ? '' : 's'} match "${query}" (${mode}) but --limit hid them all — ` +
            `raise --limit to see them (this was a match, not a coverage gap)\n`;
    return { out: '', err: skipErr + err };
  }
  const hitCount = result.groups.reduce((n, g) => n + g.hits.length, 0);
  const nbCount = result.groups.length;
  // When `--limit` truncated the groups, read "N of total" like `nb list`, so the
  // caller can tell the result was capped (and widen `--limit` if they need more).
  const nbClause = nbCount < result.total ? `${nbCount} of ${result.total}` : `${nbCount}`;
  const lines = [
    `agent-notebook search — "${query}" (${mode} over ${result.terms.length} term${result.terms.length === 1 ? '' : 's'}): ` +
      `${hitCount} hit${hitCount === 1 ? '' : 's'} in ${nbClause} notebook${result.total === 1 ? '' : 's'} ` +
      `(secondary fallback — lessons are normally surfaced to you, not searched)`,
  ];
  for (const g of result.groups) {
    const descPart = g.desc ? `  — ${truncateCol(g.desc)}` : '';
    const descOnly = g.hits.length === 0 ? '  (description match)' : g.descMatched ? '  (+description match)' : '';
    lines.push(`  ${g.shelf}${descPart}${descOnly}`);
    for (const h of g.hits) {
      lines.push(`    ${h.id}  [${fmt(h.score)}]  ${h.text}`);
    }
  }
  return { out: lines.join('\n') + '\n', err: skipErr };
}

/**
 * One truthful stderr note per shelf a cross-shelf scan had to skip because its
 * file was unreadable (issue #332). `nb list`/`nb search` still succeed for every
 * healthy shelf; this names the casualty and its errno so the user can fix the
 * file (chmod, remove the stray directory) without reading `nb` source. Empty
 * string when nothing was skipped, so a healthy run's stderr stays byte-identical.
 */
export function renderSkipped(cmd: string, skipped: SkippedShelf[]): string {
  return skipped
    .map((s) =>
      s.code === INVALID_NAME_CODE
        ? // A stray file, not a shelf (issue #369). JSON.stringify keeps a hostile stem on one line.
          `nb ${cmd}: skipped ${escapeDiskName(JSON.stringify(`${s.shelf}.md`))} — not a valid shelf name ` +
          `(allowed: letters, digits, . _ @ -); rename or remove the file\n`
        : `nb ${cmd}: skipped shelf "${s.shelf}" — could not read ${s.shelf}.md (${s.code}); ` +
          `fix the file (permissions, or remove a directory named ${s.shelf}.md) to include it again\n`,
    )
    .join('');
}

/**
 * One stderr line warning that a READ found a git merge-conflict marker in a
 * shelf (issue #333). Reads are never refused — the lessons print as stored — but
 * a mutation will refuse until the conflict is resolved, so the reader is told
 * which shelf (and which line) needs `git merge` / a manual fix. stdout and the
 * `--json` result stay untouched and valid.
 */
export function renderConflict(cmd: string, shelf: string, marker: string): string {
  return (
    `nb ${cmd}: warning: shelf "${shelf}" contains a git merge-conflict marker (${escapeDiskName(JSON.stringify(marker))}); ` +
    `resolve the conflict in ${shelf}.md before mutating it — writes are refused until then\n`
  );
}

/**
 * The stderr lines for every conflicted shelf a scan saw (issue #333), by the
 * same additive, only-when-non-empty rule as `renderSkipped`.
 */
export function renderConflicts(cmd: string, conflicts: ConflictShelf[]): string {
  return conflicts.map((c) => renderConflict(cmd, c.shelf, c.marker)).join('');
}

/**
 * browse-without-use text-report thresholds (issue #480). A shelf is rated —
 * printed on its own line, ranked by voted share — only once at least
 * BROWSE_MIN_SESSIONS sessions showed it; below that one unvoted session says
 * little, so those shelves fold into one summary line. A rated shelf voted in
 * fewer than BROWSE_LOW_SHARE of the sessions that showed it gets the "the
 * notebook's description may over-promise" hint.
 */
const BROWSE_MIN_SESSIONS = 3;
const BROWSE_LOW_SHARE = 0.25;

export function renderStats(rep: StatsReport, shelf: string | undefined): string {
  const lines: string[] = [];
  lines.push(`nb usage — ${shelf ? `shelf ${shelf}, ` : ''}window ${rep.window}, ${rep.totalCalls} calls`);
  // Ops-per-day activity sparkline (issue #106): one glyph per rolling-24h
  // bucket, oldest (leftmost) to the 24h ending now (rightmost). A silent bucket
  // reads as the floor glyph, so "went quiet N days ago" is visible at a glance.
  // Glyph ramp is env-selected (issue #136): Unicode blocks by default, the
  // ASCII digit ramp under NB_ASCII or a non-UTF-8 locale. `sparkline` stays pure.
  lines.push(`  activity  ${sparkline(rep.activity, sparkGlyphs())}  (${rep.window}, ${rep.totalCalls} ops)`);
  if (rep.perCommand.length === 0) {
    lines.push('  (no usage recorded in this window)');
  } else {
    lines.push('  command   calls  err%   p50    p95    last-used');
    for (const c of rep.perCommand) {
      lines.push(
        `  ${c.command.padEnd(8)}  ${String(c.calls).padStart(4)}  ${String(Math.round(c.errorRate * 100)).padStart(3)}%  ` +
          `${(c.p50ms + 'ms').padStart(5)}  ${(c.p95ms + 'ms').padStart(5)}  ${c.lastUsed.slice(0, 19)}`,
      );
    }
  }
  // Error causes (issue #223): name the lever behind each command's err% so the
  // two most actionable rates — `add` over-cap rejections and `vote` selector
  // misses — are in the header, not buried behind the high-error-rate anomaly
  // threshold. Only printed when something errored this window. A dominant
  // `unclassified` share means the log predates the errorClass column (#176) —
  // upgrade `nb` so causes get recorded.
  if (rep.errorCauses.length > 0) {
    lines.push('  error causes:');
    let anyUnclassified = false;
    for (const e of rep.errorCauses) {
      for (const b of e.breakdown) if (b.cause === 'unclassified') anyUnclassified = true;
      const parts = e.breakdown.map((b) => `${b.cause} ${b.pct}%`).join(', ');
      lines.push(`    ${e.command.padEnd(8)} ${parts}  (${e.errors} err)`);
    }
    if (anyUnclassified)
      lines.push('    (unclassified = log predates error-class recording — upgrade nb to split these by cause)');
  }
  if (rep.anomalies.length > 0) {
    lines.push('  anomalies:');
    for (const a of rep.anomalies) {
      lines.push(`    [${a.kind}] ${a.command}${a.shelf ? ` (shelf ${a.shelf})` : ''}: ${a.detail}`);
    }
  } else {
    lines.push('  anomalies: none');
  }
  // Free diagnostic signals (issue #72): memory-quality observations read from
  // the usage ring (over-promised descriptions, too-tight caps, mis-aimed
  // lessons). Distinct from anomalies (command health), so they get their own
  // section; each line names the shelf (and entry/session where relevant).
  if (rep.signals.length > 0) {
    lines.push('  signals:');
    // browse-without-use fires once per (session, shelf) pair (issue #415), so
    // the text report folds it into one line per shelf. Each line gives both
    // counts — sessions that showed the shelf and sessions that voted in it — and
    // the list is sorted by voted share, lowest first (issue #480): a busy shelf
    // voted in half its sessions is ordinary, a shelf never voted is the one to
    // read. Shelves shown in fewer than BROWSE_MIN_SESSIONS sessions are too few
    // to rate and fold into one summary line. `--json` keeps every pair.
    const browse = new Map<string, { shown: number; voted: number }>();
    for (const s of rep.signals) {
      if (s.kind === 'browse-without-use') {
        // Every pair of one shelf carries the same shelf totals, so overwriting is fine.
        browse.set(s.shelf, { shown: s.shown ?? 0, voted: s.voted ?? 0 });
        continue;
      }
      const where = s.entry ? ` entry ${s.entry}` : s.session ? ` session "${s.session}"` : '';
      lines.push(`    [${s.kind}] shelf ${s.shelf}${where}: ${s.detail}`);
    }
    const share = (t: { shown: number; voted: number }): number => (t.shown > 0 ? t.voted / t.shown : 0);
    const rated = [...browse]
      .filter(([, t]) => t.shown >= BROWSE_MIN_SESSIONS)
      .sort(
        ([a, ta], [b, tb]) =>
          share(ta) - share(tb) || tb.shown - ta.shown || (a < b ? -1 : a > b ? 1 : 0),
      );
    for (const [shelf, t] of rated) {
      const pctVoted = Math.round(share(t) * 100);
      // Compare the printed percent, so a line reading "(25%)" never carries the hint.
      const hint = pctVoted < BROWSE_LOW_SHARE * 100 ? " — the notebook's description may over-promise" : '';
      lines.push(
        `    [browse-without-use] shelf ${shelf}: shown in ${t.shown} sessions, voted in ${t.voted} (${pctVoted}%)${hint}`,
      );
    }
    const few = browse.size - rated.length;
    if (few > 0) {
      lines.push(
        `    [browse-without-use] ${few} more shel${few === 1 ? 'f' : 'ves'} shown without a vote, each in fewer than ${BROWSE_MIN_SESSIONS} sessions — run \`nb stats --json\` for every pair`,
      );
    }
  } else {
    lines.push('  signals: none');
  }
  // Surfacing metrics (issue #81): the named recall-miss / precision-miss rates
  // and the coverage×surfacing readout, engagement-gated. The recall-miss rate is
  // the headline (re-deriving a stored lesson is the clearest surfacing failure);
  // precision-miss is shown beside it so "surface everything" cannot look free.
  const sf = rep.surfacing;
  if (sf.engagedSessions === 0) {
    // Zero engagement: split the one vague line into the root cause(s) (issue
    // #105). At most three terse lines; fall back to the generic line when none
    // of the three causes apply (e.g. an empty notebook with no activity).
    const diagLines = engagementDiagnosisLines(sf.engagementDiagnosis);
    if (diagLines.length > 0) {
      for (const l of diagLines) lines.push(l);
    } else {
      lines.push('  surfacing: no engaged sessions in this window (set NB_SESSION and vote to measure)');
    }
  } else {
    const sess = `${sf.engagedSessions} engaged session${sf.engagedSessions === 1 ? '' : 's'}`;
    lines.push(`  surfacing: ${sess}`);
    lines.push(`    coverage        ${pct(sf.coverage)}  (${sf.addAttempts ? `${Math.round((sf.coverage ?? 0) * sf.addAttempts)}/${sf.addAttempts} attempts novel` : 'no add attempts'})`);
    lines.push(`    recall-miss     ${pct(sf.recallMiss)}  (${sf.addAttempts ? `${Math.round((sf.recallMiss ?? 0) * sf.addAttempts)}/${sf.addAttempts} re-derived — stored lesson not surfaced; the headline alarm` : 'no add attempts'})`);
    lines.push(`    precision-miss  ${pct(sf.precisionMiss)}  (${sf.votesActedOn ? `${Math.round((sf.precisionMiss ?? 0) * sf.votesActedOn)}/${sf.votesActedOn} downvotes on pushed lessons` : 'no votes'})`);
    // Serendipity (issue #114): the positive goal — upvotes on lessons that arrived
    // unbidden. The leading `~` and "approx" flag it as a two-sided PROXY, not a
    // bound (a show-pull/recall inflates it; a same-session search match deflates
    // it) — it must never be read as "true serendipity ≤ x". See SurfacingMetrics.
    lines.push(`    serendipity    ~${pct(sf.serendipity)}  (${sf.upvotes ? `${Math.round((sf.serendipity ?? 0) * sf.upvotes)}/${sf.upvotes} upvotes arrived unbidden — approx; a proxy, not a bound` : 'no upvotes'})`);
    if (sf.readout) lines.push(`    readout: ${sf.readout} — ${READOUT_GLOSS[sf.readout]}`);
  }
  // Notebook inventory (issue #40): make memory pressure visible — a shelf at
  // `lines/cap` where the two are equal is one distinct add from an eviction,
  // flagged FULL so a supervisor spots it without listing files.
  const nb = rep.notebookTotals;
  if (rep.notebooks.length === 0) {
    lines.push('  notebooks: none');
  } else {
    lines.push(`  notebooks: ${nb.shelves} ${nb.shelves === 1 ? 'shelf' : 'shelves'}, ${plural(nb.lines, 'line')} (cap ${nb.cap}/shelf)`);
    for (const n of rep.notebooks) {
      const full = n.lines >= n.cap ? '  FULL' : '';
      // Add rate (issue #353): on a full shelf each add evicts a line, so
      // `cap ÷ adds/day` is about the most a never-voted lesson gets (a vote buys more
      // time: each point is one more dock the lesson can absorb, issue #437).
      // Shown for every
      // shelf (0 adds is "measured, quiet", DP-5); the window estimate only when full.
      const rate = `${n.adds} add${n.adds === 1 ? '' : 's'} (${n.addsPerDay}/day)`;
      const keep = n.retentionDays !== null ? `, ~${n.retentionDays}d retention` : '';
      lines.push(`    ${n.shelf.padEnd(20)}  ${String(n.lines).padStart(4)}/${n.cap}${full}  ${rate}${keep}`);
    }
  }
  // Usage-ring occupancy (issue #206): the log's own fill vs its cap, so "why did
  // my window lose older data" is answerable at a glance — the analogue, for the
  // monitoring log, of the per-shelf cap pressure just above. Total occupancy
  // (not the windowed call count), flagged FULL when it has reached the cap.
  const ring = rep.usageRing;
  const ringFull = ring.rows >= ring.cap ? '  FULL' : '';
  lines.push(`  usage ring: ${ring.rows}/${ring.cap} rows${ringFull}`);
  if (ring.oldest !== undefined) {
    // Issue #406: the log was trimmed to its row cap and no longer reaches back
    // to the window start. The per-day rates above divide by the span it covers
    // (issue #511), with a one-day floor: under a day, they are lower bounds and
    // no retention is estimated. Same one-day threshold as `stats()`.
    const ageDays = Math.max(0, (Date.parse(rep.generatedAt) - Date.parse(ring.oldest)) / 86_400_000);
    const reach = ageDays >= 1 ? `${Math.floor(ageDays)}d` : 'under a day';
    const windowDays = (Date.parse(rep.generatedAt) - Date.parse(rep.windowStart)) / 86_400_000;
    const floor = windowDays < 1 ? `the ${rep.window} window` : 'one day';
    const rates = ageDays >= 1 ? 'per-day rates divide by the time since that row' : `per-day rates divide by ${floor}, so they are lower bounds, and retention is not estimated`;
    lines.push(`  usage log reaches back only ${reach} (oldest row ${ring.oldest}); ${rates}`);
  }
  // Crash-recovery readout (issue #309): the two previously-silent signs a prior
  // nb died mid-write — stale locks stolen and leftover temps reaped — summed over
  // the window. Deployment-wide (like the usage ring), so it is not shelf-scoped.
  // Shown even at zero (the healthy normal) so its absence can't be mistaken for
  // "not measured"; a nonzero count tells an operator agents are crashing
  // mid-mutation. A trailing marker calls out any nonzero count at a glance.
  const cr = rep.crashRecovery;
  const crMark = cr.lockSteals > 0 || cr.tempReaps > 0 ? '  ⚠ crashes recovered' : '';
  lines.push(
    `  crash recovery: ${cr.lockSteals} stale lock${cr.lockSteals === 1 ? '' : 's'} stolen, ` +
      `${cr.tempReaps} leftover temp${cr.tempReaps === 1 ? '' : 's'} reaped (window)${crMark}`,
  );
  // Log-derived strings (command, shelf, session, note) are caller-influenced and an
  // older `nb` may have stored control characters (issue #375): strip them from the
  // whole rendering. Newlines are kept.
  return stripControlChars(lines.join('\n'));
}
