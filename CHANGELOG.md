# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

### Added
- **`nb stats` shows an ops-per-day activity sparkline** (issue #106). The report gains a
  one-line, zero-dependency Unicode block-glyph plot of activity over the window —
  e.g. `activity  ▂▁▅█▇▃▁  (7d, 41 ops)` — so "when did this store go quiet?" is answerable
  at a glance instead of by eyeballing raw `.nb-usage.log` timestamps. Rows are bucketed
  into **rolling 24-hour windows counting back from now** (timezone-free; oldest bucket
  leftmost, the 24h ending now rightmost), and the per-bucket counts are exposed as
  `StatsReport.activity` in `nb stats --json` (`sum(activity) === totalCalls`). Scaling is
  zero-based so a silent (0-op) bucket always reads as the floor glyph `▁`. No notebook-file
  schema change and no new runtime dependency; the library gains the pure `sparkline` and
  `activityByDay` functions. See [RFC 0106](docs/rfcs/0106-stats-activity-sparkline.md).
- **`nb stats` breaks down "no engaged sessions" by root cause** (issue #105). When the
  engagement gate finds no engagement anywhere in the window, the one vague
  `surfacing: no engaged sessions…` line is replaced by up to three terse, actionable
  lines naming the actual deployment-level failure(s): `NB_SESSION` unset (calls can't be
  grouped into sessions), the retrospective nudge not landing (a notebook was opened but
  never voted), or the SessionStart injection hook not wired (notebooks hold lessons but
  nothing read them). The diagnosis is deployment-wide — the hook's own global `nb list`
  is counted as a read but **not** as deliberate engagement, so it is never
  double-counted — and the underlying counts are exposed as
  `surfacing.engagementDiagnosis` in `nb stats --json` (`null` whenever any session was
  engaged). No notebook-file schema change; the library gains the `diagnoseEngagement`
  function and the `EngagementDiagnosis` type.
- **`nb move <from> <to> <id|query>` — score-preserving cross-shelf move** (issue #103).
  Relocates one lesson from one shelf to another **with its score intact**, the
  consolidation `add`+`rm` could not express (`add` always enters at the `+1` floor, so a
  hard-won lesson would land at the bottom of the target and lose its vote history). The
  entry is admitted into the target like a newcomer, so a full target ages/evicts its
  stalest *other* line, never the lesson just moved. The move is refused — writing nothing
  to either shelf — when the source and target are the same shelf, the selector is
  absent/ambiguous (same unique-match rule as `vote`/`rm`), or the target already holds a
  near-duplicate (same dedup rule as `add`). Accepts the usual `--reason <code>`/`--note`
  (enum: `consolidate` · `other`) and `--json` (emits a `MoveResult`). The library gains
  `move(dir, fromShelf, toShelf, selector)` and the `MoveResult` type.

## [0.4.0] - 2026-10-29

### Changed
- **Terminology: a notebook file is now called a *shelf*.** A shelf is one `<name>.md`
  notebook file: a group of lessons an agent needs in the same situations. Lessons are
  grouped by co-access (needed together), not by agent role, so an agent that opens a
  shelf can get the lessons it looks for plus ones it might not think to search for. The CLI help, error messages (e.g.
  `invalid shelf name`, `missing <shelf> argument`), human `nb stats` output, README,
  AGENTS.md and docs now say shelf. Argument positions, the `shelf@project` scoping, every
  `NB_*` variable, the file layout and the usage-log format are unchanged.

- The `.` namespace convention now recommends **no prefix or one level at most**
  (`family.situation`). The dot builds no hierarchy, and deeper names split lessons that
  are needed together into small shelves. Docs only; no behaviour change.

- **A full shelf is the normal state; do not split a shelf because it is full.** Eviction
  and aging only run at the cap, and they are what retire unused lessons; splitting on
  size multiplies half-empty shelves and makes the index harder to choose from. The README
  gains a section on when to act: only when a full shelf keeps evicting lessons still
  scored above the starting +1, or relearns evicted ones. The `eviction-while-still-voted` signal of `nb stats`
  now counts only lessons evicted with a score above the +1 a new lesson starts at (evicting
  a lesson that was never voted, or that fell back to +1 or below, is the cap working),
  and its detail no longer suggests splitting.
- `examples/nb-janitor.mjs`: section 1 is now "Lessons lost to eviction". It flags a shelf
  with 2 or more evictions of lessons scored above +1 or re-added evicted lessons in the window, and
  reports how many shelves are full for information only. The `--json` report replaces
  `capPressure` with `fullShelves` and `lostLessons`.

### Added
- `shelf` key next to `role` (same value) on every JSON object that carried `role`:
  `nb show --json`, `nb list --json` rows, `nb search --json` groups, `nb describe --json`,
  and in `nb stats --json` the `notebooks[]`, `anomalies[]` and `signals[]` entries.
  `notebookTotals` gains `shelves` next to `roles`.
- Library exports `listShelves` and `assertSafeShelf`, and a `shelf` option for `stats()` (the `role` option still works).
- `nb shelves`, an alias of `nb list`.

### Deprecated
- The `role` / `roles` JSON keys, the `listRoles` and `assertSafeRole` exports, the `role`
  option of `stats()`, and the `nb roles` command. They still work and behave exactly as before; they will be removed
  only in a later release marked BREAKING.

## [0.3.0] - 2026-10-29

### Changed
- **Eviction is now recency-aware, and a full notebook always admits a newcomer.**
  Storage order became *recency* order (least-recently-touched first): a touch — a vote
  of either sign, an add, or a merge/split's new lesson — moves its entry to the end of
  the file. When a full notebook takes a new lesson it is always stored (the old
  `rejected-full` outcome is gone); the lowest-scored line is evicted (ties → stalest) and
  then the stalest *surviving* line is docked one point. That gentle, targeted "aging" is
  what lets a once-upvoted lesson that has gone quiet eventually fall, instead of being
  immortal, without needing a downvote to arrive. It fires only when a notebook is full, so
  every sub-cap notebook is unaffected except that a vote now moves its line (a ~2-line git
  diff instead of a 1-line one). Rationale and the full design in `docs/eviction-and-aging.md`;
  this reverses the old DP-3 "storage is insertion order, never reordered on vote".
- The default per-notebook cap (`NB_MAX_LINES`) is now **50**, down from 200. A tighter
  default keeps eviction pressure meaningful and a notebook focused on the lessons that
  earn their place; most roles need far fewer than 200. Raise it any time with
  `NB_MAX_LINES` (range unchanged, 1–5000). The character cap (`NB_MAX_CHARS`) stays 200.

### Added
- Onboarding and harness-integration documentation (docs-only; no package behaviour change).
  - `AGENTS.md` (with `CLAUDE.md` as a symlink to it) — the agent operating contract: the
    four moments (list / open / subagent / retrospective) and how to write a lesson. The
    core behaviour is harness-agnostic: the agent lists the notebooks and opens the ones
    that fit, rather than a role-specific notebook being auto-injected.
  - `docs/getting-started.md` (plain-language intro with diagrams), `docs/harness-setup.md`
    (make Claude Code / Codex CLI use it on Linux/macOS/Windows via the list-&-open
    instruction, plus optional convenience hooks, git-versioning, backup, janitor),
    `docs/enterprise.md` (data-sovereignty / security / compliance rollout), and
    `docs/visual-explainer.html`.
  - `examples/` — the optional harness layer: `nb-git-wrapper.mjs` (a commit per change),
    `nb-backup.sh` (daily push), `nb-janitor.mjs` (read-only cross-notebook diagnostics:
    paraphrase-duplicate and near-duplicate-role detection, cap pressure, growth trends),
    and hook recipes for Claude Code and Codex CLI.
  - `.claude/skills/` — `agent-notebook-setup` and `agent-notebook-explain` skills that
    walk a user through configuration or explain the tool on request.

## [0.2.1] - 2026-10-28

### Added
- `nb show <role> --json` (#87) emits the notebook as `{ role, description, entries: [{ id, score, text }] }`,
  in the same order and with the same ids as the human output, so agents no longer parse text. The flag works
  before or after the role; the human output is unchanged. Library form: `showJson(dir, role)`.

### Fixed
- `nb describe` now strips the optional `--reason`/`--note` flags before reading its
  text operand, like the other mutating commands (#91). Previously an option placed
  before the text (`nb describe <role> --reason other "real text"`) was silently stored
  as the description and the intended text dropped, exiting 0 — a DP-5 violation. The
  flags are now logged to the usage log (never the notebook); `describe` has no seeded
  enum, so a stray code buckets to `other` with its text kept in the note, like `add`.
- A `README.md` in `NB_DIR` is no longer treated as a notebook (#90). A README is
  common when the notebook folder is a git repo that backs up your notebooks; it was
  being listed, searched, counted in `nb stats`, and — worst — voteable/removable,
  letting a write command rewrite it. `README.md` (case-insensitive) is now excluded
  from `listRoles` and the `README` role name is reserved in `assertSafeRole`, so no
  read or write command touches it. Documented beside the `.` namespace convention.

## [0.2.0] - 2026-10-28

### Added
- The **`.` namespace convention** for grouping notebooks (#83) — a documented,
  recommended way to cluster related notebooks by a `.`-delimited role-name prefix
  (`review.tests`, `review.correctness`) so they sort together and `nb list review.` /
  `nb search "flaky" review.` scope straight to the group. It is a **naming convention
  only**: a namespaced role is a first-class role (no change to `assertSafeRole` — `.`
  was already a legal interior character) stored as one flat `<role>.md` file, never a
  directory, and grouped lexically with no embeddings or similarity ([NG-001]). Keep the
  trailing dot so `review.` does not also match a bare `reviewer`; `@` stays reserved for
  the existing `role@project` scoping and composes with a namespace
  (`review.tests@repo`). Documented in the README and as [FR-NAMESPACE-001]; part of
  epic #73 (Phase 2).
- `nb search <query> [prefix] [--any]` (#82) — a **demoted, secondary** keyword fallback
  and gap-sensor. The primary path is *surfacing* (injection + the `nb list` index), per
  [DP-8] / [NG-007]; search exists only for genuine known-item lookup, and both the help
  text and the output say so plainly. It is **keyword-only** (plain case-insensitive
  substring over the query's terms — no embeddings, [NG-001]): it scans every notebook's
  lessons and descriptions, AND-over-terms by default (`--any` for OR), groups hits by
  notebook most-relevant-first, and prints each lesson's id so the agent can `vote` it.
  `--json` emits the raw `SearchResult`; the library form is `search(dir, query, {prefix?, any?})`.
  A search that finds nothing is logged (outcome `no-match`, query in the usage note) and is
  not an error (exit 0). That unlocks the **`failed-search → add` coverage-gap signal**
  deferred from #72: `nb stats` now derives a fourth `DiagnosticSignal` kind, `failed-search`,
  when a `no-match` search is followed by an accepted `add` in the same session — a gap the
  notebook did not hold, labelled by the agent's own query.
- Named **surfacing metrics** in `nb stats` (#81). `StatsReport.surfacing`
  (`SurfacingMetrics`) turns the usage ring into the rates the design rationale §4
  defines: **coverage** (novel-add rate = accepted ÷ attempts), **recall-miss** (the
  headline alarm — dedup-block rate = blocked ÷ attempts, a stored lesson re-derived),
  **precision-miss** (downvotes ÷ votes on pushed lessons, read beside recall so
  "surface everything" can't look free), and a coverage×surfacing **readout**
  (`healthy` / `surfacing-failure` / `coverage-building` / `churny`). Every rate is
  conditioned on *attempts* (robust to a lazy agent) and gated on *engagement* — only
  sessions with a vote are scored, so an uninstrumented session isn't read as "healthy
  quiet"; a rate with no data is `null` (shown `—`), never a misleading `0`. Surfaces in
  the human table under a `surfacing:` section and in `--json` as `StatsReport.surfacing`.
  Readout cutoffs are tunable via `NB_COVERAGE_HI` (default `0.5`) and `NB_RECALL_MISS_HI`
  (default `0.2`). Needs `NB_SESSION` set to attribute calls to sessions.
- `docs/self-observing-notebook.md` — the design rationale for the self-observing
  signal layer: why the tool instruments itself, what each operation signals, and how
  engagement, coverage, surfacing recall, surfacing precision, and serendipity are
  distinguished. Linked from `docs/requirements.md`.
- Free diagnostic signals in `nb stats` (#72). Three memory-quality observations read
  straight from the usage ring — no new agent action, no field added to a lesson: 
  **browse-without-use** (a notebook `show`n in a session with no `vote` on it that
  session → its description may over-promise), **eviction-while-still-voted** (the cap
  evicted an entry that had been voted on → the cap may be too tight for that role), and
  **vote-reversal** (the same entry upvoted in one session and downvoted in another →
  correct but mis-aimed). They surface in the human table under a `signals:` section and
  in `--json` as `StatsReport.signals` (`DiagnosticSignal = { kind, role, detail,
  session?, entry? }`), computed over the same windowed, role-scoped rows as the
  anomalies. browse-without-use and vote-reversal are session-scoped, so set `NB_SESSION`.
  The `failed-search→add` coverage signal is deferred to the future `nb search` command.
- `nb list` — the notebook index (#71). One richest-first line per notebook — name,
  lesson count, and description — so an agent can decide *which* notebook to open
  without reading any of them (level 1 of progressive disclosure for epic #73). `ls`
  and `roles` are aliases. Ordered by lesson count (ties by name); a notebook with no
  `# desc:` falls back to its top-scored lesson, marked `(auto)`. A bare `prefix`
  filters by name (the `.` namespace convention, e.g. `nb list review.`), `--limit N`
  bounds the rows (default 50; the header then reads "shown of total") so discovery
  cost stays flat, and `--json` emits the raw `NotebookListing`. An empty (zero-lesson,
  no-description) notebook is hidden as phantom debris; a described-but-empty notebook
  is kept. New library export `listNotebooks(dir, {prefix?, limit?})`.
- Notebook descriptions: `# key: value` metadata + `nb describe` (#70). A notebook file
  may now begin with a leading `# key: value` comment block; `readEntries` skips it (a
  `#`-leading `key:` line never becomes a score-0 lesson) and every mutation round-trips
  it. `nb describe <role> "<text>"` sets the notebook's one-line description — a *trigger*
  for when to open it — stored as a `# desc:` line; `nb describe <role>` prints it, an
  empty text clears it, and `nb show` prints it as a header. The description is capped
  like a lesson (rejected, not truncated), and unknown keys are preserved verbatim
  (forward-compatible). Stays within the no-schema non-goal — metadata is optional
  comment lines in the file, not a field on a lesson. Level 1 of discovery for epic #73.
- Entry-level + outcome logging in the usage ring (#67). Each `.nb-usage.log` row now
  also records the entry id(s) a call touched, a session id from the `NB_SESSION`
  environment variable, and the call's outcome (`accepted`/`dedup-blocked` with the
  colliding id, vote direction, eviction). The parser tolerates old five-column rows,
  logging stays best-effort, and the ring stays bounded — no field is added to a
  lesson. Foundation for the self-observing-notebook diagnostics (epic #73).
- This changelog.
- **DP-8 / NG-007** in `docs/requirements.md`, and a matching line in the README:
  memory's job is to surface the lesson an agent would not think to search for, so
  the notebook is *shown* (injected) rather than queried — a search-first retrieval
  model is a non-goal.
- `docs/requirements.md` — a canonical specification of the essential
  features, design choices, and their rationale (including why the on-disk
  file is stored in insertion order rather than sorted), so settled decisions
  are not re-litigated or mistaken for bugs.
- A pull-request template (`.github/PULL_REQUEST_TEMPLATE.md`) with a checklist
  item that keeps `docs/requirements.md` in sync with code changes.

### Changed
- `nb roles` is now an alias of `nb list` (#71): instead of a bare sorted list of role
  stems, it prints the richest-first index (header + one `name  count  description` row
  per notebook). Use `nb list --json` or the `listRoles` library function for the plain
  sorted stems. (This matches the richer format the kookr `nb` shim already provided.)
- The README now documents the `nb stats` anomaly-tuning environment variables (#8).
- The README now has animated SVG explainers (#13).

### Fixed
- `nb --version` now prints the real package version instead of a placeholder (#9).
- `nb stats --since` now warns about an invalid value (e.g. `--since banana`) instead of silently falling back to the full history (#11).

## [0.1.3] - 2026-10-23

### Fixed
- A fresh `npm run build` now produces an executable `nb`, and the build no longer depends on `@types/node` resolving indirectly.

## 0.1.2 - 2026-10-23

### Changed
- Version bump; no user-facing changes.

## 0.1.1 - 2026-10-23

### Changed
- Releases are now published to npm from CI using short-lived OIDC credentials (npm Trusted Publishing, with provenance) instead of a stored token. No change to the installed package.

### Fixed
- `nb` silently did nothing when run through an npm bin symlink; it now runs normally.

## 0.1.0 - 2026-10-23

### Added
- Initial release: a bounded, voted, plain-text memory for AI agents. Commands: `nb add`, `show`, `vote`, `merge`, `rm`, `stats`. Each role's notebook holds at most 200 lines, each at most 200 characters, and the lowest-scored line is evicted first when full. The library has zero runtime dependencies.

[Unreleased]: https://github.com/jeanibarz/agent-notebook/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jeanibarz/agent-notebook/releases/tag/v0.1.3
