# RFC 0105 — `nb stats`: break down "no engaged sessions" by root cause

- Issue: [#105](https://github.com/jeanibarz/agent-notebook/issues/105)
- Status: accepted (autonomous — small, additive, high-confidence per the issue's own classification)
- Epic: self-observing notebook (#73); extends the engagement gate of #81

## Problem

When `nb stats` finds no engaged sessions it prints one vague line:

```
  surfacing: no engaged sessions in this window (set NB_SESSION and vote to measure)
```

"No engaged sessions" (engagement gate of §4 — a session counts only once it
shows an up/down vote) collapses three *different* operational failures into
one message, each with a different fix:

1. **`NB_SESSION` is unset** — calls happen but carry a blank session, so they
   can never be grouped into a session, so none can ever be "engaged".
2. **The retrospective nudge isn't landing** — the agent *opens* notebooks but
   never votes, so the end-of-task vote (the engagement signal) never fires.
3. **The SessionStart injection hook isn't wired** — the notebooks hold lessons
   but nothing in the window *read* them at all.

Today an operator must read the raw `.nb-usage.log` to tell which one they are
in. This is the hardest failure to diagnose in a real deployment ("agents
aren't using the notebooks" and the tool can't say why).

## Design

A **read** of the usage ring — no notebook-file schema change ([NG-004]), no new
agent action, no new column. Computed in `stats()` from the same windowed,
shelf-scoped `recent` rows that already feed `surfacing`, and surfaced both in
the human table and in `--json`.

### Scope: only when `engagedSessions === 0`

The diagnosis replaces the single generic line **only** when the engagement gate
finds nothing (`engagedSessions === 0`). When there *is* engagement the existing
coverage / recall-miss / precision-miss readout is shown unchanged. The issue
mentions "zero *or unhealthy*"; defining an "unhealthy-but-nonzero" threshold is
deliberately **out of scope** — it would need a new tunable and none of the
acceptance criteria exercise it. `engagementDiagnosis` is therefore `null`
whenever `engagedSessions > 0`.

### Defining "read" precisely (the one real risk the issue flags)

A **read** is deliberately defined *twice*, because the two checks ask different
questions, and this is exactly where the issue warns "don't double-count the
hook's own `nb list`":

- **For the injection-hook check** (cause 3), a read is any of
  `show` / `list` / `search`. If even the hook's auto-injected `nb list` is
  absent from the whole window, the hook path did not run — so a total read
  count of **0** is the signal.
- **For the retrospective check** (cause 2), a read is only `show` / `search` —
  a *deliberate* open of notebook content by the agent. The SessionStart hook's
  automatic `nb list` is **excluded** here: a session in which the hook injected
  the index but the agent never opened a notebook is not "the agent used the
  notebook but skipped the retrospective", so it must not be counted as cause 2.

### The three causes (computed, ordered, ≤ 3 lines)

Over the windowed, shelf-scoped `recent` rows, when `engagedSessions === 0`:

| Cause | Condition | Line |
|---|---|---|
| `blank-session` | `blankSessionCalls > 0` (rows with `session === ''`) | export `NB_SESSION` so calls group into sessions |
| `retrospective-not-landing` | `readOnlySessions > 0` (distinct non-blank sessions with a `show`/`search`) | the agent opened a notebook but never voted — the retrospective nudge isn't landing |
| `injection-hook` | `reads === 0` **and** `storedLessons > 0` | notebooks hold lessons but had 0 reads — the SessionStart hook is probably not wired |

Where `reads` counts `show`/`list`/`search` rows and `storedLessons` is the
in-scope notebook line total (already computed for the inventory section).

Causes are independent booleans emitted in the order above, so a mixed log can
show more than one (e.g. some blank-session calls *and* a never-wired hook). The
set is naturally ≤ 3. `retrospective-not-landing` and `injection-hook` are
mutually exclusive (the former needs a `show`/`search`, which makes `reads > 0`).

If `engagedSessions === 0` but **no** cause fires (e.g. an empty notebook with no
activity — nothing to diagnose), the original generic line is kept as a fallback.

### Acceptance-criteria trace

- *Only blank-session rows* → `blankSessionCalls > 0`, `readOnlySessions === 0`
  (blank sessions form no session), `reads` from those shows keeps cause 3 off →
  **only `blank-session`**. ✅
- *Reads but no votes* (NB_SESSION set, `show`, no vote) → `readOnlySessions > 0`
  → **`retrospective-not-landing`**; `reads > 0` keeps cause 3 off, no blank rows
  keeps cause 1 off. ✅
- *Non-empty shelves, zero reads* → `reads === 0 && storedLessons > 0` →
  **`injection-hook`**. ✅
- *≤ 3 lines; `--json` exposes the counts; no notebook-file schema change.* ✅ —
  `SurfacingMetrics.engagementDiagnosis` carries `blankSessionCalls`,
  `readOnlySessions`, `reads`, `storedLessons`, and the ordered `causes[]`.

## JSON shape

```jsonc
"surfacing": {
  "engagedSessions": 0,
  // …existing rate fields (null when no data)…
  "engagementDiagnosis": {
    "blankSessionCalls": 3,
    "readOnlySessions": 0,
    "reads": 0,
    "storedLessons": 5,
    "causes": ["blank-session", "injection-hook"]
  }
}
```

`engagementDiagnosis` is `null` when `engagedSessions > 0`.

## Risks & mitigations

- **Mis-defining "read"** — mitigated by the two precise definitions above and by
  per-condition tests (each cause isolated so a deleted guard fails a test —
  verified by a mutation-testing pass over the new logic).
- **Clutter** — capped at three terse lines, shown only in the zero-engagement
  branch; the healthy readout is untouched.
- **Blast radius** — additive: a few lines in `stats()` + `renderStats()` and one
  new optional JSON field; no change to the notebook file format or to any
  existing rate.

## Verification

- Unit tests per cause (and per overlap) in `notebook.test.ts`; CLI/E2E
  assertions in `cli.test.ts`.
- End-to-end: build `dist/`, craft `.nb-usage.log` fixtures, run the real
  `nb stats` binary, and confirm each of the three diagnoses renders (the
  blank-session case run under `env -u NB_SESSION`).
- Mutation testing over the new `diagnoseEngagement` logic to confirm every
  guard is pinned by a test.
