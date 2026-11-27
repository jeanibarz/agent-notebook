/**
 * `nb status` (issue #558, FR-STATUS-001..003): the pure half. It turns the facts
 * that `status-facts.ts` read into a verdict, two fixed sentences, a detail block
 * and a JSON object. It imports nothing, so it cannot read a file, start a process
 * or look at the clock: the time is an argument.
 *
 * Every sentence comes from the tables below, keyed by a code, and is filled only
 * with ages, counts, versions and file names. A path, a git message or any other
 * text read from disk never reaches line 1 or line 2. The values the detail block
 * prints come from the facts already escaped and capped.
 *
 * The verdict claims only that the start step ran (DP-5): that `nb brief` or
 * `nb retro` ran with a hook label for this project at that time. It does not say
 * the assistant saw the text, read the list or used a lesson.
 */

export type Verdict = 'off' | 'place_unknown' | 'broken' | 'running' | 'not_seen';
export type Scope = 'project' | 'notebook';

/** Why a message file of the user is refused, as a fixed code (never the reason read from disk). */
export type RefusalCode = 'too_long' | 'empty' | 'not_utf8' | 'inside_notebooks' | 'unreadable' | 'other';

/** One usage row of `brief` or `retro` that passed read-time validation. */
export interface StatusRow {
  at: string;
  atMs: number;
  command: 'brief' | 'retro';
  ok: boolean;
  /** The hook label, or `''` when the call gave none. */
  label: string;
  outcome: string;
  /** `''` on a row written before the `version` column. */
  version: string;
  /** The project key, or `''`. */
  project: string;
  /** The error class of a failed call, or `''`. */
  errorClass: string;
  /** The last 8 characters of the session id. */
  session: string;
}

export interface MessageFileFact {
  kind: 'brief' | 'retro';
  file: string;
  status: 'used' | 'refused' | 'absent';
  reason: RefusalCode | null;
}

export type ProjectSourceFact = 'env' | 'remote' | 'folder' | 'none';
export type KeyKind = 'name' | 'folder-hash' | 'undetermined' | 'none';

/** Where notes are kept (issue #560): present in the facts only when `.layout` exists and `NB_DIR` is unset. */
export interface StatusLayout {
  /** The sentence `nb place` and `nb config` print too. */
  line: string;
  default: 'shared' | 'own' | 'ask';
  source: 'chosen' | 'unreadable';
  since: string | null;
}

/** What `status-facts.ts` read. Strings under `shown` are escaped and capped for the text output. */
export interface StatusFacts {
  switch: { enabled: boolean; source: 'env' | 'git' | 'default' };
  place: { kind: 'env' | 'own' | 'shared' | 'unknown' };
  layout?: StatusLayout;
  project: { name: string | null; source: ProjectSourceFact; keyKind: KeyKind; key: string | null };
  /**
   * The notebook folder and its usage log. `not-file` (with `logKind`) and `too-large`
   * are the writer's own refusals (issue #576, FR-USAGE-005): a row is not written there.
   */
  live: {
    folder: 'ok' | 'missing' | 'unreadable' | 'not-folder';
    log: 'ok' | 'absent' | 'unwritable' | 'not-file' | 'too-large';
    logKind?: 'link' | 'folder' | 'special';
  };
  /** The `brief` and `retro` rows of the logs read, oldest first; the newest is last. */
  rows: StatusRow[];
  /** How many valid rows of any command were read. */
  rowsRead: number;
  /** The timestamp of the oldest valid row read, or `null`. */
  since: string | null;
  notebook: { shelves: number | null; lastAddAt: string | null };
  messages: { state: string; files: MessageFileFact[] };
  program: { version: string; released: string | null; nodeVersion: string; platform: string };
  shown: {
    projectName: string | null;
    folderAsked: string | null;
    notebookFolder: string | null;
    notebookWhy: string;
    programPaths: string[];
    nodePath: string;
  };
}

export interface RowEvidence {
  at: string;
  ageSeconds: number;
  label: string;
  outcome: string;
  version: string | null;
  session: string;
}

export interface StatusDecision {
  verdict: Verdict;
  scope: Scope;
  /** The code of line 1's variant (a key of `LINE1`). */
  code: string;
  headline: string;
  next: string;
  announce: boolean;
  problem: 'message_ignored' | null;
  lastStart: RowEvidence | null;
  lastEnd: RowEvidence | null;
  olderProgram: { count: number; at: string; ageSeconds: number } | null;
  /** The last rows of this project that count (starts and ends), oldest first, at most 5. */
  recent: (RowEvidence & { kind: 'start' | 'end' })[];
  /** The version the chats last used for this project, or `null`. */
  chatsVersion: string | null;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** `just now`, `N minutes ago`, `N hours ago` or `N days ago`, singular where it applies. */
export function ageWords(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'just now';
  const unit = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

/** `1 day` or `N days`. */
function daysWords(n: number): string {
  return n === 1 ? 'day' : `${n} days`;
}

const REFUSAL_WORDS: Record<RefusalCode, string> = {
  too_long: 'it is too long',
  empty: 'it is empty',
  not_utf8: 'it is not saved as UTF-8',
  inside_notebooks: 'its folder lies inside the notebook folder',
  unreadable: 'it cannot be read',
  other: 'it cannot be used',
};

const LINE1: Record<string, (a: { age: string; lessons: string; file: string }) => string> = {
  off_switch: () => 'The notebook is switched off for this folder.',
  off_chats: (a) => `Your chats here found the notebook switched off (last start ${a.age}).`,
  place_unknown: () =>
    "The notebook can't tell where this project's lessons are kept, so it stays closed here for now. Your lessons are safe.",
  broken_folder: () => "The notebook can't be opened right now, so chats can't use it.",
  broken_log: () =>
    "The notebook can't note when a chat starts it (a file in it can't be written), so this check can't tell whether it works.",
  broken_rows: (a) => `The notebook could not open when a chat last started it (${a.age}).`,
  running_start: (a) => `The notebook was working when a chat last started it on its own, ${a.age}. ${a.lessons}`,
  running_end: (a) =>
    `The notebook was working when a chat asked for the end-of-task notes on its own ${a.age}; no automatic start is recorded. ${a.lessons}`,
  broken_log_file: (a) =>
    `The notebook's lessons are fine, but its record of chat starts (the usage log, .nb-usage.log) is ${a.file}, so this check can't tell whether chats start it.`,
  not_seen_yet: () => 'This check has not seen a chat in this project start the notebook on its own yet.',
  not_seen: () => 'This check has not seen a chat in this project start the notebook on its own',
};

const LINE2 = {
  off_git:
    'It was switched off on purpose. To use it here again, ask your assistant to switch it back on.',
  off_env:
    'A setting on this computer switched it off, possibly set by whoever manages it. Leave it unless you set it yourself.',
  ask_details: 'Ask your assistant to look at the details below.',
  opens_now: 'It opens now: start a new chat and ask again.',
  nothing: 'Nothing to do.',
  new_chat: 'Start a new chat here and ask again. If it still says this, ask your assistant to look at the details below.',
  update: 'Ask your assistant to help you update the notebook, then start a new chat. Your lessons are safe.',
} as const;

/** The plain words for a usage log the writer refuses (issue #576). */
const LOG_KIND_WORDS = {
  link: 'a shortcut (symbolic link) instead of a normal file',
  folder: 'a folder instead of a normal file',
  special: 'a special system file instead of a normal file',
  'too-large': 'too large to start a new one',
} as const;

function logWords(live: StatusFacts['live']): keyof typeof LOG_KIND_WORDS {
  return live.log === 'too-large' ? 'too-large' : (live.logKind ?? 'special');
}

const OUT_OF_DATE = (age: string): string => ` Part of the notebook seemed out of date the last time a chat tried (${age}).`;

const DP5_SENTENCE = 'This shows the start step ran. It does not show that your assistant read the list or used a lesson.';

const NOT_SEEN_HELP =
  'If you use the notebook through an instruction file or through start-up scripts from before version 0.13, this is expected. ' +
  'If chats should start it on their own and this stays, the assistant may not run it ' +
  '(not installed or switched off there, blocked by a company policy, Node.js missing or too old). ' +
  'See "When nb status has not seen a chat" in docs/harness-setup.md.';

export const NAMES_HEADING = 'Names and paths (remove these lines before posting publicly if they are private)';

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const START_OUTCOMES = new Set(['index', 'layered', 'empty', 'off', 'broken']);

function evidence(r: StatusRow, now: number): RowEvidence {
  return {
    at: r.at,
    ageSeconds: Math.max(0, Math.floor((now - r.atMs) / 1000)),
    label: r.label,
    outcome: r.outcome,
    version: r.version === '' ? null : r.version,
    session: r.session,
  };
}

/** The refused message file that line 2 of `running` names: a start message (`brief`), global before project. */
function refusedStartMessage(f: StatusFacts): MessageFileFact | null {
  return f.messages.files.find((m) => m.kind === 'brief' && m.status === 'refused') ?? null;
}

/** The days the log covers, at least 1, or `null` with no valid row. */
function windowDays(f: StatusFacts, now: number): number | null {
  if (f.since === null) return null;
  const ms = Date.parse(f.since);
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.ceil(Math.max(0, now - ms) / 86_400_000));
}

function lessonSentence(f: StatusFacts, now: number): string {
  if (f.notebook.lastAddAt !== null) {
    const t = Date.parse(f.notebook.lastAddAt);
    return `Last lesson added ${ageWords((now - t) / 1000)}.`;
  }
  if (f.notebook.shelves === 0) return 'No lessons yet: they are added at the end of tasks.';
  const n = windowDays(f, now);
  return n === null ? 'No lesson added yet.' : `No lesson added in the last ${n === 1 ? 'day' : daysWords(n)}.`;
}

/**
 * The verdict, in order: off, place_unknown, broken (live, then from the rows),
 * running, not_seen. `now` is in milliseconds.
 */
export function decideStatus(f: StatusFacts, now: number): StatusDecision {
  const key = f.project.key !== null && f.project.key !== '?' ? f.project.key : null;
  // One pass: the indices (positions in `f.rows`, oldest first) of each kind of row.
  const startIx: number[] = [];
  const endIx: number[] = [];
  const unknownBrokenIx: number[] = [];
  const olderIx: number[] = [];
  f.rows.forEach((r, i) => {
    if (r.command === 'brief' && !r.ok && r.errorClass === 'unknown_subcommand' && r.version === '') olderIx.push(i);
    if (!r.ok || r.label === '') return;
    if (r.command === 'brief' && r.project === '?' && r.outcome === 'broken') unknownBrokenIx.push(i);
    if (key === null || r.project !== key) return;
    if (r.command === 'brief' && START_OUTCOMES.has(r.outcome)) startIx.push(i);
    else if (r.command === 'retro' && r.outcome === 'nudge') endIx.push(i);
  });
  const rowAt = (ix: number[]): StatusRow | null => (ix.length === 0 ? null : f.rows[ix[ix.length - 1]!]!);
  const lastStartRow = rowAt(startIx);
  const lastEndRow = rowAt(endIx);
  const lastStartPos = startIx.length === 0 ? -1 : startIx[startIx.length - 1]!;
  const lastEndPos = endIx.length === 0 ? -1 : endIx[endIx.length - 1]!;
  const newestProjectPos = Math.max(lastStartPos, lastEndPos);
  // A place that was `unknown` when a chat started writes an ok row with outcome `broken` and key `?`.
  const lastUnknownBroken = rowAt(unknownBrokenIx);
  const lastUnknownBrokenPos = unknownBrokenIx.length === 0 ? -1 : unknownBrokenIx[unknownBrokenIx.length - 1]!;
  const lastOlder = rowAt(olderIx);
  const lastOlderPos = olderIx.length === 0 ? -1 : olderIx[olderIx.length - 1]!;

  const lastStart = lastStartRow === null ? null : evidence(lastStartRow, now);
  const lastEnd = lastEndRow === null ? null : evidence(lastEndRow, now);
  const olderProgram =
    lastOlder === null ? null : { count: olderIx.length, at: lastOlder.at, ageSeconds: evidence(lastOlder, now).ageSeconds };
  const recentIx = [...startIx.slice(-5), ...endIx.slice(-5)].sort((x, y) => x - y).slice(-5);
  const recent = recentIx.map((i) => ({ ...evidence(f.rows[i]!, now), kind: (f.rows[i]!.command === 'brief' ? 'start' : 'end') as 'start' | 'end' }));
  const versioned = [...startIx, ...endIx].filter((i) => f.rows[i]!.version !== '').sort((x, y) => x - y);
  const chatsVersion = versioned.length === 0 ? null : f.rows[versioned[versioned.length - 1]!]!.version;
  const age = (r: StatusRow): string => ageWords((now - r.atMs) / 1000);

  const base = { lastStart, lastEnd, olderProgram, recent, chatsVersion, problem: null as 'message_ignored' | null };
  const done = (
    verdict: Verdict,
    scope: Scope,
    code: string,
    args: { age?: string; lessons?: string; file?: string },
    next: string,
    suffix = '',
  ): StatusDecision => ({
    ...base,
    verdict,
    scope,
    code,
    headline: LINE1[code]!({ age: args.age ?? '', lessons: args.lessons ?? '', file: args.file ?? '' }) + suffix,
    next,
    announce: verdict === 'place_unknown' || (verdict === 'broken' && scope === 'project'),
  });

  if (!f.switch.enabled) {
    return done('off', 'project', 'off_switch', {}, f.switch.source === 'env' ? LINE2.off_env : LINE2.off_git);
  }
  if (lastStartRow !== null && lastStartRow.outcome === 'off') {
    // The terminal's switch is on, so the chats' switch was set where the chats run: the git wording.
    return done('off', 'project', 'off_chats', { age: age(lastStartRow) }, LINE2.off_git);
  }
  if (f.place.kind === 'unknown') return done('place_unknown', 'project', 'place_unknown', {}, LINE2.ask_details);
  if (f.live.folder === 'unreadable' || f.live.folder === 'not-folder') {
    return done('broken', 'project', 'broken_folder', {}, LINE2.ask_details);
  }
  if (f.live.log === 'unwritable') return done('broken', 'project', 'broken_log', {}, LINE2.ask_details);
  if (f.live.log === 'not-file' || f.live.log === 'too-large') {
    return done('broken', 'project', 'broken_log_file', { file: LOG_KIND_WORDS[logWords(f.live)] }, LINE2.ask_details);
  }
  const ownBroken = lastStartRow !== null && lastStartRow.outcome === 'broken';
  // A `?` row counts only when it is newer than this project's newest start or end row.
  const noticedBroken = lastUnknownBroken !== null && lastUnknownBrokenPos > newestProjectPos;
  if (ownBroken || noticedBroken) {
    const row = ownBroken ? lastStartRow! : lastUnknownBroken!;
    // The live checks above passed, so the notebook opens now.
    return done('broken', ownBroken ? 'project' : 'notebook', 'broken_rows', { age: age(row) }, LINE2.opens_now);
  }
  const refused = refusedStartMessage(f);
  const running = (code: 'running_start' | 'running_end', row: StatusRow): StatusDecision => {
    const d = done('running', 'project', code, { age: age(row), lessons: lessonSentence(f, now) }, '');
    if (refused === null) return { ...d, next: LINE2.nothing };
    return {
      ...d,
      problem: 'message_ignored',
      next: `Your own start message (${refused.file}) is not used: ${REFUSAL_WORDS[refused.reason ?? 'other']}. Ask your assistant to show you why.`,
    };
  };
  if (lastStartRow !== null) return running('running_start', lastStartRow);
  if (lastEndRow !== null) return running('running_end', lastEndRow);

  // `not_seen`: nothing above. Part of the notebook may be out of date when an older program
  // answered a start and no later row carries a version.
  const olderIsStale = lastOlder !== null && !f.rows.slice(lastOlderPos + 1).some((r) => r.version !== '');
  const n = windowDays(f, now);
  const lookedAt = n === null || f.rowsRead === 0 ? null : `(it looked at the last ${n === 1 ? 'day' : daysWords(n)}).`;
  const stale = olderIsStale ? OUT_OF_DATE(age(lastOlder!)) : '';
  if (lookedAt === null) {
    return done('not_seen', 'project', 'not_seen_yet', {}, olderIsStale ? LINE2.update : LINE2.new_chat, stale);
  }
  return done('not_seen', 'project', 'not_seen', {}, olderIsStale ? LINE2.update : LINE2.new_chat, ` ${lookedAt}${stale}`);
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

const KEY_WORDS: Record<KeyKind, string> = {
  name: 'the project name',
  'folder-hash': 'a hash of the repository folder',
  undetermined: 'undetermined (git could not answer)',
  none: 'none (no folder to ask)',
};

const SOURCE_WORDS: Record<ProjectSourceFact, string> = {
  env: 'set by NB_PROJECT_SLUG',
  remote: 'from the git remote',
  folder: 'from the repository folder',
  none: 'none found',
};

function rowLine(r: RowEvidence, kind: 'start' | 'end'): string {
  return `  ${r.at}  ${kind}  ${r.label}  ${r.outcome}  ${r.version ?? '-'}  session ...${r.session === '' ? '-' : r.session}`;
}

/** The two lines, a blank line, then the detail block (the facts first, then the names and paths). */
export function renderStatus(f: StatusFacts, d: StatusDecision, now: number): string {
  const lines: string[] = [d.headline, d.next, '', DP5_SENTENCE];
  const p = f.program;
  lines.push(`Version: ${p.version}${p.released === null ? '' : ` (released ${p.released})`}`);
  lines.push(`Node.js: ${p.nodeVersion} on ${p.platform}`);
  lines.push(
    `Switch: ${f.switch.enabled ? 'on' : 'off'} (${f.switch.source === 'default' ? 'the default' : f.switch.source === 'env' ? 'NB_ENABLED' : 'git config nb.enabled'}), as seen from this terminal`,
  );
  lines.push(`Place: ${f.place.kind}`);
  if (f.layout) lines.push(f.layout.line);
  lines.push(`Project: name ${SOURCE_WORDS[f.project.source]}; the key is ${KEY_WORDS[f.project.keyKind]}`);
  const shelves = f.notebook.shelves === null ? 'shelves could not be counted' : `${f.notebook.shelves} ${f.notebook.shelves === 1 ? 'shelf' : 'shelves'}`;
  const lastAdd = f.notebook.lastAddAt === null ? 'no lesson added in the record' : `last lesson added ${ageWords((now - Date.parse(f.notebook.lastAddAt)) / 1000)}`;
  lines.push(`Notebook: ${shelves}; ${lastAdd}`);
  const msgs = f.messages.files.filter((m) => m.status !== 'absent');
  const msgText = msgs.map((m) => `${m.file} ${m.status === 'used' ? 'used' : `refused (${REFUSAL_WORDS[m.reason ?? 'other']})`}`).join('; ');
  lines.push(`Message files: ${msgText === '' ? 'none' : msgText}${f.messages.state === 'unreadable' ? ' (the messages folder cannot be read)' : ''}`);
  if (f.live.log === 'not-file' || f.live.log === 'too-large') {
    lines.push(
      `Usage log: ${LOG_KIND_WORDS[logWords(f.live)]}; nb does not write it${f.live.log === 'not-file' ? ' or read it' : ''}. The lessons are not in it; delete it (a link itself, not what it points to) and nb starts a new log.`,
    );
  }
  lines.push(
    f.rowsRead === 0
      ? 'Record: no rows (the usage log is missing, empty or cannot be read)'
      : `Record: ${f.rowsRead} row${f.rowsRead === 1 ? '' : 's'} read, the oldest from ${f.since}`,
  );
  if (d.recent.length === 0) lines.push('Last starts and ends of this project: none');
  else {
    lines.push('Last starts and ends of this project (time, kind, label, outcome, version, session):');
    for (const r of d.recent) lines.push(rowLine(r, r.kind));
  }
  if (d.chatsVersion !== null && d.chatsVersion !== p.version) {
    lines.push(`The chats last used version ${d.chatsVersion}; this terminal runs ${p.version}.`);
  }
  if (d.olderProgram !== null) {
    lines.push(
      `An older program answered a chat start ${d.olderProgram.count} time${d.olderProgram.count === 1 ? '' : 's'}; the last was ${ageWords(d.olderProgram.ageSeconds)}.`,
    );
  }
  if (d.verdict === 'not_seen') lines.push(NOT_SEEN_HELP);
  lines.push('More: nb doctor, nb config, nb enabled --why, nb place');
  lines.push('', NAMES_HEADING);
  const s = f.shown;
  lines.push(`Project name: ${s.projectName ?? '-'}`);
  lines.push(`Folder asked: ${s.folderAsked ?? '-'}`);
  lines.push(`Notebook folder: ${s.notebookFolder ?? '-'} (${s.notebookWhy})`);
  lines.push(`Program: ${s.programPaths.length === 0 ? '-' : s.programPaths.join(' ; ')}`);
  lines.push(`Node.js: ${s.nodePath}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The JSON (FR-STATUS-003)
// ---------------------------------------------------------------------------

function jsonRow(r: RowEvidence | null): Record<string, unknown> | null {
  return r === null ? null : { at: r.at, ageSeconds: r.ageSeconds, label: r.label, outcome: r.outcome, version: r.version };
}

/** The object `nb status --json` prints. It holds no path. */
export function statusJson(f: StatusFacts, d: StatusDecision, now: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verdict: d.verdict,
    scope: d.scope,
    headline: d.headline,
    next: d.next,
    announce: d.announce,
    problem: d.problem,
    now: new Date(now).toISOString(),
    evidence: {
      lastStart: jsonRow(d.lastStart),
      lastEnd: jsonRow(d.lastEnd),
      olderProgram: d.olderProgram,
      rowsRead: f.rowsRead,
      since: f.since,
    },
    switch: { enabled: f.switch.enabled, source: f.switch.source },
    place: { kind: f.place.kind },
    ...(f.layout ? { layout: { default: f.layout.default, source: f.layout.source, since: f.layout.since } } : {}),
    project: { name: f.project.name, source: f.project.source, key: f.project.keyKind },
    notebook: { shelves: f.notebook.shelves, lastAddAt: f.notebook.lastAddAt },
    program: { version: f.program.version, released: f.program.released, nodeVersion: f.program.nodeVersion, platform: f.program.platform },
  };
}
