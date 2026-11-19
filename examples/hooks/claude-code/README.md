# Claude Code hooks for agent-notebook

These hooks are **optional conveniences**. The required integration is just the
[AGENTS.md / CLAUDE.md contract](../../../AGENTS.md) — once that is in context,
the agent runs `nb list` and opens the notebooks it needs on its own. These
scripts save it a call and keep the retrospective from being forgotten. They are
built for a short, single-agent session: read
[what the hooks do not cover](../../../docs/harness-setup.md#what-the-hooks-do-not-cover)
before relying on them in long sessions or with subagents.

| File | Hook event | What it adds |
|---|---|---|
| `nb-session-start.sh` | `SessionStart` | injects the `nb list` **index** (every notebook + its "open me when…" description) into context, so the agent sees it without a call. It never picks a notebook for the agent, so it is the same script in every project. An opt-in [layered variant](#optional-layered-index-project--domain--global) groups the index by project / domain / global. |
| `nb-subagent-start.sh` | `SubagentStart` | hands the same index to each **subagent**, which never sees the `SessionStart` one. See [below](#give-subagents-the-index-subagentstart) for when to prefer a line in the brief. |
| `nb-retrospective.sh` | `Stop` / `SubagentStop` | once per session, at the session's first stop, nudges the agent to vote / prune / add on the notebooks it used. |
| `settings.json` | — | the config that registers the three scripts. |

## Install (per project, recommended first)

```sh
# 1. Copy the scripts somewhere stable and make them executable.
mkdir -p ~/.agent-notebook/hooks
cp nb-session-start.sh nb-subagent-start.sh nb-retrospective.sh ~/.agent-notebook/hooks/
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
| `NB_ENABLED` | unset | `0`/`false`/`no`/`off` switches both hooks (and the text `nb list` index) off for this process, over `git config nb.enabled`; see [per-repository on/off](../../../README.md#turn-it-on-or-off-per-repository) |

Both hooks first run `nb enabled` (from `CLAUDE_PROJECT_DIR`, else the working
directory). When it prints `off` — set with `git config nb.enabled false` in a
repository, or `--global` for all of them — the session-start hook prints one
line telling the agent to skip the notebook steps instead of the index, and the
retrospective hook lets the stop through. Any other answer, including an older
`nb` that lacks the subcommand, keeps them on.

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

## The moment the hooks don't drive — and why that's fine

- **② "this looks familiar" mid-task.** There is no "the agent is about to start a
  sub-task" event. The session-start index plus the AGENTS.md instruction cover it;
  the agent re-checks `nb list` or `nb search` on its own. A `UserPromptSubmit`
  nudge is possible but usually just noise.

## Give subagents the index (`SubagentStart`)

Moment ③ needs help. `SessionStart` runs for the main session only, so a subagent
starts from its brief and never sees the index. Unless the lead agent writes the
contract into each brief, the subagent does not know the notebooks exist. Two
ways to close the gap:

| | A line in every brief | The `SubagentStart` hook |
|---|---|---|
| How | the lead's standing instruction says: brief each subagent to run `nb list`, open what fits, and run the retrospective before its final report | register `nb-subagent-start.sh` under `SubagentStart` (the example `settings.json` does) |
| Cost per subagent | one sentence, plus the `nb list` call the subagent makes | the whole index in its context, whether its job needs it or not |
| Fails when | the lead forgets the line | the index is long and subagents are many |

`nb-subagent-start.sh` runs `nb-session-start.sh` (keep the two files together)
and wraps its output as `hookSpecificOutput.additionalContext`. The wrapper is
needed because a `SubagentStart` hook's **plain stdout is not added to the
subagent's context**: registering `nb-session-start.sh` itself under
`SubagentStart` runs it, injects nothing and reports no error (checked on Claude
Code 2.1.328). To confirm the hook reaches a subagent, look in its transcript
for a `hook_additional_context` record from `SubagentStart`:

```sh
cd ~/.claude/projects/<project-dir>/<session-id>/subagents
for f in agent-*.jsonl; do
  printf '%s ' "$f"; grep '"hook_additional_context"' "$f" | grep -c '"SubagentStart"'
done            # 1 = the index was injected; 0 = the hook ran without effect, or did not run
```

The index gives a subagent the notebooks to read. It does not make the
retrospective happen at the subagent's end: see the next section.

## How the retrospective nudge avoids looping

`nb-retrospective.sh` fires on `Stop`, writes a `.retro-<session_id>` sentinel in
`NB_DIR`, and blocks the stop exactly once with the retrospective checklist as the
reason. On the next stop the sentinel exists (and `stop_hook_active` is set), so it
lets the agent finish. Because `SubagentStop` fires with the *parent* session id,
the first stop in a session — whether a subagent's or the main agent's — claims the
sentinel: **one nudge per whole session**, not one per subagent. Treat it as a
backstop; the reliable driver of each subagent's retrospective is the contract it
was given.

Two consequences are easy to miss, because neither produces an error:

- **The nudge is spent at the first stop, not at the end of the task.** A lead
  that starts background subagents stops for the first time when it begins
  waiting for them. That stop takes the nudge. Later stops, including the real
  end of the task, get none.
- **A nudged subagent's report can be displaced.** Blocking `SubagentStop` makes
  the subagent continue, and its answer to the nudge becomes the last message,
  which is what the lead receives as the subagent's result. If your subagents get
  the contract from their brief, remove the `SubagentStop` entry from
  `settings.json` so the nudge always goes to the lead.

[What the hooks do not cover](../../../docs/harness-setup.md#what-the-hooks-do-not-cover)
lists all four gaps and what to do about each.

Nothing used to remove those `.retro-<session>` files, so on a busy machine they
piled up unbounded — invisible to `nb list` (dotfiles are filtered) but real
clutter in backups, a git-tracked `NB_DIR`, and directory scans. To bound the
pile, the hook prunes after claiming each session's sentinel: it sweeps `NB_DIR`
and unlinks every `.retro-*` entry whose mtime is older than `NB_RETRO_TTL_DAYS`
(default **7**). The whole sweep is best-effort and wrapped in `try/catch`, so a
failed `readdir`/`stat`/`unlink` never blocks the stop. Keep the TTL comfortably
above your longest plausible session so an in-flight sentinel is never reaped
early; the session's own sentinel is just-written and so never a prune candidate.
