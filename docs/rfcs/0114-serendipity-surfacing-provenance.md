# RFC 0114 — Make serendipity measurable: log surfacing provenance (push vs pull)

- Issue: [#114](https://github.com/jeanibarz/agent-notebook/issues/114)
- Status: accepted (autonomous — small, additive, high-confidence; the design is the issue's own "Proposed direction", reused existing columns, no notebook-file schema change)
- Epic: self-observing notebook ([#73](https://github.com/jeanibarz/agent-notebook/issues/73)); completes the surfacing triad of #81 (recall · precision · **serendipity**)

## Problem

`docs/self-observing-notebook.md` §4 defines **serendipity** as
**`relevant ∧ arrived-unbidden`** — an upvote on a lesson delivered by **push**
(session-start injection / organization), *not* via a targeted search. It is the
positive goal of [DP-8]; recall-miss and precision-miss are its two failure
modes, and both are already measured ([#81]). Serendipity is not.

The log lets us observe the **`relevant`** half — the upvote (`vote` logs the
entry id, `src/cli.ts`). It does **not** let us observe the **`arrived-unbidden`**
half, because the usage ring carries no **surfacing provenance**:

- **`search` does not record which lessons it returned.** The search case sets
  only `meta.outcome` (`match`/`no-match`/`no-terms`) and `meta.note` (the
  query); it never sets `meta.entries` (`src/cli.ts`). So a later upvote cannot
  be linked to a prior search hit — we know only *that* a search ran this
  session, not *which* entry ids it surfaced.
- **The push channel is invisible to `nb`.** Session-start injection lives in the
  kookr runtime hook, not this package (epic #73). `nb` logs no injection event,
  so "arrived by push" has no positive record — it can only be *inferred* from
  the absence of a pull.
- **`show` is ambiguous** — an agent pulling a shelf it chose, or the hook
  rendering an injection; nothing distinguishes them.
- **The code already says so.** `precisionMiss` treats every delivered lesson as
  pushed and defers the narrowing to non-search-delivered lessons as "a possible
  future refinement, not yet implemented" (`SurfacingMetrics.precisionMiss`
  docstring; `docs/requirements.md` FR-STATS-004). Serendipity inherits the exact
  gap and today has no metric at all.

A serendipity count computed today would equal *all* upvotes (every delivery
assumed pushed) — an **upper bound**, not `relevant ∧ arrived-unbidden`.

## Design

Three changes, all inside the existing log contract: reuse existing columns (no
new column — [FR-USAGE-002]), add no field to a lesson ([NG-004]), keep every
rate deterministic ([DP-6]) and `null`-when-empty ([DP-5]).

### 1. Make pulls self-labelling — `search` logs what it returned

In the CLI `search` case, set `meta.entries` to the entry ids the result
surfaced:

```ts
meta.entries = result.groups.flatMap((g) => g.hits.map((h) => h.id));
```

This reuses the existing `entries` column (already comma-joined and sanitized by
`logUsage`; already parsed back by `parseUsage`). No new column, so no row-shape
or column-count test breaks. The row still carries shelf `-` (search spans
notebooks) and the query in `note`, so the `failed-search` gap-sensor is
untouched (a `no-match` has no hits, so its `entries` stays empty).

**Within a session, an upvoted entry that a prior search returned is a *pull*;
one that no search returned is a candidate *push*.** This is the smallest change
and the only one wholly inside this package.

### 2. Compute `serendipity` in `SurfacingMetrics`

Two new fields on `SurfacingMetrics`, derived from the usage ring alone, beside
the existing recall/precision rates:

- `upvotes: number` — `up` votes in engaged sessions (the denominator). It is
  **not** a redundant restatement of an existing field: `votesActedOn` is
  `up + down`, so the serendipity sample size cannot be recovered from the
  existing object. It is exposed for the same reason `addAttempts` and
  `votesActedOn` are — a small sample must be legible, so a reader can tell
  `serendipity: 1.0` over one upvote from the same ratio over fifty ([DP-5]). If a
  reviewer still judges it surplus, it can be dropped and the human line can fall
  back to the bare percentage; the field is the honest, consistent choice.
- `serendipity: number | null` — **push-delivered upvotes ÷ `upvotes`**, where an
  upvote is *push-delivered* when its entry id was **not** returned by any
  `search` in the same session. `null` when `upvotes` is 0 ([DP-5]).

Engagement-gated exactly like the other rates: only sessions that cast a vote are
scored; a blank-session row is skipped. An upvote itself engages its session, so
every counted upvote is in an engaged session by construction.

**Pull evidence is deployment-wide.** `search` rows are logged under shelf `-`,
so they are absent from a shelf-scoped `recent`. The pull set is therefore built
from the deployment-wide `recentAll` rows (the same precedent the engagement
diagnosis of #105 uses for cross-notebook reads), keyed by session:

```ts
const searchedBySession = new Map<string, Set<string>>();
for (const r of recentAll) {
  if (r.command === 'search' && r.session !== '' && r.entries.length > 0) {
    (searchedBySession.get(r.session) ?? setInto(searchedBySession, r.session))
      .add(...r.entries); // every id the search surfaced, any shelf
  }
}
```

Then, in the existing engaged-session accumulation loop, an `up` vote counts
toward the numerator only when its entry was **not** in that session's searched
set:

```ts
if (r.outcome === 'up') {
  up++;
  const pulled = searchedBySession.get(r.session)?.has(r.entries[0] ?? '') ?? false;
  if (!pulled) pushUp++;
}
// …
const serendipity = up ? pushUp / up : null;
```

A scoped `nb stats <shelf>` thus still classifies *its* upvotes correctly: the
upvote is scoped to the shelf, but the cross-notebook search that would mark it a
pull is read from the deployment-wide rows.

### 3. The honest limit — serendipity is a two-sided **proxy**, not a bound

`serendipity` is published as an **inferred proxy** for true serendipity, never
as the clean signal ([DP-5]), and — deliberately **not** as a one-sided bound. It
carries two error sources that point in **opposite** directions, so its value may
land either above or below the §4 quantity:

- **Upward (over-counts push):** we observe only **search**-pulls. A **`show`**-pull
  the agent chose is indistinguishable from a hook injection (both log `show`),
  and a lesson recalled from earlier in the session is no surfacing event at all —
  so these true pulls stay in the numerator and inflate it.
- **Downward (under-counts push):** we treat *any* same-session search that
  returned the id as a pull. A lesson that was genuinely pushed **and** happened
  to also surface in an exploratory search this session is scored as a pull,
  removing a real push from the numerator. (This is faithful to the §4 wording —
  "arrived unbidden, *not via a targeted search*" — once the agent reached a
  lesson via its own search this session, it is no longer unambiguously unbidden;
  but it still means the number is not an upper bound on the pure-injection
  quantity.)

Because the two biases are of **unknown relative size**, the honest label is a
*biased estimate / approximate indicator*, not "upper bound." The number also
**degrades as the usage ring churns**: a search row evicted before its matching
vote, or an `entryId` changed by a `merge`/`split`/reword between search and
vote, silently drops pull evidence (an upward error). It is therefore read as a
*direction-of-travel* indicator beside recall/precision, and the clean one-sided
signal waits on the Option-C push marker (§Design decision).

This framing is stated in the `SurfacingMetrics.serendipity` docstring, in the
human `nb stats` line (`~ ` approximate marker), and in
`docs/self-observing-notebook.md` §4 / `docs/requirements.md` FR-STATS-004.

### Design decision — how a *push* becomes positively observed (issue AC #2)

A valid serendipity signal ultimately needs a **positive** record of a push, not
just the absence of a pull. The key observation: **the hook that performs the
push already issues a logged `nb` read.** Session-start injection fetches the
agent's own notebook and the `nb list` index — and those calls already land in
the usage ring (this very session's SessionStart output is an injected `nb list`
index). So the push is not truly invisible; what is missing is only that the
hook's read is **indistinguishable from an agent-initiated read** (the `show`
ambiguity §Problem names). The party that knows the truth — the caller — can
resolve it by identifying itself.

That reframes the three candidate mechanisms:

| Option | Mechanism | Verdict |
|---|---|---|
| **A. New `nb surfaced`/`--pushed` command** the hook calls purely to record a push | a brand-new write whose only consumer is the metric | **Rejected** — a write that does no real work; the weakest option. |
| **B. New per-session injection *event* type** emitted by the hook | a new `nb` command/surface *or* the hook writing `nb`'s private log schema directly (cross-repo coupling) | **Rejected** — it either *is* Option A under another name, or couples the kookr runtime to `nb`'s log format. |
| **C. Tag the read the hook *already makes*** — the hook sets an `NB_INJECTED`-style marker (env var / `--pushed` flag) that `logUsage` records as a provenance attribute on that `show`/`list` row | provenance as an **attribute on existing real work**, no new write, no new event type | **Chosen.** |

**Decision: Option C — provenance as a marker on the hook's existing injection
read.** It adds no synthetic write (so the "never force writes" rule is not even
in play — and note that rule governs *agent* Goodhart filler, not deterministic
machine instrumentation, so it was never the right lens for A/B anyway). The
in-package part is small plumbing: `logUsage`/`parseUsage` learn one provenance
marker, and a tagged injection read of the agent's own shelf records which entry
ids were pushed. The cross-repo part shrinks to **one line in the kookr hook**
(set the marker on the read it already issues), tracked under the **#73
session-start injection contract** — and is **out of scope for this RFC's
implementation**.

Until Option C's hook marker lands, this package ships the inferred **proxy** of
parts 1–3 and labels it as such. When the marker exists, the numerator tightens
from "not-pulled" (the two-sided proxy) to "observed-pushed" (the clean,
one-sided signal) with no change to the notebook-file format — the provenance is
just another usage-ring read attribute.

**Is closing the gap even worth it?** Its value scales with how often agents
*pull*. `search` is the deliberately *demoted* keyword fallback ([FR-SEARCH-001],
[NG-007]); if it fires rarely in real logs, almost every delivery is already a
push and the proxy is already ≈ the true signal, making Option C a rounding-error
chase. The honest proxy shipped here is therefore the *primary* deliverable;
Option C is a follow-up to be justified by observed search frequency, not
assumed. This is recorded, not pre-committed as mandatory work.

## JSON shape

```jsonc
"surfacing": {
  "engagedSessions": 1,
  "addAttempts": 2,
  "coverage": 0.5,
  "recallMiss": 0.5,
  "votesActedOn": 1,
  "precisionMiss": 0,
  "upvotes": 1,          // NEW — denominator for serendipity
  "serendipity": 1,      // NEW — push-delivered upvotes ÷ upvotes (two-sided PROXY, not a bound); null when upvotes === 0
  "readout": "churny",
  "engagementDiagnosis": null
}
```

## Acceptance-criteria trace

- *A `search` logs the entry ids it surfaced* → part 1 (`meta.entries` = flattened
  hit ids). ✅
- *A design decision recorded for how a push is positively observed, incl. the
  #73 cross-repo dependency* → the "Design decision" section (Option C chosen —
  tag the hook's existing injection read; one-line hook change tracked under the
  #73 injection contract, out of scope here). ✅
- *`SurfacingMetrics` exposes `serendipity` (+ `--json`), read beside
  recall/precision, with its honest limit documented* → part 2 (`serendipity` +
  `upvotes`), rendered beside recall/precision, `--json` carries it, honest-limit
  text in §4 / FR-STATS-004. ✅
- *Tests: push-upvote counted, pull-upvote (searched-then-voted) excluded,
  engagement gate applied* → unit tests in `notebook.test.ts` and CLI/E2E in
  `cli.test.ts` (below). ✅

## Risks & mitigations

- **Two-sided bias (the headline honest-limit).** The metric both over-counts
  push (unobserved `show`-pulls / recall) and under-counts it (a pushed lesson
  that also surfaced in a same-session search is scored a pull). The biases point
  opposite ways and are of unknown relative size. *Mitigation:* publish it as a
  **proxy / approximate indicator, not a bound** — in the docstring, the human
  line (`~` marker), and the docs — so no operator reads `serendipity: 0.2` as
  "true serendipity ≤ 0.2" ([DP-5]). The one-sided clean signal waits on the
  Option-C push marker.
- **Loop-anomaly regression (blast radius the data-shape view misses).** The loop
  detector in `stats()` keys on `role + command + entries`; today every `search`
  row is entry-less, so repeated searches group and trip the loop alarm. Giving
  search rows real `entries` would split varying-query searches into distinct
  keys and silently stop flagging a `search`-hammering agent. *Mitigation:* the
  loop detector treats a `search` row as entry-less (`target = ''` for
  `command === 'search'`), preserving the pre-#114 grouping exactly; a regression
  test pins "N varying-query searches still trip the loop." Only the serendipity
  provenance join reads a search row's entries.
- **Scoped vs deployment-wide evidence.** If the pull set were read from the
  shelf-scoped `recent`, a scoped `nb stats <shelf>` would mark every upvote a
  push (search rows are shelf `-`). *Mitigation:* the pull set is built from
  `recentAll`; a dedicated scoped-stats test pins this.
- **`NB_SESSION` cross-notebook sensitivity.** Serendipity is the only metric
  that joins `search` provenance *across notebooks* onto votes by session id, so
  two concurrent tasks (or a reused/templated id) sharing one non-blank
  `NB_SESSION` cross-contaminate the pull set (a downward error). This is the
  existing per-task-session assumption all session-scoped signals share; blank
  sessions are already excluded. *Mitigation:* documented as a limitation here and
  in FR-STATS-004 — the `NB_SESSION`-uniqueness expectation is an epic-#73 /
  deployment contract, not introduced by this RFC.
- **Determinism.** Same-session set membership (not strict search-before-vote
  ordering) keeps the computation order-independent ([DP-6]).
- **Blast radius.** Additive: one line in the CLI `search` case, a one-token guard
  in the loop detector, a counter + a map in `stats()`, one human line in
  `renderStats()`, two optional JSON fields. No change to the notebook file format
  or to any existing rate.

## Verification

- Unit (`notebook.test.ts`, `surfacing metrics` describe): push-upvote → 1;
  searched-then-voted pull-upvote → 0; mixed one-pull-one-push → 0.5; blank /
  no-vote session excluded (gate); scoped `nb stats <shelf>` still detects a pull
  from a deployment-wide (`-`) search row; `null` when no upvotes.
- Loop-detector regression (`notebook.test.ts`): N `search` rows with **distinct
  queries** (hence distinct surfaced id-sets) in the window still trip the `loop`
  anomaly, exactly as before #114 — pins the `command === 'search'` entry-less
  guard.
- CLI/E2E (`cli.test.ts`): `nb search` writes the surfaced entry ids to the usage
  row; `search → vote` yields serendipity 0 while a bare `vote` yields 1; the
  human table renders the `serendipity` line (with the `~` approximate marker);
  `stats --json` carries `serendipity`/`upvotes`.
- Build `dist/` and run the real binary for the E2E assertions (`npm run build`
  then `npx vitest run`).

[DP-5]: ../requirements.md#dp-5
[DP-6]: ../requirements.md#dp-6
[DP-8]: ../requirements.md#dp-8
[NG-004]: ../requirements.md#ng-004
[NG-007]: ../requirements.md#ng-007
[FR-USAGE-002]: ../requirements.md#fr-usage-002
[FR-SEARCH-001]: ../requirements.md#fr-search-001
[#81]: https://github.com/jeanibarz/agent-notebook/issues/81
