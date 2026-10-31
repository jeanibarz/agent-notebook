#!/usr/bin/env node
// nb-janitor — a READ-ONLY diagnostician for your Agent Notebook store.
//
// WHAT IT IS
//   `nb stats` tells you how ONE notebook is doing right now. The janitor takes
//   the long, cross-notebook view that stats cannot: it reads every notebook
//   file, the usage log, and (if NB_DIR is a git repo) the commit history, and
//   reports five things, each with a concrete suggested `nb` command:
//
//     1. Lessons lost to eviction   — shelves that evict lessons still scored above +1,
//                                      or whose evicted lessons get added again.
//                                      A full shelf alone is normal and not flagged.
//     2. Near-duplicate SHELF names — likely typos / fragmentation (e.g.
//                                      `build-and-test` vs `build-and-tests`) that split memory.
//     3. Likely duplicate LESSONS   — paraphrase pairs the exact-match dedup let
//                                      through; `nb merge` candidates. This is the
//                                      "duplicate detection" gap, found offline.
//     4. Volume over time & silence — from git history: how the store grew, how
//                                      busy it's been, and which shelves went quiet.
//     5. Shelf co-access            — which shelves get `show`n together in the same
//                                      session: pairs almost always opened together
//                                      (merge/namespace), and isolated shelves.
//                                      Needs NB_SESSION; degrades to a note without it.
//
// WHY A SEPARATE, OFFLINE TOOL
//   The notebook core stays dumb, deterministic, and offline (requirements.md
//   DP-6): nothing clever runs inside an `nb` call. All the "intelligence" —
//   fuzzy duplicate detection, eviction-loss heuristics, trend analysis — lives here, in
//   an offline janitor that only READS the plain files and PRINTS suggestions.
//   It never edits a notebook; you (or an agent) run the suggested commands.
//
// USAGE
//   node nb-janitor.mjs                 # scan $NB_DIR (default ~/.agent-notebook/notebooks)
//   NB_DIR=/path node nb-janitor.mjs    # scan a specific store
//   node nb-janitor.mjs --json          # machine-readable report
//   node nb-janitor.mjs --days 30       # history window for section 4 (default 30)
//   node nb-janitor.mjs --sim 0.55      # lesson-similarity threshold 0..1 (default 0.6)
//
// PORTABILITY: pure Node, zero dependencies; git is optional (section 4 degrades).

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const JSON_OUT = argv.includes('--json');
const DAYS = Math.max(1, Number.parseInt(flag('--days', '30'), 10) || 30);
const SIM = Math.min(1, Math.max(0, Number.parseFloat(flag('--sim', '0.6')) || 0.6));
const NB_DIR =
  process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? process.env.NB_DIR
    : join(homedir(), '.agent-notebook', 'notebooks');
const MAX_LINES = Number.parseInt(process.env.NB_MAX_LINES ?? '50', 10) || 50;

// ---- read the store (mirrors the package's file conventions) --------------
function readNotebooks(dir) {
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  } catch {
    return [];
  }
  return files.map((f) => {
    const shelf = f.slice(0, -3);
    let lessons = [];
    try {
      lessons = readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('#')) // skip the `# key:` metadata block
        .map((l) => {
          const tab = l.indexOf('\t');
          const text = tab === -1 ? l : l.slice(tab + 1);
          const score = tab === -1 ? 0 : Number.parseInt(l.slice(0, tab), 10) || 0;
          return { score, text: text.replace(/\s+/g, ' ').trim() };
        })
        .filter((e) => e.text !== '');
    } catch {
      /* unreadable → report as empty rather than crash the whole scan */
    }
    return { shelf, lessons };
  });
}

// ---- lexical similarity (the paraphrase-duplicate detector) ---------------
// Deterministic, cheap, explainable: normalize to content tokens, drop stopwords,
// and score a PAIR by token-overlap (Jaccard). No embeddings (NG-001) — this is
// exactly the "learned threshold over cheap features" rung, used read-only.
const STOP = new Set(
  ('a an the and or of to in on for with without is are be do does run the this that it its you your' +
    ' before after when then so if not no as at by from into over under via per vs use using') .split(/\s+/),
);
function tokens(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// shelf-name similarity (normalized edit-distance), for typo/fragmentation detect
function editSim(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m][n] / Math.max(m, n);
}

// ---- usage log ------------------------------------------------------------
function readUsage(dir) {
  const file = join(dir, '.nb-usage.log');
  if (!existsSync(file)) return [];
  const rows = [];
  try {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      // columns: ts, shelf, command, status, ms, session, entry-ids, outcome, collided, evicted, …
      const [ts, shelf, command, status, , session = '', entries = '', outcome = '', , evicted = ''] = line.split('\t');
      if (!ts || !command) continue;
      rows.push({
        ts,
        t: Date.parse(ts),
        shelf: shelf ?? '',
        command,
        session,
        ok: status === 'ok',
        entries: entries.split(',').filter((e) => e !== ''),
        outcome,
        evicted: evicted.split(':')[0] ?? '',
        evictedScore: Number(evicted.split(':')[1] ?? 0),
      });
    }
  } catch {
    /* ignore */
  }
  return rows;
}

// ---- git history (optional) ----------------------------------------------
function gitHistory(dir, days) {
  if (!existsSync(join(dir, '.git'))) return null;
  try {
    const since = `${days} days ago`;
    const out = execFileSync('git', ['-C', dir, 'log', `--since=${since}`, '--format=%cI\t%s'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commits = out
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [iso, subject = ''] = l.split('\t');
        const m = /^nb\s+(\w+)/.exec(subject); // our wrapper's "nb <cmd> <shelf>" messages
        return { day: iso.slice(0, 10), cmd: m ? m[1] : null };
      });
    return commits;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
const notebooks = readNotebooks(NB_DIR);
const usage = readUsage(NB_DIR);
const history = gitHistory(NB_DIR, DAYS);
const now = Date.now();

// 1) lessons lost to eviction. A full shelf is the normal state: eviction and
//    aging only run at the cap, and they are what retire unused lessons. So
//    fullness is reported for information only; a shelf is flagged when, within
//    the window, it evicts lessons still scored above the +1 a new lesson starts
//    at (net voted up, not aged out), or a lesson it
//    evicted is added again (agents had to relearn it).
const LOSS_MIN = 2; // one loss is ordinary churn; repeated losses are the signal
const fullShelves = notebooks.filter((nb) => nb.lessons.length >= MAX_LINES).map((nb) => nb.shelf);
const lossByShelf = {};
const evictedBefore = {}; // shelf → ids evicted earlier in the log
for (const r of usage) {
  if (r.command !== 'add') continue;
  const inWindow = now - r.t <= DAYS * 86400000;
  const seen = (evictedBefore[r.shelf] ??= new Set());
  const loss = (lossByShelf[r.shelf] ??= { shelf: r.shelf, stillVoted: 0, relearned: 0 });
  if (inWindow && r.outcome === 'accepted' && r.entries.some((id) => seen.has(id))) loss.relearned++;
  if (r.evicted !== '') {
    if (inWindow && r.evictedScore > 1) loss.stillVoted++;
    seen.add(r.evicted);
  }
}
const lostLessons = Object.values(lossByShelf)
  .filter((l) => l.stillVoted + l.relearned >= LOSS_MIN)
  .sort((a, b) => b.stillVoted + b.relearned - (a.stillVoted + a.relearned));

// 2) near-duplicate shelf names
const shelfDups = [];
const shelves = notebooks.map((n) => n.shelf);
for (let i = 0; i < shelves.length; i++)
  for (let j = i + 1; j < shelves.length; j++) {
    const sim = editSim(shelves[i], shelves[j]);
    // same namespace stem (`review.tests` vs `review.correctness`) is intentional, not a dup
    const sameNs = shelves[i].split('.')[0] === shelves[j].split('.')[0] && shelves[i].includes('.') && shelves[j].includes('.');
    if (sim >= 0.8 && !sameNs) shelfDups.push({ a: shelves[i], b: shelves[j], sim: Number(sim.toFixed(2)) });
  }
shelfDups.sort((x, y) => y.sim - x.sim);

// 3) likely duplicate lessons (within a shelf)
const lessonDups = [];
for (const nb of notebooks) {
  const toks = nb.lessons.map((e) => ({ ...e, tk: tokens(e.text) }));
  for (let i = 0; i < toks.length; i++)
    for (let j = i + 1; j < toks.length; j++) {
      const sim = jaccard(toks[i].tk, toks[j].tk);
      if (sim >= SIM) lessonDups.push({ shelf: nb.shelf, role: nb.shelf, sim: Number(sim.toFixed(2)), a: toks[i].text, b: toks[j].text });
    }
}
lessonDups.sort((x, y) => y.sim - x.sim);

// 4) volume over time & silence
let volume = null;
if (history) {
  const byDay = {};
  const byCmd = {};
  for (const c of history) {
    byDay[c.day] = (byDay[c.day] ?? 0) + 1;
    if (c.cmd) byCmd[c.cmd] = (byCmd[c.cmd] ?? 0) + 1;
  }
  volume = { source: 'git', windowDays: DAYS, commits: history.length, byCmd, activeDays: Object.keys(byDay).length };
}
// silence: a shelf with lessons but no usage-log activity in the window
const SILENT_DAYS = DAYS;
const lastUse = {};
for (const r of usage) lastUse[r.shelf] = Math.max(lastUse[r.shelf] ?? 0, r.t || 0);
const silentShelves = notebooks
  .filter((nb) => nb.lessons.length > 0)
  .map((nb) => ({ shelf: nb.shelf, lastUse: lastUse[nb.shelf] ?? 0 }))
  .filter((r) => now - r.lastUse > SILENT_DAYS * 86400000)
  .map((r) => ({ shelf: r.shelf, role: r.shelf, daysQuiet: r.lastUse ? Math.round((now - r.lastUse) / 86400000) : null }));

// 5) shelf co-access — which shelves get `show`n together in the same session.
//    A shelf is *defined* by co-access (lessons needed in the same situations),
//    so two shelves almost always opened together are really one (merge/namespace
//    candidate), and a shelf never opened alongside another is isolated. Rows
//    with a blank session carry no co-access signal (requirements.md FR-USAGE-002:
//    "co-access is then not computed"), so they are dropped here and the section
//    degrades to a one-line note when nothing is left — mirroring section 4
//    degrading without git.
const COACCESS_MIN_SUPPORT = 2; // a single shared session is coincidence, not a pattern
const COACCESS_MIN_RATIO = 0.8; // "almost always opened together"
const COACCESS_MAX_ROWS = 25; // cap each list like section 3
const sessionShelves = {}; // session → Set of shelves `show`n in it (non-blank sessions only)
for (const r of usage) {
  if (r.command !== 'show' || r.session === '' || r.shelf === '') continue;
  (sessionShelves[r.session] ??= new Set()).add(r.shelf);
}
const showsByShelf = {}; // shelf → # distinct non-blank sessions it was shown in
const coCount = new Map(); // "a\tb" (a<b) → # sessions showing both
let coAccessSessions = 0; // # non-blank sessions that showed ≥1 shelf
for (const shelves of Object.values(sessionShelves)) {
  const list = [...shelves].sort(); // a created set always holds ≥1 shelf
  coAccessSessions++;
  for (const s of list) showsByShelf[s] = (showsByShelf[s] ?? 0) + 1;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const key = `${list[i]}\t${list[j]}`;
      coCount.set(key, (coCount.get(key) ?? 0) + 1);
    }
}
const shelvesShown = Object.keys(showsByShelf);
const coAccessComputed = shelvesShown.length > 0;
const coPaired = new Set(); // shelves that co-occur with ≥1 other (any count)
const highPairs = [];
for (const [key, co] of coCount) {
  const [a, b] = key.split('\t');
  coPaired.add(a);
  coPaired.add(b);
  const support = Math.min(showsByShelf[a], showsByShelf[b]); // ≥1: a paired shelf was shown
  const ratio = co / support;
  if (co >= COACCESS_MIN_SUPPORT && ratio >= COACCESS_MIN_RATIO)
    highPairs.push({ a, b, co, support, ratio: Number(ratio.toFixed(2)) });
}
highPairs.sort((x, y) => y.ratio - x.ratio || y.co - x.co);
// isolated: shown but never alongside another shelf — only meaningful once ≥2
// distinct shelves were shown overall (with one, "isolated" is trivially true).
const isolated =
  shelvesShown.length >= 2
    ? shelvesShown
        .filter((s) => !coPaired.has(s))
        .map((s) => ({ shelf: s, shows: showsByShelf[s] }))
        .sort((x, y) => y.shows - x.shows)
    : [];
const coAccess = {
  computed: coAccessComputed,
  sessions: coAccessSessions,
  highPairs,
  isolated,
};

const report = {
  dir: NB_DIR,
  notebooks: notebooks.length,
  totalLessons: notebooks.reduce((s, n) => s + n.lessons.length, 0),
  fullShelves,
  lostLessons,
  shelfDups,
  roleDups: shelfDups, // deprecated alias of shelfDups
  lessonDups,
  volume,
  silentShelves,
  silentRoles: silentShelves, // deprecated alias of silentShelves
  coAccess,
  usageRows: usage.length,
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

// ---- human report ---------------------------------------------------------
const out = [];
const H = (s) => out.push('', `── ${s} ` + '─'.repeat(Math.max(0, 60 - s.length)));
out.push(`nb-janitor — ${report.notebooks} notebooks, ${report.totalLessons} lessons in ${NB_DIR}`);

H(`1. Lessons lost to eviction (last ${DAYS}d)`);
out.push(
  `  ${fullShelves.length} of ${notebooks.length} shelves are full (${MAX_LINES} lines) — normal: eviction keeps them focused.`,
);
if (lostLessons.length === 0) out.push('  ✅ no shelf repeatedly evicts lessons scored above +1 or relearns evicted ones.');
else
  for (const l of lostLessons) {
    out.push(`  ⚠️  ${l.shelf}: ${l.stillVoted} lesson(s) evicted with a score above +1, ${l.relearned} evicted lesson(s) added again.`);
    out.push(`      → nb show ${l.shelf}: if its lessons serve two different situations, split it by situation;`);
    out.push(`        otherwise nb merge near-duplicates to free lines, or raise NB_MAX_LINES.`);
  }

H('2. Near-duplicate shelf names (fragmented memory)');
if (shelfDups.length === 0) out.push('  ✅ no suspiciously similar shelf names.');
else
  for (const d of shelfDups) {
    out.push(`  ⚠️  "${d.a}" ~ "${d.b}" (name similarity ${d.sim}) — likely the same shelf, split in two.`);
    out.push(`      → consolidate: re-add ${d.b}'s lessons under "${d.a}" (or vice-versa), then retire the orphan.`);
  }

H(`3. Likely duplicate lessons (paraphrases, sim ≥ ${SIM})`);
if (lessonDups.length === 0) out.push('  ✅ no paraphrase duplicates above threshold.');
else
  for (const d of lessonDups.slice(0, 25)) {
    out.push(`  ⚠️  [${d.shelf}] sim ${d.sim}`);
    out.push(`        A: ${d.a}`);
    out.push(`        B: ${d.b}`);
    out.push(`      → if they say the same thing: nb merge ${d.shelf} "<A-substr>" "<B-substr>" "<one line>" --reason duplicate`);
  }
if (lessonDups.length > 25) out.push(`  …(${lessonDups.length - 25} more pairs — run with --json)`);

H(`4. Volume over time & silence (last ${DAYS}d)`);
if (volume)
  out.push(
    `  git: ${volume.commits} notebook commits on ${volume.activeDays} active days` +
      (Object.keys(volume.byCmd).length
        ? ` — ${Object.entries(volume.byCmd).map(([k, v]) => `${k}:${v}`).join('  ')}`
        : ''),
  );
else out.push('  (NB_DIR is not a git repo — enable git-versioning for growth trends: harness-setup.md#git-versioning)');
if (report.usageRows === 0) out.push('  (no usage log yet — set NB_SESSION and use the notebooks to populate it)');
if (silentShelves.length === 0) out.push('  ✅ no shelf has gone silent in the window.');
else
  for (const s of silentShelves)
    out.push(`  💤 ${s.shelf}: ${s.daysQuiet == null ? 'never used in the log' : `quiet ${s.daysQuiet}d`} — stale, or no longer exercised?`);

H('5. Shelf co-access (shown together in a session)');
if (!coAccess.computed)
  out.push(
    '  (no sessions with NB_SESSION set — co-access not computed; set NB_SESSION so shelves shown together can be correlated)',
  );
else {
  out.push(`  from ${coAccess.sessions} session(s) with a shelf shown.`);
  if (highPairs.length === 0)
    out.push('  ✅ no pair of shelves is almost always opened together.');
  else {
    for (const p of highPairs.slice(0, COACCESS_MAX_ROWS)) {
      out.push(
        `  ⚠️  "${p.a}" + "${p.b}" — shown together in ${p.co}/${p.support} session(s) (co-access ${p.ratio}); almost always opened together.`,
      );
      out.push(`      → consider one namespaced shelf (e.g. "${p.a}.*"/"${p.b}.*") or nb merge their overlapping lessons.`);
    }
    if (highPairs.length > COACCESS_MAX_ROWS)
      out.push(`  …(${highPairs.length - COACCESS_MAX_ROWS} more pairs — run with --json)`);
  }
  if (isolated.length === 0) out.push('  ✅ no isolated shelf (every shown shelf shares a session with another).');
  else {
    for (const s of isolated.slice(0, COACCESS_MAX_ROWS))
      out.push(`  🏝️  ${s.shelf}: shown in ${s.shows} session(s), never alongside another shelf — isolated.`);
    if (isolated.length > COACCESS_MAX_ROWS)
      out.push(`  …(${isolated.length - COACCESS_MAX_ROWS} more isolated — run with --json)`);
  }
}

out.push('');
process.stdout.write(out.join('\n') + '\n');
