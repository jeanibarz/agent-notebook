# agent-notebook — Requirements & Design Rationale

This is the canonical specification of what `agent-notebook` is and why it is
built the way it is. It exists so that a design choice settled once is not
re-litigated or mistaken for a bug later (for example: "the on-disk file looks
unsorted — is that broken?" — no, see [DP-3](#dp-3)).

Requirements use RFC 2119 keywords (**SHALL**, **SHALL NOT**, **SHOULD**, **MAY**)
and carry a MoSCoW priority (**Must**, **Should**, **Could**, **Won't**). Each
load-bearing behavior links to the test that proves it; if you change a behavior,
change the requirement and its test together (see [Keeping this document honest](#keeping-this-document-honest)).

- **Source of truth for behavior:** `src/notebook.ts` (library) and `src/cli.ts` (CLI).
- **Tests:** `src/notebook.test.ts`, `src/cli.test.ts`.
- **Design rationale (signals & self-observation):** [`self-observing-notebook.md`](./self-observing-notebook.md) — why the tool instruments itself and how engagement / coverage / recall / precision / serendipity are told apart.

---

## 1. Purpose & scope

`agent-notebook` is a bounded, voted, plain-text memory for AI agents: one small
file per shelf (a group of lessons that should surface together), holding a short list of one-line lessons ranked by vote.
It has zero runtime dependencies and makes no network calls.

The product is deliberately narrow. Section [6. Non-goals](#6-non-goals-shall-not)
is as binding as the functional requirements — the non-goals are the product.

---

## 2. Glossary (ubiquitous language)

One definition per term, used identically in requirements, code, and tests.

| Term | Definition |
|------|------------|
| **Shelf** | One `<name>.md` notebook file: a group of lessons that should surface together. Lessons are grouped by co-access, not by agent role, so an agent that opens a shelf gets the lessons it looks for plus ones it would not think to search for (see [DP-8](#dp-8)). A path-safe name (see [FR-SAFE-001](#fr-safe-001)); stored at `<NB_DIR>/<name>.md`. Formerly called a "role" (when notebooks were one per agent role); `role`/`roles` JSON keys, `listRoles`, `assertSafeRole` and `nb roles` remain as deprecated aliases. "Notebook" may still name the tool or a shelf's file in general prose. |
| **Namespace** | A recommended *convention*, not a storage layer: a `.`-delimited shelf-name prefix (e.g. `review.tests`, `review.correctness`) that clusters related notebooks lexically so `nb list <prefix>` / `nb search … <prefix>` can scope to a group. A namespaced shelf is still one flat `<shelf>.md` file (see [FR-NAMESPACE-001](#fr-namespace-001)). |
| **Notebook** | The file of one shelf: a bounded, newline-separated list of entries. |
| **Entry** | One lesson = one line `"<score>\t<text>"`. The in-memory shape is `{ score: number; text: string }`. |
| **Lesson** / **text** | The single-line content of an entry, at most `maxChars` characters, no tab/newline. |
| **Score** | A signed integer: the running sum of +1/-1 votes on an entry. |
| **File order** / **recency order** | The order entries physically appear in the file — least-recently-*touched* first. A *touch* (a vote of either sign, an add, or a merge/split's new lesson) moves its entry to the end, so the top of the file is the stalest entry. |
| **Touch** | An engagement with a specific entry that refreshes its recency: a `vote` (±1), an `add`, or the new lesson(s) a `merge`/`split` creates. A read (`show`/`search`) is not a touch. |
| **Display order** | The order `nb show` / `render` presents entries: score descending, ties broken by ascending file order (stalest / least-recently-touched first). |
| **Stable id** | A 6-hex-character identifier derived from an entry's deduped text (`entryId`), not its position. |
| **Dedup key** | The case-, punctuation-, and whitespace-insensitive normal form of a text (`dedupKey`), used for duplicate detection and the stable id. |
| **Selector** | The argument to `vote`/`rm`/`merge`/`split` that identifies an entry: a stable id (exact or unique prefix) or a unique case-insensitive text substring. |
| **Operation reason** | An optional, per-operation enum code (seed-and-grow, plus an `other` escape hatch and optional free-text note) recorded for a mutating op in the usage log — never in the notebook (see [FR-REASON-001](#fr-reason-001)). |
| **Metadata** | Optional leading `# key: value` comment lines at the top of a notebook file, carrying notebook-level context (not lessons). Skipped by `readEntries`, round-tripped through every mutation (see [FR-DESC-001](#fr-desc-001)). |
| **Description** | The `# desc:` metadata value: a one-line *trigger* ("the situation in which you should open me") that lets an agent decide whether to open a notebook without reading its lessons. Set/printed with `nb describe` (see [FR-DESC-002](#fr-desc-002)). |
| **Cap** | `maxLines` (max entries per notebook) and `maxChars` (max characters per lesson). |
| **Eviction** | Removing the lowest-scored entry (ties: stalest) when the notebook exceeds `maxLines`. The newcomer is never the one removed. |
| **Staleness decay** / **aging** | Docking one point from the stalest surviving entry each time a full notebook accepts a new lesson, so a once-upvoted lesson that goes quiet eventually becomes evictable (see [eviction-and-aging.md](./eviction-and-aging.md)). |
| **Usage ring** | A bounded append-only log of CLI calls (`.nb-usage.log`) that `nb stats` reads. |

---

## 3. Design principles (the load-bearing choices + rationale)

These are the invariants the rest of the spec rests on. Each is a decision that
is easy to "fix" into a bug, so the rationale is recorded here.

<a id="dp-1"></a>
### DP-1: The cap and the vote are the whole mechanism — **Must**
There SHALL be no decay curve, relevance scoring, scheduler, or background job.
An entry's survival is decided only by its vote score relative to others and the
`maxLines` cap.
**Rationale:** The thesis of the tool is that bounded + voted is sufficient agent
memory without the machinery (embeddings, aging) that "memory" usually invites.
Adding any such mechanism contradicts the product (see [6. Non-goals](#6-non-goals-shall-not)).

<a id="dp-2"></a>
### DP-2: One entry is exactly one line — **Must**
An entry SHALL serialize to a single line `"<score>\t<text>"`. Text SHALL contain
no tab, carriage return, or newline (collapsed to single spaces by `sanitizeLesson`).
**Rationale:** Keeps the file trivially `cat`/`grep`/`diff`-able and keeps the tab
as an unambiguous field separator. Multi-line notes are a non-goal.

<a id="dp-3"></a>
### DP-3: Storage order is recency order; display order is by score — **Must**
The notebook file SHALL be stored in **recency order** — least-recently-*touched*
first — with a touch (a `vote` of either sign, an `add`, or a `merge`/`split`'s new
lesson) moving its entry to the END of the file. Sorting by score SHALL happen only
at read/display time (`render`, `nb show`), and the injected/printed view SHALL be
score-descending with ties broken by ascending file order (stalest first).
**Rationale:**
- The line format carries no timestamp, but eviction needs to tell a *stale* high
  lesson from an *active* one (see [eviction-and-aging.md](./eviction-and-aging.md)).
  Last-touch order is that recency signal, carried by position at **zero character
  cost** — and it is the *right* signal: insertion order (the previous rule) is the
  FIFO trap, where a frequently-reused lesson looks as old as a dead one. The top of
  the file is therefore the stalest lesson, which is what the staleness-decay and the
  eviction tie-break act on.
- The cost: a `vote` is now a line *move* (a delete + an append, which git renders as
  a ~2-line move) rather than a 1-line in-place edit. This is the one diff cost the
  design accepts; everything else stays a small diff, and git is not required at all
  ([DP-6](#dp-6)).
- No migration: an existing file's insertion order is a fine *initial* recency order
  (older = staler, a fair prior), and an older binary still reads a reordered file
  (it ranks by score and addresses entries by content id ([DP-4](#dp-4))).
A raw `cat` of the file therefore looks unordered; read it with `nb show`.
*Proven by:* `notebook.test.ts` → `describe('display ordering ("moving" an entry)')` and the recency/aging tests under `describe('caps')`.

<a id="dp-4"></a>
### DP-4: Entry identity is content-derived and stable — **Must**
An entry's id SHALL be `sha1(dedupKey(text)).slice(0, 6)` — a function of content,
never of position.
**Rationale:** An agent reads `nb show` in one step and votes in another; between
them other entries may be added or reordered. A positional id would drift and cause
a vote to land on the wrong lesson. A content id does not move.
*Proven by:* `notebook.test.ts` → "a stable id keeps pointing at the same entry after reordering".

<a id="dp-5"></a>
### DP-5: Never silently mislead the agent — **Must**
Operations SHALL report honestly rather than pretend success:
- An over-long `add` SHALL be rejected, not truncated ([FR-ADD-004](#fr-add-004)).
- An `add` that evicts SHALL report the removed entry in `evicted`, so the agent
  knows its memory changed ([FR-ADD-005](#fr-add-005)).
- A `vote`/`rm`/`merge` selector that is ambiguous or unmatched SHALL refuse and
  list candidate ids, rather than act on a guess ([FR-SEL-002](#fr-sel-002)).
- A bad `nb stats --since` value SHALL warn on stderr, not silently filter.
**Rationale:** The notebook is an agent's memory of its own past; a silent
truncation or a mis-landed vote poisons future runs. A loud refusal is cheap to
recover from; a silent corruption is not.

<a id="dp-6"></a>
### DP-6: A call is a fast, deterministic, offline file edit — **Must**
Every operation SHALL complete locally with no network call and SHALL be
deterministic given the same inputs and files.
**Rationale:** Agent memory must be usable on every task without latency, cost, or
a dependency on an external service being up.

<a id="dp-7"></a>
### DP-7: Zero runtime dependencies — **Must**
The published package SHALL have no runtime `dependencies`; it SHALL use only the
Node.js standard library.
**Rationale:** The whole mechanism is small enough not to need them, and a memory
tool an agent calls constantly should not drag a dependency tree or its CVEs.

<a id="dp-8"></a>
### DP-8: Memory's job is to surface what the agent would not think to ask for — **Must**
The tool SHALL deliver lessons by *presentation* — injection at session start, and
(where an organization or discovery layer is built) structure that nudges the agent
toward the relevant notebook — rather than by requiring the agent to query for them.
A retrieval model that depends on the agent already knowing what to search for SHALL
NOT be the primary path ([NG-007](#ng-007)).
**Rationale:** The highest-value lesson is the one the agent would never think to
search for — if it already knew to look, it would scarcely need the memory. An agent
re-running a task does not know which past mistake is about to recur, and a search
returns only what you can already name, so it cannot catch the un-anticipated repeat.
This is why the notebook is *injected* at session start rather than queried, and why
lessons are *voted* ([DP-1](#dp-1)) — so a hard-won lesson the agent rarely re-derives
still survives to be re-presented. Any discovery or organization layer SHALL be judged
by how well it surfaces relevant lessons the agent did not ask for.

---

## 4. Functional requirements

### 4.1 Entry model & sanitization

<a id="fr-model-001"></a>
**FR-MODEL-001 (Must).** An entry SHALL be `{ score: number; text: string }` and
SHALL serialize as `"<±score>\t<text>"` (score always sign-prefixed).

<a id="fr-model-002"></a>
**FR-MODEL-002 (Must).** `sanitizeLesson` SHALL replace any tab/CR/LF with a space,
collapse runs of whitespace to one space, and trim — and SHALL NOT truncate.
*Acceptance:* `sanitizeLesson("a\n b\tc")` → `"a b c"`; a 50-char input stays 50 chars.

<a id="fr-model-003"></a>
**FR-MODEL-003 (Should).** `readEntries` SHALL tolerate a hand-edited line with no
tab by treating its whole content as `text` with `score = 0`, and SHALL skip blank
lines.
**Rationale:** The file is advertised as human-editable; a hand edit must not crash a read.

### 4.2 `add`

<a id="fr-add-001"></a>
**FR-ADD-001 (Must).** `addEntry(dir, shelf, lesson)` SHALL sanitize the lesson, and
when it is accepted SHALL append a new entry with `score = 1` at the end of file
order, returning `{ added: true, reason: 'added', size, evicted }`.

<a id="fr-add-002"></a>
**FR-ADD-002 (Must).** An empty (post-sanitize) lesson SHALL be rejected with
`reason: 'empty'` and nothing stored.

<a id="fr-add-003"></a>
**FR-ADD-003 (Must).** A lesson whose dedup key equals an existing entry's SHALL be
rejected with `reason: 'duplicate'` and nothing stored.

<a id="fr-add-004"></a>
**FR-ADD-004 (Must).** A lesson longer than `maxChars` SHALL be rejected with
`reason: 'too-long'` and `length` set; it SHALL NOT be truncated or stored. A lesson
of exactly `maxChars` SHALL be accepted. *(See [DP-5](#dp-5).)*

<a id="fr-add-005"></a>
**FR-ADD-005 (Must).** When adding exceeds `maxLines`, eviction SHALL remove the
lowest-scored entries, breaking ties by stalest (lowest file index), until `maxLines`
remain, and SHALL NOT remove the just-added newcomer; a removed existing entry SHALL
be reported in `evicted`. (See [eviction-and-aging.md](./eviction-and-aging.md).)

<a id="fr-add-006"></a>
**FR-ADD-006 (Must).** A newcomer SHALL always be admitted — there is no
`rejected-full`. When the notebook is full, after the eviction of
[FR-ADD-005](#fr-add-005) the stalest surviving entry (the topmost non-newcomer)
SHALL be docked one point (**staleness decay / aging**). This runs *after*
eviction, so the dock never flips which entry is lowest. The decay is what prevents
a once-upvoted lesson from being immortal: it drifts to the top as fresher lessons
are touched and loses a point per add until it is re-voted (moved back to fresh) or
evicted. Decay fires ONLY when a notebook is over cap; a sub-cap notebook is
untouched. *(See [DP-1](#dp-1), [DP-3](#dp-3).)*

<a id="fr-add-007"></a>
**FR-ADD-007 (Should).** On the CLI, a lesson operand of `-` SHALL mean "read the
lesson from stdin", so a supervising agent can pipe a lesson in without shell-quoting
it as an argument. The CLI SHALL read exactly one line: a single trailing line ending
(LF, CRLF, or a lone CR) SHALL be stripped, and input that still contains any line
break (`\n` or `\r`) SHALL be refused (exit 1, message on stderr) rather than
flattened — honoring "one entry = one line" ([DP-2](#dp-2)), since `sanitizeLesson`
would otherwise collapse the line breaks into a space. The resulting line SHALL go through the unchanged
[`addEntry`](#fr-add-001) (same empty/duplicate/too-long/eviction behavior; empty
stdin yields `reason: 'empty'`). Because `-` denotes stdin, the one-character lesson
`-` cannot be stored through this operand; a literal hyphen SHALL go through the
library `addEntry` or a non-dash quoted argument. *(See [DP-5](#dp-5).)*

*Acceptance (table):*

| Precondition | Input | reason | Stored? |
|---|---|---|---|
| empty notebook | `"lesson"` | `added` | yes, score +1 |
| contains `dedupKey`-equal line | near-duplicate | `duplicate` | no |
| `maxChars=30` | 50-char lesson | `too-long` | no |
| full, mixed scores, newcomer not lowest | new lesson | `added` | yes, lowest evicted |
| full, every entry outranks newcomer | new lesson | `added` | yes — stalest line aged, lowest evicted |

### 4.3 `vote`

<a id="fr-vote-001"></a>
**FR-VOTE-001 (Must).** `vote(dir, shelf, selector, delta)` SHALL accept `delta` of
only `+1` or `-1`; any other value SHALL throw.

<a id="fr-vote-002"></a>
**FR-VOTE-002 (Must).** A vote SHALL add `delta` to the selected entry's score and,
as a *touch*, SHALL move that entry to the END of file order (it is now the
most-recently-touched). Both signs count — a downvote is engagement too; the low
score, not the position, is what makes an entry an eviction target, so moving a
downvoted entry to the fresh end never shields it. *(See [DP-3](#dp-3).)*

<a id="fr-vote-003"></a>
**FR-VOTE-003 (Should).** Scores MAY go negative (a repeatedly downvoted lesson), and
such entries SHALL be evicted first under [FR-ADD-005](#fr-add-005).

### 4.4 Selector resolution (shared by vote/rm/merge/split)

<a id="fr-sel-001"></a>
**FR-SEL-001 (Must).** Resolution SHALL try, in order: (1) if the selector is hex,
match it as a stable id by exact value or unique prefix; (2) otherwise, or if the
hex matched zero or many ids, match it as a unique case-insensitive substring of the
text. A step SHALL be used only when it identifies exactly one entry.
**Rationale:** Lets hex-looking real words (e.g. "dead", "cafe", "add") still resolve
as text when they are not an id.

<a id="fr-sel-002"></a>
**FR-SEL-002 (Must).** If no step yields exactly one entry (zero or multiple matches),
resolution SHALL throw an error that lists the candidate entries with their ids, and
SHALL NOT mutate anything. *(See [DP-5](#dp-5).)*

### 4.5 `merge`

<a id="fr-merge-001"></a>
**FR-MERGE-001 (Must).** `merge(dir, shelf, selA, selB, merged)` SHALL require two
distinct entries (SHALL throw if they resolve to the same one), replace both with a
single entry whose text is the sanitized `merged`, and give it `max(scoreA, scoreB)`.

<a id="fr-merge-002"></a>
**FR-MERGE-002 (Must).** `merge` SHALL reject an empty or over-`maxChars` merged
lesson (throw, leaving both sources intact), and SHALL drop any pre-existing entry
whose dedup key equals the merged text so the merge never creates a duplicate.

### 4.6 `split`

<a id="fr-split-001"></a>
**FR-SPLIT-001 (Must).** `split(dir, shelf, selector, lessonA, lessonB)` — the reverse
of `merge` — SHALL replace the uniquely selected entry with two entries whose texts are
the sanitized `lessonA` and `lessonB`, each inheriting the original entry's score. It
SHALL return `{ size, source, ids: [idA, idB] }` and SHALL obey the `maxLines` cap
(trimming the lowest-scored entry after the net addition, per the **Eviction** rule). An
empty notebook SHALL throw.
**Rationale:** An agent that recorded two lessons crammed into one line should be able
to cut it cleanly; `merge` had no inverse. The split rate is also a diagnostic — rising
splits mean entries are getting too coarse / the one-line discipline is strained.

<a id="fr-split-002"></a>
**FR-SPLIT-002 (Must).** `split` SHALL be atomic and SHALL NOT create a duplicate: it
SHALL reject (throw, leaving the original intact, nothing written) an empty or
over-`maxChars` half, two halves that share a dedup key, or a half whose dedup key
equals a *surviving* entry's. A half MAY equal the entry being split, since that entry
is removed. Over-long halves are rejected, never truncated ([DP-5](#dp-5)).
*Proven by:* `notebook.test.ts` → `describe('split')` and `cli.test.ts` → `describe('split (issue #68)')`.

### 4.7 `rm`

<a id="fr-rm-001"></a>
**FR-RM-001 (Must).** `remove(dir, shelf, selector)` SHALL delete the uniquely
selected entry and return its text and score. An empty notebook SHALL throw.

### 4.8 `show` / `render`

<a id="fr-show-001"></a>
**FR-SHOW-001 (Must).** `render` SHALL output one line per entry as
`"<id>  [<±score>]  <text>"` in display order ([DP-3](#dp-3)).

<a id="fr-show-002"></a>
**FR-SHOW-002 (Should).** An empty notebook SHALL render a friendly, non-error
message naming the shelf.

### 4.9 Shelves & paths

<a id="fr-safe-001"></a>
**FR-SAFE-001 (Must).** A shelf name SHALL match `^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$`,
SHALL NOT contain `..`, SHALL NOT be a reserved name (`README`, case-insensitive),
and SHALL be at most 128 characters long. `assertSafeShelf` SHALL throw otherwise.
**Rationale:** The shelf is a path segment; the pattern and `..` check prevent
traversal outside `NB_DIR`, and the 128-character bound keeps `<shelf>.md` under
typical filename limits so an over-long name throws a friendly `invalid shelf name`
error instead of a bare `ENAMETOOLONG` stack. 128 fits `shelf@owner-repo` plus a suffix.
`README` is reserved because a `README.md` is the conventional git/backup artifact
in a notebook folder, not a notebook — reserving the name stops a write command
(`nb add README …`, `nb vote README …`) from ever creating or rewriting one.
*Proven by:* `notebook.test.ts` → "rejects path-traversal and unsafe shelf names"; "bounds shelf-name length with a friendly error before it becomes a filename"; "`README` is a reserved shelf name (issue #90): a write command cannot target it".

<a id="fr-shelves-001"></a><a id="fr-roles-001"></a>
**FR-SHELVES-001 (Should).** `listShelves` SHALL return the sorted stems of `*.md` files
in `NB_DIR`, excluding dotfile sidecars (`.nb-usage.log`, `.nb.lock`) and a
`README.md` (case-insensitive — it is a backup artifact, not a notebook; see
[FR-SAFE-001](#fr-safe-001)). It is the primitive the `list` index
([FR-LIST-001](#fr-list-001)) is built on; the `nb shelves` *command* is an alias
of `nb list`, not a bare-stems printer. `listRoles` is a deprecated alias bound to the
same function (`listRoles === listShelves`); `assertSafeRole` likewise aliases
`assertSafeShelf`. Both stay until a later release marked BREAKING.
*Proven by:* `notebook.test.ts` → "excludes a README.md so it is not a notebook (issue #90)"; "excludes README.md case-insensitively".

<a id="fr-path-001"></a>
**FR-PATH-001 (Should).** `nb path` SHALL print `NB_DIR`; `nb path <shelf>` SHALL
print `<NB_DIR>/<shelf>.md` as a bare path (pipe-friendly, no decoration).

<a id="fr-list-001"></a>
**FR-LIST-001 (Should).** `listNotebooks(dir, {prefix?, limit?})` SHALL return the
notebook index — one `NotebookSummary {shelf, role, lessons, desc, auto}` per notebook (`role` is a deprecated copy of `shelf`, filled from the same value) —
ordered **richest-first** (descending `lessons`), ties broken by `shelf` name
ascending. `nb list` SHALL render it as a header line plus one aligned row per
notebook (name, lesson count, description); `ls`, `shelves` and the deprecated `roles` are aliases.
**Rationale:** Level 1 of progressive disclosure for epic [#73](https://github.com/jeanibarz/agent-notebook/issues/73) — the always-readable index an agent consults to decide *which* notebook to open without reading any notebook's lessons. More lessons ⇒ more worth reusing, so it leads.
*Proven by:* `notebook.test.ts` → "listNotebooks — the notebook index (issue #71)"; `cli.test.ts` → "list / ls / shelves — the notebook index (issue #71)".

<a id="fr-list-002"></a>
**FR-LIST-002 (Should).** A bare `prefix` operand SHALL keep only notebooks whose
shelf name starts with it (the `.` namespace convention, e.g. `nb list review.`).
`--limit <N>` SHALL bound the rows to the richest `N` (default 50; a non-negative
integer; an unparseable value SHALL warn on stderr and fall back to the default,
never reject), while `NotebookListing.total` SHALL still count every match so the
header can read `shown of total`. `--json` SHALL emit the raw `NotebookListing`
as the only thing on stdout.

<a id="fr-namespace-001"></a>
**FR-NAMESPACE-001 (Should).** Related notebooks SHOULD be grouped with a `.`-delimited
shelf-name prefix — the **namespace convention** (e.g. `review.tests`,
`review.correctness`) — so they cluster lexically and `nb list <prefix>`
([FR-LIST-002](#fr-list-002)) / `nb search … <prefix>` ([FR-SEARCH-001](#fr-search-001))
can scope to the group. This is a *naming convention only*: a namespaced shelf is a
first-class shelf requiring **no** change to [FR-SAFE-001](#fr-safe-001) (`.` is
already a permitted interior character) and **no** new storage layout — the notebook
stays one flat `<shelf>.md` file, never a directory. The grouping prefix SHOULD carry
the trailing `.` so a namespace (`review.`) does not also match a bare sibling that
merely shares the stem (`reviewer`). `@` is NOT the grouping delimiter; it stays
reserved for the existing `shelf@project` scoping and MAY combine with a namespace
(`review.tests@some-repo`).
**Rationale:** "Group by concept" done the minimal, brand-safe way — lexically, by
name, not by a similarity engine ([NG-001](#ng-001)). It lets an agent see and open a
related cluster at the index level ([FR-LIST-001](#fr-list-001)) while adding no
schema, no field, and no filesystem structure. `.` is filesystem-safe cross-platform.
Part of epic [#73](https://github.com/jeanibarz/agent-notebook/issues/73) (Phase 2).
*Proven by:* `notebook.test.ts` → "a `.`-namespaced shelf is first-class (issue #83)"; "the `.` delimiter clusters a namespace and excludes a non-namespaced sibling (issue #83)"; `cli.test.ts` → "a bare prefix filters by name (the `.` namespace convention)".

<a id="fr-list-003"></a>
**FR-LIST-003 (Should).** When a notebook has no `# desc:` description, `list` SHALL
fall back to its **top-scored lesson** (the `render`/`ordered` top row) as the
displayed trigger, marked `(auto)`; the `NotebookSummary.auto` field carries that
text and `desc` is `null`. A notebook WITH a description SHALL show it verbatim and
unmarked.

<a id="fr-list-004"></a>
**FR-LIST-004 (Should).** `listNotebooks` SHALL HIDE a notebook that has zero lessons
AND no description (phantom debris — e.g. `nb describe <shelf> ""` that left an empty
file, or an `rm` of the last lesson). A described-but-empty notebook (zero lessons,
a `# desc:` set) SHALL be kept — it is a deliberate trigger an agent set up.
**Rationale:** The index exists to point at notebooks worth opening; an empty,
undescribed file has nothing to discover and would only be noise. Stays within the
no-schema non-goal ([NG-004](#ng-004)) — the decision reads existing entries and the
existing `# desc:` metadata, adding no field to a lesson.

### 4.10 CLI contract

<a id="fr-cli-001"></a>
**FR-CLI-001 (Must).** `nb` SHALL implement: `show`, `add <shelf> ("<lesson>"|-)`,
`vote`, `merge`, `split <shelf> <id|query> "<a>" "<b>"`,
`rm`, `describe <shelf> ["<text>"]`, `stats [<shelf>] [--since <N{d,h,m}>] [--json]`, `path [<shelf>]`,
`list [prefix] [--limit <N>] [--json]` (aliases `ls`, `shelves`, and the deprecated `roles`), `--help`, `--version`.
The `-` lesson operand of `add` reads from stdin per
[FR-ADD-007](#fr-add-007). The optional `[--reason <code>] [--note "<text>"]` flags are
consumed by every mutating op — `add`, `merge`, `rm`, `split`, and `describe` — (the
operation-reasons mechanism, [FR-REASON-001](#fr-reason-001)); they are stripped before
positional parsing so they are never mistaken for a lesson/operand/description text.

<a id="fr-cli-002"></a>
**FR-CLI-002 (Must).** Exit codes SHALL be: `0` success; `1` a handled operation
error (message on stderr); `2` an unknown command.

<a id="fr-cli-003"></a>
**FR-CLI-003 (Should).** `nb stats --json` SHALL emit the raw `StatsReport` object as
the only thing on stdout (warnings stay on stderr), as a stable machine contract.

<a id="fr-cli-004"></a>
**FR-CLI-004 (Must).** A symlinked bin (e.g. an npm `.bin/nb`) SHALL still run the CLI
(resolve `argv[1]` via `realpath` before the main-module check).
**Rationale:** Regression guard — a prior release silently did nothing through the
npm bin symlink.

<a id="fr-cli-005"></a>
**FR-CLI-005 (Must).** Every JSON object that names a shelf (`ShowResult`,
`NotebookSummary`, `SearchGroup`, `DescribeResult`, `Anomaly`, `DiagnosticSignal`,
`NotebookStat`) SHALL carry `shelf` and the deprecated `role` with the same value,
filled from one variable so they cannot diverge; `NotebookTotals` SHALL carry `shelves`
and the deprecated `roles` likewise. Keys are only ever added to the `StatsReport`
contract, never removed or renamed; the deprecated keys, `listRoles`, `assertSafeRole`
and `nb roles` SHALL keep working and SHALL be removed only in a later release marked
BREAKING.
*Proven by:* `cli.test.ts` and `notebook.test.ts` → "shelf terminology (role kept as a deprecated alias)".

### 4.11 Durability & concurrency

<a id="fr-lock-001"></a>
**FR-LOCK-001 (Must).** Every notebook mutation (`add`/`vote`/`merge`/`split`/`rm`) SHALL run
under a `mkdir`-based spinlock on `.nb.lock`, with an acquire budget of ~2s; a lock
older than ~10s SHALL be treated as stale and stolen. (The usage log is appended
outside this lock — see [FR-USAGE-001](#fr-usage-001).)
**Rationale:** Serial CLI calls on one host occasionally overlap; the lock keeps a
concurrent `add`+`vote` from corrupting the file, and stale-steal recovers from a
crashed process.

<a id="fr-dur-001"></a>
**FR-DUR-001 (Must).** A *notebook* write SHALL go to a temp file, be `fsync`'d,
atomically renamed over the target, and the parent directory SHALL be `fsync`'d. (The
usage log is written best-effort with a plain write + rename and no `fsync` — losing a
monitoring row is acceptable; losing a lesson is not.)
**Rationale:** The rename is atomic but not durable; without the fsyncs a crash could
lose a lesson the CLI already reported as added. *(Directory-fsync failure is
tolerated for platforms that disallow it.)*

### 4.12 Usage log & stats

<a id="fr-usage-001"></a>
**FR-USAGE-001 (Must).** Each CLI invocation other than `--help`/`--version` (which
return before any work) SHALL append one tab-delimited row to the usage ring,
bounded to `usageRing` rows (oldest dropped). The row's first five columns SHALL be
`"<iso-ts>\t<shelf>\t<command>\t<ok|err>\t<ms>ms"`, followed by the five entry-level
columns of [FR-USAGE-002](#fr-usage-002) and the two reason columns of
[FR-USAGE-003](#fr-usage-003). A failure to log SHALL NOT fail the
operation, and every field SHALL be sanitized (tab/CR/LF collapsed to spaces) so a
value cannot inject an extra column or row.
**Rationale:** Monitoring must itself be bounded and must never break a real call.
*Proven by:* `notebook.test.ts` → `describe('usage log + stats')`.

<a id="fr-usage-002"></a>
**FR-USAGE-002 (Should).** Each usage row SHALL additionally record, after the five
base columns, five entry-level/outcome columns:
`"\t<session>\t<entry-ids>\t<outcome>\t<collided-id>\t<evicted-id:score>"`, where
`session` is the value of `NB_SESSION` at call time (blank when unset — co-access is
then not computed), `entry-ids` is the comma-joined stable id(s) the call touched,
`outcome` is `accepted`/`dedup-blocked`/`empty`/`too-long` for `add` (plus
`rejected-full` in logs predating the always-admit policy; `add` no longer emits it),
`up`/`down` for `vote`, `removed` for `rm`, `merged` for `merge`, `split` for `split`,
and blank for a
read-only command, `collided-id` is the id of the existing entry that blocked a
`dedup-blocked` add, and `evicted-id:score` is the entry an `add` evicted and its
final score. The parser SHALL tolerate an old five-column row written before this
change, reading the missing columns as blank/empty.
**Rationale:** Diagnostic signals (recall/precision, co-access, findability, coverage
× surfacing) rest on entry-level data living in the log, not the notebook — this adds
no field to a lesson ([NG-004](#ng-004)), keeping the one-line / no-schema contract.
*Proven by:* `notebook.test.ts` → `describe('entry-level + outcome logging (issue #67)')`
and `cli.test.ts` → `describe('usage log records entry ids + outcome (issue #67)')`.

<a id="fr-usage-003"></a>
**FR-USAGE-003 (Should).** Each usage row SHALL additionally record, after the
entry-level columns of [FR-USAGE-002](#fr-usage-002), two reason columns:
`"\t<reason>\t<note>"`, where `reason` is the normalized operation-reason code
([FR-REASON-001](#fr-reason-001)) and `note` its optional free text, both blank when
none was given. The parser SHALL tolerate a row written before these columns existed,
reading them as blank.
**Rationale:** The reason is monitoring data, so it belongs in the log columns, not in a
lesson ([NG-004](#ng-004)). Appending after the existing columns keeps an older reader
and older rows working, exactly as [FR-USAGE-002](#fr-usage-002) was appended after the
base five.
*Proven by:* `notebook.test.ts` → `describe('operation reasons (seed-and-grow enum)')`.

<a id="fr-reason-001"></a>
**FR-REASON-001 (Should).** A mutating op MAY carry an optional **operation reason**:
a per-operation enum code plus optional free-text note, validated and normalized by
`normalizeReason(op, code, note)` and written to the usage log ([FR-USAGE-003](#fr-usage-003)),
never to the notebook. The reason SHALL be **optional** (an absent code yields an empty
reason — forcing it would breed filler, the anti-Goodhart rule of [DP-8](#dp-8)/non-goals).
An **unrecognized** code SHALL be accepted as `other` (keeping the original code at the
front of the note), never rejected — the `other` rate is the growth thermostat that an
offline process mines to promote recurring reasons into real enum codes. The enum is
**seed-and-grow** and now spans every mutating op: `merge` seeds `duplicate · other`,
`rm` seeds `wrong · obsolete · other`, and `split` seeds `overloaded · other`; `add` and
`describe` are intentionally enum-less (free text only via `--note`) so their vocabulary
emerges from mined notes rather than being guessed up front. A code valid for one op is NOT valid for
another (it buckets to `other` there), since the vocabularies are per-op. Each enum value
SHALL be given a crisp, example-anchored definition in `nb --help` so different agents
code the same case consistently.
**Rationale:** An operation's surface form hides its intent (an agent may `merge` to save
calls, not because of a true duplicate); a reason disambiguates it and becomes a typed
label for later self-improvement, while staying monitoring-only so the notebook keeps its
one-line / no-schema contract.
*Proven by:* `notebook.test.ts` → `describe('operation reasons (seed-and-grow enum)')`
and `cli.test.ts` → `describe('split (issue #68)')` and
`describe('operation reasons on add/merge/rm (issue #69)')`.

<a id="fr-stats-001"></a>
**FR-STATS-001 (Should).** `stats` SHALL roll up per-command calls/errors/p50/p95/last-used
within a window (`parseWindowMs`, default 7d) and flag three anomalies: **loop**
(≥`NB_LOOP_N` calls of one shelf+command within `NB_LOOP_WINDOW_S`), **went-silent**
(used historically, zero in-window, and last seen longer than `NB_SILENT_H` ago),
**high-error-rate** (≥`NB_ERR_MIN` calls and ≥`NB_ERR_RATE` failures).

<a id="fr-stats-002"></a>
**FR-STATS-002 (Should).** A malformed anomaly-tuning value SHALL fall back to the
documented default (never `NaN`, which would disable detection).

<a id="fr-stats-003"></a>
**FR-STATS-003 (Should).** `stats` SHALL additionally derive **free diagnostic signals**
from the same windowed, shelf-scoped usage rows and return them as `StatsReport.signals`
(a list of `DiagnosticSignal = { kind, shelf, role, detail, session?, entry? }`, `role` being a deprecated copy of `shelf`), computed from
the usage ring alone — the entry-level columns of [FR-USAGE-002](#fr-usage-002) — with no
new agent action and no field added to a lesson ([NG-004](#ng-004)). The three kinds:
**browse-without-use** (a `show` of a notebook in a session with no `vote` on any of its
entries that same session → the description may over-promise), **eviction-while-still-voted**
(an `add` whose `evicted` id had been voted on → the cap may be too tight for that shelf),
and **vote-reversal** (one entry id with an `up` vote in one session and a `down` vote in a
**different** session → correct but mis-aimed). browse-without-use and vote-reversal are
session-scoped and SHALL skip rows with a blank session ([FR-USAGE-002](#fr-usage-002):
"co-access is then not computed"). The field is additive — the report from
[FR-STATS-001](#fr-stats-001) and the issue-#40 inventory is otherwise unchanged. A fourth
kind, **failed-search** (a `no-match` `search` followed by an `accepted` `add` in the same
session → a coverage gap), was added with `nb search` — see [FR-SEARCH-002](#fr-search-002).
**Rationale:** These signals diagnose description quality, cap pressure, and mis-targeting
from behaviour the agent already performs; reading them costs nothing and keeps the
one-line / no-schema lesson contract intact. They are heuristic hints, not verdicts.
*Proven by:* `notebook.test.ts` → `describe('diagnostic signals (issue #72)')` and
`cli.test.ts` → `describe('diagnostic signals (issue #72)')`.

<a id="fr-stats-004"></a>
**FR-STATS-004 (Should).** `stats` SHALL additionally report the named **surfacing
metrics** (`StatsReport.surfacing`, a `SurfacingMetrics` object) that turn the usage
ring into the rates [`self-observing-notebook.md`](./self-observing-notebook.md) §4
defines, computed from the same windowed, shelf-scoped rows with no new agent action and
no field added to a lesson ([NG-004](#ng-004)):
- **coverage** (novel-add rate) = `accepted` adds ÷ `addAttempts`;
- **recallMiss** (dedup-block rate — the headline alarm: a stored lesson was re-derived) =
  `dedup-blocked` adds ÷ `addAttempts`;
- **precisionMiss** (downvote rate on *pushed* lessons) = downvotes ÷ `votesActedOn`,
  read beside `recallMiss` so chasing recall cannot look free;
- a **readout** placing (coverage, recallMiss) on the coverage×surfacing 2×2 —
  `healthy` / `surfacing-failure` / `coverage-building` / `churny` (a heuristic hint,
  not a verdict), with the LOW/HIGH cutoffs `NB_COVERAGE_HI` (default 0.5) and
  `NB_RECALL_MISS_HI` (default 0.2).

Each rate SHALL be conditioned on **attempts** (`addAttempts` = `accepted` +
`dedup-blocked` + `rejected-full`, excluding the malformed `empty`/`too-long`;
`rejected-full` is a historical outcome — the always-admit policy no longer
produces it, but old logs may still carry it, so it stays in the denominator;
`votesActedOn` = `up` + `down`), so a lazy agent is a small sample rather than a
deflated `0`. Each rate SHALL be **gated on engagement**: only sessions that show a
vote are scored (a vote-less or blank-session row is excluded as a setup/plumbing gap,
not read as "healthy quiet"). A rate with an empty denominator (no engaged sessions, or
no attempts within them) SHALL be `null`, never a misleading `0` ([DP-5](#dp-5)); the
human table shows `null` as `—`. Every delivered lesson is currently treated as *pushed*
for `precisionMiss` (per [NG-007](#ng-007)); now that `nb search`
([FR-SEARCH-001](#fr-search-001)) exists, narrowing this to *non-search-delivered* lessons
is a possible future refinement, not yet implemented. The field is additive — the rest of the report
is unchanged. `--json` SHALL emit it inside the `StatsReport`.
**Rationale:** The free signals ([FR-STATS-003](#fr-stats-003)) point at *which* entry
or description needs attention; these named rates say whether the notebook is covering
and surfacing at all. The recall-miss rate is the clearest failure (re-learning what you
already stored); precision-miss is its counterweight so "surface everything" is not free
([DP-8](#dp-8)). All derived from behaviour the agent already performs.
*Proven by:* `notebook.test.ts` → `describe('surfacing metrics (issue #81)')` and
`cli.test.ts` → the surfacing-metrics table/`--json` tests.

### 4.13 Notebook descriptions & metadata

<a id="fr-desc-001"></a>
**FR-DESC-001 (Should).** A notebook file MAY begin with a **metadata** block: a
leading run of `# key: value` comment lines matching `^#\s*([a-z][a-z0-9_-]*):\s?(.*)$`.
`readEntries` SHALL skip the leading metadata block (such a line SHALL NOT become a
score-0 lesson), and every mutation (`add`/`vote`/`merge`/`split`/`rm`) SHALL
round-trip the block unchanged. Only the *leading* run is metadata — a `# key:`
line that follows an entry stays a tolerated bare lesson ([FR-MODEL-003](#fr-model-003)).
**Rationale:** An entry always starts with `±score\t` (or is a bare tab-less lesson),
so a `#`-leading `key:` line is unambiguous and backward-compatible — existing
notebooks have no `#` lines. Unknown keys SHALL be preserved verbatim and ignored
(forward-compatible). This stays within [NG-004](#ng-004): metadata is optional
comment lines in the *file*, not a field on a lesson.
*Proven by:* `notebook.test.ts` → "notebook metadata / descriptions (issue #70)".

<a id="fr-desc-002"></a>
**FR-DESC-002 (Should).** `nb describe <shelf> "<text>"` SHALL set the notebook's
one-line **description** (the `# desc:` metadata value); `nb describe <shelf>` with no
text SHALL print the current description (bare, pipe-friendly) or warn on stderr and
exit 0 when none is set. `setDescription`/`getDescription` are the library form.
An empty (post-sanitize) text SHALL clear the description. The `[--reason] [--note]`
flags ([FR-CLI-001](#fr-cli-001)) SHALL be stripped before the text operand is read, so
an option placed before the text is never silently stored as the description ([DP-5](#dp-5)).

*Proven by:* `cli.test.ts` → `describe('nb describe (issue #70)')`.

<a id="fr-desc-003"></a>
**FR-DESC-003 (Should).** A description SHALL be sanitized to one line
(`sanitizeLesson`) and capped exactly like a lesson: an over-`maxChars` description
SHALL be rejected, never truncated ([DP-5](#dp-5) / [FR-ADD-004](#fr-add-004)).

<a id="fr-desc-004"></a>
**FR-DESC-004 (Should).** `nb show` SHALL print the description (when set) as a
`# desc: <text>` header above the rendered entries, so a reader sees what a notebook
is *for* before its contents.

### 4.14 `search` — the demoted keyword fallback (issue #82)

<a id="fr-search-001"></a>
**FR-SEARCH-001 (Should).** `search(dir, query, {prefix?, any?})` SHALL scan every
notebook's entries and description for the query's whitespace-split **terms**, matching
each term as a **case-insensitive substring**. The default SHALL be **AND** (an entry is
a hit only if it contains *every* term); `any` SHALL make it **OR** (any one term). An
entry is matched on its own text; the description is matched separately, so a notebook
whose description matches SHALL surface (with any entry hits) even when no single entry
contains the terms. Results SHALL group by notebook; within a group, hits SHALL rank by
terms-matched, then score, then file order; groups SHALL rank by their best hit
(description-only matches last), ties by shelf name — all deterministic. Each hit SHALL
carry the entry's stable **id**, so the agent can `vote` it afterwards. `prefix` SHALL
scope by shelf name (the `.` namespace convention); an empty/whitespace query SHALL yield
no terms and no groups (never an error). `nb search <query> [prefix] [--any] [--json]` is
the CLI form; `--json` SHALL emit the raw `SearchResult`. Search SHALL be **keyword-only**
— plain substring over terms, no embeddings or similarity ranking ([NG-001](#ng-001)).
**Rationale:** Search is a **secondary convenience**, explicitly demoted below surfacing
([DP-8](#dp-8), [NG-007](#ng-007)): the highest-value lesson is the one the agent would
not think to search for, so presentation (injection + the `nb list` index) stays the
primary path, and both the help text and the command output SHALL say so plainly. A whole
notebook is ≤`maxLines` short lines, so scanning them all is instant ([DP-6](#dp-6)).
*Proven by:* `notebook.test.ts` → `describe('search — the demoted keyword fallback (issue #82)')`
and `cli.test.ts` → `describe('nb search …')`.

<a id="fr-search-002"></a>
**FR-SEARCH-002 (Should).** The CLI SHALL log each `search` to the usage ring
([FR-USAGE-002](#fr-usage-002)) with outcome `match` or `no-match` and the query in the
`note` field (reusing existing columns — no new column), under `shelf` `-` since it spans
notebooks. `stats` SHALL then derive a **`failed-search`** `DiagnosticSignal`
([FR-STATS-003](#fr-stats-003)): within one session, a `no-match` search followed
by an `accepted` `add` SHALL be flagged as a **coverage gap** the notebook did not hold,
labelled by the agent's own query (one signal per session + added-entry; a blank session
is skipped, and a terms-less query logs `no-terms`, never `no-match`, so it cannot be a
false gap). Because the `search` row is logged under shelf `-` (it spans notebooks), the
signal is observable only in an **unscoped** `stats` report — `nb stats <shelf>` filters to
one shelf and cannot pair the cross-notebook search with the add. **Rationale:** This is the
`failed-search → add` gap-sensor — the coverage signal deferred from #72. A search that
keeps failing for a topic is exactly where presentation is failing for that topic, and the
agent labels it for free ([DP-8](#dp-8)). The search `note` carries an agent-supplied query,
sanitized like every usage field so it cannot split the row ([FR-USAGE-002](#fr-usage-002)).
*Proven by:* `notebook.test.ts` → `describe('failed-search → add gap signal (issue #82)')`
and the `nb search` logging / end-to-end CLI tests.

---

## 5. Non-functional requirements

<a id="nfr-perf-001"></a>
**NFR-PERF-001 (Should).** A single operation on a within-cap notebook SHALL complete
in under ~50 ms on a developer machine (plain `fs` over one small file; no network).

<a id="nfr-bound-001"></a>
**NFR-BOUND-001 (Must).** A notebook SHALL never exceed `maxLines` entries after any
operation; a lesson SHALL never exceed `maxChars`; the usage log SHALL never exceed
`usageRing` rows. *(Unbounded growth is the failure this product exists to avoid.)*

<a id="nfr-port-001"></a>
**NFR-PORT-001 (Must).** The tool SHALL run on Node.js ≥ 18 as an ESM package with no
runtime dependencies. CI exercises Linux and macOS on Node 18/20/22; macOS is a
supported target (no Linux-specific syscalls) and is covered by CI.

<a id="nfr-safe-001"></a>
**NFR-SAFE-001 (Must).** No operation SHALL write, read, or delete outside `NB_DIR`;
shelf validation ([FR-SAFE-001](#fr-safe-001)) is the sole guard and SHALL be applied
on every shelf-to-path conversion.

<a id="nfr-maint-001"></a>
**NFR-MAINT-001 (Should).** The whole mechanism SHALL stay in `src/notebook.ts` (the
library) with `src/cli.ts` a thin wrapper; behavior SHALL be covered by `vitest`
tests runnable with `npm test`.

<a id="nfr-obs-001"></a>
**NFR-OBS-001 (Could).** Operational state SHALL be observable without extra tooling
via `nb stats` reading the usage ring.

---

## 6. Non-goals (SHALL NOT)

These are as binding as the functional requirements. A PR that adds any of these is
changing the product, not extending it, and SHALL make that case explicitly.

<a id="ng-001"></a>
**NG-001.** The tool SHALL NOT use embeddings, semantic search, or similarity ranking.
Dedup is conservative exact-normal-form equality only.

<a id="ng-002"></a>
**NG-002.** The tool SHALL NOT store long-form notes, summaries, or documents — one
line per lesson, period.

<a id="ng-003"></a>
**NG-003.** The tool SHALL NOT make network calls, run a server, or sync between
machines. Backup is whatever already backs up the home directory (or git on `NB_DIR`).

<a id="ng-004"></a>
**NG-004.** The tool SHALL NOT add a multi-field schema — a lesson is a string, a
score is an integer. (This governs the *notebook*. The usage log
[FR-USAGE-002](#fr-usage-002) may carry richer per-call columns; it is monitoring
telemetry, not entry storage, and adds no field to a lesson.)

<a id="ng-005"></a>
**NG-005.** The tool SHALL NOT age, decay, or schedule. Vote and cap are the only
forces on an entry's lifetime ([DP-1](#dp-1)).

<a id="ng-006"></a>
**NG-006.** `add` SHALL NOT truncate an over-long lesson to fit the cap
([FR-ADD-004](#fr-add-004)).

<a id="ng-007"></a>
**NG-007.** The tool SHALL NOT require an agent to query in order to retrieve its own
memory. Search, if ever offered, is a secondary convenience; the primary path is
presentation ([DP-8](#dp-8)).

---

## 7. Configuration

All are read at call time and clamped to the stated range; a missing value falls back
to the default (integer vars also fall back on a non-numeric string).

| Variable | Default | Range | Effect |
|---|---|---|---|
| `NB_DIR` | `~/.agent-notebook/notebooks` | — | Notebooks directory. |
| `NB_SESSION` | _(unset → blank)_ | — | Session id a caller/hook sets; recorded per usage row ([FR-USAGE-002](#fr-usage-002)) to group a session's calls. |
| `NB_MAX_LINES` | 50 | 1–5000 | `maxLines` — entries per notebook (a deliberately tight default so eviction pressure stays meaningful and a notebook keeps only what earns its place; raise it for a shelf that genuinely needs more). |
| `NB_MAX_CHARS` | 200 | 20–2000 | `maxChars` — characters per lesson. |
| `NB_USAGE_RING` | 5000 | 100–100000 | `usageRing` — rows in the usage log. |
| `NB_LOOP_N` | 10 | 2–1000 | Loop anomaly: call count threshold. |
| `NB_LOOP_WINDOW_S` | 120 | 5–86400 | Loop anomaly: window (seconds). |
| `NB_SILENT_H` | 48 | 1–8760 | Went-silent anomaly: silence threshold (hours). |
| `NB_ERR_MIN` | 5 | 1–10000 | High-error-rate anomaly: min calls. |
| `NB_ERR_RATE` | 0.3 | 0–1 | High-error-rate anomaly: min failure fraction. |
| `NB_COVERAGE_HI` | 0.5 | 0–1 | Surfacing readout ([FR-STATS-004](#fr-stats-004)): coverage ≥ this reads as novel-adds HIGH. |
| `NB_RECALL_MISS_HI` | 0.2 | 0–1 | Surfacing readout ([FR-STATS-004](#fr-stats-004)): recall-miss ≥ this reads as dedup-blocks HIGH. |

---

## Keeping this document honest

This document rots the moment code changes without it. To prevent that:

1. The pull-request template (`.github/PULL_REQUEST_TEMPLATE.md`) carries a checklist
   item requiring that this document be updated, or confirmed still accurate, whenever
   a PR changes behavior, a default, the CLI surface, or a non-goal.
2. Each load-bearing requirement names the test that proves it. When you change the
   behavior, change the requirement and the test in the same PR.
3. A new feature SHALL be justified against [DP-1](#dp-1)
   and [6. Non-goals](#6-non-goals-shall-not) here before it is implemented.
