/**
 * The agent-facing loop (issue #538): `nb brief`, what an assistant sees at the
 * start of a session, and `nb retro`, the end-of-task retrospective said once
 * per session.
 *
 * Harness-blind by rule: nothing here reads standard input, a hook payload, or a
 * harness variable such as `CLAUDE_PROJECT_DIR`. An adapter (the Claude Code one
 * lives in `examples/hooks/claude-code/`) turns its harness's event into a call
 * of this command and wraps the printed text in its harness's reply format.
 *
 * It is a port of the 0.12 `nb-retrospective.sh` once its Claude Code checks
 * (a stop that is already a hook-forced continuation, a subagent's stop, delegated work in flight) are done by
 * the adapter: the same sentinel file `<NB_DIR>/.retro-<session>`, created with
 * the same exclusive flag, so an old copied script and the new command running
 * for one session nudge once between them; the same order of steps; the same
 * sweep of old sentinels; the same `NB_RETRO_EXTRA_PROMPT` rules, plus a check
 * that the file is a regular file of at most 64 KiB before it is opened
 * (requirements FR-RETRO-001..003).
 *
 * This module asks `git` through `enabled.ts` (the switch) and `project.ts` (the
 * project name, issue #540), never directly. It never writes stdout: `cli.ts` does.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  BRIEF_EMPTY_LINE,
  BRIEF_HEADER_LINES,
  BRIEF_OFF_LINE,
  FRAMING_LINE,
  LAYERED_TEXT,
  LAYERED_TEXT_DERIVED,
  LAYERED_UNAVAILABLE_LINE,
  RETRO_LESSONS,
  briefBrokenLine,
  briefCutLine,
  layeredPreamble,
} from './agent-text.js';
import { resolveEnabled, type EnabledState } from './enabled.js';
import { cleanProjectName, groupsIndex, resolveProject, type ProjectState } from './project.js';
import { escapeDiskName, expandHomeDir, listNotebooks, type NotebookSummary } from './notebook.js';
import { formatListing, renderConflicts, renderSkipped } from './render.js';

/** What `nb retro` decided. `already` means a sentinel for this session existed. */
export type RetroOutcome = 'nudge' | 'already' | 'off' | 'off-work-dir';

export interface RetroResult {
  outcome: RetroOutcome;
  /** The text to print (no trailing newline); `''` unless `outcome` is `nudge`. */
  text: string;
  /** The cleaned session id, as used in the sentinel name. */
  session: string;
  /** Warnings for stderr, each ending in `\n`; `''` when none. */
  err: string;
}

export interface RetroOptions {
  /** The raw `--session` value. `''` means "no session id" (the sentinel is then `.retro-nosession`). */
  session: string;
  /** The raw `--work-dir` value, or undefined. Used only when it is an existing absolute directory. */
  workDir?: string;
  /** The notebooks directory (holds the sentinels). */
  dir: string;
  /** The project directory: the working directory the command runs in; `null` when it no longer exists. */
  cwd: string | null;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; the CLI uses the real resolver. */
  enabled?: (env: NodeJS.ProcessEnv, cwd: string) => EnabledState;
  /** Injectable clock for the sweep; the CLI uses `Date.now`. */
  now?: () => number;
}

/** Largest `NB_RETRO_EXTRA_PROMPT` file read, in bytes. Larger files are skipped with a warning. */
export const EXTRA_PROMPT_MAX_BYTES = 64 * 1024;

/** Default age, in days, past which a `.retro-*` sentinel is removed. */
export const RETRO_TTL_DAYS_DEFAULT = 7;

/**
 * Clean a session id for use in a file name, as the 0.12 Stop hook did: every
 * character outside `A-Za-z0-9._-` becomes `_`, then at most 128 characters
 * are kept. One rule is new: a leading `-` becomes `_`, so a cleaned id can
 * never be read as a command-line flag (the CLI strips `--json` anywhere in its
 * arguments). A UUID passes through unchanged. `''` becomes `nosession`.
 */
export function cleanSessionId(raw: string): string {
  const s = String(raw || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return s.startsWith('-') ? '_' + s.slice(1) : s;
}

/** `NB_RETRO_TTL_DAYS` as a number of days: a positive finite number, else the default (7). */
export function retroTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.NB_RETRO_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : RETRO_TTL_DAYS_DEFAULT;
}

/**
 * Read the `NB_RETRO_EXTRA_PROMPT` file. Returns its trimmed text, or `''` with
 * a reason when it is unset or unusable. The path must be absolute (a leading
 * `~` or `~/` is expanded) and name a regular file of at most
 * `EXTRA_PROMPT_MAX_BYTES` without a NUL byte. The type is checked with `stat`
 * before the file is opened, and again on the open descriptor, so a FIFO or a
 * device never stalls the call.
 */
export function readExtraPrompt(env: NodeJS.ProcessEnv): { text: string; warning: string | null } {
  const raw = env.NB_RETRO_EXTRA_PROMPT ?? '';
  if (raw === '') return { text: '', warning: null };
  const p = raw === '~' || raw.startsWith('~/') ? expandHomeDir(raw) : raw;
  const fail = (why: string): { text: string; warning: string } => ({
    text: '',
    warning: `nb retro: ignoring NB_RETRO_EXTRA_PROMPT (${why}); sending the lessons retrospective alone\n`,
  });
  if (!isAbsolute(p)) return fail('path must be absolute');
  let fd: number | undefined;
  try {
    const st = statSync(p);
    if (!st.isFile()) return fail('not a regular file');
    if (st.size > EXTRA_PROMPT_MAX_BYTES) return fail(`larger than ${EXTRA_PROMPT_MAX_BYTES} bytes`);
    fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return fail('not a regular file');
    if (fst.size > EXTRA_PROMPT_MAX_BYTES) return fail(`larger than ${EXTRA_PROMPT_MAX_BYTES} bytes`);
    const buf = readFileSync(fd);
    if (buf.length > EXTRA_PROMPT_MAX_BYTES) return fail(`larger than ${EXTRA_PROMPT_MAX_BYTES} bytes`);
    if (buf.includes(0)) return fail('the file holds NUL bytes; save it as UTF-8 text');
    let text = buf.toString('utf-8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // a UTF-8 byte-order mark
    return { text: text.trim(), warning: null };
  } catch (err) {
    return fail((err as NodeJS.ErrnoException).code ?? (err as Error).message ?? String(err));
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed or never opened: nothing to release
      }
    }
  }
}

/** An existing absolute directory, resolved; else `null`. */
function existingAbsoluteDir(p: string | undefined): string | null {
  if (p === undefined || p === '' || !isAbsolute(p)) return null;
  try {
    return statSync(p).isDirectory() ? resolve(p) : null;
  } catch {
    return null;
  }
}

/**
 * `nb retro`: the retrospective text the first time it is called for a
 * session, nothing afterwards (FR-RETRO-001). The steps run in the order of the
 * 0.12 Stop hook, so an old copied script and this command agree:
 *   1. read the extra prompt (a bad file only warns);
 *   2. claim the session's sentinel with an exclusive create; "already exists"
 *      prints nothing; any other error falls through to a nudge (fail open);
 *   3. remove `.retro-*` files older than `NB_RETRO_TTL_DAYS` (best effort);
 *   4. off in the project directory: print nothing, keep the claim;
 *   5. off in `workDir` only: print nothing, release the claim, so a later call
 *      from an on directory still nudges once (issue #517);
 *   6. print the nudge, plus the extra text when it applies.
 */
export function retro(opts: RetroOptions): RetroResult {
  const env = opts.env ?? process.env;
  const enabled = opts.enabled ?? resolveEnabled;
  const now = opts.now ?? Date.now;
  const session = cleanSessionId(opts.session);
  let err = '';

  // 1. The extra prompt, read before the claim: a broken file never costs the nudge.
  const extra = readExtraPrompt(env);
  if (extra.warning !== null) err += extra.warning;

  // 2. Claim the sentinel. `wx` is O_CREAT|O_EXCL: of two processes racing on one
  //    session, exactly one creates the file.
  const sentinel = join(opts.dir, `.retro-${session}`);
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch {
    // the create below reports the real problem, and fails open
  }
  try {
    writeFileSync(sentinel, new Date(now()).toISOString(), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { outcome: 'already', text: '', session, err };
    // Any other error (a read-only folder, for example): fail open and nudge.
  }

  // 3. Sweep old sentinels. Ours was just written, so it is never a candidate.
  try {
    const cutoff = now() - retroTtlDays(env) * 86_400_000;
    for (const name of readdirSync(opts.dir)) {
      if (!name.startsWith('.retro-')) continue;
      const p = join(opts.dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        // gone already, or not ours to remove
      }
    }
  } catch {
    // an unreadable folder: nothing to sweep
  }

  // 4-5. The per-repository switch, in the project directory, then in the
  //      directory the assistant last worked in.
  //      A working directory that no longer exists (a removed worktree) cannot be
  //      asked: the switch then fails open, as it does for any git error.
  const projectDir = opts.cwd === null ? null : resolve(opts.cwd);
  if (projectDir !== null && !enabled(env, projectDir).enabled) return { outcome: 'off', text: '', session, err };
  const workDir = existingAbsoluteDir(opts.workDir);
  if (workDir !== null && workDir !== projectDir && !enabled(env, workDir).enabled) {
    try {
      unlinkSync(sentinel);
    } catch {
      // not created (a read-only folder) or already gone
    }
    return { outcome: 'off-work-dir', text: '', session, err };
  }

  // 6. The text. The extra prompt is appended only when both placeholders can be
  //    filled: a session id was given and a project name is found.
  let text = RETRO_LESSONS;
  if (extra.text !== '' && opts.session !== '') {
    const asked = workDir ?? projectDir;
    // One rule for every caller (FR-PROJECT-001): the name `nb project` prints in that directory.
    const project = asked === null ? (env.NB_PROJECT_SLUG ? cleanProjectName(env.NB_PROJECT_SLUG) : '') : resolveProject(env, asked).name;
    if (project !== '') {
      const values: Record<string, string> = { project, session };
      text = `${RETRO_LESSONS}\n\n${extra.text.replace(/\{(project|session)\}/g, (_, k: string) => values[k]!)}`;
    }
  }
  return { outcome: 'nudge', text, session, err };
}

/** What `nb brief` printed in place of, or as, the index. */
export type BriefOutcome = 'index' | 'layered' | 'empty' | 'broken' | 'off';

export interface BriefResult {
  outcome: BriefOutcome;
  /** The text to print, ending in `\n`. */
  text: string;
  /** Notes for stderr (skipped or conflicted shelves), `''` when none. */
  err: string;
}

export interface BriefOptions {
  /** The notebooks directory. */
  dir: string;
  /** The project directory: the working directory the command runs in; `null` when it no longer exists. */
  cwd: string | null;
  /** Character budget for the whole text; `0` disables it. */
  maxChars: number;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; the CLI uses the real resolver. */
  enabled?: (env: NodeJS.ProcessEnv, cwd: string) => EnabledState;
  /** Injectable for tests; the CLI uses the real resolver (FR-PROJECT-001). */
  project?: (env: NodeJS.ProcessEnv, cwd: string) => ProjectState;
}

/**
 * Whether the notebooks folder holds a shelf whose name contains `@` (a project
 * shelf). Only file names are read, no file is parsed; a hidden file (such as a
 * `.retro-*` sentinel) or a file not ending in `.md` does not count. An unreadable
 * folder counts as no.
 */
function hasProjectShelf(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => !f.startsWith('.') && f.endsWith('.md') && f.includes('@'));
  } catch {
    return false;
  }
}

/** Default `--max-chars`: Claude Code shows hook output whole up to 10,000 characters (epic #537, M9). */
export const BRIEF_MAX_CHARS_DEFAULT = 9000;
/** Rows of the flat index, as the 0.12 hook's `nb list` showed. */
const FLAT_LIMIT = 50;
/** Rows read for the layered index, as the 0.12 hook's `nb list --json --limit 1000` read. */
const LAYERED_LIMIT = 1000;

/**
 * Make a value safe to place in model-facing text (FR-BRIEF-003): control
 * characters, line and paragraph separators and bidi or zero-width marks become
 * visible `\uXXXX` escapes, so no value can start a line of its own.
 */
const clean = escapeDiskName;

/** The errno-style code of a failed directory read, or `error`. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'error';
}

/** Two-space indent, as the 0.12 hook's `sed 's/^/  /'` did. */
const indent = (lines: string[]): string[] => lines.map((l) => `  ${l}`);

/**
 * The lines of the flat index body, or of the empty or broken line. Over budget
 * (`room` characters for the body), rows are dropped from the end, fewest lessons
 * first, and the last line says how many were left out.
 */
function flatBody(dir: string, room: number, maxChars: number): { lines: string[]; outcome: BriefOutcome; err: string } {
  let listing;
  try {
    listing = listNotebooks(dir, { limit: FLAT_LIMIT });
  } catch (err) {
    return { lines: [briefBrokenLine(errorCode(err))], outcome: 'broken', err: '' };
  }
  const err = renderSkipped('brief', listing.skipped) + renderConflicts('brief', listing.conflicts);
  if (listing.total === 0) return { lines: [BRIEF_EMPTY_LINE], outcome: 'empty', err };
  const render = (k: number, cut: boolean): string[] =>
    indent(
      formatListing(listing.rows.slice(0, k), listing.total, {
        dir,
        clean,
        ...(cut ? { footer: briefCutLine(listing.total - k, maxChars, listing.total) } : {}),
      }),
    );
  let lines = render(listing.rows.length, false);
  for (let k = listing.rows.length; room > 0 && size(lines) > room && k > 0; ) {
    k--;
    lines = render(k, true);
  }
  return { lines, outcome: 'index', err };
}

/** Characters the lines take once joined and newline-ended. */
function size(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

/**
 * The layered index (`NB_PROJECT_SLUG` set, or a derived project name), a port of the 0.12 hook's node
 * block: this project's shelves, the bare domain shelves, the one global shelf,
 * and how many other projects' shelves were hidden. The notes are computed on
 * the whole listing; over budget, rows are dropped fewest lessons first,
 * whatever their layer (FR-BRIEF-002). Throws when the folder cannot be read.
 */
function layeredBody(
  dir: string,
  slug: string,
  globalName: string,
  room: number,
  maxChars: number,
  derived: boolean,
): { lines: string[]; err: string } {
  const listing = listNotebooks(dir, { limit: LAYERED_LIMIT });
  const err = renderSkipped('brief', listing.skipped) + renderConflicts('brief', listing.conflicts);
  const slugKey = slug.toLowerCase();
  const layerOf = (r: NotebookSummary): 'project' | 'domain' | 'global' | 'hidden' => {
    const at = r.shelf.lastIndexOf('@');
    if (at >= 0) return r.shelf.slice(at + 1).toLowerCase() === slugKey ? 'project' : 'hidden';
    return r.shelf === globalName ? 'global' : 'domain';
  };
  const classified = listing.rows.filter((r) => layerOf(r) !== 'hidden');
  const hidden = listing.rows.length - classified.length;
  const hadProject = classified.some((r) => layerOf(r) === 'project');
  const unread = listing.total - listing.rows.length;
  const cSlug = clean(slug);
  const row = (r: NotebookSummary): string =>
    '  ' + clean(r.shelf) + '  ' + r.lessons + '  ' + clean(String(r.desc || r.auto || '')).slice(0, 100) + (!r.desc && r.auto ? '  (auto)' : '');
  const render = (kept: NotebookSummary[], cut: number): string[] => {
    const out = [...layeredPreamble(cSlug), ''];
    // A layer is shown when it has shelves before the cut, so a budget that cuts all
    // of its rows still leaves its heading (FR-BRIEF-002); the cut line says why.
    const section = (title: string, layer: 'project' | 'domain' | 'global', ifEmpty?: string): void => {
      const had = classified.some((r) => layerOf(r) === layer);
      if (!had && ifEmpty === undefined) return;
      out.push('### ' + title);
      const rows = kept.filter((r) => layerOf(r) === layer);
      if (rows.length) out.push(...rows.map(row));
      else if (!had) out.push('  ' + ifEmpty);
    };
    section(LAYERED_TEXT.projectTitle(cSlug), 'project', hadProject ? undefined : LAYERED_TEXT.projectEmpty(cSlug));
    section(LAYERED_TEXT.domainTitle, 'domain');
    section(LAYERED_TEXT.globalTitle, 'global');
    out.push('');
    if (unread > 0) out.push(LAYERED_TEXT.unclassified(unread));
    const notes = derived ? LAYERED_TEXT_DERIVED : LAYERED_TEXT;
    out.push(hidden > 0 && !hadProject && unread === 0 ? notes.noneForSlug(hidden, cSlug) : notes.hidden(hidden, cSlug));
    if (cut > 0) out.push(briefCutLine(cut, maxChars, listing.total));
    return out;
  };
  let lines = render(classified, 0);
  // `classified` is richest first, so dropping from its end drops the fewest lessons first.
  for (let k = classified.length; room > 0 && size(lines) > room && k > 0; ) {
    k--;
    lines = render(classified.slice(0, k), classified.length - k);
  }
  return { lines, err };
}

/**
 * `nb brief`: what an assistant should see at the start of a session
 * (FR-BRIEF-001..003). The 0.12 `nb-session-start.sh` output, plus one framing
 * line, a size budget, and cleaning of every value placed in the text.
 */
export function brief(opts: BriefOptions): BriefResult {
  const env = opts.env ?? process.env;
  const enabled = opts.enabled ?? resolveEnabled;
  // A removed working directory cannot be asked: the switch fails open, as in retro().
  if (opts.cwd !== null && !enabled(env, resolve(opts.cwd)).enabled) return { outcome: 'off', text: BRIEF_OFF_LINE + '\n', err: '' };
  const head = [...BRIEF_HEADER_LINES, FRAMING_LINE, ''];
  const room = opts.maxChars > 0 ? Math.max(1, opts.maxChars - size(head)) : 0;
  // The project the index is grouped by: NB_PROJECT_SLUG exactly as before (its raw
  // trimmed value; set but blank keeps the flat index, and no git runs); else, when the
  // store already holds a project shelf, the derived name, if it came from the remote
  // (a folder name could be shared by two unrelated repositories, FR-BRIEF-003).
  let slug = (env.NB_PROJECT_SLUG ?? '').trim().slice(0, 128);
  let derived = false;
  if (!env.NB_PROJECT_SLUG && opts.cwd !== null && hasProjectShelf(opts.dir)) {
    const st = (opts.project ?? resolveProject)(env, resolve(opts.cwd));
    if (groupsIndex(st) && st.name !== '') {
      slug = st.name;
      derived = true;
    }
  }
  const out = (lines: string[], outcome: BriefOutcome, err: string): BriefResult => ({
    outcome,
    text: [...head, ...lines].join('\n') + '\n',
    err,
  });
  if (slug !== '') {
    try {
      const layered = layeredBody(opts.dir, slug, env.NB_GLOBAL_SHELF || 'global', room, opts.maxChars, derived);
      return out(layered.lines, 'layered', layered.err);
    } catch {
      const flat = flatBody(opts.dir, room, opts.maxChars);
      return out([LAYERED_UNAVAILABLE_LINE, ...flat.lines], flat.outcome, flat.err);
    }
  }
  const flat = flatBody(opts.dir, room, opts.maxChars);
  return out(flat.lines, flat.outcome, flat.err);
}
