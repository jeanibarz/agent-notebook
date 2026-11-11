# Claude Code hooks for agent-notebook

These hooks are **optional conveniences**. The required integration is just the
[AGENTS.md / CLAUDE.md contract](../../../AGENTS.md) — once that is in context,
the agent runs `nb list` and opens the notebooks it needs on its own. These two
scripts save it a call and keep the retrospective from being forgotten.

| File | Hook event | What it adds |
|---|---|---|
| `nb-session-start.sh` | `SessionStart` | injects the `nb list` **index** (every notebook + its "open me when…" description) into context, so the agent sees it without a call. It never picks a notebook for the agent, so it is the same script in every project. An opt-in [layered variant](#optional-layered-index-project--domain--global) groups the index by project / domain / global. |
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
| `NB_RETRO_TTL_DAYS` | `7` | how many days a `.retro-<session>` sentinel survives before `nb-retrospective.sh` prunes it (see [below](#how-the-retrospective-nudge-avoids-looping)) |
| `NB_SESSION` | — | set it (e.g. to Claude Code's session id) to unlock the per-session [surfacing metrics](../../../README.md#surfacing-metrics) in `nb stats` |
| `NB_BIN` | `nb` | point at the [git-versioning wrapper](../../nb-git-wrapper.mjs) to commit each change |
| `NB_PROJECT_SLUG` | unset | opt in to the [layered index](#optional-layered-index-project--domain--global): the repo's slug, e.g. `acme-app`. Unset keeps the flat index. Read by `nb-session-start.sh` only; `nb` itself never reads it |
| `NB_GLOBAL_SHELF` | `global` | with `NB_PROJECT_SLUG`: the one bare shelf shown as the global layer |

(There is no `NB_ROLE`: the index hook injects *all* notebooks' descriptions and
the agent chooses — nothing has to guess which notebook this project uses.)

## Optional: layered index (project > domain > global)

If your harness runs agents across several repos, the flat index shows every
repo's `shelf@project` notebooks to every agent. Setting `NB_PROJECT_SLUG` in the
environment that launches Claude Code switches `nb-session-start.sh` to a grouped
index: this project's shelves first (names ending in `@<slug>`, where the slug
is a short repo id such as `acme-app`), then the bare domain shelves, then the
one global shelf (`global`, or the name in `NB_GLOBAL_SHELF`), plus a line saying how many other
projects' shelves it left out. The hook still never opens a shelf for the agent,
and `nb list` still shows everything.

This is a **naming convention**, not an `nb` feature: `nb` treats `@` as part of
an opaque shelf name, and nothing about a layer is stored in a shelf file. The
convention, its placement rule and its limits are in
[docs/memory-layers.md](../../../docs/memory-layers.md). The variant is a block
in the script that does nothing unless the variable is set, falls back to the
flat index (with a warning) if `nb list --json` fails, and needs only `bash` and
`node`, so it also runs under macOS's bash 3.2.

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

Nothing used to remove those `.retro-<session>` files, so on a busy machine they
piled up unbounded — invisible to `nb list` (dotfiles are filtered) but real
clutter in backups, a git-tracked `NB_DIR`, and directory scans. To bound the
pile, the hook prunes after claiming each session's sentinel: it sweeps `NB_DIR`
and unlinks every `.retro-*` entry whose mtime is older than `NB_RETRO_TTL_DAYS`
(default **7**). The whole sweep is best-effort and wrapped in `try/catch`, so a
failed `readdir`/`stat`/`unlink` never blocks the stop. Keep the TTL comfortably
above your longest plausible session so an in-flight sentinel is never reaped
early; the session's own sentinel is just-written and so never a prune candidate.
