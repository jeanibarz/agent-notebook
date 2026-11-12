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
file per shelf (a group of lessons an agent needs in the same situations), holding a short list of one-line lessons ranked by vote.
It has zero runtime dependencies and makes no network calls.

The product is deliberately narrow. Section [6. Non-goals](#6-non-goals-shall-not)
is as binding as the functional requirements — the non-goals are the product.

---

## 2. Glossary (ubiquitous language)

One definition per term, used identically in requirements, code, and tests.

| Term | Definition |
|------|------------|
| **Shelf** | One `<name>.md` notebook file: a group of lessons an agent needs in the same situations. Lessons are grouped by co-access (needed together), not by agent role, so an agent that opens a shelf can get the lessons it looks for plus ones it might not think to search for (see [DP-8](#dp-8)). A path-safe name (see [FR-SAFE-001](#fr-safe-001)); stored at `<NB_DIR>/<name>.md`. Formerly called a "role" (when notebooks were one per agent role); `role`/`roles` JSON keys, `listRoles`, `assertSafeRole` and `nb roles` remain as deprecated aliases. "Notebook" may still name the tool or a shelf's file in general prose. |
| **Namespace** | A recommended *convention*, not a storage layer: a `.`-delimited shelf-name prefix (e.g. `review.tests`, `review.correctness`) that clusters related notebooks lexically so `nb list <prefix>` / `nb search … <prefix>` can scope to a group. Recommended depth: no prefix or one level. A namespaced shelf is still one flat `<shelf>.md` file (see [FR-NAMESPACE-001](#fr-namespace-001)). |
| **Notebook** | The tool and its set of shelves; also the general word for a shelf's file (a bounded, newline-separated list of entries). Say *shelf* when you mean one file, one name or one argument. |
| **Entry** | One lesson = one line `"<score>\t<text>"`. The in-memory shape is `{ score: number; text: string }`. |
| **Lesson** / **text** | The single-line content of an entry, at most `maxChars` characters, no tab/newline. |
| **Score** | A signed integer: the running sum of +1/-1 votes on an entry. |
| **File order** / **recency order** | The order entries physically appear in the file — least-recently-*touched* first. A *touch* (a vote of either sign, an add, or a merge/split's new lesson) moves its entry to the end, and so does the staleness dock, so the top of the file is the **stalest** entry: the one that has gone longest since it was touched or docked. |
| **Touch** | An engagement with a specific entry that refreshes its recency: a `vote` (±1), an `add`, or the new lesson(s) a `merge`/`split` creates. A read (`show`/`search`) is not a touch. |
| **Display order** | The order `nb show` / `render` presents entries: score descending, ties broken by ascending file order (stalest first: least recently touched or docked). |
| **Stable id** | A 6-hex-character identifier derived from an entry's deduped text (`entryId`), not its position. |
| **Dedup key** | The case-, punctuation-, and whitespace-insensitive normal form of a text (`dedupKey`), used for duplicate detection and the stable id. |
| **Selector** | The argument to `vote`/`rm`/`merge`/`split` that identifies an entry: a stable id (exact or unique prefix) or a unique case-insensitive text substring. |
| **Operation reason** | An optional, per-operation enum code (seed-and-grow, plus an `other` escape hatch and optional free-text note) recorded for a mutating op in the usage log — never in the notebook (see [FR-REASON-001](#fr-reason-001)). |
| **Metadata** | Optional leading `# key: value` comment lines at the top of a notebook file, carrying notebook-level context (not lessons). Skipped by `readEntries`, round-tripped through every mutation (see [FR-DESC-001](#fr-desc-001)). |
| **Description** | The `# desc:` metadata value: a one-line *trigger* ("the situation in which you should open me") that lets an agent decide whether to open a notebook without reading its lessons. Set/printed with `nb describe` (see [FR-DESC-002](#fr-desc-002)). |
| **Cap** | `maxLines` (max entries per notebook) and `maxChars` (max characters per lesson). |
| **Eviction** | Removing the lowest-scored entry (ties: stalest) when the notebook exceeds `maxLines`. The newcomer is never the one removed. |
| **Staleness decay** / **aging** | Docking one point from the stalest surviving entry, and moving that entry to the end of the file, each time a full notebook accepts a new lesson. A once-upvoted lesson that goes quiet eventually becomes evictable, and a run of adds docks many quiet lessons once instead of one lesson many times (see [eviction-and-aging.md](./eviction-and-aging.md)). |
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
lesson) moving its entry to the END of the file. The staleness dock of
[FR-ADD-006](#fr-add-006) SHALL move the docked entry to the END as well, after the
newcomer(s) of the same call. Sorting by score SHALL happen only
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
- The dock moves its entry too (issue #437). Left in place, the docked entry stayed
  the stalest and took every following dock until it was evicted, so one session
  adding a few lessons could remove a well-voted lesson. Moved, each add docks the
  next quiet lesson in turn, and file order reads "longest since touched or docked".
- The cost: a `vote` is now a line *move* (a delete + an append, which git renders as
  a ~2-line move) rather than a 1-line in-place edit. This is the one diff cost the
  design accepts; everything else stays a small diff, and git is not required at all
  ([DP-6](#dp-6)).
- No migration: an existing file's insertion order is a fine *initial* recency order
  (older = staler, a fair prior), and an older binary still reads a reordered file
  (it ranks by score and addresses entries by content id ([DP-4](#dp-4))).
A raw `cat` of the file therefore looks unordered; read it with `nb show`.
*Proven by:* `notebook.test.ts` → `describe('display ordering ("moving" an entry)')` and the recency/aging tests under `describe('caps')`, including "the docked line moves to the end of the file, after the newcomer (#437)".

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
**FR-MODEL-002 (Must).** `sanitizeLesson` SHALL strip terminal-manipulating and
invisible characters, then replace any whitespace control (tab/CR/LF/VT/FF) with a space, collapse runs of
whitespace to one space, and trim — and SHALL NOT truncate. The stripped classes are:
C0 controls other than the whitespace ones it normalises (tab, LF, VT `U+000B`, FF `U+000C`, CR) (so ESC `U+001B`,
NUL `U+0000` and BEL `U+0007`); DEL (`U+007F`); C1 controls (`U+0080–U+009F`); bidi
embedding/override/isolate marks (`U+202A–U+202E`, `U+2066–U+2069`); and invisible
zero-width characters (`U+200B`, `U+2060`, `U+FEFF`); the soft hyphen (`U+00AD`); and the Unicode Tag block (`U+E0000–U+E007F`). It SHALL KEEP `U+200D` (ZWJ) and
the variation selectors so emoji ZWJ sequences survive. Because stored data may
predate this rule, the render paths (`render`, `list`, `search`, `show --json`, and
the `show`/`describe`/`list`/`search` text output) SHALL also strip these classes, so
a line written before the rule cannot emit a raw escape either.
*Acceptance:* `sanitizeLesson("a\n b\tc")` → `"a b c"`; a 50-char input stays 50 chars;
`sanitizeLesson("x\u001b[31my\u0000z\u202e!")` drops every listed character; a stored
ESC byte never reaches `show`/`list`/`search` output; emoji ZWJ and CJK text round-trip
unchanged; `sanitizeLesson("page1\fpage2")` → `"page1 page2"` (VT/FF stay whitespace) (issue #335).
*Proven by:* `notebook.test.ts` → the three `issue #335` tests in `describe('serialization round-trip')`, and `cli.test.ts` → `describe('printed output carries no raw control bytes (issue #335)')`.

<a id="fr-model-003"></a>
**FR-MODEL-003 (Should).** `readEntries` SHALL tolerate a hand-edited line with no
tab by treating its whole content as `text` with `score = 0`, and SHALL skip blank
lines.
**Rationale:** The file is advertised as human-editable; a hand edit must not crash a read.

<a id="fr-model-004"></a>
**FR-MODEL-004 (Must).** `readShelf` SHALL recognize a git merge-conflict marker line — a line-start
`<<<<<<<` or `>>>>>>>` followed by a space or the end of the line, or a bare `=======` (nothing else on
it) — and SHALL surface the first one as `ShelfContents.conflict` (`null` for a clean shelf) while still
parsing it exactly as before, so a read's stdout is unchanged. A lesson that merely contains `=======`
mid-line, and the ordinary hand-edited tab-less line ([FR-MODEL-003](#fr-model-003)), SHALL NOT be
treated as a conflict. When a shelf holds a marker: the read commands `show`, `list`, `search` and `stale`
SHALL still succeed (exit `0`) and print exactly what they printed before, plus one stderr warning naming
the shelf and the marker line, and `--json` stdout SHALL stay valid JSON, a clean store's `list`/`search` output byte-identical, and the stderr warning SHALL also be printed under `--json` (the conflicted
shelves appear in the additive `NotebookListing.conflicts` / `SearchResult.conflicts` /
`StatsReport.conflicts` field — emitted only when non-empty for `list`/`search`, always present (`[]` when clean) in the `stats` report, like `skipped`); and **every** mutation (`add`, `vote`,
`voteMany`, `merge`, `split`, `rm`, `move`, `describe`) SHALL refuse with exit `1`, a handled `NbError`
of class `corrupt` naming the shelf and the marker, and leave the file byte-identical — no data is
dropped or rewritten.
**Rationale:** A git-versioned notebook (the documented `nb-git-wrapper`/`nb-backup.sh` flow) that hits a
merge conflict would otherwise parse the markers as score-0 lessons and the next mutation would persist
them as real lessons, silently "resolving" the conflict and evicting real lessons ([DP-5](#dp-5)).
*Acceptance:* a shelf with `<<<<<<< HEAD`, `+2<TAB>mine`, `=======`, `+3<TAB>theirs`, `>>>>>>> branch`
makes `nb add|vote|merge|split|rm|move|describe` exit `1` with `errorClass` `corrupt` and leaves the file
byte-identical, while `nb show|list|search|stale` exit `0` with the same stdout plus one stderr warning.
*Proven by:* `notebook.test.ts` → `describe('git merge-conflict markers are detected, never rewritten (issue #333)')`; `cli.test.ts` → `describe('a git merge-conflicted shelf warns on reads and refuses mutations (issue #333)')`.

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
`reason: 'too-long'`, `length` set, and `overflow` set to `length - maxChars` (the
number of characters to trim, always ≥ 1); it SHALL NOT be truncated or stored. The
CLI SHALL report that overflow so the retry trims exactly that much rather than
guessing (issue #239). A lesson of exactly `maxChars` SHALL be accepted. *(See [DP-5](#dp-5).)*

*Proven by:* `notebook.test.ts` → `describe('caps')` → "rejects an over-length lesson instead of truncating it"; `cli.test.ts` → "an over-long add exits 1, is not stored, and tells the agent to retry" and "add --json on a too-long lesson emits reason:\"too-long\" on stdout but still exits 1".

<a id="fr-add-005"></a>
**FR-ADD-005 (Must).** When adding exceeds `maxLines`, eviction SHALL remove the
lowest-scored entries, breaking ties by stalest (lowest file index), until `maxLines`
remain, and SHALL NOT remove the just-added newcomer; the first removed existing entry
SHALL be reported in `evicted`. A cap *decrease* can evict many entries in one call, so
the result SHALL also carry an `evictedAll` array with **every** removed entry in storage
order (`evicted` is `evictedAll[0] ?? null`, so the single-eviction case is unchanged),
and the CLI SHALL report the extra count (issue #306). (See [eviction-and-aging.md](./eviction-and-aging.md).)

<a id="fr-add-006"></a>
**FR-ADD-006 (Must).** A newcomer SHALL always be admitted — there is no
`rejected-full`. When the notebook is full, after the eviction of
[FR-ADD-005](#fr-add-005) the stalest surviving entry (the topmost non-newcomer)
SHALL be docked one point (**staleness decay / aging**) and SHALL be moved to the
END of the file, after the newcomer. This runs *after* eviction, so the dock never
flips which entry is lowest. The decay is what prevents a once-upvoted lesson from
being immortal: it drifts to the top as fresher lessons are touched or docked, loses
a point, and goes to the back; with no vote it reaches the bottom score and is
evicted. Because the docked entry moves, an entry SHALL NOT be docked again until
every other entry that was present at its previous dock has been docked, voted on,
or removed (issue #437): a run of adds takes one point from many quiet lessons and
does not drain one of them. The same rule applies to the dock a `merge`, `split` or
`move` causes. Decay fires ONLY when a notebook is over cap; a sub-cap notebook is
untouched. *(See [DP-1](#dp-1), [DP-3](#dp-3).)*

*Proven by:* `notebook.test.ts` → `describe('caps')` → "the docked line moves to the end of the file, after the newcomer (#437)", "a move into a full shelf and a split of a full shelf also send the docked line to the end (#437)", "a merge that overflows a lowered cap also sends the docked line to the end (#437)", "a run of unrelated adds docks each proven lesson once before it evicts a second one (#414, #437)", "40 unrelated adds into 20 stale +4 lessons and 30 unvoted ones evict none of the 20 (#437)", "each extra point buys an untouched lesson another pass of the decay (#437)" and "randomized: a lesson is docked again only after the decay has passed over the rest of the shelf [slow]".

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

<a id="fr-add-008"></a>
**FR-ADD-008 (Should).** An accepted add whose lesson is *not* an exact-normal-form
duplicate ([FR-ADD-003](#fr-add-003)) but whose trigram-Jaccard `similarity` to an
existing entry is ≥ the near-duplicate threshold (`NB_NEAR_DUP`, default `0.5`;
`0` disables the advisory) SHALL still be stored, and SHALL additionally surface a
**non-blocking advisory** that names the resembling entry (the most similar; ties
resolved to the earliest in storage order) and suggests a `merge`. The advisory SHALL NOT block, reject,
reorder, or otherwise alter the add — a fuzzy match must never cause a silent loss
([DP-5](#dp-5)). The resembling entry's id SHALL be recorded in the usage log's
`collided` field on the (still `accepted`) row, so an accept-with-resemblance is a
measurable near-duplicate / paraphrase-miss signal, distinct from a hard
`dedup-blocked`. The check SHALL be deterministic, offline, and dependency-free — a
lexical overlap, not embeddings or semantic ranking ([NG-001](#ng-001)). *(On the CLI
the advisory goes to stderr so stdout stays pipe-clean; `--json` carries `nearId`.)*
*Proven by:* `notebook.test.ts` → `describe('near-duplicate advisory (FR-ADD-008)')`;
`cli.test.ts` → "a resembling add still stores the lesson, warns on stderr, and logs the
accepted row with the near-match id" and "a resembling add --json carries nearId; a
dissimilar add does not warn".

*Acceptance (table):*

| Precondition | Input | reason | Stored? |
|---|---|---|---|
| empty notebook | `"lesson"` | `added` | yes, score +1 |
| contains `dedupKey`-equal line | exact-normal-form duplicate | `duplicate` | no |
| contains a trigram-similar line (≥ `NB_NEAR_DUP`) | same lesson reworded | `added` + advisory | yes, score +1 |
| `maxChars=30` | 50-char lesson | `too-long` | no |
| full, mixed scores, newcomer not lowest | new lesson | `added` | yes, lowest evicted |
| full, every entry outranks newcomer | new lesson | `added` | yes — lowest evicted, stalest survivor aged and moved to the end |

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

### 4.4 Selector resolution (shared by vote/rm/merge/split/move)

<a id="fr-sel-001"></a>
**FR-SEL-001 (Must).** Resolution SHALL try, in order: (1) if the selector is hex,
match it as a stable id by exact value or unique prefix; (2) otherwise, or if the
hex matched zero or many ids, match it as a unique case-insensitive substring of the
text. A step SHALL be used only when it identifies exactly one entry. A hex selector
shorter than a full id that uniquely prefixes one id but is also a substring of the
text of a *different* entry SHALL be refused as `ambiguous_selector`, listing both
entries; a full 6-character id that equals an entry's id SHALL resolve directly,
whatever other entries' texts contain.
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

### 4.7a `move`

<a id="fr-move-001"></a>
**FR-MOVE-001 (Must).** `move(dir, fromShelf, toShelf, selector)` SHALL remove the
uniquely selected entry from `fromShelf` and insert it into `toShelf` **with its score
carried over unchanged**, returning `{ reason, text, score, id, fromSize, toSize,
evicted, collidedId?, created?, similarShelves? }` (`created`/`similarShelves` per
[FR-NOTE-001](#fr-note-001)). The inserted entry SHALL be treated as a newcomer for the
`maxLines` cap — a *touch* (so it lands at the fresh end, [DP-3](#dp-3)) and *protected*
like any newcomer ([FR-ADD-006](#fr-add-006)), so a full target ages/evicts its stalest
*other* line and never drops the lesson just moved. This is the
score-preserving relocation `add`+`rm` cannot express: `add` enters at the `+1` floor,
discarding the vote capital the move must keep.
**Rationale:** "Shelves are chosen by situation" needs an inverse — when two situations
turn out to be one, their shelves must be consolidable without the tool resetting scores
(issue #103). The score lives in the entry line the tool owns, so only the tool can
relocate it losslessly under its own lock and eviction rules.

<a id="fr-move-002"></a>
**FR-MOVE-002 (Must).** `move` SHALL refuse, writing NOTHING to either shelf, when: the
source and target are the same shelf (throw); the source is empty (throw); the selector
is absent or ambiguous (throw, per [FR-SEL-002](#fr-sel-002)); or the target already
holds an entry with the moved lesson's dedup key — a near-duplicate — in which case it
SHALL return `reason: 'duplicate'` with the colliding entry's `collidedId` and leave
both shelves untouched (same dedup rule as `add`/`merge`, so a move never creates a
duplicate). On success it SHALL persist the target before removing from the source, so
an interruption between the two writes duplicates the lesson across shelves rather than
losing it (a "no loss of a voted lesson" guarantee).
*Proven by:* `notebook.test.ts` → `describe('move …')` and `cli.test.ts` → `describe('nb move …')`.

### 4.8 `show` / `render`

<a id="fr-show-001"></a>
**FR-SHOW-001 (Must).** `render` SHALL output one line per entry as
`"<id>  [<±score>]  <text>"` in display order ([DP-3](#dp-3)).

<a id="fr-show-002"></a>
**FR-SHOW-002 (Should).** An empty notebook SHALL render a friendly, non-error
message naming the shelf.

<a id="fr-show-003"></a>
**FR-SHOW-003 (Should).** `staleCandidates(dir, shelf, limit?)` SHALL rank a
shelf's lessons by eviction priority — lowest score first, ties broken by stalest
(lowest file index) — and return them most-disposable-first, truncated to `limit`
(default 10 on the CLI), with the full pre-`limit` `total` and the `exists` flag
([FR-SHOW-… / issue #166](#fr-show-001)). It SHALL be strictly read-only: no
score change, no reorder, no removal. The `nb stale <shelf>` command surfaces this
ranking on ANY shelf (not only a full one) so the retrospective can downvote/`rm`
the weakest lessons by id, reviving the curation loop ([DP-1](#dp-1)); a missing
shelf is reported like `show` (stderr, exit 0). *(Issue #240; spun off from the
#223 usage audit's F3/F4.)*

*Proven by:* `notebook.test.ts` → `describe('staleCandidates (nb stale — cull candidates, issue #240)')`; `cli.test.ts` → `describe('nb stale — cull candidates (issue #240)')`.

<a id="fr-show-004"></a>
**FR-SHOW-004 (Should).** `nb show` SHALL accept one or more shelf operands and
present each one, in the given order, instead of silently dropping all but the
first. Under `--json` it SHALL emit the structured form via `showJson` /
`showJsonMany`: for a single shelf a lone `ShowResult` object
(`{role, shelf, description, entries, exists}`), and for two or more a per-shelf
`ShowResult[]` produced in one process (one consistent snapshot, no re-spawn).
A named shelf with no file SHALL report `exists: false` with `entries: []`, never
a silent empty ([DP-5](#dp-5), [issue #166](#fr-show-001)). Each `--json` entry
SHALL carry a `key`: the `dedupKey` normal form of its `text` (the same
case/punctuation-folded, whitespace-collapsed form that derives its `id`), so two
entries with an equal `key` are exact duplicates a caller can drop — including
across shelves. This path SHALL do NO cross-shelf dedup, reordering, scope
precedence, or similarity ranking: those stay caller policy, and `key` is an
equality signal only, never a near-duplicate or ranking score ([DP-8](#dp-8)).
*(Issue #286.)*

*Proven by:* `cli.test.ts` → `describe('show --json batch + per-entry key (issue #286)')`; `notebook.test.ts` → `describe('showJson key + showJsonMany batch (issue #286)')`.

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
print `<NB_DIR>/<shelf>.md`; `nb path --usage` SHALL print the resolved usage-log
path (`<NB_DIR>/.nb-usage.log`) — each a bare path (pipe-friendly, no decoration).
`--usage` is the only recognized flag; any other `--`-prefixed token is treated as
a shelf name and rejected by the safe-shelf check, so `--usage` cannot collide with
a shelf (a `--`-prefixed shelf name is unreachable). **Rationale:** the usage-log
filename is an internal detail a supervisor must not hard-code to tail/back it up
([#169](https://github.com/jeanibarz/agent-notebook/issues/169)) — the same
`$NB_DIR/<file>` coupling `nb path` was introduced ([#14](https://github.com/jeanibarz/agent-notebook/issues/14)) to remove.
`NB_DIR` SHALL have a single leading `~` (or `~/…`; `~\…` on Windows) expanded to
the home directory before use, so a value set from a source without shell expansion
(`settings.json` `env`, systemd, cron, `.env`) resolves like its shell equivalent
instead of creating a literal `~` directory
([#334](https://github.com/jeanibarz/agent-notebook/issues/334)); `~user/…`,
absolute and relative values are used verbatim. The shipped helper scripts under
`examples/` (git wrapper, janitor, backup, retrospective hook) SHALL resolve `NB_DIR` the
same way.
*Proven by:* `cli.test.ts` → the `path --usage …`, `path with an unrecognized
--flag …` and `NB_DIR with a leading ~ is expanded … (issue #334)` cases;
`notebook.test.ts` → `NB_DIR leading-tilde expansion (issue #334)`;
`examples-nb-dir-tilde.test.ts` (the helper scripts).

<a id="fr-list-001"></a>
**FR-LIST-001 (Should).** `listNotebooks(dir, {prefix?, limit?})` SHALL return the
notebook index — one `NotebookSummary {shelf, role, lessons, desc, auto}` per notebook (`role` is a deprecated copy of `shelf`, filled from the same value) —
ordered **richest-first** (descending `lessons`), ties broken by `shelf` name
ascending. `nb list` SHALL render it as a header line plus one aligned row per
notebook (name, lesson count, description); `ls`, `shelves` and the deprecated `roles` are aliases. When the default 50-row cap (no explicit `--limit`) leaves notebooks out, the output SHALL end with one flush-left `#` footer giving the number not shown and an `nb list [prefix] --limit <total>` command that lists them (issue #407); an explicit `--limit` and `--json` output are unchanged.
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
merely shares the stem (`reviews`). A shelf name SHOULD carry no prefix or one
level at most (`family.situation`): the convention is not a hierarchy, and no command
groups, counts or opens a level. `@` is NOT the grouping delimiter; it stays
reserved for the existing `shelf@project` scoping and MAY combine with a namespace
(`review.tests@some-repo`).
**Rationale:** "Group by concept" done the minimal, brand-safe way — lexically, by
name, not by a similarity engine ([NG-001](#ng-001)). It lets an agent see and open a
related cluster at the index level ([FR-LIST-001](#fr-list-001)) while adding no
schema, no field, and no filesystem structure. `.` is filesystem-safe cross-platform.
One level is enough to cluster the index; deeper names would split lessons that are
needed together into small shelves ([DP-8](#dp-8)), lengthen the injected index, and make
renames costly because shelf names match exactly.
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

<a id="fr-list-005"></a>
**FR-LIST-005 (Should).** When a mutation (e.g. `rm` of the last lesson) leaves a
notebook with **neither entries nor a `# desc:` metadata block**, the write SHALL
**reap** the `<shelf>.md` file — unlink it rather than leave a 0-byte file on disk —
so the phantom `listNotebooks` already hides ([FR-LIST-004](#fr-list-004)) does not
linger in the notebooks dir, every backup, and git history without bound. The reap
SHALL run under the same lock as the mutation and SHALL apply ONLY to a genuinely
empty file: a described-but-empty notebook (a `# desc:` block, no entries) is
non-empty and SHALL be preserved. It SHALL be best-effort — a reap failure SHALL NOT
fail the mutation.
**Rationale:** Completes the NB_DIR-hygiene line (the reap of `*.md.tmp` and
usage-log temps, issues #46/#163) for the one leftover it missed: an emptied,
undescribed shelf. Gating on "no entries AND no metadata" distinguishes a true
phantom (reaped) from a deliberate trigger (kept) without adding a field to a lesson
([NG-004](#ng-004)).
*Proven by:* `notebook.test.ts` → `describe('reaps an emptied, undescribed phantom shelf (issue #209)')`.

<a id="fr-list-006"></a>
**FR-LIST-006 (Should).** The cross-shelf scans — `listNotebooks` ([FR-LIST-001](#fr-list-001)),
`search` ([FR-SEARCH-001](#fr-search-001)), and the `stats` notebook inventory
([FR-STATS-002](#fr-stats-002)) — SHALL keep working when a single shelf file is unreadable. A non-`ENOENT` read failure for one shelf (e.g. `EACCES` on a
root-owned or `chmod`'d file after a `sudo nb`, `EISDIR` for a directory named
`<shelf>.md`, `EIO`) SHALL skip **only** that shelf and SHALL NOT abort the command;
every healthy shelf SHALL still be listed/searched and the command SHALL exit `0`.
The skip SHALL be surfaced, never silent: `NotebookListing.skipped`,
`SearchResult.skipped` and `StatsReport.skipped` SHALL carry `{shelf, code}` per skipped
shelf (`code` the errno code; only a throw carrying an errno is skipped — a codeless throw,
e.g. a parser bug, still propagates so the field never invents a non-errno token), `nb
list`/`nb search`/`nb stats` SHALL print one stderr line naming the shelf and code, and
`--json` SHALL include the additive `skipped` field **only when non-empty** so healthy
output stays byte-identical. A prefix or search scope whose only match is a skipped shelf
SHALL report that the matching shelf was unreadable, not "no match". A single-shelf command that names the bad shelf explicitly
(e.g. `nb show <bad-shelf>`) SHALL still fail loudly — the resilience applies only to
scans, so an error for an explicitly requested shelf is never hidden.
A `*.md` file whose stem is not a legal shelf name (`review copy.md`, `résumé.md`, left by a
file manager, sync tool or editor) is not a shelf: the same scans SHALL skip it the same way
(`skipped` carries `{shelf: <stem>, code: "INVALID_NAME"}`, the stderr line says the name is
invalid and to rename or remove the file), and `nb doctor` SHALL report it as an
`invalid-name` finding. Addressing such a name directly (`nb show "review copy"`) stays a
`bad_args` error.
**Rationale:** One unreadable file (a stray directory, a permissions slip from a `sudo`
run) previously turned every accumulated lesson into "nb failed" for `nb list`,
`nb search`, and the session-start index agents use to decide which shelves to open
(#332). Degrading to "one shelf is unreadable, here it is" preserves the rest of the
memory and keeps the failure actionable.
*Proven by:* `notebook.test.ts` → `describe('one unreadable shelf does not abort list/search (issue #332)')` and `describe('one unreadable shelf does not abort the stats inventory (issue #332)')`; `cli.test.ts` → the `list …` / `nb search …` / `nb stats …` "issue #332" cases.

<a id="fr-list-007"></a>
**FR-LIST-007 (Should).** Only a missing notebooks directory (`ENOENT`) SHALL count as an
empty store. When the directory exists but cannot be listed (e.g. `EACCES`, `EIO`, or
`ENOTDIR` for a regular file where the directory should be), `listShelves` SHALL throw an
error that names the directory and the errno and keeps the errno as its `code`, so `nb
list`, `nb search` and `nb stats` print one stderr line `nb <cmd>: cannot read notebooks
directory "<dir>" (<code>)`, exit `1`, and under `--json` emit the structured error object
of the CLI error path (`{ok:false, command, error:{class, message}}`). A throw with no errno
`code` SHALL propagate unchanged, as in [FR-LIST-006](#fr-list-006). A missing directory and
an empty readable directory SHALL still print "no notebooks yet" and exit `0`.
**Rationale:** A harness that injects `nb list` at session start must be able to tell "`nb`
failed" from "the store is empty". Before, any listing failure returned `[]`, so a store
`nb` could not read looked empty and the session ran with no memory and no warning (#383).
*Proven by:* `notebook.test.ts` → `describe('only a missing directory is an empty store (issue #383)')`; `cli.test.ts` → `describe('an unreadable notebooks directory is not an empty store (issue #383)')`.

### 4.10 CLI contract

<a id="fr-cli-001"></a>
**FR-CLI-001 (Must).** `nb` SHALL implement: `show <shelf>... [--json]` (one or more
shelves; `--json` emits a lone object for one shelf, an array for several),
`stale <shelf> [--limit <N>] [--json]` (cull candidates, [FR-SHOW-003](#fr-show-003)),
`add <shelf> ("<lesson>"|-)`,
`vote <shelf> <id|query> +1|-1` (a comma-separated id list is the batch form),
`merge`, `split <shelf> <id|query> "<a>" "<b>"`,
`rm`, `move <from> <to> <id|query>`, `describe <shelf> ["<text>"|-]`,
`search <query> [prefix] [--any] [--limit <N>]`,
`stats [<shelf>] [--since <N{d,h,m}>] [--json] [--exit-code]`, `doctor [--json] [--exit-code]`, `path [<shelf>] [--usage] [--json]`, `config [--json]`,
`list [prefix] [--limit <N>] [--json]` (aliases `ls`, `shelves`, and the deprecated `roles`),
`completion <bash|zsh>` ([FR-CLI-010](#fr-cli-010)), `--help`, `--version`. Every command
dispatched by `src/cli.ts` SHALL be named in this paragraph (guarded by `cli.test.ts` →
`describe('HELP ↔ dispatch drift guard (issue #131)')`, issue #340).
The `-` lesson operand of `add` reads from stdin per
[FR-ADD-007](#fr-add-007). The optional `[--reason <code>] [--note "<text>"]` flags are
consumed by every mutating op — `add`, `merge`, `rm`, `split`, `move`, and `describe` — (the
operation-reasons mechanism, [FR-REASON-001](#fr-reason-001)); they are stripped before
positional parsing so they are never mistaken for a lesson/operand/description text. A
`--` end-of-options terminator ([FR-CLI-007](#fr-cli-007)) lets a flag-shaped token be
passed as a literal operand.
`move` and `rm` SHALL emit a JSON result object with `--json` like the other mutating ops.

<a id="fr-cli-002"></a>
**FR-CLI-002 (Must).** Exit codes SHALL be: `0` success; `1` a handled operation
error (message on stderr); `2` an unknown command; `130`/`143` termination by
`SIGINT`/`SIGTERM` (`128 + signo`, see [FR-LOCK-002](#fr-lock-002)).

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

<a id="fr-cli-006"></a>
**FR-CLI-006 (Should).** A mutating command that names a shelf (`vote`, `rm`, `split`,
`move`) SHALL, when that shelf does not exist on disk (`notebookExists` is
false), fail with `no notebook for shelf "<name>"` rather than the core selector/empty
`"… is empty"` throw — so a mistyped shelf reads as a typo, not as a real empty notebook
that invites seeding a new lesson on the wrong shelf. When an existing shelf is a close
match (by the same `editDistance` closest-match rule as the command did-you-mean,
issue #171) it SHALL append an advisory `did you mean
"<nearest>"?`; otherwise it SHALL point the reader at `nb list`. The hint is ADVISORY and
SHALL NOT auto-correct, the error keeps the `no_match` class (exit `1`), and a shelf whose
file exists but holds no lessons is untouched — it still takes the core "is empty" throw,
preserving the `show` exists-vs-empty split (issue #166). For `move` only the source shelf
is guarded; a never-created *target* is created like `add`. The core mutation functions are
unchanged (the guard lives in the CLI, as it does for `show`).
*Proven by:* `cli.test.ts` → `describe('mutations distinguish a missing shelf from an empty one (issue #200)')` and `describe('closestShelf (shelf did-you-mean, issue #200)')`.

<a id="fr-cli-007"></a>
**FR-CLI-007 (Should).** `nb` SHALL honor `--` as an end-of-options terminator: every
token after the first `--` is a literal operand, never a flag, so a
lesson/description/query that is itself flag-shaped (e.g. `--json`, `--reason`) can be
passed as `nb add <shelf> -- --json` (issue #277). The option flags of
[FR-CLI-001](#fr-cli-001) (`--json`, `--reason`, `--note`) SHALL be recognized only
*before* the terminator; without a `--`, a bare flag-shaped token keeps its existing flag
meaning. A *bare trailing* `--` (no token follows) SHALL NOT act as a terminator, so
`vote`'s `--` downvote alias and a literal `--` operand are preserved. The per-command
read-flags `--any`/`--limit` (`search`, `list`, `stale`) SHALL likewise be recognized
only before the `--`, so a flag-shaped query/prefix after it is a literal operand.
`stats` keeps its own `argv` parse ([FR-CLI-003](#fr-cli-003)) and is unaffected: its
sole operand is a shelf name, which cannot be flag-shaped.
*Proven by:* `cli.test.ts` → `describe('nb `--` end-of-options terminator (issue #277)')`.

<a id="fr-cli-008"></a>
**FR-CLI-008 (Should).** `--json` SHALL be a complete machine contract on the failure
paths too (issue #266), so a supervisor never falls back to regex-parsing the English
prose on exactly the paths where structured data matters most. (1) When a command
*throws* under `--json` (a handled `NbError` — `bad_args`, `no_match`,
`ambiguous_selector`, `multiline_refused`, `too_long`, `corrupt` — or any other error such as an
`EACCES`/`ENOTDIR` write failure, which classifies as `other`), it SHALL write a single
structured error object to **stdout** — `{ ok: false, command, error: { class, message } }`,
where `class` is the same bounded `ErrorClass` token the usage log records (issue #176,
never parsed from the message text) — *in addition to* the unchanged English line on
stderr. An unknown command SHALL emit the same object keyed `class: "unknown_subcommand"`.
Exit codes are unchanged ([FR-CLI-002](#fr-cli-002)): `1` for a handled error, `2` for an
unknown command. (2) When a flag value is unrecognized and the command silently falls back
to a default (`stats --since`, and `--limit` on `search`/`list`/`stale`), under `--json` it
SHALL also write a machine-readable warning object to **stderr** —
`{ warning: { class: "defaulted_flag", command, flag, value, usedDefault } }` — alongside
the unchanged prose line, so the defaulted value is discoverable without regex-parsing
prose. The warning stays on stderr so the bare-result-object stdout contract
([FR-CLI-003](#fr-cli-003)) is never corrupted; exit stays `0` (a defaulted flag is
forgiving, [DP-5](#dp-5)). Without `--json`, every throw and defaulted-flag path is
byte-for-byte unchanged.
*Proven by:* `cli.test.ts` → `describe('--json completes the machine contract on throw + defaulted-flag paths (issue #266)')`.

<a id="fr-cli-009"></a>
**FR-CLI-009 (Must).** An unrecognized long option SHALL be refused rather than silently
ignored or absorbed as a positional (issue #267). Each command accepts a bounded set of
long options — the global `--json` (every command), the mutation `--reason`/`--note`
([FR-CLI-001](#fr-cli-001)), and the per-command flags (`--any`/`--limit` on the read
commands, `--exit-code`/`--since` on `stats`, `--usage` on `path`) — and any OTHER
`--`-prefixed token *before* the `--` terminator SHALL fail with a `bad_args` error
(exit `1`, message on stderr; the structured `{ ok:false, … }` object on stdout under
`--json` per [FR-CLI-008](#fr-cli-008)), naming the offending option and, when one is close
by the same `editDistance` rule as the command did-you-mean ([FR-CLI-006](#fr-cli-006),
issue #171), appending a `Did you mean \`<nearest>\`?` hint. **Rationale:** before this, a
typo'd `nb stats --exitcode` ran WITHOUT the `--exit-code` health gate and still exited `0`,
so `nb stats --exitcode || alert` (the #129 cron health-gate) silently stopped firing — a
[DP-5](#dp-5) "never silently mislead" violation defeated by one missing hyphen. Exempt, so
[FR-CLI-007](#fr-cli-007) is preserved: every operand *after* a `--` terminator and a bare
trailing `--` are literal operands, never checked as flags; a value-taking flag's value
token (`--note --json`) is consumed, never re-examined. An unknown *command* is unaffected —
it keeps the exit-`2` [FR-CLI-002](#fr-cli-002) path, never downgraded to this exit-`1` one.
*Proven by:* `cli.test.ts` → `describe('nb unknown-flag rejection (issue #267)')`.

<a id="fr-cli-010"></a>
**FR-CLI-010 (Should).** `nb completion <bash|zsh>` SHALL print a static, offline,
dependency-free shell-completion script to stdout and exit `0`; it SHALL perform no network
access and mutate no notebook. The script completes the command set and, where a command
takes a shelf, existing shelf names via a guarded `nb list` call. A missing or unsupported
shell SHALL be a `bad_args` error (exit `1`, naming the supported shells), not an unknown
command (exit `2`). The shipped `examples/completion/` files SHALL match the emitter.
`nb stale <shelf> [--limit <N>] [--json]` is read-only and lists cull candidates, lowest
score then stalest first (see [FR-SHOW-003](#fr-show-003)).
*Proven by:* `cli.test.ts` → `describe('nb completion (shell completion, issue #187)')`
and `describe('nb stale — cull candidates (issue #240)')`.

<a id="fr-cli-011"></a>
**FR-CLI-011 (Should).** `nb doctor [--json] [--exit-code]` SHALL be a strictly read-only
check of the notebooks directory: it SHALL take no lock and write no shelf. On a clean directory
it prints a one-line OK summary and exits `0`. Each finding has a stable `code` — `conflict-marker`,
`bad-score` (no valid `<score>\t` prefix), `control-char`, `lesson-too-long`, `duplicate-lesson` (a later line whose dedup key repeats an earlier one in the same shelf, so both share one id and no selector can pick either; one finding per later copy, [FR-SEL-002](#fr-sel-002)), `shelf-over-cap`,
`empty-file` (0 bytes), `case-collision`, `leftover-temp` (older than `NB_STALE_LOCK_MS`, so a live
writer's temp is not reported), `stale-lock`, `unreadable`, `invalid-name` (a `*.md` whose stem is not a legal shelf name, [FR-LIST-006](#fr-list-006)) — a `shelf` and, for line-level
findings, a 1-based `line`. `--json` emits `{schemaVersion, shelves, findings:[{code, shelf, line?, message}]}`
(`shelves` is the number of shelf files examined, so `0` tells a gate nothing was checked);
`--exit-code` exits `3` when any finding exists, otherwise the exit is `0` — including for a
nonexistent or shelf-less directory, whose human line says so explicitly ("0 shelves checked
(the notebooks directory does not exist | holds no shelf)"). The summary pluralizes ("1 shelf").
The detectors are the ones the guards use (conflict markers, control characters, the temp
predicate), so definitions cannot drift.
*Proven by:* `cli.test.ts` → `describe('nb doctor (issue #338)')`.

<a id="fr-config-001"></a>
**FR-CONFIG-001 (Should).** `nb config` SHALL print every effective (post-clamp) tunable
as `name=value`, one per line — `maxLines`, `maxChars`, `nearThreshold`, `usageRing`,
`usageRingSlack`, `staleLockMs`, `lockGraceMs`, and the `nb stats` thresholds
`loopN`/`loopWindowSec`/`silentHours`/`errMin`/`addBurstN`/`errRate`/`coverageHi`/`recallMissHi` — each
read from the SAME exported getter the hot path uses (see [§7](#7-configuration)), so a
printed value can never drift from the value in force. Each line SHALL be tagged with its
source: `(default)` when the backing `NB_*` var is unset, `(env NB_*)` when it is set, or
`(derived …)` for a value computed from another (`usageRingSlack`). Because the printed value
is always the post-clamp effective one, a set-but-out-of-range or non-numeric var reads `env`
while its value is shown corrected — the pair never silently misleads ([DP-5](#dp-5)).
`nb config --json` SHALL emit one object keyed by tunable name, each value
`{ value, source, env }`. For each *set* numeric tunable, `nb config` SHALL additionally
report how the raw value was resolved ([issue #336](#fr-config-001)): `honored` (used as given),
`clamped` (a parseable value outside the bound, with the raw value quoted), or `ignored` (an
unparseable value that fell back to the default — int tunables require a *whole* integer, so a
partially-numeric value `parseInt` would have truncated, such as `1e3` or `12.9`, is `ignored`,
never honored as a rewritten `1`/`12`). The human path appends this to the source tag —
e.g. `(env NB_NEAR_DUP: clamped to 1 from 2)` or `(env NB_MAX_LINES: ignored "abc", not an integer;
using default)` — and `--json` gains the additive `status` (`"honored"`/`"clamped"`/`"ignored"`,
`null` when unset or derived) and `rawValue` (the raw env string, `null` when unset) fields, leaving
`source` and every existing key unchanged. Output for a config with no problems SHALL be
byte-identical to the pre-#336 form. `nb config` SHALL further list every `NB_*` environment
variable it does not read as *not read by `nb`* (with a nearest-name `did you mean` suggestion when
one is close) — in the human output as a trailing block and in `--json` as an additive top-level
`unrecognized` array — derived from the SAME registry `effectiveConfig` uses, informational only
(never an error, exit code stays `0`). Variables read only by the tooling shipped under
`examples/` (`NB_BIN`, `NB_RETRO_TTL_DAYS`, `NB_GIT_AUTOCOMMIT`, `NB_GIT_SESSION_TRAILER`, `NB_BACKUP_PUSH_TIMEOUT`,
`NB_BACKUP_GIT_LOCK_WAIT`) SHALL NOT be flagged — they belong to those tools, not to `nb`. `nb config` SHALL be read-only (it mutates no notebook) and is scoped
to *configuration*, distinct from `nb stats` (usage, anomalies, engagement). To surface the
`nb stats` thresholds without duplicating their clamp logic, `stats()` reads them through those
exported getters rather than inline — a behavior-preserving extraction (same defaults, same
clamps). The command is in `KNOWN_COMMANDS`/HELP/dispatch so the [FR-CLI-001](#fr-cli-001) drift
guard stays green.
*Proven by:* `cli.test.ts` → `describe('config — effective (post-clamp) tunables (issue #188)')`.

<a id="fr-config-002"></a>
**FR-CONFIG-002 (Should).** Below the numeric tunables, `nb config` SHALL print the three
behavior-critical *string* env vars that most often explain a misbehaving deployment but that
`FR-CONFIG-001`'s numeric table structurally cannot hold: `NB_DIR` (storage location),
`NB_SESSION` (the id the usage/engagement diagnostics group by — its unset state is the usual
cause of `nb stats` reporting "no engaged sessions"), and `NB_ASCII` (rendering mode). Each SHALL be shown as `NAME=value` where `value` is read from the
SAME resolver the hot path uses — `notebooksDir()`, the effective `NB_SESSION`, and `asciiMode()`
(post-locale) — so it can never drift from the value in force, and SHALL be tagged `(env)` when
the var itself is defined or `(default)` otherwise (the `!== undefined` rule of
[DP-5](#dp-5): a set-but-blank `NB_DIR` reads `(env)` while its value falls back to the default
dir; an `NB_ASCII` left unset but forced on by a non-UTF-8 locale reads `on (default)`).
`nb config --json` SHALL carry these under a new top-level `environment` key, keyed by var name,
each value `{ value, source }`, leaving the numeric rows' keys and `{ value, source, env }` shape
unchanged so the `--json` contract stays backward-compatible (a new section, not a changed row
type).
*Proven by:* `cli.test.ts` → `describe('string env section — NB_DIR / NB_SESSION / NB_ASCII (issue #312)')`.

### 4.11 Durability & concurrency

<a id="fr-lock-001"></a>
**FR-LOCK-001 (Must).** Every notebook mutation (`add`/`vote`/`merge`/`split`/`rm`/`move`) SHALL run
under a `mkdir`-based spinlock on `.nb.lock`. A lock whose holder has been silent
longer than a stale-steal threshold (`NB_STALE_LOCK_MS`, default ~10s) SHALL be
treated as abandoned by a crashed process and stolen. The acquire budget SHALL be
*derived* as that threshold plus a grace margin (`NB_LOCK_GRACE_MS`, default ~2s),
so it is always ≥ the threshold; otherwise a caller meeting a just-crashed holder's
still-fresh lock would give up before the lock could ever age enough to be stolen,
and every mutation would fail with 'locked' until the stale lock aged out. The
acquire loop SHALL treat only an `EEXIST` from `mkdir(.nb.lock)` as a held lock;
any other error (e.g. `EACCES`/`EPERM`/`EROFS`/`ENOSPC` from an unwritable
`NB_DIR`) SHALL fail fast with a clear 'directory is not writable' error that
names the underlying code, rather than busy-waiting the whole acquire budget and
then reporting a misleading 'locked' when no other process exists (issue #263).
(The usage log is appended outside this lock — see [FR-USAGE-001](#fr-usage-001).)
**Rationale:** Serial CLI calls on one host occasionally overlap; the lock keeps a
concurrent `add`+`vote` from corrupting the file, and stale-steal recovers from a
crashed process — recovery that is reachable only when the acquire budget is at
least the steal threshold (issue #133).
*Proven by:* `notebook.test.ts` → `describe('locking (mkdir spinlock)')`, in particular
"a crashed holder's fresh lock is reclaimed WITHIN the acquire window, not thrown (issue #133)"
and "a genuinely live holder that keeps its lock fresh still times out, reporting the DERIVED budget"
— the latter asserts the thrown timeout message reports the derived budget (`staleMs + grace`),
which proves the acquire deadline is >= the steal threshold. The fail-fast guarantee is proven by
"fails fast (not 'locked') when mkdir(.nb.lock) throws EACCES — unwritable store (issue #263)"
(and its `EROFS`/`ENOSPC` siblings), which inject an unwritable store and assert the mutation rejects
well under the acquire budget with a 'not writable' error naming the errno, not 'notebook is locked'.

<a id="fr-lock-002"></a>
**FR-LOCK-002 (Must).** The CLI SHALL install `SIGINT`/`SIGTERM` handlers so an
interrupt (Ctrl-C) or a harness `SIGTERM` during a mutation does not strand
`.nb.lock`. Installing the handlers changes the signals' default "terminate now"
disposition to a deferred callback, so an in-flight mutation's synchronous critical
section — including [FR-LOCK-001](#fr-lock-001)'s release — runs to completion before
the process exits; the handler additionally releases any lock the process still owns,
then exits with the conventional `128 + signo` status (130 for `SIGINT`, 143 for
`SIGTERM`). A handler SHALL release *only* a lock this process owns — ownership is
established solely by this process's own atomic `mkdir` acquire, never by stealing a
stale lock nor while spinning — and SHALL never remove another live `nb`'s lock.
Normal, un-signalled exit paths SHALL be unchanged.
**Rationale:** Without the handlers a default-disposition signal kills the process
before the lock is released, stranding `.nb.lock` so the next mutation blocks the
full `staleLockMs + lockGraceMs` (~12s) stale-steal window before it can self-heal —
an avoidable stall on a tool whose promise is that a call is a millisecond (issue
#247).
*Proven by:* `nb-signal-lock.test.ts` → `describe('releaseHeldLock — ownership (issue #247)')`
(an owned lock is released, a foreign lock is never removed, and release is idempotent)
and `describe('signal handler in the real built CLI (issue #247)')`, which delivers a
real `SIGINT`/`SIGTERM` to a built process with the handlers installed and asserts it
exits 130/143 and leaves a lock it does not own intact.

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
**FR-USAGE-001 (Must).** Each CLI invocation — including `--help`/`--version`, which
log a lightweight best-effort row under the canonical command `help`/`version` (with
an empty shelf and no entry-level columns) so that a harness that only ever runs
`nb --help` is still visible to `nb stats` rather than leaving no trace — SHALL
append one tab-delimited row to the usage ring, bounded to `usageRing` rows (oldest
dropped). The row's first five columns SHALL be
`"<iso-ts>\t<shelf>\t<command>\t<ok|err>\t<ms>ms"`, followed by the five entry-level
columns of [FR-USAGE-002](#fr-usage-002) and the two reason columns of
[FR-USAGE-003](#fr-usage-003). A failure to log SHALL NOT fail the
operation (so `--help`/`--version` still succeed on a read-only `NB_DIR`), and every
field SHALL be sanitized (tab/CR/LF collapsed to spaces, other control characters such
as ESC/BEL dropped) so a value cannot inject an extra column or row or reach a terminal.
The `shelf` column SHALL record only a syntactically valid shelf name (anything else,
e.g. a lesson typed in the shelf position, is logged as `-`), and the `shelf` and
`command` columns SHALL be capped to the same per-field length as `note`/`session`
(issue #375). `nb stats` SHALL strip control characters from log-derived output, so a
row written by an older `nb` cannot emit an escape sequence either.
**Rationale:** Monitoring must itself be bounded and must never break a real call;
the "every call appends one row" invariant is what lets `nb stats` see the classic
integration-not-wired symptom of a harness that only ever calls `--help`.
*Proven by:* `notebook.test.ts` → `describe('usage log + stats')`; the `--help`/`--version`
rows by `cli.test.ts` → `describe('runNbCli')` → the two `issue #250` usage-row tests.

<a id="fr-usage-002"></a>
**FR-USAGE-002 (Should).** Each usage row SHALL additionally record, after the five
base columns, five entry-level/outcome columns:
`"\t<session>\t<entry-ids>\t<outcome>\t<collided-id>\t<evicted-id:score>"`, where
`session` is the value of `NB_SESSION` at call time (blank when unset — co-access is
then not computed), `entry-ids` is the comma-joined stable id(s) the call touched,
`outcome` is `accepted`/`dedup-blocked`/`empty`/`too-long` for `add` (plus
`rejected-full` in logs predating the always-admit policy; `add` no longer emits it),
`up`/`down` for `vote`, `removed` for `rm`, `merged` for `merge`, `split` for `split`,
`moved`/`move-blocked` for `move` (the latter when the target already held a
near-duplicate), and blank for a
read-only command, `collided-id` is the id of the existing entry that blocked a
`dedup-blocked` add or a `move-blocked` move, and `evicted-id:score` records the
entry/entries an `add`/`merge`/`split`/`move` evicted, each as `<id>:<finalScore>`.
A single eviction is one such pair (byte-identical to the original format); a cap
*decrease* can evict many at once (issue #306), so the column SHALL list all of them
comma-joined, bounded to `maxChars` by keeping whole pairs from the front and
appending a `+<dropped>` marker so the total evicted count stays recoverable — this
column has a single consumer (**eviction-while-still-voted**, [FR-STATS-003](#fr-stats-003)),
which skips the marker, so the count-preserving sentinel is safe here (unlike the
silently-truncated `entry-ids` column above). The `session` value SHALL be truncated
to `maxChars` (with the same trailing-ellipsis convention as `note`, never rejected —
logging is best-effort), since it is caller-influenced free text appended to every
row and must not let the ring's row-count bound stop bounding its bytes (issue #202,
extending the `note` cap of [FR-USAGE-003](#fr-usage-003) / [NFR-BOUND-001](#nfr-bound-001)).
The `entry-ids` column SHALL likewise be bounded to `maxChars` for the whole
comma-joined list: a `search match` row records the full pre-`limit` surfaced ids
(every hit across every matching notebook), so without a cap a single broad `search`
would let one row's bytes grow without bound even though the ring's row count is
fixed. The cap applies to every command's id-list (a large batch `vote` can overflow
it too), keeping as many WHOLE ids from the front as fit (never a mangled partial id
a reader could mistake for a real entry); it is best-effort and never rejected. Unlike
the `note`/`session` caps this truncation SHALL be SILENT — no trailing sentinel —
because the parser splits this column back into individual ids that the diagnostic
reads iterate, so any marker token would be read as a phantom entry id (issue #264,
completing the per-column byte bound of issues #128/#202 for the last
unbounded-length column).
The parser SHALL tolerate an old five-column row written before this
change, reading the missing columns as blank/empty.
**Rationale:** Diagnostic signals (recall/precision, co-access, findability, coverage
× surfacing) rest on entry-level data living in the log, not the notebook — this adds
no field to a lesson ([NG-004](#ng-004)), keeping the one-line / no-schema contract.
*Proven by:* `notebook.test.ts` → `describe('entry-level + outcome logging (issue #67)')`
and `cli.test.ts` → `describe('usage log records entry ids + outcome (issue #67)')`; the
`session` cap by `notebook.test.ts` → `describe('usage log + stats')` →
`test('caps an over-long NB_SESSION to maxChars, same as the note (issue #202)')`; the
`entry-ids` cap by `notebook.test.ts` → `describe('operation reasons (seed-and-grow enum)')` →
`test('a broad search row\'s entries id-list is truncated so one row stays byte-bounded (issue #264)')`.

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
`rm` seeds `wrong · obsolete · other`, `split` seeds `overloaded · other`, and `move`
seeds `consolidate · other`; `add` and
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
(≥`NB_LOOP_N` calls of one command on one shelf within `NB_LOOP_WINDOW_S`; calls are
grouped per session when the row's session is non-blank, so several agents each making one
call are not one stuck agent, and blank-session rows are grouped together as before),
**went-silent** (used historically, zero in-window, and last seen longer than `NB_SILENT_H`
ago; rows with error class `unknown_subcommand` do not count as use, so a mistyped command
name is never reported),
**high-error-rate** (≥`NB_ERR_MIN` calls and ≥`NB_ERR_RATE` failures).
The **high-error-rate** detail names the causes of the flagged command's error rows with the
same rule as the per-command error-cause readout: the row's error class, else `too_long` when a
row without a class recorded the `too-long` outcome, else `unclassified` — so the two lines
report the same split for the same rows (issue #418).
*Proven by:* `notebook.test.ts` → `the high-error-rate detail and the error-causes readout agree on a mixed-age log (issue #418)`.

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
(an `add` where **any** evicted entry's final score was above the +1 a new entry starts at → a useful
lesson was lost; evicting an entry at +1 or below is the cap working as intended — and because a cap
*decrease* can evict many entries in one `add` ([FR-USAGE-002](#fr-usage-002), issue #306), this
signal SHALL count **each** still-voted entry in that row's `evicted` list, not just the first),
and **vote-reversal** (one entry id with an `up` vote in one session and a `down` vote in a
**different** session → correct but mis-aimed). browse-without-use and vote-reversal are
session-scoped and SHALL skip rows with a blank session ([FR-USAGE-002](#fr-usage-002):
"co-access is then not computed"). The human report SHALL fold browse-without-use into one line per shelf carrying the session count (busiest first); `signals[]` in `--json` keeps every (session, shelf) pair (issue #415). The field is additive — the report from
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
- **serendipity** ([#114](https://github.com/jeanibarz/agent-notebook/issues/114))
  (share of upvotes on lessons that *arrived unbidden*) = push-delivered upvotes ÷
  `upvotes`, where an upvote is *push-delivered* iff its entry id was **not** returned
  by any `search` in the same session (the CLI `search` case logs its surfaced ids —
  see [FR-SEARCH-002](#fr-search-002)); `upvotes` (= `up` votes in engaged sessions) is
  reported alongside as its denominator, since `votesActedOn` (= `up` + `down`) cannot
  recover it. The pull evidence is read **deployment-wide** (search rows are logged
  under shelf `-`, so a shelf-scoped report would otherwise never see the cross-notebook
  search that marks one of its upvotes a pull);
- a **readout** placing (coverage, recallMiss) on the coverage×surfacing 2×2 —
  `healthy` / `surfacing-failure` / `coverage-building` / `churny` (a heuristic hint,
  not a verdict), with the LOW/HIGH cutoffs `NB_COVERAGE_HI` (default 0.5) and
  `NB_RECALL_MISS_HI` (default 0.2).

Each rate SHALL be conditioned on **attempts** (`addAttempts` = `accepted` +
`dedup-blocked` + `rejected-full`, excluding the malformed `empty`/`too-long`;
`rejected-full` is a historical outcome — the always-admit policy no longer
produces it, but old logs may still carry it, so it stays in the denominator;
`votesActedOn` = `up` + `down`; votes are counted **per lesson** — a batch vote row
listing N landed ids counts N votes, each tested separately for search-pull provenance
— [#373](https://github.com/jeanibarz/agent-notebook/issues/373)), so a lazy agent is a small sample rather than a
deflated `0`. Each rate SHALL be **gated on engagement**: only sessions that show a
vote are scored (a vote-less or blank-session row is excluded as a setup/plumbing gap,
not read as "healthy quiet"). A rate with an empty denominator (no engaged sessions, or
no attempts within them) SHALL be `null`, never a misleading `0` ([DP-5](#dp-5)); the
human table shows `null` as `—`. Every delivered lesson is currently treated as *pushed*
for `precisionMiss` (per [NG-007](#ng-007)); now that `nb search`
([FR-SEARCH-001](#fr-search-001)) exists, narrowing this to *non-search-delivered* lessons
is a possible future refinement, not yet implemented. `serendipity` applies exactly that
narrowing to the *upvote* side. The field is additive — the rest of the report
is unchanged. `--json` SHALL emit it inside the `StatsReport`.

`serendipity` SHALL be published as a two-sided **proxy, never a one-sided bound**
([DP-5](#dp-5)): it *over*-counts push (an agent-chosen `show`-pull or in-session recall
is indistinguishable from an injection, so it stays in the numerator) **and** *under*-counts
it (a pushed lesson that also surfaced in a same-session search is scored a pull). The two
biases are of unknown relative size, and usage-ring churn (an evicted search row, or an
`entryId` changed by a merge/split/reword between the search and the vote) silently drops
pull evidence — so the rate is an approximate direction-of-travel indicator, and the
docstring, the human `nb stats` line (a leading `~`), and the design rationale SHALL label
it as such. A **positive** record of a push (the clean, one-sided signal) requires tagging
the session-start injection hook's own read with a provenance marker — an attribute on work
the hook already performs, not a synthetic write; it lives in the kookr runtime hook, is
tracked under the #73 session-start injection contract (cross-repo), and is NOT in scope
here (see RFC 0114). Because serendipity joins `search` provenance across notebooks by
session id, it assumes `NB_SESSION` is a per-task id not shared by concurrent tasks (the
same assumption as every session-scoped signal; blank sessions are excluded) — an
epic-#73 / deployment contract, not introduced here.
**Rationale:** The free signals ([FR-STATS-003](#fr-stats-003)) point at *which* entry
or description needs attention; these named rates say whether the notebook is covering
and surfacing at all. The recall-miss rate is the clearest failure (re-learning what you
already stored); precision-miss is its counterweight so "surface everything" is not free
([DP-8](#dp-8)). All derived from behaviour the agent already performs.
*Proven by:* `notebook.test.ts` → `describe('surfacing metrics (issue #81)')` and
`cli.test.ts` → the surfacing-metrics table/`--json` tests.

<a id="fr-stats-005"></a>
**FR-STATS-005 (Should).** `stats` SHALL additionally report an **ops-over-time
activity sparkline** — the windowed, shelf-scoped usage rows bucketed into
**rolling 24-hour windows counting back from `now`** (not calendar days, so the
read is timezone-free and deterministic given `now`) — surfaced both as one human
line under the `nb usage — …` header and as `StatsReport.activity` (a `number[]`,
**oldest bucket first**) in `--json`. The bucket count SHALL be
`max(1, ceil(windowMs / 86_400_000))` (a `7d` window → 7 buckets, `12h` → 1), and
every scoped in-window row SHALL land in exactly one bucket so that
**`sum(activity) === totalCalls`** — the rendered `(<window>, N ops)` label is
exactly that scoped total. Each bucket count SHALL be mapped to one of the eight
Unicode block glyphs `▁▂▃▄▅▆▇█` by **zero-based** scaling (not min–max): a silent
(0-op) bucket SHALL read as the floor glyph `▁` and the window's busiest bucket as
the full block `█`, so "went quiet" is legible (the testable identity is
`sparkline([0,1,2,3,4,5,6,7]) === '▁▂▃▄▅▆▇█'`; an empty series renders `''`). An
empty or single-day window SHALL render without crashing. Scope follows the rest
of the report, and the feature SHALL add no runtime dependency ([DP-7](#dp-7)) and
no field to a lesson ([NG-004](#ng-004)) — it is a pure read of the usage ring.
See [RFC 0106](./rfcs/0106-stats-activity-sparkline.md) for the design and the
zero-based-vs-min–max rationale.
**Rationale:** `nb stats` otherwise shows activity per command but nothing *over
time*; "when did this store go quiet?" is a core observability question. Rolling-24h
bucketing keeps the read timezone-free and unit-testable with a fixed `now`, and
zero-based scaling anchors the floor glyph to zero (the origin) rather than to the
window's busiest-relative minimum, so a fully silent window reads as the floor `▁`
instead of being stretched to look busy ([DP-5](#dp-5)). Derived entirely from
behaviour the agent already performs.
*Proven by:* `notebook.test.ts` → `describe('sparkline (issue #106)')` and
`describe('activityByDay (issue #106)')`, and `cli.test.ts` → the human
activity-line test and the `stats --json … activity` test (both issue #106).

<a id="fr-stats-006"></a>
**FR-STATS-006 (Should).** `stats` SHALL additionally report the **usage ring's own
occupancy** as `StatsReport.usageRing = { rows, cap }`, where `rows` is the total
row count held on disk and `cap` is `usageRing()` (the `NB_USAGE_RING` bound of
[NFR-BOUND-001](#nfr-bound-001)), surfaced both as a human `usage ring: <rows>/<cap> rows`
line in the `nb stats` table (flagged `FULL` at the cap) and in `--json`. This is
**total** occupancy — independent of the `--since` window and the `[<shelf>]` scope,
so it is NOT the windowed `totalCalls` — read from the same `parseUsage` the report
already performs (no second ring read). Additive to the report: `STATS_SCHEMA_VERSION`
SHALL NOT bump ([#172](#fr-stats-001) additive-field policy), every prior field is
unchanged, and it adds no field to a lesson ([NG-004](#ng-004)).
When the ring is at capacity and its oldest retained row is newer than the window start
(the log no longer reaches back to `--since`; issue #406), `usageRing` SHALL additionally
carry `oldest` (that row's ISO timestamp) and `coversWindow: false`, and the table SHALL
print one extra line under the ring line stating how far back the log reaches; otherwise
`usageRing` is exactly `{ rows, cap }` and the text output is unchanged.
**Rationale:** The notebook inventory (issue #40) made per-shelf cap pressure visible,
but the usage ring — whose fill decides when the oldest monitoring history is dropped —
had no such readout; "why did my window lose older data?" otherwise needs reading the
log by hand.
*Proven by:* `notebook.test.ts` → `describe('usage log + stats')` →
`test('reports usage-ring occupancy (rows/cap), total and window-independent (issue #206)')`,
and `cli.test.ts` → `test('the human stats table shows the usage-ring occupancy line (issue #206)')`.

<a id="fr-stats-007"></a>
**FR-STATS-007 (Should).** The two interrupt-recovery actions that each mean a previous
`nb` died mid-mutation — the stale-lock **steal** of [FR-LOCK-001](#fr-lock-001) and the
leftover-temp **reap** of [FR-DUR-001](#fr-dur-001)/the NB_DIR-hygiene sweep — SHALL be
**counted and made observable**, without changing either recovery action. Each usage row
([FR-USAGE-002](#fr-usage-002)) SHALL carry a trailing **`recovered`** column recording the
recovery performed *during that call* as `<lockSteals>:<tempReaps>` (blank in the common
no-recovery case), where `lockSteals` is the number of stale `.nb.lock`s the acquire loop
stole and `tempReaps` is the number of leftover `*.md.<pid>.tmp` / `.nb-usage.log.<pid>.tmp`
files `reapLeftoverTemps` removed. The column SHALL be appended after `decayed` so the
parser reads a pre-#309 row's missing column as blank, exactly as every prior trailing
column was added. `stats` SHALL sum the column across the window into
`StatsReport.crashRecovery = { lockSteals, tempReaps }`, surfaced both as a human
`crash recovery: <n> stale locks stolen, <m> leftover temps reaped (window)` line (with a
trailing `⚠ crashes recovered` marker when either count is nonzero) and in `--json`. Like `usageRing` ([FR-STATS-006](#fr-stats-006)) this readout is **deployment-wide**
— the `.nb.lock` and the temp debris are shared across every shelf — so a `[<shelf>]` scope
narrows the rest of the report but NOT this (only the window applies). A clean deployment
reports `{ 0, 0 }`, SHOWN rather than omitted so "measured, healthy" is never confused with
"not measured" ([DP-5](#dp-5)). The counting SHALL be **best-effort** — a failure to record
SHALL NOT fail the mutation nor alter the recovery — and is additive: `STATS_SCHEMA_VERSION`
SHALL NOT bump ([#172](#fr-stats-001) additive-field policy), and it adds no field to a lesson
([NG-004](#ng-004)).
**Rationale:** Both recovery paths were entirely silent — no log, no counter, no signal — so
an operator running `nb` from agent hooks could not answer "are my agents crashing mid-write
and losing updates?", a first-class reliability question for a multi-agent store. The stolen
lock and the reaped temp are exactly that evidence; counting them turns a silent self-heal
into an observable one, read for free from behaviour `nb` already performs (issue #309).
*Proven by:* `notebook.test.ts` → `describe('crash-recovery observability (issue #309)')`
(the stale-lock steal and planted-temp reap are tallied, round-trip the `recovered` column,
and sum into `crashRecovery` deployment-wide and window-scoped), and `cli.test.ts` → the
`issue #309` crash-recovery stats tests.

<a id="fr-stats-008"></a>
**FR-STATS-008 (Should).** A **batch** `vote` (`nb vote <shelf> id1,id2,id3 +1`) that
resolves at least one id but skips others exits `0` (a best-effort success), so its skipped
ids — stale selectors a reader should see — were invisible to the `errorClass`-keyed vote
error-cause readout (issue #223), which only reads rows that exited non-zero. Each such row SHALL instead record the count of skipped ids in a trailing
**`misses`** column (a non-negative integer, blank in the common no-miss case), appended
after `recovered` ([FR-STATS-007](#fr-stats-007)) so the parser reads a pre-#310 row's
missing column as `0`, exactly as every prior trailing column was added; the parser SHALL
clamp a non-numeric or negative cell to `0`. The column SHALL be a dedicated miss counter,
NOT `errorClass`, so recording it does not change the `0` exit of a partly-successful batch.
`stats` SHALL fold each row's `misses` into the `vote` command's error-cause breakdown as the
`no_match` cause — the same class a wholly-failed vote stamps — counting each skipped id as
one miss event toward both the breakdown and its denominator, subject to the same
dominant-error noise floor applied to every cause. The per-command error **rate**
([FR-STATS-001](#fr-stats-001)) SHALL be unchanged — it counts whole failed calls, so a batch
that exited `0` stays a success there; only the cause readout surfaces the folded misses. The
all-fail batch (which exits `1` with `errorClass` `no_match`) and the single-vote path SHALL
be untouched. The counting is additive: `STATS_SCHEMA_VERSION` SHALL NOT bump and it adds no
field to a lesson ([NG-004](#ng-004)).
**Rationale:** Batch vote (#223/#224) was added for the end-of-session retro that promotes
several lessons at once; the moment ≥1 id landed, any stale ids in the same call were laundered
out of the "agents voting on ids that no longer exist" signal that drives curation health —
exactly the signal `nb stats` exists to watch. Recording the skipped count turns a silent
partial failure into an observable one, read for free from behaviour `nb` already performs
(issue #310).
*Proven by:* `cli.test.ts` → the `issue #310` batch-vote tests (a partial batch logs
`misses`, keeps exit `0`, and surfaces end-to-end in `nb stats`; the all-fail and fully-landed
paths record no misses), and `notebook.test.ts` → `describe('usage log + stats')` (`misses`
round-trips the column, clamps a negative cell, folds into the vote error causes without
inflating the error rate, and respects the noise floor on miss events).

<a id="fr-stats-010"></a>
**FR-STATS-010 (Should).** The `stats` notebook inventory SHALL carry, per shelf, `adds` (the
`accepted` `add` rows for that shelf in the window), `addsPerDay` (`adds ÷ window days`, two
decimals) and `retentionDays` — `cap ÷ addsPerDay` to one decimal when the shelf is at its cap and
took at least one add, else `null` (never 0 or Infinity, [DP-5]). The human table prints
`N adds (R/day)` on every shelf row and `, ~Dd retention` on a full one. `stats` SHALL also emit an
`add-burst` diagnostic signal for each (session, shelf) pair whose accepted adds exceed
`NB_ADD_BURST_N` (default 15); a blank session is skipped. The change only counts rows
[FR-USAGE-002](#fr-usage-002) already writes: no field is added to a lesson ([NG-004]), no aging
rule or scheduler ([NG-005]), and `STATS_SCHEMA_VERSION` SHALL NOT bump (additive).
**Rationale:** On a full shelf eviction and aging fire once per add, so the time an unvoted lesson
has to earn a vote is `cap ÷ add rate`. Nothing showed that rate, so "a full shelf is normal"
could not be told from "this shelf forgets a lesson in ten days" (issue #353).
*Proven by:* `notebook.test.ts` → `describe('stats add rate, retention window and add-burst (issue #353)')`
and `cli.test.ts` → the `stats table shows the notebook inventory` tests.

<a id="fr-stats-009"></a>
**FR-STATS-009 (Should).** When `stats` is scoped to a shelf operand that has no
`<shelf>.md` AND the requested window holds no usage rows for it, `stats` SHALL print one
advisory note on **stderr** (`nb stats: no shelf named "<x>"`, plus `— did you mean "<y>"?`
when a shelf is close, reusing the `closestShelf` did-you-mean helper from issue #200),
so a typo is never mistaken for a real shelf that has gone
silent. The note is **advisory only**: the exit code and stdout (the human table and the
`--json` `StatsReport`, still a single valid object) SHALL be unchanged. A shelf that no
longer exists but still has historical in-window rows SHALL NOT be flagged — only the
"no rows other than `stats`' own" case is a typo signal (`stats` logs each call under the
operand as its shelf, so its own rows are ignored and the note repeats on every call). An unsafe shelf name SHALL keep `stats`' existing forgiving behaviour
(no note, no new error).
**Rationale:** The mutations answer an unknown shelf with a did-you-mean (#200) and `show`
distinguishes missing from empty (#166), but `stats` validated only `--since` — a misspelled
shelf produced a plausible, empty report indistinguishable from a truly silent shelf, the
exact wrong conclusion a command built to surface unused shelves must not invite (issue #341).
*Proven by:* `cli.test.ts` → `describe('stats names a shelf that does not exist (issue #341)')`
(a typo notes with a suggestion while stdout is unchanged; no suggestion when nothing is
close; the note repeats on every repeated call; an existing shelf and a retired shelf with
history print no note; `--json` stays one
valid object).

### 4.13 Notebook descriptions & metadata

<a id="fr-note-001"></a>
**FR-NOTE-001 (Should).** A mutation that creates a shelf SHALL say so on stderr:
`nb add` (the shelf), `nb move` (the target shelf, only when the move is written, not
when refused as a duplicate) and `nb describe` (only for a non-empty description on a
shelf that did not exist) SHALL print `note: created new shelf "<name>"`, followed by
the existing shelves sharing at least two name words with it when there are any. The
`--json` result SHALL carry `created: true` (and `similarShelves` when non-empty) only
in the creating case. Exit code and stdout are unchanged.
**Rationale:** shelf matching is exact, so a mistyped shelf silently starts an orphan;
`move` targets and `describe` can mistype the same way `add` can (issues #354, #404).
*Proven by:* `cli.test.ts` → `describe('created-shelf note (issue #404)')`.

<a id="fr-desc-001"></a>
**FR-DESC-001 (Should).** A notebook file MAY begin with a **metadata** block: a
leading run of `# key: value` comment lines matching `^#\s*([a-z][a-z0-9_-]*):\s?(.*)$`.
`readEntries` SHALL skip the leading metadata block (such a line SHALL NOT become a
score-0 lesson), and every mutation (`add`/`vote`/`merge`/`split`/`rm`) SHALL
round-trip the block unchanged. Only the *leading* run is metadata — a `# key:`
line that follows an entry stays a tolerated bare lesson ([FR-MODEL-003](#fr-model-003)).
The leading-block parse SHALL tolerate CRLF (`\r\n`) line endings — a notebook
normalized by git on Windows (`core.autocrlf=true`), or any CRLF hand-edit — so a
`# desc: …\r` line is still recognized as metadata and never decays into a score-0
lesson; the trailing `\r` is stripped so the preserved block carries no `\r`.
**Rationale:** An entry always starts with `±score\t` (or is a bare tab-less lesson),
so a `#`-leading `key:` line is unambiguous and backward-compatible — existing
notebooks have no `#` lines. Unknown keys SHALL be preserved verbatim and ignored
(forward-compatible). This stays within [NG-004](#ng-004): metadata is optional
comment lines in the *file*, not a field on a lesson.
*Proven by:* `notebook.test.ts` → "notebook metadata / descriptions (issue #70)"
(including "a CRLF-normalized notebook keeps its `# desc:` metadata (issue #273)").

<a id="fr-desc-002"></a>
**FR-DESC-002 (Should).** `nb describe <shelf> "<text>"` SHALL set the notebook's
one-line **description** (the `# desc:` metadata value); `nb describe <shelf>` with no
text SHALL print the current description (bare, pipe-friendly) or warn on stderr and
exit 0 when none is set. `setDescription`/`getDescription` are the library form; a
non-empty text on a never-created shelf creates it and adds `created`/`similarShelves`
to the result ([FR-NOTE-001](#fr-note-001)).
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
no terms and no groups (never an error). An optional `limit` SHALL bound the number of
notebook **groups** returned, after ranking (highest-relevance first), so search stays
bounded as notebooks grow exactly as `--limit` bounds `nb list`; the CLI SHALL default it
to **50** when `--limit` is omitted and SHALL parse `--limit` with the same forgiving
semantics as `list` (a non-integer warns on stderr and falls back to the default). The
limit SHALL bound only what is returned/printed: the `SearchResult` SHALL also carry
`total` (the full pre-limit match count) and `surfacedIds` (every id surfaced across the
full result), and the gap-sensor `match`/`no-match` outcome ([FR-STATS-003](#fr-stats-003))
and the `#114` surfacing provenance SHALL be computed on the full result, so a small
`--limit` (even `0`) can never flip a real match into a `no-match`. `nb search <query>
[prefix] [--any] [--limit N] [--json]` is the CLI form; `--json` SHALL emit the raw
`SearchResult`. Search SHALL be **keyword-only**
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
([FR-USAGE-002](#fr-usage-002)) with outcome `match`, `no-match`, `no-terms`, `skipped` or `no-shelf`, the query in the
`note` field, and — since [#114](https://github.com/jeanibarz/agent-notebook/issues/114)
— the **entry ids it surfaced** in the `entries` field (all reusing existing columns — no
new column), under `shelf` `-` since it spans notebooks. Both the `match`/`no-match`
outcome and the surfaced ids SHALL be computed on the **full** pre-`limit` result
([FR-SEARCH-001](#fr-search-001)), so a `--limit` bounds only what is printed and never
changes what is logged. The surfaced ids give an upvote
its *pull* provenance for `serendipity` ([FR-STATS-004](#fr-stats-004)); a `no-match`
search has no hits, so its `entries` stays empty and the `failed-search → add` gap-sensor
below is unaffected. The `loop` anomaly ([FR-STATS-001](#fr-stats-001)) SHALL continue to
treat a `search` row as entry-less so repeated varying-query searches still group and trip
it as before. `stats` SHALL then derive a **`failed-search`** `DiagnosticSignal`
([FR-STATS-003](#fr-stats-003)): within one session, a `no-match` search followed
by an `accepted` `add` SHALL be flagged as a **coverage gap** the notebook did not hold,
labelled by the agent's own query (one signal per session + added-entry; a blank session
is skipped, and a terms-less query logs `no-terms`, never `no-match`, so it cannot be a
false gap; likewise a `no-match` that exists only because a shelf was skipped as
unreadable ([FR-LIST-006](#fr-list-006)) logs `skipped`, never `no-match`, so a damaged store
cannot masquerade as a coverage gap and prompt a spurious `add`; and a prefix operand that matches no shelf name logs `no-shelf`, because nothing was searched — usually the caller left a multi-word query unquoted, and `search` rejects more than `<query> [prefix]` operands with `bad_args`, as [#378](https://github.com/jeanibarz/agent-notebook/issues/378) does for the mutating commands). Because the `search` row is logged under shelf `-` (it spans notebooks), the
signal is observable only in an **unscoped** `stats` report — `nb stats <shelf>` filters to
one shelf and cannot pair the cross-notebook search with the add. **Rationale:** This is the
`failed-search → add` gap-sensor — the coverage signal deferred from #72. A search that
keeps failing for a topic is exactly where presentation is failing for that topic, and the
agent labels it for free ([DP-8](#dp-8)). The search `note` carries an agent-supplied query,
sanitized like every usage field so it cannot split the row ([FR-USAGE-002](#fr-usage-002)).
*Proven by:* `notebook.test.ts` → `describe('failed-search → add gap signal (issue #82)')`
and the `nb search` logging / end-to-end CLI tests.

### 4.15 Offline janitor signals for `shelf@project` names (issue #362)

These live in the shipped example `examples/nb-janitor.mjs`, a read-only script that
runs around the package, never inside `nb` ([DP-6](#dp-6), [NG-001](#ng-001),
[NG-004](#ng-004)): no `nb` command, `nb` output or shelf-file field changes.

<a id="fr-janitor-001"></a>
**FR-JANITOR-001 (Should).** `nb-janitor` SHALL report two name- and text-equality signals
about shelves named `<base>@<slug>`, in both the human report and `--json`, read-only and
byte-for-byte deterministic for the same store (shelves and groups ordered by plain
code-point comparison, never by directory order or locale):
(a) **possible slug drift**, in section 2 and as `slugVariants`: two `@` shelves with an
*equal* base (the part before the first `@`) whose slugs differ and where the shorter slug
is the longer one with one or more leading parts dropped, anchored on `-` (`app` vs
`acme-app`, not `app` vs `acme-webapp`). Slugs are compared ignoring case, and slugs that
are equal ignoring case are a case collision, not drift. Each entry lists the lessons held
under both, and the report suggests `nb move <short-shelf> <long-shelf> <id>`;
(b) **exact duplicate lessons across shelves**, in section 8 and as `crossShelfDups`: a
lesson held by two or more shelves that share a base (the `@` shelves of that base and the bare
`<base>` shelf itself; a bare shelf alone never forms a group), where "the same lesson" means an
equal `dedupKey` (the normal form `nb` itself uses to refuse an exact duplicate, so no
similarity guess and no lesson is matched with its negation). The report says "appears in N
shelves", names the highest-scored copy (ties broken by shelf name), and suggests
`nb move <that-shelf> <base> <id>` followed by `nb rm <other-shelf> <id> --reason obsolete --note duplicate`
(`duplicate` is a `merge` reason code, not an `rm` one). If the bare `<base>` shelf already
holds the lesson, only `nb rm` lines for the `@` copies are suggested, because `nb move` refuses a target
that holds an equal lesson. Bases that differ by case, shelves holding git
merge-conflict markers (`nb` refuses to rewrite them) and lessons whose normal form is empty never form a group.
When the move is needed but the bare `<base>` shelf holds conflict markers, or another shelf differs
from it only by case (`nb` refuses both as a move target), the group is still reported but with `blocked` set and no commands.
The script mirrors `sanitizeLesson` + `dedupKey` + `entryId` and `readShelf`'s parsing (leading BOM,
CRLF, leading `# key:` metadata lines) because it ships dependency-free and cannot import them, so the
same key and id are printed as `nb show --json` shows. `--json` SHALL be written in full before the
process exits, even when piped.
**Rationale:** the `shelf@project` convention (AGENTS.md section 4) fragments a project's memory when
one repo is named by two slugs, and hides a lesson that several project shelves repeat
(a cue that it is not specific to one project). Section 2's same-scope rule and section 3's
paraphrase similarity cannot see either. Both are hints, not proof: two repos can share a short
name, and a duplicated lesson may be correct in each shelf.
*Proven by:* `nb-janitor-layers.test.ts` → `describe('nb-janitor section 2 — possible slug drift (issue #362)')`
and `describe('nb-janitor section 8 — exact duplicate lessons across shelves sharing a base (issue #362)')`
(including the parity test against `nb show --json` and the test that runs the printed commands),
and `describe('nb-janitor sections 2 & 8 — read-only and neutral (issue #362)')`.

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
runtime dependencies. CI exercises Linux and macOS on Node 18/20/22/24; macOS is a
supported target (no Linux-specific syscalls) and is covered by CI. Because the test
runner (Vitest) itself needs Node 20.12+ ([the guard](../scripts/check-node-for-tests.mjs)),
the Node-18 leg runs a dependency-free runtime smoke of the built CLI
([`scripts/smoke-node18.mjs`](../scripts/smoke-node18.mjs)) instead of the suite, so the
minimum engine is actually executed and not merely compiled. *(Proven by
`src/smoke-node18.test.ts`.)*

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
**NG-001.** The tool SHALL NOT use embeddings, semantic search, a learned/vector
similarity ranker, or any network call for matching. The *blocking* dedup decision
SHALL remain conservative exact-normal-form equality only. A deterministic, offline,
dependency-free *lexical* overlap (e.g. trigram Jaccard) MAY additionally raise a
**non-blocking** near-duplicate advisory ([FR-ADD-008](#fr-add-008)); it SHALL NOT
block, reject, reorder, or rank an add, so it can never cause a silent loss
([DP-5](#dp-5)) and never becomes a retrieval path ([NG-007](#ng-007)).

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
| `NB_NEAR_DUP` | 0.5 | 0–1 | `nearThreshold` — trigram-Jaccard similarity at/above which an accepted `add` prints a non-blocking merge advisory ([FR-ADD-008](#fr-add-008)); `0` disables it. |
| `NB_USAGE_RING` | 5000 | 100–100000 | `usageRing` — rows in the usage log. |
| `NB_LOOP_N` | 10 | 2–1000 | Loop anomaly: call count threshold. |
| `NB_LOOP_WINDOW_S` | 120 | 5–86400 | Loop anomaly: window (seconds). |
| `NB_SILENT_H` | 48 | 1–8760 | Went-silent anomaly: silence threshold (hours). |
| `NB_ERR_MIN` | 5 | 1–10000 | High-error-rate anomaly: min calls. |
| `NB_ADD_BURST_N` | 15 | 1–100000 | `add-burst` signal ([FR-STATS-010](#fr-stats-010)): a session with more than this many accepted adds to one shelf. |
| `NB_ERR_RATE` | 0.3 | 0–1 | High-error-rate anomaly: min failure fraction. |
| `NB_ASCII` | _(unset → locale decides)_ | — | Force the activity sparkline's glyph ramp to ASCII (truthy) or Unicode (`''`, `0`, `false`, `no`, `off`); unset, the locale decides. |
| `NB_STALE_LOCK_MS` | 10000 | 100–600000 | `.nb.lock` age (ms) past which a lock is treated as abandoned by a crashed `nb` and stolen. |
| `NB_LOCK_GRACE_MS` | 2000 | 0–600000 | Extra wait past `NB_STALE_LOCK_MS` to notice and steal an abandoned lock before failing with `notebook is locked`. |
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
