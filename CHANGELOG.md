# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

### Added
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
