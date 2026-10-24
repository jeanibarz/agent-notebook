# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

### Added
- This changelog.

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
