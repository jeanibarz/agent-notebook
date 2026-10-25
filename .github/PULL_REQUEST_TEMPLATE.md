<!--
Thanks for contributing! The whole point of agent-notebook is that it stays
small. A PR that adds a feature should make the case for why the
bounded / voted / one-line model needs it — see docs/requirements.md
(Design principles + Non-goals). Bug fixes, docs, and test coverage are
always welcome.
-->

## What & why

<!-- What does this change do, and why? Link any related issue (#123). -->

## Checklist

- [ ] Tests added or updated, and `npm test` passes locally.
- [ ] **Requirements are in sync.** If this PR changes behavior, a default, the CLI
      surface, or a non-goal, `docs/requirements.md` is updated to match (and the
      affected requirement still names the test that proves it). If it changes none
      of those, tick this box to confirm no requirements update is needed.
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (if the change is
      user-visible).
- [ ] `README.md` updated if the usage, commands, or configuration changed.
- [ ] No new runtime dependencies (the package ships zero — see requirements DP-7),
      or the PR explains why one is unavoidable.
- [ ] A new feature is justified against the bounded / voted / one-line model
      (requirements DP-1 and the Non-goals), not just "it would be nice".
