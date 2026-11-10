<!--
Thanks for contributing! The whole point of agent-notebook is that it stays
small. A PR that adds a feature should make the case for why the
bounded / voted / one-line model needs it — see docs/requirements.md
(Design principles + Non-goals). Bug fixes, docs, and test coverage are
always welcome.

Checklist rows carrying a kookr:check marker are machine-checked (kookr
pr-checklist) against the actual diff. A CHECKED box is an assertion that the
evidence is present in this PR; a STRUCK box with a one-line reason is an
explicit waiver, written as: - [ ] ~~<marker> row text~~ — reason; a blank
marked box fails. Build the PR body from this template and pass it with
`gh pr create --body-file` (or a quoted heredoc); inline `--body` skips the
template. Keep the markers verbatim.
-->

## What & why

<!-- What does this change do, and why? Link any related issue (#123). -->

## Checklist

- [ ] <!-- kookr:check:tests --> Tests added or updated, and `npm test` passes locally.
- [ ] <!-- kookr:check:requirements-sync --> **Requirements are in sync.** If this PR changes behavior, a default, the CLI
      surface, or a non-goal, `docs/requirements.md` is updated to match (and the
      affected requirement still names the test that proves it). If it changes none
      of those, tick this box to confirm no requirements update is needed.
- [ ] <!-- kookr:check:changelog --> `CHANGELOG.md` has an entry under `## [Unreleased]` (if the change is
      user-visible).
- [ ] <!-- kookr:check:readme --> `README.md` updated if the usage, commands, or configuration changed.
- [ ] <!-- kookr:check:no-new-deps --> No new runtime dependencies (the package ships zero — see requirements DP-7),
      or the PR explains why one is unavoidable.
- [ ] <!-- kookr:check:feature-justified --> A new feature is justified against the bounded / voted / one-line model
      (requirements DP-1 and the Non-goals), not just "it would be nice".
