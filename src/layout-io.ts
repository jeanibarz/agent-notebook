/**
 * The reads and writes of the two small files nb keeps in `~/.agent-notebook/projects/`
 * (issue #560, FR-PLACE-005): `.layout`, the answer to "where should notes be kept?",
 * and `.seen-<name>`, one per project already settled; and `.first-start`, the one-time
 * claim of the set-up note (FR-SETUP-002), with `prepareSessionStart`, the one entry point
 * `nb brief` calls. The grammar lives in `layout.ts`; this module only touches the disk.
 * Only `cli.ts` imports it, and `place-ops.ts` does not: moving shelves never learns about
 * the answer.
 *
 * Nothing here follows a link or waits on a special file, and nothing here reads or
 * writes outside `projects/`:
 *   - `projects/` is created with mode 0700 and must be a real folder of this user;
 *   - `.layout` is read with `lstat`, then `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`
 *     where the system has those flags, then `fstat` (a regular file, the user's,
 *     at most 64 bytes), so a link, a FIFO or a 10 MB file is `unreadable`, never read;
 *   - `.layout` is written through an exclusive 0600 temporary file in `projects/` and
 *     a rename; a rename refused with `EPERM` or `EACCES` (Windows, a scanner holding
 *     the file) is retried for about one second;
 *   - `.seen-<name>` is an exclusive create (0600), so exactly one process makes it.
 */
import { closeSync, constants as fsConstants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isOwnRealDir, projectShelves } from './place-ops.js';
import {
  FIRST_START_DONE,
  FIRST_START_MAX_BYTES,
  LAYOUT_FILE_MAX_BYTES,
  formatPending,
  layoutDate,
  parseFirstStart,
  parseLayout,
  seenFileName,
  setupDue,
  type FirstStartRead,
  type Layout,
  type LayoutRead,
} from './layout.js';

/** The answer file of a `projects/` folder. */
export const layoutPath = (projectsDir: string): string => join(projectsDir, '.layout');

/**
 * Read `.layout`. No `projects/` of this user, or no file: `none`. Anything that is
 * not one plain word in a small regular file of this user: `unreadable`. Never throws.
 * A `projects/` that is a link or another user's folder is treated as absent: nothing
 * in it is read, and no output of nb changes.
 */
export function readLayout(projectsDir: string, uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null): LayoutRead {
  if (!isOwnRealDir(projectsDir)) return { state: 'none' };
  const file = layoutPath(projectsDir);
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'unreadable', since: null };
  }
  if (!st.isFile()) return { state: 'unreadable', since: null };
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    const since = layoutDate(fst.mtimeMs);
    if (!fst.isFile()) return { state: 'unreadable', since: null };
    if (uid !== null && fst.uid !== uid) return { state: 'unreadable', since };
    if (fst.size > LAYOUT_FILE_MAX_BYTES) return { state: 'unreadable', since };
    const buf = Buffer.alloc(LAYOUT_FILE_MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > LAYOUT_FILE_MAX_BYTES) return { state: 'unreadable', since };
    const value = parseLayout(buf.toString('utf8', 0, n));
    return value === null ? { state: 'unreadable', since } : { state: 'chosen', value, since };
  } catch {
    return { state: 'unreadable', since: null };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/** Make `projects/` (mode 0700) and check it is a real folder of this user. Throws one plain sentence. */
export function ensureProjectsDir(projectsDir: string): void {
  try {
    mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new Error(`could not make the folder ${projectsDir} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  if (!isOwnRealDir(projectsDir)) {
    throw new Error(`${projectsDir} is not a plain folder of yours (a link, a file, or another user's folder), so nb does not write in it.`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The pauses between tries of a refused rename: about one second in all. */
const RENAME_BACKOFF_MS = [0, 20, 40, 80, 160, 320, 400];

/**
 * Record the answer: an exclusive 0600 temporary file in `projects/`, then a rename over
 * `.layout`. Throws one plain sentence when it cannot (read-only home, full disk, a folder
 * named `.layout`); nothing is then changed.
 */
export async function writeLayout(projectsDir: string, value: Layout): Promise<void> {
  ensureProjectsDir(projectsDir);
  sweepStaleTemps(projectsDir);
  const tmp = join(projectsDir, `.layout.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const fail = (e: unknown): Error =>
    new Error(`could not record the choice (${(e as NodeJS.ErrnoException).code ?? 'error'}): ${projectsDir} cannot be written.`);
  let fd: number;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (e) {
    throw fail(e);
  }
  try {
    // No fsync: after a power cut the worst case is an empty file, which reads as `unreadable` and is set again by one command.
    writeSync(fd, `${value}\n`);
  } catch (e) {
    closeSync(fd);
    removeQuietly(tmp);
    throw fail(e);
  }
  closeSync(fd);
  let last: unknown;
  for (const pause of RENAME_BACKOFF_MS) {
    if (pause > 0) await sleep(pause);
    try {
      renameSync(tmp, layoutPath(projectsDir));
      return;
    } catch (e) {
      last = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') break;
    }
  }
  removeQuietly(tmp);
  throw fail(last);
}

/** A temporary file left by a process that died between its create and its rename: removed once it is this old. */
const STALE_TEMP_MS = 5 * 60_000;

function sweepStaleTemps(projectsDir: string): void {
  try {
    for (const n of readdirSync(projectsDir)) {
      if (!/^\.layout\.\d+\.[0-9a-f]{16}\.tmp$/.test(n)) continue;
      const f = join(projectsDir, n);
      const st = lstatSync(f);
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS) removeQuietly(f);
    }
  } catch {
    // best effort
  }
}

function removeQuietly(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // gone or never made
  }
}

/** Whether a name can be used in a file name here: a cleaned project name, never a path. */
const SEEN_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Whether `.seen-<name>` exists (anything with that name counts, a link included). */
export function seenExists(projectsDir: string, name: string): boolean {
  if (!SEEN_NAME.test(name)) return true;
  try {
    lstatSync(join(projectsDir, seenFileName(name)));
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/**
 * Make `.seen-<name>` (exclusive, 0600, an empty file), making `projects/` first.
 * `true` when this call made it. Never throws: a read-only home or a name that is
 * already settled gives `false`.
 */
export function writeSeen(projectsDir: string, name: string): boolean {
  if (!SEEN_NAME.test(name)) return false;
  try {
    ensureProjectsDir(projectsDir);
    closeSync(openSync(join(projectsDir, seenFileName(name)), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600));
    return true;
  } catch {
    return false;
  }
}

/** The claim file of a `projects/` folder. */
export const firstStartPath = (projectsDir: string): string => join(projectsDir, '.first-start');

/** The 16 hex digits of the sha256 of a cleaned session id: what `pending` records, so only that chat confirms it. */
export function sessionHash(cleanedSession: string): string {
  return createHash('sha256').update(cleanedSession).digest('hex').slice(0, 16);
}

/** A small file read as `readLayout` reads `.layout`: no link, no special file, no other owner, at most `max` bytes. */
function readSmall(file: string, max: number): { state: 'none' } | { state: 'bad' } | { state: 'ok'; text: string } {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'bad' };
  }
  if (!st.isFile() || st.size > max) return { state: 'bad' };
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > max) return { state: 'bad' };
    if (typeof process.getuid === 'function' && fst.uid !== process.getuid()) return { state: 'bad' };
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > max) return { state: 'bad' };
    const text = buf.toString('utf8', 0, n);
    return text.includes('\0') ? { state: 'bad' } : { state: 'ok', text };
  } catch {
    return { state: 'bad' };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/**
 * Read `.first-start`. No `projects/`, or no file: `none`. A `projects/` that is a link or
 * another user's, a file that is a link, a folder, a FIFO, too big, with a NUL, or not one
 * of the two sentences: `unreadable`. Never throws.
 */
export function readFirstStart(projectsDir: string): FirstStartRead {
  try {
    lstatSync(projectsDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'none' } : { state: 'unreadable' };
  }
  if (!isOwnRealDir(projectsDir)) return { state: 'unreadable' };
  const r = readSmall(firstStartPath(projectsDir), FIRST_START_MAX_BYTES);
  if (r.state !== 'ok') return r.state === 'none' ? { state: 'none' } : { state: 'unreadable' };
  return parseFirstStart(r.text) ?? { state: 'unreadable' };
}

/**
 * Claim the first start for a chat: make `projects/` (mode 0700), check it and
 * `~/.agent-notebook` are real folders of this user, then create `.first-start` exclusively
 * (0600) holding `pending <now> <hash>`. `takeoverRaw` is the text of an expired `pending`
 * claim the caller saw: it is first renamed aside, and only the process whose rename wins
 * goes on; a file that is not the one seen (a fresh claim made in between) is put back.
 * `true` only for the one process that made the file. Any error: `false` (no note), and a
 * claim that could not be written whole is removed, so the first start is still due.
 */
export function claimFirstStart(projectsDir: string, cleanedSession: string, nowMs: number, takeoverRaw: string | null = null): boolean {
  try {
    // `~/.agent-notebook` that is already there must be a real folder of this user BEFORE anything is made inside it:
    // a link would otherwise receive `projects/`.
    if (exists(dirname(projectsDir)) && !isOwnRealDir(dirname(projectsDir))) return false;
    mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
    if (!isOwnRealDir(dirname(projectsDir)) || !isOwnRealDir(projectsDir)) return false;
    const file = firstStartPath(projectsDir);
    if (takeoverRaw !== null) {
      const aside = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.old`;
      renameSync(file, aside);
      const moved = readSmall(aside, FIRST_START_MAX_BYTES);
      if (moved.state !== 'ok' || moved.text !== takeoverRaw) {
        try {
          linkSync(aside, file);
        } catch {
          // another claim was made meanwhile: it stands
        }
        removeQuietly(aside);
        return false;
      }
      removeQuietly(aside);
    }
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, formatPending(nowMs, sessionHash(cleanedSession)));
    } catch {
      closeSync(fd);
      removeQuietly(file);
      return false;
    }
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm the claim: `pending … <hash of this session>` becomes `done` (an exclusive 0600
 * temporary file and a rename). Another session's claim, `done`, no file, an unreadable
 * file and every error leave the file as it was. Never throws.
 */
export function confirmFirstStart(projectsDir: string, cleanedSession: string): boolean {
  if (cleanedSession === '') return false;
  try {
    const r = readFirstStart(projectsDir);
    if (r.state !== 'pending' || r.hash !== sessionHash(cleanedSession)) return false;
    const tmp = join(projectsDir, `.first-start.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, FIRST_START_DONE);
      closeSync(fd);
      renameSync(tmp, firstStartPath(projectsDir));
      return true;
    } catch {
      removeQuietly(tmp);
    }
  } catch {
    // The question may be asked once more; nothing else is lost.
  }
  return false;
}

/** Which set-up note a call prints, and for which project (`name` is `''` unless the kind is `project`). */
export interface SetupNote {
  kind: 'first' | 'first-no-project' | 'project';
  name: string;
}

/** What `prepareSessionStart` decided. */
export interface SessionStartPlan {
  /** The note to print first, or `null`. Its claim (`.first-start`, or `.seen-<name>` for a project) is already made. */
  note: SetupNote | null;
  /** The index is grouped by the derived project name from the first chat (FR-BRIEF-003). */
  group: boolean;
  /** `.seen-<name>` was made by this call (note B). */
  seenWritten: boolean;
}

/** Everything `prepareSessionStart` needs, as plain values and small functions, so a test can give any of them. */
export interface SessionStartDeps {
  welcome: boolean;
  env: NodeJS.ProcessEnv;
  /** `<home>/.agent-notebook/projects`. */
  projectsDir: string;
  /** `<home>/.agent-notebook/messages`. */
  messagesDir: string;
  /** The shared notebook folder (`NB_DIR` is unset whenever this is read). */
  sharedDir: string;
  /** The cleaned session id, `''` when the call has none. */
  session: string;
  nowMs: number;
  /** The kind of `Place` the call resolved: only `shared` can be asked a per-project question. */
  placeKind: 'env' | 'own' | 'shared' | 'unknown';
  /** The project name when it comes from the git remote (the only kind that can have an own folder), else `null`. Asked lazily. */
  projectName: () => string | null;
  /** A project name could be asked here at all (a working folder, and a `.git` entry or `NB_PROJECT_SLUG`). */
  canName: () => boolean;
  switchOn: () => boolean;
  /** Whether the note, as it would be printed, fits `--max-chars`. */
  fits: (note: SetupNote) => boolean;
}

const blank = (v: string | undefined): boolean => v === undefined || v.trim() === '';

function hasNonDotEntry(dir: string, test: (name: string) => boolean = () => true): boolean {
  try {
    return readdirSync(dir).some((n) => !n.startsWith('.') && test(n));
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one entry point of the set-up note (issue #560, FR-SETUP-001..003), called by `nb brief`
 * only: decide, claim, and say what to print. Note A or A' when the first start is due
 * (`setupDue`) and its claim is made; else note B when the answer is `ask`, the project is
 * new, named from the git remote, holds no shelf in the shared notebook, and `.seen-<name>`
 * is made. Both need `--welcome`. Also says whether the index is grouped by project from the
 * first chat. With `NB_DIR` set nothing is read and nothing is written. Never throws.
 */
export function prepareSessionStart(d: SessionStartDeps): SessionStartPlan {
  const none: SessionStartPlan = { note: null, group: false, seenWritten: false };
  try {
    if (!blank(d.env.NB_DIR)) return none;
    const layout = readLayout(d.projectsDir);
    const first = readFirstStart(d.projectsDir);
    const group = layout.state !== 'none' || first.state !== 'none';
    const noteKind = (): SetupNote => {
      const name = d.projectName();
      return name === null ? { kind: 'first-no-project', name: '' } : { kind: 'first', name };
    };
    let kind: SetupNote | null = null;
    const memo = (): SetupNote => (kind ??= noteKind());
    if (d.welcome) {
      const verdict = setupDue({
        welcome: true,
        envSet: () => !blank(d.env.NB_DIR) || !blank(d.env.NB_PROJECT_SLUG),
        projectsUsed: () => hasNonDotEntry(d.projectsDir),
        messagesPresent: () => exists(d.messagesDir),
        notebooksUsed: () =>
          hasNonDotEntry(d.sharedDir, (n) => n.endsWith('.md')) || exists(join(d.sharedDir, '.git')) || exists(join(d.sharedDir, '.nb.json')),
        firstStart: () => first,
        nowMs: d.nowMs,
        switchOn: d.switchOn,
        placeKnown: () => d.placeKind !== 'unknown',
        sessionLength: () => d.session.length,
        fits: () => d.fits(memo()),
      });
      if (verdict.due && claimFirstStart(d.projectsDir, d.session, d.nowMs, verdict.takeover ? verdict.raw : null)) {
        return { note: memo(), group: d.canName(), seenWritten: false };
      }
      // Note B: only where the answer is `ask` and the project is new to the shared notebook.
      if (layout.state === 'chosen' && layout.value === 'ask' && d.placeKind === 'shared' && d.switchOn()) {
        const name = d.projectName();
        if (name !== null && !seenExists(d.projectsDir, name) && projectShelves(d.sharedDir, name).length === 0) {
          const note: SetupNote = { kind: 'project', name };
          if (d.fits(note) && writeSeen(d.projectsDir, name)) return { note, group: d.canName(), seenWritten: true };
        }
      }
    }
    return { note: null, group: group && d.canName(), seenWritten: false };
  } catch {
    return none;
  }
}
