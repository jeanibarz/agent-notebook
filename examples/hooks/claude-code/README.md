# Claude Code hooks for agent-notebook

These hooks are **optional conveniences**. The required integration is just the
[AGENTS.md / CLAUDE.md contract](https://github.com/jeanibarz/agent-notebook/blob/main/AGENTS.md) — once that is in context,
the agent runs `nb list` and opens the notebooks it needs on its own. These
hooks save it a call and keep the retrospective from being forgotten. They are
built for a short, single-agent session: read
[what the hooks do not cover](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#what-the-hooks-do-not-cover)
before relying on them in long sessions or with subagents.

| File | Hook event | What it adds |
|---|---|---|
| `nb-claude-hook.mjs` | all three | the adapter: it reads Claude Code's hook payload, decides which stops must not nudge, runs `nb brief` or `nb retro`, and wraps their output in Claude Code's reply format. The words the agent reads come from `nb`, not from this file. |
| `nb-session-start.sh` | `SessionStart` | injects `nb brief`: the instruction lines and the notebook **index** (every notebook + its "open me when…" description), so the agent sees it without a call. It never picks a notebook for the agent, so it is the same hook in every project. An opt-in [layered variant](#optional-layered-index-project--domain--global) groups the index by project / domain / global. |
| `nb-subagent-start.sh` | `SubagentStart` | hands the same index to each **subagent**, which never sees the `SessionStart` one. See [below](#give-subagents-the-index-subagentstart) for when to prefer a line in the brief. |
| `nb-retrospective.sh` | `Stop` | once per session, at the lead agent's first stop with no subagent still running, sends `nb retro`: a nudge to vote / prune / add on the notebooks it used. It never nudges a subagent. |
| `nb-hook-entry.cjs` | all three | what the Claude Code plugin's hooks run first (issue #559): with a Node.js older than 18 it tells the assistant, at session start, to install Node.js 18 or later; otherwise it runs `nb-claude-hook.mjs` unchanged. Written in old JavaScript so that an old Node.js can still read it. You can register it in place of the adapter (`node nb-hook-entry.cjs <event>`); add `--managed` in an administrator's managed settings to make it ignore `NB_BIN`. |
| `settings.json` | — | the config that registers the three scripts. |

Each `.sh` file is a short `sh` script that runs `node nb-claude-hook.mjs <event>`
from its own folder, so keep the four files together. They keep the 0.12 file names,
so a `settings.json` that names them needs no change.

## Install (per project, recommended first)

```sh
# 1. Print a hooks block that runs the adapter from the installed package. It
#    needs no copy and no bash, and an `npm i -g agent-notebook` updates it:
node "$(npm root -g)/agent-notebook/examples/hooks/claude-code/nb-claude-hook.mjs" print-settings

# 2. Merge its `hooks` block into .claude/settings.json.

# 3. Restart Claude Code (hooks load at startup).
```

The block names `node` and the adapter's full path, with no shell in between, so
it also works on native Windows and in a folder whose name has a space.

To keep copies of the scripts instead, copy all four files together, then print
the example `settings.json` with your path filled in:

```sh
mkdir -p ~/.agent-notebook/hooks
cp "$(npm root -g)/agent-notebook/examples/hooks/claude-code/"nb-*.sh "$(npm root -g)/agent-notebook/examples/hooks/claude-code/nb-claude-hook.mjs" ~/.agent-notebook/hooks/
chmod +x ~/.agent-notebook/hooks/*.sh
sed -e '/^  "\/\//d' -e "s|/ABSOLUTE/PATH/examples/hooks/claude-code|$HOME/.agent-notebook/hooks|" "$(npm root -g)/agent-notebook/examples/hooks/claude-code/settings.json"
```

A copied adapter runs `NB_BIN`, else the `nb` on your `PATH`; the adapter inside the
installed package runs that package's own `nb`.

### Upgrading from 0.12 copies

The 0.12 scripts held the instruction text themselves. Copy the four files again (or
switch to `print-settings`); your `settings.json` can stay as it is. Until you do, the
old copies keep working with this `nb`. An old Stop script and the new hook share the
same `.retro-<session>` file, so a session is still nudged once between them.

**The project name changes with the new hooks (issue #540).** Without `NB_PROJECT_SLUG`,
the new hooks name a repository with an `origin` remote after the remote (`owner-repo`,
as `nb project` prints it), where the 0.12 scripts used its folder name. This starts at the
first session after you upgrade `nb`, for hooks that run `nb brief` and `nb retro` (the
adapter, or `print-settings`); old copied scripts keep the folder name until you copy them
again, so two machines on different setups can write to two names. Two things follow:

- The `{project}` of `NB_RETRO_EXTRA_PROMPT` changes (`my-app` becomes `acme-my-app`), so
  ideas written from now on go to new shelves while the old ones stay under the old name.
  `nb project --why` shows both names. To keep the old one, set `NB_PROJECT_SLUG` to it in
  that project's `.claude/settings.local.json` `env` block; to fold the old shelves into the
  new name, move their lessons with `nb move` (the janitor's slug-drift section lists the pairs).
- Once a shelf name in your store contains `@`, the session-start index is grouped by
  project under that name (see below). A store without one keeps the flat index.

**Your own start and end text needs the new hooks (issue #539).** Copied 0.12 scripts hold their
text themselves and never call `nb brief` or `nb retro`, so they ignore the files in
`~/.agent-notebook/messages/`. To use them, switch to the new hooks (the adapter, or
`print-settings`). That also brings the built-in start text of issue #538 in place of the
0.12 text. If the [git wrapper](../../nb-git-wrapper.mjs) is installed as `nb`, the adapter
inside the installed package still runs the package's own `nb` and skips the wrapper: keep a
copied adapter (it runs `NB_BIN`, else `nb` on your `PATH`, which is the wrapper), or set
`NB_BIN` to the wrapper.

If a new `.sh` file is copied without `nb-claude-hook.mjs` beside it, or `node` or `nb`
cannot be found, or `nb` is too old to have `nb brief`, the session-start hook prints
one line naming the problem, which the agent can relay to you; the Stop hook stays
quiet. No hook ever exits with status 2, which Claude Code would treat as a block.

For a machine-wide setup, use `~/.claude/settings.json` instead of the
per-project `.claude/settings.json`.

## Configuration (environment)

| Var | Default | Purpose |
|---|---|---|
| `NB_DIR` | `~/.agent-notebook/notebooks` | where notebooks (and retro sentinels) live |
| `NB_RETRO_TTL_DAYS` | `7` | how many days a `.retro-<session>` sentinel survives before `nb retro` prunes it (see [below](#how-the-retrospective-nudge-avoids-looping)) |
| `NB_SESSION` | — | set it (e.g. to Claude Code's session id) to unlock the per-session [surfacing metrics](https://github.com/jeanibarz/agent-notebook/blob/main/docs/operating.md#surfacing-metrics) in `nb stats` |
| `NB_BIN` | `nb` | the `nb` the hooks run: a bare name is looked up on `PATH`, a path is used as is (a `.js`/`.mjs` file is run with `node`). Unset, the adapter runs the package it ships in, else `nb` on `PATH`. Point it at the [git-versioning wrapper](../../nb-git-wrapper.mjs) to commit each change |
| `NB_PROJECT_SLUG` | unset | the project name, e.g. `acme-app`, for the [layered index](#optional-layered-index-project--domain--global), for `{project}` and for the project's [message files](#your-own-start-and-end-text). Set it per project, not machine-wide. Unset, `nb project` derives it from the git `origin` remote (`owner-repo`), else the repository's folder |
| `NB_GLOBAL_SHELF` | `global` | with a layered index: the one bare shelf shown as the global layer |
| `NB_ENABLED` | unset | `0`/`false`/`no`/`off` switches the hooks (and the text `nb list` index) off for this process, over `git config nb.enabled`; see [per-repository on/off](https://github.com/jeanibarz/agent-notebook/blob/main/docs/harness-setup.md#per-repository-onoff) |
| `NB_RETRO_EXTRA_PROMPT` | unset | absolute path (a leading `~/` is expanded) of a text file that `nb retro` appends to its nudge, with `{project}` and `{session}` filled in; see [below](#optional-extra-prompt-for-the-retrospective-nudge) |

The hooks run `nb brief` and `nb retro` in `CLAUDE_PROJECT_DIR` (else the working
directory), and both commands read the per-repository switch there, as `nb enabled`
does. When it is `off` — set with `git config nb.enabled false` in a
repository, or `--global` for all of them — the start hooks show one
line telling the agent to skip the notebook steps instead of the index, and the
Stop hook lets the stop through. The retrospective hook also asks from
the `cwd` Claude Code passes in the hook payload, when that is another directory,
and lets the stop through if either answer is `off`: the agent's own `nb list` ran
there and may already have told it to skip the retrospective. An `off` from the
payload `cwd` alone does not use up the session's one nudge, so a later stop back
in an on directory still asks for the retrospective. A switch that cannot be read
(no git, a bad value) counts as on.

(There is no `NB_ROLE`: the index hook injects *all* notebooks' descriptions and
the agent chooses — nothing has to guess which notebook this project uses.)

## Optional: layered index (project > domain > global)

If your harness runs agents across several repos, the flat index shows every
repo's `shelf@project` notebooks to every agent. `nb brief` then shows a grouped
index when `NB_PROJECT_SLUG` is set in the environment that launches Claude Code, or,
when it is unset, once a shelf name in your store contains `@` and the repository has
an `origin` remote (the name is then the one `nb project` prints): this project's shelves
first (names ending in `@<slug>`, where the slug
is a short repo id such as `acme-app`), then the bare domain shelves, then the
one global shelf (`global`, or the name in `NB_GLOBAL_SHELF`), plus a line saying how many other
projects' shelves it left out. The hook still never opens a shelf for the agent,
and `nb list` still shows everything.

This is a **naming convention**, not an `nb` feature: `nb` treats `@` as part of
an opaque shelf name, and nothing about a layer is stored in a shelf file. The
convention, its placement rule and its limits are in
[docs/memory-layers.md](https://github.com/jeanibarz/agent-notebook/blob/main/docs/memory-layers.md). It does nothing
for a store without a `@` shelf (unless the variable is set), and falls back to the flat index (with a warning) when
the notebooks folder cannot be read.

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

`nb-subagent-start.sh` (the adapter's `subagent-start` event) wraps the output of
`nb brief` as `hookSpecificOutput.additionalContext`. The wrapping is
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

## Your own start and end text

You can add your own words to what the assistant reads at the start of a session and at
the end of a task. Put plain UTF-8 text files in `~/.agent-notebook/messages/` (create the
folder yourself; `nb` never does):

| File | Added to | For |
|---|---|---|
| `brief.txt` | `nb brief` (session start; subagents get it too) | every project |
| `retro.txt` | `nb retro` (the end-of-task nudge) | every project |
| `<project>.brief.txt`, `<project>.retro.txt` | the same, after the global text | one project |

- **Append only.** The built-in text always stays; yours comes after it, framed as "the
  user's own instructions" so the model does not take it for one more lesson. It is added
  before the `NB_RETRO_EXTRA_PROMPT` text, which is unchanged.
- **The project file wins** where it differs from the global one. `<project>` is the name
  `nb project` prints. It selects a file only when it comes from `NB_PROJECT_SLUG` or the git
  `origin` remote (`acme-app.brief.txt`), not from the folder name, which unrelated
  repositories can share.
- **Caps.** A brief file holds at most 1,000 characters and a retro file 4,000, after
  cleaning. A longer file is refused whole, never cut. A file that is empty, not UTF-8
  (save it as UTF-8, not UTF-16 or ANSI) or not a regular file is refused too, and the brief
  or retro then holds one warning line naming the file and why.
- **Cleaning.** Control characters, bidi overrides, the zero-width space and the soft hyphen
  show as `\uXXXX` (a soft hyphen pasted from a word processor shows as `\u00ad`); a tab becomes
  a space. Accented letters, Japanese text and emoji pass unchanged.
- **Retro files** may use `{project}` and `{session}`, filled in as for `NB_RETRO_EXTRA_PROMPT`.
  A file that uses one with no value (outside a git repository, no session id) is left out
  without a warning.
- **Not read** when `HOME` is empty or relative, or when the folder lies inside `NB_DIR`.
- **Check it:** `nb config` lists each file, whether it is in force, its size and when it
  changed, and names files it ignores (`Brief.txt`, `brief.txt.txt`) or that belong to another
  project. It prints this only once the folder exists. It asks for the project in the folder
  you run it in; at the end of a task, `nb retro` asks in the folder the assistant last worked
  in, which can be another project.
- **Preview** without waiting for a session. Run both in the project's folder:

  ```sh
  nb brief
  nb retro --session preview-$(date +%s)   # a fresh id, so no real session is marked as nudged
  ```

Claude Code shows a `SessionStart` output above 10,000 characters as a short preview. With
the default `--max-chars 9000` the whole brief stays under that; with `--max-chars 0` or
above 10,000 it may not.

Hooks copied from 0.12 never call `nb brief` or `nb retro`, so they ignore these files (see
[upgrading](#upgrading-from-012-copies)).

## Optional: extra prompt for the retrospective nudge

Set `NB_RETRO_EXTRA_PROMPT` to the absolute path of a text file and
`nb retro` appends its contents to the block reason, after the lessons
retrospective and a blank line. Same single nudge, same sentinel: no second hook.
`examples/hooks/ideas-end-prompt.txt` is one such file (an end-of-task check that
records at most one improvement idea with `nb-ideas add`). Put the variable in the
`env` block of your `settings.json`, never in a notebooks folder.

Nothing has to move: `NB_RETRO_EXTRA_PROMPT` works as before, with no label around its text.
To move it to a message file anyway: use the new hooks, copy the file to
`~/.agent-notebook/messages/retro.txt` (at most 4,000 characters, UTF-8), check it with
`nb config`, then unset the variable. If both stay, `nb config` says the nudge carries the
text twice. See [your own start and end text](#your-own-start-and-end-text).

The file may use two placeholders:

- `{session}`: the payload `session_id`, cleaned like the sentinel name.
- `{project}`: the name `nb project` prints in the payload `cwd`: `NB_PROJECT_SLUG` when
  set; otherwise the git `origin` remote as `owner-repo` (`git@github.com:acme/app.git`
  gives `acme-app`); otherwise the name of the repository's folder. A main checkout and its
  worktrees give the same name. It is lower-cased, characters outside `a-z0-9._-` become
  `-`, and the ends are trimmed to a letter or digit. Two repositories without a remote
  and with the same folder name share a name: set `NB_PROJECT_SLUG` per project (not in
  user-level settings) to tell them apart.

The file must be a regular UTF-8 text file of at most 64 KiB. It is read before the
sentinel is claimed. A missing, unreadable or relative path, or any other file,
prints one warning on stderr and the lessons retrospective is sent alone. When
there is no `session_id`, or no usable project name (not a git directory, git
missing), the extra text is left out and the lessons nudge is sent alone.

## How the retrospective nudge avoids looping

The Stop hook runs `nb retro`, which writes a `.retro-<session_id>` sentinel in
`NB_DIR`; the hook blocks the stop exactly once with the retrospective checklist as the
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
pile, `nb retro` prunes after each attempt to claim a session's sentinel: it sweeps `NB_DIR`
and unlinks every `.retro-*` entry whose mtime is older than `NB_RETRO_TTL_DAYS`
(default **7**). The whole sweep is best-effort and wrapped in `try/catch`, so a
failed `readdir`/`stat`/`unlink` never blocks the stop. Keep the TTL comfortably
above your longest plausible session so an in-flight sentinel is never reaped
early; the session's own sentinel is just-written and so never a prune candidate.
