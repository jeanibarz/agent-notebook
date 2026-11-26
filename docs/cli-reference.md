# CLI reference

*The details behind the [`## Usage`](https://github.com/jeanibarz/agent-notebook/blob/main/README.md#usage) block in the README: how to pick an entry, the commands that edit a shelf, how to find notebooks, and shell completion.*

`nb --help` prints the same usage lines, and `nb <command> --help` prints the help for one command. For the counters and logs behind `nb stats`, and for every environment variable, see [Operating `nb`](operating.md).

**Reading the command reference.** `<angle brackets>` mark a value you must replace (`<shelf>`, `<lesson>`), and `[square brackets]` mark an optional argument you can leave out (`[--since 7d]`). Type the value or flag, never the brackets themselves. A bare `--` ends option parsing: every token after it is a literal operand, so a lesson, description or query that is itself flag-shaped is passed verbatim (`nb add glossary -- --json` stores the line `--json`).

Run the blocks in order, starting from an empty notebooks folder: later ones continue the shelves (`reviewer`, `build-and-test`) that earlier ones create. The ones marked **Illustrative** assume shelves that already hold lessons; their output has the right shape, but your names, counts and paths will differ.

---

## Selecting an entry — `id` vs. `query`

Every command that acts on one entry — `vote`, `rm`, `merge`, `split`, `move` — takes a **selector** that is either:

- an **`id`** — the short stable code at the start of each `nb show` line (e.g. `acf179`), or a unique prefix of it (a short prefix made of digits or a-f, like `18` or `add`, is refused as ambiguous when it is also text in another lesson — use the full id); or
- a **`query`** — any unique text substring of the lesson (e.g. `lint before`).

Either way the selector must match **exactly one** entry. If it matches none, or more than one, the command changes nothing and lists the candidates so you can pick the one you mean.

Start a `reviewer` shelf with two lessons that say nearly the same thing, so there is something to select between:

```
$ nb add reviewer "run lint before claiming done"
added — 1 line
note: created new shelf "reviewer"

$ nb add reviewer "run the linter first"
added — 2 lines

$ nb show reviewer
acf179  [+1]  run lint before claiming done
dce866  [+1]  run the linter first
# vote by id: nb vote reviewer <id> +1|-1  ·  several at once: nb vote reviewer <id1,id2,…> +1
```

The `note:` line goes to stderr; the rest goes to stdout.

**Vote** an entry up or down — a vote also marks it recently used, which is what keeps it from aging out:

```
$ nb vote reviewer acf179 +1
+1 → [+2] run lint before claiming done
```

**Merge** two near-duplicate entries into one line (here one selected by `id`, one by `query`); the survivor inherits the higher of the two scores:

```
$ nb merge reviewer acf179 "linter first" "run lint before every commit"
merged two entries into one — 1 line

$ nb show reviewer
8ddce2  [+2]  run lint before every commit
# vote by id: nb vote reviewer <id> +1|-1  ·  several at once: nb vote reviewer <id1,id2,…> +1
```

**Remove** an entry you no longer want:

```
$ nb rm reviewer "lint before every commit"
removed — [+2] run lint before every commit
```

`rm` takes effect immediately and there is **no in-tool undo** — the line is gone from the notebook. Because a notebook is just a plain text file, though, a deleted lesson is recoverable with `git checkout`/`git revert` when the notebooks directory is under git (the [per-change git-versioning hook](harness-setup.md#git-versioning) sets that up).

## Splitting an overloaded entry

`nb split` is the reverse of `merge`: it replaces one entry with two, each inheriting the original's score — for when a line turned out to be two lessons crammed together. Each half is rejected (not truncated) if too long, and a split never creates a duplicate: the two halves must differ from each other and from every surviving entry, or the split is refused and nothing changes.

```
$ nb add build-and-test "run the build and then vitest"
added — 1 line
note: created new shelf "build-and-test"

$ nb split build-and-test build "run the build first" "run vitest after the build" --reason overloaded
split one entry into two — 2 lines
```

## Reason codes

You can tag a write command with why you ran it, for example on a lesson you still have: `nb rm <shelf> <id> --reason wrong`. The tag goes to the usage log only, never the notebook, so `nb stats` can show how often each reason comes up. Add `--note "<text>"` for free text.

`add`, `merge`, `rm`, `split`, `move` and `describe` accept the flags; `vote` takes neither. Each command has a short starter list of codes, which grows when many tags land in `other`:

- `merge` — `duplicate` (the two entries say the same thing — one is a reworded copy of the other) · `other`
- `rm` — `wrong` (the lesson is incorrect or misleading) · `obsolete` (it was true but no longer applies) · `other`
- `split` — `overloaded` (the entry crammed two distinct lessons into one line) · `other`
- `move` — `consolidate` (folding a thin or redundant shelf into a broader one — two situations turned out to be one) · `other`
- `add` — no codes yet: free text only, via `--note`, so its codes can come from the notes people actually write rather than be guessed up front
- `describe` — no codes yet (free text only, like `add`); the flags are accepted and stripped so a code meant for another command is never stored as the description

The reason is always optional (omit it rather than invent one). An unrecognized code is accepted as `other` with the code kept in the note, never rejected. If `other` becomes a large share of a command's tags, a new code is needed. Codes are per command: a code valid for one command counts as `other` on another.

## Describing a notebook

`nb describe <shelf> "<text>"` gives a notebook a one-line *description* — a **trigger** that says "the situation in which you should open me", so an agent (or a plain list of notebooks) can decide whether to open it without reading its lessons. It is stored as a leading `# desc:` comment at the top of the `<shelf>.md` file. Continuing the `build-and-test` shelf from the split above:

```
$ nb describe build-and-test "building or testing this repo, or working in a fresh worktree"
description set for shelf "build-and-test": building or testing this repo, or working in a fresh worktree
$ nb describe build-and-test           # no text → print the current one
building or testing this repo, or working in a fresh worktree
$ nb show build-and-test               # the description leads the output as a header
# desc: building or testing this repo, or working in a fresh worktree
900971  [+1]  run the build first
66e1b2  [+1]  run vitest after the build
# vote by id: nb vote build-and-test <id> +1|-1  ·  several at once: nb vote build-and-test <id1,id2,…> +1
```

The description is capped like a lesson (rejected, not truncated, if too long), and an empty text (`nb describe build-and-test ""`) clears it. The `# key: value` block round-trips through every mutation and is never turned into a lesson; unknown keys are preserved verbatim, so the file format stays forward-compatible. This stays within the no-schema non-goal — metadata is optional comment lines in the *file*, not a field on a lesson.

## Piping a lesson in

Pass `-` as the lesson to read it from stdin, so an agent that just wrote a lesson into a pipe can hand it over without shell-quoting. Continuing the same shelf:

```
$ printf '%s\n' 'run lint first' | nb add build-and-test -
added — 3 lines
```

It reads exactly one line: a single trailing newline is stripped, and **multi-line** input is refused (exit 1) rather than silently flattened into one run-together entry — one entry is one line. Because `-` means stdin, the one-character lesson `-` can't be stored through this form; use a non-dash quoted argument, or call the library's `addEntry` directly, if you ever need a literal hyphen. Everything else is unchanged — the piped line still goes through the same caps, dedup, and eviction as a quoted argument.

## Storage order vs. display order

Read a notebook with `nb show`, not by eyeballing the file. `nb show` sorts highest-scored first; the `<shelf>.md` file on disk does not, so a raw `cat` looks unordered. That is intentional, not a bug. In git, a vote shows up as a line *move* (a ~2-line diff) rather than a one-line edit.

The file is in *recency order*: least-recently-touched first. A *touch* (a vote of either sign, an add, or a merge/split's new lesson) moves its line to the end. So does the aging dock (the one point docked from the stalest line when a full shelf takes a new lesson). The top of the file is therefore the *stalest* lesson: the one that has gone longest since it was touched or docked.

Why: the order is the recency signal eviction needs, carried in line position at zero character cost, with no timestamp. Ids are derived from the lesson's text, so they stay stable when lines move. When the notebook is full, the lowest-scored line is evicted (on a tie, the stalest), and the stalest survivor is docked a point and moved to the end. ([Full rationale.](eviction-and-aging.md))

## Where the files live — `nb path`

`NB_DIR` overrides the storage directory (default `~/.agent-notebook/notebooks`); a leading `~` (or `~/…`) in `NB_DIR` is expanded by `nb` itself to your home directory — so `NB_DIR=~/notes` works even when the value comes from a source with no shell (`settings.json` `env`, systemd, cron, `.env`). `~user/…`, absolute and relative paths are used verbatim (pass an absolute path if you want no ambiguity). `NB_MAX_LINES` and `NB_MAX_CHARS` override the caps, if you need something other than the 50-line / 200-char defaults (see the [configuration table](https://github.com/jeanibarz/agent-notebook/blob/main/README.md#configuration)).

You never have to reconstruct that layout by hand — `nb path` prints the notebooks directory, `nb path <shelf>` the resolved file, and `nb path --usage` the usage-log path, so `cat "$(nb path reviewer)"`, `git diff "$(nb path reviewer)"`, or `tail -F "$(nb path --usage)"` just works. (Use `tail -F`, not `-f`: the usage log is periodically compacted by writing a new file and renaming it into place, so a `-f` tail following the old inode would silently go stale.) The usage-log filename may change, so resolve it through `nb path --usage` rather than hard-coding it.

## Discovering notebooks — `nb list`

`nb list` is the **notebook index**: one richest-first line per notebook — its name, lesson count, and one-line description — so an agent can decide *which* notebook to open without reading any of them: the cheap first step before opening any notebook. `ls` and `shelves` are aliases (`roles`, the old name, still works but is deprecated).

**Illustrative** (the folder path is shortened):

```
$ nb list
agent-notebook notebooks — 3 in /home/you/.agent-notebook/notebooks
  build-and-test   12  building or testing this repo, or working in a fresh worktree
  bug-fixing        8  when fixing a reproduced bug in this codebase
  repo-onboarding   3  mapping an unfamiliar repo: build/test entry points  (auto)
```

Notebooks are ordered **richest-first** (most lessons first — the ones most worth reusing), ties broken by name. A notebook with no `# desc:` falls back to its top-scored lesson, marked `(auto)`. A bare `prefix` filters by name using the `.` namespace convention (`nb list review.` shows just `review.*`), and `--limit N` bounds the rows (default 50) so the index stays a flat, cheap read as notebooks accumulate — the header then reads `N of total` (e.g. `50 of 53`) and, unless you passed `--limit` yourself, a final `#` line says how many notebooks were left out (the ones with the fewest lessons) and the `--limit` that lists them. `nb list --json` emits the raw `NotebookListing` (`{ dir, total, rows[] }`) for a supervising agent. An empty (zero-lesson, no-description) notebook is hidden — usually a leftover with nothing to discover — while a described-but-empty notebook is kept, because its description is still a deliberate trigger. It prints a friendly note to stderr and exits 0 when no notebook (or none matching the prefix) exists yet.

In a repository where the agent loop is [switched off](harness-setup.md#per-repository-onoff), the text form of `nb list` prints one line telling the agent to skip the notebook steps instead of the index; `nb list --json` is never affected.

## Grouping notebooks — the `.` namespace convention

When one shelf collects lessons needed in different situations, split it into **namespaced shelves** named with a `.`-delimited prefix — `review.tests`, `review.correctness`, `review.security` — instead of one overloaded `review`, so each shelf again holds lessons used together and the prefix keeps the family together. It is a **naming convention only**: nothing new to configure.

**Illustrative** (the folder path is shortened):

```
$ nb list review.
agent-notebook notebooks — 2 matching "review." in /home/you/.agent-notebook/notebooks
  review.correctness  9  reviewing a diff for logic bugs
  review.tests        4  reviewing test coverage and quality
```

- **Lexical clustering, no engine.** Related notebooks sort together and `nb list review.` / `nb search "flaky" review.` scope straight to the group — plain prefix matching on the name, never embeddings or similarity (non-goal [NG-001](requirements.md#ng-001): no embeddings or semantic search).
- **No prefix, or one level at most.** Most shelves need no prefix. When the index gets hard to scan, add one level (`family.situation`, e.g. `release.tagging`, `release.changelog`) and stop there. The dot builds no tree: no command groups, counts or opens a level. Deeper names (`ci.flaky.e2e.retries`) split lessons that are needed together across small shelves, lengthen the index every agent reads, and are hard to rename later because shelf names match exactly.
- **Keep the trailing dot.** `review.` matches the namespace but *not* a bare sibling that merely shares the stem (`reviews`), so the group stays exactly what you meant.
- **No new storage.** A namespaced shelf is still one flat `<shelf>.md` file — `review.tests.md`, `review.correctness.md` — never a directory. `.` is already a legal shelf character, so there is nothing to enable.
- **`@` is separate.** It stays reserved for the existing `shelf@project` scoping and composes with a namespace (`review.tests@your-repo`). [Memory layers](memory-layers.md) builds a naming convention on it.
- **`README` is reserved.** A `README.md` in the notebooks dir (common when the dir is a git repo that backs up your notebooks) is *not* a notebook — it is never listed, searched, counted, or writable as a shelf (case-insensitive). Name a real notebook something else (`readme-notes` is fine).
- **Case-variants of an existing shelf are refused.** Creating `foo` when `Foo` exists exits 1 naming `Foo` — they are one file on macOS/Windows, which breaks a git-synced notebook. Existing shelves and colliding pairs are left alone.

When a full shelf is a reason to divide it, and when it is not, is in [A full shelf is the normal state](eviction-and-aging.md#a-full-shelf-is-the-normal-state). The convention is specified in [FR-NAMESPACE-001](requirements.md#fr-namespace-001).

## Searching — the demoted fallback

`nb search <query>` exists, but it is deliberately the **secondary** path. The point of this tool is that a notebook is *shown* to you — injected at session start, picked from the [`nb list`](#discovering-notebooks--nb-list) index — because the lesson you most need is the one you would never think to search for (design principle [DP-8](requirements.md#dp-8), and non-goal [NG-007](requirements.md#ng-007): an agent never has to query to get its own memory). Reach for `search` only for a genuine known-item lookup.

It is **keyword-only** — a plain case-insensitive substring over the query's terms, no embeddings or similarity ranking — and scans every notebook's lessons *and* descriptions. By default it is AND-over-terms (an entry must contain every term); `--any` makes it OR. Hits group by notebook, most-relevant-first; each group's header carries the notebook's description, and each lesson line leads with its stable id so you can `vote` it afterwards.

**Illustrative** (a `build-and-test` shelf holding these two lessons):

```
$ nb search "build vitest"
agent-notebook search — "build vitest" (AND over 2 terms): 2 hits in 1 notebook (secondary fallback — lessons are normally surfaced to you, not searched)
  build-and-test  — building or testing this repo, or working in a fresh worktree
    66e1b2  [+1]  run vitest after the build
    d7497d  [+1]  run the build before vitest
```

A bare `prefix` scopes by name (`nb search lock review.`). `--limit N` bounds the notebook groups (default 50, like [`nb list`](#discovering-notebooks--nb-list)) so a common term can't dump every notebook — the header then reads `N of total notebooks`, and a bad value warns on stderr and falls back to the default. The limit shapes only what is shown: the `failed-search` coverage-gap signal and the surfaced-id provenance are always computed on the full result, so a small `--limit` never turns a real match into a recorded gap. `--json` emits the raw `SearchResult` (`{ terms, groups[], total, surfacedIds[] }`), where `groups` is the bounded set and `total` / `surfacedIds` are the full pre-limit result.

**A failed search is itself a signal.** When a search finds nothing it is not an error (exit 0) — it is logged (with your query), so that if you then `add` a lesson in the same session, `nb stats` reads the pair back as a **`failed-search`** diagnostic signal: a coverage gap the notebook did not hold, labelled by your own query. High search volume for a topic is exactly where *surfacing* is failing for that topic, and you flag it for free just by using the tool. See [Free diagnostic signals](operating.md#free-diagnostic-signals).

## The project name — `nb project`

`nb project` prints which project the current directory belongs to, the name that shelves of
that project end with (`<situation>@<name>`, see [memory layers](memory-layers.md)):

```sh
$ cd ~/git/agent-notebook && nb project --why
jeanibarz-agent-notebook (git remote origin)
```

The first rule that applies decides:

1. `NB_PROJECT_SLUG`, when set. No git runs.
2. The git `origin` remote: its path, the segments joined by `-`, the host left out.
   `git@github.com:acme/app.git` and `https://github.com/acme/app` both give `acme-app`;
   a GitLab group `a/b/c` gives `a-b-c`.
3. The name of the repository's folder, when there is no `origin`, or when `origin` is a local
   path or holds anything but letters, digits and `. _ ~ / -` in its path (a token, a `%`, a space).
4. Nothing (an empty line), outside a git repository, or when git is missing, takes more than
   2 seconds, or refuses the folder ("dubious ownership").

Every name is lower case, made of `a-z 0-9 . _ -`, at most 100 characters. A remote URL is never
printed. Two forms of one repository can give two names on some hosts (Azure DevOps over ssh
and https, Bitbucket Server's `/scm/` prefix); set `NB_PROJECT_SLUG` for such a repository, for
example in its `.claude/settings.local.json` `env` block. The name includes the remote's owner,
often an employer or a client; set `NB_PROJECT_SLUG` to choose another.

`--why` adds the rule that decided and, when it differs, the name nb 0.12 gave the
retrospective's `{project}` (the folder holding the repository's `.git`), so shelves written
under that name can be found; `--json` prints `{name, source, reason}`, with `source` one
of `env`, `remote`, `folder`, `none` (`reason` is prose for people; scripts should read
`source`). It exits 0 in every case.

## Where a project's lessons live — `nb place`

A project has its own notebook when the folder `~/.agent-notebook/projects/<project>/` exists,
`<project>` being the name `nb project` prints. Otherwise it uses the shared notebook,
`~/.agent-notebook/notebooks`. There is no setting: making the folder is the switch.

```sh
$ mkdir -p ~/.agent-notebook/projects/acme-app
$ cd ~/git/app && nb place
own: /home/you/.agent-notebook/projects/acme-app
  project acme-app (git remote origin) has its own notebook. It is kept on this computer, separate from the notebook your other projects share, and does not include that notebook's general shelves.
project folders (1): acme-app
```

- **`NB_DIR` wins.** When it is set, every project uses it and `projects/` is not read
  (`env: <dir>`).
- **Only a name from `NB_PROJECT_SLUG` or the git remote selects a folder.** A name taken from the
  repository's folder (no `origin`, or a clone made from a local path) does not, because another
  copy of the repository may sit in a folder with another name.
- **The project's shelves stay in its folder.** From anywhere else (a plain folder, another
  repository, git missing), a write to a shelf `<x>@<project>` of a project that has its own folder
  is refused, so its lessons never land in the shared notebook by accident. `nb rm` and moving a
  lesson *out of* such a shelf still work.
- **`unknown`.** When a project folder exists and git times out, or refuses the folder for its
  owner, nb cannot tell which notebook to use: every notebook command exits 1 with the error
  class `place_unknown` and reads and writes nothing. A missing git is not such a case.
- **What moves with it:** the usage log (and so `nb stats`) and `.nb.json` are per folder. The
  retrospective's once-per-session marker stays in the shared notebook.

`--json` prints `{kind, dir, shared, project, reason, folders}`, `kind` being `own`, `shared`,
`env` or `unknown`. It exits 0 in every case. Once a project folder exists, every notebook command
in a repository without `NB_PROJECT_SLUG` runs `git` twice (a few milliseconds) to learn the name;
without a `projects/` folder no process is started.

## The start-of-session text — `nb brief`

`nb brief` prints what an assistant should see at the start of a session: the
instruction lines, one line framing the lessons as notes from earlier agent runs (not
instructions from the user), and the notebook index. A harness's start hook shows the
model whatever it prints. It reads no hook payload and exits 0 in every runtime state.

```sh
nb brief                      # instructions + the index (the 50 richest shelves)
nb brief --max-chars 3000     # a smaller budget, e.g. for subagents
nb brief --json               # {"outcome":"index|layered|empty|broken|off","text":"…"}
```

- **Off** (see `nb enabled`) prints one line telling the agent to skip the notebook steps.
- **Layered**: the index is grouped into this project's shelves (`<situation>@<name>`),
  the bare domain shelves and the global shelf (`NB_GLOBAL_SHELF`, default `global`); see
  [memory layers](memory-layers.md). The name is `NB_PROJECT_SLUG` when set. Unset, it is the
  name [`nb project`](#the-project-name--nb-project) derives from the git `origin` remote, used
  only when a shelf name in the store already contains `@`; a store without one keeps the flat
  index, and a name from the folder (no remote) never groups it.
- **Budget**: over `--max-chars` (default 9000; `0` = none) the shelves with the fewest
  lessons are dropped, whatever their layer, and the last line says how many and gives
  the `nb list --limit` command that shows them. Claude Code shows hook output whole
  only up to 10,000 characters.
- **Safe to show a model**: control characters and line separators in a name, a
  description, the folder path or the slug are shown as `\uXXXX`, so no value can
  start a line of its own.

## The end-of-task retrospective — `nb retro`

`nb retro --session <id>` prints the end-of-task retrospective text (vote, prune, add at
most one lesson) the first time it is called for a session, and nothing afterwards. A
harness's stop hook can therefore call it on every stop and show the model whatever it
prints. It reads no hook payload and exits 0 in every runtime state.

```sh
nb retro --session "$SESSION_ID"                # the text, once; nothing on later calls
nb retro --session "$SESSION_ID" --json         # {"outcome":"nudge|already|off|off-work-dir","text":"…","session":"…"}
nb retro --session "$SESSION_ID" --work-dir "$PWD_OF_THE_AGENT"   # also ask the on/off switch there
```

- **Once per session** is decided by creating `<NB_DIR>/.retro-<id>` exclusively, the file
  the 0.12 example Stop hook creates, so an old copied hook and this command nudge once
  between them. The id keeps only `A-Za-z0-9._-` (others become `_`), at most 128
  characters, and a leading `-` becomes `_`. `.retro-*` files older than
  `NB_RETRO_TTL_DAYS` (7) are removed after the claim attempt (unless the session was already claimed).
- **Off** (see `nb enabled`) in the working directory prints nothing and keeps the claim;
  off only in `--work-dir` prints nothing and releases it, so a later stop from an on
  directory still nudges.
- **`NB_RETRO_EXTRA_PROMPT`**, an absolute path (a leading `~/` is expanded) to a regular
  UTF-8 file of at most 64 KiB, is appended after a blank line, with `{project}` and
  `{session}` filled in. `{project}` is the name `nb project` prints in `--work-dir` (else the
  working directory). Anything else prints a warning on stderr and the text goes alone.
- **`--hook <label>`** is for adapters: it is recorded in the usage log's note column and
  never changes the output. A call that finds the session already claimed logs no row.

The example Claude Code hooks ([`examples/hooks/claude-code/`](../examples/hooks/claude-code/README.md)) are a thin adapter around these two commands: they read the hook payload, skip the stops that must not nudge, and wrap the text in Claude Code's reply format (issue #538).

## Shell completion

`nb` is run dozens of times a session, so it ships tab-completion for **bash** and **zsh**. `nb completion <bash|zsh>` prints a static, dependency-free script to stdout; source it to complete the command set and — where a command takes a shelf — existing shelf names:

```bash
# bash — add to ~/.bashrc:
eval "$(nb completion bash)"

# zsh — add to ~/.zshrc (after `autoload -U compinit && compinit`):
eval "$(nb completion zsh)"
```

Then `nb <TAB>` completes to the commands, and `nb show <TAB>` completes to your existing shelf names (looked up with `nb list`). The shelf lookup is guarded — it discards errors and never hangs or breaks your shell, just offering no suggestions if anything goes wrong.

Prefer installing the script instead of sourcing it each shell start? The emitted files are also shipped with the package under [`examples/completion/`](../examples/completion/) (e.g. `nb completion bash > /etc/bash_completion.d/nb`).

## Deprecated aliases

Earlier versions called a shelf a "role". The old names still work as deprecated aliases: the `nb roles` command (an alias of `nb list`), the `role` keys in JSON output (a copy of `shelf`), and the library's `listRoles` and `assertSafeRole`. New code should use the shelf names.
