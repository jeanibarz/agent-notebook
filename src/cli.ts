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
//   nb path   [<shelf> | --usage] [--json]   print the notebooks dir, a shelf's file path, or the usage-log path (--json = {dir, shelf, path} object)
//   nb config [--json]                      print the effective (post-clamp) NB_* tunables as name=value (--json = object keyed by name)
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
  asciiMode,
  assertSafeShelf,
  classifyError,
  coverageHi,
  DESC_KEY,
  entryId,
  errMin,
  errRate,
  getDescription,
  getMetaValue,
  isValidWindow,
  listNotebooks,
  listShelves,
  lockGraceMs,
  logUsage,
  loopN,
  loopWindowSec,
  maxChars,
  maxLines,
  merge,
  move,
  NbError,
  nearThreshold,
  normalizeReason,
  notebookExists,
  notebooksDir,
  parseWindowMs,
  recallMissHi,
  readShelf,
  releaseHeldLock,
  remove,
  renderEntries,
  search,
  setDescription,
  showJson,
  showJsonMany,
  staleCandidates,
  silentHours,
  sparkGlyphs,
  sparkline,
  split,
  staleLockMs,
  stats,
  usageFile,
  usageRing,
  usageRingSlack,
  vote,
  voteMany,
  type EngagementDiagnosis,
  type SearchResult,
  type StatsReport,
  type UsageMeta,
} from './notebook.js';

/**
 * Default row cap for `nb list` when `--limit` is not given. The index is meant
 * to be read (even injected) whole, so the default is generous enough to show a
 * normal working set in full, while still bounding a pathologically large
 * notebooks dir — the header then reads "showing N of total".
 */
const LIST_DEFAULT_LIMIT = 50;

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
  nb path   [<shelf>] [--json]             print the notebooks dir, or a shelf's resolved file path (--json emits a {dir, shelf, path} object)
  nb path   --usage [--json]               print the resolved usage-log path (to tail -F or back it up)
  nb config [--json]                       print the effective (post-clamp) NB_* tunables as name=value (--json emits an object keyed by tunable name)
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
  - add/vote/rm/merge/move accept --json (after the subcommand): stdout is one JSON
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
  - add/merge/rm/split/describe accept an optional \`--reason <code>\` (+ \`--note "<text>"\`), logged
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
    that session — the description may over-promise), eviction-while-still-voted (the cap
    evicted an entry whose score was still above the
    starting +1 — a useful lesson was lost),
    vote-reversal (the same entry upvoted in one session and downvoted in another — correct but
    mis-aimed), and failed-search (a search returned nothing and a lesson was then added in the
    same session — the coverage gap that search just exposed). They need \`NB_SESSION\` set to
    attribute calls to a session; \`--json\` includes them as \`signals[]\` in the StatsReport.
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
  - when full, the LOWEST-scored line is evicted (ties: oldest).
  - every \`nb show\` line begins with the entry's short stable <id>; pass that id to vote/rm/merge
    (a unique id prefix works too). A unique text substring also selects an entry; an ambiguous one is refused.
  - storage: $NB_DIR or ~/.agent-notebook/notebooks/<shelf>.md (plain text, git-diffable).
  - \`nb config\` prints every effective (post-clamp) tunable as \`name=value\`, each read from the live
    getter the hot path uses, so you never re-derive it by hand from the env var, its default and its
    clamp. Each line is tagged with its source: \`(default)\` (the var is unset), \`(env NB_*)\` (the var is
    set — the printed value is still the post-clamp effective value, so an out-of-range or non-numeric
    value is clamped/ignored and may differ from what you exported), or \`(derived …)\`. \`--json\` emits one
    object keyed by tunable name, each \`{ value, source, env }\`. Read-only — it mutates nothing, and is
    scoped to CONFIGURATION (the knobs), distinct from \`nb stats\` (usage, anomalies, engagement).
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
  'search', 'stats', 'path', 'config', 'completion', 'list', 'ls', 'shelves', 'roles',
  'help', 'version',
] as const;

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
  local shelves
  shelves="$(nb list 2>/dev/null | awk '/^[[:space:]]/ {print $1}')" || return 0
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
    local _nb_list
    _nb_list="$(nb list 2>/dev/null | awk '/^[[:space:]]/ {print $1}')"
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

/** Levenshtein edit distance between two strings (zero-dependency, O(a·b)). */
function editDistance(a: string, b: string): number {
  // Single rolling row keeps it allocation-light; command names are tiny.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Nearest candidate to an unknown input, or `undefined` when nothing is close
 * enough to suggest confidently. Two cheap, zero-dependency signals: a small
 * Levenshtein distance (≤ 2, and strictly under the input length so a 1–2 char
 * stub can't match half the set), or `input` being a prefix of a candidate
 * (≥ 3 chars, catching abbreviations like `desc` → `describe` that edit distance
 * alone would miss). The Levenshtein match wins when both fire; a far-off input
 * matches neither and yields no suggestion. Ties resolve to the EARLIER
 * candidate (strict `<`), so a caller that wants a canonical form preferred over
 * an alias lists it first. Shared by `closestCommand` (over commands, issue
 * #171) and `closestShelf` (over existing shelf names, issue #200).
 */
function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.trim().toLowerCase();
  if (needle === '') return undefined;
  // An exact candidate is not a typo to recover from (and never reaches the
  // recovery path anyway) — never "suggest" the input back to itself.
  if (candidates.includes(needle)) return undefined;

  let best: string | undefined;
  let bestDist = Infinity;
  for (const cand of candidates) {
    const d = editDistance(needle, cand);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  // A close typo: within a small edit budget AND not so short that the distance
  // swamps the input (keeps `x`/`ab` from matching an unrelated 2-letter name).
  if (best !== undefined && bestDist <= 2 && bestDist < needle.length) return best;

  // Otherwise an abbreviation: `input` is a prefix of a candidate (first match
  // wins under the caller's ordering), e.g. `desc` → `describe`.
  if (needle.length >= 3) {
    const prefixHit = candidates.find((cand) => cand.startsWith(needle));
    if (prefixHit) return prefixHit;
  }
  return undefined;
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
 * Nearest existing shelf to a mistyped one, or `undefined` when none is close
 * (issue #200). The shelf sibling of `closestCommand`: a mutation that names a
 * shelf which was never created is almost always a typo, so — exactly as an
 * unknown command points at the nearest real command — we point at the nearest
 * real shelf. Purely advisory: it never auto-corrects. Callers pass the live
 * shelf set, `listShelves(dir)` (already sorted, so ties resolve alphabetically).
 */
export function closestShelf(input: string, shelves: readonly string[]): string | undefined {
  return closestMatch(input, shelves);
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
  path: ['--usage'],
  config: [],
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
  const known = KNOWN_FLAGS[cmd];
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
  if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const t0 = Date.now();
    process.stdout.write(HELP + '\n');
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
  // reason to a mutating op, logged (never stored in the notebook). Every
  // mutating op consumes them — `merge` (duplicate · other), `rm` (wrong ·
  // obsolete · other), `split` (overloaded · other), `move` (consolidate ·
  // other), `add` (free text only, no enum yet), and `describe` (free text only,
  // like `add`). Pulling them out
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
    if (cmd === 'add' || cmd === 'merge' || cmd === 'rm' || cmd === 'split' || cmd === 'describe' || cmd === 'move') {
      // Inside the try so a malformed flag (e.g. `--reason` with no value)
      // becomes a handled exit-1 error, not an uncaught rejection.
      ({ value: reasonArg, rest: args } = extractOption(args, '--reason'));
      ({ value: noteArg, rest: args } = extractOption(args, '--note'));
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
        if (json) {
          // One shelf → a lone ShowResult object ({ shelf, description, entries })
          // so an agent reads each entry's id/score/text/key without regex-parsing
          // the human output (backward-compatible with issue #87). Two or more →
          // a per-shelf ShowResult[] in one consistent snapshot (issue #286), each
          // entry carrying its `key` so the caller drops exact cross-shelf dupes
          // itself; nb does no cross-shelf dedup or ordering here. Same per-shelf
          // ordering as `render()`.
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
            const { metaLines, entries } = readShelf(dir, s);
            // Print the one-line description (if any) as a header above the lessons,
            // so a reader sees what the notebook is *for* before its contents.
            const desc = getMetaValue(metaLines, DESC_KEY);
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
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
        if (r.decayed) meta.decayed = `${entryId(r.decayed.text)}:${r.decayed.score}`;
        // `add` has no seeded enum yet (free text only): a `--note` records
        // free text, and a stray `--reason` buckets to `other` so its vocabulary
        // can emerge from mined notes. Set BEFORE the output branch below, which
        // can `throw`/`return` on 'too-long' — the finally still logs meta.
        {
          const { reason, note } = normalizeReason('add', reasonArg, noteArg);
          if (reason) meta.reason = reason;
          if (note) meta.note = note;
        }
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
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          process.stdout.write('\n');
          // Non-blocking near-duplicate advisory: the lesson WAS stored (stdout
          // above), and this hint goes to stderr so stdout stays pipe-clean. It
          // surfaces the resembling lesson at the moment of re-derivation, so the
          // agent can consolidate if it is the same lesson reworded.
          if (r.nearId) {
            process.stderr.write(
              `note: resembles ${r.nearId} "${r.nearText}" — if that is the same lesson reworded, ` +
                `consolidate with: nb merge ${shelf} ${r.nearId} ${r.id} "<combined>"\n`,
            );
          }
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
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
        if (r.decayed) meta.decayed = `${entryId(r.decayed.text)}:${r.decayed.score}`;
        // Reason lives in the usage log only (merge enum: duplicate · other).
        {
          const { reason, note } = normalizeReason('merge', reasonArg, noteArg);
          if (reason) meta.reason = reason;
          if (note) meta.note = note;
        }
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else {
          process.stdout.write(`merged two entries into one — ${r.size} lines`);
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
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
        const { reason, note } = normalizeReason('split', reasonArg, noteArg);
        // Log the source + both produced ids, the outcome, and the reason/note —
        // the reason lives in the usage log only, never in the notebook.
        meta.entries = [r.source, ...r.ids];
        meta.outcome = 'split';
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
        if (r.decayed) meta.decayed = `${entryId(r.decayed.text)}:${r.decayed.score}`;
        if (reason) meta.reason = reason;
        if (note) meta.note = note;
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else {
          process.stdout.write(`split one entry into two — ${r.size} lines`);
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
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
        {
          const { reason, note } = normalizeReason('rm', reasonArg, noteArg);
          if (reason) meta.reason = reason;
          if (note) meta.note = note;
        }
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
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
        if (r.decayed) meta.decayed = `${entryId(r.decayed.text)}:${r.decayed.score}`;
        // Reason lives in the usage log only (move enum: consolidate · other).
        {
          const { reason, note } = normalizeReason('move', reasonArg, noteArg);
          if (reason) meta.reason = reason;
          if (note) meta.note = note;
        }
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else if (r.reason === 'duplicate') {
          process.stdout.write(
            `skipped (a near-duplicate already lives in "${to}") — "${from}" unchanged, "${to}" still ${r.toSize} lines\n`,
          );
        } else {
          process.stdout.write(
            `moved [${fmt(r.score)}] ${r.text} — "${from}" now ${r.fromSize}, "${to}" now ${r.toSize} lines`,
          );
          if (r.evicted) {
            process.stdout.write(` (evicted lowest-scored from "${to}": [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          }
          if (agedVisibly(r.decayed)) process.stdout.write(` (aged stalest in "${to}" −1 → [${fmt(r.decayed.score)}] ${r.decayed.text})`);
          process.stdout.write('\n');
        }
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
          {
            const { reason, note } = normalizeReason('describe', reasonArg, noteArg);
            if (reason) meta.reason = reason;
            if (note) meta.note = note;
          }
          if (json) process.stdout.write(JSON.stringify(r) + '\n');
          else if (r.desc === null) process.stdout.write(`description cleared for shelf "${shelf}"\n`);
          else process.stdout.write(`description set for shelf "${shelf}": ${r.desc}\n`);
        } else {
          const desc = getDescription(dir, shelf);
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
        const query = need(searchArgs[1], 'query');
        const prefix = searchArgs[2]; // optional positional prefix (undefined → all notebooks)
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
        meta.outcome = result.terms.length === 0 ? 'no-terms' : result.total > 0 ? 'match' : 'no-match';
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
          process.stdout.write(JSON.stringify(result) + '\n');
        } else {
          const { out, err } = renderSearch(query, any, result);
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
        // `--json` emits the raw StatsReport (stable, machine-readable) so a
        // supervising agent can act on a loop/went-silent/high-error-rate
        // anomaly without regex-parsing the human table. The --since warning
        // above stays on stderr, keeping stdout pure JSON.
        if (json) {
          process.stdout.write(JSON.stringify(rep) + '\n');
        } else {
          process.stdout.write(renderStats(rep, maybeShelf) + '\n');
        }
        // The command itself succeeded (stats read cleanly); the usage log must
        // record that, so set `ok` before the opt-in anomaly exit returns early.
        ok = true;
        if (wantExitCode && rep.anomalies.length > 0) return 3;
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
        // the env var + its default + its clamp. Scoped to CONFIGURATION (the
        // knobs), deliberately distinct from `nb stats` (usage/anomalies/
        // engagement). The shared `finally` appends its one usage row; the shelf
        // column stays `-` because the command reads global config, not a shelf.
        const rows = effectiveConfig();
        if (json) {
          // One object keyed by tunable name; each carries the effective value,
          // its source (env/default/derived), and the env var that overrides it,
          // so a supervisor can branch on the live value without regex-parsing
          // the human lines. The value is always the post-clamp effective value.
          const obj: Record<string, { value: number; source: ConfigSource; env: string | null }> = {};
          for (const r of rows) obj[r.name] = { value: r.value, source: configSource(r.env), env: r.env };
          process.stdout.write(JSON.stringify(obj) + '\n');
        } else {
          const { out } = renderConfig(rows);
          process.stdout.write(out);
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
        if (limitRaw !== undefined) {
          // Forgiving like `stats --since`: an unparseable --limit warns on
          // stderr (stdout/JSON stays clean) and falls back to the default,
          // rather than rejecting — the least-surprising path.
          if (/^\d+$/.test(limitRaw.trim())) {
            limit = Number.parseInt(limitRaw, 10);
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
          process.stdout.write(JSON.stringify(listNotebooks(dir, { prefix, limit })) + '\n');
        } else {
          const { out, err } = renderList(dir, prefix, limit);
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

function fmt(score: number): string {
  return score >= 0 ? `+${score}` : `${score}`;
}

/** Render a surfacing rate as a right-aligned whole percent, or `—` when it is `null` (no data — never a misleading 0%, DP-5). */
function pct(rate: number | null): string {
  return (rate === null ? '—' : `${Math.round(rate * 100)}%`).padStart(4);
}

/** Pluralize `word` for `n` by appending `s` unless `n === 1`. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Turn the zero-engagement diagnosis (issue #105) into up to three terse,
 * actionable `surfacing:` lines — one per applicable root cause, in the order
 * `diagnoseEngagement` emits them. Returns `[]` when there is nothing to
 * diagnose (no diagnosis object, or `engagedSessions > 0`, or none of the three
 * causes applies), so the caller can fall back to the generic line.
 */
function engagementDiagnosisLines(diag: EngagementDiagnosis | null): string[] {
  if (!diag) return [];
  const out: string[] = [];
  for (const cause of diag.causes) {
    if (cause === 'blank-session') {
      out.push(
        `  surfacing: no engaged sessions — NB_SESSION was unset on ${plural(diag.blankSessionCalls, 'call')}, ` +
          `so none could group into a session; export NB_SESSION (then vote) to measure`,
      );
    } else if (cause === 'retrospective-not-landing') {
      out.push(
        `  surfacing: no engaged sessions — ${plural(diag.readOnlySessions, 'session')} opened a notebook but cast no vote; ` +
          `the end-of-task retrospective nudge isn't landing`,
      );
    } else if (cause === 'injection-hook') {
      out.push(
        `  surfacing: no engaged sessions — notebooks hold ${plural(diag.storedLessons, 'lesson')} but had 0 reads in this window; ` +
          `the SessionStart injection hook is probably not wired`,
      );
    }
  }
  return out;
}

/** One-line gloss per coverage×surfacing readout quadrant (issue #81, §4 of the design rationale). */
const READOUT_GLOSS: Record<'healthy' | 'surfacing-failure' | 'coverage-building' | 'churny', string> = {
  healthy: 'covers and surfaces',
  'surfacing-failure': 'content present but not reaching the agent',
  'coverage-building': 'a young notebook filling gaps',
  churny: 'gaps and poor surfacing',
};

/** Where a tunable's effective value came from: a set env var, the built-in default, or a derived value with no own env var. */
type ConfigSource = 'env' | 'default' | 'derived';

/** One `nb config` row: the tunable's config name, the value its live getter resolves to RIGHT NOW, and the env var that overrides it (null for a derived value). */
interface ConfigRow {
  name: string;
  value: number;
  env: string | null;
}

/**
 * The effective, post-clamp tunables `nb config` reports (issue #188). Every
 * value comes from the SAME exported getter the hot path uses, so a printed
 * value can never drift from the value `nb` actually runs under — the honest way
 * to surface a post-clamp value without re-reading the env (and re-copying every
 * default + clamp) here, which is exactly the #116-class drift the #131 guard
 * exists to prevent. `usageRingSlack` is DERIVED from `usageRing` and has no env
 * var of its own (env `null`).
 */
function effectiveConfig(): ConfigRow[] {
  return [
    { name: 'maxLines', value: maxLines(), env: 'NB_MAX_LINES' },
    { name: 'maxChars', value: maxChars(), env: 'NB_MAX_CHARS' },
    { name: 'nearThreshold', value: nearThreshold(), env: 'NB_NEAR_DUP' },
    { name: 'usageRing', value: usageRing(), env: 'NB_USAGE_RING' },
    { name: 'usageRingSlack', value: usageRingSlack(), env: null },
    { name: 'staleLockMs', value: staleLockMs(), env: 'NB_STALE_LOCK_MS' },
    { name: 'lockGraceMs', value: lockGraceMs(), env: 'NB_LOCK_GRACE_MS' },
    { name: 'loopN', value: loopN(), env: 'NB_LOOP_N' },
    { name: 'loopWindowSec', value: loopWindowSec(), env: 'NB_LOOP_WINDOW_S' },
    { name: 'silentHours', value: silentHours(), env: 'NB_SILENT_H' },
    { name: 'errMin', value: errMin(), env: 'NB_ERR_MIN' },
    { name: 'errRate', value: errRate(), env: 'NB_ERR_RATE' },
    { name: 'coverageHi', value: coverageHi(), env: 'NB_COVERAGE_HI' },
    { name: 'recallMissHi', value: recallMissHi(), env: 'NB_RECALL_MISS_HI' },
  ];
}

/**
 * Classify where a tunable's effective value comes from. A tunable with no env
 * var of its own (`env === null`) is `derived`; otherwise it is `env` when the
 * variable is DEFINED and `default` when it is unset (absent from the
 * environment). This is a statement about the ENVIRONMENT, not the value: a
 * set-but-out-of-range, non-numeric, or even blank var still reads `env`, while
 * the value `nb config` prints is always the post-clamp effective one.
 *
 * The test is `!== undefined`, NOT "non-blank": a var set to the empty string IS
 * set, and for a rate getter `clampRate` resolves `''` to `0` (via `Number('')`),
 * which is the value the hot path actually uses — so it must read `(env …)`, not
 * `(default)`. Tagging that `default` would print `errRate=0 (default)` while the
 * real default is `0.3`: a value/tag pair that silently misleads, the exact thing
 * FR-CONFIG-001 and DP-5 forbid.
 */
function configSource(env: string | null): ConfigSource {
  if (env === null) return 'derived';
  return process.env[env] !== undefined ? 'env' : 'default';
}

/**
 * Render `nb config` for the human path. One `name=value` line per tunable, the
 * `name=value` column left-padded so the source tags line up. The tag names the
 * source: `(default)`, `(env NB_*)`, or `(derived from usageRing)`. Returns
 * `{ out }` (stdout only) — there is no error/empty state, the table is fixed.
 */
function renderConfig(rows: ConfigRow[]): { out: string } {
  const pairW = rows.reduce((w, r) => Math.max(w, `${r.name}=${r.value}`.length), 0);
  const lines = rows.map((r) => {
    const src = configSource(r.env);
    const tag = src === 'env' ? `(env ${r.env})` : src === 'derived' ? '(derived from usageRing)' : '(default)';
    return `${`${r.name}=${r.value}`.padEnd(pairW)}  ${tag}`;
  });
  return { out: lines.join('\n') + '\n' };
}

/**
 * Fixed display width for the trigger/description column in the human `nb list`
 * and `nb search` renderers (issue #211). Deterministic — a sane fixed width, no
 * terminal probing — so the output is stable and testable.
 */
const DESC_COL_WIDTH = 80;

/**
 * Bound a one-line trigger/description to `width` display chars for the human
 * renderers so a long (up to `maxChars()` = 200) description or top lesson can't
 * wrap and shatter the aligned `name  count  desc` columns of `nb list` / the
 * shelf lines of `nb search` (issue #211). Over-width text is cut and closed with
 * an ellipsis — `…`, or `...` under `asciiMode` (the non-UTF-8 / `NB_ASCII`
 * fallback, issue #136) — and the result (ellipsis included) never exceeds
 * `width`. The `--json` paths (`listNotebooks` / `search`) are untouched and keep
 * emitting the full, untruncated text.
 */
function truncateCol(text: string, width: number = DESC_COL_WIDTH): string {
  if (text.length <= width) return text;
  const ell = asciiMode() ? '...' : '…';
  return text.slice(0, Math.max(0, width - ell.length)) + ell;
}

/**
 * Render the notebook index for `nb list`/`ls`/`shelves`/`roles`. Returns `{out, err}` so
 * the caller writes the body to stdout (pipe-clean) and a friendly empty-state
 * note to stderr, exactly like `nb roles` did. One header line, then one row per
 * notebook: `  <name>  <count>  <description>`, name left-padded and count
 * right-aligned so the columns line up. A notebook with no `# desc:` shows its
 * top-scored lesson instead, suffixed `(auto)`. The header reads `N` when every
 * match is shown, or `shown of total` when `--limit` truncated the list. A long
 * description/trigger is bounded by `truncateCol` so it can't wrap the row.
 */
function renderList(dir: string, prefix: string | undefined, limit: number): { out: string; err: string } {
  const listing = listNotebooks(dir, { prefix, limit });
  if (listing.total === 0) {
    const err = prefix
      ? `no notebooks matching "${prefix}" — run \`nb list\` to see them all\n`
      : 'no notebooks yet — add one with `nb add <shelf> "<lesson>"`\n';
    return { out: '', err };
  }
  const shown = listing.rows.length;
  const countClause = shown < listing.total ? `${shown} of ${listing.total}` : `${listing.total}`;
  const match = prefix ? ` matching "${prefix}"` : '';
  const lines = [`agent-notebook notebooks — ${countClause}${match} in ${dir}`];
  const nameWidth = listing.rows.reduce((w, r) => Math.max(w, r.shelf.length), 0);
  const countWidth = listing.rows.reduce((w, r) => Math.max(w, String(r.lessons).length), 0);
  for (const r of listing.rows) {
    const trigger = r.desc ?? r.auto; // explicit description, else the (auto) top lesson
    const descPart = trigger ? `  ${truncateCol(trigger)}${r.desc === null ? '  (auto)' : ''}` : '';
    lines.push(`  ${r.shelf.padEnd(nameWidth)}  ${String(r.lessons).padStart(countWidth)}${descPart}`);
  }
  return { out: lines.join('\n') + '\n', err: '' };
}

/**
 * Render a `nb search` result for the human path. Returns `{out, err}` so a match
 * writes to stdout (pipe-clean) and a no-match writes a friendly note to stderr
 * (keeping stdout empty), exactly like `nb list`. A no-match is not an error — the
 * note reminds the reader that search is the secondary path AND that the miss was
 * recorded as a possible coverage gap. On a match: one header line (term count and
 * AND/OR mode), then per notebook a shelf line (with its description when set, and a
 * `(description match)` tag when only the description matched) followed by one
 * indented `<id>  [score]  <text>` line per hit — the id so the agent can `vote` it.
 */
function renderSearch(query: string, any: boolean, result: SearchResult): { out: string; err: string } {
  const mode = any ? 'OR' : 'AND';
  if (result.groups.length === 0) {
    // Three distinct empty renders, only ONE of which is the logged coverage gap.
    // Key the gap message on `result.total` (the FULL pre-limit count), NOT on the
    // bounded `groups.length`: otherwise `--limit 0` on a real match would print
    // "no lessons match … recorded as a possible coverage gap" while the usage log
    // correctly recorded a `match` — telling the user the opposite of the truth.
    const err =
      result.terms.length === 0
        ? `nb search: no searchable terms in "${query}"\n`
        : result.total === 0
          ? `no lessons match "${query}" (${mode}) — search is the secondary path (lessons are surfaced to you, ` +
            `not searched); this miss was recorded as a possible coverage gap\n`
          : `${result.total} notebook${result.total === 1 ? '' : 's'} match "${query}" (${mode}) but --limit hid them all — ` +
            `raise --limit to see them (this was a match, not a coverage gap)\n`;
    return { out: '', err };
  }
  const hitCount = result.groups.reduce((n, g) => n + g.hits.length, 0);
  const nbCount = result.groups.length;
  // When `--limit` truncated the groups, read "N of total" like `nb list`, so the
  // caller can tell the result was capped (and widen `--limit` if they need more).
  const nbClause = nbCount < result.total ? `${nbCount} of ${result.total}` : `${nbCount}`;
  const lines = [
    `agent-notebook search — "${query}" (${mode} over ${result.terms.length} term${result.terms.length === 1 ? '' : 's'}): ` +
      `${hitCount} hit${hitCount === 1 ? '' : 's'} in ${nbClause} notebook${result.total === 1 ? '' : 's'} ` +
      `(secondary fallback — lessons are normally surfaced to you, not searched)`,
  ];
  for (const g of result.groups) {
    const descPart = g.desc ? `  — ${truncateCol(g.desc)}` : '';
    const descOnly = g.hits.length === 0 ? '  (description match)' : g.descMatched ? '  (+description match)' : '';
    lines.push(`  ${g.shelf}${descPart}${descOnly}`);
    for (const h of g.hits) {
      lines.push(`    ${h.id}  [${fmt(h.score)}]  ${h.text}`);
    }
  }
  return { out: lines.join('\n') + '\n', err: '' };
}

function renderStats(rep: StatsReport, shelf: string | undefined): string {
  const lines: string[] = [];
  lines.push(`nb usage — ${shelf ? `shelf ${shelf}, ` : ''}window ${rep.window}, ${rep.totalCalls} calls`);
  // Ops-per-day activity sparkline (issue #106): one glyph per rolling-24h
  // bucket, oldest (leftmost) to the 24h ending now (rightmost). A silent bucket
  // reads as the floor glyph, so "went quiet N days ago" is visible at a glance.
  // Glyph ramp is env-selected (issue #136): Unicode blocks by default, the
  // ASCII digit ramp under NB_ASCII or a non-UTF-8 locale. `sparkline` stays pure.
  lines.push(`  activity  ${sparkline(rep.activity, sparkGlyphs())}  (${rep.window}, ${rep.totalCalls} ops)`);
  if (rep.perCommand.length === 0) {
    lines.push('  (no usage recorded in this window)');
  } else {
    lines.push('  command   calls  err%   p50    p95    last-used');
    for (const c of rep.perCommand) {
      lines.push(
        `  ${c.command.padEnd(8)}  ${String(c.calls).padStart(4)}  ${String(Math.round(c.errorRate * 100)).padStart(3)}%  ` +
          `${(c.p50ms + 'ms').padStart(5)}  ${(c.p95ms + 'ms').padStart(5)}  ${c.lastUsed.slice(0, 19)}`,
      );
    }
  }
  // Error causes (issue #223): name the lever behind each command's err% so the
  // two most actionable rates — `add` over-cap rejections and `vote` selector
  // misses — are in the header, not buried behind the high-error-rate anomaly
  // threshold. Only printed when something errored this window. A dominant
  // `unclassified` share means the log predates the errorClass column (#176) —
  // upgrade `nb` so causes get recorded.
  if (rep.errorCauses.length > 0) {
    lines.push('  error causes:');
    let anyUnclassified = false;
    for (const e of rep.errorCauses) {
      for (const b of e.breakdown) if (b.cause === 'unclassified') anyUnclassified = true;
      const parts = e.breakdown.map((b) => `${b.cause} ${b.pct}%`).join(', ');
      lines.push(`    ${e.command.padEnd(8)} ${parts}  (${e.errors} err)`);
    }
    if (anyUnclassified)
      lines.push('    (unclassified = log predates error-class recording — upgrade nb to split these by cause)');
  }
  if (rep.anomalies.length > 0) {
    lines.push('  anomalies:');
    for (const a of rep.anomalies) {
      lines.push(`    [${a.kind}] ${a.command}${a.shelf ? ` (shelf ${a.shelf})` : ''}: ${a.detail}`);
    }
  } else {
    lines.push('  anomalies: none');
  }
  // Free diagnostic signals (issue #72): memory-quality observations read from
  // the usage ring (over-promised descriptions, too-tight caps, mis-aimed
  // lessons). Distinct from anomalies (command health), so they get their own
  // section; each line names the shelf (and entry/session where relevant).
  if (rep.signals.length > 0) {
    lines.push('  signals:');
    for (const s of rep.signals) {
      const where = s.entry ? ` entry ${s.entry}` : s.session ? ` session "${s.session}"` : '';
      lines.push(`    [${s.kind}] shelf ${s.shelf}${where}: ${s.detail}`);
    }
  } else {
    lines.push('  signals: none');
  }
  // Surfacing metrics (issue #81): the named recall-miss / precision-miss rates
  // and the coverage×surfacing readout, engagement-gated. The recall-miss rate is
  // the headline (re-deriving a stored lesson is the clearest surfacing failure);
  // precision-miss is shown beside it so "surface everything" cannot look free.
  const sf = rep.surfacing;
  if (sf.engagedSessions === 0) {
    // Zero engagement: split the one vague line into the root cause(s) (issue
    // #105). At most three terse lines; fall back to the generic line when none
    // of the three causes apply (e.g. an empty notebook with no activity).
    const diagLines = engagementDiagnosisLines(sf.engagementDiagnosis);
    if (diagLines.length > 0) {
      for (const l of diagLines) lines.push(l);
    } else {
      lines.push('  surfacing: no engaged sessions in this window (set NB_SESSION and vote to measure)');
    }
  } else {
    const sess = `${sf.engagedSessions} engaged session${sf.engagedSessions === 1 ? '' : 's'}`;
    lines.push(`  surfacing: ${sess}`);
    lines.push(`    coverage        ${pct(sf.coverage)}  (${sf.addAttempts ? `${Math.round((sf.coverage ?? 0) * sf.addAttempts)}/${sf.addAttempts} attempts novel` : 'no add attempts'})`);
    lines.push(`    recall-miss     ${pct(sf.recallMiss)}  (${sf.addAttempts ? `${Math.round((sf.recallMiss ?? 0) * sf.addAttempts)}/${sf.addAttempts} re-derived — stored lesson not surfaced; the headline alarm` : 'no add attempts'})`);
    lines.push(`    precision-miss  ${pct(sf.precisionMiss)}  (${sf.votesActedOn ? `${Math.round((sf.precisionMiss ?? 0) * sf.votesActedOn)}/${sf.votesActedOn} downvotes on pushed lessons` : 'no votes'})`);
    // Serendipity (issue #114): the positive goal — upvotes on lessons that arrived
    // unbidden. The leading `~` and "approx" flag it as a two-sided PROXY, not a
    // bound (a show-pull/recall inflates it; a same-session search match deflates
    // it) — it must never be read as "true serendipity ≤ x". See SurfacingMetrics.
    lines.push(`    serendipity    ~${pct(sf.serendipity)}  (${sf.upvotes ? `${Math.round((sf.serendipity ?? 0) * sf.upvotes)}/${sf.upvotes} upvotes arrived unbidden — approx; a proxy, not a bound` : 'no upvotes'})`);
    if (sf.readout) lines.push(`    readout: ${sf.readout} — ${READOUT_GLOSS[sf.readout]}`);
  }
  // Notebook inventory (issue #40): make memory pressure visible — a shelf at
  // `lines/cap` where the two are equal is one distinct add from an eviction,
  // flagged FULL so a supervisor spots it without listing files.
  const nb = rep.notebookTotals;
  if (rep.notebooks.length === 0) {
    lines.push('  notebooks: none');
  } else {
    lines.push(`  notebooks: ${nb.shelves} ${nb.shelves === 1 ? 'shelf' : 'shelves'}, ${nb.lines} lines (cap ${nb.cap}/shelf)`);
    for (const n of rep.notebooks) {
      const full = n.lines >= n.cap ? '  FULL' : '';
      lines.push(`    ${n.shelf.padEnd(20)}  ${String(n.lines).padStart(4)}/${n.cap}${full}`);
    }
  }
  // Usage-ring occupancy (issue #206): the log's own fill vs its cap, so "why did
  // my window lose older data" is answerable at a glance — the analogue, for the
  // monitoring log, of the per-shelf cap pressure just above. Total occupancy
  // (not the windowed call count), flagged FULL when it has reached the cap.
  const ring = rep.usageRing;
  const ringFull = ring.rows >= ring.cap ? '  FULL' : '';
  lines.push(`  usage ring: ${ring.rows}/${ring.cap} rows${ringFull}`);
  return lines.join('\n');
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
