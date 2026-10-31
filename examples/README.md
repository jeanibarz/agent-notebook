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
| [`nb-janitor.mjs`](nb-janitor.mjs) | read-only diagnostics: near-duplicate lessons and near-duplicate shelf names, lessons lost to eviction, growth trends, shelf co-access (which shelves are shown together) | Node (git optional) |
| [`hooks/claude-code/`](hooks/claude-code/) | optional hooks: inject the `nb list` index at session start + nudge the retrospective once per session | Claude Code |
| [`hooks/codex-cli/`](hooks/codex-cli/) | the AGENTS.md contract + PATH wrapper for Codex CLI | Codex CLI |

Full, OS-by-OS wiring instructions are in the
**[harness setup guide](../docs/harness-setup.md)**. For a company rollout with
security or data-sovereignty constraints, see the
**[enterprise guide](../docs/enterprise.md)**.

These scripts are examples to adapt, not a published API — they are intentionally
short and commented so you can read and modify them. Each is standalone.
