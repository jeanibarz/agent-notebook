# Claude Code hooks for agent-notebook

These hooks are **optional conveniences**. The required integration is just the
[AGENTS.md / CLAUDE.md contract](../../../AGENTS.md) — once that is in context,
the agent runs `nb list` and opens the notebooks it needs on its own. These two
scripts save it a call and keep the retrospective from being forgotten.

| File | Hook event | What it adds |
|---|---|---|
| `nb-session-start.sh` | `SessionStart` | injects the `nb list` **index** (every notebook + its "open me when…" description) into context, so the agent sees it without a call. No shelf logic — the same script in every project. |
| `nb-retrospective.sh` | `Stop` / `SubagentStop` | once per session, nudges the agent to vote / prune / add on the notebooks it used before finishing. |
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
| `NB_DIR` | `~/.agent-notebook/notebooks` | where notebooks (and retro sentinels) live |
| `NB_SESSION` | — | set it (e.g. to Claude Code's session id) to unlock the per-session [surfacing metrics](../../../README.md#surfacing-metrics) in `nb stats` |
| `NB_BIN` | `nb` | point at the [git-versioning wrapper](../../nb-git-wrapper.mjs) to commit each change |

(There is no `NB_ROLE`: the index hook injects *all* notebooks' descriptions and
the agent chooses — nothing has to guess a per-project shelf.)

## The two moments the hooks don't drive — and why that's fine

- **② "this looks familiar" mid-task.** There is no "the agent is about to start a
  sub-task" event. The session-start index plus the AGENTS.md instruction cover it;
  the agent re-checks `nb list` or `nb search` on its own. A `UserPromptSubmit`
  nudge is possible but usually just noise.
- **③ subagent start.** Claude Code has no `SubagentStart` hook, and none is needed:
  a subagent reads the same contract and runs `nb list` for its own task. See
  [harness-setup › Subagents](../../../docs/harness-setup.md#subagents).

## How the retrospective nudge avoids looping

`nb-retrospective.sh` fires on `Stop`, writes a `.retro-<session_id>` sentinel in
`NB_DIR`, and blocks the stop exactly once with the retrospective checklist as the
reason. On the next stop the sentinel exists (and `stop_hook_active` is set), so it
lets the agent finish. Because `SubagentStop` fires with the *parent* session id,
the first stop in a session — whether a subagent's or the main agent's — claims the
sentinel: **one nudge per whole session**, not one per subagent. Treat it as a
backstop; the reliable driver of each subagent's retrospective is the contract it
was given.
