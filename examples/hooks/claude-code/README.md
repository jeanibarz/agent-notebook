# Claude Code hooks for agent-notebook

These hooks are **optional conveniences**. The required integration is just the
[AGENTS.md / CLAUDE.md contract](https://github.com/jeanibarz/agent-notebook/blob/main/AGENTS.md) — once that is in context,
the agent runs `nb list` and opens the notebooks it needs on its own. These
scripts save it a call and keep the retrospective from being forgotten. They are
built for a short, single-agent session: read
[what the hooks do not cover](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#what-the-hooks-do-not-cover)
before relying on them in long sessions or with subagents.

| File | Hook event | What it adds |
|---|---|---|
| `nb-session-start.sh` | `SessionStart` | injects the `nb list` **index** (every notebook + its "open me when…" description) into context, so the agent sees it without a call. It never picks a notebook for the agent, so it is the same script in every project. An opt-in [layered variant](#optional-layered-index-project--domain--global) groups the index by project / domain / global. |
| `nb-subagent-start.sh` | `SubagentStart` | hands the same index to each **subagent**, which never sees the `SessionStart` one. See [below](#give-subagents-the-index-subagentstart) for when to prefer a line in the brief. |
| `nb-retrospective.sh` | `Stop` | once per session, at the lead agent's first stop with no subagent still running, nudges it to vote / prune / add on the notebooks it used. It never nudges a subagent. |
| `settings.json` | — | the config that registers the three scripts. |

## Install (per project, recommended first)

```sh
# 1. Copy the scripts somewhere stable and make them executable. They ship in
#    the npm package, so this works from any directory:
mkdir -p ~/.agent-notebook/hooks
cp "$(npm root -g)/agent-notebook/examples/hooks/claude-code/"nb-*.sh ~/.agent-notebook/hooks/
chmod +x ~/.agent-notebook/hooks/*.sh

# 2. Print the hooks block from settings.json with the `//` comment keys
#    dropped and your full paths filled in, then merge its `hooks` block into
#    .claude/settings.json:
sed -e '/^  "\/\//d' -e "s|/ABSOLUTE/PATH/examples/hooks/claude-code|$HOME/.agent-notebook/hooks|" "$(npm root -g)/agent-notebook/examples/hooks/claude-code/settings.json"

# 3. Restart Claude Code (hooks load at startup).
```

For a machine-wide setup, use `~/.claude/settings.json` instead of the
per-project `.claude/settings.json`.

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `NB_DIR` | `~/.agent-notebook/notebooks` | where notebooks (and retro sentinels) live |
| `NB_RETRO_TTL_DAYS` | `7` | how many days a `.retro-<session>` sentinel survives before `nb-retrospective.sh` prunes it (see [below](#how-the-retrospective-nudge-avoids-looping)) |
| `NB_SESSION` | — | set it (e.g. to Claude Code's session id) to unlock the per-session [surfacing metrics](https://github.com/jeanibarz/agent-notebook/blob/main/docs/operating.md#surfacing-metrics) in `nb stats` |
| `NB_BIN` | `nb` | point at the [git-versioning wrapper](../../nb-git-wrapper.mjs) to commit each change |
| `NB_PROJECT_SLUG` | unset | opt in to the [layered index](#optional-layered-index-project--domain--global): the repo's slug, e.g. `acme-app`. Unset keeps the flat index. Read by `nb-session-start.sh` and `nb brief` for the index, and by `nb retro` for `{project}` |
| `NB_GLOBAL_SHELF` | `global` | with `NB_PROJECT_SLUG`: the one bare shelf shown as the global layer |
| `NB_ENABLED` | unset | `0`/`false`/`no`/`off` switches the hooks (and the text `nb list` index) off for this process, over `git config nb.enabled`; see [per-repository on/off](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#per-repository-onoff) |
| `NB_RETRO_EXTRA_PROMPT` | unset | absolute path (a leading `~/` is expanded) of a text file that `nb-retrospective.sh` appends to its nudge, with `{project}` and `{session}` filled in; see [below](#optional-extra-prompt-for-the-retrospective-nudge) |

The session-start and retrospective hooks first run `nb enabled` (from
`CLAUDE_PROJECT_DIR`, else the working directory); the subagent hook inherits the
answer through `nb-session-start.sh`. When it prints `off` — set with `git config nb.enabled false` in a
repository, or `--global` for all of them — the session-start hook prints one
line telling the agent to skip the notebook steps instead of the index, and the
retrospective hook lets the stop through. The retrospective hook also asks from
the `cwd` Claude Code passes in the hook payload, when that is another directory,
and lets the stop through if either answer is `off`: the agent's own `nb list` ran
there and may already have told it to skip the retrospective. An `off` from the
payload `cwd` alone does not use up the session's one nudge, so a later stop back
in an on directory still asks for the retrospective. Any other answer,
including an older `nb` that lacks the subcommand, keeps them on.

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
[docs/memory-layers.md](https://github.com/jeanibarz/agent-notebook/blob/main/docs/memory-layers.md). The variant is a block
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

## Optional: extra prompt for the retrospective nudge

Set `NB_RETRO_EXTRA_PROMPT` to the absolute path of a text file and
`nb-retrospective.sh` appends its contents to the block reason, after the lessons
retrospective and a blank line. Same single nudge, same sentinel: no second hook.
`examples/hooks/ideas-end-prompt.txt` is one such file (an end-of-task check that
records at most one improvement idea with `nb-ideas add`). Put the variable in the
`env` block of your `settings.json`, never in a notebooks folder.

The file may use two placeholders:

- `{session}`: the payload `session_id`, cleaned like the sentinel name.
- `{project}`: `NB_PROJECT_SLUG` when set; otherwise the name of the folder that holds
  the repository's `.git` (from `git rev-parse --git-common-dir`, run in the payload
  `cwd`), so a main checkout and its worktrees give the same name. It is lower-cased,
  characters outside `a-z0-9._-` become `-`, and the ends are trimmed to a letter or
  digit. Two repositories with the same folder name share a name: set
  `NB_PROJECT_SLUG` per project (not in user-level settings) to tell them apart.

The file is read before the sentinel is claimed. A missing, unreadable or relative
path prints one warning on stderr and the lessons retrospective is sent alone. When
there is no `session_id`, or no usable project name (not a git directory, git
missing), the extra text is left out and the lessons nudge is sent alone.

## How the retrospective nudge avoids looping

`nb-retrospective.sh` fires on `Stop`, writes a `.retro-<session_id>` sentinel in
`NB_DIR`, and blocks the stop exactly once with the retrospective checklist as the
reason. On the next stop the sentinel exists (and `stop_hook_active` is set), so it
lets the agent finish: **one nudge per whole session**. Two kinds of stop are let
through without writing the sentinel, so they never use up that nudge:

- **A lead that is waiting for subagents.** When the `Stop` payload's
  `background_tasks` lists delegated work that is still `running` or `pending`
  (a task of type `subagent`, `workflow`, `teammate` or `cloud session`), the
  lead has stopped to wait for it, not because the task is done. The hook lets
  that stop through and keeps the nudge for a later stop with nothing delegated
  in flight, typically after the delegated work has come back. Shells, monitors
  and other background tasks do not count. A Claude Code that sends no
  `background_tasks` nudges the lead's first stop, even one where it is waiting
  for subagents.
- **A subagent.** The hook never nudges on `SubagentStop`, so it is registered
  under `Stop` only in the example `settings.json`; an older config that still
  registers it under `SubagentStop` is harmless, as the script exits at once
  there. It recognises a subagent's stop by `hook_event_name` or by a non-empty
  `agent_id`. There are three reasons. `SubagentStop` fires with the *parent*
  session id, so a subagent that stopped first used to take the session's only
  nudge and leave the lead without one. And blocking `SubagentStop` makes the
  subagent continue: its answer to the nudge becomes its last message, which is
  all the lead receives as its result, so the report it had written could come
  back shortened or replaced. `SubagentStop` also fires for Claude Code's
  internal agents, where nobody would read a nudge. A subagent gets the
  retrospective from its brief instead (see
  [subagents](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#subagents)).

The reason text still asks a subagent to repeat its full final report after the
retrospective, in case another harness passes it a subagent's stop.

Two limits remain:

- **The nudge still marks one stop, not the end of the task.** In an interactive
  session the lead's first stop with no subagent running is the end of its first
  reply, and a lead that starts new subagents after the nudge gets no second one.
  Treat the hook as a backstop: the reliable driver of the retrospective is
  moment ④ in the contract.
- **A subagent that never returns keeps the nudge back.** While a subagent is
  listed as `running`, every stop of the lead is let through.

[What the hooks do not cover](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#what-the-hooks-do-not-cover)
lists the gaps and what to do about each.

Nothing used to remove those `.retro-<session>` files, so on a busy machine they
piled up unbounded — invisible to `nb list` (dotfiles are filtered) but real
clutter in backups, a git-tracked `NB_DIR`, and directory scans. To bound the
pile, the hook prunes after claiming each session's sentinel: it sweeps `NB_DIR`
and unlinks every `.retro-*` entry whose mtime is older than `NB_RETRO_TTL_DAYS`
(default **7**). The whole sweep is best-effort and wrapped in `try/catch`, so a
failed `readdir`/`stat`/`unlink` never blocks the stop. Keep the TTL comfortably
above your longest plausible session so an in-flight sentinel is never reaped
early; the session's own sentinel is just-written and so never a prune candidate.
