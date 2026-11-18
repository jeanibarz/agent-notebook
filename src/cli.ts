#!/usr/bin/env node
// `nb` — the Agent Notebook CLI. A shelf is a bounded, voted memory: local plain
// text, no embeddings, no network, so every call is a fast, deterministic,
// offline file edit.
//
// Commands:
//   nb show   <shelf>... [--json]           print the notebook(s) (--json → structured {shelf,description,entries}; one shelf → object, many → array, each entry has a `key`)
//   nb add    <shelf> "<lesson>"            dedup-skip, score +1, write, trim (lowest-score out)
//   nb add    <shelf> -                     read the one-line lesson from stdin (multi-line refused)
//   nb vote   <shelf> <id|query> +1|-1      adjust an entry's score (id-list <id1,id2,…> votes several at once)
//   nb merge  <shelf> <idA> <idB> "<merged>"  consolidate two entries into one
//   nb split  <shelf> <id|query> "<a>" "<b>"   cut one overloaded entry into two
//   nb rm     <shelf> <id|query>            delete an entry judged useless
//   nb move   <from> <to> <id|query>        relocate an entry across shelves, score intact
//   (add/vote/rm/merge/move take --json: one structured result object on stdout)
//   nb describe <shelf> ["<text>"]          set the notebook's one-line description (or print it)
//   nb describe <shelf> -                   read the one-line description from stdin (multi-line refused)
//   nb search <query> [prefix] [--any] [--limit N]  SECONDARY keyword fallback: scan all notebooks (surfacing is primary)
//   nb stats  [<shelf>] [--since 7d] [--json] [--exit-code]  usage analytics + anomaly & diagnostic-signal flags (--json = raw StatsReport; --exit-code = exit 3 when anomalies present)
//   nb doctor [--json] [--exit-code]        read-only structural check of the notebooks dir (conflict markers, bad lines, control chars, case collisions, over-cap, 0-byte, temps, stale lock; --exit-code = exit 3 when any found)
//   nb path   [<shelf> | --usage] [--json]   print the notebooks dir, a shelf's file path, or the usage-log path (--json = {dir, shelf, path} object)
//   nb config [--json]                      print the effective (post-clamp) NB_* tunables + the NB_DIR/NB_SESSION/NB_ASCII string env vars as name=value (--json = object keyed by name, string vars under `environment`)
//   nb enabled [--why] [--json]             print `on` or `off`: whether the agent-facing loop (hooks, retrospective, text `nb list`) is on here (NB_ENABLED, then git config nb.enabled, default on)
//   nb list   [prefix] [--limit N]         index notebooks: one richest-first line each (name, lessons, desc)
//   nb ls / nb shelves / nb roles          aliases of `nb list` (`roles` is deprecated)
//   nb completion <bash|zsh>               print a static shell-completion script to source
//   nb --help                              this help
//
// Every call — including `nb --help` and `nb --version` — appends one line to
// the usage ring so `nb stats` can surface loop / went-silent / high-error-rate
// anomalies (and so a harness that only ever runs `--help` is still visible).

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addEntry,
  assertSafeShelf,
  classifyError,
  DESC_KEY,
  entryId,
  getDescription,
  getMetaValue,
  listNotebooks,
  listShelves,
  maxChars,
  merge,
  move,
  NbError,
  notebookExists,
  notebooksDir,
  readShelf,
  releaseHeldLock,
  remove,
  renderEntries,
  search,
  setDescription,
  showJson,
  showJsonMany,
  staleCandidates,
  split,
  stripControlChars,
  usageFile,
  vote,
  voteMany,
  type Entry,
} from './notebook.js';
import { formatEvictedUsage, logUsage, normalizeReason, type UsageMeta } from './usage.js';
import {
  isValidWindow,
  parseWindowMs,
  stats,
} from './stats.js';
import { doctor, renderDoctor } from './doctor.js';
import {
  configSource,
  effectiveConfig,
  environmentRows,
  renderConfig,
  unknownEnvVars,
  type ConfigSource,
  type ConfigStatus,
} from './config-report.js';
import { describeSource, resolveEnabled, stateWord } from './enabled.js';
import { closestMatch, closestShelf } from './suggest.js';
import {
  fmt,
  plural,
  renderConflict,
  renderConflicts,
  renderList,
  renderSearch,
  renderSkipped,
  renderStats,
} from './render.js';

/**
 * Default row cap for `nb list` when `--limit` is not given. The index is meant
 * to be read (even injected) whole, so the default is generous enough to show a
 * normal working set in full, while still bounding a pathologically large
 * notebooks dir — the header then reads "showing N of total".
 */
const LIST_DEFAULT_LIMIT = 50;

/**
 * What a text `nb list` prints in place of the index when `nb enabled` says off
 * (slice 2 of issue #514). It starts flush-left, so the completion scripts,
 * which read only indented rows, take no shelf name from it.
 * `NB_ENABLED=1` is the escape hatch: it overrides git config for one command.
 */
const LIST_OFF_LINE =
  'agent-notebook is switched off for this repository: skip the notebook steps (no `nb show`, no end-of-task retrospective). ' +
  '`nb enabled --why` shows which setting decided; `NB_ENABLED=1 nb list` shows the index anyway.';

/**
 * Row cap the emitted shell-completion scripts pass to `nb list` (issue #456). A
 * bare `nb list` stops at `LIST_DEFAULT_LIMIT` rows, so on a larger store the
 * newest, smallest shelves would never tab-complete. `--limit 0` returns no rows
 * (it cannot mean "all"), so completion asks for an explicit, practically
 * unbounded number instead.
 */
const COMPLETION_LIST_LIMIT = 1000000;

/**
 * Default notebook-group cap for `nb search` when `--limit` is not given (issue
 * #186). Mirrors `LIST_DEFAULT_LIMIT`: search groups ARE notebooks, so the same
 * generous bound keeps a normal result set whole while capping a common term (or
 * `--any`) that would otherwise dump every notebook on a large deployment. The
 * bound shapes only what is printed — the gap-sensor outcome and #114 surfacing
 * provenance are always computed on the full, unbounded result.
 */
const SEARCH_DEFAULT_LIMIT = 50;

/**
 * Default number of cull candidates `nb stale` lists when `--limit` is not
 * given. The retrospective only needs the weakest handful to review, not the
 * whole shelf, so this stays small; `--limit N` widens it (and `--json` returns
 * exactly what `--limit` selects).
 */
const STALE_DEFAULT_LIMIT = 10;

const HELP = `nb — the Agent Notebook (bounded, voted memory, grouped in shelves)

For developers who run AI agents and want them to carry a few durable lessons across runs.

usage:
  nb show   <shelf>... [--json]            print one or more notebooks (highest-scored first; --json emits {shelf,description,entries} — a lone object for one shelf, an array for several; each entry carries a dedup key)
  nb stale  <shelf> [--limit N] [--json]   list cull candidates to downvote/rm, most disposable first (lowest score, then stalest; default ${STALE_DEFAULT_LIMIT})
  nb add    <shelf> "<lesson>"             add a lesson (exact dup skipped; a near-dup still adds but warns; rejected if too long, never truncated)
  nb add    <shelf> -                      read the lesson from stdin (one line; multi-line is refused)
  nb vote   <shelf> <id|query> +1|-1       upvote/downvote an entry you used
  nb vote   <shelf> <id1,id2,…> +1|-1      batch: vote several ids at once with one delta (one lock, one write)
  nb merge  <shelf> <idA> <idB> "<merged>" consolidate two entries into one
  nb split  <shelf> <id|query> "<a>" "<b>" cut one overloaded entry into two (reverse of merge)
  nb rm     <shelf> <id|query>             delete an entry
  nb move   <from> <to> <id|query>         move an entry to another shelf, keeping its score (consolidate shelves)
  nb describe <shelf> ["<text>"]           set the notebook's one-line description (no text → print the current one)
  nb describe <shelf> -                    read the description from stdin (one line; multi-line is refused)
  nb search <query> [prefix] [--any] [--limit N]  SECONDARY keyword fallback — scan all notebooks (surfacing is the primary path)
  nb stats  [<shelf>] [--since 7d] [--json] [--exit-code] usage analytics + anomaly & diagnostic-signal flags (--json emits the raw StatsReport)
  nb doctor [--json] [--exit-code]         read-only check of the notebooks dir for structural problems (conflict markers, lines without a score, control chars, case-colliding shelves, over-cap, 0-byte files, leftover temps, stale lock); --exit-code exits 3 if any are found
  nb path   [<shelf>] [--json]             print the notebooks dir, or a shelf's resolved file path (--json emits a {dir, shelf, path} object)
  nb path   --usage [--json]               print the resolved usage-log path (to tail -F or back it up)
  nb config [--json]                       print the effective (post-clamp) NB_* tunables + the NB_DIR/NB_SESSION/NB_ASCII string env vars as name=value (--json: tunables keyed by name, string vars under \`environment\`)
  nb enabled [--why] [--json]              print \`on\` or \`off\`: whether the agent-facing loop (hooks, retrospective, text \`nb list\`) is on in this directory
  nb list   [prefix] [--limit N]          index notebooks richest-first: one line each (name, lesson count, description)
  nb ls     [prefix] [--limit N]          alias of \`nb list\`
  nb shelves [prefix] [--limit N]         alias of \`nb list\`
  nb roles  [prefix] [--limit N]          deprecated alias of \`nb list\` (still works)
  nb completion <bash|zsh>                print a shell-completion script to source (eval "$(nb completion bash)")
  nb --help                               show this help
  nb --version                            print the tool version

notes:
  - <shelf> is a notebook's name: one <shelf>.md file of lessons an agent needs in the
    same situations (see \`nb list\`).
  - add/vote/rm/merge/split/move/describe accept --json (after the subcommand): stdout is one JSON
    result object and nothing else; warnings/errors stay on stderr. Exit codes are
    unchanged (a too-long add still exits 1, a duplicate still exits 0).
  - \`--\` ends option parsing: every token after it is a literal operand, so a
    lesson/description/query that is itself flag-shaped is passed verbatim —
    \`nb add glossary -- --json\` stores the line \`--json\` (a bare trailing \`--\`
    is NOT a terminator, so \`nb vote <shelf> <id> --\` still means downvote).
  - \`nb move <from> <to> <id|query>\` relocates one entry to another shelf WITH ITS
    SCORE INTACT — the score-preserving consolidation \`add\`+\`rm\` cannot do (\`add\`
    resets to +1). It refuses, writing nothing, if source and target are the same
    shelf, the selector is absent/ambiguous, or the target already holds a
    near-duplicate; the moved entry is admitted like a newcomer, so a full target
    ages/evicts its stalest OTHER line, never the lesson you moved.
  - \`nb vote <shelf> <id1,id2,…> +1|-1\` votes SEVERAL entries with one delta in a
    single call — the end-of-session retro promoting/demoting a handful of lessons
    at once (N calls → 1, under one lock and one write). It is BATCH only when the
    operand is a comma-separated list of ≥2 BARE HEX ids (the ids \`nb show\` prints);
    a single token, or any comma-part that is not a bare hex id, stays one
    (possibly text) selector, so \`nb vote s "build, then test" +1\` is unchanged.
    Best-effort: each id is resolved independently, an unresolved one (stale or
    ambiguous) is reported on stderr WITHOUT aborting the rest, and the call exits
    non-zero only if NONE landed. \`--json\` emits the per-id result array.
  - \`nb add <shelf> -\` reads the lesson from stdin (one line, so a supervising agent
    can pipe it in without shell-quoting). It reads exactly one line: a trailing
    newline is stripped and multi-line input is REFUSED (exit 1), never flattened —
    one entry = one line. To store a literal single hyphen, use the library addEntry.
  - \`nb split\` is the reverse of \`merge\`: it replaces one overloaded entry with two,
    each inheriting the original's score. Each half is rejected (not truncated) if too
    long, and a split never creates a duplicate (the two halves must differ from each
    other and from every surviving entry, else the split is refused and nothing changes).
  - add/merge/rm/split/move/describe accept an optional \`--reason <code>\` (+ \`--note "<text>"\`), logged
    (never stored in the notebook) so each op's rate-by-reason becomes a diagnostic
    signal. The reason is always OPTIONAL (omit it rather than invent one — forcing it
    breeds filler), and an unrecognized code is accepted as \`other\` (kept in the note),
    never rejected, so a recurring one can later become its own code. Per-op codes:
      merge  duplicate  the two entries say the same thing — one is a reworded copy of the
                        other (e.g. "run build then test" + "build before running tests")
             other      any other motive (e.g. editing one and deleting the other was
                        cheaper than three calls); add \`--note\` to describe it
      rm     wrong      the lesson is incorrect or misleading — it should not have been
                        stored (e.g. "vitest needs Node 18" when it actually needs 20)
             obsolete   the lesson was true but no longer applies (e.g. a CLI flag the
                        tool has since removed, or a path that was refactored away)
             other      any other motive; add \`--note\` so a recurring one can emerge
      split  overloaded the entry crammed two distinct lessons into one line — cut apart
                        (e.g. "run build, then vitest" → "run build first" + "run vitest")
             other      any other motive; add \`--note\` so a recurring one can emerge
      move   consolidate folding a thin or redundant shelf into a broader one — two
                        situations turned out to be one (the usual reason to move)
             other      any other motive; add \`--note\` so a recurring one can emerge
      add    (no enum yet — free text only: use \`--note "<text>"\`; add's codes will emerge
             from mined notes rather than be guessed up front)
      describe (no enum yet — free text only, like add; the flags are accepted and logged so
             a code learned from the other write commands is never stored as the description)
  - \`nb describe <shelf> "<text>"\` sets the notebook's one-line description, stored as a
    leading \`# desc: <text>\` comment in the file; \`nb describe <shelf>\` (no text) prints the
    current one. The description is a *trigger* — "the situation in which you should open me" —
    so \`nb show\` and a bare list can tell what a notebook is for without reading its lessons.
    It is capped like a lesson (rejected, not truncated, if too long); an empty text clears it.
    A text operand of \`-\` reads the one-line description from stdin (multi-line refused), the
    same escape hatch \`add -\` offers so an agent can pipe it in without shell-quoting.
    The \`# key: value\` block round-trips through every mutation and never becomes a lesson.
  - \`nb list\` (aliases \`ls\`, \`shelves\`; \`roles\` is the deprecated old name) is the notebook index: one richest-first line per notebook —
    name, lesson count, and description — so you can pick which notebook to open WITHOUT reading any
    of them. Richest-first = most lessons first (ties by name). A notebook with no \`# desc:\` falls back
    to its top-scored lesson, marked \`(auto)\`. A bare \`prefix\` filters by name (the \`.\` namespace
    convention, e.g. \`nb list review.\`); \`--limit N\` bounds the rows (default ${LIST_DEFAULT_LIMIT}) so discovery
    cost stays flat as notebooks grow; \`--json\` emits the raw NotebookListing. An empty (zero-lesson,
    no-description) notebook is hidden — it is phantom debris with nothing to discover.
    Where \`nb enabled\` says off, the text form prints one line telling the agent to skip the notebook
    steps instead of the index (\`NB_ENABLED=1 nb list\` shows it anyway); \`--json\` is unaffected.
  - \`nb search <query> [prefix]\` is a DEMOTED, SECONDARY keyword fallback — the primary path is
    *surfacing* (a notebook is shown to you at session start, and \`nb list\` helps you pick one),
    because the lesson you most need is the one you would not think to search for. Reach for search
    only for a genuine known-item lookup. It is KEYWORD-ONLY (plain case-insensitive substring over
    the query's terms — no embeddings or semantic ranking): it scans every notebook's lessons and
    descriptions, AND-over-terms by default (\`--any\` for OR), and groups the hits by notebook,
    most-relevant-first, printing each lesson's id so you can \`vote\` it later. A bare \`prefix\` scopes
    by name (the \`.\` convention, e.g. \`nb search lock review.\`); \`--limit N\` bounds the notebook groups
    (default ${SEARCH_DEFAULT_LIMIT}, like \`nb list\`) so a common term can't dump every notebook — the header then
    reads "N of total"; \`--json\` emits the raw SearchResult. The limit shapes only what is shown: a
    \`failed-search\` coverage gap and the surfaced-id provenance are always computed on the full result.
    A search that finds nothing is also a signal: it is logged so a later \`add\` in the same session
    reads back as a \`failed-search\` coverage gap in \`nb stats\`.
  - \`nb stats\` also surfaces free *diagnostic signals* read straight from the usage log (no
    extra agent action): browse-without-use (a notebook shown in a session but no entry voted
    that session; the report ranks shelves by the share of sessions that voted, lowest first,
    and a low share suggests the description may over-promise), eviction-while-still-voted (the cap
    evicted an entry upvoted in the window, or whose score was still
    above the starting +1 — a useful lesson was lost),
    vote-reversal (the same entry upvoted in one session and downvoted in another — correct but
    mis-aimed), and failed-search (a search returned nothing and a lesson was then added in the
    same session — the coverage gap that search just exposed), and add-burst (one session accepted
    more than NB_ADD_BURST_N adds into one shelf — on a full shelf that shortens how long the other
    lessons survive). Each shelf row also shows its adds and, when full, ~retention (cap ÷ adds/day:
    about the most time a never-voted lesson gets; downvotes on other lessons can stretch it). They
    need \`NB_SESSION\` set to attribute calls to a session; \`--json\` includes them as \`signals[]\` in
    the StatsReport.
  - \`nb stats\` also reports the named *surfacing metrics* (as \`surfacing\` in the StatsReport):
    coverage (novel-add rate), recall-miss (dedup-block rate — the headline alarm: a stored lesson
    was re-derived, not surfaced), precision-miss (downvote rate on pushed lessons, read beside
    recall so "surface everything" can't look free), serendipity (share of upvotes on lessons that
    arrived unbidden — not pulled by a same-session search; an approximate proxy, not a bound — #114),
    and a coverage×surfacing readout
    (healthy / surfacing-failure / coverage-building / churny). Every rate is conditioned on add/vote
    *attempts* (robust to a lazy agent) and gated on *engagement* — only sessions with a vote are
    scored, so an uninstrumented session isn't mistaken for "healthy quiet". A rate is \`null\` (shown
    \`—\`) when there's no data. Needs \`NB_SESSION\` set to attribute calls to a session.
  - when NO session is engaged anywhere in the window, \`nb stats\` splits the cause instead of one
    vague line: \`NB_SESSION\` unset, the retrospective nudge not landing (a notebook was opened but
    never voted), or the SessionStart hook not wired (lessons stored but nothing read them). The
    counts are \`surfacing.engagementDiagnosis\` in \`--json\` (\`null\` once any session is engaged).
  - \`nb stats --exit-code\` turns the anomaly detector into a drop-in health gate: it exits 3
    (distinct from 1=handled error, 2=unknown command) when the window holds >=1 anomaly, and 0
    otherwise, so \`nb stats --exit-code >/dev/null || alert\` fires on loop/went-silent/high-error-rate.
    The flag is opt-in — WITHOUT it \`nb stats\` always exits 0 regardless of anomalies. It composes
    with \`--since\`/\`<shelf>\`/\`--json\` (the exit code reflects the same filtered window that is printed).
  - a notebook holds at most 50 lines; each lesson is one line of at most 200 chars.
  - an over-long add is REJECTED (exit 1), never truncated — rewrite shorter and retry.
  - when full, the LOWEST-scored line is evicted (ties: stalest — the least recently touched line).
  - every \`nb show\` line begins with the entry's short stable <id>; pass that id to vote/rm/merge
    (a unique id prefix works too). A unique text substring also selects an entry; an ambiguous one is refused.
  - storage: $NB_DIR or ~/.agent-notebook/notebooks/<shelf>.md (plain text, git-diffable).
  - \`nb config\` prints every effective (post-clamp) tunable as \`name=value\`, each read from the live
    getter the hot path uses, so you never re-derive it by hand from the env var, its default and its
    clamp. Each line is tagged with its source: \`(default)\` (the var is unset), \`(env NB_*)\` (the var is
    set), or \`(derived …)\`. A set value that was rewritten or thrown away is annotated: it is still the
    post-clamp effective value, but the tag names \`clamped\`/\`ignored\` (with the raw value) so it never reads
    as if honored. A trailing section then prints the three behavior-critical STRING env vars — \`NB_DIR\`
    (storage), \`NB_SESSION\` (the id the usage/engagement diagnostics group by), and \`NB_ASCII\` (rendering
    mode) — each tagged \`(env)\`/\`(default)\`. Any \`NB_*\` var nb does not read is listed as \`unrecognized\`
    (with a did-you-mean hint when one is close); informational only. \`--json\` emits one object keyed by tunable name, each
    \`{ value, source, env, status, rawValue }\`, plus an \`environment\` key holding the string vars
    (\`{ value, source }\` each) and an \`unrecognized\` array. Read-only — it mutates nothing, and is
    scoped to CONFIGURATION (the knobs), distinct from \`nb stats\` (usage, anomalies, engagement).
  - \`nb enabled\` prints \`on\` or \`off\` for the current directory, so a harness hook can stay quiet in a
    repository where the notebook loop is switched off. \`NB_ENABLED\` decides first (\`0\`/\`false\`/\`no\`/\`off\`
    = off, any other non-blank value = on); otherwise \`git config nb.enabled\` (\`git config nb.enabled false\` in
    one repository, \`--global\` for all of them); otherwise on. A missing \`git\` or an invalid value resolves to
    on, with a warning on stderr. \`--why\` adds which input decided. Read-only; it switches off only the hooks
    that ask it and the text \`nb list\` index, never the other \`nb\` commands.
  - \`nb completion <bash|zsh>\` prints a static, dependency-free completion script to stdout.
    Source it with \`eval "$(nb completion bash)"\` (or the zsh form) to tab-complete the command set
    and, where a command takes a shelf, existing shelf names (looked up via \`nb list\`, guarded so it
    never hangs or errors your shell). The emitted scripts are also shipped under \`examples/completion/\`.

docs: https://github.com/jeanibarz/agent-notebook`;

// Resolve the shipped package.json relative to this module (not the cwd):
// `../package.json` is the tarball root both from src/ (tests) and dist/
// (the published bin). npm always includes package.json at the tarball root.
function pkgVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseDelta(arg: string): number {
  const t = arg.trim();
  if (t === '+1' || t === '1' || t === '++') return 1;
  if (t === '-1' || t === '--') return -1;
  throw new NbError('bad_args', 'vote direction must be +1 or -1');
}

/**
 * Every command `nb` dispatches — the switch `case` labels plus the two
 * pre-switch word commands (`help`/`version`). Canonical names come first so a
 * tie in `closestCommand` resolves to the preferred form (e.g. `lis` → `list`,
 * not the `ls` alias). Kept in sync with the dispatch by a drift guard in
 * cli.test.ts, so a new command missing here fails the suite loudly rather than
 * silently dropping out of the did-you-mean suggestions (issue #171).
 */
export const KNOWN_COMMANDS = [
  'show', 'stale', 'add', 'vote', 'merge', 'split', 'rm', 'move', 'describe',
  'search', 'stats', 'doctor', 'path', 'config', 'enabled', 'completion', 'list', 'ls', 'shelves', 'roles',
  'help', 'version',
] as const;

/**
 * The commands that write a notebook. `examples/nb-git-wrapper.mjs` keeps a
 * literal copy of this list (it is a standalone script and cannot import from
 * the package) to decide which commands are worth an auto-commit; a test
 * compares the two so they cannot drift apart (issue #411). Deliberately NOT
 * derived from `MAX_ARGS`, whose keys are operand caps, not a write surface.
 */
export const MUTATING_COMMANDS = ['add', 'vote', 'merge', 'rm', 'split', 'move', 'describe'] as const;

/**
 * Commands whose FIRST operand is a shelf name, so the generated shell
 * completion offers existing shelf names there. `move` is handled on its own in
 * the emitted scripts (both its `from` and `to` operands are shelves). Commands
 * whose first operand is free text — `search`'s query, `list`'s name prefix —
 * are deliberately excluded: completing shelf names there would mislead.
 */
const SHELF_FIRST_COMMANDS = [
  'show', 'stale', 'add', 'vote', 'merge', 'split', 'rm', 'describe', 'stats', 'path',
] as const;

/**
 * Emit a static, dependency-free shell-completion script for `nb completion
 * <bash|zsh>` (issue #187). The script is plain text printed to stdout — no
 * runtime dependency — and completes the fixed command set plus, for commands
 * that take a shelf, shelf names enumerated by shelling out to `nb list`. That
 * dynamic lookup is guarded in the emitted script so it can never hang or error
 * the user's shell: `nb list` is a local, offline, read-only call, its stderr is
 * swallowed, and any failure degrades quietly to no suggestions. The command set
 * is interpolated from `KNOWN_COMMANDS`, so a new command is completed the moment
 * it is added (a test pins the shipped `examples/completion/` scripts to this
 * output so they cannot drift). An unknown shell is a handled bad-args error.
 */
function completionScript(shell: string): string {
  const commands = KNOWN_COMMANDS.join(' ');
  const shelfCase = SHELF_FIRST_COMMANDS.join('|');
  if (shell === 'bash') return bashCompletion(commands, shelfCase);
  if (shell === 'zsh') return zshCompletion(commands, shelfCase);
  throw new NbError('bad_args', `unknown shell "${shell}" for \`nb completion\` — supported shells: bash, zsh`);
}

/** The bash completion script, with the command set and shelf-command case interpolated. */
function bashCompletion(commands: string, shelfCase: string): string {
  return `# nb (agent-notebook) bash completion — generated by \`nb completion bash\`.
# Load it into the current shell:   eval "$(nb completion bash)"
# Or install it where your shell sources completions, e.g. /etc/bash_completion.d/nb
# on many Linux distros, or "$(brew --prefix)/etc/bash_completion.d/nb" under Homebrew.
#
# Completes the fixed command set, and for commands that take a shelf it
# completes shelf names from \`nb list\`. The dynamic lookup is guarded so it can
# never hang or error your shell: \`nb list\` is a local, offline, read-only call,
# its stderr is discarded, and any failure degrades quietly to no suggestions.
_nb_complete() {
  local cur cword
  # Reset first: a path that offers nothing (e.g. a free-text operand) must clear
  # the reply, never leak stale candidates from the previous completion.
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cword=$COMP_CWORD

  # Position 1: the subcommand itself.
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return 0
  fi

  # Later positions: offer shelf names only where an operand is a shelf.
  local cmd="\${COMP_WORDS[1]}"
  case "$cmd" in
    ${shelfCase})
      [ "$cword" -eq 2 ] || return 0 ;;
    move)
      [ "$cword" -eq 2 ] || [ "$cword" -eq 3 ] || return 0 ;;
    *)
      return 0 ;;
  esac

  # Shelf names = the first field of each indented row of \`nb list\` (its header
  # line is flush-left, so the leading-space match skips it). stderr and any
  # failure are swallowed, so a broken or absent \`nb\` yields no completions
  # rather than an error.
  # NB_ENABLED=1 keeps the index on in a repository where the notebook is switched
  # off (\`nb enabled\`), so shelf names still complete there.
  local shelves
  shelves="$(NB_ENABLED=1 nb list --limit ${COMPLETION_LIST_LIMIT} 2>/dev/null | awk '/^[[:space:]]/ {print $1}')" || return 0
  COMPREPLY=( $(compgen -W "$shelves" -- "$cur") )
  return 0
}
complete -F _nb_complete nb
`;
}

/** The zsh completion script, with the command set and shelf-command case interpolated. */
function zshCompletion(commands: string, shelfCase: string): string {
  return `#compdef nb
# nb (agent-notebook) zsh completion — generated by \`nb completion zsh\`.
# Load it into the current shell:   eval "$(nb completion zsh)"
# Or install it as an autoloaded function on your \$fpath, named \`_nb\`:
#   nb completion zsh > "\${fpath[1]}/_nb"   # pick a writable \$fpath dir; then restart zsh
# Both work: the trailing guard registers the function when the file is sourced
# (eval) and runs it directly when compinit autoloads it as \`_nb\`.
#
# Requires compinit (run \`autoload -U compinit && compinit\` once in ~/.zshrc).
# Completes the fixed command set, and shelf names (via \`nb list\`) where an
# operand is a shelf. The dynamic lookup is guarded so it can never hang or error
# your shell: \`nb list\` is a local, offline, read-only call, its stderr is
# discarded, and any failure degrades quietly to no suggestions.
_nb() {
  local -a _nb_commands
  _nb_commands=(${commands})

  # Position 1 (CURRENT counts from 1, with words[1] = "nb"): the subcommand.
  if (( CURRENT == 2 )); then
    compadd -a _nb_commands
    return 0
  fi

  local cmd=\${words[2]}
  local want_shelf=0
  case $cmd in
    ${shelfCase}) (( CURRENT == 3 )) && want_shelf=1 ;;
    move)         (( CURRENT == 3 || CURRENT == 4 )) && want_shelf=1 ;;
  esac

  if (( want_shelf )); then
    # Shelf names = the first field of each indented row of \`nb list\` (its header
    # line is flush-left, so the leading-space match skips it). Only split and add
    # when the lookup produced output, so an empty list adds no empty candidate.
    # NB_ENABLED=1 keeps the index on in a repository where the notebook is switched
    # off (\`nb enabled\`), so shelf names still complete there.
    local _nb_list
    _nb_list="$(NB_ENABLED=1 nb list --limit ${COMPLETION_LIST_LIMIT} 2>/dev/null | awk '/^[[:space:]]/ {print $1}')"
    if [[ -n $_nb_list ]]; then
      local -a _nb_shelves
      _nb_shelves=(\${(f)_nb_list})
      compadd -a _nb_shelves
    fi
  fi
  return 0
}

# Dual-mode registration (the kubectl/helm idiom): when compinit autoloads this
# file as the \`_nb\` completion function, funcstack[1] is \`_nb\`, so just run it;
# when the file is sourced/eval'd instead, funcstack is empty, so register with
# compdef (the leading \`#compdef nb\` tag is then an inert comment).
if [[ "\${funcstack[1]}" == _nb ]]; then
  _nb "$@"
else
  compdef _nb nb
fi
`;
}

/**
 * Nearest known command to an unknown input, or `undefined` when nothing is
 * close enough to suggest confidently (issue #171). See `closestMatch`.
 */
export function closestCommand(
  input: string,
  commands: readonly string[] = KNOWN_COMMANDS,
): string | undefined {
  return closestMatch(input, commands);
}

/**
 * Guard a mutation (`vote`/`split`/`rm`/`move`) that names a shelf: if the shelf
 * was never created, the op cannot run, but letting the core selector/empty
 * throw call it an *empty* notebook mislabels a typo — and so sends an agent to
 * seed a brand-new lesson onto the wrong (nonexistent) shelf, silently
 * fragmenting memory across typo shelves (issue #200). Mirror `show`'s
 * exists-vs-empty split (issue #166): say `no notebook for shelf "X"` and,
 * unlike the generic empty-state error, point at the nearest existing shelf when
 * one is close (did-you-mean). A shelf whose file exists but holds no lessons is
 * NOT intercepted here — it still reaches the core "is empty" throw, so the #166
 * distinction is preserved. Advisory only; keeps the `no_match` class (exit 1).
 * An unsafe shelf name still throws `bad_args` first (via `notebookExists` →
 * `shelfFile` → `assertSafeShelf`), exactly as the core call would.
 */
function requireExistingShelf(dir: string, shelf: string): void {
  if (notebookExists(dir, shelf)) return;
  const near = closestShelf(shelf, listShelves(dir));
  const hint = near
    ? ` — did you mean "${near}"? (run \`nb list\` to see existing shelves)`
    : ' — run `nb list` to see existing shelves';
  throw new NbError('no_match', `no notebook for shelf "${shelf}"${hint}`);
}

/**
 * The long options each command accepts, so a typo'd or misplaced flag is
 * REFUSED loudly instead of silently ignored or absorbed as a positional (issue
 * #267). Before this, `nb stats --exitcode` (a typo of `--exit-code`) ran
 * WITHOUT the health gate and still exited 0 — so `nb stats --exitcode || alert`
 * silently stopped firing, the #129 use case defeated by one missing hyphen.
 *
 * `--json` is accepted everywhere (it is parsed globally for every command), so
 * it is folded in by `assertKnownFlags` rather than repeated in each row. A row
 * is required for every dispatched command except `help`/`version` (which return
 * before the switch); a drift guard in cli.test.ts fails loudly if a
 * `KNOWN_COMMANDS` entry is missing one, so a new command cannot quietly opt out
 * of flag validation. An unknown COMMAND has no row and is left to the dispatch
 * default (exit 2) — never masked by a flag error here.
 */
export const KNOWN_FLAGS: Record<string, readonly string[]> = {
  show: [],
  stale: ['--limit'],
  add: ['--reason', '--note'],
  vote: [],
  merge: ['--reason', '--note'],
  split: ['--reason', '--note'],
  rm: ['--reason', '--note'],
  move: ['--reason', '--note'],
  describe: ['--reason', '--note'],
  search: ['--any', '--limit'],
  stats: ['--exit-code', '--since'],
  doctor: ['--exit-code'],
  path: ['--usage'],
  config: [],
  enabled: ['--why'],
  list: ['--limit'],
  ls: ['--limit'],
  shelves: ['--limit'],
  roles: ['--limit'],
  completion: [],
};

/**
 * The flags that take a following value token. Listed so `assertKnownFlags`
 * consumes that token and never re-examines it — a value may itself be
 * flag-shaped (e.g. `--note --exitcode`, recording a note that is literally
 * `--exitcode`), and treating it as an option would be a false rejection. (A
 * literal `--json` value is the exception: the global `--json` strip runs first,
 * so passing it as a value needs the `--` terminator instead — issue #277.)
 */
const VALUE_FLAGS = new Set(['--reason', '--note', '--limit', '--since']);

/**
 * Refuse an unknown or misplaced long option rather than silently swallowing it
 * (issue #267). Scans only `head` — the region BEFORE a `--` terminator —
 * because every token after `--` is a deliberate literal operand (issue #277)
 * and must never be read as a flag. A bare `--` within `head` is likewise a
 * literal operand (e.g. `vote`'s trailing-`--` downvote alias), not a flag.
 * Value-taking flags consume their following token (see `VALUE_FLAGS`). On an
 * unknown flag, throws `bad_args` — the FR-CLI-002 "handled operation error"
 * path (exit 1, message on stderr; a structured `{ok:false,…}` on stdout under
 * `--json`) — with a nearest-option hint (reusing `closestCommand`) when one is
 * close, so `--exitcode` points at `--exit-code` in one line.
 */
function assertKnownFlags(cmd: string, head: string[]): void {
  // Own-property lookup: a plain-object table also "contains" every inherited
  // member (`constructor`, `toString`, `__proto__`, …), which would otherwise be
  // read as a known command and crash `new Set` with a TypeError (issue #483).
  const known = Object.hasOwn(KNOWN_FLAGS, cmd) ? KNOWN_FLAGS[cmd] : undefined;
  if (!known) return; // unknown command → handled by the dispatch default (exit 2)
  const accepted = new Set<string>(known);
  accepted.add('--json'); // parsed globally for every command (see `json` below)
  for (let i = 1; i < head.length; i++) {
    const tok = head[i];
    // A literal operand or positional (incl. a bare `--`, and short tokens like
    // the `-` stdin sentinel or a `-1` vote delta): never a long option.
    if (tok === '--' || !tok.startsWith('--')) continue;
    if (accepted.has(tok)) {
      if (VALUE_FLAGS.has(tok)) i++; // skip its value token (may be flag-shaped)
      continue;
    }
    const near = closestCommand(tok, [...accepted]);
    const hint = near ? ` Did you mean \`${near}\`?` : '';
    throw new NbError('bad_args', `unknown option "${tok}" for \`nb ${cmd}\`.${hint}`);
  }
}

/**
 * Max tokens (command word included) each command reads. A longer argv means
 * the caller left a multi-word lesson/description unquoted, and the fixed
 * positional reads would silently store only its first word (issue #378).
 * `show` and the read commands are deliberately absent, and so is `search`: it
 * builds its own operand list (it extracts `--any`/`--limit` itself) and applies
 * the same check there, capped at `SEARCH_MAX_ARGS` (issue #402).
 */
const MAX_ARGS: Record<string, number> = {
  add: 3,
  merge: 5,
  split: 5,
  rm: 3,
  vote: 4,
  move: 4,
  describe: 3,
};

/** `search <query> [prefix]`: command word + query + optional prefix. */
const SEARCH_MAX_ARGS = 3;

function assertOperandCount(
  cmd: string,
  args: string[],
  // Own-property lookup, as in `assertKnownFlags` (issue #483).
  max: number | undefined = Object.hasOwn(MAX_ARGS, cmd) ? MAX_ARGS[cmd] : undefined,
): void {
  if (max === undefined || args.length <= max) return;
  throw new NbError(
    'bad_args',
    `unexpected extra argument "${args[max]}" for \`nb ${cmd}\` — quote multi-word text as one argument`,
  );
}

/**
 * Per-command help (issue #370): the usage line(s) for `cmd` plus the `notes:`
 * bullets whose first line names it, sliced out of `HELP` so the scoped text can
 * never drift from the full one. Aliases share their canonical command's lines
 * (`ls`/`shelves`/`roles` → `list`; `help`/`version` → the `--help`/`--version`
 * lines). Returns null for a word that is not a known command.
 */
export function scopedHelp(cmd: string): string | null {
  if (!(KNOWN_COMMANDS as readonly string[]).includes(cmd)) return null;
  const tokens = cmd === 'help' ? ['--help'] : cmd === 'version' ? ['--version']
    : ['list', 'ls', 'shelves', 'roles'].includes(cmd) ? ['list', 'ls', 'shelves', 'roles'] : [cmd];
  const usageStart = HELP.indexOf('usage:');
  const notesStart = HELP.indexOf('notes:');
  const docsStart = HELP.indexOf('\ndocs:');
  const usage = HELP.slice(usageStart, notesStart).split('\n').filter((l) => {
    const m = /^ {2}nb (\S+)/.exec(l);
    return m !== null && tokens.includes(m[1]);
  });
  const bullets = HELP.slice(notesStart + 'notes:\n'.length, docsStart).split(/\n(?= {2}- )/);
  const word = new RegExp(`(^|[^\\w-])${cmd}([^\\w-]|$)`);
  const notes = bullets.filter((b) => word.test(b.split('\n')[0]!));
  return [
    `nb ${cmd} — usage:`,
    ...usage,
    ...(notes.length ? ['', 'notes:', ...notes] : []),
    '',
    'nb --help shows every command.',
  ].join('\n');
}

/**
 * Which command's help a call asks for, or undefined when it is not a help
 * request (issue #370). `nb help <command>` and a `--help`/`-h` token after the
 * command word (before a `--` terminator, and never as a value-flag's value)
 * scope help to that command; `null` means the full help text.
 */
function helpRequest(argv: string[]): string | null | undefined {
  const cmd = (argv[0] ?? '').trim();
  const known = (KNOWN_COMMANDS as readonly string[]);
  if (cmd === 'help') return known.includes((argv[1] ?? '').trim()) ? argv[1]!.trim() : null;
  if (!known.includes(cmd) || cmd === 'version') return undefined;
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break;
    if (VALUE_FLAGS.has(tok)) { i++; continue; }
    if (tok === '--help' || tok === '-h') return cmd;
  }
  return undefined;
}

/**
 * Non-blocking new-shelf advisory (issues #354, #404) printed by `add`, `move`
 * (to its target) and `describe`. stderr, so stdout stays pipe-clean; the exit
 * code is unchanged. `consolidateId` is the lesson a `nb move` suggestion would
 * carry; absent (describe) means the new shelf has no lesson to move.
 */
function writeCreatedNote(shelf: string, sim: string[], consolidateId?: string): void {
  process.stderr.write(
    `note: created new shelf "${shelf}"` +
      (sim.length > 0
        ? `; existing shelves with overlapping names: ${sim.join(', ')}` +
          (consolidateId ? ` — if it is the same subject, consolidate with: nb move ${shelf} ${sim[0]} ${consolidateId}` : '')
        : '') +
      '\n',
  );
}

export async function runNbCli(
  argv: string[],
  readStdin: () => Promise<string> = readStdinDefault,
): Promise<number> {
  const cmd = (argv[0] ?? '').trim();
  // `help` and `version` return before the main switch and its shared
  // `finally { logUsage(...) }`, so they would otherwise append NO usage row —
  // breaking the header invariant that every call appends one line, and hiding
  // the classic not-wired symptom (a harness that only ever runs `nb --help`,
  // never a real command, would leave no trace in `nb stats`). Emit a lightweight
  // row here so both the invariant and that diagnostic hold. The logged command
  // is canonicalised to `help`/`version` so every alias (`-h`, no-args, `-v`, …)
  // aggregates under one name in stats. `logUsage` is best-effort (it swallows
  // its own write failures), so logging never requires a writable NB_DIR and
  // never breaks `nb --help`/`--version` on a read-only system. `notebooksDir()`
  // is resolved inline here (not hoisted above these branches) so the `const dir
  // = notebooksDir()` below still marks the end of the pre-switch region the #131
  // HELP-drift guard scans.
  const scoped = helpRequest(argv);
  if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help' || scoped) {
    const t0 = Date.now();
    process.stdout.write((scoped ? scopedHelp(scoped)! : HELP) + '\n');
    logUsage(notebooksDir(), '-', 'help', true, Date.now() - t0);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    const t0 = Date.now();
    process.stdout.write(`nb (agent-notebook) ${pkgVersion()}\n`);
    logUsage(notebooksDir(), '-', 'version', true, Date.now() - t0);
    return 0;
  }

  const dir = notebooksDir();
  const started = Date.now();
  let shelf = '-';
  let ok = false;
  // Richer usage-log fields for this call (entry-level + outcome logging, #67).
  // Each command fills what it produced; `show`/`path`/`shelves`/`stats` leave it
  // empty and `logUsage` writes blanks. `session` is filled by `logUsage` from
  // `NB_SESSION`, so it is not set here.
  const meta: UsageMeta = {};
  // `--` is an end-of-options terminator (issue #277): every token after the
  // first `--` is a literal operand, never a flag. Without it, the unconditional
  // `--json` strip below removed a `--json` token *anywhere* in argv — including
  // an operand the user plainly typed, e.g. `nb add flags "--json"` (recording a
  // glossary line that is literally `--json`) — and `add` then threw a baffling
  // `missing <lesson>` for the lesson they typed (a DP-5 'never mislead'
  // violation). With the terminator a flag-shaped operand is passed explicitly:
  // `nb add flags -- --json`. The terminator and the operands after it are also
  // shielded from the `--reason`/`--note` extraction below.
  //
  // A *trailing* `--` (nothing after it) is NOT a terminator: it escapes nothing,
  // and `vote`'s `--` downvote alias (parseDelta) relies on a bare trailing `--`
  // staying a literal operand. So only a `--` with at least one token after it
  // ends options; `operands` holds the shielded literals, appended after flag
  // parsing so positional indices are unchanged.
  const termIdx = argv.findIndex((a, i) => a === '--' && i < argv.length - 1);
  const head = termIdx === -1 ? argv : argv.slice(0, termIdx);
  const operands = termIdx === -1 ? [] : argv.slice(termIdx + 1);
  // `--json` on a mutation (add/vote/rm/merge) emits the library's structured
  // result object on stdout and nothing else, so a supervisor can branch on
  // `reason`/`score` without regex-parsing the English line. `show` also honors
  // it (emitting a ShowResult); `stats` reads it from its own arg slice; `path`
  // emits a `{dir, shelf, path}` object (issue #185). Strip it before positional
  // parsing (like `stats`, it is a flag, not a shelf/lesson); `shelves` ignores
  // it. Only `head` (pre-`--`) is scanned, so a literal `--json` operand after
  // the terminator is kept. Exit codes are unchanged (a too-long add still exits 1).
  const json = head.includes('--json');
  let args = json ? head.filter((a) => a !== '--json') : head;
  // `--reason <code>` / `--note "<text>"` attach an optional, never-required
  // reason to a mutating op, logged (never stored in the notebook). The ops
  // that take them are the `KNOWN_FLAGS` rows listing `--reason` (see the gate
  // below); the per-op codes are e.g. `merge` (duplicate · other), `rm` (wrong ·
  // obsolete · other), `split` (overloaded · other), `move` (consolidate ·
  // other), while `add` and `describe` take free text only. Pulling them out
  // of `args` BEFORE positional parsing keeps them from being mistaken for a
  // lesson/operand — otherwise `nb describe <shelf> --reason x "text"` would
  // silently store `--reason` as the description (issue #91, a DP-5 violation);
  // `normalizeReason` validates the code against the op's seed-and-grow enum.
  let reasonArg: string | undefined;
  let noteArg: string | undefined;
  try {
    // Refuse a typo'd/misplaced flag (e.g. `nb stats --exitcode`) before any
    // parsing consumes it, so it can never degrade silently (issue #267). Scans
    // `head` only — operands after a `--` terminator stay literals (issue #277).
    assertKnownFlags(cmd, head);
    // The commands that take `--reason`/`--note` are exactly those whose own
    // `KNOWN_FLAGS` row lists `--reason` — one source of truth, so a command
    // cannot pass validation yet have the flag stored as text (issue #487).
    // Own-property lookup, as in `assertKnownFlags` (issue #483).
    if (Object.hasOwn(KNOWN_FLAGS, cmd) && KNOWN_FLAGS[cmd].includes('--reason')) {
      // Inside the try so a malformed flag (e.g. `--reason` with no value)
      // becomes a handled exit-1 error, not an uncaught rejection.
      ({ value: reasonArg, rest: args } = extractOption(args, '--reason'));
      ({ value: noteArg, rest: args } = extractOption(args, '--note'));
      // `extractOption` removes only the FIRST occurrence; a repeat would stay in
      // the positional list and be stored as a lesson/description (issue #378).
      for (const flag of ['--reason', '--note']) {
        if (args.includes(flag)) throw new NbError('bad_args', `${flag} given more than once for \`nb ${cmd}\` — pass it once`);
      }
    }
    // `flagArgs` is the flag-eligible region: the command plus the pre-`--`
    // positionals, with the global `--json`/`--reason`/`--note` already removed.
    // The per-command flag parsers below (`--limit`, `--any` on the read
    // commands) run on THIS slice and re-append `operands` afterwards, so a
    // flag-shaped token after `--` (e.g. `nb search -- --limit`) is read as a
    // positional, never consumed as a flag — the same shielding the global parse
    // above gets by running on `head` (issue #277).
    const flagArgs = args;
    // Append the post-`--` literal operands now, after the global flags have been
    // parsed out of `head`, so a flag-shaped operand reaches its positional slot
    // untouched. A no-op when no `--` terminator was present (`operands` is
    // empty), keeping every existing path byte-for-byte unchanged.
    args = args.concat(operands);
    assertOperandCount(cmd, args);
    switch (cmd) {
      case 'show': {
        // Resolve EVERY shelf positional from the --json-stripped args so
        // `nb show <a> <b> <c>` reads them all in one process (batch read, issue
        // #286) instead of silently dropping all but the first, and so
        // `nb show --json <shelf>` still works (the flag is never a shelf). `need`
        // still rejects a bare `nb show` with no shelf.
        const shelves = args.slice(1);
        need(shelves[0], 'shelf');
        shelf = shelves[0]; // usage-log field: the first shelf (single-shelf behavior unchanged)
        // Record a show of a shelf with no notebook file as `no-shelf` (issue #480),
        // so `nb stats` does not read it as a browse — even after a later `add` in
        // the same session creates the file. Exit stays 0 (see below).
        if (!notebookExists(dir, shelf)) meta.outcome = 'no-shelf';
        if (json) {
          // One shelf → a lone ShowResult object ({ shelf, description, entries })
          // so an agent reads each entry's id/score/text/key without regex-parsing
          // the human output (backward-compatible with issue #87). Two or more →
          // a per-shelf ShowResult[] in one consistent snapshot (issue #286), each
          // entry carrying its `key` so the caller drops exact cross-shelf dupes
          // itself; nb does no cross-shelf dedup or ordering here. Same per-shelf
          // ordering as `render()`.
          // Warn on stderr about a conflicted shelf (issue #333); the JSON on
          // stdout is unchanged and still valid.
          for (const s of shelves) {
            const { conflict } = readShelf(dir, s);
            if (conflict !== null) process.stderr.write(renderConflict('show', s, conflict));
          }
          const out = shelves.length === 1 ? showJson(dir, shelves[0]) : showJsonMany(dir, shelves);
          process.stdout.write(JSON.stringify(out) + '\n');
        } else {
          // Human mode renders each shelf block in order, blank-line separated for
          // a batch, so `nb show a b` never silently drops `b`. A single shelf is
          // byte-for-byte identical to before.
          shelves.forEach((s, i) => {
            if (i > 0) process.stdout.write('\n');
            // One read for both the description header and the rendered lessons
            // (issue #201): this branch used to read the shelf twice
            // (getDescription then render→readEntries).
            const { metaLines, entries, conflict } = readShelf(dir, s);
            // Warn (stderr only) that the shelf needs a merge resolved (issue
            // #333) — the lessons below still render exactly as stored, stdout
            // unchanged, but the reader is told the file is not clean.
            if (conflict !== null) process.stderr.write(renderConflict('show', s, conflict));
            // Print the one-line description (if any) as a header above the lessons,
            // so a reader sees what the notebook is *for* before its contents.
            const descRaw = getMetaValue(metaLines, DESC_KEY);
            const desc = descRaw === null ? null : stripControlChars(descRaw);
            if (desc) process.stdout.write(`# desc: ${desc}\n`);
            // A shelf that was never created (e.g. a typo) must not read as a real
            // empty notebook — that would mislead (DP-5, issue #166). Say "no
            // notebook" on stderr, matching the empty-state convention `list` and
            // `describe` use, and reserve render()'s "(... is empty)" on stdout for
            // a shelf whose file exists but holds no lessons. Not found is not an
            // error, so exit stays 0 (like `describe`'s read path).
            if (!notebookExists(dir, s)) {
              process.stderr.write(`no notebook for shelf "${s}" — run \`nb list\` to see existing shelves\n`);
            } else {
              process.stdout.write(renderEntries(s, entries) + '\n');
              // Copy-paste vote hint (issue #223): the usage audit found ~1 in 5
              // votes failing on a fuzzy TEXT selector while the id was printed
              // right there. Echo a ready-to-run command with the shelf already
              // filled, so the reflect step votes by id (the stable token above)
              // — and can batch several — instead of by ambiguous substring. It is
              // a `#` comment line (never a lesson, never written to the file) and
              // is suppressed under `--json`, which stays a lone ShowResult object.
              // Only shown when there is something to vote on.
              if (entries.length > 0) {
                process.stdout.write(
                  `# vote by id: nb vote ${s} <id> +1|-1  ·  several at once: nb vote ${s} <id1,id2,…> +1\n`,
                );
              }
            }
          });
        }
        break;
      }
      case 'stale': {
        // Read-only curation aid (issue #240, #223-F3): list the lessons
        // eviction would drop first — lowest score, ties → stalest — so the
        // retrospective can downvote/`rm` the weakest by id. It never writes.
        // Pull out `--limit N` BEFORE positionals (forgiving parse, identical to
        // `search`/`list`): an unparseable value warns on stderr and falls back
        // to the default rather than rejecting, keeping stdout/JSON clean. Parse
        // from the pre-`--` region and re-append `operands` so a flag-shaped
        // operand after `--` is not consumed as the flag (issue #277).
        const { value: limitRaw, rest: staleRest } = extractOption(flagArgs, '--limit');
        const staleArgs = staleRest.concat(operands);
        let limit = STALE_DEFAULT_LIMIT;
        if (limitRaw !== undefined) {
          if (/^\d+$/.test(limitRaw.trim())) {
            limit = Number.parseInt(limitRaw, 10);
          } else {
            warnDefaultedFlag(
              json,
              `nb ${cmd}: unrecognized --limit '${limitRaw}' (use a non-negative integer); showing ${STALE_DEFAULT_LIMIT}\n`,
              { command: cmd, flag: '--limit', value: limitRaw, usedDefault: STALE_DEFAULT_LIMIT },
            );
          }
        }
        shelf = need(staleArgs[1], 'shelf');
        const staleConflict = readShelf(dir, shelf).conflict;
        if (staleConflict !== null) process.stderr.write(renderConflict('stale', shelf, staleConflict));
        const result = staleCandidates(dir, shelf, limit);
        if (json) {
          // Lone StaleResult object on stdout (same contract as `show --json`).
          process.stdout.write(JSON.stringify(result) + '\n');
        } else if (!result.exists) {
          // A never-created shelf must not read as a real empty notebook (DP-5,
          // issue #166) — mirror `show`'s stderr message; not found is exit 0.
          process.stderr.write(`no notebook for shelf "${shelf}" — run \`nb list\` to see existing shelves\n`);
        } else if (result.total === 0) {
          process.stdout.write(`(notebook for shelf "${shelf}" has no lessons to cull)\n`);
        } else {
          process.stdout.write(
            `# stale: cull candidates on "${shelf}" — most disposable first (lowest score, then stalest)\n`,
          );
          for (const e of result.entries) {
            const s = e.score >= 0 ? `+${e.score}` : `${e.score}`;
            process.stdout.write(`${e.id}  [${s}]  ${e.text}\n`);
          }
          // Actionable footer: a ready-to-run downvote/rm with the shelf filled,
          // so the reflect step acts by id (printed above) instead of a fuzzy
          // text selector. Says "N of M" so a truncated list is never mistaken
          // for the whole shelf. A `#` comment line (never a lesson); suppressed
          // under `--json`, which stays a lone StaleResult object.
          process.stdout.write(
            `# showing ${result.entries.length} of ${result.total} · cull by id: nb vote ${shelf} <id> -1  ·  nb rm ${shelf} <id> --reason obsolete\n`,
          );
        }
        break;
      }
      case 'add': {
        shelf = need(args[1], 'shelf');
        // A lesson operand of `-` means "read the lesson from stdin" so a
        // supervising agent that wrote a lesson into a pipe can hand it over
        // without shell-quoting it. We read exactly one line (see
        // `readOneLine`): multi-line input is refused rather than flattened,
        // because `sanitizeLesson` would otherwise collapse the newlines into a
        // single space and silently store a run-together lesson — violating the
        // "one entry = one line" contract. The result still goes through the
        // unchanged `addEntry`, so caps, dedup, and eviction behave identically.
        let lesson = need(args[2], 'lesson');
        if (lesson === '-') lesson = readOneLine(await readStdin());
        const r = await addEntry(dir, shelf, lesson);
        // Record which entry was touched and how it landed BEFORE the output
        // branch below, which can `throw`/`return` on 'too-long' — the finally
        // still logs, so meta must already be set.
        meta.entries = r.id ? [r.id] : [];
        meta.outcome = r.reason === 'added' ? 'accepted' : r.reason === 'duplicate' ? 'dedup-blocked' : r.reason;
        // A too-long add exits non-zero on BOTH paths below (the `--json` branch
        // returns 1, the human branch throws), so record its error class here —
        // before either path — so the shared `finally` logs it (issue #176). An
        // `empty` add is NOT an error (it exits 0), so it gets no class.
        if (r.reason === 'too-long') meta.errorClass = 'too_long';
        if (r.collidedId) meta.collided = r.collidedId;
        // An accepted add that resembled an existing entry records that entry id
        // in the same `collided` column; `outcome` stays `accepted`, so the pair
        // (outcome=accepted ∧ collided≠'') is the measurable near-duplicate /
        // paraphrase-miss signal, distinct from a hard `dedup-blocked`.
        else if (r.nearId) meta.collided = r.nearId;
        recordEvictionUsage(meta, r);
        // `add` has no seeded enum yet (free text only): a `--note` records
        // free text, and a stray `--reason` buckets to `other` so its vocabulary
        // can emerge from mined notes. Set BEFORE the output branch below, which
        // can `throw`/`return` on 'too-long' — the finally still logs meta.
        recordReasonUsage(meta, 'add', reasonArg, noteArg);
        if (json) {
          // One result object on stdout; `too-long` keeps exit 1 (below) while
          // still emitting its `reason`, so a supervisor sees why it failed.
          process.stdout.write(JSON.stringify(r) + '\n');
          if (r.reason === 'too-long') return 1;
        } else if (r.reason === 'duplicate') process.stdout.write(`skipped (exact duplicate already present) — ${plural(r.size, 'line')}\n`);
        else if (r.reason === 'empty') process.stdout.write('skipped (empty lesson)\n');
        else if (r.reason === 'too-long') throw new Error(`lesson too long: ${r.length} chars, ${r.overflow} over the ${maxChars()} limit — trim at least ${r.overflow} and retry as ONE complete line; it was NOT truncated or stored.`);
        else {
          process.stdout.write(`added — ${plural(r.size, 'line')}`);
          if (r.evicted) {
            // A cap decrease trims the shelf all the way down in one call, so
            // report the extra evictions rather than hiding them (issue #306).
            const more = r.evictedAll.length - 1;
            process.stdout.write(
              ` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text}${more > 0 ? ` +${plural(more, 'more line')}` : ''})`,
            );
          }
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          process.stdout.write('\n');
          // Non-blocking near-duplicate advisory: the lesson WAS stored (stdout
          // above), and this hint goes to stderr so stdout stays pipe-clean. It
          // surfaces the resembling lesson at the moment of re-derivation, so the
          // agent can consolidate if it is the same lesson reworded.
          if (r.nearId && r.nearEvicted) {
            // The resembling lesson is the one this add just evicted, so it is no
            // longer on the shelf: a `nb merge` naming it would fail (issue #451).
            process.stderr.write(`note: resembles a lesson this add evicted: "${r.nearText}"\n`);
          } else if (r.nearId) {
            process.stderr.write(
              `note: resembles ${r.nearId} "${r.nearText}" — if that is the same lesson reworded, ` +
                `consolidate with: nb merge ${shelf} ${r.nearId} ${r.id} "<combined>"\n`,
            );
          }
          // Non-blocking new-shelf advisory (issue #354): the one outcome of
          // `add` the agent is not otherwise told about. stderr, so stdout stays
          // pipe-clean; the exit code is unchanged.
          if (r.created) writeCreatedNote(shelf, r.similarShelves ?? [], r.id);
        }
        break;
      }
      case 'vote': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
        const delta = parseDelta(need(args[3], '+1|-1'));
        requireExistingShelf(dir, shelf);
        // Batch form: a comma-separated list of ≥2 BARE HEX ids votes them all
        // with one delta, one lock, one write — the end-of-session retro
        // promoting several lessons at once (N calls → 1). It is id-only on
        // purpose: a single token, or any comma-part that is not a bare hex id,
        // stays a single (possibly text) selector, so `nb vote s "build, then
        // test" +1` still resolves as one substring and the old behavior is
        // untouched.
        const ids = parseVoteIdList(selector);
        if (ids) {
          const sign = delta > 0 ? '+1' : '-1';
          const results = await voteMany(dir, shelf, ids, delta);
          const landed = results.filter((r) => r.id !== undefined);
          const failed = results.filter((r) => r.error !== undefined);
          if (json) {
            process.stdout.write(JSON.stringify(results) + '\n');
          } else {
            for (const r of landed) process.stdout.write(`${sign} → [${fmt(r.score as number)}] ${r.text}\n`);
            // Failures go to stderr so stdout stays a clean list of the votes
            // that landed; the first line of each selector's error is enough.
            for (const r of failed) {
              process.stderr.write(`✗ ${r.selector}: ${(r.error as string).split('\n')[0]}\n`);
            }
          }
          if (landed.length === 0) {
            // Nothing landed — surface it as an error (non-zero, logged as err)
            // like a single failed vote, so a wholly-wrong batch is not silent.
            // CRUCIAL: leave meta.outcome/entries BLANK here. `stats()` keys vote
            // engagement on `outcome` alone (not the ok flag), so stamping
            // 'up'/'down' on a row where no vote landed would mark the session
            // "engaged", count a phantom upvote, and suppress the zero-engagement
            // diagnosis — exactly the single-vote failure path's blank-outcome
            // behavior must be matched. So outcome/entries are set only below.
            meta.errorClass = 'no_match';
            return 1;
          }
          // At least one vote landed → best-effort success (exit 0). Record the
          // touched ids and outcome ONLY now (a no-match above logs neither), so
          // the usage row mirrors the single-vote success path.
          meta.entries = landed.map((r) => r.id as string);
          meta.outcome = delta > 0 ? 'up' : 'down';
          // A ≥1-landed batch still exits 0, but any stale ids it skipped are real
          // selector misses the err-rate table (keyed on ok=false) can't see.
          // Record the count so `nb stats` folds them into the vote error-cause
          // readout instead of laundering them out (issue #310). It is a dedicated
          // miss counter, NOT errorClass, so the partial success keeps exit 0.
          if (failed.length > 0) meta.misses = failed.length;
          // Any per-id failures were already reported on stderr above.
          break;
        }
        const r = await vote(dir, shelf, selector, delta);
        meta.entries = [entryId(r.text)];
        meta.outcome = delta > 0 ? 'up' : 'down';
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`${delta > 0 ? '+1' : '-1'} → [${fmt(r.score)}] ${r.text}\n`);
        break;
      }
      case 'merge': {
        shelf = need(args[1], 'shelf');
        const a = need(args[2], 'idA');
        const b = need(args[3], 'idB');
        const merged = need(args[4], 'merged lesson');
        const r = await merge(dir, shelf, a, b, merged);
        meta.entries = [...(r.sources ?? []), ...(r.id ? [r.id] : [])];
        meta.outcome = 'merged';
        recordEvictionUsage(meta, r);
        // Reason lives in the usage log only (merge enum: duplicate · other).
        recordReasonUsage(meta, 'merge', reasonArg, noteArg);
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else {
          process.stdout.write(`merged two entries into one — ${plural(r.size, 'line')}`);
          if (r.evicted) {
            // A cap decrease trims the shelf all the way down in one call, so
            // report the extra evictions rather than hiding them (issue #306).
            const more = r.evictedAll.length - 1;
            process.stdout.write(
              ` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text}${more > 0 ? ` +${plural(more, 'more line')}` : ''})`,
            );
          }
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          // A third lesson identical to the merged text was dropped; say so, with
          // the score it held (the merged entry does not inherit it — issue #454).
          for (const a of r.absorbed) {
            process.stdout.write(` (also absorbed [${fmt(a.score)}] ${a.text}, identical to the merged lesson)`);
          }
          process.stdout.write('\n');
        }
        break;
      }
      case 'split': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
        const lessonA = need(args[3], 'lessonA');
        const lessonB = need(args[4], 'lessonB');
        requireExistingShelf(dir, shelf);
        const r = await split(dir, shelf, selector, lessonA, lessonB);
        // Log the source + both produced ids, the outcome, and the reason/note —
        // the reason lives in the usage log only, never in the notebook.
        meta.entries = [r.source, ...r.ids];
        meta.outcome = 'split';
        recordEvictionUsage(meta, r);
        recordReasonUsage(meta, 'split', reasonArg, noteArg);
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else {
          process.stdout.write(`split one entry into two — ${plural(r.size, 'line')}`);
          if (r.evicted) {
            // A cap decrease trims the shelf all the way down in one call, so
            // report the extra evictions rather than hiding them (issue #306).
            const more = r.evictedAll.length - 1;
            process.stdout.write(
              ` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text}${more > 0 ? ` +${plural(more, 'more line')}` : ''})`,
            );
          }
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          process.stdout.write('\n');
        }
        break;
      }
      case 'rm': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
        requireExistingShelf(dir, shelf);
        const r = await remove(dir, shelf, selector);
        meta.entries = [entryId(r.text)];
        meta.outcome = 'removed';
        // Reason lives in the usage log only (rm enum: wrong · obsolete · other).
        recordReasonUsage(meta, 'rm', reasonArg, noteArg);
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`removed — [${fmt(r.score)}] ${r.text}\n`);
        break;
      }
      case 'move': {
        const from = need(args[1], 'from-shelf');
        const to = need(args[2], 'to-shelf');
        const selector = need(args[3], 'id|query');
        // Usage log: attribute the call to the SOURCE shelf (the one the entry
        // leaves); the moved id is in `meta.entries`, so a reader sees which
        // lesson relocated even though the op spans two shelves.
        shelf = from;
        // Only the SOURCE is guarded: `move` auto-creates the target like `add`,
        // so a never-created target is intentional, but a never-created source is
        // the same typo the core would mislabel "is empty" (issue #200).
        requireExistingShelf(dir, from);
        const r = await move(dir, from, to, selector);
        meta.entries = [r.id];
        meta.outcome = r.reason === 'moved' ? 'moved' : 'move-blocked';
        if (r.collidedId) meta.collided = r.collidedId;
        recordEvictionUsage(meta, r);
        // Reason lives in the usage log only (move enum: consolidate · other).
        recordReasonUsage(meta, 'move', reasonArg, noteArg);
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else if (r.reason === 'duplicate') {
          process.stdout.write(
            `skipped (a near-duplicate already lives in "${to}") — "${from}" unchanged, "${to}" still ${plural(r.toSize, 'line')}\n`,
          );
        } else {
          process.stdout.write(
            `moved [${fmt(r.score)}] ${r.text} — "${from}" now ${plural(r.fromSize, 'line')}, "${to}" now ${plural(r.toSize, 'line')}`,
          );
          if (r.evicted) {
            const more = r.evictedAll.length - 1;
            process.stdout.write(
              ` (evicted lowest-scored from "${to}": [${fmt(r.evicted.score)}] ${r.evicted.text}${more > 0 ? ` +${plural(more, 'more line')}` : ''})`,
            );
          }
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest in "${to}" −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          process.stdout.write('\n');
        }
        if (r.created) writeCreatedNote(to, r.similarShelves ?? [], r.id);
        break;
      }
      case 'describe': {
        shelf = need(args[1], 'shelf');
        // With a text operand → set the description; without one → print the
        // current description. Use `args` (the `--json` flag already stripped),
        // so `nb describe <shelf> --json` reads rather than setting the
        // description to the literal "--json". An empty string is still a
        // *present* operand (clears the description), so we branch on presence
        // (args.length), not on emptiness.
        if (args.length > 2) {
          // A text operand of `-` means "read the description from stdin" — the
          // same escape hatch `add -` offers (issue #38), so a supervising agent
          // can pipe a long or punctuation-heavy description without
          // shell-quoting it. Read exactly one line via `readOneLine`
          // (multi-line input is refused, not flattened), identical to `add -`.
          // `-` is distinct from the present-but-empty operand `""`, which still
          // clears — so we only reach stdin when the operand is literally `-`.
          let text = args[2]!;
          if (text === '-') text = readOneLine(await readStdin());
          const r = await setDescription(dir, shelf, text);
          meta.outcome = r.desc === null ? 'desc-cleared' : 'described';
          // `--reason`/`--note` are stripped above (so they can't be mistaken
          // for the description text); record them in the usage log, never in
          // the notebook — `describe` has no seeded enum, so a stray code
          // buckets to `other` with its text kept in the note (like `add`).
          recordReasonUsage(meta, 'describe', reasonArg, noteArg);
          if (json) process.stdout.write(JSON.stringify(r) + '\n');
          else if (r.desc === null) process.stdout.write(`description cleared for shelf "${shelf}"\n`);
          else process.stdout.write(`description set for shelf "${shelf}": ${r.desc}\n`);
          if (r.created) writeCreatedNote(shelf, r.similarShelves ?? []);
        } else {
          const descRaw = getDescription(dir, shelf);
          const desc = descRaw === null ? null : stripControlChars(descRaw);
          if (json) process.stdout.write(JSON.stringify({ role: shelf, shelf, desc, set: false }) + '\n');
          else if (desc) process.stdout.write(desc + '\n');
          else process.stderr.write(`no description set for shelf "${shelf}" — set one with \`nb describe ${shelf} "<text>"\`\n`);
        }
        break;
      }
      case 'search': {
        // The demoted keyword fallback (issue #82). Spans notebooks, so the usage-log shelf column
        // stays `-` (like `list`). `--json` is already stripped; pull out the
        // boolean `--any` (OR instead of AND), leaving the query at args[1] and an
        // optional positional name prefix at args[2]. Parse flags from `flagArgs`
        // (the pre-`--` region) and re-append `operands`, so a query/prefix that is
        // literally `--any`/`--limit` after `--` stays a positional (issue #277).
        const any = flagArgs.includes('--any');
        const withoutAny = any ? flagArgs.filter((a) => a !== '--any') : flagArgs;
        // Pull out `--limit N` BEFORE reading positionals, so its value token is
        // never mistaken for the name prefix. Forgiving parse, identical to
        // `list`: an unparseable value warns on stderr (stdout/JSON stays clean)
        // and falls back to the default rather than rejecting.
        const { value: limitRaw, rest } = extractOption(withoutAny, '--limit');
        const searchArgs = rest.concat(operands);
        let limit = SEARCH_DEFAULT_LIMIT;
        if (limitRaw !== undefined) {
          if (/^\d+$/.test(limitRaw.trim())) {
            limit = Number.parseInt(limitRaw, 10);
          } else {
            warnDefaultedFlag(
              json,
              `nb ${cmd}: unrecognized --limit '${limitRaw}' (use a non-negative integer); showing ${SEARCH_DEFAULT_LIMIT}\n`,
              { command: cmd, flag: '--limit', value: limitRaw, usedDefault: SEARCH_DEFAULT_LIMIT },
            );
          }
        }
        assertOperandCount('search', searchArgs, SEARCH_MAX_ARGS);
        const query = need(searchArgs[1], 'query');
        const prefix = searchArgs[2]; // optional positional prefix (undefined → all notebooks)
        // A prefix that no shelf name starts with scans nothing, which is not a coverage
        // gap (issue #402): usually the caller dropped the quotes around a multi-word
        // query. Detect it here so it is logged as `no-shelf`, not `no-match`.
        const noShelf =
          prefix !== undefined && !listShelves(dir).some((r) => r.startsWith(prefix));
        const result = search(dir, query, { prefix, any, limit });
        // Log the search so the `failed-search → add` gap-sensor can read it back:
        // outcome `match`/`no-match` plus the query in `note` (no new log column).
        // A no-match is NOT an error — the command succeeded, it just found
        // nothing (exit 0, like a dedup-blocked add), so `ok` is set below. A query
        // with no searchable terms (e.g. all whitespace) is logged as `no-terms`,
        // NOT `no-match`, so an empty query can never masquerade as a coverage gap
        // (the `failed-search` signal keys on `no-match`) — DP-5, never mislead.
        // `result.total` is the FULL pre-`limit` match count, so `--limit` (even
        // `0`) never flips a real match into a `no-match` coverage gap (issue #186).
        // A no-match that exists only because a shelf was skipped is NOT a
        // coverage gap (issue #332): a skipped shelf may hold the hit, so log it
        // as `skipped` (never `no-match`, which the `failed-search` signal keys
        // on) rather than prompting a spurious `nb add`. A real match still logs
        // `match`; an empty query still logs `no-terms`.
        meta.outcome =
          result.terms.length === 0
            ? 'no-terms'
            : result.total > 0
              ? 'match'
              : result.skipped.length > 0
                ? 'skipped'
                : noShelf
                  ? 'no-shelf'
                  : 'no-match';
        meta.note = query;
        // Record WHICH entry ids this search surfaced (issue #114 — surfacing
        // provenance). Reuses the existing `entries` column (no new column), so a
        // later upvote on one of these ids in the same session reads back as a
        // PULL (the agent reached it by search), distinguishing it from a PUSH
        // (arrived unbidden) for the serendipity metric. A `no-match` has no hits,
        // so `entries` stays empty and the `failed-search → add` gap-sensor is
        // untouched. The loop anomaly detector deliberately keeps treating a
        // `search` as entry-less (see `stats()`), so this does not change it.
        // `surfacedIds` is the FULL pre-`limit` set, so the provenance (and the
        // serendipity proxy that joins on it) stays independent of `--limit`.
        meta.entries = result.surfacedIds;
        if (json) {
          // Keep healthy `--json` output byte-identical: the additive `skipped`
          // field (issue #332) is emitted only when a shelf was actually skipped.
          process.stdout.write(
            JSON.stringify(
              result.skipped.length > 0 || result.conflicts.length > 0
                ? result
                : { terms: result.terms, groups: result.groups, total: result.total, surfacedIds: result.surfacedIds },
            ) + '\n',
          );
          // Same stderr warning as the text path (issue #333); stdout stays JSON.
          process.stderr.write(renderConflicts('search', result.conflicts));
        } else {
          const { out, err } = renderSearch(query, any, result, prefix, noShelf);
          if (out) process.stdout.write(out);
          if (err) process.stderr.write(err);
        }
        break;
      }
      case 'stats': {
        // Flags come from the `--`-aware `flagArgs` (global `--json` already
        // stripped), so tokens after the terminator are never read as flags
        // (issue #302). Post-`--` operands stay eligible as the shelf positional.
        const rest = flagArgs.slice(1);
        // Opt-in health gate (#129): with --exit-code, a window holding >=1
        // anomaly exits non-zero (3 — distinct from 1=handled error /
        // 2=unknown command) so `nb stats --exit-code >/dev/null || alert` is a
        // drop-in cron/CI check. Without the flag the command always exits 0,
        // exactly as before (no breaking change). `--exit-code` starts with
        // `--`, so it is never mistaken for the shelf positional below, and it
        // takes no value, so it never shifts the `--since` value index.
        const wantExitCode = rest.includes('--exit-code');
        const sinceIdx = rest.indexOf('--since');
        const sinceVal = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;
        // Share `nb add`'s refusal to silently mislead: a mistyped --since
        // otherwise falls back to 7d while the user believes they filtered.
        // Warn (naming the accepted format and window used), then proceed with
        // the default rather than reject — the least-surprising, forgiving path.
        if (sinceIdx >= 0 && !isValidWindow(sinceVal)) {
          warnDefaultedFlag(
            json,
            `nb stats: unrecognized --since '${sinceVal ?? ''}' (use Nd/Nh/Nm); showing 7d\n`,
            { command: 'stats', flag: '--since', value: sinceVal ?? '', usedDefault: '7d' },
          );
        }
        const windowMs = sinceIdx >= 0 ? parseWindowMs(sinceVal) : undefined;
        const maybeShelf =
          rest.find((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1)) ??
          operands.find((a) => !a.startsWith('--'));
        shelf = maybeShelf ?? '-';
        // Compute the report once: both the --json dump and the human render
        // consume it, and the --exit-code gate reads its anomaly count.
        const rep = stats(dir, { shelf: maybeShelf, windowMs });
        // A shelf operand that names a shelf never created is almost always a
        // typo, yet `stats` (unlike the mutations, #200, and `show`, #166) never
        // validated it — a misspelling produced a plausible, empty report that
        // reads exactly like a real shelf gone silent, a wrong conclusion in a
        // command whose job is to surface unused shelves (issue #341). Keep the
        // exit code and stdout byte-identical (this is advisory only) and print
        // one stderr note. "No rows for this shelf" must ignore the rows `stats`
        // itself logs (the shared `finally` records every call under the operand
        // as its shelf), or the note would fire only on the first run and a
        // repeat of the same typo would go quiet. So count only non-`stats`
        // commands: a retired shelf with real history (add/vote/...) has such rows
        // and is never flagged.
        // An unsafe shelf name makes `notebookExists` throw; skip the note so the
        // advisory check can't turn a tolerated bad operand into a new error.
        if (maybeShelf && !rep.perCommand.some((c) => c.command !== 'stats' && c.calls > 0)) {
          let exists = true;
          try {
            exists = notebookExists(dir, maybeShelf);
          } catch {
            // unsafe shelf name — leave stats' existing forgiving behavior alone
          }
          if (!exists) {
            const near = closestShelf(maybeShelf, listShelves(dir));
            const hint = near ? ` — did you mean "${near}"?` : '';
            process.stderr.write(`nb stats: no shelf named "${maybeShelf}"${hint}\n`);
          }
        }
        // `--json` emits the raw StatsReport (stable, machine-readable) so a
        // supervising agent can act on a loop/went-silent/high-error-rate
        // anomaly without regex-parsing the human table. The --since warning
        // above stays on stderr, keeping stdout pure JSON.
        if (json) {
          process.stdout.write(JSON.stringify(rep) + '\n');
        } else {
          process.stdout.write(renderStats(rep, maybeShelf) + '\n');
        }
        // Report any shelf the inventory skipped (issue #332) on stderr, so the
        // health scan still succeeds but never hides why a shelf is missing.
        const statsSkip = renderSkipped('stats', rep.skipped);
        if (statsSkip) process.stderr.write(statsSkip);
        // Warn about any shelf holding a merge conflict (issue #333), same rule.
        process.stderr.write(renderConflicts('stats', rep.conflicts));
        // The command itself succeeded (stats read cleanly); the usage log must
        // record that, so set `ok` before the opt-in anomaly exit returns early.
        ok = true;
        if (wantExitCode && rep.anomalies.length > 0) return 3;
        break;
      }
      case 'doctor': {
        // Strictly read-only (issue #338): no lock, no shelf write; the shared
        // `finally` still appends its one standard usage row (shelf column `-`).
        // Like `stats --exit-code`, the gate is opt-in: without the flag the
        // command exits 0 even with findings.
        const rep = doctor(dir);
        if (json) process.stdout.write(JSON.stringify({ schemaVersion: rep.schemaVersion, shelves: rep.shelves, findings: rep.findings }) + '\n');
        else process.stdout.write(renderDoctor(rep, dir) + '\n');
        ok = true;
        if (flagArgs.slice(1).includes('--exit-code') && rep.findings.length > 0) return 3;
        break;
      }
      case 'path': {
        // Read-only on notebook state (like `show`/`stats`, it still appends one
        // usage row via the shared `finally`): expose the file layout the
        // plain-text promise relies on, so nobody has to hard-code
        // `$NB_DIR | ~/.agent-notebook/notebooks/<shelf>.md`. Output is a BARE path
        // (no decoration) so it pipes into `cat`/`$(...)`.
        //
        // Read from `args` (the `--json` flag already stripped upstream), NOT the
        // raw `argv` — otherwise `nb path --json` is silently taken as a shelf
        // *named* `--json` and prints `<dir>/--json.md` (issue #185).
        const maybeShelf = args[1];
        // The resolved FILE this invocation points at, or null when it resolves to
        // the notebooks dir itself (the no-shelf case). `dir` is always the
        // notebooks dir; `shelfName` is the shelf, or null when none.
        let file: string | null = null;
        let shelfName: string | null = null;
        if (maybeShelf === '--usage') {
          // `--usage` resolves the internal usage-log path (issue #169) so a
          // supervisor can tail/rotate/back-up it without hard-coding
          // `.nb-usage.log`. A `--`-prefixed flag can never be a shelf name
          // (assertSafeShelf rejects it), so it can't collide with the branch
          // below. Still a bare path (no decoration), so it pipes into tail/$(...).
          file = usageFile(dir);
        } else if (maybeShelf == null || maybeShelf === '') {
          // No shelf — resolves to the notebooks dir itself (file stays null).
        } else {
          shelf = maybeShelf;
          shelfName = maybeShelf;
          assertSafeShelf(shelf); // reuse the existing escape-proof shelf check
          file = join(dir, `${shelf}.md`);
        }
        if (json) {
          // Mirror `describe --json` / `list --json`: one object on stdout so a
          // supervisor can read the notebooks dir (and resolved file) as stable
          // fields instead of special-casing `path`, the one read command that
          // used to emit only a bare string (issue #185).
          process.stdout.write(JSON.stringify({ dir, shelf: shelfName, path: file }) + '\n');
        } else {
          // Bare path, byte-for-byte unchanged: the resolved file, or the dir.
          process.stdout.write((file ?? dir) + '\n');
        }
        break;
      }
      case 'config': {
        // Read-only introspection (issue #188): print every effective, post-clamp
        // tunable as `name=value`, each read from the SAME live getter the hot
        // path uses, so an operator never has to re-derive a value by hand from
        // the env var + its default + its clamp. Then a string env section (issue
        // #312) surfaces the three behavior-critical NB_* vars — NB_DIR,
        // NB_SESSION, NB_ASCII — that the numeric table structurally can't hold
        // but that most often explain a misbehaving deployment. Scoped to
        // CONFIGURATION (the knobs), deliberately distinct from `nb stats`
        // (usage/anomalies/engagement). The shared `finally` appends its one usage
        // row; the shelf column stays `-` because the command reads global config,
        // not a shelf.
        const rows = effectiveConfig();
        const envRows = environmentRows();
        const unknown = unknownEnvVars();
        // Per-repository on/off state (issue #514), resolved for the working directory.
        const enabledState = resolveEnabled();
        if (json) {
          // One object keyed by tunable name; each carries the effective value,
          // its source (env/default/derived), and the env var that overrides it,
          // so a supervisor can branch on the live value without regex-parsing
          // the human lines. The value is always the post-clamp effective value.
          // Issue #336 adds two ADDITIVE fields: `status` (honored/clamped/
          // ignored/how the env value was resolved — `null` when the var is unset)
          // and `rawValue` (the raw env string, `null` when unset), so a consumer
          // can tell an in-force override from one that was rewritten or dropped.
          const obj: Record<string, { value: number; source: ConfigSource; env: string | null; status: ConfigStatus | null; rawValue: string | null }> = {};
          for (const r of rows) {
            obj[r.name] = { value: r.value, source: configSource(r.env), env: r.env, status: r.status, rawValue: r.rawValue };
          }
          // The string env vars live under a dedicated `environment` key, keyed by
          // the var name, so the 14 numeric rows keep their exact shape and keys —
          // the --json contract stays backward-compatible (a NEW section, not a
          // changed type on an existing row; issue #312). Issue #336 adds a second
          // new top-level `unrecognized` array (informational only) alongside it.
          const environment: Record<string, { value: string; source: ConfigSource }> = {};
          for (const r of envRows) environment[r.name] = { value: r.value, source: configSource(r.name) };
          const unrecognized = unknown.map((u) => ({ name: u.name, suggestion: u.suggestion ?? null }));
          // Issue #514 adds a third top-level key, `enabled`, with the on/off state
          // for this directory and the input that decided it.
          const enabled = {
            value: stateWord(enabledState),
            source: enabledState.source,
            origin: enabledState.origin,
            warning: enabledState.warning,
          };
          process.stdout.write(JSON.stringify({ ...obj, environment, enabled, unrecognized }) + '\n');
        } else {
          const { out } = renderConfig(rows, envRows, unknown, enabledState);
          process.stdout.write(out);
        }
        break;
      }
      case 'enabled': {
        // Per-repository on/off (issue #514): resolve NB_ENABLED, then
        // `git config nb.enabled` in the working directory, then the default (on).
        // Read-only and fail-open. The hooks compare stdout to the literal word
        // `off`, so the plain output is exactly `on` or `off`; `--why` appends the
        // deciding input on the same line. Exit 0 either way.
        const st = resolveEnabled();
        if (json) {
          process.stdout.write(
            JSON.stringify({ enabled: st.enabled, state: stateWord(st), source: st.source, value: st.value, origin: st.origin, warning: st.warning }) + '\n',
          );
        } else {
          const why = flagArgs.slice(1).includes('--why');
          process.stdout.write(why ? `${stateWord(st)} (${describeSource(st)})\n` : `${stateWord(st)}\n`);
          if (!why && st.warning !== null) process.stderr.write(`nb enabled: warning: ${st.warning}\n`);
        }
        break;
      }
      case 'list':
      case 'ls':
      case 'shelves':
      case 'roles': {
        // The notebook index (issue #71): one richest-first line per notebook —
        // name, lesson count, and description — so a caller can pick WHICH
        // notebook to open without reading any of them. `ls`, `shelves` and `roles` are
        // aliases (`roles`, now deprecated, replaced the old plain-stems listing, matching the
        // richer format the kookr `nb` shim already bolted on). Read-only — it
        // still appends one usage row via the shared `finally`; the logged shelf stays `-`
        // because the command spans notebooks rather than acting on one.
        // `--json` is already stripped; pull out `--limit` from the pre-`--`
        // region and re-append `operands`, leaving an optional positional name
        // prefix as args[1] (a literal `--limit` prefix after `--` is not consumed
        // as the flag — issue #277).
        const { value: limitRaw, rest: listRest } = extractOption(flagArgs, '--limit');
        const listArgs = listRest.concat(operands);
        let limit = LIST_DEFAULT_LIMIT;
        let explicitLimitGiven = false;
        if (limitRaw !== undefined) {
          // Forgiving like `stats --since`: an unparseable --limit warns on
          // stderr (stdout/JSON stays clean) and falls back to the default,
          // rather than rejecting — the least-surprising path.
          if (/^\d+$/.test(limitRaw.trim())) {
            limit = Number.parseInt(limitRaw, 10);
            explicitLimitGiven = true;
          } else {
            warnDefaultedFlag(
              json,
              `nb ${cmd}: unrecognized --limit '${limitRaw}' (use a non-negative integer); showing ${LIST_DEFAULT_LIMIT}\n`,
              { command: cmd, flag: '--limit', value: limitRaw, usedDefault: LIST_DEFAULT_LIMIT },
            );
          }
        }
        const prefix = listArgs[1]; // optional positional name prefix (undefined → all)
        if (json) {
          // Keep healthy `--json` output byte-identical: the additive `skipped`
          // field (issue #332) is emitted only when a shelf was actually skipped.
          const listing = listNotebooks(dir, { prefix, limit });
          process.stdout.write(
            JSON.stringify(
              listing.skipped.length > 0 || listing.conflicts.length > 0
                ? listing
                : { dir: listing.dir, total: listing.total, rows: listing.rows },
            ) + '\n',
          );
          process.stderr.write(renderConflicts('list', listing.conflicts));
        } else if (!resolveEnabled().enabled) {
          // Slice 2 of issue #514: an instruction-only setup (Codex CLI, or a
          // contract with no hooks) has no hook to ask `nb enabled`, so the
          // agent's own `nb list` answers "off here" in place of the index. One
          // unindented line (shell completion reads only indented rows), exit 0.
          // `--json` is left out of this on purpose: it is the scripts' surface.
          // A failed check is not printed here: it fails open, so the index shows.
          meta.outcome = 'off';
          process.stdout.write(`${LIST_OFF_LINE}\n`);
        } else {
          const { out, err } = renderList(dir, prefix, limit, explicitLimitGiven);
          if (out) process.stdout.write(out);
          if (err) process.stderr.write(err);
        }
        break;
      }
      case 'completion': {
        // Print a static, dependency-free shell-completion script to stdout
        // (issue #187). The shell (`bash`/`zsh`) is a required operand, so a
        // missing one is a handled bad-args error (exit 1) and an unknown shell
        // is likewise exit 1 — never the exit-2 unknown-command path. Read-only
        // on notebook state; the shared `finally` appends its one usage row.
        const shell = need(args[1], 'shell');
        process.stdout.write(completionScript(shell));
        break;
      }
      default: {
        // Forgiving-not-rejecting (like a bad --since/--limit): if the input is
        // an obvious typo of a real command, point at the nearest one so a `nb
        // stat` recovers in one line instead of a round-trip to --help. Exit
        // stays 2 and the --help pointer stays put (issue #171).
        const suggestion = closestCommand(cmd);
        const hint = suggestion ? `Did you mean \`${suggestion}\`? ` : '';
        // An unknown command — commonly an agent guessing a subcommand name
        // (e.g. `nb upvote`, `nb +1`). Record it so `nb stats` can tell these
        // apart from genuine misuse of a real command (issue #176).
        meta.errorClass = 'unknown_subcommand';
        // Same structured-error contract as the throw path (issue #266): under
        // --json a supervisor gets a parseable `{ok:false, error:{class,…}}` on
        // stdout keyed on `unknown_subcommand`, instead of the previously-empty
        // stdout. The stderr line is byte-for-byte unchanged — note its bare `nb:`
        // prefix (there is no real command to name) — and exit stays 2 (distinct
        // from the 1 the handled-error catch returns).
        const message = `unknown command "${cmd}". ${hint}Try \`nb --help\`.`;
        if (json) {
          process.stdout.write(
            JSON.stringify({ ok: false, command: cmd, error: { class: 'unknown_subcommand', message } }) + '\n',
          );
        }
        process.stderr.write(`nb: ${message}\n`);
        return 2;
      }
    }
    ok = true;
    return 0;
  } catch (e) {
    // Record the error class for the usage log unless a non-throwing failure
    // path above already set one (e.g. a too-long add). `classifyError` reads the
    // class off an `NbError` and falls back to `other` for anything else — never
    // parsing the message (issue #176). Resolve it into a local so the --json
    // error object below reports the SAME bounded class the usage log records
    // (`??=` is preserved as `?? …` then assigned back — behaviour is identical).
    const errorClass = meta.errorClass ?? classifyError(e);
    meta.errorClass = errorClass;
    const message = e instanceof Error ? e.message : String(e);
    // Complete the --json machine contract (issue #266). A throwing command
    // (bad_args / no_match / ambiguous_selector / EACCES / …) used to put the
    // English sentence on stderr and write NOTHING to stdout — so the one
    // consumer --json was built for (issue #41: branch on a structured field,
    // never regex-parse the prose line) was thrown back to parsing prose exactly
    // on the failure paths where structured data matters most. Emit a structured
    // error object on stdout — the same machine channel the success and too-long
    // results already use — discriminated by `ok:false` + an `error` object, and
    // keyed on the bounded `errorClass` (never the drift-prone message text) so a
    // supervisor branches on `error.class`. The English line still goes to stderr
    // UNCHANGED, so human output and every existing stderr test stay byte-for-byte
    // identical; only the previously-empty stdout gains content. Exit stays 1.
    if (json) {
      process.stdout.write(
        JSON.stringify({ ok: false, command: cmd, error: { class: errorClass, message } }) + '\n',
      );
    }
    process.stderr.write(`nb ${cmd}: ${message}\n`);
    return 1;
  } finally {
    // The `stats` read of the usage log happens above; logging it afterwards is fine.
    logUsage(dir, shelf, cmd, ok, Date.now() - started, meta);
  }
}

function need(v: string | undefined, name: string): string {
  if (v == null || v === '') throw new NbError('bad_args', `missing <${name}> argument`);
  return v;
}

/**
 * Record a mutation's cap side effects in its usage-log row: every evicted
 * entry and the entry the aging step docked. Shared by add, merge, split and
 * move so the `evicted`/`decayed` columns `nb stats` reads have one format.
 */
function recordEvictionUsage(meta: UsageMeta, r: { evictedAll: Entry[]; decayed: Entry | null }): void {
  // Record EVERY evicted entry (a cap decrease can evict many at once —
  // issue #306), not just the first, so the usage log never undercounts.
  if (r.evictedAll.length) meta.evicted = formatEvictedUsage(r.evictedAll);
  if (r.decayed) meta.decayed = `${entryId(r.decayed.text)}:${r.decayed.score}`;
}

/** The mutations that accept `--reason`/`--note`; a typo in a call site is a compile error. */
type ReasonOp = 'add' | 'merge' | 'split' | 'rm' | 'move' | 'describe';

/**
 * Record the normalized `--reason`/`--note` of a mutation `op` in its usage-log
 * row (the reason lives in the usage log only, never in the notebook). An empty
 * reason or note leaves its column blank.
 */
function recordReasonUsage(meta: UsageMeta, op: ReasonOp, reasonArg: string | undefined, noteArg: string | undefined): void {
  const { reason, note } = normalizeReason(op, reasonArg, noteArg);
  if (reason) meta.reason = reason;
  if (note) meta.note = note;
}

/**
 * Decide whether a `vote` selector is a BATCH of ids or a single selector.
 * Returns the trimmed id list only when the argument is a comma-separated run of
 * ≥2 bare hex tokens (the shape `nb show` prints, e.g. `3f9a2c,8bd7fe,ee5c9e`);
 * otherwise `null`, so one token OR any non-hex comma-part (a text substring that
 * happens to contain a comma) falls through to the unchanged single-selector
 * path. Id-only on purpose: batch voting by fuzzy text would reintroduce exactly
 * the ambiguity the id selector exists to avoid.
 */
function parseVoteIdList(selector: string): string[] | null {
  if (!selector.includes(',')) return null;
  const parts = selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[0-9a-f]+$/i.test(p))) return null;
  return parts;
}

/**
 * Pull a `--flag <value>` pair out of an argv slice, returning the value (if the
 * flag was present) and the remaining args with the pair removed. A flag at the
 * very end with no following token throws, so a missing value is a loud error
 * rather than a silently dropped reason (DP-5: never silently mislead).
 */
function extractOption(args: string[], flag: string): { value?: string; rest: string[] } {
  const i = args.indexOf(flag);
  if (i === -1) return { rest: args };
  if (i + 1 >= args.length) throw new NbError('bad_args', `${flag} needs a value`);
  return { value: args[i + 1], rest: args.slice(0, i).concat(args.slice(i + 2)) };
}

/**
 * Report that a flag value was unrecognized, so the command silently fell back to
 * a default (issue #266 — the defaulted-flag half of the --json machine
 * contract). The human prose line is ALWAYS written to stderr, byte-for-byte as
 * before. Under `--json` a one-line JSON object is written to stderr *as well*,
 * so a supervisor branching on structured output learns — without regex-parsing
 * the prose — that the value it passed was ignored and which default took its
 * place (`class: 'defaulted_flag'`, the flag, the offending value, the default).
 *
 * It stays on stderr (never stdout) on purpose: these commands' `--json` stdout
 * is a single bare result object (StatsReport, search result, StaleResult, the
 * notebook index) whose shape is the documented contract, and a defaulted flag is
 * a warning, not a result — folding it into stdout would corrupt that stream and
 * break every consumer that parses the bare object. stderr is already where the
 * prose warning goes; this makes that same channel machine-readable. Exit codes
 * are unchanged (a defaulted flag is forgiving, not an error). DP-5: a mistyped
 * flag must never silently mislead — now the machine consumer is told too.
 */
function warnDefaultedFlag(
  json: boolean,
  prose: string,
  w: { command: string; flag: string; value: string; usedDefault: string | number },
): void {
  process.stderr.write(prose);
  if (json) {
    process.stderr.write(
      JSON.stringify({
        warning: {
          class: 'defaulted_flag',
          command: w.command,
          flag: w.flag,
          value: w.value,
          usedDefault: w.usedDefault,
        },
      }) + '\n',
    );
  }
}

// Reduce piped stdin to the single lesson line it must be. One trailing line
// ending (LF, CRLF, or a lone CR) is stripped — a well-formed `printf '%s\n'
// '...'` or editor line ends with one — and any line break that remains means
// the caller piped more than one line, which is refused (exit 1) rather than
// silently flattened into one entry. We test for a bare `\r` too, not just
// `\n`: `sanitizeLesson` collapses `\r` to a space exactly like `\n`, so an
// old-Mac CR line break would otherwise flatten just as silently. An empty
// stream yields '' and falls through to `addEntry`'s `empty`.
function readOneLine(raw: string): string {
  const body = raw.replace(/\r\n$|\r$|\n$/, '');
  if (/[\r\n]/.test(body)) {
    throw new NbError(
      'multiline_refused',
      'refusing multi-line stdin — a lesson is one line (one entry = one line). ' +
        'Pipe exactly one line, or pass the lesson as a single quoted argument.',
    );
  }
  return body;
}

/* c8 ignore start */
// The real stdin reader for `nb add <shelf> -`. Drains stdin to a string. Guards
// against a TTY: with no pipe, reading would block forever waiting for the user,
// so we fail fast with a message that shows the intended pipe form instead. The
// test suite injects its own reader, so this branch is excluded from coverage.
async function readStdinDefault(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "lesson '-' reads from stdin, but stdin is a terminal — pipe the lesson in, " +
        "e.g. `printf '%s\\n' 'run lint first' | nb add reviewer -`",
    );
  }
  return readBoundedStream(process.stdin);
}
/* c8 ignore stop */

/**
 * Byte budget for the piped `-` read (issue #304): a lesson is one line of at
 * most `maxChars()` chars, i.e. at most 4 bytes/char in UTF-8; the 8x multiple
 * leaves generous room for a trailing newline and CRLF without letting a
 * runaway pipe buffer more than a few KB. Floor of 4096 keeps a tiny
 * `NB_MAX_CHARS` from rejecting a legitimate line.
 */
function stdinByteBudget(): number {
  return Math.max(4096, maxChars() * 8);
}

/**
 * Drain a stream incrementally, never holding more than the byte budget. Stops
 * reading as soon as the input is already a multi-line rejection (a line break
 * with more content after it, judged exactly as `readOneLine` will), and throws
 * `too_long` the moment the budget is exceeded — so a huge pipe or a single
 * enormous newline-less line fails fast instead of being buffered into memory.
 * Exported for tests; the caller still passes the result through `readOneLine`.
 */
export async function readBoundedStream(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number = stdinByteBudget(),
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk;
    bytes += buf.length;
    if (bytes > maxBytes) {
      throw new NbError(
        'too_long',
        `stdin input exceeds the ${maxBytes}-byte limit for a one-line lesson — it was NOT read in full or stored. ` +
          'Pipe exactly one short line.',
      );
    }
    chunks.push(buf);
    // Multi-line already (a break that is not just the trailing terminator):
    // readOneLine will refuse it, so stop consuming the stream now.
    if (/[\r\n]/.test(Buffer.concat(chunks).toString('utf-8').replace(/\r\n$|\r$|\n$/, ''))) break;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Whether an aging dock is worth printing (issue #293). `decayed.score` is the
 * POST-dock score, so the pre-dock score was `score + 1`; we print only when that
 * was above the +1 floor (a line that still carried vote capital). A routine
 * +1 → 0 dock on an already-unproven line stays silent (it is still logged).
 */
function agedVisibly(decayed: { score: number } | null): decayed is { score: number; text: string } {
  return decayed !== null && decayed.score > 0;
}

// Settle the process exit status from the `runNbCli` promise. On resolve, the
// returned code becomes `process.exitCode`. On *rejection* — an unexpected bug
// in the CLI wrapper, not a handled command error (`runNbCli` try/catches those
// and resolves with a code) — write the error to stderr and force exit 1.
// Without this `.catch`, a rejection left `exitCode` unset (often 0) plus an
// `unhandledRejection` warning, so a crashing CLI looked like success to an
// orchestrator that only checks the exit code (DP-5: never silently mislead).
// We set `process.exitCode` rather than calling `process.exit(1)`, which would
// abort synchronously before `runNbCli`'s `finally` (logUsage) could run.
export function settleCliExit(result: Promise<number>): Promise<void> {
  return result.then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Set the failing exit code *before* touching stderr: if `stderr.write`
      // itself throws (e.g. EPIPE on a closed pipe) the code is already set, so
      // the crash can never leak back out as a success exit (0).
      process.exitCode = 1;
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`nb: fatal: ${detail}\n`);
    },
  );
}

// Guard `stdout`/`stderr` against broken-pipe (`EPIPE`) errors. When a reader
// closes the pipe early — `nb show <shelf> | head -1`, `… | grep -q foo`, or
// quitting a pager before it drains — a write to the now-closed pipe emits an
// async `error` event on the stream. Node installs no default listener for it,
// so without this it surfaces as an uncaught `Error: write EPIPE` with a stack
// trace on stderr and an abnormal (non-zero) exit — noisy for interactive use
// and liable to trip scripts and hooks that pipe `nb` output (issue #246).
//
// The handler exits cleanly on `EPIPE`: the reader we were writing to is gone,
// so there is nothing left to say and nothing to flush. It uses `process.exit()`
// with no argument — which honors any already-set `process.exitCode` — rather
// than a hard `exit(0)`: a broken pipe during normal output leaves `exitCode`
// unset and so exits 0 (the benign case), but `settleCliExit`'s fatal path sets
// `exitCode = 1` *before* its stderr write, so an EPIPE on *that* write still
// exits 1 and a crash can never leak out as success (DP-5). Any *other* stream
// error is re-thrown so a genuine write failure still surfaces loudly and is
// never silently swallowed. `.then(onFulfilled, onRejected)` in `settleCliExit`
// catches a `runNbCli` *rejection* but not an async `error` event on the stdout
// stream, so that guard and this one are complementary.
//
// `streams`/`onEpipe` are injectable so the EPIPE-vs-other branch is unit
// testable without tearing down the test runner's real stdout.
export function installPipeGuards(
  streams: ReadonlyArray<NodeJS.EventEmitter> = [process.stdout, process.stderr],
  onEpipe: () => void = () => process.exit(),
): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') {
      onEpipe();
      return;
    }
    throw err;
  };
  for (const stream of streams) stream.on('error', onError);
}

// Install SIGINT/SIGTERM handlers so an interrupt during a mutation does not
// strand the `.nb.lock`. Without a handler these signals have a default "terminate
// now" disposition: one delivered while a mutation holds the mkdir lock kills the
// process before withLock's `finally` can run, stranding `.nb.lock` so the NEXT nb
// call blocks up to staleLockMs + lockGraceMs (~12s by default) before it can steal
// it — an avoidable stall on a tool whose whole promise is "a call is a
// millisecond" (issue #247).
//
// The load-bearing fix is the disposition change itself: installing ANY handler
// turns the signal into a deferred JS callback, so the synchronous critical section
// of an in-flight mutation (withLock's `fn` + its `finally`) runs to completion and
// releases the lock normally before we exit. The explicit `releaseHeldLock()` is
// defensive cover for the case of still owning a lock when the handler runs (e.g.
// were a mutation ever to hold the lock across an `await`); it removes ONLY a lock
// THIS process owns — never another live `nb`'s, never a fresh lock we are merely
// spinning on — and is a harmless no-op otherwise.
//
// After releasing, exit with the conventional 128+signo code (130 for SIGINT, 143
// for SIGTERM) so shells and callers see a normal signal-terminated status. Normal,
// un-signalled exits are untouched: the handler fires only on an actual signal.
//
// `release`/`onExit`/`target`/`signals` are injectable so the wiring is unit
// testable without delivering real signals to the test runner. `onExit` receives
// the computed exit *code* (128 + signo), not the raw signal number.
export function installSignalLockRelease(
  release: () => void = releaseHeldLock,
  onExit: (code: number) => void = (code) => process.exit(code),
  target: NodeJS.EventEmitter = process,
  signals: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
    ['SIGINT', 2],
    ['SIGTERM', 15],
  ],
): void {
  for (const [name, signo] of signals) {
    target.on(name, () => {
      release();
      onExit(128 + signo);
    });
  }
}

/* c8 ignore start */
// `process.argv[1]` is the invoked path (e.g. an npm bin symlink such as
// node_modules/.bin/nb); `import.meta.url` resolves through that symlink to
// the real file. Comparing them directly never matches for a symlinked bin,
// which silently skips this block (the CLI exits 0 having done nothing) —
// resolve argv[1]'s realpath first so the comparison works either way.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  installPipeGuards();
  installSignalLockRelease();
  void settleCliExit(runNbCli(process.argv.slice(2)));
}
/* c8 ignore stop */
