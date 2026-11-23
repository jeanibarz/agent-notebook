# The ideas store: `nb-ideas`

`nb-ideas` records **improvement ideas**: things a task showed should be deleted,
merged, shortened, split, corrected or made to fail loudly. It wraps the real `nb`
CLI and keeps the ideas in a notebooks folder of their own, so your lessons
notebooks are never touched. Agents record at most one idea per task, in one fixed
line format; a periodic curator (a person or an agent) reads which ideas several
different tasks hit and promotes only those. Nothing is shown to agents at session
start. The concept and the reasons for each rule are in
[the ideas-store guide](https://github.com/jeanibarz/agent-notebook/blob/main/docs/ideas-store.md).

A line looks like this and lives on a shelf named `<category>@<project>`:

```text
<target>: <problem> -> <change> (keeps: <behaviour that must keep working>)
```

## Install

Keep `nb-ideas.mjs` where the package ships it and put a two-line shim on your
`PATH` (the shim keeps the `.mjs` name, which older Node needs to run an ES module):

```sh
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$(npm root -g)/agent-notebook/examples/ideas/nb-ideas.mjs" > ~/.local/bin/nb-ideas
chmod +x ~/.local/bin/nb-ideas     # ~/.local/bin must be on PATH
```

It finds the `agent-notebook` package it ships in (or the global npm root) and runs
that package's own CLI. Needs Node 18 or newer. To prompt agents at the end of a
task, add the [ideas Stop hook](../hooks/claude-code/README.md#ideas-prompt-nb-ideas-stopsh).
For a step-by-step setup see [`../SETUP.md`](../SETUP.md).

## Commands

The runs below use a throwaway folder (`NB_IDEAS_DIR=$(mktemp -d)/ideas`) and
`--project my-app`; the task id comes from `NB_SESSION`. Ids are derived from the
line, so you get the same ones.

```sh
$ NB_SESSION=task-1 nb-ideas add dead "scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)" --project my-app
added 9d7734 to dead@my-app
```

`add <category> "<line>"` checks the category and the line format, then looks at
every idea of the project (all its shelves). An identical line becomes a +1 vote. A
line with the same target (case-insensitive) or a similar text (character-trigram
similarity at least `NB_IDEAS_SIMILARITY`) is not recorded: the matches are printed
and the exit code is 3. `--new` records it anyway; `--because` gives the reason when
the add turns into a vote.

```sh
$ NB_SESSION=task-2 nb-ideas add dead "scripts/old-sync.sh: nothing calls it -> remove the script (keeps: the nightly backup job)" --project my-app
Not recorded: similar ideas already exist.
  dead@my-app  9d7734  [1]  similarity 0.60, same target
    scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
If one of them is what you hit, vote for it:
  nb-ideas vote <shelf> <id> +1 --because "<what in this task hit it>"
If yours is a different idea, record it anyway:
  re-run the same command with --new
```

`vote <shelf-or-category> <id> <+1|-1>` votes on an idea; a bare category means
`<category>@<project>`. A +1 needs `--because`.

```sh
$ NB_SESSION=task-2 nb-ideas vote dead 9d7734 +1 --because "grep found no caller while tracing the sync step" --project my-app
voted +1 on dead@my-app 9d7734: score is now 2
$ NB_SESSION=task-3 nb-ideas add dead "scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)" --project my-app --because "still unused"
identical idea already recorded in dead@my-app; counted as a vote
voted +1 on dead@my-app 9d7734: score is now 3
```

`show` lists all of a project's ideas in one view, highest score first
(`--json` for scripts). `support` is the curator report: per idea, its score and
the number of distinct tasks that support it (by adding it, or by voting +1 with a
reason); events with no `NB_SESSION` count as one task each and the row says how many.
Promotable ideas come first.

```sh
$ nb-ideas show --project my-app
dead@my-app  9d7734  [3]  scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
fragile@my-app  d07830  [1]  src/fetch.ts: a failed request is swallowed and returns an empty list -> throw instead (keeps: the retry on a 503)
$ nb-ideas support --project my-app
promotable = score >= 3 and supporting tasks >= 2
PROMOTABLE  dead@my-app  9d7734  [3]  tasks 3  scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
-           fragile@my-app  d07830  [1]  tasks 1  src/fetch.ts: a failed request is swallowed and returns an empty list -> throw instead (keeps: the retry on a 503)
```

`prompt [--session ID] [--project P]` prints the end-of-task text the Stop hook
shows the agent (with `--session`, its commands are prefixed `NB_SESSION=<ID> `).
`categories` prints the categories, one `name: definition` per line, in tie-break
order. `help` prints usage. Anything else (`list`, `rm`, `describe`, `doctor`,
`stats`, `path`, `merge`, ...) is passed to `nb` with the ideas folder and caps set:

```sh
$ nb-ideas rm dead@my-app 9d7734 --reason other --note "promoted: https://example.com/issues/12"
removed — [+3] scripts/old-sync.sh: no caller since the CI move -> delete it (keeps: the nightly backup job)
```

When `NB_SESSION` is unset, `add` and `vote` print a note to stderr, skip the
per-task rules and count each event as its own task.

## Rules and exit codes

- The category must be in the list; the line must match the format. `nb` itself
  rejects a line longer than `NB_IDEAS_MAX_CHARS`.
- One `add` per task (per `NB_SESSION` and project); further ideas are votes.
  Votes that an `add` turned into do not count as adds.
- A task votes once per idea and never +1s an idea it added.
- The project is `--project`, else `NB_IDEAS_PROJECT`, else the basename of the git
  root of the working directory, lower-cased with characters outside `a-z 0-9 . _ -`
  replaced by `-`. If none gives a name, the command is refused.

| Exit | Meaning |
|---|---|
| `0` | done |
| `2` | refused by a rule, or bad usage; the message says which rule and what to do |
| `3` | `add` found similar ideas and recorded nothing |
| other | the exit code of `nb` itself (for passed-through commands and `nb` failures) |

## Side log

Every add and vote made through the wrapper is appended to
`$NB_IDEAS_DIR/.ideas-support.log`, tab-separated, one event per line:

```text
<iso-time>	<session>	<event>	<shelf>	<id>	<delta>	<reason>
```

`event` is `add` or `vote`; `delta` is `+1` or `-1` on a vote and empty on an add;
`session` is the cleaned `NB_SESSION` (empty if unset); tabs and newlines in the
reason become spaces and the reason is cut at 300 characters. `nb-ideas support`
counts supporting tasks from this file. It is a dotfile, so `nb list` ignores it.

## Categories

Default list, in tie-break order (if two fit, take the first); each definition is
the shelf description the first time the category is used.

| Category | Meaning |
|---|---|
| `guidance` | a doc, rule, comment or help text is wrong, stale or redundant: correct, shorten or delete it |
| `dead` | code, flag, file, script or config that nothing uses: delete it |
| `duplicate` | the same logic, rule or data in two places: merge it |
| `overbuilt` | an abstraction, indirection, option or layer more complex than the job: inline or collapse it |
| `tangled` | mixed responsibilities or code in the wrong layer: split or move it |
| `unused` | a working feature or option that is rarely used or confusing: remove or unify it (the curator asks a human) |
| `fragile` | a swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result: make it fail loudly and simply |
| `tests` | a tautological, duplicated, flaky or slow test, or one tied to implementation details: delete, merge or rewrite it |

To use your own list, put a `categories.txt` in `NB_IDEAS_DIR`: one
`name: definition` per line, `#` comments and blank lines allowed, names made of
`a-z`, `0-9` and `-`. The file replaces the defaults and its order is the
tie-break order. No feature category ships: the store is for simplification.


## The curator recipe

Run it on a schedule, for example weekly. A person or an agent can do it.

1. `nb-ideas support --project my-app` lists the ideas and marks the `PROMOTABLE` ones.
2. Check each promotable idea against the code, by category:

   | Category | Check |
   |---|---|
   | `dead` | a search finds no use outside its own tests |
   | `duplicate` | both copies exist |
   | `unused` | look for usage evidence; a human decides |
   | `fragile` | reproduce it |
   | `guidance` | the quoted text is still there |
   | `overbuilt`, `tangled` | usually need a design first |
   | `tests` | run the test, or check what a mutation does to it |

   A deletion idea is not verified by asking "does something already do this?";
   that question finds a reason to keep everything. Check that nothing uses it, and
   that a test covers the `keeps:` behaviour before planning the deletion.
3. File a work item in your tracker for each idea that passes.
4. Remove the idea, keeping the link:
   `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link>"`.
5. For an idea that fails its check, `nb-ideas rm <shelf> <id> --reason wrong`
   (or `--reason obsolete` if the code has changed since).

### Curator prompt

Paste this to an agent that runs the job (replace `my-app`):

```text
You are the weekly curator of the ideas store for the project my-app. Do not
change any code; your output is work items and a cleaned-up store.
1. Run `nb-ideas support --project my-app`. Work only on the PROMOTABLE rows.
2. For each one, check it against the code, by the category in its shelf name:
   dead: search for uses outside its own tests; duplicate: confirm both copies
   exist; unused: gather usage evidence and leave the decision to a human (ask);
   fragile: reproduce the failure; guidance: confirm the quoted text is still
   there; overbuilt and tangled: these usually need a design, so file a work item
   asking for one; tests: run the test, or check what a mutation does to it.
   Do not verify a deletion by asking "does something already do this?". Check
   that nothing uses it, and that a test covers the `keeps:` behaviour; if none
   does, say so in the work item.
3. For an idea that holds up, file a work item in the tracker with the idea line,
   the evidence you found and the `keeps:` behaviour. Then run
   `nb-ideas rm <shelf> <id> --reason other --note "promoted: <link to the item>"`.
4. For an idea that fails its check, run
   `nb-ideas rm <shelf> <id> --reason wrong` (or `--reason obsolete` if the code
   has changed since). Leave unpromotable ideas alone.
5. Finish with a list: one line per idea, with what you did and why.
```

## Environment

| Var | Default | Meaning |
|---|---|---|
| `NB_IDEAS_DIR` | `~/.agent-notebook/ideas` | the ideas folder, a notebooks folder of its own (a leading `~` is expanded). Read by `nb-ideas.mjs` and `nb-ideas-stop.sh` |
| `NB_IDEAS_MAX_CHARS` | `400` | line cap, passed to `nb` as `NB_MAX_CHARS` |
| `NB_IDEAS_MAX_LINES` | `50` | per-shelf cap, passed to `nb` as `NB_MAX_LINES` |
| `NB_IDEAS_PROJECT` | basename of the git root of the working directory | project slug (lower-cased); the `--project` flag wins |
| `NB_IDEAS_SIMILARITY` | `0.4` | `add` refuses (exit 3) an idea at least this similar to an existing one |
| `NB_IDEAS_PROMOTE_SCORE` | `3` | `support`: minimum score to be promotable |
| `NB_IDEAS_PROMOTE_TASKS` | `2` | `support`: minimum distinct supporting tasks to be promotable |
| `NB_IDEAS_BIN` | `nb-ideas` | the command `nb-ideas-stop.sh` runs to get the end-of-task prompt |
| `NB_SESSION` | unset | the task id: turns on the per-task rules and the support counts |
| `NB_BIN` | the package's own `nb` | the `nb` command `nb-ideas.mjs` runs (for example the git wrapper); `nb-ideas-stop.sh` uses it for `nb enabled` |
| `NB_RETRO_TTL_DAYS` | `7` | days an `.ideas-prompt-<session>` sentinel survives before `nb-ideas-stop.sh` prunes it |

`nb-ideas.mjs` never reads the caller's `NB_DIR`, `NB_MAX_CHARS` or `NB_MAX_LINES`:
it sets all three for the `nb` it runs, from the `NB_IDEAS_*` values above.
