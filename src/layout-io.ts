/**
 * The reads and writes of the two small files nb keeps in `~/.agent-notebook/projects/`
 * (issue #560, FR-PLACE-005): `.layout`, the answer to "where should notes be kept?",
 * and `.seen-<name>`, one per project already settled. The grammar lives in `layout.ts`;
 * this module only touches the disk. Only `cli.ts` imports it, and `place-ops.ts`
 * does not: moving shelves never learns about the answer.
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
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isOwnRealDir } from './place-ops.js';
import { LAYOUT_FILE_MAX_BYTES, layoutDate, parseLayout, seenFileName, type Layout, type LayoutRead } from './layout.js';

/** The answer file of a `projects/` folder. */
export const layoutPath = (projectsDir: string): string => join(projectsDir, '.layout');

/**
 * Read `.layout`. No `projects/` of this user, or no file: `none`. Anything that is
 * not one plain word in a small regular file of this user: `unreadable`. Never throws.
 * A `projects/` that is a link or another user's folder is treated as absent: nothing
 * in it is read, and no output of nb changes.
 */
export function readLayout(projectsDir: string): LayoutRead {
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
    if (typeof process.getuid === 'function' && fst.uid !== process.getuid()) return { state: 'unreadable', since };
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
