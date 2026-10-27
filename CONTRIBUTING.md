# Contributing to agent-notebook

Thanks for your interest. The whole point of this project is that it stays
small, so the most useful thing you can do before writing code is read the
spec.

## Read the requirements first

The essential features, the design choices, and the rationale behind them are
specified in [docs/requirements.md](docs/requirements.md). **Read it before
proposing a feature.** It is the single source of truth for behavior — this
file does not restate it. In particular:

- The non-goals are binding. Embeddings, semantic search, a server, a network
  call, or multi-line notes are deliberately out of scope, not missing features.
- A PR that adds behavior should make the case for why the bounded / voted /
  one-line model (lessons are capped in number, ranked by votes, and one line
  each) needs it — see DP-1 and the Non-goals, where "DP" is a numbered design
  principle in the requirements doc — not just that it would be nice to have.
  Bug fixes, docs, and test coverage are always welcome.

Keep `docs/requirements.md` in sync with any behavior change — the
[pull-request template](.github/PULL_REQUEST_TEMPLATE.md) has a checklist for
this.

## Build and test

```
npm install
npm run build   # tsc, then chmod +x dist/cli.js
npm test        # vitest run
```

The tests exec the built `dist/` output, so a stale build gives misleading
results — `npm test` runs the build first via its `pretest` hook.

**`npm test` needs Node 20.12 or newer.** Although the package itself runs on
Node ≥ 18 (see `engines` in `package.json`), the test runner (vitest 5) imports
`styleText` from `node:util`, which only exists on Node 20.12+. On Node 18 the
suite cannot start — CI builds on 18 to prove the package still compiles on its
minimum engine, but skips `npm test` there. If `npm test` crashes on import,
check your Node version before anything else.

## Zero runtime dependencies

The published package ships no runtime `dependencies` and uses only the Node.js
standard library (requirements **DP-7**). A PR that adds a runtime dependency
must explain why it is unavoidable; expect it to be declined unless there is
genuinely no alternative.

## Changelog

Add a one-line entry under the `## [Unreleased]` section of
[CHANGELOG.md](CHANGELOG.md) for any user-facing change.
