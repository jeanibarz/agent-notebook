# Examples — the harness layer around `agent-notebook`

The `agent-notebook` package is deliberately a dumb, offline file editor: it
never touches git, never phones home, never runs anything clever inside an `nb`
call ([DP-6](../docs/requirements.md#dp-6)). Everything that makes it feel like a
*system* — a one-line instruction, optional convenience hooks, per-change history, off-machine backup, trend
diagnostics — lives *around* the package, as the optional, copy-pasteable pieces
in this directory. Use the ones you want; skip the rest.

| File | What it adds | Depends on |
|---|---|---|
| [`nb-git-wrapper.mjs`](nb-git-wrapper.mjs) | a git commit per notebook change (reviewable, revertible memory) | Node, git |
| [`nb-backup.sh`](nb-backup.sh) | daily push of that history to a remote | bash, git |
| [`nb-janitor.mjs`](nb-janitor.mjs) | read-only diagnostics: near-duplicate lessons and near-duplicate shelf names (including the same base under two `@project` slugs), the same lesson held by several project shelves, lessons lost to eviction, growth trends, shelf co-access (which shelves are shown together) | Node (git optional) |
| [`hooks/claude-code/`](hooks/claude-code/) | optional hooks: inject the `nb list` index at session start + nudge the retrospective once per session | Claude Code |
| [`hooks/codex-cli/`](hooks/codex-cli/) | the AGENTS.md contract + PATH wrapper for Codex CLI | Codex CLI |
| [`completion/`](completion/) | tab-completion scripts for bash & zsh, as emitted by `nb completion <bash\|zsh>` (source them, or install into your completion dir) | bash or zsh |

Full, OS-by-OS wiring instructions are in the
**[harness setup guide](../docs/harness-setup.md)**. For a company rollout with
security or data-sovereignty constraints, see the
**[enterprise guide](../docs/enterprise.md)**.

These scripts are examples to adapt, not a published API — they are intentionally
short and commented so you can read and modify them. Each is standalone.

## Environment knobs

Each script reads the environment variable(s) it needs; the knob is documented
where the script that reads it lives. A CI drift guard
(`src/env-docs.test.ts`) fails the build if a shipped example script reads an
`NB_*` variable that no shipped doc mentions, so a new knob can't ship
undocumented (issue #207, extending the `src/*.ts` guard of #164).

| Var | Default | Read by | Purpose |
|---|---|---|---|
| `NB_DIR` | `~/.agent-notebook/notebooks` | all | the notebooks (and backup/history) directory |
| `NB_BACKUP_PUSH_TIMEOUT` | `300` (seconds) | [`nb-backup.sh`](nb-backup.sh) | caps the `git push` (any `timeout` duration, e.g. `5m`; `0` disables) so a hung credential/askpass prompt can't hold the single-instance lock forever and wedge later runs — needs `timeout` (GNU/coreutils) |
| `NB_BACKUP_GIT_LOCK_WAIT` | `12` (seconds) | [`nb-backup.sh`](nb-backup.sh) | how long the straggler commit waits for the git-wrapper's `.nb-git.lock` before skipping the commit this run (a lock older than 30 s is treated as a crashed holder's and reclaimed) |
| `NB_GIT_AUTOCOMMIT` | `1` (on) | [`nb-git-wrapper.mjs`](nb-git-wrapper.mjs) | set to `0` to skip the auto-commit for a single `nb` call (e.g. a scripted bulk edit you'll commit yourself) |
| `NB_MAX_LINES` | `50` | [`nb-janitor.mjs`](nb-janitor.mjs) | the per-shelf line cap the diagnostics report against (mirrors the package's own [`NB_MAX_LINES`](../README.md#other-environment-variables)) |
| `NB_SESSION` | — | [`nb-janitor.mjs`](nb-janitor.mjs) | the session id that unlocks per-session [surfacing metrics](../README.md#surfacing-metrics) |

The `hooks/claude-code/` scripts (`NB_BIN`, `NB_RETRO_TTL_DAYS`, `NB_SESSION`)
are documented in their own [README](hooks/claude-code/README.md#configuration-environment).

## Status of these examples

- **Claude Code is the primary target** — the [`hooks/claude-code/`](hooks/claude-code/)
  example is written against it. The [Codex CLI](hooks/codex-cli/) pieces and any
  other harness are a lighter-touch starting point: adapt and **test them in your
  own setup** before relying on them. They are reference integrations, not a
  certified, supported matrix.
- **There is no MCP server.** `nb` is a plain, offline CLI; integrate it through
  the hooks or the [AGENTS.md / CLAUDE.md contract](../AGENTS.md) above, not an
  MCP endpoint.
