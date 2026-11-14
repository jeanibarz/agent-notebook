# RFC 0478 — Move the usage log and the `nb stats` engine out of `notebook.ts`

- Issue: [#478](https://github.com/jeanibarz/agent-notebook/issues/478)
- Status: accepted (v2, after one critic round; autonomous — behavior-preserving refactor, no user-facing change)
- Out of scope (separate decisions, per the issue): narrowing the exported API
  (`stealStale`, `noteRecovery` and other test-only internals); splitting the
  `runNbCli` switch in `cli.ts`.

## Problem

`src/notebook.ts` is 4,112 lines with 138 exports (100 runtime values, 38 types),
and it is the package entry. The README and `docs/enterprise.md` tell a
supply-chain reviewer that this one file "is the whole mechanism", so they can read
it end to end. But its last ~1,600 lines (about 40%) are not the cap-and-vote
mechanism. They are the self-monitoring layer:

- the **usage log** (`logUsage`, `parseUsage`, `normalizeReason`, `REASON_ENUMS`,
  `formatEvictedUsage`, and the row-count sidecar behind the append fast-path);
- the **`nb stats` engine** (`stats()`, `diagnoseEngagement`, `sparkline`,
  `activityByDay`, `parseWindowMs`, and the anomaly and signal types).

Most changes to the file land in that monitoring layer, so the mechanism file's
history is mostly monitoring churn.

The split's benefit is organisation, not a smaller audit. A reviewer can now read the
cap-and-vote mechanism as one file and see monitoring changes as their own diffs.
But `usage.ts` writes user-derived data to disk on every call: search query text,
`NB_SESSION`, and ids. So it stays in the audit surface, and the docs say so.

## Dependency facts this design rests on

These were checked against the code, not taken from the issue:

1. **No core code depends on the block.** Every mention of `logUsage` or `stats` before
   line 2486 is in a comment. The block's private helpers (`sanitizeUsageField`,
   `capNote`, `percentile`, `WINDOW_RE`, …) are used only inside it.
2. **The block depends on core, and on one private core helper each way:**
   - `usage.ts` needs `preserveMode` (private; core also uses it for shelf writes);
   - `stats.ts` needs `skipUnreadable` (private; core `search` also uses it).
3. **The row-count sidecar is usage-log code that happens to sit in core.**
   `usageCountFile`, `readUsageState`, `usageSize` and `writeUsageState` (core,
   ~lines 375–425) are called only by `logUsage`.
4. **The error family is core.** `ERROR_CLASSES`, `ErrorClass`, `NbError` and
   `classifyError` are declared under the "usage log + monitoring" banner but are
   thrown about 27 times by core code.

## Design

```
src/notebook.ts   core: storage, cap-and-vote, search, tunables, error classes
src/usage.ts      usage log         imports ./notebook.js
src/stats.ts      nb stats engine   imports ./notebook.js, ./usage.js
src/index.ts      package root      re-exports the three; imported by nobody in src/
src/cli.ts        CLI               imports the three modules directly, never index
```

Tests follow the same rule as `cli.ts`: a test imports a name from the module that
owns it (`logUsage` from `./usage.js`, `stats` from `./stats.js`), never from
`./index.js`. The only exceptions are the two tests that exist to check the root.

1. **Error family stays in `notebook.ts`.** Its banner is renamed from
   "usage log + monitoring" to "error classes", so it reads as core. A separate
   `errors.ts` would add a file and a re-export for no gain.
2. **The usage log moves to `src/usage.ts`, with its sidecar.** The four sidecar
   helpers (fact 3) move with `logUsage` and stay unexported.
3. **The stats engine moves to `src/stats.ts`.** It imports `parseUsage` /
   `UsageRow` from `usage.ts` and everything else from core.
4. **Barrel `src/index.ts` becomes the package root.** `package.json` `main`, `types`
   and `exports["."]` move from `dist/notebook.*` to `dist/index.*`. This avoids a
   `notebook ↔ stats` ESM cycle, which `export * from './stats.js'` inside
   `notebook.ts` would create. It is safe because `exports` exposes only `.`, so no
   consumer can deep-import `dist/notebook.js` by specifier. A consumer that builds
   a file path around `exports` still can. The repo's own
   `examples/nb-git-wrapper.mjs` does this: it loads `notebook.js` next to the
   resolved entry for `stripControlChars` and `maxChars`. Both stay in core, so it
   keeps working. Only its comment, which names the old `main`, changes.
5. **The root does not widen.** `preserveMode` and `skipUnreadable` must now be
   exported from `notebook.ts` so the new modules can import them. So `index.ts`
   cannot `export * from './notebook.js'`. It re-exports core by an **explicit name
   list** (`export { … }` and `export type { … }`), generated from the pre-split
   export set. `usage.ts` and `stats.ts` have no internals, so they use
   `export *`, as `notebook.ts` did before.
6. **Tunables stay in core.** The issue allows the stats-only tunables (`LOOP_N`,
   `SILENT_H`, `ERR_MIN`, `ERR_RATE`, `ADD_BURST_N`, `COVERAGE_HI`,
   `RECALL_MISS_HI`) to move, but does not require it. Keeping every `IntTunable` /
   `RateTunable` declaration in one place keeps `nb config`'s registry in one
   place, and keeps the tests that `import('./notebook.js')` for them unchanged.
   This is a deliberate exception to "core does not know about stats". Core
   declares the knobs, with their names, defaults and bounds, but never reads them.
   Moving them needs a tunable-registration seam, and that is a design change, not
   a move.
7. **Module shape follows `doctor.ts`.** Each new file opens with a doc header that
   says what it is and what it reads, then imports from `./notebook.js` by name.

## Guards (tests)

- **`src/package-exports.test.ts` (golden).** It is committed first, against
  unchanged `main`, and is not edited afterwards. It imports the entry named by
  `package.json` `exports["."].default` and pins the sorted runtime key set
  (100 names).
- **`src/module-boundaries.test.ts`** covers what the golden test cannot:
  - *No import cycle.* It parses the relative imports of every non-test
    `src/*.ts`, asserts the graph is acyclic, and asserts `notebook.ts` imports
    none of `usage`, `stats` or `index`.
  - *Types pinned at compile time.* An `import type { … }` of all 38 published type
    names from `./index.js`. Dropping one fails `npm run typecheck`, which CI runs.
  - *No silent un-publishing.* Every runtime export of `notebook`, `usage` and
    `stats` is either on the root or in a short, named allowlist of internals
    (`preserveMode`, `skipUnreadable`). A new core export cannot be left off the
    root by accident, and an internal cannot reach it by accident.
- **`src/pack-install.test.ts`** asserts that `main`/`types` are the shipped
  `dist/index.js` / `dist/index.d.ts`, and that the bare specifier still resolves.
  The expected filenames change, so this is more than an import-path edit.

## Behavior preservation

The moved code is cut from the file, not rewritten. The PR records a script check
that the original lines 2541–4112, plus the four sidecar helpers, equal the bodies
of `usage.ts` and `stats.ts` once the new headers and import blocks are stripped.

## Docs

- README:616 and `docs/enterprise.md:42`: the mechanism is `src/notebook.ts`. The
  usage log writer (`src/usage.ts`, which records query text and `NB_SESSION`) and
  its reader (`src/stats.ts`) sit beside it. A review of what the package records
  should read all three files.
- `docs/requirements.md:13` (source-of-truth list) and NFR-MAINT-001 (`:1492`, "the
  whole mechanism SHALL stay in `src/notebook.ts`"): name the two monitoring modules
  alongside it, so the requirement matches the code. NFR-MAINT-001 is a
  maintainability requirement, not a behavior, so no test changes.
- CHANGELOG: no entry. There is no user-visible change: the CLI, the root API and
  the on-disk formats are unchanged. The PR template's changelog row is struck with
  that reason.

## Rollback

There is one PR and no data or format change. Reverting it restores the previous
layout exactly.

## Alternatives considered

- **`export * from './usage.js'` / `'./stats.js'` inside `notebook.ts`**, keeping
  `main` unchanged. Rejected: `stats.ts` imports core, so this is an ESM cycle.
  Cycles work in practice, but they make evaluation order fragile, and the issue
  forbids it.
- **`export *` from all three modules in the barrel.** Rejected: it publishes
  `preserveMode` and `skipUnreadable` at the root.
- **Move `preserveMode` / `skipUnreadable` into a small internal module** so the
  barrel could `export *` everything. Rejected: it moves core shelf-write and
  shelf-read semantics out of the core file to satisfy a packaging detail, the
  opposite of the "core in one file" goal.

## Critic feedback incorporated

Round 1 (2026-11-14) ran three critics: `boundary-critic`, `design-minimalist` and
`failure-mode-analyst`.

**Incorporated**

- *failure-mode-analyst / boundary-critic: the deep-import claim was too strong.*
  `examples/nb-git-wrapper.mjs` builds a path to `notebook.js`. The RFC now names
  it as a known path consumer (design §4), and its stale comment is fixed. The
  wrapper's session-trailer path is already exercised by
  `nb-git-wrapper-gitignore.test.ts`.
- *failure-mode-analyst: the RFC did not say where tests import from.* It now
  states the owning-module rule.
- *boundary-critic: keeping the tunables in core was under-justified.* It is now
  recorded as a deliberate exception, with the reason (design §6).
- *design-minimalist: no committed move-proof artifact.* The verbatim-move check is
  a one-off script whose output goes in the PR body.

**Rejected, with reasons**

- *design-minimalist: use `export *` from all three and accept two new root names.*
  This contradicts the issue's acceptance criterion "no new names are added to the
  package root". Narrowing or widening the API is the separate semver decision
  that the issue puts out of scope.
- *design-minimalist: the allowlist test duplicates the golden test.* It does not.
  The golden test pins the old set, so a **new** core export left out of the
  explicit list passes it silently. That silent un-publishing is the one failure
  mode the explicit list introduces, and the allowlist test closes it.
- *design-minimalist: drop the cycle check or the type pin.* "No import cycle" is an
  acceptance criterion, and the check is about 15 lines over a five-file graph.
  The type pin is the only guard on the 38 types once core is listed explicitly.
- *boundary-critic: move `usageFile`, `usageRing` and `usageRingSlack` into
  `usage.ts`.* Core uses `usageFile` itself, to reap leftover temp files from
  usage-log rewrites. `usageRing` and `usageRingSlack` are tunables, the same
  case as design §6.
- *boundary-critic: an `fs-util.ts` for `preserveMode` and `skipUnreadable`.*
  `preserveMode` is part of the shelf write's durability contract, and
  `skipUnreadable` returns the core `SkippedShelf` type. Both are mechanism, not
  generic utilities. Already listed under Alternatives.
- *boundary-critic: allowlist the exact names `usage.ts` and `stats.ts` import
  from core.* `tsc` already fails on a missing name, and a widening import shows
  up in review. A name allowlist would need an edit with every change.
- *failure-mode-analyst: type-check a packed consumer against all 38 types.* The
  declarations are emitted from the same `index.ts` that the compile-time type pin
  checks. `pack-install.test.ts` already proves `types` resolves to a shipped
  file.
- *failure-mode-analyst: a guard for the `pendingRecovery` tally across the seam.*
  It already exists. The `logUsage` column-order test in `notebook.test.ts` primes
  the tally with `noteRecovery` from `./notebook.js` and asserts the `2:1`
  `recovered` cell written by `logUsage` from `./usage.js`.
- *failure-mode-analyst: add a CHANGELOG line.* The root API, the CLI and the files
  on disk do not change. The changed `main` value is visible only to code that
  resolves the package and then reaches around `exports`, which the package does
  not support. The PR body records the change instead.

**Convergence.** Round 1 changed wording and evidence, not the design: the module
split, the barrel shape and the guards are as drafted. A second round of the same
lenses would re-review an unchanged design, so review stopped after one round. The
empirical checkpoint ran as the real thing rather than as an agent. The split is
implemented, the move-proof script and the full suite were run against it, and a
mutation (adding `export * from './stats.js'` to `notebook.ts`) was confirmed to
fail the cycle test.

**Consensus attack.** `general-purpose` 2026-11-14 found a consensus-attack
finding. The panel and the first doc draft framed the usage log as "not mechanism",
which implied an auditor could skip it. But `usage.ts` writes search query text and
`NB_SESSION` to disk on every call. The finding was incorporated: the Problem
section now gives the split's benefit as organisation, and the README and
`enterprise.md` name all three files as the audit surface for what the package
records. The module design is unchanged.
