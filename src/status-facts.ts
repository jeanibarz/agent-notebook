/**
 * `nb status` (issue #558, FR-STATUS-001): every read, behind injectable
 * dependencies, so `status.ts` can stay pure. Read-only and never throws: each
 * read is wrapped and a failed one becomes the neutral value ("no rows", "not
 * counted"), never an error. It writes nothing and creates nothing.
 *
 * What it reads: the switch (`enabled.ts`), the project key (`projectRecordKey`),
 * the tail of the usage log(s) (an own place reads its own log and the shared
 * one, otherwise the shared one; at most 8 MiB each, through `parseUsage`'s
 * bounded reader), one `readdir` of the notebook folder in use, the message files
 * (through `messages.ts`, as `nb config` does), and `CHANGELOG.md` beside the
 * package's `package.json`. It starts only the git runs `enabled.ts` makes; the
 * project and place arrive already resolved from the CLI.
 *
 * Every value that comes from disk, the environment or git and is printed in the
 * detail block goes through `escapeDiskName` with a cap, and a path shows the home
 * folder as `~`.
 */
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveEnabled, type EnabledState } from './enabled.js';
import { INSIDE_NOTEBOOKS_WHY, listMessages, NOT_UTF8_WHY, readMessages, type MessageFile, type MessageKind, type MessageListing } from './messages.js';
import { escapeDiskName, usageFile } from './notebook.js';
import { projectRecordKey, type ProjectState } from './project.js';
import { parseUsage, type UsageRow } from './usage.js';
import type { KeyKind, MessageFileFact, RefusalCode, StatusFacts, StatusRow } from './status.js';

/** The most of a usage log `nb status` reads: its tail. */
export const STATUS_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** `CHANGELOG.md` is read only when it is a regular file smaller than this. */
export const CHANGELOG_MAX_BYTES = 1024 * 1024;

/** The commands a usage row may name (a copy of the CLI's list; a test pins the two together). */
export const ROW_COMMANDS: readonly string[] = [
  'show', 'stale', 'add', 'vote', 'merge', 'split', 'rm', 'move', 'describe',
  'search', 'stats', 'doctor', 'path', 'config', 'enabled', 'project', 'place', 'brief', 'retro', 'status', 'completion', 'list', 'ls', 'shelves', 'roles',
  'help', 'version',
];

/** What the CLI has already resolved for the call. */
export interface FactsInput {
  env: NodeJS.ProcessEnv;
  /** The working folder, or `null` when it no longer exists. */
  cwd: string | null;
  place: { kind: 'env' | 'own' | 'shared' | 'unknown'; dir: string | null; shared: string; reason: string };
  /** The project of the call (`null` when there is no working folder and no `NB_PROJECT_SLUG`). */
  project: ProjectState | null;
  /** The project name that selects a message file, or `null` (`messageProjectName`). */
  messageProject: string | null;
  /** The running `cli.js`, and `process.argv[1]`. */
  programFile: string;
  argv1: string | undefined;
  /** The version of this program. */
  version: string;
  /** The clock, in milliseconds (default `Date.now()`): a row dated more than `FUTURE_SLACK_MS` after it is forged and dropped. */
  now?: number;
}

/** A row may be dated this far ahead of the clock (clock skew between two machines sharing a notebook) before it is dropped as forged. */
export const FUTURE_SLACK_MS = 5 * 60_000;

export interface FactsDeps {
  homedir: () => string;
  realpath: (p: string) => string;
  platform: string;
  nodeVersion: string;
  execPath: string;
  readUsage: (dir: string, maxBytes: number) => UsageRow[];
  stat: (p: string) => { isFile(): boolean; isDirectory(): boolean };
  lstat: (p: string) => { isFile(): boolean };
  readdir: (p: string) => string[];
  writable: (p: string) => boolean;
  enabled: (env: NodeJS.ProcessEnv, cwd: string) => EnabledState;
  listMessages: (home: string, nbDir: string) => MessageListing;
  readMessages: (listing: MessageListing, kind: MessageKind, project: string | null) => { global: MessageFile; project: MessageFile | null };
  changelog: (version: string) => string | null;
}

const defaultDeps: FactsDeps = {
  homedir: () => homedir(),
  realpath: (p) => realpathSync(p),
  platform: process.platform,
  nodeVersion: process.version,
  execPath: process.execPath,
  readUsage: (dir, maxBytes) => parseUsage(dir, { maxBytes }),
  stat: (p) => statSync(p),
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
  writable: (p) => {
    accessSync(p, fsConstants.W_OK);
    return true;
  },
  enabled: (env, cwd) => resolveEnabled(env, cwd),
  listMessages,
  readMessages,
  changelog: (version) => readReleaseDate(version),
};

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Display values
// ---------------------------------------------------------------------------

const FIELD_CAP = 512;

function cap(s: string, n: number = FIELD_CAP): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** `p` with the home folder (either spelling) shown as `~`, matched on a path boundary. */
export function tildify(p: string, homes: readonly string[], platform: string): string {
  const win = platform === 'win32';
  const norm = (s: string): string => (win ? s.toLowerCase() : s);
  const cands = homes.filter((h) => h !== '').map((h) => h.replace(/[\\/]+$/, '')).filter((h) => h !== '').sort((a, b) => b.length - a.length);
  for (const h of cands) {
    if (norm(p) === norm(h)) return '~';
    const sep = p.charAt(h.length);
    if (norm(p.slice(0, h.length)) === norm(h) && (sep === '/' || (win && sep === '\\'))) return `~${p.slice(h.length)}`;
  }
  return p;
}

/** A value from disk, the environment or git, as the detail block prints it: capped, `~` for the home folder, escaped. */
export function shown(raw: string, homes: readonly string[], platform: string): string {
  return escapeDiskName(tildify(cap(raw), homes, platform));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const LABEL_RE = /^[a-z0-9._-]{1,40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const KEY_RE = /^(?:\?|h:[0-9a-f]{12}|[a-z0-9][a-z0-9._-]{0,63})$/;
const ERROR_CLASS_RE = /^[a-z_]{1,32}$/;
const OTHER_OUTCOME_RE = /^[a-z][a-z0-9-]{0,23}$/;

const OUTCOMES: Record<string, readonly string[]> = {
  brief: ['index', 'layered', 'empty', 'broken', 'off'],
  retro: ['nudge', 'already', 'off', 'off-work-dir'],
  add: ['accepted', 'dedup-blocked', 'rejected-full', 'empty', 'too-long'],
};

/** A valid usage row: the `brief`/`retro` ones become a `StatusRow`; the others only feed the counts and the last accepted add. */
interface Item {
  at: string;
  atMs: number;
  row: StatusRow | null;
  addAccepted: boolean;
}

/**
 * A usage row, checked again at read time: it is used only if every column passes.
 * Rows are cleaned when written, and a forged or damaged one is dropped whole.
 */
export function validateRow(u: UsageRow): Item | null {
  if (!ISO_RE.test(u.ts)) return null;
  const atMs = Date.parse(u.ts);
  if (!Number.isFinite(atMs)) return null;
  if (!ROW_COMMANDS.includes(u.command)) return null;
  const list = OUTCOMES[u.command];
  const outcomeOk = list !== undefined ? list.includes(u.outcome) || (!u.ok && u.outcome === '') : u.outcome === '' || OTHER_OUTCOME_RE.test(u.outcome);
  if (!outcomeOk) return null;
  if (u.errorClass !== '' && !ERROR_CLASS_RE.test(u.errorClass)) return null;
  const addAccepted = u.command === 'add' && u.ok && u.outcome === 'accepted';
  if (u.command !== 'brief' && u.command !== 'retro') {
    return u.version !== '' || u.project !== '' ? null : { at: u.ts, atMs, row: null, addAccepted };
  }
  if (u.note !== '' && !LABEL_RE.test(u.note)) return null;
  if (u.version !== '' && !VERSION_RE.test(u.version)) return null;
  if (u.project !== '' && !KEY_RE.test(u.project)) return null;
  const row: StatusRow = {
    at: u.ts,
    atMs,
    command: u.command,
    ok: u.ok,
    label: u.note,
    outcome: u.outcome,
    version: u.version,
    project: u.project,
    errorClass: u.errorClass,
    session: u.session.slice(-8).replace(/[^0-9A-Za-z._-]/g, '?'),
  };
  return { at: u.ts, atMs, row, addAccepted };
}

/** The valid rows of one log, in file order. */
function readLog(deps: FactsDeps, dir: string, now: number): Item[] {
  const out: Item[] = [];
  for (const u of safe(() => deps.readUsage(dir, STATUS_LOG_MAX_BYTES), [] as UsageRow[])) {
    const item = safe(() => validateRow(u), null);
    if (item !== null && item.atMs <= now + FUTURE_SLACK_MS) out.push(item);
  }
  return out;
}

/** Two logs merged by timestamp, each kept in its own order; on a tie the own log's row is the newer. */
function merge(shared: Item[], own: Item[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  let j = 0;
  while (i < shared.length && j < own.length) {
    if (shared[i]!.atMs <= own[j]!.atMs) out.push(shared[i++]!);
    else out.push(own[j++]!);
  }
  while (i < shared.length) out.push(shared[i++]!);
  while (j < own.length) out.push(own[j++]!);
  return out;
}

// ---------------------------------------------------------------------------
// The release date
// ---------------------------------------------------------------------------

/** The date of `## [<version>] - YYYY-MM-DD` in the shipped `CHANGELOG.md`, or `null`. Bounded: a regular file under 1 MiB. */
export function readReleaseDate(version: string): string | null {
  try {
    const file = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));
    const st = lstatSync(file);
    if (!st.isFile() || st.size >= CHANGELOG_MAX_BYTES) return null;
    return releaseDateIn(readFileSync(file, 'utf-8'), version);
  } catch {
    return null;
  }
}

/** The date in the heading of `version` in a changelog text, or `null`. */
export function releaseDateIn(text: string, version: string): string | null {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^## \\[${esc}\\](?:\\([^)\\n]*\\))? - (\\d{4}-\\d{2}-\\d{2})[ \\t]*$`, 'm').exec(text);
  if (m === null || !Number.isFinite(Date.parse(m[1]!))) return null;
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function refusalCode(reason: string): RefusalCode {
  if (reason === INSIDE_NOTEBOOKS_WHY) return 'inside_notebooks';
  if (reason === NOT_UTF8_WHY) return 'not_utf8';
  if (reason === 'empty') return 'empty';
  if (reason.startsWith('larger than')) return 'too_long';
  if (reason.startsWith('unreadable')) return 'unreadable';
  return 'other';
}

function messageFacts(deps: FactsDeps, home: string, sharedDir: string, project: string | null, homes: readonly string[]): StatusFacts['messages'] {
  const listing = deps.listMessages(home, sharedDir);
  const files: MessageFileFact[] = [];
  for (const kind of ['brief', 'retro'] as const) {
    const set = deps.readMessages(listing, kind, project);
    for (const f of [set.global, set.project]) {
      if (f === null) continue;
      files.push({
        kind,
        file: shown(f.file, homes, process.platform),
        status: f.status,
        reason: f.status === 'refused' ? refusalCode(f.reason) : null,
      });
    }
  }
  return { state: listing.state, files };
}

// ---------------------------------------------------------------------------
// The facts
// ---------------------------------------------------------------------------

function keyKindOf(key: string | null): KeyKind {
  if (key === null) return 'none';
  if (key === '?') return 'undetermined';
  return key.startsWith('h:') ? 'folder-hash' : 'name';
}

/** Read everything `nb status` needs. Never throws. */
export function gatherFacts(input: FactsInput, overrides: Partial<FactsDeps> = {}): StatusFacts {
  const deps: FactsDeps = { ...defaultDeps, ...overrides };
  const platform = deps.platform;
  const home = safe(() => deps.homedir(), '');
  const homes = [home, safe(() => deps.realpath(home), '')].filter((h) => h !== '');
  const show = (s: string): string => shown(s, homes, platform);

  const en = safe(() => deps.enabled(input.env, input.cwd ?? '.'), null);
  const st = input.project;
  const key = safe((): string | null => {
    if (st === null) return null;
    if (input.cwd === null && st.source !== 'env') return null;
    return projectRecordKey(input.cwd ?? '.', st);
  }, null);

  const dir = input.place.dir;
  let folder: StatusFacts['live']['folder'] = 'ok';
  let log: StatusFacts['live']['log'] = 'absent';
  let shelves: number | null = null;
  if (dir !== null) {
    try {
      const s = deps.stat(dir);
      if (!s.isDirectory()) folder = 'not-folder';
      else {
        const names = deps.readdir(dir);
        shelves = names.filter((n) => !n.startsWith('.') && n.endsWith('.md') && n.toLowerCase() !== 'readme.md').length;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      folder = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
      // A folder that does not exist yet holds no shelves (`brief` creates it; status creates nothing).
      if (folder === 'missing') shelves = 0;
    }
    if (folder === 'ok') {
      const file = usageFile(dir);
      try {
        deps.lstat(file);
        try {
          log = deps.stat(file).isFile() && deps.writable(file) ? 'ok' : 'unwritable';
        } catch {
          log = 'unwritable';
        }
      } catch (e) {
        log = (e as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? 'absent' : 'unwritable';
      }
    }
  }

  // The logs: an own place reads its own log and the shared one, otherwise the shared one.
  const now = input.now ?? Date.now();
  const sharedRows = readLog(deps, input.place.shared, now);
  const ownRows = input.place.kind === 'own' && dir !== null && dir !== input.place.shared ? readLog(deps, dir, now) : [];
  const all = merge(sharedRows, ownRows);
  const rows: StatusRow[] = [];
  let lastAddAt: string | null = null;
  for (const x of all) {
    if (x.row !== null) rows.push(x.row);
    if (x.addAccepted) lastAddAt = x.at;
  }
  let since: string | null = null;
  let sinceMs = Infinity;
  for (const x of all) {
    if (x.atMs < sinceMs) {
      sinceMs = x.atMs;
      since = x.at;
    }
  }

  const messages = safe(() => messageFacts(deps, home, input.place.shared, input.messageProject, homes), { state: 'unreadable', files: [] as MessageFileFact[] });
  const released = safe(() => deps.changelog(input.version), null);
  const programPaths = safe(() => {
    const real = deps.realpath(input.programFile);
    const out = [real];
    if (input.argv1 !== undefined && input.argv1 !== '') {
      const a = safe(() => deps.realpath(input.argv1!), input.argv1);
      if (a !== real) out.push(a);
    }
    return out.map(show);
  }, [show(input.programFile)]);

  return {
    switch: { enabled: en === null ? true : en.enabled, source: en === null ? 'default' : en.source },
    place: { kind: input.place.kind },
    project: {
      name: st === null || st.name === '' ? null : st.name,
      source: st === null ? 'none' : st.source,
      keyKind: keyKindOf(key),
      key,
    },
    live: { folder, log },
    rows,
    rowsRead: all.length,
    since,
    notebook: { shelves, lastAddAt },
    messages,
    program: { version: input.version, released, nodeVersion: deps.nodeVersion, platform },
    shown: {
      projectName: st === null || st.name === '' ? null : show(st.name),
      folderAsked: input.cwd === null ? null : show(input.cwd),
      notebookFolder: dir === null ? null : show(dir),
      notebookWhy: show(input.place.reason),
      programPaths,
      nodePath: show(deps.execPath),
    },
  };
}
