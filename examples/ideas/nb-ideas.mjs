#!/usr/bin/env node
// nb-ideas — a second, separate agent-notebook folder for "ideas": things a task
// showed should be deleted, merged, shortened, split, corrected or made to fail
// loudly. It wraps the real `nb` CLI and adds a few rules that keep that folder
// small and honest.
//
// WHAT IT ADDS
//   The lessons notebooks answer "what should the next agent know?". This store
//   answers "what in this project should change?". Agents record at most one
//   idea per task, in one fixed line format, and when a similar idea already
//   exists they vote for it instead of adding a near-copy. A later curator
//   (human or agent) reads `nb-ideas support` and promotes only the ideas that
//   enough distinct tasks ran into.
//
//   A line looks like:
//     <target>: <problem> -> <change> (keeps: <behaviour that must keep working>)
//   and lives on a shelf named `<category>@<project>` inside NB_IDEAS_DIR, which
//   is a notebooks folder of its own: your lessons NB_DIR is never touched.
//
// HOW TO INSTALL
//   Keep this file where it is and put a two-line shim on PATH (the shim keeps
//   the .mjs name, which older Node needs to run an ES module):
//       mkdir -p ~/.local/bin
//       printf '#!/bin/sh\nexec node "%s" "$@"\n' "$(npm root -g)/agent-notebook/examples/ideas/nb-ideas.mjs" > ~/.local/bin/nb-ideas
//       chmod +x ~/.local/bin/nb-ideas     # ~/.local/bin must be on PATH
//   It finds the `agent-notebook` package it ships in (or the global npm root)
//   and runs that package's own CLI. Set NB_BIN to run another `nb` command,
//   for example the git wrapper (examples/nb-git-wrapper.mjs).
//
// THE RULES (each refusal says what to do next)
//   - the category must be in the list (`nb-ideas categories`);
//   - the line must match the format above (nb itself rejects an over-long line);
//   - one `add` per task (per NB_SESSION and project); further ideas are votes;
//   - an identical line is turned into a +1 vote instead of a duplicate;
//   - a line with the same target or similar text is NOT recorded: exit 3 and
//     the matches are printed; vote for one, or re-run with --new;
//   - a +1 vote needs --because; a task votes once per idea and never +1s its own.
//
// EXIT CODES   0 done | 2 refused by a rule or bad usage | 3 similar ideas found,
//              nothing recorded | otherwise the exit code of `nb` itself.
//
// SIDE LOG
//   Every add and vote made through this wrapper is appended to
//   $NB_IDEAS_DIR/.ideas-support.log (TSV: time, session, event, shelf, id, delta,
//   reason). `nb-ideas support` counts distinct supporting tasks from it.
//
// Environment: see the table in examples/ideas/README.md. Pure Node >= 18, no
// dependencies, no shell.

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

// Default categories, in tie-break order: when two fit, take the first. Each
// definition becomes the description of the shelf the first time it is used.
// Override with a `categories.txt` file in NB_IDEAS_DIR (`name: definition` per line).
const DEFAULT_CATEGORIES = [
  ['guidance', 'a doc, rule, comment or help text is wrong, stale or redundant: correct, shorten or delete it'],
  ['dead', 'code, flag, file, script or config that nothing uses: delete it'],
  ['duplicate', 'the same logic, rule or data in two places: merge it'],
  ['overbuilt', 'an abstraction, indirection, option or layer more complex than the job: inline or collapse it'],
  ['tangled', 'mixed responsibilities or code in the wrong layer: split or move it'],
  ['unused', 'a working feature or option that is rarely used or confusing: remove or unify it (the curator asks a human)'],
  ['fragile', 'a swallowed error, silent fallback, fail-open check, race, missing timeout or wrong result: make it fail loudly and simply'],
  ['tests', 'a tautological, duplicated, flaky or slow test, or one tied to implementation details: delete, merge or rewrite it'],
];

const FORMAT = '<target>: <problem> -> <change> (keeps: <behaviour that must keep working>)';
const LINE_RE = /^(\S[^:]*?): (.+) -> (.+) \(keeps: (.+)\)$/;
const NAME_RE = /^[a-z0-9-]+$/;
const LOG_NAME = '.ideas-support.log';
const REASON_CAP = 300;

const USAGE = `nb-ideas: a separate notebooks folder for improvement ideas, with rules.

Usage
  nb-ideas add <category> "<line>" [--project P] [--new] [--because "<why>"]
  nb-ideas vote <shelf-or-category> <id> <+1|-1> [--because "<what hit it>"] [--project P]
  nb-ideas show [--project P] [--json]
  nb-ideas support [--project P] [--json]
  nb-ideas prompt [--session ID] [--project P]
  nb-ideas categories
  nb-ideas help
  nb-ideas <anything else>     passed to nb (list, rm, describe, doctor, stats, path, ...)

Line format
  ${FORMAT}

Exit codes
  0 done | 2 refused by a rule or bad usage | 3 similar ideas found, nothing recorded

Environment (details in examples/ideas/README.md)
  NB_IDEAS_DIR  NB_IDEAS_PROJECT  NB_IDEAS_MAX_CHARS  NB_IDEAS_MAX_LINES
  NB_IDEAS_SIMILARITY  NB_IDEAS_PROMOTE_SCORE  NB_IDEAS_PROMOTE_TASKS  NB_SESSION  NB_BIN
`;

// ---------------------------------------------------------------- plumbing

/** Thrown to end the command with an exit code and optional output. */
class Exit extends Error {
  constructor(code, stderr = '', stdout = '') {
    super(stderr);
    this.code = code;
    this.stdout = stdout;
  }
}
const refuse = (msg) => new Exit(2, msg.endsWith('\n') ? msg : msg + '\n');

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function floatEnv(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const config = () => ({
  dir: expandHome(process.env.NB_IDEAS_DIR || join(homedir(), '.agent-notebook', 'ideas')),
  maxChars: intEnv('NB_IDEAS_MAX_CHARS', 400),
  maxLines: intEnv('NB_IDEAS_MAX_LINES', 50),
  threshold: floatEnv('NB_IDEAS_SIMILARITY', 0.4),
  promoteScore: floatEnv('NB_IDEAS_PROMOTE_SCORE', 3),
  promoteTasks: intEnv('NB_IDEAS_PROMOTE_TASKS', 2),
});

/** Task id: NB_SESSION cleaned like a file-name part (same rule as the Stop hook). */
function currentSession() {
  const raw = (process.env.NB_SESSION || '').trim();
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}
const cleanSession = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);

/** Split argv into positionals and flags; unknown flags are a usage error. */
function parseArgs(argv, valueFlags, boolFlags) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (valueFlags.includes(name)) {
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw refuse(`--${name} needs a value`);
      flags[name] = value;
    } else if (boolFlags.includes(name)) {
      flags[name] = true;
    } else {
      throw refuse(`unknown option --${name}; run \`nb-ideas help\``);
    }
  }
  return { pos, flags };
}

// ------------------------------------------------------------ finding `nb`

function globalNpmRoot() {
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

let cachedMain;
/** The installed agent-notebook package's main file (dist/index.js). */
function packageMain() {
  if (cachedMain) return cachedMain;
  const require = createRequire(import.meta.url);
  let main;
  try {
    main = require.resolve('agent-notebook');
  } catch {
    const root = globalNpmRoot();
    if (root) {
      try {
        main = require.resolve('agent-notebook', { paths: [root] });
      } catch {
        /* reported below */
      }
    }
  }
  if (!main) {
    throw new Exit(1, `nb-ideas: cannot find the agent-notebook package (looked beside ${dirname(fileURLToPath(import.meta.url))} and in the global npm root)\n`);
  }
  cachedMain = main;
  return main;
}

let cachedSimilarity;
/** similarity(a, b): character-trigram Jaccard in [0,1], from the package. */
async function loadPackageHelpers() {
  if (!cachedSimilarity) {
    const mod = await import(pathToFileURL(packageMain()).href);
    cachedSimilarity = { similarity: mod.similarity, dedupKey: mod.dedupKey };
  }
  return cachedSimilarity;
}

/** The environment every child `nb` gets: the ideas folder and the ideas caps. */
function childEnv(cfg) {
  return { ...process.env, NB_DIR: cfg.dir, NB_MAX_CHARS: String(cfg.maxChars), NB_MAX_LINES: String(cfg.maxLines) };
}

/** Run nb with the ideas environment; returns { status, stdout, stderr }. */
function nb(cfg, args) {
  const bin = process.env.NB_BIN;
  const [cmd, cmdArgs] = bin ? [bin, args] : [process.execPath, [join(dirname(packageMain()), 'cli.js'), ...args]];
  const r = spawnSync(cmd, cmdArgs, { env: childEnv(cfg), encoding: 'utf-8', timeout: 60000 });
  if (r.error) throw new Exit(1, `nb-ideas: cannot run ${cmd}: ${r.error.message}\n`);
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function nbJson(cfg, args) {
  const r = nb(cfg, args);
  try {
    return { ...r, json: JSON.parse(r.stdout) };
  } catch {
    return { ...r, json: null };
  }
}

// --------------------------------------------------- project and categories

function resolveProject(flag) {
  let raw = flag || process.env.NB_IDEAS_PROJECT || '';
  if (!raw) {
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).trim();
      raw = basename(top);
    } catch {
      /* not a git repo */
    }
  }
  const slug = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  if (slug === '' || /^-+$/.test(slug)) {
    throw refuse('cannot tell which project this is: run inside a git repository, or pass --project <slug> (or set NB_IDEAS_PROJECT)');
  }
  return slug;
}

/** [[name, definition], ...] in tie-break order: categories.txt if present, else the defaults. */
function loadCategories(cfg) {
  const file = join(cfg.dir, 'categories.txt');
  if (!existsSync(file)) return DEFAULT_CATEGORIES;
  const out = [];
  for (const [i, line] of readFileSync(file, 'utf-8').split(/\r?\n/).entries()) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(t);
    if (!m || !NAME_RE.test(m[1])) {
      throw refuse(`${file} line ${i + 1}: expected "name: definition" with a name of a-z, 0-9 and "-" only`);
    }
    out.push([m[1], m[2]]);
  }
  if (out.length === 0) throw refuse(`${file} lists no categories`);
  return out;
}

const categoryList = (cats) => cats.map(([n]) => n).join(', ');

// ----------------------------------------------------------------- side log

const logPath = (cfg) => join(cfg.dir, LOG_NAME);

function appendLog(cfg, ev) {
  mkdirSync(cfg.dir, { recursive: true });
  const reason = String(ev.reason || '').replace(/[\t\r\n]+/g, ' ').slice(0, REASON_CAP);
  const row = [new Date().toISOString(), ev.session, ev.event, ev.shelf, ev.id, ev.delta || '', reason];
  appendFileSync(logPath(cfg), row.join('\t') + '\n');
}

function readLog(cfg) {
  if (!existsSync(logPath(cfg))) return [];
  return readFileSync(logPath(cfg), 'utf-8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [ts, session, event, shelf, id, delta, reason] = l.split('\t');
      return { ts, session: session || '', event, shelf, id, delta: delta || '', reason: reason || '' };
    });
}

// ------------------------------------------------------------------ shelves

/** Load every `*@<project>` shelf: [{ shelf, category, description, entries }]. */
function loadProjectShelves(cfg, project) {
  if (!existsSync(cfg.dir)) return [];
  const suffix = `@${project}.md`;
  const names = readdirSync(cfg.dir)
    .filter((f) => f.endsWith(suffix) && !f.startsWith('.'))
    .map((f) => f.slice(0, -3))
    .sort();
  if (names.length === 0) return [];
  const r = nbJson(cfg, ['show', '--json', ...names]);
  if (r.status !== 0 || r.json === null) {
    throw new Exit(r.status || 1, r.stderr || `nb-ideas: nb show failed\n`);
  }
  const list = Array.isArray(r.json) ? r.json : [r.json];
  return list
    .filter((s) => s.exists)
    .map((s) => ({ shelf: s.shelf, category: s.shelf.split('@')[0], description: s.description, entries: s.entries }));
}

const allIdeas = (shelves) =>
  shelves.flatMap((s) => s.entries.map((e) => ({ shelf: s.shelf, id: e.id, score: e.score, text: e.text, key: e.key })));

const targetOf = (text) => {
  const m = LINE_RE.exec(text);
  return m ? m[1].trim().toLowerCase() : null;
};

function noteSessionUnset(session) {
  if (!session) {
    process.stderr.write('note: NB_SESSION is unset, so per-task rules are not checked and this event counts as its own task\n');
  }
}

// ----------------------------------------------------------------- commands

async function cmdAdd(argv) {
  const { pos, flags } = parseArgs(argv, ['project', 'because'], ['new']);
  if (pos.length !== 2) throw refuse(`usage: nb-ideas add <category> "<line>" [--project P] [--new] [--because "<why>"]`);
  const [category, line] = [pos[0], pos[1].trim()];
  const cfg = config();
  const cats = loadCategories(cfg);
  const cat = cats.find(([n]) => n === category);
  if (!cat) throw refuse(`unknown category "${category}". Categories (first that fits): ${categoryList(cats)}`);
  if (!LINE_RE.test(line)) {
    throw refuse(`the line does not match the format:\n  ${FORMAT}\nGot: ${line}`);
  }
  const project = resolveProject(flags.project);
  const session = currentSession();
  noteSessionUnset(session);

  // One idea per task.
  if (session) {
    const prior = readLog(cfg).find((e) => e.event === 'add' && e.session === session && e.shelf.endsWith(`@${project}`));
    if (prior) {
      throw refuse(`this task already recorded idea ${prior.id} (${prior.shelf}); vote instead:\n  nb-ideas vote ${prior.shelf} <id> +1 --because "<what in this task hit it>"`);
    }
  }

  const { similarity, dedupKey } = await loadPackageHelpers();
  const shelves = loadProjectShelves(cfg, project);
  const ideas = allIdeas(shelves);
  const shelf = `${category}@${project}`;

  // An identical line anywhere in the project is a vote, not a new idea.
  const key = dedupKey(line);
  const same = ideas.find((i) => i.key === key);
  if (same) {
    return doVote(cfg, {
      shelf: same.shelf,
      id: same.id,
      delta: 1,
      reason: flags.because || 're-added the identical line',
      session,
      note: `identical idea already recorded in ${same.shelf}; counted as a vote`,
    });
  }

  // A similar idea (same target, or similar text) is shown instead of recorded.
  if (!flags.new) {
    const target = targetOf(line);
    const matches = ideas
      .map((i) => ({ ...i, sim: similarity(line, i.text), sameTarget: target !== null && targetOf(i.text) === target }))
      .filter((i) => i.sameTarget || i.sim >= cfg.threshold)
      .sort((a, b) => b.sim - a.sim);
    if (matches.length > 0) {
      const rows = matches.map(
        (m) => `  ${m.shelf}  ${m.id}  [${m.score}]  similarity ${m.sim.toFixed(2)}${m.sameTarget ? ', same target' : ''}\n    ${m.text}`,
      );
      throw new Exit(
        3,
        '',
        `Not recorded: similar ideas already exist.\n${rows.join('\n')}\n` +
          `If one of them is what you hit, vote for it:\n  nb-ideas vote <shelf> <id> +1 --because "<what in this task hit it>"\n` +
          `If yours is a different idea, record it anyway:\n  re-run the same command with --new\n`,
      );
    }
  }

  const r = nbJson(cfg, ['add', '--json', shelf, line]);
  const res = r.json;
  if (res && res.reason === 'duplicate' && res.collidedId) {
    // Lost a race against an identical add: count this one as a vote.
    return doVote(cfg, {
      shelf,
      id: res.collidedId,
      delta: 1,
      reason: flags.because || 're-added the identical line',
      session,
      note: `identical idea already recorded in ${shelf}; counted as a vote`,
    });
  }
  if (res && res.reason === 'too-long') {
    throw refuse(`the line is ${res.length} characters, ${res.overflow} over the cap of ${cfg.maxChars} (NB_IDEAS_MAX_CHARS). Shorten it.`);
  }
  if (r.status !== 0 || !res || !res.added) {
    throw new Exit(r.status || 1, r.stderr || r.stdout || 'nb-ideas: nb add failed\n');
  }

  const known = shelves.find((s) => s.shelf === shelf);
  if (!known || !known.description) nb(cfg, ['describe', shelf, cat[1]]);
  appendLog(cfg, { session, event: 'add', shelf, id: res.id, reason: flags.because });
  const evicted = res.evicted ? `\nnote: ${shelf} was full; nb evicted its lowest-scored idea` : '';
  return `added ${res.id} to ${shelf}${evicted}\n`;
}

/**
 * Vote on an idea and log it. Applies the per-task rules when a session is set:
 * one vote per idea per task, and no +1 on an idea the same task added.
 */
function doVote(cfg, { shelf, id, delta, reason, session, note }) {
  const sign = delta > 0 ? '+1' : '-1';
  if (session) {
    const mine = readLog(cfg).filter((e) => e.session === session && e.shelf === shelf && e.id === id);
    if (mine.some((e) => e.event === 'vote')) {
      throw refuse(`this task already voted on ${id} (${shelf}); one vote per idea per task`);
    }
    if (delta > 0 && mine.some((e) => e.event === 'add')) {
      throw refuse(`this task added ${id} (${shelf}); it cannot +1 its own idea`);
    }
  }
  const current = nbJson(cfg, ['show', '--json', shelf]).json;
  if (!current || !current.exists) throw refuse(`no shelf ${shelf} in ${cfg.dir}; run \`nb-ideas show\` to see the shelves`);
  if (!current.entries.some((e) => e.id === id)) {
    const ids = current.entries.map((e) => `  ${e.id}  ${e.text}`).join('\n');
    throw refuse(`no idea with id ${id} in ${shelf}. Ideas there:\n${ids}`);
  }
  const r = nbJson(cfg, ['vote', '--json', shelf, id, sign]);
  if (r.status !== 0 || !r.json) throw new Exit(r.status || 1, r.stderr || r.stdout || 'nb-ideas: nb vote failed\n');
  appendLog(cfg, { session, event: 'vote', shelf, id, delta: sign, reason });
  return `${note ? note + '\n' : ''}voted ${sign} on ${shelf} ${id}: score is now ${r.json.score}\n`;
}

function cmdVote(argv) {
  const { pos, flags } = parseArgs(argv, ['project', 'because'], []);
  if (pos.length !== 3) throw refuse(`usage: nb-ideas vote <shelf-or-category> <id> <+1|-1> [--because "<what in this task hit it>"] [--project P]`);
  const [target, id, sign] = pos;
  if (sign !== '+1' && sign !== '-1') throw refuse(`the vote must be +1 or -1, got "${sign}"`);
  const delta = sign === '+1' ? 1 : -1;
  if (delta > 0 && !(flags.because || '').trim()) {
    throw refuse('a +1 vote needs --because "<what in this task hit this idea>": the reason is what makes it count as support');
  }
  const cfg = config();
  const shelf = target.includes('@') ? target : `${target}@${resolveProject(flags.project)}`;
  const session = currentSession();
  noteSessionUnset(session);
  return doVote(cfg, { shelf, id, delta, reason: flags.because, session });
}

function cmdShow(argv) {
  const { flags } = parseArgs(argv, ['project'], ['json']);
  const cfg = config();
  const project = resolveProject(flags.project);
  const ideas = allIdeas(loadProjectShelves(cfg, project)).sort((a, b) => b.score - a.score);
  if (flags.json) return JSON.stringify(ideas.map(({ shelf, id, score, text }) => ({ shelf, id, score, text }))) + '\n';
  if (ideas.length === 0) return `no ideas recorded for ${project}\n`;
  return ideas.map((i) => `${i.shelf}  ${i.id}  [${i.score}]  ${i.text}`).join('\n') + '\n';
}

function cmdSupport(argv) {
  const { flags } = parseArgs(argv, ['project'], ['json']);
  const cfg = config();
  const project = resolveProject(flags.project);
  const log = readLog(cfg);
  const rows = allIdeas(loadProjectShelves(cfg, project)).map((i) => {
    // A task supports an idea by adding it, or by voting +1 with a reason.
    const events = log.filter(
      (e) => e.shelf === i.shelf && e.id === i.id && (e.event === 'add' || (e.event === 'vote' && e.delta === '+1' && e.reason !== '')),
    );
    const named = new Set(events.filter((e) => e.session !== '').map((e) => e.session));
    const unattributed = events.filter((e) => e.session === '').length;
    const tasks = named.size + unattributed;
    return {
      shelf: i.shelf,
      id: i.id,
      score: i.score,
      tasks,
      unattributed,
      promotable: i.score >= cfg.promoteScore && tasks >= cfg.promoteTasks,
      text: i.text,
    };
  });
  rows.sort((a, b) => Number(b.promotable) - Number(a.promotable) || b.score - a.score);
  if (flags.json) return JSON.stringify(rows) + '\n';
  if (rows.length === 0) return `no ideas recorded for ${project}\n`;
  const head = `promotable = score >= ${cfg.promoteScore} and supporting tasks >= ${cfg.promoteTasks}\n`;
  const body = rows.map(
    (r) =>
      `${r.promotable ? 'PROMOTABLE' : '-         '}  ${r.shelf}  ${r.id}  [${r.score}]  tasks ${r.tasks}` +
      `${r.unattributed ? ` (${r.unattributed} unattributed)` : ''}  ${r.text}`,
  );
  return head + body.join('\n') + '\n';
}

function cmdPrompt(argv) {
  const { flags } = parseArgs(argv, ['project', 'session'], []);
  const cfg = config();
  const project = resolveProject(flags.project);
  const cats = loadCategories(cfg);
  const session = cleanSession(flags.session);
  const pre = session ? `NB_SESSION=${session} ` : '';
  return (
    `Before you finish: did this task show that something in ${project} should be deleted, merged, shortened, split,\n` +
    `corrected or made to fail loudly? Most tasks have nothing to record; that is the expected answer, and then you just\n` +
    `stop.\n` +
    `If one did, record at most one idea:\n` +
    `  ${pre}nb-ideas add <category> "${FORMAT.replace('<target>', '<file or command>')}"\n` +
    `Categories, first that fits: ${categoryList(cats)} (nb-ideas categories).\n` +
    `No new features. If it lists similar ideas, vote for the one you hit instead:\n` +
    `  ${pre}nb-ideas vote <shelf> <id> +1 --because "<what in this task hit it>"\n` +
    `or re-run the add with --new if yours is different.\n`
  );
}

function cmdCategories() {
  const cats = loadCategories(config());
  return cats.map(([n, d]) => `${n}: ${d}`).join('\n') + '\n';
}

function passthrough(argv) {
  const cfg = config();
  const bin = process.env.NB_BIN;
  const [cmd, args] = bin ? [bin, argv] : [process.execPath, [join(dirname(packageMain()), 'cli.js'), ...argv]];
  const r = spawnSync(cmd, args, { env: childEnv(cfg), stdio: 'inherit' });
  if (r.error) throw new Exit(1, `nb-ideas: cannot run ${cmd}: ${r.error.message}\n`);
  return r.status ?? 1;
}

// --------------------------------------------------------------------- main

async function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === undefined) throw new Exit(2, USAGE);
  switch (sub) {
    case 'help':
    case '--help':
    case '-h':
      return USAGE;
    case 'add':
      return cmdAdd(rest);
    case 'vote':
      return cmdVote(rest);
    case 'show':
      return cmdShow(rest);
    case 'support':
      return cmdSupport(rest);
    case 'prompt':
      return cmdPrompt(rest);
    case 'categories':
      return cmdCategories();
    default:
      return passthrough(argv);
  }
}

try {
  const out = await main(process.argv.slice(2));
  if (typeof out === 'number') process.exitCode = out;
  else process.stdout.write(out);
} catch (e) {
  if (!(e instanceof Exit)) throw e;
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.message) process.stderr.write(e.message);
  process.exitCode = e.code;
}
