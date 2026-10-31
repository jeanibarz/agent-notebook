#!/usr/bin/env node
// `nb` — the Agent Notebook CLI. A shelf is a bounded, voted memory: local plain
// text, no embeddings, no network, so every call is a fast, deterministic,
// offline file edit.
//
// Commands:
//   nb show   <shelf> [--json]              print the notebook (--json → structured {shelf,description,entries})
//   nb add    <shelf> "<lesson>"            dedup-skip, score +1, write, trim (lowest-score out)
//   nb add    <shelf> -                     read the one-line lesson from stdin (multi-line refused)
//   nb vote   <shelf> <id|query> +1|-1      adjust an entry's score
//   nb merge  <shelf> <idA> <idB> "<merged>"  consolidate two entries into one
//   nb split  <shelf> <id|query> "<a>" "<b>"   cut one overloaded entry into two
//   nb rm     <shelf> <id|query>            delete an entry judged useless
//   nb move   <from> <to> <id|query>        relocate an entry across shelves, score intact
//   (add/vote/rm/merge/move take --json: one structured result object on stdout)
//   nb describe <shelf> ["<text>"]          set the notebook's one-line description (or print it)
//   nb search <query> [prefix] [--any]     SECONDARY keyword fallback: scan all notebooks (surfacing is primary)
//   nb stats  [<shelf>] [--since 7d] [--json]  usage analytics + anomaly & diagnostic-signal flags (--json = raw StatsReport)
//   nb path   [<shelf>]                     print the notebooks dir, or a shelf's file path
//   nb list   [prefix] [--limit N]         index notebooks: one richest-first line each (name, lessons, desc)
//   nb ls / nb shelves / nb roles          aliases of `nb list` (`roles` is deprecated)
//   nb --help                              this help
//
// Every call appends one line to the usage ring so `nb stats` can surface
// loop / went-silent / high-error-rate anomalies.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  addEntry,
  assertSafeShelf,
  entryId,
  getDescription,
  isValidWindow,
  listNotebooks,
  logUsage,
  maxChars,
  merge,
  move,
  normalizeReason,
  notebooksDir,
  parseWindowMs,
  remove,
  render,
  search,
  setDescription,
  showJson,
  sparkline,
  split,
  stats,
  vote,
  type EngagementDiagnosis,
  type SearchResult,
  type UsageMeta,
} from './notebook.js';

/**
 * Default row cap for `nb list` when `--limit` is not given. The index is meant
 * to be read (even injected) whole, so the default is generous enough to show a
 * normal working set in full, while still bounding a pathologically large
 * notebooks dir — the header then reads "showing N of total".
 */
const LIST_DEFAULT_LIMIT = 50;

const HELP = `nb — the Agent Notebook (bounded, voted memory, grouped in shelves)

usage:
  nb show   <shelf> [--json]               print the notebook (highest-scored first; --json emits {shelf,description,entries})
  nb add    <shelf> "<lesson>"             add a lesson (dedup-skipped; rejected if too long, never truncated)
  nb add    <shelf> -                      read the lesson from stdin (one line; multi-line is refused)
  nb vote   <shelf> <id|query> +1|-1       upvote/downvote an entry you used
  nb merge  <shelf> <idA> <idB> "<merged>" consolidate two entries into one
  nb split  <shelf> <id|query> "<a>" "<b>" cut one overloaded entry into two (reverse of merge)
  nb rm     <shelf> <id|query>             delete an entry
  nb move   <from> <to> <id|query>         move an entry to another shelf, keeping its score (consolidate shelves)
  nb describe <shelf> ["<text>"]           set the notebook's one-line description (no text → print the current one)
  nb search <query> [prefix] [--any]      SECONDARY keyword fallback — scan all notebooks (surfacing is the primary path)
  nb stats  [<shelf>] [--since 7d] [--json] usage analytics + anomaly & diagnostic-signal flags (--json emits the raw StatsReport)
  nb path   [<shelf>]                      print the notebooks dir, or a shelf's resolved file path
  nb list   [prefix] [--limit N]          index notebooks richest-first: one line each (name, lesson count, description)
  nb ls     [prefix] [--limit N]          alias of \`nb list\`
  nb shelves [prefix] [--limit N]         alias of \`nb list\`
  nb roles  [prefix] [--limit N]          deprecated alias of \`nb list\` (still works)
  nb --help                               show this help
  nb --version                            print the tool version

notes:
  - <shelf> is a notebook's name: one <shelf>.md file of lessons an agent needs in the
    same situations (see \`nb list\`).
  - add/vote/rm/merge/move accept --json (after the subcommand): stdout is one JSON
    result object and nothing else; warnings/errors stay on stderr. Exit codes are
    unchanged (a too-long add still exits 1, a duplicate still exits 0).
  - \`nb move <from> <to> <id|query>\` relocates one entry to another shelf WITH ITS
    SCORE INTACT — the score-preserving consolidation \`add\`+\`rm\` cannot do (\`add\`
    resets to +1). It refuses, writing nothing, if source and target are the same
    shelf, the selector is absent/ambiguous, or the target already holds a
    near-duplicate; the moved entry is admitted like a newcomer, so a full target
    ages/evicts its stalest OTHER line, never the lesson you moved.
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
    by name (the \`.\` convention, e.g. \`nb search lock review.\`); \`--json\` emits the raw SearchResult.
    A search that finds nothing is also a signal: it is logged so a later \`add\` in the same session
    reads back as a \`failed-search\` coverage gap in \`nb stats\`.
  - \`nb stats\` also surfaces free *diagnostic signals* read straight from the usage log (no
    extra agent action): browse-without-use (a notebook shown in a session but no entry voted
    that session — the description may over-promise), eviction-while-still-voted (the cap
    evicted an entry whose score was still above the
    starting +1 — a useful lesson was lost), and
    vote-reversal (the same entry upvoted in one session and downvoted in another — correct but
    mis-aimed). They need \`NB_SESSION\` set to attribute calls to a session; \`--json\` includes
    them as \`signals[]\` in the StatsReport.
  - \`nb stats\` also reports the named *surfacing metrics* (as \`surfacing\` in the StatsReport):
    coverage (novel-add rate), recall-miss (dedup-block rate — the headline alarm: a stored lesson
    was re-derived, not surfaced), precision-miss (downvote rate on pushed lessons, read beside
    recall so "surface everything" can't look free), and a coverage×surfacing readout
    (healthy / surfacing-failure / coverage-building / churny). Every rate is conditioned on add/vote
    *attempts* (robust to a lazy agent) and gated on *engagement* — only sessions with a vote are
    scored, so an uninstrumented session isn't mistaken for "healthy quiet". A rate is \`null\` (shown
    \`—\`) when there's no data. Needs \`NB_SESSION\` set to attribute calls to a session.
  - when NO session is engaged anywhere in the window, \`nb stats\` splits the cause instead of one
    vague line: \`NB_SESSION\` unset, the retrospective nudge not landing (a notebook was opened but
    never voted), or the SessionStart hook not wired (lessons stored but nothing read them). The
    counts are \`surfacing.engagementDiagnosis\` in \`--json\` (\`null\` once any session is engaged).
  - a notebook holds at most 200 lines; each lesson is one line of at most 200 chars.
  - an over-long add is REJECTED (exit 1), never truncated — rewrite shorter and retry.
  - when full, the LOWEST-scored line is evicted (ties: oldest).
  - every \`nb show\` line begins with the entry's short stable <id>; pass that id to vote/rm/merge
    (a unique id prefix works too). A unique text substring also selects an entry; an ambiguous one is refused.
  - storage: $NB_DIR or ~/.agent-notebook/notebooks/<shelf>.md (plain text, git-diffable).

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
  throw new Error('vote direction must be +1 or -1');
}

export async function runNbCli(
  argv: string[],
  readStdin: () => Promise<string> = readStdinDefault,
): Promise<number> {
  const cmd = (argv[0] ?? '').trim();
  if (cmd === '' || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    process.stdout.write(`nb (agent-notebook) ${pkgVersion()}\n`);
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
  // `--json` on a mutation (add/vote/rm/merge) emits the library's structured
  // result object on stdout and nothing else, so a supervisor can branch on
  // `reason`/`score` without regex-parsing the English line. `show` also honors
  // it (emitting a ShowResult); `stats` reads it from its own arg slice. Strip it
  // before positional parsing (like `stats`, it is a flag, not a shelf/lesson);
  // `path`/`shelves` ignore it. Exit codes are unchanged (a too-long add still exits 1).
  const json = argv.includes('--json');
  let args = json ? argv.filter((a) => a !== '--json') : argv;
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
    if (cmd === 'add' || cmd === 'merge' || cmd === 'rm' || cmd === 'split' || cmd === 'describe' || cmd === 'move') {
      // Inside the try so a malformed flag (e.g. `--reason` with no value)
      // becomes a handled exit-1 error, not an uncaught rejection.
      ({ value: reasonArg, rest: args } = extractOption(args, '--reason'));
      ({ value: noteArg, rest: args } = extractOption(args, '--note'));
    }
    switch (cmd) {
      case 'show': {
        // Resolve the shelf from the --json-stripped args so `nb show <shelf> --json`
        // and `nb show --json <shelf>` both work and the flag is never taken as the shelf.
        shelf = need(args[1], 'shelf');
        if (json) {
          // `--json` emits the structured ShowResult ({ shelf, description, entries })
          // and nothing else, so an agent reads each entry's id/score/text without
          // regex-parsing the human output. Same ordering as `render()`.
          process.stdout.write(JSON.stringify(showJson(dir, shelf)) + '\n');
        } else {
          // Print the one-line description (if any) as a header above the lessons,
          // so a reader sees what the notebook is *for* before its contents.
          const desc = getDescription(dir, shelf);
          if (desc) process.stdout.write(`# desc: ${desc}\n`);
          process.stdout.write(render(dir, shelf) + '\n');
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
        if (r.collidedId) meta.collided = r.collidedId;
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
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
        } else if (r.reason === 'duplicate') process.stdout.write(`skipped (near-duplicate already present) — ${r.size} lines\n`);
        else if (r.reason === 'empty') process.stdout.write('skipped (empty lesson)\n');
        else if (r.reason === 'too-long') throw new Error(`lesson too long (${r.length} chars > ${maxChars()} max). Rewrite it shorter as ONE complete line and retry — it was NOT truncated or stored.`);
        else {
          process.stdout.write(`added — ${r.size} lines`);
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          process.stdout.write('\n');
        }
        break;
      }
      case 'vote': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
        const delta = parseDelta(need(args[3], '+1|-1'));
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
        // Reason lives in the usage log only (merge enum: duplicate · other).
        {
          const { reason, note } = normalizeReason('merge', reasonArg, noteArg);
          if (reason) meta.reason = reason;
          if (note) meta.note = note;
        }
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`merged two entries into one — ${r.size} lines\n`);
        break;
      }
      case 'split': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
        const lessonA = need(args[3], 'lessonA');
        const lessonB = need(args[4], 'lessonB');
        const r = await split(dir, shelf, selector, lessonA, lessonB);
        const { reason, note } = normalizeReason('split', reasonArg, noteArg);
        // Log the source + both produced ids, the outcome, and the reason/note —
        // the reason lives in the usage log only, never in the notebook.
        meta.entries = [r.source, ...r.ids];
        meta.outcome = 'split';
        if (reason) meta.reason = reason;
        if (note) meta.note = note;
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`split one entry into two — ${r.size} lines\n`);
        break;
      }
      case 'rm': {
        shelf = need(args[1], 'shelf');
        const selector = need(args[2], 'id|query');
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
        const r = await move(dir, from, to, selector);
        meta.entries = [r.id];
        meta.outcome = r.reason === 'moved' ? 'moved' : 'move-blocked';
        if (r.collidedId) meta.collided = r.collidedId;
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
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
          const r = await setDescription(dir, shelf, args[2]);
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
        // stays `-` (like `list`). `--json` is already stripped from `args`; pull
        // out the boolean `--any` (OR instead of AND), leaving the query at
        // args[1] and an optional positional name prefix at args[2].
        const any = args.includes('--any');
        const searchArgs = any ? args.filter((a) => a !== '--any') : args;
        const query = need(searchArgs[1], 'query');
        const prefix = searchArgs[2]; // optional positional prefix (undefined → all notebooks)
        const result = search(dir, query, { prefix, any });
        // Log the search so the `failed-search → add` gap-sensor can read it back:
        // outcome `match`/`no-match` plus the query in `note` (no new log column).
        // A no-match is NOT an error — the command succeeded, it just found
        // nothing (exit 0, like a dedup-blocked add), so `ok` is set below. A query
        // with no searchable terms (e.g. all whitespace) is logged as `no-terms`,
        // NOT `no-match`, so an empty query can never masquerade as a coverage gap
        // (the `failed-search` signal keys on `no-match`) — DP-5, never mislead.
        meta.outcome = result.terms.length === 0 ? 'no-terms' : result.groups.length > 0 ? 'match' : 'no-match';
        meta.note = query;
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
        const rest = argv.slice(1);
        const sinceIdx = rest.indexOf('--since');
        const sinceVal = sinceIdx >= 0 ? rest[sinceIdx + 1] : undefined;
        // Share `nb add`'s refusal to silently mislead: a mistyped --since
        // otherwise falls back to 7d while the user believes they filtered.
        // Warn (naming the accepted format and window used), then proceed with
        // the default rather than reject — the least-surprising, forgiving path.
        if (sinceIdx >= 0 && !isValidWindow(sinceVal)) {
          process.stderr.write(
            `nb stats: unrecognized --since '${sinceVal ?? ''}' (use Nd/Nh/Nm); showing 7d\n`,
          );
        }
        const windowMs = sinceIdx >= 0 ? parseWindowMs(sinceVal) : undefined;
        const maybeShelf = rest.find((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1));
        shelf = maybeShelf ?? '-';
        // `--json` emits the raw StatsReport (stable, machine-readable) so a
        // supervising agent can act on a loop/went-silent/high-error-rate
        // anomaly without regex-parsing the human table. The --since warning
        // above stays on stderr, keeping stdout pure JSON.
        if (rest.includes('--json')) {
          process.stdout.write(JSON.stringify(stats(dir, { shelf: maybeShelf, windowMs })) + '\n');
        } else {
          process.stdout.write(renderStats(dir, maybeShelf, windowMs) + '\n');
        }
        break;
      }
      case 'path': {
        // Read-only on notebook state (like `show`/`stats`, it still appends one
        // usage row via the shared `finally`): expose the file layout the
        // plain-text promise relies on, so nobody has to hard-code
        // `$NB_DIR | ~/.agent-notebook/notebooks/<shelf>.md`. Output is a BARE path
        // (no decoration) so it pipes into `cat`/`$(...)`.
        const maybeShelf = argv[1];
        if (maybeShelf == null || maybeShelf === '') {
          process.stdout.write(dir + '\n');
        } else {
          shelf = maybeShelf;
          assertSafeShelf(shelf); // reuse the existing escape-proof shelf check
          process.stdout.write(join(dir, `${shelf}.md`) + '\n');
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
        // `--json` is already stripped from `args`; pull out `--limit`, leaving
        // an optional positional name prefix as args[1].
        const { value: limitRaw, rest: listArgs } = extractOption(args, '--limit');
        let limit = LIST_DEFAULT_LIMIT;
        if (limitRaw !== undefined) {
          // Forgiving like `stats --since`: an unparseable --limit warns on
          // stderr (stdout/JSON stays clean) and falls back to the default,
          // rather than rejecting — the least-surprising path.
          if (/^\d+$/.test(limitRaw.trim())) {
            limit = Number.parseInt(limitRaw, 10);
          } else {
            process.stderr.write(
              `nb ${cmd}: unrecognized --limit '${limitRaw}' (use a non-negative integer); showing ${LIST_DEFAULT_LIMIT}\n`,
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
      default:
        process.stderr.write(`nb: unknown command "${cmd}". Try \`nb --help\`.\n`);
        return 2;
    }
    ok = true;
    return 0;
  } catch (e) {
    process.stderr.write(`nb ${cmd}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    // The `stats` read of the usage log happens above; logging it afterwards is fine.
    logUsage(dir, shelf, cmd, ok, Date.now() - started, meta);
  }
}

function need(v: string | undefined, name: string): string {
  if (v == null || v === '') throw new Error(`missing <${name}> argument`);
  return v;
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
  if (i + 1 >= args.length) throw new Error(`${flag} needs a value`);
  return { value: args[i + 1], rest: args.slice(0, i).concat(args.slice(i + 2)) };
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
    throw new Error(
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}
/* c8 ignore stop */

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

/**
 * Render the notebook index for `nb list`/`ls`/`shelves`/`roles`. Returns `{out, err}` so
 * the caller writes the body to stdout (pipe-clean) and a friendly empty-state
 * note to stderr, exactly like `nb roles` did. One header line, then one row per
 * notebook: `  <name>  <count>  <description>`, name left-padded and count
 * right-aligned so the columns line up. A notebook with no `# desc:` shows its
 * top-scored lesson instead, suffixed `(auto)`. The header reads `N` when every
 * match is shown, or `shown of total` when `--limit` truncated the list.
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
    const descPart = trigger ? `  ${trigger}${r.desc === null ? '  (auto)' : ''}` : '';
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
    // Distinguish "no searchable terms" from "searched, found nothing" — only the
    // latter is the logged gap signal.
    const err =
      result.terms.length === 0
        ? `nb search: no searchable terms in "${query}"\n`
        : `no lessons match "${query}" (${mode}) — search is the secondary path (lessons are surfaced to you, ` +
          `not searched); this miss was recorded as a possible coverage gap\n`;
    return { out: '', err };
  }
  const hitCount = result.groups.reduce((n, g) => n + g.hits.length, 0);
  const nbCount = result.groups.length;
  const lines = [
    `agent-notebook search — "${query}" (${mode} over ${result.terms.length} term${result.terms.length === 1 ? '' : 's'}): ` +
      `${hitCount} hit${hitCount === 1 ? '' : 's'} in ${nbCount} notebook${nbCount === 1 ? '' : 's'} ` +
      `(secondary fallback — lessons are normally surfaced to you, not searched)`,
  ];
  for (const g of result.groups) {
    const descPart = g.desc ? `  — ${g.desc}` : '';
    const descOnly = g.hits.length === 0 ? '  (description match)' : g.descMatched ? '  (+description match)' : '';
    lines.push(`  ${g.shelf}${descPart}${descOnly}`);
    for (const h of g.hits) {
      lines.push(`    ${h.id}  [${fmt(h.score)}]  ${h.text}`);
    }
  }
  return { out: lines.join('\n') + '\n', err: '' };
}

function renderStats(dir: string, shelf: string | undefined, windowMs: number | undefined): string {
  const rep = stats(dir, { shelf, windowMs });
  const lines: string[] = [];
  lines.push(`nb usage — ${shelf ? `shelf ${shelf}, ` : ''}window ${rep.window}, ${rep.totalCalls} calls`);
  // Ops-per-day activity sparkline (issue #106): one glyph per rolling-24h
  // bucket, oldest (leftmost) to the 24h ending now (rightmost). A silent bucket
  // reads as the floor glyph, so "went quiet N days ago" is visible at a glance.
  lines.push(`  activity  ${sparkline(rep.activity)}  (${rep.window}, ${rep.totalCalls} ops)`);
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
  void settleCliExit(runNbCli(process.argv.slice(2)));
}
/* c8 ignore stop */
