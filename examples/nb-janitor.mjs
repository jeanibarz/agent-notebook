#!/usr/bin/env node
// nb-janitor — a READ-ONLY diagnostician for your Agent Notebook store.
//
// WHAT IT IS
//   `nb stats` tells you how ONE notebook is doing right now. The janitor takes
//   the long, cross-notebook view that stats cannot: it reads every notebook
//   file, the usage log, and (if NB_DIR is a git repo) the commit history, and
//   reports eight things, each with a concrete suggested `nb` command:
//
//     1. Lessons lost to eviction   — shelves that evict lessons still scored above +1,
//                                      or whose evicted lessons get added again.
//                                      A full shelf alone is normal and not flagged.
//     2. Near-duplicate SHELF names — likely typos / fragmentation (e.g.
//                                      `build-and-test` vs `build-and-tests`) that split memory.
//                                      Also "possible slug drift": the same base name under
//                                      two `@slug`s where the shorter slug is the longer one
//                                      with its leading part dropped (`x@app` / `x@acme-app`).
//     3. Likely duplicate LESSONS   — paraphrase pairs the exact-match dedup let
//                                      through; `nb merge` candidates. This is the
//                                      "duplicate detection" gap, found offline.
//     4. Volume over time & silence — from git history: how the store grew, how
//                                      busy it's been, and which shelves went quiet.
//     5. Shelf co-access            — which shelves get `show`n together in the same
//                                      session: pairs almost always opened together,
//                                      split into `fragment` (one role in two →
//                                      merge/namespace) vs `panel` (distinct roles
//                                      that co-fire → expected), and isolated shelves.
//                                      Needs NB_SESSION; degrades to a note without it.
//     6. Curation (+1-floor)        — window upvotes vs downvotes (is voting one-sided?)
//                                      and shelves piled with never-reinforced +1 lessons
//                                      to scan for ones that misfired (downvote/rm).
//     7. Undescribed shelves        — shelves with no `# desc:` trigger, ranked by
//                                      browse-without-use so the noisiest get a trigger
//                                      first (`nb describe`). Browse rank needs NB_SESSION.
//     8. Exact duplicates across    — the same lesson (equal `dedupKey`, nb's own normal form)
//        shelves                       held by two or more shelves that share a base name
//                                      (`orchestrator@a`, `orchestrator@b`): `nb move` one copy
//                                      to the shared `<base>` shelf, `nb rm` the others.
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
import { createHash } from 'node:crypto';

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : dflt;
};
const JSON_OUT = argv.includes('--json');
const DAYS = Math.max(1, Number.parseInt(flag('--days', '30'), 10) || 30);
const SIM = Math.min(1, Math.max(0, Number.parseFloat(flag('--sim', '0.6')) || 0.6));
/** Expand a leading `~` / `~/…` (and `~\\…` on Windows) exactly like the package's
 *  `expandHomeDir` (issue #334): `NB_DIR` set where no shell expands it (settings.json
 *  `env`, systemd, cron) must not become a literal `~` directory. `~user/…` is left alone. */
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (process.platform === 'win32' && value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

const NB_DIR =
  process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? expandHome(process.env.NB_DIR)
    : join(homedir(), '.agent-notebook', 'notebooks');
const MAX_LINES = Number.parseInt(process.env.NB_MAX_LINES ?? '50', 10) || 50;
// The usage ring is bounded by ROW COUNT, not time (see notebook.ts usageRing():
// default 5000, clamped to 100..100000). Mirror that clamp so we can tell when a
// `--days` window reaches further back than the rows the ring still retains — an
// active store rotates old rows out, so a wide window can be partially blind to
// evicted activity and otherwise report a false all-clear (#275).
// Mirror notebook.ts clampInt() EXACTLY (default 5000 only when the value is
// non-finite; a finite 0 or negative clamps UP to the 100 floor, it does NOT
// fall back to the default) — the `|| 5000` idiom would mishandle `NB_USAGE_RING=0`
// (→ 5000 here vs 100 in core) and misjudge capacity.
const USAGE_RING = (() => {
  const raw = process.env.NB_USAGE_RING;
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(100000, Math.max(100, n)) : 5000;
})();

// ---- nb's own exact-duplicate normal form ---------------------------------
// Sections 2 and 8 compare lessons by `dedupKey`, the normal form `nb add|merge|move`
// itself uses to refuse an exact duplicate, and name a lesson by `entryId`, the id
// `nb show` prints. This script ships dependency-free and runs standalone, so it
// cannot import them from the package: it mirrors `sanitizeLesson` + `dedupKey` +
// `entryId` (src/notebook.ts), and src/nb-janitor-layers.test.ts pins the mirror to the
// package's own `nb show --json` `key`/`id` so the two cannot drift silently.
// The control/zero-width set is DELETED first (as nb does on write), not turned
// into a space the way the punctuation rule would, or a lesson holding one would
// get a different key here than in nb.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
// A git merge-conflict marker line (nb refuses to rewrite a shelf holding one): its text
// ("<<<<<<< HEAD", "=======") is not a lesson, so it never counts as a duplicate.
// nb's metadata-line shape (`# key: value`); only the leading run of these is metadata.
const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;
const CONFLICT_MARKER_RE = /^(?:<<<<<<<|>>>>>>>)(?: |$)|^=======$/;
function dedupKey(raw) {
  return raw
    .replace(CONTROL_CHARS_RE, '')
    .replace(/[\t\r\n]+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space, so "shell-safety" == "shell safety"
    .replace(/\s+/g, ' ')
    .trim();
}
const lessonId = (raw) => createHash('sha1').update(dedupKey(raw)).digest('hex').slice(0, 6);
// Plain code-point order: `localeCompare` depends on the host locale, and these
// sections must print the same report for the same store everywhere.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
    let described = false; // has an explicit `# desc:` trigger line (vs an auto-fallback)
    try {
      // Parse like nb's readShelf: strip one leading BOM (U+FEFF) and split on `\r?\n` so a BOM-adding
      // editor or a CRLF checkout reads like a plain file, and treat only the LEADING run of `# key:` lines
      // as metadata (a later `#` line is a lesson to nb). Otherwise a BOM-prefixed `# desc:` would be read
      // as a lesson here, and section 8 would print an id nb does not know.
      const raw = readFileSync(join(dir, f), 'utf-8');
      const rawLines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).split(/\r?\n/);
      // A `# desc:` line in the leading metadata block is the shelf's trigger —
      // "the situation in which you should open me". Its presence (not its text)
      // is what section 7 ranks on, so a plain boolean is enough.
      let inMeta = true;
      for (const l of rawLines) {
        if (inMeta && META_RE.test(l)) {
          if (/^#\s*desc:/.test(l)) described = true;
          continue;
        }
        inMeta = false;
        if (l.trim() === '') continue;
        const tab = l.indexOf('\t');
        const text = tab === -1 ? l : l.slice(tab + 1);
        const score = tab === -1 ? 0 : Number.parseInt(l.slice(0, tab), 10) || 0;
        // Delete nb's control/zero-width set BEFORE collapsing whitespace, as nb's sanitizeLesson does:
        // `\s` itself matches U+FEFF, so collapsing first would turn it into a space and give the
        // lesson a different dedupKey/id here than in nb.
        const clean = text.replace(CONTROL_CHARS_RE, '').replace(/\s+/g, ' ').trim();
        if (clean !== '') lessons.push({ score, text: clean, marker: CONFLICT_MARKER_RE.test(l) });
      }
    } catch {
      /* unreadable → report as empty rather than crash the whole scan */
    }
    return { shelf, lessons, described };
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
// gitHistory distinguishes three outcomes so section 4 can report them apart:
//   null         — NB_DIR is not a git repo (no .git); growth trends unavailable
//                  because versioning is simply not enabled.
//   GIT_FAILED   — .git exists but `git log` failed (its 5s timeout on a huge
//                  repo, git's "dubious ownership" refusal on a shared host, a
//                  corrupt repo, or git missing from PATH). The repo IS versioned;
//                  the tool just could not read it this run.
//   Commit[]     — history read successfully (possibly empty).
const GIT_FAILED = Symbol('git-failed');
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
    return GIT_FAILED;
  }
}

// ---------------------------------------------------------------------------
const notebooks = readNotebooks(NB_DIR);
const usage = readUsage(NB_DIR);
const history = gitHistory(NB_DIR, DAYS);
const now = Date.now();

// --days blindness guard (#275): sections 1, 4, 6 and 7 keep only rows within
// `now - DAYS`, but the usage ring is bounded by ROW COUNT, not time, so an
// active store rotates old rows out. When the ring is AT CAPACITY and its oldest
// retained row is NEWER than the window start, the `--days` window reaches back
// further than any row we still have: those sections then see only part of the
// window and can print a false all-clear. Requiring capacity (not just "oldest
// row is recent") avoids misfiring on a young store that simply has < DAYS of
// history — raising NB_USAGE_RING would not help there. Compute `min` with a loop
// rather than `Math.min(...usage)` so a 100k-row ring can't overflow the stack.
let oldestUsage = null;
for (const r of usage)
  if (Number.isFinite(r.t) && (oldestUsage === null || r.t < oldestUsage)) oldestUsage = r.t;
const usageAtCapacity = usage.length >= USAGE_RING;
const usageWindowBlind = usageAtCapacity && oldestUsage !== null && oldestUsage > now - DAYS * 86400000;
const usageCoverageDays = oldestUsage === null ? null : Math.floor((now - oldestUsage) / 86400000);
const usageWindow = {
  ring: USAGE_RING,
  rows: usage.length,
  atCapacity: usageAtCapacity,
  requestedDays: DAYS,
  coverageDays: usageCoverageDays,
  blind: usageWindowBlind,
};

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
// A shelf name is `role@project` (or just `role`), and the role may itself use the
// `.`-namespace convention (`review.tests`, `build.ci`). Two shelves only fragment
// memory when they are near-duplicate ROLES within the SAME project scope AND not
// intentional namespace siblings:
//   • `orchestrator@proj` vs `patch-author@proj` — different roles, same project → not a dup.
//   • `role@a` vs `role@b` — same role, different projects → not a dup.
//   • `build.ci` vs `build.cd` (shared `.`-stem) — intentional namespace siblings → not a dup.
// So: compare similarity on the role, scoped by project, suppressing dotted siblings.
const splitShelf = (name) => {
  const at = name.indexOf('@');
  return at === -1 ? { role: name, scope: '' } : { role: name.slice(0, at), scope: name.slice(at + 1) };
};
const dotStem = (role) => (role.includes('.') ? role.slice(0, role.indexOf('.')) : null);
const shelfDups = [];
const shelves = notebooks.map((n) => n.shelf);
for (let i = 0; i < shelves.length; i++)
  for (let j = i + 1; j < shelves.length; j++) {
    const a = splitShelf(shelves[i]);
    const b = splitShelf(shelves[j]);
    if (a.scope !== b.scope) continue; // different project scope → intentionally separate
    if (dotStem(a.role) !== null && dotStem(a.role) === dotStem(b.role)) continue; // shared `.`-namespace stem → intentional siblings
    const sim = editSim(a.role, b.role);
    if (sim >= 0.8) shelfDups.push({ a: shelves[i], b: shelves[j], sim: Number(sim.toFixed(2)) });
  }
shelfDups.sort((x, y) => y.sim - x.sim);

// 2b) slug drift: one base name under two `@slug`s, where the shorter slug is the
//     longer one with its leading part(s) dropped (`x@app` / `x@acme-app`). Typical
//     cause: one repo named by `<repo>` in one place and `<owner>-<repo>` in another,
//     so its memory splits across two scopes that §2's same-scope rule cannot see.
//     Rules, all deterministic and name-only (no lesson text, no similarity):
//       • the base (part before the first `@`, as splitShelf and §5 split it) must be
//         EQUAL (shelf names are exact in nb, so `X@a` and `x@a` are other shelves);
//       • "leading part dropped" is anchored on `-` (`app` vs `acme-webapp` is not drift);
//       • slugs are compared ignoring case; slugs equal ignoring case are a case
//         collision (`nb doctor` reports it), not drift; a bare shelf has no slug.
//     It is a hint, not proof: two different repos can share a short name.
const shelfKeys = new Map(); // shelf → Map(dedupKey → { id, score, text }), best-scored copy per key
for (const n of notebooks) {
  const keys = new Map();
  // A shelf holding a merge-conflict marker is left out: nb refuses `move`/`rm` on it until the conflict is
  // resolved, so any command suggested for it would fail ("<<<<<<< HEAD" / "=======" are merge debris anyway).
  if (n.lessons.some((e) => e.marker)) {
    shelfKeys.set(n.shelf, keys);
    continue;
  }
  for (const e of n.lessons) {
    const key = dedupKey(e.text);
    if (key === '') continue; // punctuation-only: nothing to compare
    const prior = keys.get(key);
    if (!prior || e.score > prior.score) keys.set(key, { id: lessonId(e.text), score: e.score, text: e.text });
  }
  shelfKeys.set(n.shelf, keys);
}
const scopedByBase = new Map(); // base → [{ shelf, slug, lessons }] for `@` shelves only
for (const n of notebooks) {
  const { role, scope } = splitShelf(n.shelf);
  if (scope === '') continue;
  if (!scopedByBase.has(role)) scopedByBase.set(role, []);
  scopedByBase.get(role).push({ shelf: n.shelf, slug: scope, lessons: n.lessons.length });
}
const sortedBases = [...scopedByBase.keys()].sort(byName);
const isLeadingDrop = (shortSlug, longSlug) => {
  const s = shortSlug.toLowerCase();
  const l = longSlug.toLowerCase();
  return s !== l && l.endsWith(`-${s}`);
};
const slugVariants = [];
for (const base of sortedBases) {
  const members = scopedByBase.get(base).sort((a, b) => byName(a.shelf, b.shelf));
  for (const short of members)
    for (const long of members) {
      if (short === long || !isLeadingDrop(short.slug, long.slug)) continue;
      const inLong = shelfKeys.get(long.shelf);
      const alsoInBoth = [...shelfKeys.get(short.shelf)]
        .filter(([key]) => inLong.has(key))
        .map(([, v]) => v.id)
        .sort(byName);
      slugVariants.push({
        base,
        shortShelf: short.shelf,
        longShelf: long.shelf,
        shortSlug: short.slug,
        longSlug: long.slug,
        shortLessons: short.lessons,
        longLessons: long.lessons,
        inBoth: alsoInBoth,
      });
    }
}

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
if (Array.isArray(history)) {
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
//    A shelf is *defined* by co-access (lessons needed in the same situations), so
//    two shelves almost always opened together MAY be one role split in two (a
//    `fragment` → merge/namespace) — but they may instead be distinct roles that
//    legitimately co-fire (a `panel`: an RFC review panel, or an orchestrator with
//    its per-project reviewers), which must NOT be merged. Each high pair is
//    classified (see `coPairKind`) so the advice fits. A shelf never opened
//    alongside another is isolated. Rows
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
// Classify a high-co-access pair: `fragment` = one underlying ROLE split in two
// (a genuine merge/namespace candidate), vs `panel` = DISTINCT roles that
// legitimately co-fire (an RFC review panel, or a per-project role bundle — the
// orchestrator + its reviewers). Mirrors §2's name-dup rule EXACTLY so the two
// sections never contradict: a pair is a `fragment` only when §2 would also flag
// it as a near-duplicate NAME — same project scope, NOT intentional `.`-namespace
// siblings, and a near-identical role (editSim ≥ 0.8). Everything else is a
// `panel`: different scopes, `.`-stem siblings (e.g. `build.ci`/`build.cd`, which
// §2 treats as intentional, not a dup), or simply different roles. This keeps §5
// from advising a merge on a review panel or on intentional siblings — the false
// positives the usage audit #223 flagged.
const coPairKind = (a, b) => {
  const sa = splitShelf(a);
  const sb = splitShelf(b);
  if (sa.scope !== sb.scope) return 'panel'; // different project scope → different jobs
  const sharedDotStem = dotStem(sa.role) !== null && dotStem(sa.role) === dotStem(sb.role);
  if (sharedDotStem) return 'panel'; // intentional `.`-namespace siblings (mirrors §2's `continue`)
  return editSim(sa.role, sb.role) >= 0.8 ? 'fragment' : 'panel';
};
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
    highPairs.push({ a, b, co, support, ratio: Number(ratio.toFixed(2)), kind: coPairKind(a, b) });
}
// Fragments first (the actionable merge candidates), then by strength — a review
// panel is expected, so it should never bury a genuine split.
highPairs.sort(
  (x, y) =>
    (x.kind === 'fragment' ? 0 : 1) - (y.kind === 'fragment' ? 0 : 1) || y.ratio - x.ratio || y.co - x.co,
);
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

// 6) Curation: unreinforced lessons at the +1 floor (#223). The usage audit
//    found the vote mechanism is almost all upvotes — wrong lessons are rarely
//    downvoted or removed, so they only leave when a shelf fills and the stalest
//    floor line ages out. Surface how one-sided voting is in the window, and
//    which shelves carry the biggest pile of never-reinforced (+1-floor) lessons
//    to scan. Shelf-level on purpose: the janitor has no per-lesson id to date a
//    single line, so it points at the shelf, not the line.
const FLOOR_SCORE = 1; // a lesson enters at +1; still at +1 ⇒ never net-reinforced
const FLOOR_MIN_LESSONS = 10; // a few fresh +1 lessons is normal; a big pile is the signal
const FLOOR_MIN_FRACTION = 0.5; // …and they dominate the shelf
let upvotes = 0;
let downvotes = 0;
for (const r of usage) {
  if (now - r.t > DAYS * 86400000 || r.command !== 'vote') continue;
  if (r.outcome === 'up') upvotes++;
  else if (r.outcome === 'down') downvotes++;
}
const floorShelves = notebooks
  .map((n) => {
    const floor = n.lessons.filter((e) => e.score <= FLOOR_SCORE).length;
    const total = n.lessons.length;
    return { shelf: n.shelf, floor, total, fraction: total ? Number((floor / total).toFixed(2)) : 0 };
  })
  .filter((s) => s.floor >= FLOOR_MIN_LESSONS && s.fraction >= FLOOR_MIN_FRACTION)
  .sort((a, b) => b.floor - a.floor || b.fraction - a.fraction);
const curation = { windowUpvotes: upvotes, windowDownvotes: downvotes, floorScore: FLOOR_SCORE, floorShelves };

// 7) Undescribed shelves, ranked by browse-without-use (#223). A shelf shown in
//    a session but with no vote of IT that session is a "browse-without-use": the
//    trigger surfaced it but nothing earned a vote, so its description may
//    over-promise — and a shelf with no `# desc:` at all (an auto-fallback to its
//    top lesson) is the likeliest over-promiser. Rank undescribed shelves by that
//    count so the noisiest get a real trigger first. Needs NB_SESSION (same gate
//    as co-access): the unit is the (session, shelf) pair.
const bwuByShelf = {};
{
  const seen = new Map(); // session\tshelf → { shown, voted }
  for (const r of usage) {
    if (now - r.t > DAYS * 86400000) continue;
    if (r.session === '' || r.shelf === '' || r.shelf === '-') continue;
    const isShow = r.command === 'show';
    const isVote = r.command === 'vote' && (r.outcome === 'up' || r.outcome === 'down');
    if (!isShow && !isVote) continue;
    const k = `${r.session}\t${r.shelf}`;
    const cur = seen.get(k) ?? { shown: false, voted: false };
    if (isShow) cur.shown = true;
    else cur.voted = true;
    seen.set(k, cur);
  }
  for (const [k, v] of seen) {
    if (!v.shown || v.voted) continue;
    const shelf = k.split('\t')[1];
    bwuByShelf[shelf] = (bwuByShelf[shelf] ?? 0) + 1;
  }
}
const undescribedComputed = usage.some((r) => r.session !== '');
const undescribedShelves = notebooks
  .filter((n) => !n.described)
  .map((n) => ({ shelf: n.shelf, browseWithoutUse: bwuByShelf[n.shelf] ?? 0 }))
  .sort((a, b) => b.browseWithoutUse - a.browseWithoutUse || a.shelf.localeCompare(b.shelf));
const undescribed = { computed: undescribedComputed, shelves: undescribedShelves };

// 8) exact duplicate lessons across shelves that share a base name: the `@` shelves of
//    that base and the bare `<base>` shelf itself. "Exact" is nb's own rule (equal
//    `dedupKey`: case, punctuation and spacing ignored), so there is no similarity
//    guess and a lesson is never matched with its negation (fuzzy matching cannot
//    promise that; see #286). A bare shelf alone never forms a group: at least one
//    `@` shelf of the base must hold the lesson too.
//    Suggested fix: `nb move` the highest-scored copy (ties: shelf name) to the shared
//    shelf named by the bare `<base>`, then `nb rm` the others. Moving to a sibling
//    would be refused by nb (its target already holds the lesson). If `<base>` already
//    holds the lesson, only the `rm`s remain. (`duplicate` is a `nb merge` reason
//    code, not an `rm` one, so the rm carries it as `--note`.)
const conflictedShelves = new Set(notebooks.filter((n) => n.lessons.some((e) => e.marker)).map((n) => n.shelf));
const crossShelfDups = [];
for (const base of sortedBases) {
  // The `@` shelves of this base, plus the bare `<base>` shelf when it exists: a copy already in the
  // shared shelf counts as a holder too (then only the `@` copies are left to drop).
  const holderShelves = [...scopedByBase.get(base).map((m) => m.shelf), ...(shelfKeys.has(base) ? [base] : [])];
  const holders = new Map(); // dedupKey → [{ shelf, id, score, text }]
  for (const shelf of holderShelves)
    for (const [key, v] of shelfKeys.get(shelf)) {
      if (!holders.has(key)) holders.set(key, []);
      holders.get(key).push({ shelf, ...v });
    }
  for (const [key, copies] of holders) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => b.score - a.score || byName(a.shelf, b.shelf));
    const keep = copies[0];
    const sharedHolds = shelfKeys.get(base)?.has(key) ?? false;
    const rmTargets = sharedHolds ? copies.filter((c) => c.shelf !== base) : copies.slice(1);
    // nb refuses to move into the bare `<base>` shelf when it holds a merge-conflict marker, or when
    // another shelf differs from it only by case (#337). Then no command is printed: dropping the copies
    // without the move would lose the lesson, and the move would only be refused. (Not needed when the
    // shared shelf already holds the lesson: there is no move, only removals from the `@` shelves.)
    const blocked = sharedHolds
      ? null
      : conflictedShelves.has(base)
        ? 'conflict'
        : notebooks.some((n) => n.shelf !== base && n.shelf.toLowerCase() === base.toLowerCase())
          ? 'case-variant'
          : null;
    crossShelfDups.push({
      base,
      key,
      id: keep.id,
      text: keep.text,
      shelves: copies.length,
      copies: copies.map((c) => ({ shelf: c.shelf, score: c.score })),
      keep: keep.shelf,
      sharedShelf: base,
      sharedHolds,
      blocked,
      commands: blocked
        ? []
        : [
            ...(sharedHolds ? [] : [`nb move ${keep.shelf} ${base} ${keep.id}`]),
            ...rmTargets.map((c) => `nb rm ${c.shelf} ${keep.id} --reason obsolete --note duplicate`),
          ],
    });
  }
}
crossShelfDups.sort((a, b) => b.shelves - a.shelves || byName(a.base, b.base) || byName(a.key, b.key));

const report = {
  dir: NB_DIR,
  notebooks: notebooks.length,
  totalLessons: notebooks.reduce((s, n) => s + n.lessons.length, 0),
  fullShelves,
  lostLessons,
  shelfDups,
  roleDups: shelfDups, // deprecated alias of shelfDups
  slugVariants,
  lessonDups,
  volume,
  silentShelves,
  silentRoles: silentShelves, // deprecated alias of silentShelves
  coAccess,
  curation,
  undescribed,
  crossShelfDups,
  usageRows: usage.length,
  usageWindow,
};

if (JSON_OUT) {
  // Wait for the write to drain before exiting: a pipe write is asynchronous on macOS (and Windows), so an
  // immediate process.exit() cut a report larger than the first pipe chunk (8 KB) off mid-string and the
  // consumer's JSON.parse failed.
  // A reader that closes early (`| head`) is not an error here: exit 0 as before (nb's own CLI treats EPIPE the same way).
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  await new Promise((resolve) => process.stdout.write(JSON.stringify(report, null, 2) + '\n', resolve));
  process.exit(0);
}

// ---- human report ---------------------------------------------------------
const out = [];
const H = (s) => out.push('', `── ${s} ` + '─'.repeat(Math.max(0, 60 - s.length)));
out.push(`nb-janitor — ${report.notebooks} notebooks, ${report.totalLessons} lessons in ${NB_DIR}`);
if (usageWindowBlind)
  out.push(
    `  ⚠️  usage log retains only the last ${usageCoverageDays >= 1 ? `${usageCoverageDays}d` : 'under a day'} of activity ` +
      `(ring full at ${USAGE_RING} rows); the --days ${DAYS} window reaches further back, so sections 1/4/6/7 are ` +
      `partially blind to evicted rows and may understate — raise NB_USAGE_RING or lower --days.`,
  );

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
if (shelfDups.length === 0 && slugVariants.length === 0) out.push('  ✅ no suspiciously similar shelf names.');
else {
  for (const d of shelfDups) {
    out.push(`  ⚠️  "${d.a}" ~ "${d.b}" (name similarity ${d.sim}) — likely the same shelf, split in two.`);
    out.push(`      → consolidate: re-add ${d.b}'s lessons under "${d.a}" (or vice-versa), then retire the orphan.`);
  }
  for (const v of slugVariants.slice(0, COACCESS_MAX_ROWS)) {
    out.push(
      `  ⚠️  possible slug drift: "${v.shortShelf}" (${v.shortLessons} lesson(s)) and "${v.longShelf}" (${v.longLessons}) — ` +
        `same base "${v.base}"; slug "${v.shortSlug}" is "${v.longSlug}" with its leading part dropped.`,
    );
    out.push(
      `      → if both name one project, fold one into the other, a lesson at a time: ` +
        `nb move ${v.shortShelf} ${v.longShelf} <id>  (ids: nb show ${v.shortShelf}; reverse the two names if the short slug is the one you keep). ` +
        `Two unrelated projects can share a short name: if so, leave both.`,
    );
    if (v.inBoth.length > 0)
      out.push(
        `        ${v.inBoth.length} lesson(s) (${v.inBoth.join(', ')}) are already in both, so nb move refuses them: ` +
          `nb rm ${v.shortShelf} <id> --reason obsolete --note duplicate.`,
      );
    if (v.shortLessons + v.longLessons > MAX_LINES)
      out.push(`        together they exceed ${MAX_LINES} lines: a move into a full shelf evicts its lowest-scored lesson.`);
  }
  if (slugVariants.length > COACCESS_MAX_ROWS)
    out.push(`  …(${slugVariants.length - COACCESS_MAX_ROWS} more slug variants — run with --json)`);
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
else if (history === GIT_FAILED)
  out.push('  (git history unavailable — git failed, timed out, or refused access (dubious ownership / corrupt repo / git not on PATH); NB_DIR is versioned but could not be read this run)');
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
      if (p.kind === 'fragment')
        out.push(`      → likely one shelf split in two: nb merge their overlapping lessons, or namespace ("${p.a}.*"/"${p.b}.*").`);
      else
        out.push(
          `      → distinct roles that co-fire (a review panel / per-project bundle) — expected; extract a shared umbrella shelf ONLY if they carry duplicated cross-cutting lessons, don't merge the roles.`,
        );
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

H('6. Curation: unreinforced lessons at the +1 floor (last ' + DAYS + 'd)');
out.push(
  `  ${upvotes} upvote(s), ${downvotes} downvote(s) in the window — ` +
    (downvotes === 0
      ? 'downvoting is unused, so a wrong lesson only leaves when its shelf fills and ages out.'
      : 'downvotes are rare relative to upvotes.'),
);
if (floorShelves.length === 0)
  out.push(`  ✅ no shelf is dominated by a large pile of never-reinforced +${FLOOR_SCORE} lessons.`);
else {
  out.push('  biggest piles of never-reinforced lessons — scan each for any that misfired:');
  for (const s of floorShelves.slice(0, COACCESS_MAX_ROWS)) {
    out.push(
      `  ⚠️  ${s.shelf}: ${s.floor}/${s.total} lessons still at +${FLOOR_SCORE} (${Math.round(s.fraction * 100)}%) — never reinforced.`,
    );
    out.push(`      → nb show ${s.shelf}: downvote/rm any that misfired; a +1 vote marks the keepers as recently useful.`);
  }
  if (floorShelves.length > COACCESS_MAX_ROWS)
    out.push(`  …(${floorShelves.length - COACCESS_MAX_ROWS} more — run with --json)`);
}

H('7. Undescribed shelves (add a # desc: trigger)');
if (undescribedShelves.length === 0) out.push('  ✅ every shelf has an explicit # desc: trigger.');
else {
  const noisy = undescribedShelves.filter((s) => s.browseWithoutUse > 0);
  if (!undescribedComputed)
    out.push('  (no NB_SESSION in the log — can\'t rank by browse-without-use; listing undescribed shelves alphabetically)');
  else if (noisy.length === 0)
    out.push('  no undescribed shelf has been browsed-without-use yet — still, an explicit trigger beats the auto-fallback:');
  else out.push('  undescribed shelves, noisiest first (shown but nothing voted → the trigger may over-promise):');
  for (const s of undescribedShelves.slice(0, COACCESS_MAX_ROWS)) {
    const bwu = undescribedComputed ? ` — shown-but-not-voted in ${s.browseWithoutUse} session(s)` : '';
    out.push(`  ⚠️  ${s.shelf}${bwu}, no # desc: (trigger is an auto-fallback to its top lesson).`);
    out.push(`      → nb describe ${s.shelf} "<the situation in which you should open me>"`);
  }
  if (undescribedShelves.length > COACCESS_MAX_ROWS)
    out.push(`  …(${undescribedShelves.length - COACCESS_MAX_ROWS} more — run with --json)`);
}

H('8. Exact duplicate lessons across shelves that share a base name');
if (crossShelfDups.length === 0) out.push('  ✅ no lesson appears in more than one shelf of the same base name.');
else {
  for (const d of crossShelfDups.slice(0, COACCESS_MAX_ROWS)) {
    out.push(
      `  ⚠️  "${d.text}" appears in ${d.shelves} shelves: ` +
        `${d.copies.map((c) => `${c.shelf} (${c.score >= 0 ? '+' : ''}${c.score})`).join(', ')}.`,
    );
    if (d.blocked) {
      out.push(
        `      → no command suggested: the shared "${d.sharedShelf}" shelf ` +
          (d.blocked === 'conflict'
            ? 'holds git merge-conflict markers (resolve the merge in its file first).'
            : 'differs only by case from another shelf, which nb refuses (pick one spelling first).'),
      );
      continue;
    }
    out.push(
      d.sharedHolds
        ? `      → "${d.sharedShelf}" already holds it, so keep that copy and drop the others:`
        : `      → an exact match under nb's own duplicate rule (case, punctuation and spacing ignored). To keep one copy in the shared "${d.sharedShelf}" shelf (the highest-scored copy keeps its score), then drop the rest:`,
    );
    for (const c of d.commands) out.push(`        ${c}`);
  }
  if (crossShelfDups.length > COACCESS_MAX_ROWS)
    out.push(`  …(${crossShelfDups.length - COACCESS_MAX_ROWS} more — run with --json)`);
}

out.push('');
process.stdout.write(out.join('\n') + '\n');
