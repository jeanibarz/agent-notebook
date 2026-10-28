# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/jeanibarz/agent-notebook/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/jeanibarz/agent-notebook/releases/tag/v0.1.3
