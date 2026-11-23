# Evidence pack: notebook kinds RFC

Facts only, no opinions. Pointers are `file:line` in worktree `agent-notebook-rfc-kinds` (HEAD 6ec5155, package version 0.11.1, package.json:3) unless prefixed `IDEAS:` (= branch `docs/ideas-store-use-case`, PR #529) or `gh:` (GitHub CLI output).

## 1. Config today

**NB_DIR resolution.** `notebooksDir()` (src/notebook.ts:328-332): if `process.env.NB_DIR` is set and `.trim() !== ''` -> `expandHomeDir(NB_DIR)`, else `join(homedir(), '.agent-notebook', 'notebooks')`. Read live at every call (no cache).
- `expandHomeDir` (src/notebook.ts:320-325): `~` -> homedir; `~/x` -> homedir/x; `~\x` only on win32; `~user/x` untouched. Rationale in comment :312-319 (issue #334: settings.json/systemd/cron never pass through a shell).
- Tilde is re-implemented separately in examples/hooks/claude-code/nb-retrospective.sh:35-38, examples/nb-janitor.mjs:81-83, IDEAS:examples/ideas/nb-ideas.mjs:112-116 and IDEAS:examples/hooks/claude-code/nb-ideas-stop.sh:34-37 (test: src/examples-nb-dir-tilde.test.ts).
- `nb path` prints NB_DIR; `nb path <shelf>` prints `<NB_DIR>/<shelf>.md`; `--usage` prints the log path (docs/requirements.md:497-500, FR-PATH-001).
- NFR-SAFE-001 (docs/requirements.md:1592-1594): no operation writes/reads/deletes outside NB_DIR.

**Numeric tunables** (declared once as `IntTunable`/`RateTunable`, src/notebook.ts:28-64; resolved by `resolveIntTunable` :67 / `resolveRateTunable` :70, which call `resolveIntEnv` :200 / `resolveRateEnv` :220). Int: whole integer only (`/^[+-]?\d+$/` after trim, :206), else "ignored" -> default; out of range -> clamped (`status` honored/clamped/ignored). Rate: `Number(raw)`, non-finite -> default, clamped to [0,1] (`''` -> 0, honored/clamped).

| Env var | Config name (src/config-report.ts:108-123) | Default | Clamp | Declared | Getter |
|---|---|---|---|---|---|
| NB_MAX_LINES | maxLines | 50 | 1..5000 | notebook.ts:47 | `maxLines()` :75 |
| NB_MAX_CHARS | maxChars | 200 | 20..2000 | :48 | `maxChars()` :78 |
| NB_NEAR_DUP | nearThreshold | 0.5 | 0..1 (0 disables) | :49 | `nearThreshold()` :90 |
| NB_USAGE_RING | usageRing | 5000 | 100..100000 | :50 | `usageRing()` |
| NB_STALE_LOCK_MS | staleLockMs | 10000 | 100..600000 | :51 | |
| NB_LOCK_GRACE_MS | lockGraceMs | 2000 | 0..600000 | :52 | |
| NB_LOOP_N | loopN | 10 | 2..1000 | :53 | |
| NB_LOOP_WINDOW_S | loopWindowSec | 120 | 5..86400 | :54 | |
| NB_SILENT_H | silentHours | 48 | 1..8760 | :55 | |
| NB_ERR_MIN | errMin | 5 | 1..10000 | :56 | |
| NB_ADD_BURST_N | addBurstN | 15 | 1..100000 | :57 | |
| NB_ERR_RATE | errRate | 0.3 | 0..1 | :58 | |
| NB_COVERAGE_HI | coverageHi | 0.5 | 0..1 | :63 | |
| NB_RECALL_MISS_HI | recallMissHi | 0.2 | 0..1 | :64 | |

- Derived row `usageRingSlack` = `max(16, floor(usageRing/16))`, no env var (src/notebook.ts:108-110; spliced at index 4 in config-report.ts:149).
- String vars reported by `nb config`: NB_DIR, NB_SESSION (`process.env.NB_SESSION ?? ''`), NB_ASCII (`asciiMode()`) (config-report.ts:179-185). Source tag is `(env)` when the var is `!== undefined`, else `(default)` (config-report.ts:275-277).
- `NB_ENABLED` is recognised separately (config-report.ts:196, comment :195); parsed in src/enabled.ts:52-57.
- Documented list (19 rows) in docs/requirements.md:1656-1680 (section 7).
- Ignored-var detection: any `NB_*` not in registry + string vars + NB_ENABLED + `SHIPPED_TOOL_ENV_VARS` (NB_BIN, NB_RETRO_TTL_DAYS, NB_GIT_AUTOCOMMIT, NB_GIT_SESSION_TRAILER, NB_BACKUP_PUSH_TIMEOUT, NB_BACKUP_GIT_LOCK_WAIT; config-report.ts:208-215) is listed "(not read by nb [- did you mean X?])" (renderConfig; unknownEnvVars :242-257). Informational only, exit code untouched.
- Env vars read by shipped example tools but not `nb`: NB_PROJECT_SLUG, NB_GLOBAL_SHELF (examples/hooks/claude-code/nb-session-start.sh:13,58,114,70), NB_BIN (:21).

**Anything read from a file in NB_DIR?** Non-shelf reads in `src/` (grep `readFileSync`): shelf files (notebook.ts:1038, doctor.ts:86), lock owner file (notebook.ts:607), usage log and its count sidecar (usage.ts:302,417,459). No config file, no `.nb-*rc`, no JSON/YAML/TOML read anywhere in src. Dotfiles that exist in NB_DIR: `.nb-usage.log` (notebook.ts:369-371), `.nb-usage.log.count` (usage.ts:295 `usageCountFile`), `.nb.lock` (notebook.ts:732), `.nb-usage.log.<pid>.tmp`/`<shelf>.md.<pid>.tmp` (notebook.ts:893-931), hook sentinels `.retro-<session>` (nb-retrospective.sh:90), `.nb-git.lock`, `.nb-backup.*` (examples/nb-git-wrapper.mjs:78,210). The only per-notebook metadata is the leading `# key: value` block inside a shelf file: `META_RE` (notebook.ts:524 `/^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/`), one key used (`desc`, notebook.ts:1847), unknown keys round-trip verbatim (notebook.ts:~540-560 comment; NG-004 cited). Described in docs/requirements.md:1331 (section 4.13).

**`nb config` prints** (src/cli.ts:1494-1545; renderer config-report.ts:313-353): (1) one `name=value  (source)` line per numeric row (15 rows incl. derived), padded; (2) blank line, then `NB_DIR=...`, `NB_SESSION=...`, `NB_ASCII=on|off` each tagged `(env)`/`(default)`; (3) `enabled=on|off  (<why>)` (config-report.ts:338); (4) unrecognized `NB_*` block. `--json`: object keyed by tunable name `{value, source, env, status, rawValue}` + `environment`, `enabled {value, source, origin, warning}`, `unrecognized[]` (cli.ts:1520-1541). Spec: FR-CONFIG-001 (docs/requirements.md:802), FR-CONFIG-002 (:839), FR-ENABLED-002 (:1528).

**Per-folder today?** Yes, in one form only: `nb enabled` resolves `NB_ENABLED` env, then `git config --type=bool --show-origin --get nb.enabled` run in the cwd, then default on (src/enabled.ts:92-127; spawn :73-79). It gates hooks and the text form of `nb list`, not data commands (docs/requirements.md:1496-1502, 1558). Nothing else varies by directory: NB_DIR, caps and thresholds are process-global env. Per-"kind" separation is done today by pointing NB_DIR (and NB_MAX_CHARS/NB_MAX_LINES) at a different folder per process: IDEAS:examples/ideas/nb-ideas.mjs:224-226 `childEnv` = `{...process.env, NB_DIR, NB_MAX_CHARS, NB_MAX_LINES}`.

## 2. CLI dispatch (src/cli.ts)

- Entry: `runNbCli(argv)` :730; `const cmd = (argv[0] ?? '').trim()` :734. The FIRST token is always the command; shelf is the SECOND token (`args[1]`) for every shelf command (e.g. :978, :1054, :1115). Main guard :1997-2014 (`process.argv.slice(2)`); exit settled by `settleCliExit` :1903.
- Pre-switch branches: `''`/`--help`/`-h`/`help`/scoped help (`<cmd> --help|-h`, `nb help <cmd>`) -> print HELP, log usage row `help`, exit 0 (:751-757; `helpRequest` :699); `--version`/`-v`/`version` -> exit 0 (:758-764). Usage row appended for both (comment :736-750).
- `KNOWN_COMMANDS` (:354-358), 22 names: `show stale add vote merge split rm move describe search stats doctor path config enabled completion list ls shelves roles help version`. Switch cases (:845-1628): show, stale, add, vote, merge, split, rm, move, describe, search, stats, doctor, path, config, enabled, list/ls/shelves/roles, completion; `help`/`version` handled before the switch. `MUTATING_COMMANDS` (:369) = add vote merge rm split move describe. `SHELF_FIRST_COMMANDS` (:376) = show stale add vote merge split rm describe stats path.
- Global flags: `--` terminator is honored only when at least one token follows it (:786-788: `termIdx = argv.findIndex((a,i) => a==='--' && i < argv.length-1)`); `head` = pre-`--` tokens, `operands` = post-`--` literals appended after flag parsing (:789-790, :833). `--json` stripped from `head` anywhere before `--` (:797-798). `--reason`/`--note` extracted only for commands whose `KNOWN_FLAGS` row lists `--reason` (:820-826); a repeated flag -> bad_args (:824). A trailing bare `--` stays a literal operand (vote downvote alias, `parseDelta` :339-343).
- `KNOWN_FLAGS` (:561-582; `--json` implicitly accepted everywhere, :610-613): show []; stale [--limit]; add/merge/split/rm/move/describe [--reason --note]; vote []; search [--any --limit]; stats [--exit-code --since]; doctor [--exit-code]; path [--usage]; config []; enabled [--why]; list/ls/shelves/roles [--limit]; completion []. `VALUE_FLAGS` = --reason --note --limit --since (:592). Unknown long option -> `bad_args`, exit 1, with nearest-option hint (`assertKnownFlags` :606-628). Operand caps `MAX_ARGS` (:637-645): add 3, merge 5, split 5, rm 3, vote 4, move 4, describe 3; search 3 (`SEARCH_MAX_ARGS`); extra operand -> bad_args "quote multi-word text".
- Unknown command (`default:` :1639-1662): `closestCommand(cmd)` (:516; `closestMatch` in src/suggest.ts) -> message `unknown command "X". Did you mean \`Y\`? Try \`nb --help\`.` on stderr as `nb: ...`; `meta.errorClass='unknown_subcommand'`; under `--json` stdout gets `{ok:false, command, error:{class:'unknown_subcommand', message}}`; returns exit 2 (:1662). Flag validation never masks it (comment :554-558).
- Collision facts: (a) a leading token that equals any of the 22 command names, or `-h/--help/-v/--version`, is taken as that command. (b) `nb <anything-else>` is exit 2 today; there is no "shelf as first token" form. (c) Shelf names are not checked against command names: `SAFE_SHELF` (notebook.ts:235) admits `show`, `list`, `add`, etc. as shelf names, and `assertSafeShelf` only reserves `readme` and Windows device names (notebook.ts:253-291). (d) `list`/`search` take a free `[prefix]` operand matched against shelf names (cli.ts:161,168; FR-LIST-002 docs/requirements.md:529). (e) the did-you-mean candidate set is `KNOWN_COMMANDS`; shelf typos use `closestShelf` (src/suggest.ts:80) via `requireExistingShelf` (cli.ts:537-546).
- Shell completion is generated from `KNOWN_COMMANDS` and enumerates shelves via `NB_ENABLED=1 nb list --limit N` (cli.ts:393, 443, 490).

## 3. Add / vote / rm / merge / split / move

**addEntry** (src/notebook.ts:1326-1399), under `withLock` (:730):
1. `sanitizeLesson` (:432); `assertSafeShelf`; `assertNoCaseVariant`; read shelf; refuse if conflict markers (`assertNotConflicted`).
2. Empty text -> `{added:false, reason:'empty'}`, exit 0 (CLI: "skipped (empty lesson)", cli.ts:1018).
3. `text.length > maxChars()` -> `reason:'too-long'` with `length`, `overflow`; nothing stored, never truncated (:1337-1344). CLI: human path throws (exit 1, cli.ts:1019, class `too_long`), `--json` path prints the result then returns 1 (cli.ts:1016).
4. Exact duplicate: `dedupKey(text)` (:473-478: lowercase, every char outside `a-z0-9\s` -> space, collapse whitespace) equal to any entry's key -> `reason:'duplicate'`, `collidedId`, nothing written, exit 0 (:1345-1349; cli.ts:1017). Entry id = `sha1(dedupKey).slice(0,6)` (`entryId` :1416; DP-4).
5. Near-dup advisory: `similarity` = char-trigram Jaccard of dedupKeys (:490-); if `nearThreshold() > 0`, best entry with `s >= thr` (first in storage order on ties) is attached as `nearId`/`nearText` (:1359-1372). Never blocks (NG-001, docs/requirements.md:1616-1623; FR-ADD-008 :282). CLI prints a stderr note suggesting `nb merge` (cli.ts:1036-1043); logged in `collided` column with outcome `accepted` (cli.ts:1005).
6. New entry `{score:1}` pushed to end; `enforceCap(entries, 1)` (:1383; def :1215-1262): if over `maxLines()`, evict worst-first (non-protected, then lowest score, then stalest index), then dock the stalest surviving non-newcomer by -1 and move it to the end (issue #437). Returns `evicted`/`evictedAll`/`decayed`. New shelf -> `created:true` and up to 3 `similarShelves` sharing >=2 name words split on `-`/`.` (`overlappingShelves` :1315-1323); CLI stderr note (`writeCreatedNote` cli.ts:719-727, call :1049).
- Note: DP-1 text says "no decay curve ... scheduler" (docs/requirements.md:64-66) and NG-005 says "SHALL NOT age, decay" (:1642-1643), while the code docks (`enforceCap`, notebook.ts:1215) and DP-3 / FR-ADD-006 (docs/requirements.md:80-95, :251) describe the dock.
- Outcome tokens logged for add: `accepted`, `dedup-blocked`, `empty`, `too-long` (cli.ts:994).

**vote** (src/notebook.ts:1490; CLI cli.ts:1053-1112): `nb vote <shelf> <id|query> +1|-1`. `KNOWN_FLAGS.vote = []` (cli.ts:565) so `--reason`/`--note` are rejected as unknown options; the retrospective hook text says "(vote takes no --reason)" (nb-retrospective.sh:173). `parseDelta` accepts `+1 1 ++` and `-1 --` (cli.ts:339-343). Batch form: comma list of >=2 bare hex ids -> `voteMany` (cli.ts:1068; `parseVoteIdList` :1742); partial misses recorded in `misses` column and still exit 0; all-miss exit 1 with errorClass `no_match` and blank outcome (cli.ts:1085-1092). Shelf must exist (`requireExistingShelf`, issue #200). A vote moves the entry to the end of the file (DP-3). Row: `entries=[id]`, `outcome=up|down` (cli.ts:1097, 1108-1109).

**rm** (cli.ts:1175-1187; notebook.ts:1716): `--reason` enum `wrong|obsolete|other`, `--note` free text, both log-only (usage.ts:111-116 `REASON_ENUMS`; unknown code -> `other` with original code prefixed in note, usage.ts:126-141 `normalizeReason`). Outcome `removed`.
**merge** (cli.ts:1114; notebook.ts:1608): reason enum `duplicate|other`; outcome `merged`; entries = both sources + result id; absorbs an identical third entry (issue #454).
**split** (cli.ts:1146; notebook.ts:1663): reason enum `overloaded|other`; outcome `split`; entries = source + two ids.
**move** (cli.ts:1188-1227; notebook.ts:1779): `nb move <from> <to> <id|query>`; reason enum `consolidate|other`; outcome `moved` or `move-blocked` (target already holds a near-duplicate); logged under the SOURCE shelf; target auto-created with the created-note. Source existence guarded, target not.
**add / describe** take free-text `--note`, and a stray `--reason` is bucketed `other` (cli.ts:1007-1011; no `add` seed enum, usage.ts:128-129 comment).
- `add`, `merge`, `split`, `move` record eviction/decay columns via `recordEvictionUsage` (cli.ts:1712; calls :1006, :1122, :1157, :1204).
- JSON: `add/vote/rm/merge/split/move --json` print the library result object; failures print `{ok:false, command, error:{class, message}}` (cli.ts:1676-1692).

**Exit codes.** 0 success (cli.ts:1665-1666), including exact-duplicate and empty adds and `list/show` of nothing; 1 handled error (`NbError`/any throw; `bad_args`, `no_match`, `ambiguous_selector`, `too_long`, `corrupt`, ... `ERROR_CLASSES` notebook.ts:2454-2463) (cli.ts:1695) and `add --json` too-long (:1016) and all-miss batch vote (:1091); 2 unknown command (:1662); 3 only with opt-in gates: `nb stats --exit-code` when anomalies present (:1436; FR-CLI-002 docs/requirements.md:675, help cli.ts:291-293) and `nb doctor --exit-code` when findings exist (:1448). Unhandled promise rejection -> `process.exitCode = 1` (cli.ts:1906-1912).

## 4. Usage log

- File: `<NB_DIR>/.nb-usage.log` (`usageFile`, src/notebook.ts:369-371); written by `logUsage` (src/usage.ts:330-451, once per call in the `finally`, cli.ts:1698) and by the help/version branches (cli.ts:754, 761). Failures are swallowed (usage.ts:~450 empty `catch`).
- Row = tab-separated, 16 columns in this order (usage.ts:383-385 writer; 455-495 `parseUsage` positional parse): `ts` (ISO 8601), `shelf` (only if it passes `assertSafeShelf`, else `-`; usage.ts:162-169), `command`, `status` (`ok`|`err`), `<ms>ms`, `session`, `entries` (comma ids), `outcome`, `collided`, `evicted` (`<id>:<score>[,...][,+N]`), `reason`, `note`, `errorClass`, `decayed` (`<id>:<postDockScore>`), `recovered` (`<lockSteals>:<tempReaps>`), `misses`. Older rows end earlier; missing trailing columns default blank/0 (usage.ts:458-462). Type: `UsageRow` usage.ts:25-48 (field `role` holds the shelf).
- Ring: `NB_USAGE_RING` default 5000 (100..100000). Append fast path until `rows >= ring + usageRingSlack()` (usage.ts:386-387), then compaction keeps the last `ring` rows via tmp+rename (usage.ts:420-449). Row-count sidecar `.nb-usage.log.count` = `rows\tbytes` (usage.ts:295-327).
- Per-column caps: `note`, `session` and `command` -> `capNote` truncates to `maxChars()` (NB_MAX_CHARS, default 200) with trailing `...` (usage.ts:187-192; used :356,:384); `entries` -> `capEntries` keeps whole ids that fit in `maxChars()` and drops the rest silently (usage.ts:219-232); `evicted` -> `formatEvictedUsage` budget `maxChars()` with `+N` overflow marker (usage.ts:255-277). All fields tab/CR/LF-sanitised (`sanitizeUsageField`, usage.ts:149). `shelf` is syntactically validated (usage.ts:162-169), not capped beyond the 128-char shelf rule.
- `NB_SESSION`: read at log time, `meta.session ?? process.env.NB_SESSION ?? ''` (usage.ts:356). `nb` never generates one; blank when unset. Session-aware stats (browse-without-use, vote-reversal, failed-search, add-burst) skip blank-session rows (docs/operating.md:40; FR-USAGE-002 docs/requirements.md:952-960). The shipped Stop hook uses the hook payload `session_id`, not NB_SESSION, for its sentinel (nb-retrospective.sh:87).
- Vote row: `command=vote`, `shelf`, `entries` = voted id(s), `outcome=up|down`, `ok`; `reason`, `note` columns are blank because `vote` never calls `recordReasonUsage` and rejects `--reason/--note` (cli.ts:565, 1107-1111). The reason/note columns exist (usage.ts:44-47) and are filled for add/merge/split/rm/move/describe (cli.ts:1011, 1126, 1157, 1181, 1209-1210).
- Readers: `nb stats` via `parseUsage` (src/stats.ts:30, 907); vote rows keyed on `command==='vote'` and `outcome up|down` (stats.ts:670, 728, 770, 881, 1108-1116). `examples/nb-janitor.mjs:238-262` has its own parser of the same file (reads ts, shelf, command, status, session, entries, outcome, evicted by position; skips collided/reason/note) and mirrors NB_MAX_LINES/NB_USAGE_RING clamps (:98, :105). `examples/nb-git-wrapper.mjs:78` gitignores `.nb-usage.log*`.
- Spec: FR-USAGE-001..003 (docs/requirements.md:928, 952, 1003); NG-004 allows richer log columns but no extra lesson fields (:1636-1640).

## 5. Shelf name rules

- `SAFE_SHELF = /^[A-Za-z0-9](?:[A-Za-z0-9._@-]*[A-Za-z0-9])?$/` (src/notebook.ts:235); `MAX_SHELF_LEN = 128` (:243). `assertSafeShelf` (:272-294) rejects in order: length > 128; regex miss or contains `..`; `readme` (case-insensitive, `RESERVED_SHELVES` :253); Windows device basenames (`WINDOWS_RESERVED_DEVICE` :270, segment before first `.`). All throw `bad_args`. `isValidShelfName` is the non-throwing form (:299).
- `@` and `.` are allowed in interior positions only (first and last char must be alphanumeric). `.` is the namespace separator by convention (FR-NAMESPACE-001, docs/requirements.md:536-559: one level at most; `@` reserved for `shelf@project`); `overlappingShelves` splits words on `-` and `.` (notebook.ts:1305-1307). `@`-suffix layering is a convention read by the example hook (nb-session-start.sh:52-59, last `@` segment == slug), not by `nb`.
- A shelf is the file `<shelf>.md` flat in NB_DIR, never a directory (docs/requirements.md:545-547). Case-only variants refused on create (`assertNoCaseVariant`, notebook.ts:344).
- `listShelves` (notebook.ts:2102-2118): `readdirSync(dir)`; keep names that do not start with `.`, end with `.md`, and are not `readme.md` (case-insensitive); strip `.md`; sort. Missing dir -> `[]`; unreadable dir throws (#383). Comment :2086-2092 says a shelf name never starts with `.`.
- Doctor (src/doctor.ts:68-80): iterates `listShelves` (so dotfiles never appear) and flags any `*.md` stem failing `isValidShelfName` (e.g. `review copy.md`, issue #369). `stats.ts:596` filters `listShelves(dir).filter(isValidShelfName)`. Reap logic only touches `*.md.<pid>.tmp` and `.nb-usage.log.<pid>.tmp` (notebook.ts:893-931).

## 6. Hooks (examples/hooks/claude-code/)

Files: nb-session-start.sh (132 lines), nb-subagent-start.sh (36), nb-retrospective.sh (184), settings.json (41; registers SessionStart, SubagentStart, Stop only; nb-retrospective deliberately not under SubagentStop, settings.json:"//6").
- **nb-session-start.sh** (SessionStart): fail-open if `nb` missing (:24); `NB="${NB_BIN:-nb}"` (:21); runs `nb enabled` in `${CLAUDE_PROJECT_DIR:-.}` (:32); only the literal `off` -> prints one "switched off" line, exit 0 (:33-36). Else prints heading "## Your agent-notebook index" and the instruction to open shelves with `nb show`, vote, and "add at most one new durable lesson" (:43-50). With `NB_PROJECT_SLUG` set, prints a layered index from `nb list --json --limit 1000` via inline node (project `*@slug` / domain bare / global `NB_GLOBAL_SHELF` default `global`; :52-111, :114-119); else runs `NB_ENABLED=1 nb list`, with warning lines for failure or empty (:123-131).
- **nb-subagent-start.sh** (SubagentStart): discards stdin (:24), runs the session-start script, wraps its output as `{hookSpecificOutput:{hookEventName:"SubagentStart", additionalContext}}` (:29-36).
- **nb-retrospective.sh** (Stop): NB_DIR tilde expansion, sentinel dir = NB_DIR or default (:35-41); exits on `stop_hook_active` (:51), on `hook_event_name==='SubagentStop'` or non-empty `agent_id` (:60-61, issue #520), and when `background_tasks` has a `subagent|workflow|teammate|cloud session` task `running|pending` (:72-81). Sentinel `.retro-<session_id sanitized to [A-Za-z0-9._-], max 128>` claimed with `writeFileSync(..., {flag:'wx'})`; EEXIST -> allow stop (:87-105). Prune `.retro-*` older than `NB_RETRO_TTL_DAYS` (default 7) (:115-123). `nb enabled` asked in `CLAUDE_PROJECT_DIR` and, if different, payload `cwd`; `off` from either exits; `off` from the payload cwd alone unlinks the sentinel (:147-168). Emits `{decision:'block', reason}` where the reason is the 5-step retrospective (vote +1, vote -1, rm --reason obsolete, merge/split, add at most one <=200-char lesson) (:170-182).
- **`nb enabled` / `nb.enabled`** (src/enabled.ts): order `NB_ENABLED` (`0|false|no|off` = off, any other non-blank = on, blank = defer; :46-57, :97-100) -> `git config --type=bool --show-origin --get nb.enabled` in cwd (timeout 5000 ms; :73-79, :108-127) -> default on. Fail-open with a warning on missing git, git error, or non-boolean value (:109-118). Output `on`/`off`, `--why` appends source, `--json` emits `{enabled,state,source,value,origin,warning}` (cli.ts:1547-1563). Rationale for git config (never committed, three scopes without a new file format): docs/requirements.md:1517-1526. Which commands consult it: only `nb enabled`, `nb config`, text `nb list` (docs/requirements.md:1519-1521, 1558).

## 7. Requirements constraints

**DP-1..DP-8** (docs/requirements.md):
- DP-1 (:64) cap + vote are the whole mechanism; no decay curve, relevance scoring, scheduler or background job.
- DP-2 (:73) one entry = one line `<score>\t<text>`, no tab/CR/LF.
- DP-3 (:80) storage order is recency (touch -> end of file); display order is score-desc.
- DP-4 (:111) id = `sha1(dedupKey(text)).slice(0,6)`, content-derived.
- DP-5 (:120) never silently mislead: reject over-long, report evictions, refuse ambiguous selectors, warn on bad `--since`.
- DP-6 (:133) every call is a fast, deterministic, offline file edit.
- DP-7 (:140) zero runtime dependencies; Node stdlib only.
- DP-8 (:147) memory surfaces what the agent would not think to ask for; presentation (session-start injection) over query.

**Non-goals (section 6, :1613-1653):**
- NG-001 (:1619) no embeddings/semantic/vector/network matching; blocking dedup stays exact-normal-form; lexical overlap only as non-blocking advisory.
- NG-002 (:1628) no long-form notes, summaries or documents; one line per lesson.
- NG-003 (:1632) no network calls, server, or cross-machine sync.
- NG-004 (:1636) no multi-field schema; lesson = string, score = integer (usage log may carry richer columns).
- NG-005 (:1642) no aging, decay or scheduling; vote and cap are the only forces.
- NG-006 (:1646) `add` never truncates an over-long lesson.
- NG-007 (:1650) never require the agent to query to retrieve its own memory; search is secondary.

**Config-related FRs:** FR-CONFIG-001 (Should, :802: print every effective tunable), FR-CONFIG-002 (Should, :839: string env section), FR-ENABLED-001..004 (:1505-1558), FR-PATH-001 (:497), section 7 table (:1656-1680; preamble: "All are read at call time and clamped ... a missing value falls back to the default"). No FR specifies a config file; the words "config file"/"settings file"/"rc file" do not occur in docs/requirements.md (grep). FR-ENABLED-001 rationale (:1517-1526): git config gives repository/global/folder scopes "without a new file format", its per-repository value "is never committed, so a cloned repository cannot configure a tool that writes to the user's own memory".

**README "What it deliberately does not do"** (README.md:71-81), 5 bullets: (1) no embeddings/semantic/vector; blocking dedup exact on a normal form; `NB_NEAR_DUP` lexical note never blocks or ranks (:75); (2) no long-form notes, one line (:76); (3) no network calls, server, or sync (:77); (4) no multi-field schema (:78); (5) no trust boundary, review a shared shelf like code (:79). Followed by "If you need retrieval over large unstructured context, use a real vector store" (:81) and "When to pick something else" (:83-87).

## 8. PR #529 surface (IDEAS: branch `docs/ideas-store-use-case`)

`git diff --stat origin/main...HEAD`: 14 files, +2358 / -3; 7 commits (ef9d56f ... 3f0c469). PR body: "`nb` itself is unchanged. Everything new lives in `examples/` and the docs" (gh pr view 529; CHANGELOG addition says the same).
Files added: IDEAS:docs/ideas-store.md (207), examples/SETUP.md (287), examples/ideas/README.md (227), examples/ideas/nb-ideas.mjs (644), examples/hooks/claude-code/nb-ideas-stop.sh (137), examples/hooks/claude-code/settings.ideas.json (21), src/nb-ideas.test.ts (546), src/nb-ideas-stop.test.ts (187). Modified: README.md (+20), CHANGELOG.md (+9), docs/harness-setup.md (+4), examples/README.md (+5), examples/hooks/claude-code/README.md (+50), .claude/skills/agent-notebook-setup/SKILL.md (+17/-3).

**Env vars added** (nb-ideas.mjs:96-97 usage text, config() :131-138): `NB_IDEAS_DIR` (default `~/.agent-notebook/ideas`, tilde-expanded), `NB_IDEAS_PROJECT` (default: basename of `git rev-parse --show-toplevel`; slugified), `NB_IDEAS_MAX_CHARS` (default 400, clamped 20..2000), `NB_IDEAS_MAX_LINES` (default 50, clamped 1..5000), `NB_IDEAS_SIMILARITY` (default 0.4, no clamp), `NB_IDEAS_PROMOTE_SCORE` (default 3), `NB_IDEAS_PROMOTE_TASKS` (default 2). The Stop hook adds `NB_IDEAS_BIN` (default `nb-ideas`; nb-ideas-stop.sh:123) and reuses `NB_IDEAS_DIR`, `NB_BIN`, `NB_RETRO_TTL_DAYS`. Wrapper reuses `NB_SESSION`, `NB_BIN`. None of these are in `nb config`'s recognised set (config-report.ts:208-215 lists only 6 shipped-tool vars; the 7+1 `NB_IDEAS_*` names would be reported "not read by nb" if exported).
**Mechanism:** each nb call is a child process with `NB_DIR`, `NB_MAX_CHARS`, `NB_MAX_LINES` overridden (nb-ideas.mjs:224-226, spawn :229-235).
**Subcommands** (nb-ideas.mjs:78-89, switch :614-630): `add <category> "<line>" [--project P] [--new] [--because]`, `vote <shelf-or-category> <id> <+1|-1> [--because] [--project]`, `show`, `support [--json]`, `prompt [--session ID]`, `categories`, `help`; any other word is passed through to `nb`.
**Rules enforced** (header :35-41): closed category list (8 defaults guidance/dead/duplicate/overbuilt/tangled/unused/fragile/tests, :60-69; override by `categories.txt` in NB_IDEAS_DIR :59,:276); line must match `LINE_RE = /^(\S.*?): (.+) -> (.+) \(keeps: (.+)\)$/` (:72); shelf `<category>@<project>`; one `add` per task (NB_SESSION + project; checked :404-411; race guard marker `.ideas-adding-<session>@<project>` :379-399); identical line (dedupKey) -> converted to +1 vote (:~419-430); same target (case-insensitive) or trigram similarity >= `NB_IDEAS_SIMILARITY` -> nothing recorded, exit 3, matches printed, `--new` overrides; `+1` needs `--because`; a task votes once per idea and never +1s its own. Exit codes: 0 / 2 (rule or usage) / 3 (similar found) / otherwise nb's own (header :46-47). Note: exit 3 here is wrapper-level; in `nb` 3 means stats/doctor gate (see section 3, and gh issue 287 below).
**Side log:** `$NB_IDEAS_DIR/.ideas-support.log`, TSV 7 columns: `time, session, event, shelf, id, delta, reason` (appendLog :298-303; reason tab-stripped and capped `REASON_CAP=300` :75; reader :305-317). `support` counts distinct supporting tasks from it.
**Second Stop hook** (`nb-ideas-stop.sh`, 137 lines incl. comments; settings.ideas.json registers it under `Stop` only, "can sit beside nb-retrospective.sh ... the agent receives both reasons"): same skeleton as nb-retrospective.sh with a different sentinel `.ideas-prompt-<session>` (:74), no `stop_hook_active` exit (:77-81 comment), requires a non-empty `session_id` (:69), runs `nb-ideas prompt --session <id>` in the payload cwd (:122-128), releases the sentinel and lets the stop through if that fails or is empty (:130-133), emits `{decision:'block', reason}` (:135).
**Overlap with nb-retrospective.sh** (my count: strip `#`/`//` comment lines and blank lines, trim, dedupe): nb-ideas-stop.sh has 64 distinct code lines, nb-retrospective.sh 72; 47 of the 64 (73%) appear verbatim in nb-retrospective.sh (36 if lines of 12 chars or fewer, such as `}` and `try {`, are excluded). Shared blocks: NB_DIR-style tilde expansion + mkdir (retro :35-41 / ideas :34-39), SubagentStop + `agent_id` exits (:60-61 / :49-50), `DELEGATED_TYPES`/`IN_FLIGHT` check (:72-81 / :54-63), session sanitising (:87 / :70), `wx` sentinel claim (:100-105 / :82-86), TTL prune (:115-123 / :90-98), two-directory `nb enabled` check (:147-168 / :102-118).
**Tests:** `it(`/`test(` call counts: src/nb-ideas.test.ts 47, src/nb-ideas-stop.test.ts 14 (61 total; no `.each`); for comparison src/nb-retrospective.test.ts has 29 on main. They run the real scripts in temp folders (PR body).
Docs positioning (IDEAS:README.md diff): table "Two use cases: lessons and ideas" with columns Records / Read / Written / Folder / Ends as; lessons folder `~/.agent-notebook/notebooks`, ideas folder `~/.agent-notebook/ideas`, 400-char cap.

## 9. Prior decisions (gh)

**Issue #287 (closed 2026-11-07; `nb add --no-dup`: opt-in strict mode that writes nothing and exits 3 on a near-dup).** Owner closing comment, reasons:
1. Fuzzy gate unsafe at any threshold: default `nearThreshold()` is 0.5; trigram `similarity()` scores a lesson and its negation at the top of the scale. Measured: "fail open is unsafe" vs "fail open is safe" = 0.727; "...must check..." vs "...must not check..." = 0.897. A gate would silently refuse a genuinely new lesson and point `collided_id` at its opposite (silent loss, NG-001/DP-5).
2. The safe version is redundant: exact `dedupKey` blocking is already the default (skipped, exit 0) and `nb add --json` already returns `{added:false, reason:"duplicate", collidedId}`.
3. Secondary: the proposed exit 3 collides with `stats --exit-code` (3 = anomalies).
4. Priority numbers: dedup-blocks ~0.3% of adds on a live deployment; `too_long` ~97% of add errors (~43% of all add traffic). "The add-side pain worth fixing is lesson length."
Related fact: the PR #529 wrapper has a near-similar-text gate that exits 3 and records nothing, default threshold 0.4 (IDEAS:examples/ideas/nb-ideas.mjs:135, header :39-41), versus nb's non-blocking advisory at 0.5.

**Searches** (`gh issue list --state all --search`, limit 10; results listed are titles only unless noted):
- "config file": no issue proposes a config file for nb. Hits are unrelated or adjacent: #514 (per-repository on/off switch, CLOSED), #334 (NB_DIR=~ not expanded where no shell runs, CLOSED), #493 (move config report out of cli.ts, CLOSED), #481 (test suite inherits NB_* vars, CLOSED), #484 (janitor copies of core rules drifted, e.g. NB_MAX_LINES=1e3, CLOSED).
- "per-directory": #514 is the relevant one (see below); others (#332, #383, #482 unreadable shelf/dir handling; #338 doctor; #460, #165 hook sentinels in NB_DIR) are not about per-directory config.
- "kind": no relevant issue (hits are docs/cli issues #137-#143 and `Repository idea` issues).
- "profile": one hit, #463 (batch vote performance), unrelated.
- Adjacent: #83 "Group notebooks by the `.` namespace convention" (CLOSED; became FR-NAMESPACE-001), #363 "Document the project / domain / global memory-layer convention" (CLOSED; docs/memory-layers.md), #73 epic "self-observing notebook", #223 umbrella "Usage-grounded audit: add/vote error waste + dormant curation loop" (CLOSED). Search "ideas store" returned only #223; search "multiple notebooks" returned nothing.
- **#514** (CLOSED): per-repo switch chose env `NB_ENABLED` then `git config nb.enabled` "without any new file format"; slice 1 merged in #515 (`nb enabled`, hooks check, `enabled=` in `nb config`); issue body states data commands (`show`, `add`, ...) keep working in an off repository ("It is not an access lock"), and that the gate lives in hook scripts because Claude Code merges hook entries and cannot disable one from a project (body, `disableAllHooks` is the only project-level switch).
- Docs state a per-project install of hooks as the existing per-repository control before #514 (issue #514 body, "The need").

## 10. Operator-supplied measurements (unpublished; copied verbatim from the request)

- ~400 real agent sessions using lessons
- lesson votes ~1,075 up vs 7 down
- "at most one" in prose broken in ~98 of 541 task-shelf pairs
- 0 of 718 adds were exact duplicates
- with a once-per-session marker, subagents claimed the only prompt in ~20% of sessions (SubagentStop)

(Repo pointer for the last item: the SubagentStop handling added in issue #520, nb-retrospective.sh:53-61, and the `DELEGATED_TYPES` check :63-81.)

## 11. Size today

- `src/*.ts` non-test (wc -l): notebook.ts 2493, cli.ts 2016, stats.ts 1303, usage.ts 495, render.ts 466, config-report.ts 353, doctor.ts 203, enabled.ts 152, index.ts 134, suggest.ts 82; total 7697.
- README.md: 28234 characters (wc -c), 313 lines. src/readme-length.test.ts:6-10 states npmjs cuts a README at 65,536 characters.
- docs/requirements.md: 1694 lines; 82 `**FR-...**` definitions (`grep -c '^\*\*FR-'`), 6 `**NFR-...**`, 8 DP, 7 NG.
- Other docs (lines): harness-setup 524, eviction-and-aging 350, memory-layers 242, self-observing-notebook 234, cli-reference 217, getting-started 211, enterprise 199, operating 173, programmatic-use 132.
