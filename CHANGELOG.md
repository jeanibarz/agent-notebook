# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Version headings are bracketed and linked once a release is tagged; untagged
versions are listed plainly.

## [Unreleased]

### Fixed
- **A shelf with git merge-conflict markers is no longer silently rewritten as clean lessons (#333).**
  After a `git pull`/`git merge` conflict in a git-versioned notebook, the `<<<<<<<`, `=======` and `>>>>>>>`
  lines parsed as score-0 lessons, and the next `nb add|vote|rm` wrote them back as real lessons — erasing the
  only signal that a merge needed resolving, evicting real lessons against the cap, and injecting junk into
  agent context. `nb` now recognizes the three exact marker shapes at line start (a bare `=======`, or
  `<<<<<<<`/`>>>>>>>` followed by a space or end of line); a mid-line `=======` or an ordinary hand-edited
  tab-less line is still a normal tolerated lesson. Read commands (`show`, `list`, `search`, `stale`) still
  print exactly as before but add one stderr warning naming the shelf and marker (`--json` stdout is unchanged
  and valid); the same shelves appear in the additive `conflicts` field of `nb list`/`nb search`
  `--json` (emitted only when non-empty) and of `nb stats --json` (always present, `[]` when clean, like `skipped`). Every mutation (`add`, `vote`, `merge`, `split`, `rm`, `move`,
  `describe`) refuses with exit 1 and a new `corrupt` error class that names the shelf and marker line, leaving
  the file byte-identical. See [FR-MODEL-004](docs/requirements.md#fr-model-004).
- **One unreadable shelf no longer takes down `nb list`, `nb search` and the session-start index (#332).**
  The cross-shelf scans read every `<shelf>.md` with no per-shelf error handling, so a single
  non-`ENOENT` read failure — `EACCES` on a root-owned or `chmod`'d file left by a `sudo nb`, `EISDIR`
  for a directory named `<shelf>.md`, `EIO` — aborted the whole command, turning every accumulated
  lesson into "nb failed". `listNotebooks` and `search` now skip only the unreadable shelf, keep every
  healthy one, and exit `0`; the skip is surfaced as a `{shelf, code}` entry in the additive
  `NotebookListing.skipped` / `SearchResult.skipped` field (emitted in `--json` only when non-empty, so
  healthy output is byte-identical) and as one stderr line naming the shelf and errno. The same resilience
  covers the `nb stats` inventory (`StatsReport.skipped`), since a health scan of a damaged store is exactly
  where aborting hurts. Only a real errno failure is skipped — a codeless throw (a parser bug) still
  propagates rather than being mislabelled. A prefix/scope whose only match is the skipped shelf reports it
  was unreadable (not "no match"), and a search miss caused only by a skipped shelf logs outcome `skipped`
  instead of `no-match`, so it cannot masquerade as a coverage gap. Single-shelf commands
  (`nb show <bad-shelf>`, …) still fail loudly. See [FR-LIST-006](docs/requirements.md#fr-list-006).
- **`nb stats <shelf>` no longer lets a typo read as a real but silent shelf (#341).**
  `stats` takes a shelf operand but, unlike the mutations (which answer an unknown shelf with a
  did-you-mean, #200) and `show` (which distinguishes missing from empty, #166), never validated it —
  so a misspelled shelf produced a plausible, empty report indistinguishable from a real shelf with no
  recent activity, the exact wrong conclusion a command built to surface unused shelves must not invite.
  When the operand has no `<shelf>.md` **and** the window holds no usage rows for it (ignoring `stats`' own
  rows, so the note repeats on every call), `stats` now prints one advisory note on **stderr** — `nb stats: no shelf named "X"`,
  plus `— did you mean "Y"?` when a shelf is close (reusing #200's `closestShelf`). It is advisory only:
  the exit code and stdout (the human table and the `--json` `StatsReport`, still one valid object) are
  unchanged, and a retired shelf that still has historical in-window rows is not flagged. See
  [FR-STATS-009](docs/requirements.md#fr-stats-009).
- **Lessons and descriptions can no longer inject terminal escape sequences (#335).**
  `sanitizeLesson` only collapsed whitespace, so ANSI/OSC escapes, NUL/BEL, C1 controls,
  bidi overrides and zero-width characters were stored verbatim and echoed raw by
  `nb show`, `nb list` and `nb search` (and injected into harness context). `sanitizeLesson`
  now strips C0 controls (except tab/LF/VT/FF/CR, which still become a space), DEL, C1 controls, bidi
  embedding/override/isolate marks and zero-width characters, while keeping ZWJ and
  variation selectors so emoji survive; the render paths strip the same classes too, so a
  shelf file stored before this rule cannot emit an escape either. Zero-width characters
  no longer defeat the exact-duplicate check. See
  [FR-MODEL-002](docs/requirements.md#fr-model-002).
- **`NB_DIR` with a leading `~` is expanded by `nb` itself instead of creating a literal `~` directory (#334).**
  `notebooksDir()` used `NB_DIR` verbatim, so a value like `~/notes` set from a place
  that does no shell expansion — Claude Code `settings.json` `env`, Codex config,
  systemd units, cron, `.env` files — made `nb` write into a directory *literally*
  named `~` under the current working directory. Each hook from a different project
  then forked a new, empty notebook; `nb add` exited `0` but the next session looked
  empty. A leading `~` (or `~/…`, and `~\…` on Windows) now expands to the home
  directory for every path `nb` derives from it (shelves, the usage log, `nb path`,
  `nb config`). The shipped helpers
  (`examples/nb-git-wrapper.mjs`, `nb-janitor.mjs`, `nb-backup.sh` and the Claude Code
  `nb-retrospective.sh` hook) expand it the same way, so the auto-commit wrapper still commits and
  the hook no longer creates a literal `./~` directory in a project. `~user/…`, absolute and
  relative paths are unchanged by design.
  **Migration note:** if you already have data under a literal `~` directory from this
  bug, move it to the intended home path — `nb` will no longer look there.
- **Batch-vote partial selector-misses are no longer laundered out of `nb stats`' vote error causes (#310).**
  A batch vote (`nb vote <shelf> id1,id2,id3 +1`) that resolved at least one id but skipped others
  exited `0` and wrote a clean success row — no `errorClass` — so its stale ids were invisible to the
  `errorClass`-built vote selector-miss readout (#223), even though a *single* failed vote throws and
  gets a class stamped. The exact workflow batch vote was added for (#223/#224) thus under-reported the
  "agents voting on ids that no longer exist" signal that drives curation health. Each ≥1-landed batch
  row now records the count of skipped ids in a new trailing **`misses`** usage-log column (a dedicated
  counter, **not** `errorClass`, so the partial success keeps exit `0`), and `nb stats` folds those
  misses into the `vote` error causes as `no_match` — the same class a wholly-failed vote stamps —
  subject to the existing dominant-error noise floor. The per-command error **rate** is unchanged (it
  counts whole failed calls, so a batch that exited `0` stays a success there); the all-fail
  (`no_match`, exit 1) and single-vote paths are untouched. The column is appended last, so pre-#310
  rows read it as `0` and a corrupt negative cell is clamped to `0`; `STATS_SCHEMA_VERSION` stays `1`
  (additive). See [FR-STATS-008](docs/requirements.md#fr-stats-008).

### Added
- **`nb config` now reports whether each env tunable was honored, clamped, or ignored, and flags unknown `NB_*` vars (#336).**
  The source tag only checked whether a var was *set*, so an unparseable value (silently replaced by the
  default), an out-of-range value (silently clamped) and a typo like `NB_MAX_LINE` (never read) were all
  invisible or mislabeled — `NB_MAX_LINES=abc` printed `maxLines=50 (env NB_MAX_LINES)`, as if `abc` were
  in force. Each set numeric tunable now reports how its value was resolved: `honored`, `clamped` (with the
  raw value, e.g. `(env NB_NEAR_DUP: clamped to 1 from 2)`), or `ignored` (`(env NB_MAX_LINES: ignored
  "abc", not an integer; using default)`). `nb config --json` gains additive `status` and `rawValue` fields
  on each numeric row (`source` and every existing key unchanged). Integer knobs must be a whole integer, so a
  partially-numeric value (`1e3`, `12.9`) is `ignored` rather than silently truncated by `parseInt` to `1`/`12`.
  Any `NB_*` var `nb` does not read is listed as `not read by nb` (with a nearest-name `did you mean` hint) in
  both outputs, derived from the same variable registry `effectiveConfig` uses — informational only, never an
  error, exit code stays `0`. The knobs read only by the tooling shipped under `examples/` are not flagged.
  Output for a config with no problems is byte-identical to before. See
  [FR-CONFIG-001](docs/requirements.md#fr-config-001).
- **`nb stats` now surfaces crash/interrupt recovery, so silent mid-write crashes become observable (#309).**
  Two recovery paths each mean a previous `nb` died mid-mutation — the stale-lock steal (`withLock`)
  and the leftover-temp reap (`reapLeftoverTemps`) — yet both were entirely silent, so an operator
  running `nb` from agent hooks could not answer "are my agents crashing mid-write and losing updates?".
  Each usage row now carries a trailing `recovered` column (`<lockSteals>:<tempReaps>`, blank in the
  common case), and `nb stats` sums it window-wide into a new `crashRecovery: { lockSteals, tempReaps }`
  readout — shown as a `crash recovery: N stale locks stolen, M leftover temps reaped (window)` line in
  the human table and under a new top-level `crashRecovery` key in `--json`. Like the usage-ring
  occupancy readout it is deployment-wide (the lock and temp debris are shared across shelves), so a
  `[<shelf>]` scope does not narrow it; only the window applies. A clean deployment reports `{ 0, 0 }`,
  shown rather than omitted so "measured, healthy" is never confused with "not measured". The recovery
  actions themselves are unchanged and the counting is best-effort — a logging failure never fails a
  mutation. `STATS_SCHEMA_VERSION` stays `1` (the field is additive). See
  [FR-STATS-007](docs/requirements.md#fr-stats-007).
- **`nb config` now reports the behavior-critical string env vars `NB_DIR`, `NB_SESSION`, and `NB_ASCII` (#312).**
  The command listed only the 14 numeric clamp tunables, so the three string env vars that most often
  explain a misbehaving deployment were structurally invisible — including `NB_SESSION`, whose unset
  state is the usual cause of `nb stats` reporting "no engaged sessions". A new `environment` section
  prints each as `NAME=value`, read from the same resolver the hot path uses (`notebooksDir()`, the
  effective `NB_SESSION`, `asciiMode()`), tagged `(env)` or `(default)` like the numeric rows. Under
  `--json` the vars live under a new top-level `environment` key (`{ value, source }` each); the numeric
  rows keep their exact keys and `{ value, source, env }` shape, so the `--json` contract stays
  backward-compatible. See [FR-CONFIG-002](docs/requirements.md#fr-config-002).
- **`nb show` reads several shelves in one call, and `--json` entries now carry a dedup `key` (#286).**
  `nb show <a> <b> <c>` now prints every named shelf instead of silently dropping all but the
  first, and under `--json` returns a per-shelf array of `{shelf, description, entries, exists}`
  in one process — one consistent snapshot, no N spawns. A single shelf stays a lone object
  (backward compatible); a named shelf with no file reports `exists: false`, never a silent empty.
  Each `--json` entry gains a `key` field: the `dedupKey` normal form of its text (case- and
  punctuation-folded, whitespace-collapsed). Two entries with an equal `key` are *exact*
  duplicates — the one thing a caller cannot reproduce without reimplementing nb's internals — so
  a harness composing a context pack from several shelves can drop exact cross-shelf dupes itself.
  `key` is equality-only; nb does no cross-shelf dedup, ordering, scope precedence, or similarity
  ranking on this path — those stay caller policy. See [FR-SHOW-004](docs/requirements.md#fr-show-004).

### Fixed
- **Lowering `NB_MAX_LINES` below a full shelf now reports every eviction, not just one (#306).**
  When the cap is lowered under a full shelf's size, the next `add`/`merge`/`split`/`move` trims
  the shelf all the way down in one call — many evictions at once (e.g. `NB_MAX_LINES` 50→10 on a
  full shelf evicts 41). The result and the usage log's `evicted` column surfaced only the FIRST,
  so a data-loss event was under-reported to one entry and the `eviction-while-still-voted` signal
  that reads that column missed the scale. The result now carries an `evictedAll` array with every
  removed entry (`evicted` stays the first, so the single-eviction common case is byte-identical),
  the usage `evicted` column records a comma-separated `<id>:<score>` list bounded by `maxChars`
  with a count-preserving `+<dropped>` marker, the `added`/`moved` message appends `+N more lines`,
  and the still-voted signal counts each evicted entry. See
  [FR-USAGE-002](docs/requirements.md#fr-usage-002) and [FR-STATS-003](docs/requirements.md#fr-stats-003).
- **A CRLF-normalized notebook no longer loses its `# desc:` trigger (#273).** The project
  supports git-versioning and backing up the notebooks dir; on Windows with `core.autocrlf=true`
  (or any CRLF hand-edit) each `<shelf>.md` line arrives terminated by `\r\n`. The leading-metadata
  scan split on `\n` only, leaving a trailing `\r` that made `# desc: …\r` fail the `$`-anchored
  metadata pattern — so the description silently decayed into a score-0 lesson and the shelf lost
  its trigger. The scan now splits on `\r?\n`, so a CRLF notebook parses identically to an LF one:
  the description is preserved, a mutation rewrites the file with clean LF endings, and LF users are
  unaffected. See [FR-DESC-001](docs/requirements.md#fr-desc-001).
- **`nb` now refuses an unknown or misplaced `--flag` instead of silently ignoring it (#267).**
  A mistyped flag was dropped without a word — so `nb stats --exitcode >/dev/null || alert`
  (a typo of `--exit-code`) ran WITHOUT the health gate and still exited `0`, silently
  defeating the #129 cron monitor by one missing hyphen. Each command now validates its
  `--`-prefixed options against a bounded per-command set and fails fast on an unrecognized
  one with `unknown option "<flag>" for \`nb <cmd>\`` (exit `1`, message on stderr; the
  structured `{ok:false,…}` object on stdout under `--json`), appending a `Did you mean
  \`<nearest>\`?` hint when one is close. The `--` end-of-options terminator (#277) still
  shields a flag-shaped operand, a bare trailing `--` (vote's downvote alias) is untouched,
  and an unknown *command* keeps its exit-`2` path. See [FR-CLI-009](docs/requirements.md#fr-cli-009).
- **`nb-janitor` §4 no longer reports a git failure as "not a git repo" (#269).** `gitHistory()`
  returned `null` both when `NB_DIR` has no `.git` *and* when `git log` failed — its 5s timeout on
  a huge repo, git's dubious-ownership refusal on a shared host, a corrupt repo, or git missing
  from `PATH` — so section 4 printed the flatly-false "NB_DIR is not a git repo" guidance on a
  genuine git error. The two cases are now distinguished: a real failure prints "git history
  unavailable — git failed, timed out, or refused access …", while the absent-`.git` path keeps
  its unchanged "not a git repo" line. Read-only and zero-dependency, like the rest of the janitor.
- **`withLock` fails fast on an unwritable notebook store instead of busy-waiting (#263).** The
  lock-acquire loop treated *any* `mkdir(.nb.lock)` error as "lock held", so on a read-only or
  permission-denied `NB_DIR` every mutation spun the full acquire budget (~12s) and then died with
  a misleading `notebook is locked (…)` — when no other process existed and the real cause was an
  unwritable store. The loop now treats only `EEXIST` as a held lock and fails fast on any other
  code (`EACCES`/`EPERM`/`EROFS`/`ENOSPC`/…) with a clear `notebook directory is not writable`
  message, chaining the original error as the cause.
- **`--` now ends option parsing so a flag-shaped operand survives (#277).** `--json` was
  stripped from the *entire* argv, so recording a glossary line that is literally `--json`
  (`nb add flags "--json"`) dropped the operand and then threw `missing <lesson>` for the
  lesson the user plainly typed — and there was no way to escape it. `nb` now honors a
  POSIX `--` end-of-options terminator: every token after the first `--` is a literal
  operand, so `nb add flags -- --json` stores the line `--json`. `--json`/`--reason`/`--note`
  are recognized only before the `--`; a bare trailing `--` is still a literal operand, so
  `vote`'s `--` downvote alias is unchanged ([FR-CLI-007](docs/requirements.md)).
- **`nb-git-wrapper` no longer lets concurrent mutations race in its git section (#271).** The
  wrapper ran `git add -A` → commit with no lock of its own, *after* the package had released its
  `.nb.lock`. Under parallel-subagent workloads two wrappers interleaved: one `git add -A` staged
  a sibling's already-written `.md`, bundling two changes under one mislabelled commit while the
  other found nothing staged and dropped its commit (or the two git calls collided on
  `index.lock`). Two independent guards now fix this while keeping the lesson written *first*, as
  before: autoCommit stages **per change** (everything except `*.md`, then only the shelves this
  command wrote), so a sibling's concurrently-written shelf is never bundled in; and a per-`NB_DIR`
  `.nb-git.lock` mkdir lock (distinct from `.nb.lock`) serializes only the git calls, so they can't
  collide on `index.lock`. The lock is fail-open and guards no lesson write — a git or lock problem
  never fails or loses a lesson. One commit per change, with an accurate message.

## [0.7.0] - 2026-11-06

### Added
- **`nb stale <shelf>` lists cull candidates to revive the curation loop (#240).** The `#223`
  usage audit found the curation half of the design dormant: 572 upvotes vs 3 downvotes, and
  eviction only ever culls at the 50-line cap — so on a sub-cap shelf a wrong `+1` lesson
  persists forever. The new read-only `nb stale` command surfaces a shelf's lessons in the
  order eviction would drop them (lowest score first, ties → stalest), most disposable first,
  with a ready-to-run `nb vote … -1` / `nb rm …` footer so the retrospective acts by id. It
  takes `--limit N` (default 10) and `--json` (a `StaleResult`), and never changes a score,
  reorders, or removes anything. ([FR-SHOW-003](docs/requirements.md).)
- **A too-long `add` now reports the overflow so re-drafts stop guessing (#239).** The `#223`
  usage audit found `add` wastes ~1 in 3 calls on the 200-char cap, and each rejected lesson
  is re-drafted blind because the error named the length and the cap but never how far *over*
  it was. The rejection now reports the overflow (`length - maxChars`): the human message reads
  `… N over the <cap> limit — trim at least N …`, and `nb add --json` carries an additive
  `overflow` field alongside the existing `length`. Behaviour is unchanged — a too-long add
  still exits 1 and is never stored or truncated ([FR-ADD-004](docs/requirements.md)).
- **`nb stats` reports the usage ring's own occupancy (#206).** The stats report showed
  per-shelf notebook cap pressure (#40) but never how full the monitoring log itself is. A new
  `usageRing: { rows, cap }` field (and a human `usage ring: <rows>/<cap> rows` line, flagged
  `FULL` at the cap) surfaces total on-disk row count vs the `NB_USAGE_RING` bound, so an
  operator can see the log is near compaction and about to drop the oldest history. It is total
  occupancy — independent of the `--since` window, unlike `totalCalls` — and read from the ring
  scan the report already does (no extra read). Additive: `STATS_SCHEMA_VERSION` is unchanged.

### Fixed
- **An emptied, undescribed shelf no longer leaves a 0-byte `<shelf>.md` on disk (#209).**
  When `rm` removed the last lesson from a shelf with no description, the file was rewritten as
  an empty string: `nb list` hid it, but nothing ever removed it, so phantom 0-byte files
  accumulated in the notebooks dir, every backup, and git history without bound. Such a truly
  empty file is now reaped (unlinked) under the mutation's lock. A described-but-empty shelf
  (a `# desc:` trigger with no lessons) is non-empty and is preserved.
- **The usage-log `session` column is now length-capped like `note` (#202).** `NB_SESSION`
  was written to every row with sanitization but no length cap, so a long session id (a full
  task path, a chained id) multiplied the on-disk log size across the whole ring — defeating
  the row-count bound the ring exists to enforce (the same failure #128's note cap prevents). A
  session longer than `maxChars` is now truncated (same trailing-ellipsis convention as `note`,
  never rejected — logging stays best-effort); a normal short session round-trips unchanged.
- **`nb --help` and `nb --version` now append a usage row (#250).** Both returned before the
  shared usage-logging step, so they left no trace in the usage ring — the module's "every call
  appends one line" invariant was false, and `nb stats` was blind to the classic
  integration-not-wired symptom of a harness that only ever runs `nb --help` and never a real
  command. Each now writes a lightweight best-effort row under the canonical command `help` /
  `version` (every alias — `-h`, `-v`, no-args, bare `help`/`version` — aggregates under one
  name). Logging stays best-effort, so `--help`/`--version` still succeed on a read-only
  `NB_DIR` ([FR-USAGE-001](docs/requirements.md)).

## [0.6.0] - 2026-11-06

### Changed
- **`nb-janitor` §5 co-access now tells a `fragment` from a `panel` (#223).** A high-co-access pair used
  to always advise "merge/namespace", which is wrong for distinct roles that *legitimately* co-fire — an
  RFC review panel, or an orchestrator with its per-project reviewers. Each pair is now classified: a
  `fragment` (same project scope AND a near-identical role name or shared `.`-stem — one role split in two)
  keeps the merge/namespace advice; a `panel` (different roles) is labelled "expected; extract a shared
  umbrella shelf only if they carry duplicated cross-cutting lessons, don't merge the roles". Fragments
  sort ahead of panels so a genuine split never hides behind an expected panel. `highPairs[].kind` is added
  to `--json`.

### Added
- **`nb-janitor` sections 6 & 7: curation and undescribed-shelf signals (#223).** The usage audit
  surfaced two kinds of debt the offline janitor now reports. **§6 Curation** prints the window's
  upvotes vs downvotes (the audit found voting is almost entirely upvotes, so a wrong lesson only
  leaves when its shelf fills) and lists shelves dominated by a large pile of never-reinforced
  `+1`-floor lessons to scan for ones that misfired (`nb show` → downvote/rm). Shelf-level by design:
  the janitor has no per-lesson id to date a single line. **§7 Undescribed shelves** lists shelves
  with no explicit `# desc:` trigger, ranked by *browse-without-use* count (shown in a session but
  nothing in them voted) so the noisiest over-promisers get a real trigger first (`nb describe`); the
  browse ranking needs `NB_SESSION`, degrading to an alphabetical list without it. Both appear in
  `--json` as `curation` and `undescribed`. Read-only and zero-dependency, like the rest of the janitor.
- **`nb stats` surfaces per-command error causes in the header (#223).** The per-command table shows
  each command's error *rate*; a new `error causes:` block names the *cause* so the two most actionable
  rates — `add` over-the-cap rejections and `vote` selector-resolution failures — are visible up front
  instead of buried behind the high-error-rate anomaly threshold. Each cause is an `errorClass` token
  (#176); a row predating that column falls back to its `outcome` (so `add`'s `too-long` still shows on
  an older log) and otherwise reads `unclassified` with a one-line cue to upgrade `nb`. Only commands
  with at least a handful of errors are listed. Exposed in `--json` as the additive `StatsReport.errorCauses`
  (`{ command, errors, breakdown: [{ cause, pct }] }`); no schema bump (purely additive).
- **`nb show` prints a copy-paste vote hint with the shelf filled in (#223).**
  The usage audit found ~1 in 5 votes failing on a fuzzy *text* selector even though the stable id
  was printed on the same line. `nb show <shelf>` now ends (when it has lessons) with a `#` comment
  line — `# vote by id: nb vote <shelf> <id> +1|-1  ·  several at once: nb vote <shelf> <id1,id2,…> +1`
  — so the reflect step votes by the id above (and can batch) instead of by an ambiguous substring.
  Display-only: it is never written to the file, never parsed back as a lesson, and is suppressed
  under `--json` (which stays a lone `ShowResult`) and on an empty/never-created notebook.
- **`nb vote <shelf> <id1,id2,…> +1|-1` votes several entries in one call (#223).**
  The end-of-session retro routinely promotes or demotes a handful of lessons at once; until now
  that was N separate `nb vote` calls — N round-trips, N chances for a stale/ambiguous selector to
  fail, N usage rows. A comma-separated list of **≥2 bare hex ids** (the ids `nb show` prints) now
  applies one delta to all of them under a single lock and a single write. It is batch **only** for
  an id list: a single token, or any comma-part that is not a bare hex id, stays one (possibly text)
  selector, so `nb vote s "build, then test" +1` is unchanged — batch-by-fuzzy-text would reintroduce
  exactly the ambiguity the id selector exists to avoid. Best-effort: each id resolves independently,
  an unresolved one is reported on stderr **without** aborting the rest, and the call exits non-zero
  only when *none* landed. `--json` emits the per-id result array (`{selector,id,text,score}` or
  `{selector,error}`). Library: `voteMany(dir, shelf, selectors, delta)`. A batch is **one logged
  action**: it writes a single usage row whose `entries` column lists every touched id (an all-fail
  batch logs a blank outcome, exactly like a single failed vote, so `nb stats` never counts a
  phantom upvote or marks a session engaged when nothing landed).
- **`nb config` prints the effective (post-clamp) `NB_*` tunables (FR-CONFIG-001 / #188).**
  Every knob is read at call time and *clamped* to its range, so the value `nb` actually runs
  under is not always the one you exported; there was no command that surfaced it, so when behavior
  looked wrong (a cap evicting too hard, a loop detector firing early, a near-dup over-warning) an
  operator had to re-derive the effective value by hand from the env var, its default, and its
  clamp. `nb config` now prints each effective tunable as `name=value` — the caps, near-dup
  threshold, usage ring + derived slack, lock timings, and the `nb stats` anomaly/readout
  thresholds — each read from the **same exported getter the hot path uses**, so a printed value
  can never drift from the value in force. Each line is tagged with its source: `(default)` (var
  unset), `(env NB_*)` (var set — the printed value is still the post-clamp effective one, so an
  out-of-range or non-numeric value shows up corrected, never silently misrepresented, DP-5), or
  `(derived …)`. `nb config --json` emits one object keyed by tunable name, each `{ value, source,
  env }`. Read-only (it mutates nothing) and scoped to *configuration*, deliberately distinct from
  `nb stats` (usage, anomalies, engagement). To surface the `nb stats` thresholds without copying
  their clamp logic into a second place (the #116-class drift the #131 guard guards against), the
  inline threshold constants in `stats()` were extracted into exported getters
  (`loopN`/`loopWindowSec`/`silentHours`/`errMin`/`errRate`/`coverageHi`/`recallMissHi`) that
  `stats()` now calls — a behavior-preserving refactor (same defaults, same clamps). `config` is
  added to `KNOWN_COMMANDS`/HELP/dispatch so the drift guard stays green and shell completion
  learns it.
- **`nb search --limit N` bounds results like `nb list` (FR-SEARCH-001 / #186).** `nb list`
  takes `--limit` (default 50) so the index stays flat as notebooks grow, but `nb search` had no
  result bound — a common term (or `--any`) on a many-shelf deployment dumped every matching
  notebook's hits to stdout, the exact "discovery cost grows with the corpus" problem. `search()`
  now takes an optional `limit` that bounds the returned notebook **groups** after ranking, and the
  `search` CLI case parses `--limit` with the same forgiving semantics as `list` (a bad value warns
  on stderr and falls back to the default `50`); the human header then reads `N of total notebooks`.
  The bound shapes only what is returned/printed: `SearchResult` now also carries `total` (the full
  pre-limit match count) and `surfacedIds` (every id surfaced across the full result), and the
  `failed-search` gap-sensor outcome and the `#114` surfacing provenance are computed on that full
  result — so a small `--limit` (even `0`) can never turn a real `match` into a `no-match` coverage
  gap. `--json` reflects the bounded `groups` plus the two full-result fields.
- **`nb path --usage` prints the resolved usage-log path (FR-PATH-001 / #169).** `nb path`
  exposed the notebooks dir and `<shelf>.md` paths but nothing printed the usage-log path, so a
  supervisor had to hard-code `$NB_DIR/.nb-usage.log` to tail or back it up — the same coupling
  `nb path` was added (#14) to remove, which would break silently if the internal filename ever
  changed. `nb path --usage` now prints `<NB_DIR>/.nb-usage.log` as a bare path (pipe-friendly,
  no decoration), and `usageFile(dir)` is exported for programmatic use. `--usage` is the only
  recognized flag; any other `--`-prefixed token is rejected by the safe-shelf check, so it can
  never collide with a shelf name. (Tail with `tail -F`: the log is a self-compacting ring
  replaced by write-then-rename, so a `-f` tail on the old inode would go stale.)
- **Serendipity surfacing provenance (`serendipity` in `nb stats`, FR-STATS-004 / #114).**
  `serendipity` was defined (`relevant ∧ arrived-unbidden`) but not measurable: the log carried
  no surfacing provenance, so an upvote could not be told apart as push- vs pull-delivered.
  `nb search` now logs the entry ids it surfaced (reusing the `entries` column — no new column),
  so within a session an upvote on a searched entry reads back as a *pull* and one no search
  returned as a candidate *push*. `nb stats` reports `serendipity` = push-delivered upvotes ÷
  `upvotes` (both exposed in `--json`), beside recall-miss/precision-miss. Pull evidence is read
  deployment-wide, so a shelf-scoped report still sees the cross-notebook search. It is published
  as a two-sided inferred **proxy, not a bound** (a `show`-pull/recall inflates it; a same-session
  search match deflates it) and the human line flags it with a leading `~`. The positive push
  record — tagging the session-start injection hook's own read — is a cross-repo follow-up under
  the #73 injection contract (see RFC 0114). The `[loop]` anomaly still treats a `search` as
  entry-less, so hammering `search` with varying queries is still flagged.
- **Non-blocking near-duplicate advisory on `nb add` (FR-ADD-008).** The exact-normal-form
  dedup key misses paraphrases (`"run lint before done"` vs `"lint before claiming complete"`),
  so a re-derived lesson is silently re-stored and the recall-miss goes uncounted. An accepted
  add now also compares the lesson to existing entries with a deterministic, dependency-free
  trigram-Jaccard `similarity`; when one is at/above `NB_NEAR_DUP` (default `0.5`) it still
  stores the lesson (never blocks — a fuzzy match must not cause a silent loss, DP-5) and
  prints a `nb merge` suggestion to stderr (stdout stays pipe-clean; `--json` carries `nearId`).
  The resembling id is logged in the `collided` column of the still-`accepted` row, making the
  near-duplicate / paraphrase-miss rate measurable. No embeddings, no new runtime dependency
  (NG-001 amended to permit a non-blocking lexical advisory while the *blocking* decision stays
  exact-normal-form only).

### Fixed
- **A `vote`/`rm`/`split`/`move` on a never-created shelf now reads as a typo, not an empty
  notebook (FR-CLI-006 / #200).** These commands threw `notebook for shelf "X" is empty` for a
  shelf that was *never created*, mislabeling a mistyped name as a real-but-empty notebook — so an
  agent would seed a brand-new lesson onto the wrong (nonexistent) shelf instead of correcting the
  name, silently fragmenting memory across typo shelves. The CLI now checks existence first (as
  `nb show` has since #166) and reports `no notebook for shelf "X"`, appending an advisory `did you
  mean "<nearest>"?` when a close existing shelf is found — the shelf sibling of the command
  did-you-mean (#171), over the same `editDistance`. An *existing but empty* shelf still reports
  `is empty`; the hint never auto-corrects; and the core mutation functions are unchanged. For
  `move`, only the source is guarded — a never-created target is still created like `add`.

### Documentation
- **Retrospective contract now steers `vote` to the id, not a text snippet.** `nb stats` showed
  `vote` erroring on ~22% of 325 calls, and dozens of `browse-without-use` sessions (a shelf shown
  but never voted) — because the injected contract advertised "a unique snippet of the lesson text
  works too" as an equal to the id, and a *non-unique* snippet is refused (`notebook.ts` lists the
  candidate ids). The `AGENTS.md` §④ retrospective step and the Codex `AGENTS.snippet.md` now tell
  the agent to vote by the `<id>` `nb show` already prints at each line start (with a worked example),
  and frame a text substring as refused-if-ambiguous rather than a casual equal — removing the
  invitation to the error path that was also suppressing the end-of-task retrospective.
- **README recentered on the developer audience, with the compounding payoff stated plainly (#139).**
  The top of the README now opens with a one-line *who this is for* (developers who run AI agents and
  want them to carry a few durable lessons across runs) and a plain payoff sentence (the agent remembers
  hard-won lessons, avoids repeating mistakes, and improves over the experience it has chosen to keep — voted by
  usefulness, bounded in size), instead of describing the tool mostly by what it is not. `nb --help` now
  echoes the same one-line description so the framing is consistent in-product.

## [0.5.0] - 2026-10-31

### Fixed
- **`nb stats` no longer mistakes a retrospective sweep for a stuck loop.** The `[loop]`
  anomaly ("N+ calls within the window — the agent may be stuck/looping") keyed only on
  shelf + command, so a healthy retrospective that rapidly votes many *distinct* lessons in
  one session tripped it. The loop key now includes the touched entry id(s), so repeating the
  *same* targeted call (or a repeated entry-less call like `show <shelf>`) still trips it while
  a sweep across distinct entries does not.
- **`nb-janitor` shelf-name dedup (section 2) is now `@project`-scope-aware.** A shelf name is
  `role@project` (and the role may use the `.`-namespace convention). The old check ran
  edit-similarity across the whole name with only a `.`-stem suppression, so a long shared
  `@project` suffix inflated the score and flagged `orchestrator@proj` vs `patch-author@proj`
  — different roles in the *same* project — as "likely the same shelf split in two." It now
  compares similarity on the *role*, only within the same project scope, while still suppressing
  intentional `.`-namespace siblings (`build.ci` vs `build.cd`, which the role comparison alone
  would wrongly flag). Genuine same-scope typo fragmentation (e.g. `code-review` vs
  `code-reviews`) is still caught.

### Added
- **"Diagnosing low engagement" runbook** (issue #108). [`docs/harness-setup.md`](docs/harness-setup.md#diagnosing-low-engagement)
  gains a troubleshooting section for the *ongoing* symptom the old "Verify it's working" smoke
  test never covered — "my agents don't seem to use the notebooks." It centers on the failure mode
  that is otherwise silent: the SessionStart injection hook **fails open**, so a mis-wired hook
  errors nothing and tells no one. A symptom→cause→remedy decision tree reads the deployment-wide
  `nb stats` `surfacing:` line (the no-argument form — the engagement diagnosis is computed across
  all shelves regardless of any shelf argument, so the no-arg view is the one that also prints the
  full inventory) and maps each of the three #105 root causes to its concrete
  fix: hook-not-wired → a copy-paste **hook self-check** (`bash examples/hooks/claude-code/nb-session-start.sh | head`;
  empty ⇒ broken), reads-but-no-votes → wire the retrospective hook, blank sessions → export
  `NB_SESSION` — plus a fourth "engaged, not a bug" row for genuine quiet. Linked from the README.
  Docs-only; no code, no notebook-file schema change.
- **nb-janitor reports shelf co-access** (issue #107). The offline, read-only janitor
  (`examples/nb-janitor.mjs`) gains **section 5**: it groups usage rows by session, collects
  the set of shelves `show`n per session, and counts shelf-pair co-occurrence — the one signal
  the shelf definition rests on (lessons needed *in the same situations*) that nothing measured
  before. It reports **high-co-access pairs** ("almost always opened together → consider one
  namespaced shelf or `nb merge`", when a pair's `co ≥ 2` and `co / min(shows) ≥ 0.8`) and
  **isolated shelves** (shown but never alongside another). Blank-`NB_SESSION` logs degrade to a
  one-line "set NB_SESSION" note, exactly as section 4 degrades without git. The data is added to
  `--json` as `report.coAccess` (`{ computed, sessions, highPairs, isolated }`). Read-only, hot
  `nb` path untouched (DP-6), zero dependencies, no notebook-file schema change. See
  [RFC 0107](docs/rfcs/0107-janitor-shelf-co-access.md).
- **`nb stats` shows an ops-per-day activity sparkline** (issue #106). The report gains a
  one-line, zero-dependency Unicode block-glyph plot of activity over the window —
  e.g. `activity  ▂▁▅█▇▃▁  (7d, 41 ops)` — so "when did this store go quiet?" is answerable
  at a glance instead of by eyeballing raw `.nb-usage.log` timestamps. Rows are bucketed
  into **rolling 24-hour windows counting back from now** (timezone-free; oldest bucket
  leftmost, the 24h ending now rightmost), and the per-bucket counts are exposed as
  `StatsReport.activity` in `nb stats --json` (`sum(activity) === totalCalls`). Scaling is
  zero-based so a silent (0-op) bucket always reads as the floor glyph `▁`. No notebook-file
  schema change and no new runtime dependency; the library gains the pure `sparkline` and
  `activityByDay` functions. See [RFC 0106](docs/rfcs/0106-stats-activity-sparkline.md).
- **`nb stats` breaks down "no engaged sessions" by root cause** (issue #105). When the
  engagement gate finds no engagement anywhere in the window, the one vague
  `surfacing: no engaged sessions…` line is replaced by up to three terse, actionable
  lines naming the actual deployment-level failure(s): `NB_SESSION` unset (calls can't be
  grouped into sessions), the retrospective nudge not landing (a notebook was opened but
  never voted), or the SessionStart injection hook not wired (notebooks hold lessons but
  nothing read them). The diagnosis is deployment-wide — the hook's own global `nb list`
  is counted as a read but **not** as deliberate engagement, so it is never
  double-counted — and the underlying counts are exposed as
  `surfacing.engagementDiagnosis` in `nb stats --json` (`null` whenever any session was
  engaged). No notebook-file schema change; the library gains the `diagnoseEngagement`
  function and the `EngagementDiagnosis` type.
- **`nb move <from> <to> <id|query>` — score-preserving cross-shelf move** (issue #103).
  Relocates one lesson from one shelf to another **with its score intact**, the
  consolidation `add`+`rm` could not express (`add` always enters at the `+1` floor, so a
  hard-won lesson would land at the bottom of the target and lose its vote history). The
  entry is admitted into the target like a newcomer, so a full target ages/evicts its
  stalest *other* line, never the lesson just moved. The move is refused — writing nothing
  to either shelf — when the source and target are the same shelf, the selector is
  absent/ambiguous (same unique-match rule as `vote`/`rm`), or the target already holds a
  near-duplicate (same dedup rule as `add`). Accepts the usual `--reason <code>`/`--note`
  (enum: `consolidate` · `other`) and `--json` (emits a `MoveResult`). The library gains
  `move(dir, fromShelf, toShelf, selector)` and the `MoveResult` type.

## [0.4.0] - 2026-10-29

### Changed
- **Terminology: a notebook file is now called a *shelf*.** A shelf is one `<name>.md`
  notebook file: a group of lessons an agent needs in the same situations. Lessons are
  grouped by co-access (needed together), not by agent role, so an agent that opens a
  shelf can get the lessons it looks for plus ones it might not think to search for. The CLI help, error messages (e.g.
  `invalid shelf name`, `missing <shelf> argument`), human `nb stats` output, README,
  AGENTS.md and docs now say shelf. Argument positions, the `shelf@project` scoping, every
  `NB_*` variable, the file layout and the usage-log format are unchanged.

- The `.` namespace convention now recommends **no prefix or one level at most**
  (`family.situation`). The dot builds no hierarchy, and deeper names split lessons that
  are needed together into small shelves. Docs only; no behaviour change.

- **A full shelf is the normal state; do not split a shelf because it is full.** Eviction
  and aging only run at the cap, and they are what retire unused lessons; splitting on
  size multiplies half-empty shelves and makes the index harder to choose from. The README
  gains a section on when to act: only when a full shelf keeps evicting lessons still
  scored above the starting +1, or relearns evicted ones. The `eviction-while-still-voted` signal of `nb stats`
  now counts only lessons evicted with a score above the +1 a new lesson starts at (evicting
  a lesson that was never voted, or that fell back to +1 or below, is the cap working),
  and its detail no longer suggests splitting.
- `examples/nb-janitor.mjs`: section 1 is now "Lessons lost to eviction". It flags a shelf
  with 2 or more evictions of lessons scored above +1 or re-added evicted lessons in the window, and
  reports how many shelves are full for information only. The `--json` report replaces
  `capPressure` with `fullShelves` and `lostLessons`.

### Added
- `shelf` key next to `role` (same value) on every JSON object that carried `role`:
  `nb show --json`, `nb list --json` rows, `nb search --json` groups, `nb describe --json`,
  and in `nb stats --json` the `notebooks[]`, `anomalies[]` and `signals[]` entries.
  `notebookTotals` gains `shelves` next to `roles`.
- Library exports `listShelves` and `assertSafeShelf`, and a `shelf` option for `stats()` (the `role` option still works).
- `nb shelves`, an alias of `nb list`.

### Deprecated
- The `role` / `roles` JSON keys, the `listRoles` and `assertSafeRole` exports, the `role`
  option of `stats()`, and the `nb roles` command. They still work and behave exactly as before; they will be removed
  only in a later release marked BREAKING.

## [0.3.0] - 2026-10-29

### Changed
- **Eviction is now recency-aware, and a full notebook always admits a newcomer.**
  Storage order became *recency* order (least-recently-touched first): a touch — a vote
  of either sign, an add, or a merge/split's new lesson — moves its entry to the end of
  the file. When a full notebook takes a new lesson it is always stored (the old
  `rejected-full` outcome is gone); the lowest-scored line is evicted (ties → stalest) and
  then the stalest *surviving* line is docked one point. That gentle, targeted "aging" is
  what lets a once-upvoted lesson that has gone quiet eventually fall, instead of being
  immortal, without needing a downvote to arrive. It fires only when a notebook is full, so
  every sub-cap notebook is unaffected except that a vote now moves its line (a ~2-line git
  diff instead of a 1-line one). Rationale and the full design in `docs/eviction-and-aging.md`;
  this reverses the old DP-3 "storage is insertion order, never reordered on vote".
- The default per-notebook cap (`NB_MAX_LINES`) is now **50**, down from 200. A tighter
  default keeps eviction pressure meaningful and a notebook focused on the lessons that
  earn their place; most roles need far fewer than 200. Raise it any time with
  `NB_MAX_LINES` (range unchanged, 1–5000). The character cap (`NB_MAX_CHARS`) stays 200.

### Added
- Onboarding and harness-integration documentation (docs-only; no package behaviour change).
  - `AGENTS.md` (with `CLAUDE.md` as a symlink to it) — the agent operating contract: the
    four moments (list / open / subagent / retrospective) and how to write a lesson. The
    core behaviour is harness-agnostic: the agent lists the notebooks and opens the ones
    that fit, rather than a role-specific notebook being auto-injected.
  - `docs/getting-started.md` (plain-language intro with diagrams), `docs/harness-setup.md`
    (make Claude Code / Codex CLI use it on Linux/macOS/Windows via the list-&-open
    instruction, plus optional convenience hooks, git-versioning, backup, janitor),
    `docs/enterprise.md` (data-sovereignty / security / compliance rollout), and
    `docs/visual-explainer.html`.
  - `examples/` — the optional harness layer: `nb-git-wrapper.mjs` (a commit per change),
    `nb-backup.sh` (daily push), `nb-janitor.mjs` (read-only cross-notebook diagnostics:
    paraphrase-duplicate and near-duplicate-role detection, cap pressure, growth trends),
    and hook recipes for Claude Code and Codex CLI.
  - `.claude/skills/` — `agent-notebook-setup` and `agent-notebook-explain` skills that
    walk a user through configuration or explain the tool on request.

## [0.2.1] - 2026-10-28

### Added
- `nb show <role> --json` (#87) emits the notebook as `{ role, description, entries: [{ id, score, text }] }`,
  in the same order and with the same ids as the human output, so agents no longer parse text. The flag works
  before or after the role; the human output is unchanged. Library form: `showJson(dir, role)`.

### Fixed
- `nb describe` now strips the optional `--reason`/`--note` flags before reading its
  text operand, like the other mutating commands (#91). Previously an option placed
  before the text (`nb describe <role> --reason other "real text"`) was silently stored
  as the description and the intended text dropped, exiting 0 — a DP-5 violation. The
  flags are now logged to the usage log (never the notebook); `describe` has no seeded
  enum, so a stray code buckets to `other` with its text kept in the note, like `add`.
- A `README.md` in `NB_DIR` is no longer treated as a notebook (#90). A README is
  common when the notebook folder is a git repo that backs up your notebooks; it was
  being listed, searched, counted in `nb stats`, and — worst — voteable/removable,
  letting a write command rewrite it. `README.md` (case-insensitive) is now excluded
  from `listRoles` and the `README` role name is reserved in `assertSafeRole`, so no
  read or write command touches it. Documented beside the `.` namespace convention.

## [0.2.0] - 2026-10-28

### Added
- The **`.` namespace convention** for grouping notebooks (#83) — a documented,
  recommended way to cluster related notebooks by a `.`-delimited role-name prefix
  (`review.tests`, `review.correctness`) so they sort together and `nb list review.` /
  `nb search "flaky" review.` scope straight to the group. It is a **naming convention
  only**: a namespaced role is a first-class role (no change to `assertSafeRole` — `.`
  was already a legal interior character) stored as one flat `<role>.md` file, never a
  directory, and grouped lexically with no embeddings or similarity ([NG-001]). Keep the
  trailing dot so `review.` does not also match a bare `reviewer`; `@` stays reserved for
  the existing `role@project` scoping and composes with a namespace
  (`review.tests@repo`). Documented in the README and as [FR-NAMESPACE-001]; part of
  epic #73 (Phase 2).
- `nb search <query> [prefix] [--any]` (#82) — a **demoted, secondary** keyword fallback
  and gap-sensor. The primary path is *surfacing* (injection + the `nb list` index), per
  [DP-8] / [NG-007]; search exists only for genuine known-item lookup, and both the help
  text and the output say so plainly. It is **keyword-only** (plain case-insensitive
  substring over the query's terms — no embeddings, [NG-001]): it scans every notebook's
  lessons and descriptions, AND-over-terms by default (`--any` for OR), groups hits by
  notebook most-relevant-first, and prints each lesson's id so the agent can `vote` it.
  `--json` emits the raw `SearchResult`; the library form is `search(dir, query, {prefix?, any?})`.
  A search that finds nothing is logged (outcome `no-match`, query in the usage note) and is
  not an error (exit 0). That unlocks the **`failed-search → add` coverage-gap signal**
  deferred from #72: `nb stats` now derives a fourth `DiagnosticSignal` kind, `failed-search`,
  when a `no-match` search is followed by an accepted `add` in the same session — a gap the
  notebook did not hold, labelled by the agent's own query.
- Named **surfacing metrics** in `nb stats` (#81). `StatsReport.surfacing`
  (`SurfacingMetrics`) turns the usage ring into the rates the design rationale §4
  defines: **coverage** (novel-add rate = accepted ÷ attempts), **recall-miss** (the
  headline alarm — dedup-block rate = blocked ÷ attempts, a stored lesson re-derived),
  **precision-miss** (downvotes ÷ votes on pushed lessons, read beside recall so
  "surface everything" can't look free), and a coverage×surfacing **readout**
  (`healthy` / `surfacing-failure` / `coverage-building` / `churny`). Every rate is
  conditioned on *attempts* (robust to a lazy agent) and gated on *engagement* — only
  sessions with a vote are scored, so an uninstrumented session isn't read as "healthy
  quiet"; a rate with no data is `null` (shown `—`), never a misleading `0`. Surfaces in
  the human table under a `surfacing:` section and in `--json` as `StatsReport.surfacing`.
  Readout cutoffs are tunable via `NB_COVERAGE_HI` (default `0.5`) and `NB_RECALL_MISS_HI`
  (default `0.2`). Needs `NB_SESSION` set to attribute calls to sessions.
- `docs/self-observing-notebook.md` — the design rationale for the self-observing
  signal layer: why the tool instruments itself, what each operation signals, and how
  engagement, coverage, surfacing recall, surfacing precision, and serendipity are
  distinguished. Linked from `docs/requirements.md`.
- Free diagnostic signals in `nb stats` (#72). Three memory-quality observations read
  straight from the usage ring — no new agent action, no field added to a lesson: 
  **browse-without-use** (a notebook `show`n in a session with no `vote` on it that
  session → its description may over-promise), **eviction-while-still-voted** (the cap
  evicted an entry that had been voted on → the cap may be too tight for that role), and
  **vote-reversal** (the same entry upvoted in one session and downvoted in another →
  correct but mis-aimed). They surface in the human table under a `signals:` section and
  in `--json` as `StatsReport.signals` (`DiagnosticSignal = { kind, role, detail,
  session?, entry? }`), computed over the same windowed, role-scoped rows as the
  anomalies. browse-without-use and vote-reversal are session-scoped, so set `NB_SESSION`.
  The `failed-search→add` coverage signal is deferred to the future `nb search` command.
- `nb list` — the notebook index (#71). One richest-first line per notebook — name,
  lesson count, and description — so an agent can decide *which* notebook to open
  without reading any of them (level 1 of progressive disclosure for epic #73). `ls`
  and `roles` are aliases. Ordered by lesson count (ties by name); a notebook with no
  `# desc:` falls back to its top-scored lesson, marked `(auto)`. A bare `prefix`
  filters by name (the `.` namespace convention, e.g. `nb list review.`), `--limit N`
  bounds the rows (default 50; the header then reads "shown of total") so discovery
  cost stays flat, and `--json` emits the raw `NotebookListing`. An empty (zero-lesson,
  no-description) notebook is hidden as phantom debris; a described-but-empty notebook
  is kept. New library export `listNotebooks(dir, {prefix?, limit?})`.
- Notebook descriptions: `# key: value` metadata + `nb describe` (#70). A notebook file
  may now begin with a leading `# key: value` comment block; `readEntries` skips it (a
  `#`-leading `key:` line never becomes a score-0 lesson) and every mutation round-trips
  it. `nb describe <role> "<text>"` sets the notebook's one-line description — a *trigger*
  for when to open it — stored as a `# desc:` line; `nb describe <role>` prints it, an
  empty text clears it, and `nb show` prints it as a header. The description is capped
  like a lesson (rejected, not truncated), and unknown keys are preserved verbatim
  (forward-compatible). Stays within the no-schema non-goal — metadata is optional
  comment lines in the file, not a field on a lesson. Level 1 of discovery for epic #73.
- Entry-level + outcome logging in the usage ring (#67). Each `.nb-usage.log` row now
  also records the entry id(s) a call touched, a session id from the `NB_SESSION`
  environment variable, and the call's outcome (`accepted`/`dedup-blocked` with the
  colliding id, vote direction, eviction). The parser tolerates old five-column rows,
  logging stays best-effort, and the ring stays bounded — no field is added to a
  lesson. Foundation for the self-observing-notebook diagnostics (epic #73).
- This changelog.
- **DP-8 / NG-007** in `docs/requirements.md`, and a matching line in the README:
  memory's job is to surface the lesson an agent would not think to search for, so
  the notebook is *shown* (injected) rather than queried — a search-first retrieval
  model is a non-goal.
- `docs/requirements.md` — a canonical specification of the essential
  features, design choices, and their rationale (including why the on-disk
  file is stored in insertion order rather than sorted), so settled decisions
  are not re-litigated or mistaken for bugs.
- A pull-request template (`.github/PULL_REQUEST_TEMPLATE.md`) with a checklist
  item that keeps `docs/requirements.md` in sync with code changes.

### Changed
- `nb roles` is now an alias of `nb list` (#71): instead of a bare sorted list of role
  stems, it prints the richest-first index (header + one `name  count  description` row
  per notebook). Use `nb list --json` or the `listRoles` library function for the plain
  sorted stems. (This matches the richer format the kookr `nb` shim already provided.)
- The README now documents the `nb stats` anomaly-tuning environment variables (#8).
- The README now has animated SVG explainers (#13).

### Fixed
- `nb --version` now prints the real package version instead of a placeholder (#9).
- `nb stats --since` now warns about an invalid value (e.g. `--since banana`) instead of silently falling back to the full history (#11).

## [0.1.3] - 2026-10-23

### Fixed
- A fresh `npm run build` now produces an executable `nb`, and the build no longer depends on `@types/node` resolving indirectly.

## 0.1.2 - 2026-10-23

### Changed
- Version bump; no user-facing changes.

## 0.1.1 - 2026-10-23

### Changed
- Releases are now published to npm from CI using short-lived OIDC credentials (npm Trusted Publishing, with provenance) instead of a stored token. No change to the installed package.

### Fixed
- `nb` silently did nothing when run through an npm bin symlink; it now runs normally.

## 0.1.0 - 2026-10-23

### Added
- Initial release: a bounded, voted, plain-text memory for AI agents. Commands: `nb add`, `show`, `vote`, `merge`, `rm`, `stats`. Each role's notebook holds at most 200 lines, each at most 200 characters, and the lowest-scored line is evicted first when full. The library has zero runtime dependencies.

[Unreleased]: https://github.com/jeanibarz/agent-notebook/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/jeanibarz/agent-notebook/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jeanibarz/agent-notebook/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/jeanibarz/agent-notebook/releases/tag/v0.1.3
