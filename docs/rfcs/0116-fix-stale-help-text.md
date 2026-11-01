# RFC 0116 — Fix stale `nb --help`: line cap and the missing failed-search signal

- Issue: [#116](https://github.com/jeanibarz/agent-notebook/issues/116)
- Status: accepted (autonomous — corrective, documentation-only, high-confidence per the issue's own classification)
- Adjacent: PR #96 (lowered the cap 200→50), #82 / PR #85 (added the `failed-search` signal)

## Problem

`nb --help` is the primary user-facing reference, and two of its lines no longer
match the shipped code:

1. **Line cap is off by 4×.** The help says a notebook "holds at most 200 lines",
   but PR #96 lowered the default to **50**. Both `maxLines()`
   (`src/notebook.ts` — default `50`) and the README ("At most 50 lines per shelf
   by default") already say 50; only the help string was left stale.

2. **A shipped diagnostic signal is undocumented.** `nb stats` emits four
   diagnostic signals, but the help's diagnostic-signals bullet lists only three
   — `browse-without-use`, `eviction-while-still-voted`, `vote-reversal` — and
   omits **`failed-search`** (added in #82 / PR #85). An operator reading `--help`
   never learns the failed-search coverage-gap signal exists.

Both erode trust in the help text: the one reference an agent or operator reads
first misstates a core bound and under-documents a feature that ships.

## Design

A documentation-only edit to the `HELP` string in `src/cli.ts`. No behavior
change, no schema change, no new agent action.

1. Change `a notebook holds at most 200 lines` → `a notebook holds at most 50
   lines`, keeping the 200-char-per-lesson clause unchanged.
2. Extend the diagnostic-signals bullet to list `failed-search` alongside the
   other three, with a one-clause gloss consistent with how `stats()` computes it
   (a search returned nothing and a lesson was then added in the same session —
   the coverage gap that search just exposed).

### Verification

The repo had no help-text assertion pinning either fact, so the stale text drifted
silently. This RFC adds two focused `cli.test.ts` assertions against `nb --help`:

- the help states `at most 50 lines` and no longer contains `at most 200 lines`;
- the help lists all four signal names, and specifically carries the new
  `failed-search` entry text in the diagnostic-signals bullet (the token already
  appeared in the `nb search` description, so the assertion pins the new location,
  not merely the word).

These lock the two facts so a future cap or signal change that forgets the help
fails a test instead of drifting.

## Acceptance criteria

- `nb --help` states the line cap as 50 (matching the README and `maxLines()`).
- `nb --help` lists `failed-search` alongside the other three diagnostic signals.
- `npm test` passes on Node 20.12+.

## Risks

Documentation-only; no behavior change. The only risk the issue flags — a help
snapshot/substring test needing an update — does not materialize: no existing
assertion references these lines, and the two assertions this RFC adds are the
ones that now guard them.

## Alternatives considered

- **Rephrase the cap as "50 by default (tunable via `NB_MAX_LINES`)".** Rejected
  as scope creep: the sibling char-cap clause in the same line does not spell out
  its env override either, and the issue's accepted "smallest solution" is the
  bare `50`. Matching the existing terse style keeps the line consistent.
