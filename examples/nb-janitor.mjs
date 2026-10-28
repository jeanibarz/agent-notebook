#!/usr/bin/env node
// nb-janitor — a READ-ONLY diagnostician for your Agent Notebook store.
//
// WHAT IT IS
//   `nb stats` tells you how ONE notebook is doing right now. The janitor takes
//   the long, cross-notebook view that stats cannot: it reads every notebook
//   file, the usage log, and (if NB_DIR is a git repo) the commit history, and
//   reports four things, each with a concrete suggested `nb` command:
//
//     1. Cap pressure & reorg       — notebooks near the cap (50 lines by default) that will
//                                      start evicting lessons; split candidates.
//     2. Near-duplicate ROLE names  — likely typos / fragmentation (e.g.
//                                      `reviewer` vs `review`) that split memory.
//     3. Likely duplicate LESSONS   — paraphrase pairs the exact-match dedup let
//                                      through; `nb merge` candidates. This is the
//                                      "duplicate detection" gap, found offline.
//     4. Volume over time & silence — from git history: how the store grew, how
//                                      busy it's been, and which roles went quiet.
//
// WHY A SEPARATE, OFFLINE TOOL
//   The notebook core stays dumb, deterministic, and offline (requirements.md
//   DP-6): nothing clever runs inside an `nb` call. All the "intelligence" —
//   fuzzy duplicate detection, reorg heuristics, trend analysis — lives here, in
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
    const role = f.slice(0, -3);
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
    return { role, lessons };
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

// role-name similarity (normalized edit-distance), for typo/fragmentation detect
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
      const [ts, role, command, status] = line.split('\t');
      if (!ts || !command) continue;
      rows.push({ ts, t: Date.parse(ts), role: role ?? '', command, ok: status === 'ok' });
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
        const m = /^nb\s+(\w+)/.exec(subject); // our wrapper's "nb <cmd> <role>" messages
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

// 1) cap pressure & reorg
const capPressure = notebooks
  .map((nb) => ({ role: nb.role, lessons: nb.lessons.length, pct: Math.round((nb.lessons.length / MAX_LINES) * 100) }))
  .filter((r) => r.pct >= 80)
  .sort((a, b) => b.pct - a.pct);

// 2) near-duplicate role names
const roleDups = [];
const roles = notebooks.map((n) => n.role);
for (let i = 0; i < roles.length; i++)
  for (let j = i + 1; j < roles.length; j++) {
    const sim = editSim(roles[i], roles[j]);
    // same namespace stem (`review.tests` vs `review.correctness`) is intentional, not a dup
    const sameNs = roles[i].split('.')[0] === roles[j].split('.')[0] && roles[i].includes('.') && roles[j].includes('.');
    if (sim >= 0.8 && !sameNs) roleDups.push({ a: roles[i], b: roles[j], sim: Number(sim.toFixed(2)) });
  }
roleDups.sort((x, y) => y.sim - x.sim);

// 3) likely duplicate lessons (within a role)
const lessonDups = [];
for (const nb of notebooks) {
  const toks = nb.lessons.map((e) => ({ ...e, tk: tokens(e.text) }));
  for (let i = 0; i < toks.length; i++)
    for (let j = i + 1; j < toks.length; j++) {
      const sim = jaccard(toks[i].tk, toks[j].tk);
      if (sim >= SIM) lessonDups.push({ role: nb.role, sim: Number(sim.toFixed(2)), a: toks[i].text, b: toks[j].text });
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
// silence: a role with lessons but no usage-log activity in the window
const SILENT_DAYS = DAYS;
const lastUse = {};
for (const r of usage) lastUse[r.role] = Math.max(lastUse[r.role] ?? 0, r.t || 0);
const silentRoles = notebooks
  .filter((nb) => nb.lessons.length > 0)
  .map((nb) => ({ role: nb.role, lastUse: lastUse[nb.role] ?? 0 }))
  .filter((r) => now - r.lastUse > SILENT_DAYS * 86400000)
  .map((r) => ({ role: r.role, daysQuiet: r.lastUse ? Math.round((now - r.lastUse) / 86400000) : null }));

const report = {
  dir: NB_DIR,
  notebooks: notebooks.length,
  totalLessons: notebooks.reduce((s, n) => s + n.lessons.length, 0),
  capPressure,
  roleDups,
  lessonDups,
  volume,
  silentRoles,
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

H('1. Cap pressure & reorg');
if (capPressure.length === 0) out.push('  ✅ no notebook is near the cap.');
else
  for (const r of capPressure) {
    out.push(`  ⚠️  ${r.role}: ${r.lessons}/${MAX_LINES} (${r.pct}%) — about to evict lessons.`);
    out.push(`      → split concerns into namespaces: nb split, or new roles ${r.role}.<concern>`);
  }

H('2. Near-duplicate role names (fragmented memory)');
if (roleDups.length === 0) out.push('  ✅ no suspiciously similar role names.');
else
  for (const d of roleDups) {
    out.push(`  ⚠️  "${d.a}" ~ "${d.b}" (name similarity ${d.sim}) — likely the same role, split in two.`);
    out.push(`      → consolidate: re-add ${d.b}'s lessons under "${d.a}" (or vice-versa), then retire the orphan.`);
  }

H(`3. Likely duplicate lessons (paraphrases, sim ≥ ${SIM})`);
if (lessonDups.length === 0) out.push('  ✅ no paraphrase duplicates above threshold.');
else
  for (const d of lessonDups.slice(0, 25)) {
    out.push(`  ⚠️  [${d.role}] sim ${d.sim}`);
    out.push(`        A: ${d.a}`);
    out.push(`        B: ${d.b}`);
    out.push(`      → if they say the same thing: nb merge ${d.role} "<A-substr>" "<B-substr>" "<one line>" --reason duplicate`);
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
if (silentRoles.length === 0) out.push('  ✅ no role has gone silent in the window.');
else
  for (const s of silentRoles)
    out.push(`  💤 ${s.role}: ${s.daysQuiet == null ? 'never used in the log' : `quiet ${s.daysQuiet}d`} — stale, or no longer exercised?`);

out.push('');
process.stdout.write(out.join('\n') + '\n');
