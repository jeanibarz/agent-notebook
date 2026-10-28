#!/usr/bin/env node
// `nb` — the Agent Notebook CLI. A role's bounded, voted memory: local plain
// text, no embeddings, no network, so every call is a fast, deterministic,
// offline file edit.
//
// Commands:
//   nb show   <role>                       print the notebook
//   nb add    <role> "<lesson>"            dedup-skip, score +1, write, trim (lowest-score out)
//   nb add    <role> -                     read the one-line lesson from stdin (multi-line refused)
//   nb vote   <role> <id|query> +1|-1      adjust an entry's score
//   nb merge  <role> <idA> <idB> "<merged>"  consolidate two entries into one
//   nb split  <role> <id|query> "<a>" "<b>"   cut one overloaded entry into two
//   nb rm     <role> <id|query>            delete an entry judged useless
//   (add/vote/rm/merge take --json: one structured result object on stdout)
//   nb stats  [<role>] [--since 7d] [--json]  usage analytics + anomaly flags (--json = raw StatsReport)
//   nb path   [<role>]                     print the notebooks dir, or a role's file path
//   nb roles                               list the roles that have a notebook, one per line
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
  assertSafeRole,
  entryId,
  isValidWindow,
  listRoles,
  logUsage,
  maxChars,
  merge,
  normalizeReason,
  notebooksDir,
  parseWindowMs,
  remove,
  render,
  split,
  stats,
  vote,
  type UsageMeta,
} from './notebook.js';

const HELP = `nb — the Agent Notebook (bounded, voted, per-role memory)

usage:
  nb show   <role>                        print the notebook (highest-scored first)
  nb add    <role> "<lesson>"             add a lesson (dedup-skipped; rejected if too long, never truncated)
  nb add    <role> -                      read the lesson from stdin (one line; multi-line is refused)
  nb vote   <role> <id|query> +1|-1       upvote/downvote an entry you used
  nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
  nb split  <role> <id|query> "<a>" "<b>" cut one overloaded entry into two (reverse of merge)
  nb rm     <role> <id|query>             delete an entry
  nb stats  [<role>] [--since 7d] [--json] usage analytics + anomaly flags (--json emits the raw StatsReport)
  nb path   [<role>]                      print the notebooks dir, or a role's resolved file path
  nb roles                                list the roles that have a notebook (one per line, sorted)
  nb --help                               show this help
  nb --version                            print the tool version

notes:
  - add/vote/rm/merge accept --json (after the subcommand): stdout is one JSON
    result object and nothing else; warnings/errors stay on stderr. Exit codes are
    unchanged (a too-long add still exits 1, a duplicate still exits 0).
  - \`nb add <role> -\` reads the lesson from stdin (one line, so a supervising agent
    can pipe it in without shell-quoting). It reads exactly one line: a trailing
    newline is stripped and multi-line input is REFUSED (exit 1), never flattened —
    one entry = one line. To store a literal single hyphen, use the library addEntry.
  - \`nb split\` is the reverse of \`merge\`: it replaces one overloaded entry with two,
    each inheriting the original's score. Each half is rejected (not truncated) if too
    long, and a split never creates a duplicate (the two halves must differ from each
    other and from every surviving entry, else the split is refused and nothing changes).
    It accepts an optional \`--reason <code>\` (+ \`--note "<text>"\`), logged (never stored
    in the notebook) so the split rate and its reason become a diagnostic signal:
      overloaded  the entry crammed two distinct lessons into one line — cut them apart
                  (e.g. "run build, then vitest" → "run build first" + "run vitest after build")
      other       any other motive; add \`--note\` so a recurring one can become its own code
    An unrecognized code is accepted as \`other\` (kept in the note), never rejected.
  - a notebook holds at most 200 lines; each lesson is one line of at most 200 chars.
  - an over-long add is REJECTED (exit 1), never truncated — rewrite shorter and retry.
  - when full, the LOWEST-scored line is evicted (ties: oldest).
  - every \`nb show\` line begins with the entry's short stable <id>; pass that id to vote/rm/merge
    (a unique id prefix works too). A unique text substring also selects an entry; an ambiguous one is refused.
  - storage: $NB_DIR or ~/.agent-notebook/notebooks/<role>.md (plain text, git-diffable).

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
  let role = '-';
  let ok = false;
  // Richer usage-log fields for this call (entry-level + outcome logging, #67).
  // Each command fills what it produced; `show`/`path`/`roles`/`stats` leave it
  // empty and `logUsage` writes blanks. `session` is filled by `logUsage` from
  // `NB_SESSION`, so it is not set here.
  const meta: UsageMeta = {};
  // `--json` on a mutation (add/vote/rm/merge) emits the library's structured
  // result object on stdout and nothing else, so a supervisor can branch on
  // `reason`/`score` without regex-parsing the English line. Strip it before
  // positional parsing (like `stats`, it is a flag, not a role/lesson), and keep
  // it only on the commands that return a result object — `show`/`path`/`roles`
  // ignore it. Exit codes are unchanged (a too-long add still exits 1).
  const json = argv.includes('--json');
  let args = json ? argv.filter((a) => a !== '--json') : argv;
  // `--reason <code>` / `--note "<text>"` attach an optional, never-required
  // reason to a mutating op, logged (never stored in the notebook). Only `split`
  // consumes them in this release (its enum: overloaded · other); pulling them
  // out of `args` BEFORE positional parsing keeps them from being mistaken for a
  // lesson operand. (The operation-reasons issue generalizes this to the other
  // mutating ops.)
  let reasonArg: string | undefined;
  let noteArg: string | undefined;
  try {
    if (cmd === 'split') {
      // Inside the try so a malformed flag (e.g. `--reason` with no value)
      // becomes a handled exit-1 error, not an uncaught rejection.
      ({ value: reasonArg, rest: args } = extractOption(args, '--reason'));
      ({ value: noteArg, rest: args } = extractOption(args, '--note'));
    }
    switch (cmd) {
      case 'show': {
        role = need(argv[1], 'role');
        process.stdout.write(render(dir, role) + '\n');
        break;
      }
      case 'add': {
        role = need(args[1], 'role');
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
        const r = await addEntry(dir, role, lesson);
        // Record which entry was touched and how it landed BEFORE the output
        // branch below, which can `throw`/`return` on 'too-long' — the finally
        // still logs, so meta must already be set.
        meta.entries = r.id ? [r.id] : [];
        meta.outcome = r.reason === 'added' ? 'accepted' : r.reason === 'duplicate' ? 'dedup-blocked' : r.reason;
        if (r.collidedId) meta.collided = r.collidedId;
        if (r.evicted) meta.evicted = `${entryId(r.evicted.text)}:${r.evicted.score}`;
        if (json) {
          // One result object on stdout; `too-long` keeps exit 1 (below) while
          // still emitting its `reason`, so a supervisor sees why it failed.
          process.stdout.write(JSON.stringify(r) + '\n');
          if (r.reason === 'too-long') return 1;
        } else if (r.reason === 'duplicate') process.stdout.write(`skipped (near-duplicate already present) — ${r.size} lines\n`);
        else if (r.reason === 'empty') process.stdout.write('skipped (empty lesson)\n');
        else if (r.reason === 'rejected-full') process.stdout.write(`skipped (notebook full — every entry outranks this lesson; vote one down or merge first) — ${r.size} lines\n`);
        else if (r.reason === 'too-long') throw new Error(`lesson too long (${r.length} chars > ${maxChars()} max). Rewrite it shorter as ONE complete line and retry — it was NOT truncated or stored.`);
        else {
          process.stdout.write(`added — ${r.size} lines`);
          if (r.evicted) process.stdout.write(` (evicted lowest-scored: [${fmt(r.evicted.score)}] ${r.evicted.text})`);
          process.stdout.write('\n');
        }
        break;
      }
      case 'vote': {
        role = need(args[1], 'role');
        const selector = need(args[2], 'id|query');
        const delta = parseDelta(need(args[3], '+1|-1'));
        const r = await vote(dir, role, selector, delta);
        meta.entries = [entryId(r.text)];
        meta.outcome = delta > 0 ? 'up' : 'down';
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`${delta > 0 ? '+1' : '-1'} → [${fmt(r.score)}] ${r.text}\n`);
        break;
      }
      case 'merge': {
        role = need(args[1], 'role');
        const a = need(args[2], 'idA');
        const b = need(args[3], 'idB');
        const merged = need(args[4], 'merged lesson');
        const r = await merge(dir, role, a, b, merged);
        meta.entries = [...(r.sources ?? []), ...(r.id ? [r.id] : [])];
        meta.outcome = 'merged';
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`merged two entries into one — ${r.size} lines\n`);
        break;
      }
      case 'split': {
        role = need(args[1], 'role');
        const selector = need(args[2], 'id|query');
        const lessonA = need(args[3], 'lessonA');
        const lessonB = need(args[4], 'lessonB');
        const r = await split(dir, role, selector, lessonA, lessonB);
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
        role = need(args[1], 'role');
        const selector = need(args[2], 'id|query');
        const r = await remove(dir, role, selector);
        meta.entries = [entryId(r.text)];
        meta.outcome = 'removed';
        if (json) process.stdout.write(JSON.stringify(r) + '\n');
        else process.stdout.write(`removed — [${fmt(r.score)}] ${r.text}\n`);
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
        const maybeRole = rest.find((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1));
        role = maybeRole ?? '-';
        // `--json` emits the raw StatsReport (stable, machine-readable) so a
        // supervising agent can act on a loop/went-silent/high-error-rate
        // anomaly without regex-parsing the human table. The --since warning
        // above stays on stderr, keeping stdout pure JSON.
        if (rest.includes('--json')) {
          process.stdout.write(JSON.stringify(stats(dir, { role: maybeRole, windowMs })) + '\n');
        } else {
          process.stdout.write(renderStats(dir, maybeRole, windowMs) + '\n');
        }
        break;
      }
      case 'path': {
        // Read-only on notebook state (like `show`/`stats`, it still appends one
        // usage row via the shared `finally`): expose the file layout the
        // plain-text promise relies on, so nobody has to hard-code
        // `$NB_DIR | ~/.agent-notebook/notebooks/<role>.md`. Output is a BARE path
        // (no decoration) so it pipes into `cat`/`$(...)`.
        const maybeRole = argv[1];
        if (maybeRole == null || maybeRole === '') {
          process.stdout.write(dir + '\n');
        } else {
          role = maybeRole;
          assertSafeRole(role); // reuse the existing escape-proof role check
          process.stdout.write(join(dir, `${role}.md`) + '\n');
        }
        break;
      }
      case 'roles': {
        // Read-only inventory of the notebooks dir (like `path`, it still appends
        // one usage row via the shared `finally`): make the set of memories
        // self-describing instead of forcing an `ls` + mental filtering of the
        // `.nb-usage.log`/`.nb.lock` sidecars. Plain list (names only, one per
        // line, sorted) so it pipes into `wc -l`/`xargs`/`$(...)`.
        const roles = listRoles(dir);
        if (roles.length === 0) {
          process.stderr.write('no roles yet — add one with `nb add <role> "<lesson>"`\n');
        } else {
          process.stdout.write(roles.join('\n') + '\n');
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
    logUsage(dir, role, cmd, ok, Date.now() - started, meta);
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
// The real stdin reader for `nb add <role> -`. Drains stdin to a string. Guards
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

function renderStats(dir: string, role: string | undefined, windowMs: number | undefined): string {
  const rep = stats(dir, { role, windowMs });
  const lines: string[] = [];
  lines.push(`nb usage — ${role ? `role ${role}, ` : ''}window ${rep.window}, ${rep.totalCalls} calls`);
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
      lines.push(`    [${a.kind}] ${a.command}${a.role ? ` (role ${a.role})` : ''}: ${a.detail}`);
    }
  } else {
    lines.push('  anomalies: none');
  }
  // Notebook inventory (issue #40): make memory pressure visible — a role at
  // `lines/cap` where the two are equal is one distinct add from an eviction,
  // flagged FULL so a supervisor spots it without listing files.
  const nb = rep.notebookTotals;
  if (rep.notebooks.length === 0) {
    lines.push('  notebooks: none');
  } else {
    lines.push(`  notebooks: ${nb.roles} role${nb.roles === 1 ? '' : 's'}, ${nb.lines} lines (cap ${nb.cap}/role)`);
    for (const n of rep.notebooks) {
      const full = n.lines >= n.cap ? '  FULL' : '';
      lines.push(`    ${n.role.padEnd(20)}  ${String(n.lines).padStart(4)}/${n.cap}${full}`);
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
