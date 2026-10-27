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

---

## 1. Purpose & scope

`agent-notebook` is a bounded, voted, plain-text memory for AI agents: one small
file per agent role, holding a short list of one-line lessons ranked by vote.
It has zero runtime dependencies and makes no network calls.

The product is deliberately narrow. Section [6. Non-goals](#6-non-goals-shall-not)
is as binding as the functional requirements — the non-goals are the product.

---

## 2. Glossary (ubiquitous language)

One definition per term, used identically in requirements, code, and tests.

| Term | Definition |
|------|------------|
| **Role** | An agent identity that owns one notebook. A path-safe name (see [FR-SAFE-001](#fr-safe-001)). Stored at `<NB_DIR>/<role>.md`. |
| **Notebook** | The file for one role: a bounded, newline-separated list of entries. |
| **Entry** | One lesson = one line `"<score>\t<text>"`. The in-memory shape is `{ score: number; text: string }`. |
| **Lesson** / **text** | The single-line content of an entry, at most `maxChars` characters, no tab/newline. |
| **Score** | A signed integer: the running sum of +1/-1 votes on an entry. |
| **File order** / **insertion order** | The order entries physically appear in the file — the order they were added, preserved across votes. |
| **Display order** | The order `nb show` / `render` presents entries: score descending, ties broken by ascending file order (oldest first). |
| **Stable id** | A 6-hex-character identifier derived from an entry's deduped text (`entryId`), not its position. |
| **Dedup key** | The case-, punctuation-, and whitespace-insensitive normal form of a text (`dedupKey`), used for duplicate detection and the stable id. |
| **Selector** | The argument to `vote`/`rm`/`merge` that identifies an entry: a stable id (exact or unique prefix) or a unique case-insensitive text substring. |
| **Cap** | `maxLines` (max entries per notebook) and `maxChars` (max characters per lesson). |
| **Eviction** | Removing the lowest-scored entry (ties: oldest) when the notebook exceeds `maxLines`. |
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
### DP-3: Storage order is insertion order; display order is by score — **Must**
The notebook file SHALL be stored in insertion order and SHALL NOT be re-sorted on
mutation. Sorting by score SHALL happen only at read/display time (`render`,
`nb show`), and the injected/printed view SHALL be score-descending with ties
broken by ascending insertion order (oldest first).
**Rationale (this is the one that reads like a bug but is not):**
- Insertion order is the *only* record of an entry's age, because the line format
  carries no timestamp. That age is load-bearing: it is the tie-breaker for both
  display ranking and eviction ("ties → oldest"). Physically re-sorting by score
  would destroy it and corrupt the tie-break — e.g. add A, B, C (all +1); upvote C
  to +2 (it moves); downvote C back to +1; a stable re-sort would now place C
  (newest) at the *top* of the +1 tie instead of the bottom.
- A `vote` rewrites exactly one line in place, which is the smallest, most stable
  git diff — important because notebooks are often tracked in git.
- Stable ids ([DP-4](#dp-4)) make
  reordering unnecessary, so there is nothing to gain from it.
A raw `cat` of the file therefore looks unordered; read it with `nb show`.
*Proven by:* `notebook.test.ts` → `describe('display ordering ("moving" an entry)')`.

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
- An `add` to a full notebook where every entry outranks the newcomer SHALL report
  `rejected-full` and store nothing ([FR-ADD-006](#fr-add-006)).
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
**FR-ADD-001 (Must).** `addEntry(dir, role, lesson)` SHALL sanitize the lesson, and
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
lowest-scored entries, breaking ties by oldest (lowest file index), until `maxLines`
remain; a removed existing entry SHALL be reported in `evicted`.

<a id="fr-add-006"></a>
**FR-ADD-006 (Must).** When the notebook is full and the newcomer (`score 1`) is the
strict lowest, the newcomer SHALL NOT be stored; the result SHALL be
`reason: 'rejected-full'` and the stored set SHALL be unchanged (the file is
rewritten with the same entries, which also normalizes any hand-edited lines).
*(See [DP-5](#dp-5).)*

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
| full, every entry outranks newcomer | new lesson | `rejected-full` | no |

### 4.3 `vote`

<a id="fr-vote-001"></a>
**FR-VOTE-001 (Must).** `vote(dir, role, selector, delta)` SHALL accept `delta` of
only `+1` or `-1`; any other value SHALL throw.

<a id="fr-vote-002"></a>
**FR-VOTE-002 (Must).** A vote SHALL add `delta` to the selected entry's score in
place and SHALL NOT change file order. *(See [DP-3](#dp-3).)*

<a id="fr-vote-003"></a>
**FR-VOTE-003 (Should).** Scores MAY go negative (a repeatedly downvoted lesson), and
such entries SHALL be evicted first under [FR-ADD-005](#fr-add-005).

### 4.4 Selector resolution (shared by vote/rm/merge)

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
**FR-MERGE-001 (Must).** `merge(dir, role, selA, selB, merged)` SHALL require two
distinct entries (SHALL throw if they resolve to the same one), replace both with a
single entry whose text is the sanitized `merged`, and give it `max(scoreA, scoreB)`.

<a id="fr-merge-002"></a>
**FR-MERGE-002 (Must).** `merge` SHALL reject an empty or over-`maxChars` merged
lesson (throw, leaving both sources intact), and SHALL drop any pre-existing entry
whose dedup key equals the merged text so the merge never creates a duplicate.

### 4.6 `rm`

<a id="fr-rm-001"></a>
**FR-RM-001 (Must).** `remove(dir, role, selector)` SHALL delete the uniquely
selected entry and return its text and score. An empty notebook SHALL throw.

### 4.7 `show` / `render`

<a id="fr-show-001"></a>
**FR-SHOW-001 (Must).** `render` SHALL output one line per entry as
`"<id>  [<±score>]  <text>"` in display order ([DP-3](#dp-3)).

<a id="fr-show-002"></a>
**FR-SHOW-002 (Should).** An empty notebook SHALL render a friendly, non-error
message naming the role.

### 4.8 Roles & paths

<a id="fr-safe-001"></a>
**FR-SAFE-001 (Must).** A role name SHALL match `^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$`,
SHALL NOT contain `..`, and SHALL be at most 128 characters long. `assertSafeRole`
SHALL throw otherwise.
**Rationale:** The role is a path segment; the pattern and `..` check prevent
traversal outside `NB_DIR`, and the 128-character bound keeps `<role>.md` under
typical filename limits so an over-long name throws a friendly `invalid role name`
error instead of a bare `ENAMETOOLONG` stack. 128 fits `role@owner-repo` plus a suffix.
*Proven by:* `notebook.test.ts` → "rejects path-traversal and unsafe role names"; "bounds role-name length with a friendly error before it becomes a filename".

<a id="fr-roles-001"></a>
**FR-ROLES-001 (Should).** `listRoles` SHALL return the sorted stems of `*.md` files
in `NB_DIR`, excluding dotfile sidecars (`.nb-usage.log`, `.nb.lock`).

<a id="fr-path-001"></a>
**FR-PATH-001 (Should).** `nb path` SHALL print `NB_DIR`; `nb path <role>` SHALL
print `<NB_DIR>/<role>.md` as a bare path (pipe-friendly, no decoration).

### 4.9 CLI contract

<a id="fr-cli-001"></a>
**FR-CLI-001 (Must).** `nb` SHALL implement: `show`, `add <role> ("<lesson>"|-)`,
`vote`, `merge`, `rm`, `stats [<role>] [--since <N{d,h,m}>] [--json]`, `path [<role>]`,
`roles`, `--help`, `--version`. The `-` lesson operand of `add` reads from stdin per
[FR-ADD-007](#fr-add-007).

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

### 4.10 Durability & concurrency

<a id="fr-lock-001"></a>
**FR-LOCK-001 (Must).** Every notebook mutation (`add`/`vote`/`merge`/`rm`) SHALL run
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

### 4.11 Usage log & stats

<a id="fr-usage-001"></a>
**FR-USAGE-001 (Must).** Each CLI invocation other than `--help`/`--version` (which
return before any work) SHALL append one row
`"<iso-ts>\t<role>\t<command>\t<ok|err>\t<ms>ms"` to the usage ring, bounded to
`usageRing` rows (oldest dropped). A failure to log SHALL NOT fail the operation.
**Rationale:** Monitoring must itself be bounded and must never break a real call.

<a id="fr-stats-001"></a>
**FR-STATS-001 (Should).** `stats` SHALL roll up per-command calls/errors/p50/p95/last-used
within a window (`parseWindowMs`, default 7d) and flag three anomalies: **loop**
(≥`NB_LOOP_N` calls of one role+command within `NB_LOOP_WINDOW_S`), **went-silent**
(used historically, zero in-window, and last seen longer than `NB_SILENT_H` ago),
**high-error-rate** (≥`NB_ERR_MIN` calls and ≥`NB_ERR_RATE` failures).

<a id="fr-stats-002"></a>
**FR-STATS-002 (Should).** A malformed anomaly-tuning value SHALL fall back to the
documented default (never `NaN`, which would disable detection).

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
role validation ([FR-SAFE-001](#fr-safe-001)) is the sole guard and SHALL be applied
on every role-to-path conversion.

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
score is an integer.

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
| `NB_MAX_LINES` | 200 | 1–5000 | `maxLines` — entries per notebook. |
| `NB_MAX_CHARS` | 200 | 20–2000 | `maxChars` — characters per lesson. |
| `NB_USAGE_RING` | 5000 | 100–100000 | `usageRing` — rows in the usage log. |
| `NB_LOOP_N` | 10 | 2–1000 | Loop anomaly: call count threshold. |
| `NB_LOOP_WINDOW_S` | 120 | 5–86400 | Loop anomaly: window (seconds). |
| `NB_SILENT_H` | 48 | 1–8760 | Went-silent anomaly: silence threshold (hours). |
| `NB_ERR_MIN` | 5 | 1–10000 | High-error-rate anomaly: min calls. |
| `NB_ERR_RATE` | 0.3 | 0–1 | High-error-rate anomaly: min failure fraction. |

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
