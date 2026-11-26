# RFC — Notebook kinds: a folder that knows its line length, and nothing more in core

- Issue: [#530](https://github.com/jeanibarz/agent-notebook/issues/530)
- Supersedes: PR [#529](https://github.com/jeanibarz/agent-notebook/pull/529) (the `nb-ideas` wrapper)
- Status: accepted (v3.1 — after three rounds of critic review, empirical checks and a consensus attack)
- Evidence: [0530-notebook-kinds-evidence.md](0530-notebook-kinds-evidence.md)
- Amended by [#538](https://github.com/jeanibarz/agent-notebook/issues/538) (2026-11-26): `nb brief` and `nb retro` hold one built-in start and end text, the same for every kind of notebook. The non-goal below stands: per-kind text still comes only from outside the notebooks folder (`NB_RETRO_EXTRA_PROMPT`, then [#539](https://github.com/jeanibarz/agent-notebook/issues/539)).

## Problem

agent-notebook stores one kind of memory: **lessons**, read at the start of a task and voted on at the end. PR #529 added a second kind, **ideas**: simplification ideas a curator turns into work items. It left `nb` unchanged and pushed every difference into a wrapper: 8 new environment variables, a second command installed through a shim, a side log, and a second Stop hook (73% of its code lines copied from `nb-retrospective.sh`). Run without the wrapper, `nb doctor` judges the ideas folder with the wrong line length. A third kind would copy all of it again.

Two review rounds and four probes reduced the real gap to one fact: **a notebooks folder cannot say how long its lines may be.** `NB_MAX_CHARS` is process-wide, so every caller of a folder (an agent's shell, a script, the janitor, a teammate) must remember to set it. Everything else #529 built was policy, and the review found that policy either already exists in `nb`, or has no measurement behind it yet.

## Goals

1. A folder can declare its maximum line length, and every `nb` command run on that folder uses it, however the folder is reached.
2. A new kind of notebook is a folder, an optional one-line settings file, a prompt text and a command name. A third kind costs the same and no `src/` change.
3. The ideas use case ships as a **measured trial**: the smallest setup that gets ideas recorded and curated, with the measurement that decides whether any rule moves into a tool later.
4. Net change to `nb`: one optional file with one key. No new command, flag, exit code, error class, log, or change to the programmatic API.

## Non-goals

- **No per-kind rules in core**: no line-format pattern, category list, vote-reason requirement, per-session add limit or per-kind prompt text inside `nb`.
- **No per-folder `maxLines`.** It is the only setting whose loss or change deletes data: a shelf filled under a higher cap is cut to the lower one by the next add (probed: 70 → 50, 21 lines evicted in one add; 121 → 50, 71 evicted). A settings file can be deleted by a user or an agent, left out of a backup, synced from another machine, or ignored by an older `nb`; each would trigger that cut. `maxChars` has no such path: a lower line length only refuses new long lines.
- **No fuzzy write gate**, in this or a later design. #287 rejected one on evidence; check 1 below found the existing similarity scores a negation pair (0.62) above reworded ideas (0.31–0.33). Recorded as one sentence under NG-001.
- **No positional `nb <kind>` dispatch** in this RFC (see *Decision for the operator*).

## Design

### 1. Core: `<folder>/.nb.json` may set `maxChars`

```json
{ "maxChars": 400 }
```

- `nb` reads the file once, at CLI start, from the notebooks folder it is about to use (`NB_DIR` or the default).
- **The folder wins over `NB_MAX_CHARS`.** Line length is a property of the data. A global `NB_MAX_CHARS=200` set for lessons must not refuse a 300-character idea. A folder **without** the file behaves exactly as today.
- **Implementation seam:** `runNbCli` reads the file at the start of each call and sets a call-scoped override inside `notebook.ts`, which `resolveIntTunable` consults before the environment. `runNbCli` clears it in a `finally`. `process.env` is never written, so nothing leaks into child processes (the git wrapper's `git commit` children) or into a later in-process call. Placing it in `runNbCli` rather than the binary's entry point matters: the git wrapper calls `runNbCli` in its own process, and every `maxChars()` caller (`add`, `merge`, `split`, `describe`, `doctor`, the stdin bound and the usage-log column caps) already resolves through `resolveIntTunable` at call time. The getters' signatures and the library API are unchanged; a library caller sets `NB_MAX_CHARS` as today, and this is documented.
- `nb config` shows the source of `maxChars`: `(.nb.json)`, `(env NB_MAX_CHARS)` or `(default)`.
- **A bad file never blocks anything.** The cases are invalid JSON, an unreadable file, or an unknown key: `nb` prints one stderr warning naming the file, ignores the bad part, and continues. An out-of-range value is clamped to 20–2000, exactly as the same value in `NB_MAX_CHARS` is. With one key whose loss only refuses long lines, a refusal would cost more than it protects. Unknown keys are ignored with a warning, so a later key never breaks an older `nb`.
- **Trust:** the file holds one clamped integer and nothing that reaches an agent's prompt. A synced or edited file can only change which new lines are refused, and `nb config` shows it.
- `.nb.json` is versioned with the folder. The git wrapper commits it, which is what a folder-level setting should do.
- Why a file and not `git config` (the route #514 chose for `nb enabled`): `nb enabled` describes a project, while this describes a notebooks folder, which is usually not a git repository. `JSON.parse` is in the standard library (DP-7).

### 2. A kind is a folder with a command name

Ideas live in `~/.agent-notebook/ideas`, with `.nb.json` setting `{ "maxChars": 400 }`. The command name is a two-line shim on `PATH`, not a shell alias, because agents and hooks run non-interactive shells where aliases are not loaded:

```sh
printf '#!/bin/sh\nNB_DIR="$HOME/.agent-notebook/ideas" exec nb "$@"\n' > ~/.local/bin/nb-ideas && chmod +x ~/.local/bin/nb-ideas
```

`nb-ideas add …`, `nb-ideas doctor` and `nb-ideas stats` are plain `nb` on the ideas folder, with its own line length. The git wrapper, backup and janitor take `NB_DIR`. None of them reads `maxChars`, so none can drift (the janitor's mirrored clamp is `NB_MAX_LINES` only, which this RFC does not touch).

### 3. The ideas trial: agents add, the curator groups

The review showed that #529's write-time consolidation cannot be rebuilt from `nb` as it is:
- `nb`'s near-duplicate note misses reworded ideas (check 1);
- "write, then search, then vote instead" cannot be done in that order once the line is added;
- exact duplicates are rare (0 of 718 lesson adds).

So the trial drops write-time consolidation and moves the matching to the curator, which reads every line anyway:

- **One shelf per category and project**, `<category>@<project>` (for example `dead@my-app`), with the project name filled in by the hook (section 4) so it is the same across worktrees. Each category gets its own 50-line window, so a busy category cannot push out a rare one. The line is `<target>: <problem> -> <change> (keeps: <behaviour that must keep working>)`.
- **Agents only add.** At most one idea per task, and most tasks add none. They never vote on ideas and never read the shelves before writing, which keeps the "write first" property.
- **The curator is the voter.** Without votes every line ties at score 1, and a full shelf evicts oldest first: a 50-line FIFO window in which a problem reported twice, a week apart, may never sit on the shelf twice (found by the consensus attack). Votes are what `nb` keeps lines by, so the curator casts them. On each run, a person or an agent reads the project's shelves (`nb-ideas show` with each shelf name). It then handles each kind of line:
  - **A later report of a kept idea:** merged into the kept line with `nb-ideas merge`, then `+1`. The score then counts independent reports.
  - **An idea that is plausible but not yet well supported:** `+1` to keep it, so it outlives fresh, unreviewed lines.
  - **An idea that fails a quick check against the code:** removed with `nb-ideas rm … --reason wrong` or `--reason obsolete`.

  Unreviewed lines that nobody repeats age out, which is `nb`'s cap doing its normal job.
- **Promotion and close.** An idea reported by two or more tasks is checked against the code by its category (`dead`: a search finds no use outside its own tests; `duplicate`: both copies exist; `fragile`: reproduce it; the full table lives in the ideas docs). A deletion also needs a test that covers its `keeps:` behaviour. The curator then files a work item and removes the line with `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"`. Each work item records the run's counts: lines read, reports merged, ideas kept, ideas promoted.
- **Cadence.** The curator runs weekly, or sooner when any shelf reaches 40 lines (`nb-ideas list` shows the counts). A repeat that arrives after its first report has aged out unreviewed is still lost; the cadence bounds how often that happens, and the run counts show whether it does.

**The measurement that decides the next step.** Two sources, after four curator runs:
- `nb-ideas stats` on the ideas folder: the share of sessions adding 2 or more ideas (the add-burst signal and the per-session add counts) and the `too_long` rate. Both need a session id on each add, which the prompt supplies (`{session}`, section 4).
- The curator's run counts: how many ideas were reported by two or more tasks.

The trial has three outcomes:
- If agents overshoot "at most one" as they do on lessons (about 98 of 541 task-shelf pairs, operator-supplied), a per-shelf add limit gets its own RFC. It would use state written under the lock, not the usage log.
- If, after four runs, fewer than two ideas in total were reported twice, the store is not finding repeated problems. The trial stops, and the curator's own reading of single ideas is its whole value.
- Otherwise it continues as is.

### 4. One Stop hook, one extra prompt file

`nb-retrospective.sh` keeps its single sentinel and its rules: the lead agent only, never on `SubagentStop`, once per session. It gains one optional setting, `NB_RETRO_EXTRA_PROMPT`, the path of a text file it appends to its block reason:

- The file is read **before** the sentinel is claimed. If it is missing or unreadable, the hook warns on stderr and sends the lessons retrospective alone, so a broken ideas setup never costs the lessons nudge.
- A leading `~` is expanded, and the path must be absolute.
- `{project}` is filled in by the hook from the payload `cwd`, the directory the agent is working in:
  - **Source.** `NB_PROJECT_SLUG` when it is set for that project. Otherwise `basename(dirname(realpath(<git rev-parse --git-common-dir>)))`: the folder that holds the repository's `.git`, which is the same for every worktree of that repository.
  - **Cleaning.** The name is lower-cased, characters outside `a-z0-9._-` become `-`, and the ends are trimmed to a letter or digit.
  - **No usable name** (not a git directory, or empty after cleaning): the hook leaves the ideas text out and sends the lessons nudge alone.
  - **Collisions.** Two repositories with the same folder name share shelves. The fix is to set `NB_PROJECT_SLUG` per project, never in user-level settings; the setup guide says so.
- `{session}` is filled in with the payload `session_id`. The prompt's command is written `NB_SESSION={session} nb-ideas add …`, so each idea's add carries its session in the usage log without changing `NB_SESSION` for lessons. If there is no session id, the hook leaves the ideas text out.
- The setting lives in the user's hook configuration (the `env` block of `settings.json`), not in a notebooks folder, so prompt text never comes from synced data.

The ideas prompt ships as `examples/hooks/ideas-end-prompt.txt`. It is short, says most tasks have nothing, and names the format, the category list and `NB_SESSION={session} nb-ideas add <category>@{project} "…"`. #529's second hook, its sentinel and the two-hook ordering question go away.

## Surface ledger

| | Today | PR #529 | RFC v1 | **v3** |
|---|---|---|---|---|
| Config sources | env only | + 8 env vars | + `.nb.json`, 11 keys | **+ `.nb.json`, 1 key** |
| Commands / flags | 22 / per table | + 1 binary, 7 subcommands, 4 flags | + `nb kinds`, `nb <kind>`, `--new`, `vote --note` | **none** |
| Exit codes / error classes | 0–3 | 2 and 3 reused | 2 and 3 reused | **none** |
| Files written by tools | usage log, lock, sentinels | + side log, 2 marker kinds | none | **none** |
| Hooks | 3 | + 1 Stop hook | 2 modified | **1 modified (one optional file)** |
| `src/` | — | none | large | **read one key per `runNbCli` call into a call-scoped override; `nb config` source (est. under 80 lines plus tests)** |
| Library API | — | — | getters change | **unchanged** |
| Third kind | — | copy everything | 1 folder + file, but each new rule is a core key | **folder + optional file + prompt + shim; no `src/` change** |

## Delivery

1. **Core** (one PR; needs a release). It contains:
   - `maxChars` in `.nb.json`, where the folder wins over the environment;
   - warn-and-continue on a bad file;
   - the source shown in `nb config`;
   - an FR in `docs/requirements.md`, and one sentence under NG-001 citing #287;
   - CHANGELOG and README configuration rows.
2. **Integration and docs** (one PR, after 1). It contains:
   - `NB_RETRO_EXTRA_PROMPT`, `{project}` and `{session}` in `nb-retrospective.sh`. The tests cover:
     - a missing or unreadable file;
     - a main checkout and a worktree mapping to the same name;
     - a non-git `cwd`;
     - a name that needs cleaning;
   - for the core PR: a 300-character `nb-ideas add` through the git wrapper's in-process `runNbCli` is accepted, and a git child process does not inherit the override;
   - `examples/hooks/ideas-end-prompt.txt`;
   - the shim;
   - the ideas docs and setup guide carried over from #529, rewritten for this design;
   - closing #529.
3. **Separate issue, not part of this RFC:** the session-start hook exporting `NB_SESSION` for lessons through `$CLAUDE_ENV_FILE` (check 3). It would switch on per-session `nb stats` signals for every lessons user, so it needs its own evaluation. The ideas trial does not depend on it, because `{session}` covers ideas.

## Edge cases

- **Older `nb` on a folder with `.nb.json`.** It ignores the file. New ideas over 200 characters are refused, not stored, and `doctor` reports existing long lines. Nothing is lost (check 2). The setup guide names the minimum version.
- **The file is deleted or lost.** The default 200 applies, and long new ideas are refused. Nothing is evicted.
- **An agent raises `maxChars` in the file to get past `too_long`.** This is allowed and visible in `nb config`. It is the same power an agent has today with `NB_MAX_CHARS=… nb add`.
- **The shim is not on the agent's `PATH`.** The agent's `nb-ideas` call fails with "command not found". The setup guide's check step runs the shim from a non-interactive shell to catch this.
- **The idea lands in a lessons shelf instead.** This happens if an agent improvises `nb add` when `nb-ideas` is missing. The lesson cap (200) and the lessons hook make it visible. It is a setup error, not silent data loss.

## Decision for the operator

The operator asked: "let the user configure different kinds of notebooks and then just say `nb lesson …; nb idea …`". v3 **declines first-class kinds**: `nb` has no notion of a kind, and `nb help` does not mention one. The substitute is a folder, a shim and a one-key file. Two ways to go further, each measured against v3:

- **`nb --kind <name> …` (or `NB_KIND`).** The folder is `<parent of the lessons folder>/<name>`, and must exist. That is about 30 lines in `cli.ts`, plus one row in `KNOWN_FLAGS`, completion and docs.
  - Gain: `nb --kind ideas add …` works wherever `nb` works, with no shim.
  - Cost: a second way to choose a folder besides `NB_DIR`, and a rule for when both are set.
  - It cannot shadow a command, and reads nothing outside the notebooks parent.
- **Positional `nb ideas …`.** It is shorter to type. On top of `--kind`'s cost:
  - a future command can shadow a kind;
  - the git wrapper's argument parsing must learn it;
  - the unknown-command error must check folders.

Recommendation: v3 as written, and revisit `--kind` if a third kind appears or the shim proves to be friction. This is a choice about what agent-notebook is for, so it is the operator's.

## Empirical checks

Run by `design-experimenter` on this worktree's build, in scratch folders:

1. **`nb`'s near-duplicate note on idea-shaped lines does not consolidate them.** The test used 21 lines in the ideas format:
   - reworded pairs scored 0.31–0.33;
   - a different problem in the same file scored 0.32;
   - a negation pair scored 0.62.

   At thresholds 0.4–0.6, 0 of 5 reworded pairs were flagged and the negation pair was.
2. **A lower `maxLines` evicts at once.** 70 lines became 50, with 21 evicted in one add. A lower `maxChars` only refuses new long lines; add, vote, rm and merge still work.
3. **A SessionStart hook can export `NB_SESSION` through `$CLAUDE_ENV_FILE`** (Claude Code 2.1.330). The main agent and a subagent see the same value.
4. **A live usage log, 9 days, 700 accepted adds.** 155 of 350 sessions added 2 or more times in the folder. 98 of 551 (session, shelf) pairs did, against the operator's 98 of 541.

## Alternatives considered

- **A. Keep #529's wrapper.** Every kind copies a wrapper, env vars, a log and a hook.
- **B. RFC v1** (an 11-key file, `nb <kind>` dispatch, rules in core). Rejected in round 1:
  - most keys had one consumer and no data;
  - enforcing rules from the usage log is unsound (it is written after the lock is released, and its errors are swallowed);
  - prompt text in a data folder is a trust problem;
  - dispatch reads outside `NB_DIR` and can be shadowed by a future command.
- **C. v2** (a 2-key file with `maxLines`, a refusal on a bad file, folder-aware getters, prompt-only consolidation). Rejected in round 2:
  - `maxLines` adds every data-loss path and had no user;
  - the refusal existed only to guard it;
  - folder-aware getters touched about 12 call sites and the library API;
  - prompt-only consolidation could not work in the stated order.
- **D. No core change: the shim also sets `NB_MAX_CHARS=400`.** No `src/` change and no release. It is wrong whenever the folder is reached without the shim: a script, the janitor, a teammate, or `NB_DIR=… nb doctor`. In those cases `doctor` reports every long line and long adds are refused. This is the fallback if the core PR is not wanted. It is also enough for the trial if ideas fit in 200 characters, which has not been measured: #529's example lines are 90–130 characters.
- **E. Kinds as namespaces in one folder.** They would mix in the session-start index, `stats`, the janitor and history.
- **F. A plugin or script hook inside `nb`.** It contradicts DP-6.

## Critic feedback incorporated

**Round 1** (2026-11-23): `design-minimalist`, `boundary-critic`, `failure-mode-analyst`, `socratic-challenger`, `ambition-amplifier`.
- v1's rules were #529's wrapper renamed as generic keys, so they were cut (all five).
- The usage log cannot enforce or count rules, so those were deferred (boundary, failure-mode, ambition, socratic).
- The folder now wins over the environment (boundary, failure-mode, ambition).
- A fallback to a lower `maxLines` evicts, a finding probed by failure-mode. In v3 this led to dropping `maxLines` altogether.
- The fuzzy gate was cut, and "no fuzzy write gate" became a non-goal (all five).
- Prompt text moved out of data folders (boundary, failure-mode, socratic).
- Positional dispatch was deferred (all five).
- **Adversarial pair.** `ambition-amplifier` proposed making lessons a named kind with a structural key; `design-minimalist` proposed caps only. I sided with the minimalist: no rule has a second consumer or ideas data yet. Ambition's curator-loop point is kept as the curator's `rm --note "promoted: …"` step.
- `ambition-amplifier` 2026-11-23: novel finding (session versus task unit; lessons as a kind).

**Round 2** (2026-11-23): `design-minimalist`, `boundary-critic`, `failure-mode-analyst`, `socratic-challenger`.
- `maxLines` had no user, and every eviction path went through it, so it was cut (minimalist, failure-mode).
- The `bad_config` refusal was replaced by warn-and-continue, since with one key it no longer guards data (minimalist).
- Folder-aware getters were replaced by applying the value at CLI start, which keeps the API unchanged and settles the usage-log cap question (boundary, failure-mode).
- Unknown keys are now ignored with a warning, so a newer key cannot break an older `nb` (failure-mode).
- The alias became a shim, because agents' shells do not load aliases (boundary, socratic, failure-mode).
- `NB_END_PROMPTS` became one file, read before the sentinel is claimed, with failures degrading to the lessons nudge alone (minimalist, failure-mode).
- The project shelf name is filled in by the hook from `NB_PROJECT_SLUG` or the main checkout, so worktrees share one shelf (failure-mode, socratic).
- Prompt-only consolidation was replaced by curator grouping, with duplicates as the support signal and ideas framed as a measured trial (socratic, failure-mode).
- The `NB_SESSION` export moved to its own issue (minimalist, boundary, failure-mode).
- The intent statement was corrected from "met by an alias" to "declined, with a substitute", and the decision now goes to the operator (socratic).
- Number fixes: both eviction probes are cited with their setups (21 and 71), and both session-shelf counts with their sources (541 operator-supplied, 551 recount).
- Rejected: "drop `.nb.json`, use alternative D". D is kept as the fallback; the folder must know its own line length when reached without the shim.

**Round 3 and consensus attack** (2026-11-23): `failure-mode-analyst`, `design-minimalist`, `general-purpose` (consensus attack).
- **The seam was placed in `runNbCli`, as a call-scoped override that is never written to `process.env`.** The git wrapper calls `runNbCli` in its own process, so the binary's entry point would be bypassed, and writing `process.env` would leak into git child processes (failure-mode).
- **The `{project}` rule was corrected.** `--git-common-dir` gives `.git` in a main checkout, so the rule now uses the folder that holds it. It now also specifies cleaning, the no-name fallback and the collision advice (failure-mode).
- **The eviction claim "a full shelf ages out single, unrepeated ideas" was false.** With no votes, a full shelf is a FIFO window. The curator now votes to keep and merges repeats, and shelves go back to one per category and project (consensus attack, confirmed independently by failure-mode).
- **The trial now has a readable measurement.** `{session}` puts a session id on each idea add, the curator records counts, and an explicit stop rule decides the outcome (minimalist).
- **Cuts:** the `"//"` allowance, the 4 KB cap, the "overridden" display, and the category table, which moves to the docs (minimalist).
- **Out-of-range file values are now clamped like the environment's,** not ignored (failure-mode).
- `general-purpose` 2026-11-23: consensus-attack — finding (an unvoted capped shelf is a FIFO window; repetition is erased before a weekly curator can see it). Incorporated in this one revision; no further round.

Intent preservation check. The operator's motivations were:
1. avoid duplication when a kind is added — met;
2. "configure different kinds of notebooks" — met as folders plus one setting;
3. `nb lesson …; nb idea …` — declined, with a substitute, and raised as a decision;
4. elegant, pragmatic, little added complexity — met.
