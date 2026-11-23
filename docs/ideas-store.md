# Two use cases: lessons and ideas

*agent-notebook stores one-line notes. The same storage serves two different
jobs. This page says what the two jobs are, why they live in separate folders,
and why the ideas store has the rules it has.*

The numbers below come from a design review and from measurements on about 400
agent sessions that used agent-notebook lessons. They are the reason for each
rule, not a promise about your own sessions.

## 1. The two use cases side by side

| | Lessons | Ideas |
|---|---|---|
| What an entry is | A one-line lesson: what to remember next time | A one-line simplification idea: what to delete, merge, shorten, split, correct or make fail loudly |
| Written | At task end, by the agent that did the task | At task end, only when the task showed something; most tasks record nothing |
| Read | At task start, by the next agent (index at session start, then `nb show`) | Never at session start. Read by a periodic curator |
| Size | Bounded, one-line, voted; the lowest score is evicted | Bounded per shelf; a well-supported idea is promoted to a work item and removed |
| Folder | The default `NB_DIR` | A separate folder, `NB_IDEAS_DIR`, through the `nb-ideas` wrapper |
| Goal | Agents repeat fewer mistakes | The code base gets smaller and simpler |

**Lessons.** A lesson is a short rule such as "run the formatter before the
tests; CI fails on style first". Agents read the relevant shelves when a task
starts and curate them when it ends: add what they learned, vote on what helped
or misled them. The notebook stays small because it is capped and the lowest
score leaves first (see [eviction and aging](./eviction-and-aging.md)). This is
the original use of agent-notebook and nothing about it changes.

**Ideas.** An idea is a note that a task ran into something that should be
simpler: a script nothing calls, two copies of one rule, a check that swallows
its error. The agent that noticed it has no time to fix it and should not, so it
records one line and moves on. Nobody reads the list at session start. Once in a
while a curator (a person or an agent) looks at the ideas that several different
tasks hit independently, checks them against the code, and turns the ones that
hold up into work items.

## 2. Why separate folders

The ideas store is a second `NB_DIR`, not a set of shelves inside the lessons
folder. Three reasons:

- **Nothing mixes.** The session-start index lists every shelf in `NB_DIR`.
  Ideas must never reach the agent at session start, so they cannot sit in the
  folder the index is built from. The same goes for `nb stats`, the janitor and
  the usage log: each reports on one folder, and ideas would distort the lesson
  numbers.
- **The longer line cap needs its own folder.** An idea line carries a target, a
  problem, a change and a `keeps:` clause, so it is longer than a lesson. But
  `NB_MAX_CHARS` and `NB_MAX_LINES` are global per process, so the longer cap
  applies to the whole folder it runs in. A folder with a long cap cannot hold
  lessons without letting them grow.
- **`nb doctor` checks against the cap it runs with.** It flags any line longer
  than that cap. The wrapper passes the ideas cap to every `nb` it starts, so
  `nb-ideas doctor` is correct. Plain `nb doctor` with `NB_DIR` pointed at the
  ideas folder runs with the default cap and reports the long lines as errors.

## 3. Design, and the reason for each rule

### Simplification only, with a closed category list

The store records things to remove or fix, never features. An open "ideas" list
fills with feature requests, and the curator cannot tell which ones are cheap or
safe. A list limited to simplification can be checked against the code.

Categories are a closed list. The order is the tie-break: if two fit, take the
first.

| Category | Meaning | Change |
|---|---|---|
| `guidance` | A doc, rule, comment or help text is wrong, stale or redundant | Correct, shorten or delete it |
| `dead` | Code, flag, file, script or config that nothing uses | Delete it |
| `duplicate` | The same logic, rule or data in two places | Merge it |
| `overbuilt` | An abstraction, indirection, option or layer more complex than the job | Inline or collapse it |
| `tangled` | Mixed responsibilities, or code in the wrong layer | Split or move it |
| `unused` | A working feature or option that is rarely used or confusing | Remove or unify it (the curator asks a human) |
| `fragile` | A swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result | Make it fail loudly and simply |
| `tests` | A tautological, duplicated, flaky or slow test, or one tied to implementation details | Delete, merge or rewrite it |

The list is configurable: a `categories.txt` file in the ideas folder, one
`name: definition` per line, replaces it, and its order is the tie-break order.
No feature category ships.

### One shelf per category and project

Shelves are named `<category>@<project>`, for example `dead@my-app`. A single
shelf per project would be capped, and a busy category such as `guidance` would
push out a rare one such as `fragile`. With one shelf each, a rare category keeps
its own room. `nb-ideas show` reads all of a project's shelves together, so the
split costs the reader nothing.

### Line format

```text
<file or command>: <problem> -> <change> (keeps: <behaviour that must keep working>)
```

For example:

```text
scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
```

The target comes first so two ideas about the same thing match by target, even
when the wording differs. The `keeps:` clause makes a deletion safe to plan: it
names the behaviour the curator must confirm a test still covers. The wrapper
rejects a line that does not have this shape.

### Agents write first, then the wrapper matches

Agents are not asked to read the idea list before deciding. Reading the list
first turns a vote into recognition: the agent sees an idea, agrees, and votes,
whether or not its own task hit it. In the measured sessions, lesson votes ran
about 1,075 up to 7 down. That ratio is agreement, not evidence.

So the agent writes its idea blind, and then `nb-ideas add` compares it with
every idea of the project, across all shelves. A match is the same target, or a
character-trigram similarity of at least 0.4 (the package's exported
`similarity`). On a match the wrapper records nothing, lists the matching ideas,
and exits with code 3. The agent then either votes for the one it really hit, or
re-runs with `--new` to say its idea is different.

### An identical line becomes a vote

Plain `nb add` skips an exact duplicate and does not vote; with `--json` it
reports `reason: "duplicate"` and the `collidedId`. The wrapper turns an
identical line into a +1 on the existing idea, with the reason from `--because`
or a note that the same line was added again. Two agents who write the same line
independently is the strongest support there is, and plain `nb add` would throw
it away.

### One new idea per task, and a +1 needs a reason

- A task may add at most one new idea. A second add is refused with a pointer to
  vote instead. Converted votes do not count as adds.
- A +1 needs `--because "<what in this task hit it>"`. A task cannot vote twice
  on one idea, and cannot +1 an idea it added itself.
- Every add and vote is appended to a side log, `.ideas-support.log`, in the
  ideas folder. A task counts as supporting an idea only if it added it or
  voted +1 with a reason.

Tasks are identified by `NB_SESSION`. It is optional: an orchestrator can set
it, or the Stop hook passes its session id through `nb-ideas prompt --session`.
Without it the per-task rules are not checked, and each event counts as its own
task (the wrapper says so on stderr).

### Promotion rule

An idea is promotable when its score is at least 3 and at least 2 different
tasks support it. Both numbers are configurable (`NB_IDEAS_PROMOTE_SCORE`,
`NB_IDEAS_PROMOTE_TASKS`). The score alone is not enough: a single task can
inflate it, and a second, independent task is the cheapest signal that the
problem is real and not one agent's opinion.

### Where and when to prompt

The prompt is a Stop hook seen by the main agent. It is not on SubagentStop. The
hook claims a once-per-session marker; if subagents are allowed to claim it,
they take the only prompt, and in about 20% of the measured sessions they did.
The main agent is the one that has seen the whole task.

The prompt comes before the final step, and it is short. It says most tasks have
nothing to record, and that stopping is then the right answer. Ideas are not
shown at session start, for the same reason as the write-first rule: a visible
list invites agreement.

The rules live in the wrapper, not only in prose, because prose was not obeyed.
On lessons, "at most one" written in the instructions was broken in about 98 of
541 task-shelf pairs. And 0 of 718 adds were exact duplicates, so exact-match
checking alone catches nothing; a similarity check on the target and wording
is what finds repeats.

## 4. The curator recipe

Run it on a schedule, for example weekly. A person or an agent can do it.

1. List what is ready: `nb-ideas support --project my-app`. It shows each idea,
   its score, the tasks that support it, and whether it is promotable.
2. For each promotable idea, check it against the code, by category:

   | Category | Check |
   |---|---|
   | `dead` | A search finds no use outside its own tests |
   | `duplicate` | Both copies exist |
   | `unused` | Look for usage evidence; a human decides |
   | `fragile` | Reproduce it |
   | `guidance` | The quoted text is still there |
   | `overbuilt`, `tangled` | Usually need a design first |
   | `tests` | Run the test, or check what a mutation does to it |

   A deletion idea is not verified by asking "does something already do this?".
   That question finds a reason to keep everything. Check instead that nothing
   uses it, and that a test covers the `keeps:` behaviour.
3. File a work item for each idea that passes.
4. Remove the idea, keeping the link:
   `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"`.
5. Remove an idea that fails the check:
   `nb-ideas rm <shelf> <id> --reason wrong` (or `--reason obsolete` if the
   code has changed since).

Anything the wrapper does not handle itself (`list`, `rm`, `describe`, `doctor`,
`stats`) is passed to `nb` with the ideas folder and cap already set.

## 5. Where to go next

- Setup, step by step: [examples/SETUP.md](../examples/SETUP.md).
- The wrapper and its environment variables: [examples/ideas/README.md](../examples/ideas/README.md).
- The Stop hook: [examples/hooks/claude-code/README.md](../examples/hooks/claude-code/README.md).
- How a full lessons notebook decides what to keep: [eviction-and-aging.md](./eviction-and-aging.md).
