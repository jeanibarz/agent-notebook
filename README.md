# agent-notebook

A bounded, voted, plain-text memory for AI agents — one small file per role, no embeddings, no vector DB, no network call.

<p align="center"><img src="https://raw.githubusercontent.com/jeanibarz/agent-notebook/main/assets/cat.svg" alt="Running cat on a notebook file prints the whole plain-text memory at once — no query, no server, no embeddings." width="760"></p>

```
$ nb add reviewer "run lint before claiming done"
added — 1 lines

$ nb show reviewer
3f9a2c  [+1]  run lint before claiming done

$ nb vote reviewer 3f9a2c +1
+1 → [+2] run lint before claiming done
```

## Why

Most "agent memory" tooling reaches for a vector database the moment anyone says the word "memory." Most agents don't need one. If what you actually want is "let this agent remember a handful of short, durable lessons across runs," a notebook is enough: a capped, append-and-vote text file that a human can `cat`, `grep`, and diff in git.

The point of durable memory isn't to answer the questions an agent knows to ask — it's to put the hard-won lesson it would otherwise forget to look for back in front of it. So a notebook is *shown* to the agent, not searched; the lessons it needs arrive without it having to name them.

`agent-notebook` is the whole mechanism, nothing more:

- **One entry = one line.** `<score>\t<lesson>`, at most 200 characters, no multi-paragraph notes.
- **Bounded.** At most 50 lines per role by default (raise with `NB_MAX_LINES`). When full, the lowest-scored line is evicted first — harmful or useless lessons leave, useful ones survive.
- **Voted, not aged.** An agent votes +1/-1 on a lesson it used. No decay curve, no relevance scoring, no scheduler.
- **Plain text.** `~/.agent-notebook/notebooks/<role>.md`. Readable, diffable, greppable, backed up by whatever already backs up your home directory.

The cap and the vote are the whole mechanism. A new lesson enters at the `+1` floor; a vote lifts it past its neighbours by score; and when the file is full the *lowest-scored* line is evicted — never the oldest:

<p align="center"><img src="https://raw.githubusercontent.com/jeanibarz/agent-notebook/main/assets/leaderboard.svg" alt="A fixed 6-of-6 notebook: a +1 vote lifts a line past its neighbour by score, and a new lesson enters at the +1 floor while the lowest-scored line is evicted." width="760"></p>

## What it deliberately does not do

Naming the non-goals matters more than listing features — if any of this is what you need, this is the wrong tool:

- No embeddings, no semantic search, no similarity ranking.
- No long-form notes, summaries, or documents — one line, period.
- No network calls, no server, no sync between machines.
- No multi-field schema — a lesson is a string, a score is an integer.

If you need retrieval over large unstructured context, use a real vector store. This solves a narrower problem: a short list of hard-won, durable lessons an agent should keep seeing.

Because a notebook is a plain file in a git-backed directory, everything your agent learns is a line you can review — an added lesson is a green `+`, a recorded vote a `-`/`+` score change. You cannot `git diff` a vector DB:

<p align="center"><img src="https://raw.githubusercontent.com/jeanibarz/agent-notebook/main/assets/gitdiff.svg" alt="git diff on a notebook file: an added lesson shows as a green plus line and a recorded vote as a minus/plus score change — memory you can code-review." width="760"></p>

## Install

```
npm install -g agent-notebook
```

Or run it straight from a clone, without installing globally:

```
git clone https://github.com/jeanibarz/agent-notebook.git
cd agent-notebook
npm install
npm run build
npm link   # puts `nb` on your PATH, pointing at this clone
```

## Guides

New here, or wiring it into a real agent? These pick up where the reference below leaves off:

- **[Getting started](docs/getting-started.md)** — the plain-language intro (no AI/DevOps background needed), with diagrams. There's also a one-page [visual explainer](docs/visual-explainer.html).
- **[Harness setup](docs/harness-setup.md)** — make your agent use the notebook *automatically*: session-start injection, end-of-task retrospective, per-change git-versioning, daily backup, and a diagnostics janitor — for **Claude Code** and **Codex CLI**, on Linux/macOS/Windows.
- **[Enterprise integration](docs/enterprise.md)** — rolling it out under data-sovereignty, security, and compliance constraints.
- **[AGENTS.md](AGENTS.md)** — the operating contract an agent follows (also the `CLAUDE.md` your harness loads). Copy-pasteable integration pieces live in [`examples/`](examples/).

## Usage

```
nb show   <role>                        print the notebook (highest-scored first)
nb add    <role> "<lesson>"             add a lesson (dedup-skipped; rejected if too long, never truncated)
nb add    <role> -                      read the lesson from stdin (one line; multi-line is refused)
nb vote   <role> <id|query> +1|-1       upvote/downvote an entry you used
nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
nb split  <role> <id|query> "<a>" "<b>" cut one overloaded entry into two (reverse of merge)
nb rm     <role> <id|query>             delete an entry
nb describe <role> ["<text>"]           set the notebook's one-line description (no text → print it)
nb search <query> [prefix] [--any]      SECONDARY keyword fallback — scan all notebooks (surfacing is primary)
nb stats  [<role>] [--since 7d] [--json] usage analytics + anomaly/diagnostic flags + surfacing metrics (--json emits the raw StatsReport)
nb path   [<role>]                      print the notebooks dir, or a role's resolved file path
nb list   [prefix] [--limit N]          index notebooks richest-first: one line each (name, lessons, description)
nb ls / nb roles                        aliases of `nb list`
nb --help                               show this help
```

Every `show` line starts with a short stable id — pass that id (or a unique prefix, or a unique text substring) to `vote`/`rm`/`merge`/`split`. An over-long `add` is rejected outright, never silently truncated, so you rewrite it shorter instead of storing a cut-off, useless lesson.

**Splitting an overloaded entry.** `nb split` is the reverse of `merge`: it replaces one entry with two, each inheriting the original's score — for when a line turned out to be two lessons crammed together. Each half is rejected (not truncated) if too long, and a split never creates a duplicate: the two halves must differ from each other and from every surviving entry, or the split is refused and nothing changes.

```
$ nb split reviewer build "run the build first" "run vitest after the build" --reason overloaded
split one entry into two — 2 lines
```

The optional `--reason <code>` (and `--note "<text>"`) is recorded in the usage log only — never in the notebook — so each op's rate-by-reason becomes a diagnostic signal. It is accepted by **every** mutating op, each with its own *seed-and-grow* vocabulary:

- `merge` — `duplicate` (the two entries say the same thing — one is a reworded copy of the other) · `other`
- `rm` — `wrong` (the lesson is incorrect or misleading) · `obsolete` (it was true but no longer applies) · `other`
- `split` — `overloaded` (the entry crammed two distinct lessons into one line) · `other`
- `add` — no enum yet: free text only via `--note`, so `add`'s codes can emerge from mined notes rather than be guessed up front
- `describe` — no enum yet (free text only, like `add`); the flags are accepted and stripped so a code learned from the other write commands is never stored as the description

The reason is always optional (omit it rather than invent one). An unrecognized code is accepted as `other` with the code kept in the note, never rejected — the `other` rate is the thermostat that tells us when a new reason code should be minted. Codes are per-op: a code valid for one op buckets to `other` on another.

**Describing a notebook.** `nb describe <role> "<text>"` gives a notebook a one-line *description* — a **trigger** that says "the situation in which you should open me", so an agent (or a plain list of notebooks) can decide whether to open it without reading its lessons. It is stored as a leading `# desc:` comment at the top of the `<role>.md` file:

```
$ nb describe reviewer "build / test / worktree gotchas for this repo"
description set for role "reviewer": build / test / worktree gotchas for this repo
$ nb describe reviewer           # no text → print the current one
build / test / worktree gotchas for this repo
$ nb show reviewer               # the description leads the output as a header
# desc: build / test / worktree gotchas for this repo
acf179  [+1]  run lint before claiming done
```

The description is capped like a lesson (rejected, not truncated, if too long), and an empty text (`nb describe reviewer ""`) clears it. The `# key: value` block round-trips through every mutation and is never turned into a lesson; unknown keys are preserved verbatim, so the file format stays forward-compatible. This stays within the no-schema non-goal — metadata is optional comment lines in the *file*, not a field on a lesson.

**Piping a lesson in.** Pass `-` as the lesson to read it from stdin, so an agent that just wrote a lesson into a pipe can hand it over without shell-quoting:

```
$ printf '%s\n' 'run lint first' | nb add reviewer -
added — 1 lines
```

It reads exactly one line: a single trailing newline is stripped, and **multi-line** input is refused (exit 1) rather than silently flattened into one run-together entry — one entry is one line. Because `-` means stdin, the one-character lesson `-` can't be stored through this form; use a non-dash quoted argument, or call the library's `addEntry` directly, if you ever need a literal hyphen. Everything else is unchanged — the piped line still goes through the same caps, dedup, and eviction as a quoted argument.

**Storage order vs. display order.** `nb show` sorts highest-scored first, but the `<role>.md` file on disk is stored in *insertion order*, not sorted — so a raw `cat` of the file looks unordered, and that is intentional, not a bug. Sorting happens only at display time: ids are content-derived (stable across reordering), the lowest-scored line is evicted regardless of position, and keeping insertion order means a `vote` rewrites exactly one line in place — the smallest, most stable git diff — and preserves the "ties → oldest" tie-break that both display and eviction rely on. Read a notebook with `nb show`, not by eyeballing the file.

`NB_DIR` overrides the storage directory (default `~/.agent-notebook/notebooks`); `NB_MAX_LINES` and `NB_MAX_CHARS` override the caps, if you need something other than the 50-line / 200-char defaults. You never have to reconstruct that layout by hand — `nb path` prints the notebooks directory and `nb path <role>` the resolved file, so `cat "$(nb path reviewer)"` or `git diff "$(nb path reviewer)"` just works.

### Discovering notebooks — `nb list`

`nb list` is the **notebook index**: one richest-first line per notebook — its name, lesson count, and one-line description — so an agent can decide *which* notebook to open without reading any of them (level 1 of progressive disclosure). `ls` and `roles` are aliases.

```
$ nb list
agent-notebook notebooks — 3 in /home/you/.agent-notebook/notebooks
  reviewer   12  build / test / worktree gotchas for this repo
  patcher     8  when fixing a reproduced bug in this codebase
  scout       3  mapping an unfamiliar repo: build/test entry points   (auto)
```

Notebooks are ordered **richest-first** (most lessons first — the ones most worth reusing), ties broken by name. A notebook with no `# desc:` falls back to its top-scored lesson, marked `(auto)`. A bare `prefix` filters by name using the `.` namespace convention (`nb list review.` shows just `review.*`), and `--limit N` bounds the rows (default 50) so the index stays a flat, cheap read as notebooks accumulate — the header then reads `showing N of total`. `nb list --json` emits the raw `NotebookListing` (`{ dir, total, rows[] }`) for a supervising agent. An empty (zero-lesson, no-description) notebook is hidden — it is phantom debris with nothing to discover — while a described-but-empty notebook is kept, because its description is still a deliberate trigger. It prints a friendly note to stderr and exits 0 when no notebook (or none matching the prefix) exists yet.

### Grouping notebooks — the `.` namespace convention

When one role grows several distinct concerns, split them into **namespaced notebooks** named with a `.`-delimited prefix — `review.tests`, `review.correctness`, `review.security` — instead of one overloaded `review`. This is the recommended way to "group by concept", and it is a **naming convention only**: nothing new to configure.

```
$ nb list review.
agent-notebook notebooks — 2 matching "review." in /home/you/.agent-notebook/notebooks
  review.correctness   9  reviewing a diff for logic bugs
  review.tests         4  reviewing test coverage and quality
```

- **Lexical clustering, no engine.** Related notebooks sort together and `nb list review.` / `nb search "flaky" review.` scope straight to the group — plain prefix matching on the name, never embeddings or similarity ([NG-001](docs/requirements.md#ng-001)).
- **Keep the trailing dot.** `review.` matches the namespace but *not* a bare sibling that merely shares the stem (`reviewer`), so the group stays exactly what you meant.
- **No new storage.** A namespaced role is still one flat `<role>.md` file — `review.tests.md`, `review.correctness.md` — never a directory. `.` is already a legal role character, so there is nothing to enable.
- **`@` is separate.** It stays reserved for the existing `role@project` scoping and composes with a namespace (`review.tests@your-repo`).
- **`README` is reserved.** A `README.md` in the notebooks dir (common when the dir is a git repo that backs up your notebooks) is *not* a notebook — it is never listed, searched, counted, or writable as a role (case-insensitive). Name a real notebook something else (`readme-notes` is fine).

See [FR-NAMESPACE-001](docs/requirements.md#fr-namespace-001).

### Searching — the demoted fallback

`nb search <query>` exists, but it is deliberately the **secondary** path. The point of this tool is that a notebook is *shown* to you — injected at session start, picked from the [`nb list`](#discovering-notebooks--nb-list) index — because the lesson you most need is the one you would never think to search for ([DP-8](docs/requirements.md), [NG-007](docs/requirements.md#ng-007)). Reach for `search` only for a genuine known-item lookup.

It is **keyword-only** — a plain case-insensitive substring over the query's terms, no embeddings or similarity ranking — and scans every notebook's lessons *and* descriptions. By default it is AND-over-terms (an entry must contain every term); `--any` makes it OR. Hits group by notebook, most-relevant-first, and each lesson line leads with its stable id so you can `vote` it afterwards:

```
$ nb search "build vitest"
agent-notebook search — "build vitest" (AND over 2 terms): 1 hit in 1 notebook (secondary fallback — lessons are normally surfaced to you, not searched)
  reviewer
    d7497d  [+1]  run the build before vitest
```

A bare `prefix` scopes by name (`nb search lock review.`), and `--json` emits the raw `SearchResult` (`{ terms, groups[] }`).

**A failed search is itself a signal.** When a search finds nothing it is not an error (exit 0) — it is logged (with your query), so that if you then `add` a lesson in the same session, `nb stats` reads the pair back as a **`failed-search`** diagnostic signal: a coverage gap the notebook did not hold, labelled by your own query. High search volume for a topic is exactly where *surfacing* is failing for that topic, and you flag it for free just by using the tool.

### Machine-readable `nb stats`

`nb stats --json` prints the raw `StatsReport` to stdout as a single JSON object instead of the human table, so a supervising agent can act on a `loop` / `went-silent` / `high-error-rate` anomaly without regex-parsing formatted text. The shape is the exported `StatsReport` interface (`{ window, totalCalls, perCommand[], anomalies[], notebooks[], notebookTotals, signals[], surfacing }`) and is a stable, additive-only contract. `notebooks` is the per-role inventory — `{ role, lines, cap }` for each role's notebook, where `lines` is the stored-lesson count and `cap` is `maxLines()` — so a supervisor can see that a role is at (or near) its cap and about to evict a lesson; `notebookTotals` aggregates it as `{ roles, lines, cap }`. The inventory is the current on-disk state, not a slice of the usage window. It composes with `[<role>]` and `--since`; a bad `--since` window still warns on stderr (stdout stays pure JSON) and falls back to 7d.

### Free diagnostic signals

`nb stats` also surfaces a handful of **free diagnostic signals** — memory-quality observations read straight from the usage log, costing no new agent action because each is already implied by behaviour the agent performs for its own reasons. They appear in the human table under a `signals:` section and in `--json` as `signals[]` (each a `DiagnosticSignal` = `{ kind, role, detail, session?, entry? }`). The kinds:

- **browse-without-use** — a notebook was `show`n in a session but nothing in it was voted that session → its description may over-promise (it drew a look that didn't pay off).
- **eviction-while-still-voted** — the cap evicted an entry (`add`'s `evicted` column) whose id had been voted on → the cap may be too tight for that role, a candidate to split the role.
- **vote-reversal** — the same entry was upvoted in one session and downvoted in another → the lesson may be correct but *mis-aimed* (right in one context, wrong in another).
- **failed-search** — a [`nb search`](#searching--the-demoted-fallback) returned nothing and a lesson was then `add`ed in the same session → a coverage gap the notebook did not hold, labelled by the agent's own query.

All four are **session-aware**, so set `NB_SESSION` (a hook or supervising agent does this) for them to attribute calls to a session — browse-without-use, vote-reversal, and failed-search need it, and skip calls with a blank session. Like the anomalies, they are computed over the windowed, role-scoped usage rows (so `--since` and `[<role>]` apply). They are deliberately heuristic *hints*, not verdicts: a glance that didn't lead to a vote isn't proof a description is bad, just a place worth a look.

### Surfacing metrics

Beside the free signals, `nb stats` reports the named **surfacing metrics** (`StatsReport.surfacing`, a `SurfacingMetrics` object) — the rates that say whether the notebook is *covering* and *surfacing* at all. They turn the usage log into the numbers the [design rationale](docs/self-observing-notebook.md) §4 defines:

- **coverage** (novel-add rate) — `accepted` adds ÷ add attempts. High early (a young notebook filling gaps) is expected, not a fault.
- **recall-miss** (the headline alarm) — `dedup-blocked` adds ÷ add attempts: the agent re-derived something the notebook *already held*, so a stored lesson failed to reach it.
- **precision-miss** — downvotes ÷ votes on *pushed* lessons, read right beside recall-miss so chasing recall ("surface everything") can't look free.
- **readout** — where (coverage, recall-miss) lands on a 2×2: `healthy` (covers and surfaces), `surfacing-failure` (content present but not reaching the agent), `coverage-building` (a young notebook filling gaps), or `churny` (gaps *and* poor surfacing). A heuristic hint, not a verdict.

Two properties keep the rates honest. They are conditioned on **attempts** (add/vote *events*), so a lazy agent is just a small sample, never a deflated "healthy 0%". And they are gated on **engagement**: only sessions that show a vote are scored — a vote-less session is a setup/plumbing gap, excluded rather than mistaken for "healthy quiet". A rate with no data is `null` (shown `—` in the table), never a misleading `0`. They need `NB_SESSION` set to attribute calls to sessions. (Every delivered lesson is currently treated as *pushed* for precision-miss; now that [`nb search`](#searching--the-demoted-fallback) exists, narrowing this to non-search-delivered lessons is a possible future refinement.)

### What the usage log records

Every `nb` call appends one tab-delimited row to the usage ring (`.nb-usage.log`). Beyond the base `timestamp · role · command · ok|err · duration`, each row also records, per call:

- the **entry id(s)** the call touched — the added/voted/removed entry, (for `merge`) the two sources plus the merged result, or (for `split`) the source plus the two produced entries;
- a **session id** read from the `NB_SESSION` environment variable (a hook or supervising agent sets it so calls can be grouped; absent → blank, and co-access simply isn't computed);
- the **outcome** — for `add`, `accepted` or `dedup-blocked` (and on a block, the colliding entry's id); for `vote`, `up` or `down`; `removed` / `merged` / `split` for `rm` / `merge` / `split`; `match` / `no-match` for `search` (with the query kept in the note, so a failed search becomes a gap signal); plus, when an `add` evicts, which entry left and its final score;
- the optional **operation reason** — a per-op enum code and free-text note attached to any mutating op (`add`/`merge`/`rm`/`split`/`describe`, via `--reason`/`--note`); it lives in the log, never in a lesson.

This is richer *logging* only — the notebook file and the one-line lesson are untouched (it adds no field to an entry). Older rows written before this change are still read correctly; their extra columns are simply blank. Logging stays best-effort: a logging failure never fails a real `nb` operation, and the ring stays bounded by `NB_USAGE_RING`.

### Tuning `nb stats`

The anomaly detection in `nb stats` (loop / went-silent / high-error-rate flags) is tunable via env vars — out-of-range values are clamped to the stated bounds, and an unset or unparseable value falls back to the default:

- `NB_USAGE_RING` — how many recent calls are kept for `nb stats` to analyze (default `5000`, range `100`–`100000`).
- `NB_LOOP_N` — a loop is this many or more calls of the same command by the same role (default `10`, range `2`–`1000`).
- `NB_LOOP_WINDOW_S` — window those calls must fall within, in seconds (default `120`, range `5`–`86400`).
- `NB_SILENT_H` — hours since a command's last call before it is flagged went-silent (default `48`, range `1`–`8760`).
- `NB_ERR_MIN` — minimum calls before a command's error rate is judged (default `5`, range `1`–`10000`).
- `NB_ERR_RATE` — fraction of a command's calls that failed, above which it is flagged (default `0.3` = 30%, range `0`–`1`).
- `NB_COVERAGE_HI` — coverage at/above which the surfacing readout reads novel-adds as HIGH (default `0.5`, range `0`–`1`).
- `NB_RECALL_MISS_HI` — recall-miss at/above which the surfacing readout reads dedup-blocks as HIGH (default `0.2`, range `0`–`1`).

## Programmatic use

```ts
import {
  addEntry,
  readEntries,
  vote,
  merge,
  split,
  remove,
  render,
  search,
  listRoles,
  listNotebooks,
  notebooksDir,
  type AddResult,
  type SearchResult,
} from 'agent-notebook';

// `dir` is the storage directory. Any path works; notebooksDir() resolves the
// default — $NB_DIR if set, else ~/.agent-notebook/notebooks — the same
// location the `nb` CLI uses.
const dir = notebooksDir();

// addEntry never throws on a *content* rejection and never silently truncates:
// it resolves to an AddResult. Check `added`; when it is false, `reason` says
// why — 'duplicate' (an equivalent line already exists), 'empty' (nothing left
// after sanitizing), 'too-long' (over NB_MAX_CHARS; `length` carries the
// submitted size so you can report it), or 'rejected-full' (the notebook is at
// NB_MAX_LINES and every stored line outranks this one). The fifth reason,
// 'added', is the success case. (An invalid role name or an I/O error still
// throws — those are faults, not rejected content.)
const r: AddResult = await addEntry(dir, 'reviewer', 'run lint before claiming done');
if (!r.added) console.warn(`not stored: ${r.reason}`);
await addEntry(dir, 'reviewer', 'run the linter first'); // a near-duplicate
await addEntry(dir, 'reviewer', 'obsolete note to drop');

const entries = readEntries(dir, 'reviewer'); // Entry[] = { score, text }

// vote/merge/remove select an entry by stable id, unique prefix, or unique text
// substring — and throw if the selector matches no entry, or more than one.
await vote(dir, 'reviewer', 'run lint before', +1);

// merge folds two entries into a single line, inheriting the higher of their
// two scores; remove deletes one. Both rewrite the notebook under the same lock
// as addEntry and vote.
await merge(dir, 'reviewer', 'run lint before', 'linter first', 'run lint before every commit');

// split is the reverse of merge: it replaces one overloaded entry with two,
// each inheriting the original's score. It throws (writing nothing) on an empty
// or over-long half, on two halves that are duplicates of each other, or on a
// half that would duplicate a surviving entry — so a split never creates a dup.
await split(dir, 'reviewer', 'run lint before every commit', 'run lint before every commit', 'also run the type-checker before every commit');

await remove(dir, 'reviewer', 'obsolete note');

listRoles(dir); // string[] — roles that already have a notebook, sorted

// listNotebooks is the richest-first index behind `nb list` (name, lesson count,
// description, with a top-lesson `auto` fallback). Phantom empty notebooks are
// hidden; `total` counts every match so a caller can render "shown of total".
listNotebooks(dir, { prefix: 'review.', limit: 50 });
// → { dir, total, rows: [{ role, lessons, desc, auto }, ...] }

console.log(render(dir, 'reviewer')); // highest-scored first
```

The CLI is a thin wrapper over this library — `src/notebook.ts` is the whole mechanism, with zero runtime dependencies.

## Status

Early. This started as an internal tool for a multi-agent orchestrator and is being published to see whether the underlying idea — bounded, voted, one-line memory — is useful outside that specific context. It's on npm, but there's no marketing push behind it: if you find it because you were already looking for something like this, that's the signal this is worth taking further. Issues and forks are welcome either way.

## Changelog

Notable changes per release are recorded in [CHANGELOG.md](CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build and test (note: `npm test` needs Node 20.12+) and what to read first.

The entire point is that this stays small. A PR that adds a feature should make the case for why the bounded/voted/one-line model needs it, not just that it would be nice to have. Bug fixes, docs, and test coverage are always welcome.

The essential features, design choices, and the rationale behind them are specified in [docs/requirements.md](docs/requirements.md) — read it before proposing a change, and keep it in sync (the PR template has a checklist item for this). It's also the place to find out why something works the way it does (for example, why the notebook file is stored in insertion order rather than sorted).

Please add a one-line entry under the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for any user-facing change.

## License

MIT
