# Releasing agent-notebook

This page is for the person who cuts a release and for the owner who sets up the repository
once. A release publishes the npm package and attaches the Claude Code plugin's zip to a
GitHub release, in one workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml).
The requirement is [NFR-REL-001](requirements.md#nfr-rel-001).

## The order of a release

1. **The release pull request.** It bumps `version` in `package.json` and `package-lock.json`
   (both fields of the lock), and moves the notes from `[Unreleased]` to a dated
   `## [X.Y.Z]` section of `CHANGELOG.md`. `node scripts/check-release.mjs --pr` runs on every
   pull request, so a version that disagrees with itself is caught when it is merged.
2. **The tag.** After the pull request is merged, push the tag `vX.Y.Z` (or `vX.Y.Z-beta.1` for a
   prerelease) on the merge commit. The tag starts the workflow. It must equal `v` plus the
   version in `package.json`; no other ref can release.
3. **The jobs**, in this order:
   1. `verify`: the full test matrix (Node 18 to 24, Linux and macOS) on the tagged commit.
   2. `build-plugin`: builds `dist/`, the plugin zip and its checksums, and runs
      `scripts/check-release.mjs` on the zip, and checks that the CHANGELOG has a section for the version.
      Nothing is public yet: a failure here costs nothing.
   3. `publish`: the tag guard, then `npm publish` with provenance, through npm Trusted Publishing.
   4. `github-release`: checks the zip against what npm now holds and against the tagged commit,
      rebuilds `SHA256SUMS` from the unpacked zip and compares it byte for byte, writes the release
      notes itself (the sha256 values it verified, then the CHANGELOG section read at the tagged
      commit), then creates the GitHub release with the zip, `<zip>.sha256` and `SHA256SUMS`.
4. **The marketplace pull request.** The release does not touch the marketplace entry. Someone
   opens a pull request that points `marketplace.json` at the new zip and its sha256, and **a
   person merges it**. Until then no plugin user receives the version.
   The `marketplace-check` workflow runs on that pull request and on no other: it runs
   `scripts/check-marketplace.mjs` (the file's shape, the release, the zip's sha256 and versions, the
   version against `main`'s), rebuilds the tag and compares the sha256, and installs the real zip on
   Linux, macOS and Windows. A version lower than `main`'s needs the `Rollback:` line (below). Editing
   the pull request's description runs the check again.
   The check runs the pull request's own copy of its scripts and of the workflow. So a pull request that
   also changes `scripts/check-marketplace.mjs`, `scripts/build-plugin.mjs`, `scripts/plugin-e2e/` or the
   workflow is out of process and must be split. The workflow fails such a pull request, but only an
   honest one: the pull request could delete that step. The real control is the person who merges,
   reading the file list, plus a ruleset or CODEOWNERS on those paths.

## What each job holds

| Job | Token | Repository code | Notes |
|---|---|---|---|
| `verify` | `contents: read` | yes | |
| `build-plugin` | `contents: read` | yes, `npm ci --ignore-scripts` | checkout without credentials; uploads the artifact `plugin-zip` |
| `publish` | `contents: read`, `id-token: write` | yes | environment `release`; the file name and the environment are what npm Trusted Publishing keys on: do not rename either |
| `github-release` | `contents: write` and nothing else | none: no checkout, no Node.js setup, no npm | environment `release`; every value reaches a script through `env:` |

The top of the file says `permissions: {}`, so a new job holds nothing until it asks.
No job holds both `id-token: write` and `contents: write`.

## When a job fails: the re-run rule

- **Before `publish`** (`verify` or `build-plugin`): nothing is public. Fix the problem on `main` and
  cut the next version. A tag is never moved or deleted and re-pushed.
- **After `publish`** (the npm package is out and `github-release` failed): re-run the failed workflow
  run. `publish` sees that npm already has the version and skips itself, with a notice. The build is
  reproducible, so `build-plugin` makes the same zip again and `github-release` continues.
- **A draft release** left by an earlier run is deleted and created again (the tag is kept).
- **A published release that holds this exact zip** is left alone, and the run succeeds.
- **A published release without this exact zip** fails the run with the message "a released archive is
  never replaced or added later; cut a new version". The job never replaces or adds an asset: with
  immutable releases the tag and the assets are fixed once published.

## Rollback

A bad plugin version is not deleted; the marketplace is pointed at an older one.

1. Open a marketplace pull request that points the entry back at the last good zip and its sha256.
   A lower version installs on `claude plugin update` (measured), so users move back. State the reason
   in the pull request body on a line that starts with `Rollback:`.
2. Roll forward with a new version number, with the fix. **Never reuse a version**: npm, the GitHub release
   and users' caches all treat a number as final.
3. For the npm package, `npm deprecate agent-notebook@X.Y.Z "<why, and which version to use>"`.

## The owner's checklist (once, in the repository settings)

The `github-release` job can write to the repository, so these settings decide how much damage a
compromised step could do. The job prints a warning when no ruleset applies to `main` (the job token cannot read classic
branch protection, so only rulesets are detected); it does not refuse.

- [ ] **A ruleset on `main`**: a pull request is required, and the list of actors who may bypass it is
  empty, in particular **not GitHub Actions** and not the repository admin role.
- [ ] **A ruleset on tags `v*`**: only the owner can create them; nobody can move or delete one
  (no "update" and no "deletion").
- [ ] **Immutable releases** switched on (Settings, General): a published release's assets and tag cannot change.
- [ ] **The `release` environment** has a required reviewer, and deployment is limited to tags matching `v*`.

## What a compromised step could now do

Before this change every job's token could only read the repository, and `publish` also held
`id-token: write` for npm. A step of `github-release`, that is the pinned `download-artifact`
action, the `gh` command or the runner image, runs with `contents: write`. It could:

- push to `main` if `main` has no ruleset (it has none today), including a `marketplace.json` that
  names an attacker's zip and its sha256, which would reach every plugin user at their next update;
- push any file outside `.github/workflows/` to `main` (scripts, `src/`, the `scripts` of
  `package.json`, test configuration); `marketplace.json` above is one example. The next tag's
  `publish` job runs that code with `id-token: write`, so it could lead to a malicious npm release
  with provenance. This is the largest effect, and only a ruleset on `main` stops it;
- send a `repository_dispatch` event (no workflow listens for one today);
- create, move or delete tags;
- create, edit or delete releases and their assets.

It could not change `.github/workflows/` (that needs a `workflows` permission the token never has),
publish to npm (the job has no `id-token`), or start other workflows with its own push (events
caused by the workflow token do not trigger workflows).

The job holds no repository code, runs only values it validated, and compares the zip with the
published npm package and the tagged commit before it writes anything, so a compromise would
need to be in the pinned action, `gh` or the runner image themselves. The checklist above
narrows the rest: with a ruleset on `main` and the tag ruleset, a push to `main` or a moved tag is
refused even for this token. Any holder of a push token can still edit `marketplace.json` on an
unprotected `main`, which is why the pull-request rule matters most.
