# Two use cases: lessons and ideas

*agent-notebook stores one-line notes. The same storage serves two different jobs. This page says what the two jobs are, why they live in separate folders, how the ideas use case works, and how its trial will be judged.*

The ideas use case is a **trial**. The design is the accepted [RFC 0530](./rfcs/0530-notebook-kinds.md). The figures below are the ones that RFC reports, labelled as it labels them. They are the reasons for each rule, not a promise about your own sessions. To set it up, follow the [setup guide](../examples/SETUP.md).

## 1. The two use cases side by side

| | Lessons | Ideas |
|---|---|---|
| What an entry is | A one-line lesson: what to remember next time | A one-line simplification idea: what to delete, merge, shorten, split, correct or make fail loudly |
| Written | At task end, by the agent that did the task | At task end, only when the task showed something; at most one, and most tasks record nothing |
| Voted | By the agents that used it | By the curator only |
| Read | At task start, by the next agent (index at session start, then `nb show`) | Never at task start. Read by a periodic curator |
| Shelves | One per topic | One per category and project, `<category>@<project>`, for example `dead@my-app` |
| Line length | 200 characters (the default) | 400 characters, set by the folder |
| Folder | The default `NB_DIR`, `~/.agent-notebook/notebooks` | `~/.agent-notebook/ideas`, reached through the `nb-ideas` command |
| Ends as | The line stays or ages out | A work item, after a curator checks it against the code |
| Goal | Agents repeat fewer mistakes | The code base gets smaller and simpler |

**Lessons.** A lesson is a short rule such as "run the formatter before the tests; CI fails on style first". Agents read the relevant shelves when a task starts and curate them when it ends: add what they learned, vote on what helped or misled them. The notebook stays small because it is capped and the lowest score leaves first (see [eviction and aging](./eviction-and-aging.md)). This is the original use of agent-notebook, and nothing about it changes.

**Ideas.** An idea is a note that a task ran into something that should be simpler: a script nothing calls, two copies of one rule, a check that swallows its error. The agent that noticed it has no time to fix it, and should not, so it records one line and moves on. Nobody reads the list at session start. Once in a while a curator (a person or an agent) reads the shelves, checks the ideas that more than one task hit, and turns the ones that hold up into work items.

## 2. Why separate folders

The ideas live in a second notebooks folder, not in shelves inside the lessons folder. Three reasons:

- **Nothing mixes.** The session-start index lists every shelf in the lessons folder. Ideas must never reach the agent at session start, so they cannot sit in the folder the index is built from. The same goes for `nb stats`, the janitor and the usage log: each reports on one folder, and ideas would distort the lesson numbers.
- **A different line length.** An idea line carries a target, a problem, a change and a `keeps:` clause, so it is longer than a lesson. The line length belongs to a folder: a folder that allows 400 characters cannot also keep lessons to 200.
- **`nb doctor` must judge the folder by its own length.** `nb doctor` flags any line longer than the length in force. If the length is only set per process, every caller of the folder (an agent's shell, a script, the janitor, a teammate) has to remember it, and one that forgets sees every long line as an error.

## 3. The ideas trial: design and reasons

### A kind is a folder, a settings file, a prompt and a command name

`nb` has no notion of a kind of notebook, and `nb help` does not mention one. The ideas use case is built from four small pieces:

| Piece | What it is |
|---|---|
| Folder | `~/.agent-notebook/ideas` |
| Setting | `.nb.json` in that folder, `{ "maxChars": 400 }` |
| Prompt | `examples/hooks/ideas-end-prompt.txt`, appended to the retrospective nudge |
| Command | `nb-ideas`, a two-line shell shim on `PATH` |

The shim is `NB_DIR="$HOME/.agent-notebook/ideas" exec nb "$@"`, so `nb-ideas add`, `nb-ideas doctor` and `nb-ideas stats` are plain `nb` on the ideas folder. It is a script and not a shell alias because agents and hooks run non-interactive shells, where aliases are not loaded. The git wrapper, backup and janitor take `NB_DIR` and none of them reads `maxChars`, so none can drift from the folder's setting.

**`.nb.json`.** `nb` reads `<folder>/.nb.json` once, when it starts. The folder wins over `NB_MAX_CHARS`: a global `NB_MAX_CHARS=200` set for lessons must not refuse a 300-character idea. A folder without the file behaves as before. A bad file never blocks anything: `nb` prints one warning that names the file, ignores the bad part and goes on. A value outside 20–2000 is clamped, as it is for `NB_MAX_CHARS`. `nb config` shows where `maxChars` came from.

**Versions.** `.nb.json` lands in the release after 0.11.1. With `nb` newer than 0.11.1, put `{ "maxChars": 400 }` in the ideas folder's `.nb.json`. With 0.11.1 or older, `nb` ignores the file, so the shim also sets `NB_MAX_CHARS=400`. Run `nb --version` to tell which you have. The fallback is wrong whenever the folder is reached without the shim (a script, the janitor, `NB_DIR=… nb doctor`): `doctor` then reports every long line. The setup guide has both shims.

**There is no per-folder `maxLines`.** It is the one setting whose loss would delete data. A shelf filled under a higher cap is cut to a lower one by the next add (the RFC probed 70 lines becoming 50, with 21 evicted in one add). A settings file can be deleted, left out of a backup or ignored by an older `nb`, and each would trigger that cut. A lower `maxChars` only refuses new long lines.

### Simplification only, with a closed category list

The store records things to remove or fix, never features. An open "ideas" list fills with feature requests, and a curator cannot tell which are cheap or safe. A list limited to simplification can be checked against the code.

The category is the first part of the shelf name. The list lives in the prompt text, not in `nb`: nothing in `nb` enforces it. The order is the tie-break: if two fit, take the first.

| Category | Meaning | Change |
|---|---|---|
| `guidance` | A doc, rule, comment or help text is wrong, stale or redundant | Correct, shorten or delete it |
| `dead` | Code, flag, file, script or config that nothing uses | Delete it |
| `duplicate` | The same logic, rule or data in two places | Merge it |
| `overbuilt` | An abstraction, indirection, option or layer more complex than the job | Inline or collapse it |
| `tangled` | Mixed responsibilities, or code in the wrong layer | Split or move it |
| `unused` | A working feature or option that is rarely used or confusing | Remove or unify it (a human decides) |
| `fragile` | A swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result | Make it fail loudly and simply |
| `tests` | A tautological, duplicated, flaky or slow test, or one tied to implementation details | Delete, merge or rewrite it |

### One shelf per category and project

A shelf is `<category>@<project>`, for example `dead@my-app`. Each gets its own 50-line window, so a busy category such as `guidance` cannot push out a rare one such as `fragile`. A shelf is created by the first add. `nb-ideas describe` can label it, and nothing needs creating by hand.

The Stop hook fills in the project name, so it is the same in every worktree of a repository. It uses `NB_PROJECT_SLUG` when that is set. Otherwise it uses the name of the folder that holds the repository's `.git`, lower-cased, with characters outside `a-z0-9._-` replaced by `-`. Two repositories whose folders have the same name would share shelves. Set `NB_PROJECT_SLUG` for each project, never in user-level settings, to tell them apart.

### Line format

```text
<file or command>: <problem> -> <change> (keeps: <behaviour that must keep working>)
```

For example:

```text
scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
```

The target comes first, so two ideas about the same thing are easy to match by eye. The `keeps:` clause makes a deletion safe to plan: it names the behaviour that a test must still cover. `nb` does not check the format. The prompt asks for it, and the curator reads it.

### Agents only add, and never read first

An agent adds at most one idea per task, never votes on ideas, and does not read the shelves before writing. Reading first turns a vote into recognition: the agent sees an idea, agrees and votes, whether or not its own task hit it. Writing first keeps each report independent. The prompt says that most tasks have nothing to record, and that stopping is then the right answer.

### Why the curator is the voter

Without votes every line ties at score 1, and a full shelf drops its oldest line first. That is a 50-line first-in, first-out window. A problem reported twice, a week apart, may never sit on the shelf twice. Votes are what `nb` keeps lines by, so the curator casts them: it merges repeats and votes `+1` on them, votes `+1` on ideas worth keeping, and removes ideas that are wrong or out of date. Section 4 has the steps.

### Why the matching is done by the curator

The design first tried to match ideas at write time, and the review found that `nb` cannot do it as it stands:

- **The near-duplicate note misses reworded ideas.** RFC check 1, on 21 lines in the ideas format: reworded pairs scored 0.31–0.33, a different problem in the same file scored 0.32, and a negation pair scored 0.62. At thresholds 0.4–0.6, 0 of 5 reworded pairs were flagged, and the negation pair was.
- **"Write, then search, then vote instead" cannot be done in that order,** because the line is already added.
- **Exact duplicates are rare.** The RFC counts 0 of 718 lesson adds.

So the trial drops write-time matching. The curator reads every line anyway, so it does the grouping. There is no fuzzy write gate in `nb`, and the RFC does not plan one.

### One Stop hook, one extra prompt file

`nb-retrospective.sh` keeps its single sentinel and its rules: it nudges the lead agent only, never on `SubagentStop`, once per session. It gains one optional setting, `NB_RETRO_EXTRA_PROMPT`: the absolute path of a text file that it appends to its nudge, after the lessons retrospective. Details are in the [hooks README](../examples/hooks/claude-code/README.md#optional-extra-prompt-for-the-retrospective-nudge).

- The hook reads the file before it claims the sentinel. If the file is missing or unreadable, it warns on stderr and sends the lessons retrospective alone, so a broken ideas setup never costs the lessons nudge.
- The hook fills in `{project}` as described above, and `{session}` from the payload's `session_id`. The prompt writes the command as `NB_SESSION={session} nb-ideas add …`, so each idea's add carries its session in the usage log without changing `NB_SESSION` for lessons.
- If there is no usable project name or no session id, the hook leaves the ideas text out.
- The setting lives in the user's hook configuration (the `env` block of `settings.json`), never in a notebooks folder, so prompt text never comes from synced data.

Harnesses without a Stop hook, such as Codex CLI, get the same text appended to `AGENTS.md`, with the project name filled in by hand.

### What it costs `nb`

One optional file with one key. No new command, flag, exit code, error class or log, and no change to the programmatic API. A library caller sets `NB_MAX_CHARS` as before: the file is read by the command line only. A third kind of notebook costs a folder, an optional file, a prompt and a shim.

## 4. The curator recipe

Run it weekly, or sooner when any shelf reaches 40 lines (`nb-ideas list` shows the counts). A person or an agent can do it. Do it for one project at a time.

1. **Read.** Run `nb-ideas show <category>@<project>` for each of the project's shelves.
2. **Vote.** Handle each line by its kind:
   - **A later report of an idea you already keep.** Merge it into the kept line, then vote `+1`: `nb-ideas merge <shelf> <kept-id> <new-id> "<kept text>"`, then `nb-ideas vote <shelf> <id> +1`. The merged line keeps the higher of the two scores, so the score counts independent reports. `nb-ideas show` prints the id of the merged line.
   - **A plausible idea that is not yet well supported.** Vote `+1` to keep it. It then outlives the fresh lines that nobody has reviewed.
   - **An idea that fails a quick check against the code.** Remove it: `nb-ideas rm <shelf> <id> --reason wrong`, or `--reason obsolete` if the code has changed since.

   Unreviewed lines that nobody repeats age out. That is the cap doing its normal job.
3. **Promote.** An idea that two or more tasks reported is checked against the code, by its category:

   | Category | Check |
   |---|---|
   | `dead` | A search finds no use outside its own tests |
   | `duplicate` | Both copies exist |
   | `fragile` | Reproduce it |
   | `guidance` | The quoted text is still there |
   | `unused` | Look for usage evidence; a human decides |
   | `overbuilt`, `tangled` | Usually need a design first |
   | `tests` | Run the test, or check what a mutation does to it |

   A deletion also needs a test that covers its `keeps:` behaviour. Do not verify a deletion by asking "does something already do this?": that question finds a reason to keep everything. Check that nothing uses it.
4. **File and close.** File a work item for each idea that passes. Then remove the line, keeping the link: `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"`.
5. **Count.** Write the run's counts in the work item or the run note: lines read, reports merged, ideas kept, ideas promoted.

A repeat that arrives after its first report has aged out, unreviewed, is still lost. The cadence bounds how often that happens, and the counts show whether it does.

## 5. Measurement and stop rule

The trial exists to find out whether repeated reports are a real signal. It has two sources, read after four curator runs:

- **The usage log of the ideas folder** (`nb-ideas stats`, and the log that `nb-ideas path --usage` points to). It gives the share of sessions that add 2 or more ideas, and the `too_long` rate. Both need a session id on each add, which `NB_SESSION={session}` in the prompt supplies. `nb stats` prints adds per shelf, the add-burst signal and the error causes; its add-burst signal fires on more than `NB_ADD_BURST_N` adds (default 15) to one shelf in a session, so for the 2-or-more share, count sessions in the log's session column.
- **The curator's run counts:** how many ideas were reported by two or more tasks.

The trial has three outcomes:

- **Agents overshoot "at most one".** The RFC cites lessons, where the instruction was broken in about 98 of 541 task-shelf pairs (operator-supplied; its own recount of a live usage log gave 98 of 551). If ideas behave the same way, a per-shelf add limit gets its own RFC. It would use state written under the lock, not the usage log.
- **Fewer than two ideas in total were reported twice after four runs.** The store is not finding repeated problems. The trial stops, and the curator's own reading of single ideas is its whole value.
- **Otherwise,** it continues as it is.

These numbers come from lessons and from a short window of one usage log: 9 days and 700 accepted adds, in which 155 of 350 sessions added 2 or more times in the folder (RFC check 4). They say what to watch, not what ideas will do.

## 6. Where to go next

- Setup, step by step: [examples/SETUP.md](../examples/SETUP.md).
- The Stop hook and `NB_RETRO_EXTRA_PROMPT`: [hooks README](../examples/hooks/claude-code/README.md#optional-extra-prompt-for-the-retrospective-nudge).
- The design and the options it turned down: [RFC 0530](./rfcs/0530-notebook-kinds.md).
- How a full notebook decides what to keep: [eviction and aging](./eviction-and-aging.md).
