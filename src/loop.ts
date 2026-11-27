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
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  BRIEF_EMPTY_LINE,
  BRIEF_HEADER_LINES,
  BRIEF_OFF_LINE,
  FRAMING_LINE,
  LAYERED_TEXT,
  LAYERED_TEXT_DERIVED,
  LAYERED_UNAVAILABLE_LINE,
  PLACE_TEXT,
  RETRO_LESSONS,
  SETUP_NOTE_FIRST,
  SETUP_NOTE_FIRST_NO_PROJECT,
  USER_INSTRUCTIONS,
  briefBrokenLine,
  briefCutLine,
  layeredPreamble,
  setupNoteProject,
} from './agent-text.js';
import { resolveEnabled, type EnabledState } from './enabled.js';
import { cleanProjectName, groupsIndex, resolveProject, type ProjectState } from './project.js';
import { escapeDiskName, expandHomeDir, listNotebooks, stripControlChars, type NotebookSummary } from './notebook.js';
import { listMessages, readCheckedFile, readMessages, type MessageFile } from './messages.js';
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
  /** Injectable for tests; the CLI uses the real resolver (FR-PROJECT-001). Asked at most once per call. */
  project?: (env: NodeJS.ProcessEnv, cwd: string) => ProjectState;
  /** The home folder whose `.agent-notebook/messages/` is read (issue #539); the CLI uses `os.homedir()`. */
  home?: string;
  /** The shared notebooks folder, for the check that the messages folder is not inside it; defaults to `dir`. */
  nbDir?: string;
  /** Whether a project name is a Windows device name, which never selects a message file (see `BriefOptions`). */
  isDeviceName?: (name: string) => boolean;
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

/** What `NB_RETRO_EXTRA_PROMPT` names and whether it can be used: `why` is the reason it cannot, else `null`. */
export interface ExtraPromptStatus {
  /** Whether the variable is set to a non-empty value. */
  set: boolean;
  /** The path it names, `~` expanded; `''` when unset. */
  path: string;
  /** The trimmed text; `''` when unset or unusable. */
  text: string;
  why: string | null;
}

/**
 * Read the `NB_RETRO_EXTRA_PROMPT` file. Returns its trimmed text, or `''` with
 * a reason when it is unset or unusable. The path must be absolute (a leading
 * `~` or `~/` is expanded) and name a regular file of at most
 * `EXTRA_PROMPT_MAX_BYTES` without a NUL byte. The type is checked with `stat`
 * before the file is opened, and again on the open descriptor, so a FIFO or a
 * device never stalls the call.
 */
export function extraPromptStatus(env: NodeJS.ProcessEnv): ExtraPromptStatus {
  const raw = env.NB_RETRO_EXTRA_PROMPT ?? '';
  if (raw === '') return { set: false, path: '', text: '', why: null };
  const p = raw === '~' || raw.startsWith('~/') ? expandHomeDir(raw) : raw;
  if (!isAbsolute(p)) return { set: true, path: p, text: '', why: 'path must be absolute' };
  // The shared reader (messages.ts) does the checks, in this order and with these
  // reasons; the text is decoded without a strictness check, as it always was.
  const r = readCheckedFile(p, EXTRA_PROMPT_MAX_BYTES);
  return r.ok ? { set: true, path: p, text: r.bytes.toString('utf-8').trim(), why: null } : { set: true, path: p, text: '', why: r.why };
}

/** `extraPromptStatus` with the stderr warning `nb retro` prints for an unusable file. */
export function readExtraPrompt(env: NodeJS.ProcessEnv): { text: string; warning: string | null } {
  const st = extraPromptStatus(env);
  return {
    text: st.text,
    warning: st.why === null ? null : `nb retro: ignoring NB_RETRO_EXTRA_PROMPT (${st.why}); sending the lessons retrospective alone\n`,
  };
}

/** An existing absolute directory, resolved; else `null`. */
export function existingAbsoluteDir(p: string | undefined): string | null {
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
 *   6. print the nudge, then the user's retro message files (issue #539, read only
 *      now), then the extra text when it applies.
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

  // 6. The text: the nudge, then the user's message files (issue #539), then the extra
  //    prompt. Nothing of the user's is read before this point: a repeated stop, or a
  //    switch that is off, reads no message file. The project is resolved at most once,
  //    in `--work-dir` else the working directory, and serves the file lookup and every
  //    `{project}`.
  const asked = workDir ?? projectDir;
  let state: ProjectState | undefined;
  const ask = (): ProjectState => (state ??= projectOfCall(env, asked, opts.project ?? resolveProject));
  const hasSession = opts.session !== '';
  const segments = [RETRO_LESSONS];
  const blocks = retroBlocks(opts, ask, hasSession ? session : null);
  if (blocks.length > 0) segments.push(blocks.join('\n'));
  // The extra prompt is appended only when both placeholders can be filled: a session
  // id was given and a project name is found.
  if (extra.text !== '' && hasSession) {
    const project = ask().name;
    if (project !== '') {
      const values: Record<string, string> = { project, session };
      segments.push(extra.text.replace(/\{(project|session)\}/g, (_, k: string) => values[k]!));
    }
  }
  return { outcome: 'nudge', text: segments.join('\n\n'), session, err };
}

const TOKEN_RE = /\{(project|session)\}/g;

/**
 * The lines the user's retro message files add to `nb retro` (issue #539): the global
 * block, then the project block, each framed as in `nb brief`; a file that exists but
 * cannot be used gives one warning line. `{project}` and `{session}` are filled in a used
 * file; a block whose token has no value (no project name, no session id) is left out
 * without a warning: that is "not applicable here", not a broken file (DP-5). The project
 * is asked only when a `<project>.retro.txt` exists or a used block needs `{project}`.
 */
function retroBlocks(opts: RetroOptions, ask: () => ProjectState, session: string | null): string[] {
  const listing = listMessages(opts.home ?? homedir(), opts.nbDir ?? opts.dir);
  if (listing.state !== 'present' && listing.state !== 'inside-nb-dir') return [];
  const isDevice = opts.isDeviceName ?? (() => false);
  const selected = listing.projectFiles.retro.length > 0 ? messageProjectName(ask(), isDevice).name : null;
  const set = readMessages(listing, 'retro', selected);
  const lines = (f: MessageFile, label: string): string[] => {
    if (f.status !== 'used') return blockLines(f, label);
    const needs = new Set([...f.text.matchAll(TOKEN_RE)].map((m) => m[1]));
    const values: Record<string, string> = { project: needs.has('project') ? ask().name : '', session: session ?? '' };
    if ((needs.has('project') && values.project === '') || (needs.has('session') && session === null)) return [];
    return [label, f.text.replace(TOKEN_RE, (_, k: string) => values[k]!), USER_INSTRUCTIONS.end];
  };
  return [
    ...lines(set.global, USER_INSTRUCTIONS.globalLabel(set.global.file)),
    ...(set.project === null || selected === null ? [] : lines(set.project, USER_INSTRUCTIONS.projectLabel(selected, set.project.file))),
  ];
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
  /**
   * The line saying where this project's lessons go (issue #548), placed after the
   * framing line; omitted when no project folder exists, so the text is unchanged.
   */
  placeLine?: string;
  /** The call could not tell which notebook to use: print the header, `placeLine` and the user's message blocks, with no index (outcome `broken`). */
  placeUnknown?: boolean;
  /**
   * `.layout` exists (issue #560) and a project name can be asked: the index is grouped by
   * the derived name even while the store holds no project shelf yet. Computed by the CLI,
   * which reads that file; this module never does.
   */
  layoutGroup?: boolean;
  /**
   * A set-up note (issue #560, FR-SETUP-003), as `setupNoteText` made it: printed first,
   * before the index heading, in the part that is never cut. Omitted without `--welcome`,
   * so the text is unchanged.
   */
  note?: string;
  /** The home folder whose `.agent-notebook/messages/` is read (issue #539); the CLI uses `os.homedir()`. */
  home?: string;
  /** The shared notebooks folder, for the check that the messages folder is not inside it; defaults to `dir`. */
  nbDir?: string;
  /**
   * Whether a project name is a Windows device name, which never selects a message file.
   * The CLI passes `place.ts`'s test, which this module cannot import (issue #539).
   */
  isDeviceName?: (name: string) => boolean;
}

/** Which set-up note: A (first chat, project named), A' (first chat, no project name), B (a new project). */
export type SetupNoteKind = 'first' | 'first-no-project' | 'project';

/** The text of a set-up note, no trailing newline. `name` is the cleaned project name of kind `project`. */
export function setupNoteText(kind: SetupNoteKind, name = ''): string {
  return (kind === 'first' ? SETUP_NOTE_FIRST : kind === 'first-no-project' ? SETUP_NOTE_FIRST_NO_PROJECT : setupNoteProject(name)).join('\n');
}

/**
 * Whether a note fits `maxChars` with the heading and framing lines that always follow it
 * (`0` disables the budget). A note that does not fit is not printed, and the CLI does not
 * claim it, so the question is never spent unseen.
 */
export function setupNoteFits(note: string, maxChars: number): boolean {
  return maxChars <= 0 || size([...note.split('\n'), '', ...BRIEF_HEADER_LINES, FRAMING_LINE, '']) <= maxChars;
}

/**
 * The project name that may select a message file (issue #539, FR-MSG-001), or `null`,
 * with one sentence saying why for `nb config`. Only a name from `NB_PROJECT_SLUG` or the
 * git remote selects a file, as for an own notebook (FR-PLACE-001): a name taken from the
 * folder can be shared by unrelated repositories. A Windows device name never does.
 */
export function messageProjectName(
  st: ProjectState,
  isDeviceName: (name: string) => boolean,
): { name: string | null; why: string } {
  if (st.name === '' || st.source === 'none') return { name: null, why: `no project name (${st.reason})` };
  if (st.bare) return { name: null, why: 'a bare repository never selects a project file' };
  if (st.source === 'folder') {
    return { name: null, why: 'the project name comes from the folder: set NB_PROJECT_SLUG or an origin remote for a project file' };
  }
  if (isDeviceName(st.name)) return { name: null, why: `"${st.name}" is a Windows device name, which never selects a file` };
  return { name: st.name, why: st.source === 'env' ? 'project name from NB_PROJECT_SLUG' : 'project name from the git remote' };
}

/** The project of a call whose directory may be gone: the state of `nb project`, or `NB_PROJECT_SLUG` alone, or none. */
export function projectOfCall(
  env: NodeJS.ProcessEnv,
  cwd: string | null,
  ask: (env: NodeJS.ProcessEnv, cwd: string) => ProjectState,
): ProjectState {
  if (cwd !== null) return ask(env, resolve(cwd));
  const name = env.NB_PROJECT_SLUG ? cleanProjectName(env.NB_PROJECT_SLUG) : '';
  return { name, source: name === '' ? 'none' : 'env', reason: 'the working directory no longer exists', oldName: '', bare: false, undetermined: false };
}

/** The lines of one message file's block, or its warning line, or none. */
function blockLines(f: MessageFile, label: string): string[] {
  if (f.status === 'absent') return [];
  if (f.status === 'refused') return [USER_INSTRUCTIONS.notUsed(f.file, f.reason)];
  return [label, f.text, USER_INSTRUCTIONS.end];
}

/**
 * The line `nb brief` adds once a project folder exists (issue #548,
 * FR-PLACE-004). Values that come from disk are cleaned of control characters.
 */
export function placeLine(
  p: { kind: 'own'; name: string; dir: string } | { kind: 'shared'; folders: number } | { kind: 'unknown'; reason: string },
): string {
  if (p.kind === 'own') return PLACE_TEXT.own(p.name, stripControlChars(p.dir));
  if (p.kind === 'shared') return PLACE_TEXT.shared(p.folders);
  return PLACE_TEXT.unknown(stripControlChars(p.reason));
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
 * The lines the user's message files add to `nb brief` (issue #539): the global block,
 * then the project block, each framed by its label and the end line; a file that exists
 * but cannot be used gives one warning line in place of its block. Empty when the
 * folder is absent, not read, or holds neither file. The project name is asked (`ask`)
 * only when a `<project>.brief.txt` exists, so a user without one never starts git for it.
 */
function briefBlocks(opts: BriefOptions, ask: () => ProjectState): string[] {
  const listing = listMessages(opts.home ?? homedir(), opts.nbDir ?? opts.dir);
  if (listing.state !== 'present' && listing.state !== 'inside-nb-dir') return [];
  let project: string | null = null;
  if (listing.projectFiles.brief.length > 0) project = messageProjectName(ask(), opts.isDeviceName ?? (() => false)).name;
  const set = readMessages(listing, 'brief', project);
  return [
    ...blockLines(set.global, USER_INSTRUCTIONS.globalLabel(set.global.file)),
    ...(set.project === null || project === null
      ? []
      : blockLines(set.project, USER_INSTRUCTIONS.projectLabel(project, set.project.file))),
  ];
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
  const placed = [...BRIEF_HEADER_LINES, FRAMING_LINE, ...(opts.placeLine !== undefined ? [opts.placeLine] : [])];
  // The project name, asked at most once for the call (FR-PROJECT-001): by the messages
  // below and by the grouping of the index.
  let asked: ProjectState | undefined;
  const ask = (): ProjectState => (asked ??= projectOfCall(env, opts.cwd, opts.project ?? resolveProject));
  // The user's own message files (issue #539): after the place line, before the index, in
  // the part that is never cut. No `messages/` folder: no lines, and no process started.
  const blocks = briefBlocks(opts, ask);
  const head = [...(opts.note !== undefined ? [...opts.note.split('\n'), ''] : []), ...placed, ...blocks, ''];
  if (opts.placeUnknown) return { outcome: 'broken', text: head.join('\n') + '\n', err: '' };
  const room = opts.maxChars > 0 ? Math.max(1, opts.maxChars - size(head)) : 0;
  // The project the index is grouped by: NB_PROJECT_SLUG exactly as before (its raw
  // trimmed value; a value of only spaces keeps the flat index and runs no git, while an
  // empty value counts as unset, as `!env.NB_PROJECT_SLUG` below reads it); else, when the
  // store already holds a project shelf, the derived name, if it came from the remote
  // (a folder name could be shared by two unrelated repositories, FR-BRIEF-003).
  let slug = (env.NB_PROJECT_SLUG ?? '').trim().slice(0, 128);
  let derived = false;
  if (!env.NB_PROJECT_SLUG && opts.cwd !== null && (opts.layoutGroup === true || hasProjectShelf(opts.dir))) {
    const st = ask();
    if (groupsIndex(st) && st.name !== '') {
      slug = st.name;
      derived = true;
    }
  }
  // The blocks are part of the head, which is never cut: when they alone fill the budget,
  // one line says so in place of the index.
  if (blocks.length > 0 && opts.maxChars > 0 && size(head) > opts.maxChars) {
    return { outcome: 'index', text: [...head, USER_INSTRUCTIONS.noRoom(opts.maxChars)].join('\n') + '\n', err: '' };
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
