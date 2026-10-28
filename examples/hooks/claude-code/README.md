# Claude Code hooks for agent-notebook

These three files wire the [AGENTS.md contract](../../../AGENTS.md) into Claude
Code so the notebook is used automatically, at the right moments, without you
having to remember.

| File | Hook event | AGENTS.md moment |
|---|---|---|
| `nb-session-start.sh` | `SessionStart` | ① **read** — shows the role's notebook + `nb list` as context before the agent plans. |
| `nb-retrospective.sh` | `Stop` / `SubagentStop` | ④ **retrospective** — once per session, asks the agent to vote / prune / add ≤1 before finishing. |
| `settings.json` | — | the config that registers the two scripts. |

## Install (per project, recommended first)

```sh
# 1. Copy the scripts somewhere stable and make them executable.
mkdir -p ~/.agent-notebook/hooks
cp nb-session-start.sh nb-retrospective.sh ~/.agent-notebook/hooks/
chmod +x ~/.agent-notebook/hooks/*.sh

# 2. Merge the `hooks` block from settings.json into .claude/settings.json,
#    pointing `command` at the copied scripts' ABSOLUTE paths.

# 3. Restart Claude Code (hooks load at startup).
```

For a machine-wide setup, use `~/.claude/settings.json` instead of the
per-project `.claude/settings.json`.

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `NB_ROLE` | the project directory name | which notebook to show / maintain |
| `NB_DIR` | `~/.agent-notebook/notebooks` | where notebooks (and retro sentinels) live |
| `NB_SESSION` | — | set it (e.g. to Claude Code's session id) to unlock the per-session [surfacing metrics](../../../README.md#surfacing-metrics) in `nb stats` |
| `NB_BIN` | `nb` | point at the [git-versioning wrapper](../../nb-git-wrapper.mjs) to commit each change |

## The two moments a hook can't cleanly cover — and what to do

- **② mid-task "this looks familiar".** There is no "the agent is about to start a
  sub-task" event. The session-start injection plus the instruction in AGENTS.md
  ("reach for `nb search` only for a known-item lookup") covers it. If you want a
  nudge on *every* user turn, add a `UserPromptSubmit` hook that echoes a one-line
  reminder — but it is usually noise; prefer the session-start injection.
- **③ subagent start.** Claude Code has no `SubagentStart` hook. Give each
  specialised subagent its own *role* instead: in its agent definition (or the
  prompt you spawn it with) tell it to `nb show <its-role>` first and run the
  retrospective at the end. The `SubagentStop` hook above then drives *its*
  retrospective the same way. See the `notebook-role-reuse` pattern in the
  [harness guide](../../../docs/harness-setup.md#subagents).

## How the retrospective gate avoids looping

`nb-retrospective.sh` fires on `Stop`, writes a `.retro-<session_id>` sentinel in
`NB_DIR`, and blocks the stop exactly once with the retrospective checklist as the
reason. On the next stop the sentinel exists (and `stop_hook_active` is set), so it
lets the agent finish. One retrospective per session, no loop.
