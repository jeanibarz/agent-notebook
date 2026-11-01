# RFC 0117 — Backfill a functional requirement for the `nb stats` activity sparkline

- Issue: [#117](https://github.com/jeanibarz/agent-notebook/issues/117)
- Status: accepted (autonomous — corrective, documentation-only, high-confidence per the issue's own classification)
- Epic: self-observing notebook (#73)

## Problem

`docs/requirements.md` is the spec of record — CONTRIBUTING.md says to read it
before proposing a change and to keep it in sync with any behavior change, and
§"Keeping this document honest" states that "each load-bearing requirement names
the test that proves it."

The `nb stats` **activity sparkline** shipped in [#106](https://github.com/jeanibarz/agent-notebook/issues/106)
(designed in [RFC 0106](./0106-stats-activity-sparkline.md)) violates that
contract: it is a shipped, user-visible stats feature with **no functional
requirement**. `rg -ci 'sparkline|activity' docs/requirements.md` returns 0, even
though `README.md` ("Activity sparkline") and `CHANGELOG.md` both document it, and
`src/notebook.ts` implements `sparkline()`, `activityByDay()`, and
`StatsReport.activity`. §4.12 carries FR-STATS-001..004 for the other stats
features but stops short of the sparkline.

This is exactly the spec drift the PR-template sync checklist exists to prevent:
the next contributor cannot find the sparkline's contract (bucketing, scaling,
the `sum(activity) === totalCalls` invariant) in the source of truth, and nothing
in the spec guards those invariants against a regression.

## Design

Add one requirement — **FR-STATS-005 (Should)** — to `docs/requirements.md` §4.12,
immediately after FR-STATS-004, mirroring **RFC 0106's already-shipped contract**:
rolling-24h bucketing (oldest bucket first), zero-based scaling over `▁▂▃▄▅▆▇█`, the
`sum(activity) === totalCalls` invariant, and `StatsReport.activity` exposure in
`--json`. It names its proving tests (`sparkline`/`activityByDay` in
`notebook.test.ts`, the activity-line and `--json` tests in `cli.test.ts`) per the
"Keeping this document honest" rule. This is a corrective documentation backfill
only — no code change, no new behavior — written to the shipped behavior so it
introduces no new drift, and it renumbers nothing. See
[RFC 0106](./0106-stats-activity-sparkline.md) for the full design and the
zero-based-vs-min–max rationale.

## Alternatives considered

- **Leave it undocumented.** Rejected: it is live spec drift against a binding
  CONTRIBUTING.md policy, and leaves the sparkline's invariants unguarded in the
  source of truth.
- **Fold the sparkline into FR-STATS-001** (the per-command rollup). Rejected: the
  sparkline is a distinct over-time read with its own scaling/bucketing/invariant
  contract; §4.12's one-FR-per-feature convention (FR-STATS-001..004) keeps each
  contract independently citable and independently testable.

## Acceptance criteria (from the issue)

- `requirements.md` contains an FR for the `nb stats` activity sparkline
  referencing RFC 0106.
- The FR states the bucketing, scaling, and `sum(activity) === totalCalls`
  invariants.

## Critic feedback incorporated

Status: accepted (v2 — post-review revision). One review round of three critics,
chosen for a documentation-only backfill (`ambition-amplifier` skipped — a
backfill mirroring shipped behavior has no scope to amplify; `assumption-archaeologist`
skipped — the skill excludes documentation-only RFCs).

- **failure-mode-analyst** 2026-11-01: ran the issue-106 tests (16/16 green) and
  confirmed every normative/testable FR claim and all four contract points
  faithfully mirror shipped code — no new spec drift in the binding text. Flagged
  one non-normative Rationale overclaim (below). Verdict: Proceed.
- **clear-writing-reviewer** 2026-11-01: same Rationale overclaim — the FR's
  Rationale said zero-based scaling keeps a 0-op bucket "distinguishable from a
  merely quiet one", but under the shipped `Math.round((c/max)*7)` a low-nonzero
  bucket can round to the same floor glyph (`sparkline([0,1,100]) → ▁▁█`).
  **Fixed:** the Rationale now claims only that the floor glyph is anchored to zero
  (the origin), not to the window's minimum — which the code strictly holds.
- **design-minimalist** 2026-11-01: the first draft duplicated RFC 0106's design in
  the RFC body and repeated "no code change". **Fixed:** the Design section now
  points at RFC 0106 for the contract detail rather than restating it.
- **consensus attack** 2026-11-01: not spawned as a separate agent. The only shared
  blind spot the "mirror RFC 0106" framing could hide — RFC 0106 diverging from the
  actual shipped code — was already independently falsified: failure-mode-analyst
  checked the FR against code and the green test suite directly, not against 0106.
  Consensus survives.
