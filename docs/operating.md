# Operating `nb`

*For whoever looks after a store that agents use: what `nb stats` reports, what the usage log records, how to read an error spike, and every knob `nb` reads. For the commands themselves, see the [CLI reference](cli-reference.md).*

`nb` keeps a small usage log beside the notebooks: one row per call. `nb stats` reads it back, so you can see whether agents use the notebooks at all, whether lessons reach them, and where they go wrong. Nothing here is needed to use `nb`; it is there when you want to check.

---

## How long a lesson stays

On a full shelf, `nb stats` prints each shelf's accepted adds in the window and an estimate of how long an unvoted lesson lasts there (`~10d retention`). What that number means, and what to do when it is short, is in [A full shelf is the normal state](eviction-and-aging.md#a-full-shelf-is-the-normal-state).

## Activity sparkline

`nb stats` prints a one-line **ops-per-day activity sparkline** (an *op* is one `nb` call) right under its header, so "when did this store go quiet?" is answerable at a glance. **Illustrative:**

```
nb usage — window 7d, 41 calls
  activity  ▂▁▅█▇▃▁  (7d, 41 ops)
```

Each of the eight Unicode block glyphs (`▁▂▃▄▅▆▇█`) is one bucket, scaled against the window's busiest bucket — zero-based, so a **silent (0-op) bucket always reads as the floor glyph `▁`** and the busiest as `█`. Buckets are **rolling 24-hour windows counting back from now** (not calendar days, so there is no timezone question): the leftmost glyph is the oldest 24h of the window and the rightmost is the 24h ending now. The bucket count follows `--since` (`7d` → 7 glyphs, a sub-day window → 1), and it is scoped to `[<shelf>]` like the rest of the report. In `--json` the same counts are the `activity` array (oldest bucket first; `activity.length` is the bucket count and `sum(activity) === totalCalls`). Zero dependencies — no chart library, no network. `NB_ASCII` switches the glyphs to ASCII digits ([below](#other-environment-variables)).

## Free diagnostic signals

`nb stats` also surfaces a handful of **free diagnostic signals** — memory-quality observations read straight from the usage log, costing no new agent action because each is already implied by behaviour the agent performs for its own reasons. They appear in the human table under a `signals:` section and in `--json` as `signals[]` (each a `DiagnosticSignal` = `{ kind, shelf, role, detail, session?, entry?, shown?, voted? }`, where `role` is a deprecated copy of `shelf`). The kinds:

- **browse-without-use** — a notebook was `show`n in a session but nothing in it was voted that session. One such session is weak evidence, since an agent may open three shelves and vote in the one that helped, so the signal is read per shelf:
  - The human table prints one line per shelf with both counts (`shelf s: shown in 15 sessions, voted in 3 (20%)`), lowest voted share first, for shelves shown in at least 3 sessions, and folds the rest into one summary line.
  - A listed shelf whose printed share is below 25% gets "the notebook's description may over-promise".
  - A `show` of a shelf with no notebook file never counts: it is logged with outcome `no-shelf`, so it stays uncounted even if the shelf is created later in the session. Older rows without that outcome are skipped when the shelf still has no file.
  - `--json` still lists every (session, shelf) pair, each with the shelf's `shown` and `voted` session counts.
- **eviction-while-still-voted** — the cap evicted an entry (the `evicted` column of an `add`, `merge` or `split`) that agents had found useful, so a useful lesson was lost. One occurrence is normal churn; repeated ones on the same shelf mean the cap is too tight for it (see [A full shelf is the normal state](eviction-and-aging.md#a-full-shelf-is-the-normal-state)). "Useful" means either:
  - (a) it was upvoted during the usage window and its score when evicted was 0 or more, or
  - (b) its score when evicted was above +1, the score a new lesson starts at.
- **vote-reversal** — the same entry was upvoted in one session and downvoted in another → the lesson may be correct but *mis-aimed* (right in one context, wrong in another).
- **failed-search** — a [`nb search`](cli-reference.md#searching--the-demoted-fallback) returned nothing and a lesson was then `add`ed in the same session → a coverage gap the notebook did not hold, labelled by the agent's own query.
- **add-burst** — one session accepted more than `NB_ADD_BURST_N` (default 15) adds into a single shelf → on a full shelf each add evicts a line, so the burst shortens how long the other lessons survive. Fix it with fewer, better lessons per session.

Four of the five (browse-without-use, vote-reversal, failed-search, add-burst) are **session-aware**: set `NB_SESSION` (a hook or supervising agent does this) so calls can be attributed to a session; calls with a blank session are skipped. eviction-while-still-voted needs no session. Like the anomalies, they are computed over the windowed, shelf-scoped usage rows (so `--since` and `[<shelf>]` apply). They are deliberately heuristic *hints*, not verdicts: a glance that didn't lead to a vote isn't proof a description is bad, just a place worth a look.

## Surfacing metrics

Beside the free signals, `nb stats` reports the named **surfacing metrics** (`StatsReport.surfacing`, a `SurfacingMetrics` object) — the rates that say whether the notebook is *covering* and *surfacing* at all. They turn the usage log into the numbers the [design rationale](self-observing-notebook.md) §4 defines:

- **coverage** (novel-add rate) — `accepted` adds ÷ add attempts. High early (a young notebook filling gaps) is expected, not a fault.
- **recall-miss** (the headline alarm) — `dedup-blocked` adds ÷ add attempts: the agent re-derived something the notebook *already held*, so a stored lesson failed to reach it.
- **precision-miss** — downvotes ÷ votes on *pushed* lessons, that is lessons put in front of the agent rather than found by its own search (today every lesson it votes on counts as pushed; see the note below). For example, 2 downvotes in 10 votes is 0.2. It is read right beside recall-miss so chasing recall ("surface everything") can't look free.
- **readout** — where (coverage, recall-miss) lands on a 2×2: `healthy` (covers and surfaces), `surfacing-failure` (content present but not reaching the agent), `coverage-building` (a young notebook filling gaps), or `churny` (gaps *and* poor surfacing). A heuristic hint, not a verdict.

Votes are counted **per lesson**: a batch `nb vote <shelf> id1,id2 +1` counts one vote per landed id. Two properties keep the rates honest. They are conditioned on **attempts** (add/vote *events*), so a lazy agent is just a small sample, never a deflated "healthy 0%". And they are gated on **engagement**: only sessions that show a vote are scored — a vote-less session is a setup/plumbing gap, excluded rather than mistaken for "healthy quiet". A rate with no data is `null` (shown `—` in the table), never a misleading `0`. They need `NB_SESSION` set to attribute calls to sessions. (Every delivered lesson is currently treated as *pushed* for precision-miss; now that [`nb search`](cli-reference.md#searching--the-demoted-fallback) exists, narrowing this to non-search-delivered lessons is a possible future refinement.)

## What the usage log records

Every `nb` call appends one tab-delimited row to the usage ring (`.nb-usage.log`; `nb path --usage` prints its path). Beyond the base `timestamp · shelf · command · ok|err · duration`, each row also records, per call:

- the **entry id(s)** the call touched — the added/voted/removed entry, (for `merge`) the two sources plus the merged result, or (for `split`) the source plus the two produced entries;
- a **session id** read from the `NB_SESSION` environment variable (a hook or supervising agent sets it so calls can be grouped; absent → blank, and co-access simply isn't computed);
- the **outcome** — for `add`, `accepted` or `dedup-blocked` (and on a block, the colliding entry's id); for `vote`, `up` or `down`; `removed` / `merged` / `split` for `rm` / `merge` / `split`; `no-shelf` for a `show` of a shelf with no notebook file; `off` for a text `nb list` that printed the switched-off line instead of the index; `match` / `no-match` / `no-terms` / `no-shelf` for `search` (`no-shelf`: the prefix operand matched no shelf, so nothing was searched; with the query kept in the note, so a failed search becomes a gap signal); plus, when an `add` evicts, which entry left and its final score;
- the optional **operation reason** — a per-op enum code and free-text note attached to any mutating op (`add`/`merge`/`rm`/`split`/`move`/`describe`, via `--reason`/`--note`; `vote` takes neither); it lives in the log, never in a lesson;
- an **error class** when the call exited non-zero — one terse token from a fixed, small enum so a high-error-rate anomaly can be split by cause (see [below](#diagnosing-errors-by-class)). A successful call leaves it blank.
- a **crash-recovery** count when the call cleaned up after a *previous* `nb` that died mid-write — `<lock-steals>:<temp-reaps>`, the stale `.nb.lock`s it stole and leftover `*.tmp` files it reaped while acquiring the lock. Blank in the common case; `nb stats` sums it window-wide into the `crashRecovery` readout so "are my agents crashing mid-write?" is answerable.
- a **batch-vote miss count** when a batch `vote` (`nb vote <shelf> id1,id2,id3 +1`) landed at least one id but some ids did not resolve — the number of stale ids skipped. That call still exits `0` (a success), so its misses would otherwise be invisible to the error-rate table; recording the count lets `nb stats` fold them into the `vote` error causes as `no_match`, so stale-selector misses inside a partly-successful batch are no longer laundered out of the "voting on ids that no longer exist" signal. Blank in the common no-miss case.

This is richer *logging* only — the notebook file and the one-line lesson are untouched (it adds no field to an entry). Rows written by an older `nb`, before a column existed, are still read correctly; the missing columns are simply blank. Logging stays best-effort: a logging failure never fails a real `nb` operation, and the ring stays bounded by `NB_USAGE_RING`.

The log can hold search query text and the `NB_SESSION` value. `src/usage.ts` writes it and `src/stats.ts` reads it back; a review of what the package records should read both, with `src/notebook.ts`.

## Machine-readable `nb stats`

The *usage ring* below is the usage log just described: it keeps the last `NB_USAGE_RING` rows (default 5000), and `nb stats` reads it.

`nb stats --json` prints the raw `StatsReport` to stdout as a single JSON object instead of the human table, so a supervising agent can act on a `loop` / `went-silent` / `high-error-rate` anomaly without regex-parsing formatted text. The README's [Machine-readable `nb stats`](https://github.com/jeanibarz/agent-notebook/blob/main/README.md#machine-readable-nb-stats) section lists the top-level keys; a test keeps that list equal to what `nb stats --json` really prints. It is a stable contract that grows additively.

- **`schemaVersion`** is an integer (currently `1`, exported as `STATS_SCHEMA_VERSION`) that lets a consumer detect a breaking wire-format change cheaply. It goes up by exactly 1 on any **breaking** change — removing or renaming a field, changing a field's type or meaning, or changing an array's ordering that a consumer relies on — and does **not** change for a purely **additive** one, such as adding a field or a new `anomalies`/`signals` kind.
- **`generatedAt`** and **`windowStart`** are the window's absolute bounds as ISO-8601 instants (e.g. `"2026-05-01T12:00:00.000Z"`): `generatedAt` is the report's `now` (the instant it was generated) and `windowStart` is when the window opens (`generatedAt` minus `window`) — so a consumer can anchor the window to wall-clock time without re-deriving it from `window` and its own clock.
- **`errorCauses`** is the per-command error-cause breakdown, dominant-first and only for commands with a handful of errors in the window: each entry is `{ command, errors, breakdown: [{ cause, pct }] }`, where `cause` is an `errorClass` token (e.g. `add`'s `too_long`, `vote`'s `no_match`/`ambiguous_selector`) — or `unclassified` when the log predates the error-class column, a cue to upgrade `nb`. It surfaces the two most actionable rates (over-cap `add`s and `vote` selector misses) in the header instead of leaving them buried behind the high-error-rate anomaly threshold. For `vote`, `errors` and the `no_match` share also fold in batch-vote **partial** misses — stale ids skipped by a batch that still landed at least one vote and so exited `0` — so these do not quietly escape the readout; the per-command error *rate* still counts only whole failed calls, so a partly-successful batch stays a success there.
- **`activity`** is the per-day ops count (see [Activity sparkline](#activity-sparkline)).
- **`notebooks`** is the per-shelf inventory — `{ shelf, role, lines, cap, adds, addsPerDay, retentionDays }` for each shelf's notebook (`role` is a deprecated copy of `shelf`), where `lines` is the stored-lesson count, `cap` is `maxLines()`, `adds` is the accepted adds in the window, `addsPerDay` their rate per day the log covers, and `retentionDays` the `cap ÷ addsPerDay` estimate of how long an unvoted lesson lasts on a full shelf (`null` when the shelf is below its cap, took no adds, or the log is too short to estimate; see [How long a lesson stays](#how-long-a-lesson-stays)) — so a supervisor can see that a shelf is at (or near) its cap and about to evict a lesson; **`notebookTotals`** aggregates it as `{ shelves, roles, lines, cap }` (`roles` is a deprecated copy of `shelves`). The inventory is the current on-disk state, not a slice of the usage window.
- **`skipped`** lists any shelf the inventory could not read — the same `{ shelf, code }` skip `nb list`/`nb search` report, also printed as one stderr line — so a damaged store still yields a full health report instead of aborting.
- **`conflicts`** lists any shelf whose file holds an unresolved git merge-conflict marker (`{ shelf, marker }`), also printed as one stderr line: the shelf is still counted, but a mutation will refuse it until the conflict is resolved (see [Diagnosing errors by class](#diagnosing-errors-by-class)).
- **`usageRing`** is how full the usage ring is: `{ rows, cap }`, where `rows` is the total row count on disk and `cap` is `usageRing()` (the `NB_USAGE_RING` bound). Read it to see that the log is about to drop its oldest history, as the `notebooks` cap tells you a shelf is about to evict. It counts the whole ring, whatever `--since` is (unlike `totalCalls`). When the ring is full and its oldest row is newer than the `--since` window start, `usageRing` also carries `oldest` (ISO timestamp) and `coversWindow: false`, and the text report adds one line saying how far back the log reaches. The per-day add rates and retention estimates then divide by that span instead of the window, never less than one day (or the window, if shorter); below that the rate is a lower bound and retention is `null`. Otherwise it is exactly `{ rows, cap }`.
- **`crashRecovery`** counts clean-ups after a crashed `nb`: `{ lockSteals, tempReaps }`. Read it to learn whether agents die mid-write and may be losing updates. `lockSteals` is how many abandoned `.nb.lock` files a mutation took over (a prior `nb` crashed while holding the lock); `tempReaps` is how many leftover `*.md.<pid>.tmp` / `.nb-usage.log.<pid>.tmp` files it removed (a prior `nb` crashed mid-write). It is summed from the usage log's `recovered` column. Like `usageRing` it covers the whole deployment: a `[<shelf>]` scope narrows the rest of the report but not this, since the lock and the temp files are shared by every shelf; only the window applies. A clean deployment reports `{ 0, 0 }`, shown rather than omitted so "measured, healthy" never reads as "not measured".

`--json` composes with `[<shelf>]` and `--since`; a bad `--since` window still warns on stderr (stdout stays pure JSON) and falls back to 7d.

## Diagnosing errors by class

Every non-zero `nb` call records a terse **error class** so a `high-error-rate` anomaly becomes *actionable* instead of a dead-end flag. The classes are a fixed, small enum — a code-chosen token, never free text, user input, a lesson, or any PII, consistent with the log's terse TSV contract:

| class | meaning |
|---|---|
| `too_long` | a lesson / description / merge / split result over the char cap was rejected |
| `ambiguous_selector` | a selector matched more than one entry — pick the one you mean by its id |
| `no_match` | a selector matched no entry (or the shelf/notebook to act on was empty) |
| `multiline_refused` | `nb add … -` was piped more than one line (one entry = one line) |
| `bad_args` | a missing / malformed argument or flag, or an invalid shelf name |
| `corrupt` | a mutation refused because the shelf holds an unresolved git merge-conflict marker |
| `unknown_subcommand` | an unknown `nb` command (commonly an agent guessing a name, e.g. `nb upvote`) |
| `other` | anything not yet classified — the escape hatch and the growth thermostat |

With this, `nb stats` breaks a `high-error-rate` anomaly down by class, naming the single likely cause so the operator has a lever. **Illustrative:**

```
[high-error-rate] add: 41% errors over 250 calls — too_long 78%, bad_args 14%, other 8%
```

Percentages are of the command's error total, rounded (so they need not sum to exactly 100%), most-common first. Rows written by an older `nb`, before the error class was recorded, carry no class and are bucketed as `unclassified` (kept distinct from a genuine `other`, so a freshly-upgraded window reads honestly rather than as a misleading "other 100%"). One exception: an over-length `add` from before error classes still recorded its `too-long` outcome, so it is counted as `too_long` — the same rule the `error causes:` block uses, so the two lines give the same split for the same error rows.

If a git-versioned notebook hits an unresolved `git merge`/`pull` conflict, its `<<<<<<<`, `=======` and `>>>>>>>` marker lines stay in `<shelf>.md` until you resolve them. `nb` recognizes those shapes: `show`, `list`, `search` and `stale` still read the shelf (printing a one-line stderr warning naming the shelf and marker) so nothing is silently dropped, but **every mutation** (`add`, `vote`, `merge`, `split`, `rm`, `move`, `describe`) refuses with exit 1 and a `corrupt` error, leaving the file byte-identical — so a stray write can never bake the markers in as lessons. Resolve the conflict in `<shelf>.md` (keep the lines you want, delete the three marker lines, then `git add` the file and finish the merge), and `nb` reads and writes it normally again.

## Tuning `nb stats`

The anomaly detection in `nb stats` (loop / went-silent / high-error-rate flags) is tunable via env vars — out-of-range values are clamped to the stated bounds, and an unset or unparseable value falls back to the default:

- `NB_USAGE_RING` — how many recent calls are kept for `nb stats` to analyze (default `5000`, range `100`–`100000`).
- `NB_LOOP_N` — a loop is this many or more calls of the same command on the same shelf and, when the call logs a session, the same session (default `10`, range `2`–`1000`).
- `NB_LOOP_WINDOW_S` — window those calls must fall within, in seconds (default `120`, range `5`–`86400`).
- `NB_SILENT_H` — hours since a command's last call before it is flagged went-silent (default `48`, range `1`–`8760`).
- `NB_ERR_MIN` — minimum calls before a command's error rate is judged (default `5`, range `1`–`10000`).
- `NB_ADD_BURST_N` — a session that accepts more than this many adds into one shelf raises an `add-burst` signal (default `15`, range `1`–`100000`).
- `NB_ERR_RATE` — fraction of a command's calls that failed, at or above which it is flagged (default `0.3` = 30%, range `0`–`1`).
- `NB_COVERAGE_HI` — coverage at/above which the surfacing readout reads novel-adds as HIGH (default `0.5`, range `0`–`1`).
- `NB_RECALL_MISS_HI` — recall-miss at/above which the surfacing readout reads dedup-blocks as HIGH (default `0.2`, range `0`–`1`).
- `NB_NEAR_DUP` — trigram-Jaccard similarity at/above which an accepted `nb add` also prints a non-blocking merge suggestion (default `0.5`, range `0`–`1`; `0` disables the advisory).

## Other environment variables

A few more env vars tune rendering and concurrency rather than `nb stats`. Like the knobs above, the lock timings are clamped to their stated bounds, and an unset or unparseable value falls back to the default:

- `NB_ASCII` — force the [activity sparkline](#activity-sparkline)'s glyph ramp to ASCII digits instead of the Unicode blocks, for accessibility or a non-UTF-8 terminal. Any **truthy** value forces ASCII; any **falsey** one (`''`, `0`, `false`, `no`, `off`) forces Unicode; both override locale autodetection. **Unset**, the effective locale (`LC_ALL` → `LC_CTYPE` → `LANG`, first set wins) decides — a locale that is set but does not name UTF-8 (e.g. `C`, `POSIX`) selects ASCII, while an unset or UTF-8 locale keeps the Unicode default.
- `NB_ENABLED` — switch the agent-facing loop (the example hooks and the text `nb list` index) off (`0`, `false`, `no`, `off`) or on (any other non-blank value) for one process, over any `git config nb.enabled` setting. Unset or blank, git config decides, and the default is on. See [Per-repository on/off](harness-setup.md#per-repository-onoff).
- `NB_STALE_LOCK_MS` — milliseconds a `.nb.lock` may go untouched before it is treated as abandoned by a crashed `nb` process and stolen, so a crash can't wedge the notebook (default `10000`, range `100`–`600000`).
- `NB_LOCK_GRACE_MS` — extra time, past the stale threshold, a caller waits to notice and steal an abandoned lock before giving up with `notebook is locked`; the acquire budget is derived as `NB_STALE_LOCK_MS + NB_LOCK_GRACE_MS`, never set independently (default `2000`, range `0`–`600000`).

`NB_DIR`, `NB_MAX_LINES` and `NB_MAX_CHARS` are covered in [Where the files live](cli-reference.md#where-the-files-live--nb-path), and the README has a [table of every variable](https://github.com/jeanibarz/agent-notebook/blob/main/README.md#configuration).

A notebooks folder can also fix its own line length. Put `{ "maxChars": 400 }` in `<notebooks folder>/.nb.json` and every `nb` command run on that folder, however it is reached, uses 400 (clamped to 20–2000) instead of `NB_MAX_CHARS`; `nb config` then shows `(.nb.json)` as the source. It is the only key. A missing file changes nothing; an unreadable or invalid file, or a non-object, prints one `warning:` line on stderr and is ignored; unknown keys are named in that warning and skipped, and a valid `maxChars` beside them still applies. Only the `nb` CLI and the git wrapper read it; a program that imports the library keeps using `NB_MAX_CHARS`. An `nb` older than this feature ignores the file.

## Inspecting the effective configuration — `nb config`

Every knob above is read at call time and *clamped* to its range, so the value `nb` actually runs under is not always the one you exported — an out-of-range or non-numeric value is silently corrected to a bound or the default. Rather than re-derive that by hand from the env var, its default, and its clamp, ask `nb` for the effective (post-clamp) values. With no `NB_*` tunable set, the numeric part reads:

```sh
$ nb config
maxLines=50         (default)
maxChars=200        (default)
nearThreshold=0.5   (default)
usageRing=5000      (default)
usageRingSlack=312  (derived from usageRing)
staleLockMs=10000   (default)
lockGraceMs=2000    (default)
loopN=10            (default)
loopWindowSec=120   (default)
silentHours=48      (default)
errMin=5            (default)
addBurstN=15        (default)
errRate=0.3         (default)
coverageHi=0.5      (default)
recallMissHi=0.2    (default)
```

After the numeric knobs, `nb config` prints the string variables (`NB_DIR`, `NB_SESSION`, `NB_ASCII`) and then one `enabled=on` or `enabled=off` line naming what decided it, e.g. `enabled=off  (git config nb.enabled=false, file:.git/config)` (see [Per-repository on/off](harness-setup.md#per-repository-onoff)).

Each line is one effective tunable as `name=value`, read from the same getter the hot path uses — so what `nb config` prints is exactly what the caps, the near-dup advisory, the lock timings, and the `nb stats` anomaly/readout thresholds run with. The tag names the source: `(default)` when the env var is unset, `(env NB_*)` when it is set (the printed value is still the post-clamp effective one, so a value you set out of range shows up corrected), `(.nb.json)` when the notebooks folder's settings file sets `maxChars` (it wins over `NB_MAX_CHARS`), or `(derived …)` for a value computed from another (`usageRingSlack`).

A set env var is further annotated with how its value was actually resolved, so a setting that was silently rewritten or thrown away can never read as if it were in force:

- `(env NB_MAX_LINES)` — **honored**: the value you set is in force.
- `(env NB_NEAR_DUP: clamped to 1 from 2)` — **clamped**: you set a value outside the range, and `nb` used the nearest bound (the raw value you exported is quoted).
- `(env NB_MAX_LINES: ignored "abc", not an integer; using default)` — **ignored**: the value was unparseable, so `nb` used the built-in default. Integer knobs must be a whole integer: a partially-numeric value like `1e3` or `12.9` is ignored (not silently truncated to `1`/`12`).

Output with no problems is byte-identical to the pre-annotation form, apart from the `enabled=` line. Any `NB_*` variable that `nb` does not read (e.g. a typo like `NB_MAX_LINE`) is listed at the end as `not read by nb`, with a `did you mean …?` hint when a real variable is close. This is **informational only** — other tools may legitimately set `NB_*` variables, so it is never an error and the exit code stays `0`. The knobs `NB_BIN`, `NB_GIT_AUTOCOMMIT`, `NB_GIT_SESSION_TRAILER`, `NB_BACKUP_PUSH_TIMEOUT` and `NB_BACKUP_GIT_LOCK_WAIT`, read by the tooling this repo ships under [`examples/`](../examples/README.md), are not listed: they belong to those tools, not to `nb`. `nb retro` reads `NB_RETRO_EXTRA_PROMPT`, `NB_RETRO_TTL_DAYS` and `NB_PROJECT_SLUG`, and `nb brief` reads `NB_PROJECT_SLUG` and `NB_GLOBAL_SHELF` (issue #538), so those are not listed either; they get no line of their own.

`nb config --json` emits one object keyed by tunable name — `{ "maxLines": { "value": 50, "source": "default", "env": "NB_MAX_LINES", "status": null, "rawValue": null }, … }` — for a supervisor to read without parsing the lines. `status` is `"honored"`/`"clamped"`/`"ignored"` when the var is set (`null` when it is unset or for the derived row), and `rawValue` is the raw env string (`null` when unset). When `.nb.json` sets `maxChars`, that row's `source` is `".nb.json"`, and its `status` and `rawValue` describe the number in the file. An `unrecognized` array — `[{ "name": "NB_MAX_LINE", "suggestion": "NB_MAX_LINES" }, …]` — lists the same unknown variables, and an `enabled` object — `{ "value": "on", "source": "default", "origin": null, "warning": null }` — gives the per-repository state (`source` is `env`, `git` or `default`). All three are **additive**: the existing `{ value, source, env }` fields and the `source` values (`env`/`default`/`derived`) are unchanged; `.nb.json` is an added value. It is read-only, and scoped to *configuration* (the knobs), distinct from `nb stats` (usage, anomalies, engagement).
