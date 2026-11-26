/**
 * The user's own message files (issue #539): plain text a person puts in
 * `<home>/.agent-notebook/messages/` to add words to what `nb brief` shows an
 * assistant at the start of a session (and, in a later change, to `nb retro`).
 *
 * The folder sits beside the notebooks, never inside one: a notebooks folder is
 * synced (git wrapper, backup), and text that comes from synced data could be
 * planted by anyone who can push. So this module refuses a messages folder that
 * lies inside the notebooks folder (`NB_DIR`) or under a home folder that is not
 * an absolute path (an empty or relative `HOME` would read files under the working
 * directory, which can be a cloned repository).
 *
 * Rules kept here, with no wording (the words live in `agent-text.ts`):
 *   - which file names count: exactly `brief.txt`, `retro.txt`, `<project>.brief.txt`
 *     and `<project>.retro.txt`, matched on the names `readdir` returns;
 *   - how a file is read: `readCheckedFile`, shared with `readExtraPrompt`;
 *   - how its text is cleaned and capped.
 *
 * It takes the project name (or `null`) and the home folder as plain values, runs
 * no `git`, and never writes: not even the folder.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { escapeDiskName } from './notebook.js';

/** The two kinds of message file. */
export type MessageKind = 'brief' | 'retro';

/** Characters a message file may hold after cleaning, counted in code points (an emoji is one). */
export const MESSAGE_CHAR_CAP: Readonly<Record<MessageKind, number>> = { brief: 1000, retro: 4000 };

/** How many names `ignored` and `otherProjects` keep; the rest are only counted. */
export const MESSAGE_NAMES_SHOWN = 20;

/** The folder, relative to the home folder, as printed to the model and to the user. */
export const MESSAGES_DIR_DISPLAY = '~/.agent-notebook/messages';

/** The messages folder of a home folder. */
export function messagesDirOf(home: string): string {
  return join(home, '.agent-notebook', 'messages');
}

/** Byte cap before decoding: 4 bytes per allowed character, plus room for a byte-order mark, CRLF line ends and blank lines. */
export function messageByteCap(kind: MessageKind): number {
  return 4 * MESSAGE_CHAR_CAP[kind] + 1024;
}

// ---------------------------------------------------------------------------
// The shared file reader
// ---------------------------------------------------------------------------

/** What `readCheckedFile` found. `bytes` has a UTF-8 byte-order mark already dropped. */
export type CheckedRead =
  | { ok: true; bytes: Buffer; mtimeMs: number }
  | {
      ok: false;
      /** The reason, in nb's words; for a failed system call, its error code (or message). */
      why: string;
      /** Set when a system call failed: the error code, or `error`. */
      errno?: string;
      /** A `stat` that found nothing although `lstat` finds a link: the link's target is missing. */
      dangling?: boolean;
    };

export interface CheckedReadOptions {
  /** Refuse a file that starts with a UTF-16 byte-order mark (message files only). */
  refuseUtf16Bom?: boolean;
}

/** Why a file in a messages folder inside the notebooks folder is not used. */
export const INSIDE_NOTEBOOKS_WHY = 'the folder is inside the notebooks folder, which the shipped scripts sync';

/** Said for a file that is not UTF-8: a UTF-16 byte-order mark, or bytes that do not decode. */
export const NOT_UTF8_WHY = 'not UTF-8 (saved as UTF-16 or ANSI?); save it as UTF-8';

/**
 * Read a small text file safely: `stat` before opening (so a FIFO or a device never
 * stalls the call; a link whose target is missing is told apart with `lstat`), a regular
 * file only, an open that cannot block, `fstat` on the descriptor, at most `maxBytes`
 * bytes, no NUL byte, and a UTF-8 byte-order mark dropped. Never throws.
 * The checks, their order and their reasons are those `NB_RETRO_EXTRA_PROMPT` has had
 * since issue #538 (FR-RETRO-002).
 */
export function readCheckedFile(path: string, maxBytes: number, opts: CheckedReadOptions = {}): CheckedRead {
  const tooLarge = `larger than ${maxBytes} bytes`;
  let fd: number | undefined;
  try {
    let st;
    try {
      st = statSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      let dangling = false;
      if (code === 'ENOENT') {
        try {
          lstatSync(path);
          dangling = true;
        } catch {
          // nothing there at all
        }
      }
      return { ok: false, why: code ?? (err as Error).message ?? String(err), errno: code ?? 'error', dangling };
    }
    if (!st.isFile()) return { ok: false, why: 'not a regular file' };
    if (st.size > maxBytes) return { ok: false, why: tooLarge };
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { ok: false, why: 'not a regular file' };
    if (fst.size > maxBytes) return { ok: false, why: tooLarge };
    // Read one byte more than the cap, so a file that grew since `fstat` is still refused.
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > maxBytes) return { ok: false, why: tooLarge };
    let bytes = buf.subarray(0, n);
    if (opts.refuseUtf16Bom && n >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
      return { ok: false, why: NOT_UTF8_WHY };
    }
    if (bytes.includes(0)) return { ok: false, why: 'the file holds NUL bytes; save it as UTF-8 text' };
    if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    return { ok: true, bytes, mtimeMs: fst.mtimeMs };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, why: code ?? (err as Error).message ?? String(err), errno: code ?? 'error' };
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

// ---------------------------------------------------------------------------
// The cleaner
// ---------------------------------------------------------------------------

/**
 * Clean a decoded message: lines split on `\r\n`, `\r` and `\n`; a tab becomes one
 * space; each line goes through the cleaner `nb brief` applies to lesson text
 * (`escapeDiskName`: control characters, line and paragraph separators, bidi overrides,
 * zero-width space and soft hyphen become visible `\uXXXX` escapes); trailing ASCII spaces
 * are trimmed; blank lines at both ends are dropped. Blank lines inside stay.
 */
export function cleanMessage(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((l) => escapeDiskName(l.replace(/\t/g, ' ')).replace(/ +$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The folder and its names
// ---------------------------------------------------------------------------

/** Why the folder is, or is not, read. */
export type MessagesState = 'absent' | 'home-not-absolute' | 'inside-nb-dir' | 'unreadable' | 'present';

export interface MessageListing {
  state: MessagesState;
  /** The real folder (`<home>/.agent-notebook/messages`); only meaningful when the home folder is absolute. */
  dir: string;
  /** Whether the folder exists (any state but `absent` and `home-not-absolute`). */
  exists: boolean;
  /** The error code when `unreadable`, else `''`. */
  code: string;
  /** The notebooks folder the containment check used, when `inside-nb-dir`. */
  nbDir: string;
  /** Every entry name, sorted; empty unless `present` or `inside-nb-dir`. */
  names: string[];
  /** The names of `<project>.<kind>.txt` files, per kind (never the global file). */
  projectFiles: Record<MessageKind, string[]>;
  /** Names that are not a message file name (dot-names are left out), sorted, at most `MESSAGE_NAMES_SHOWN`. */
  ignored: string[];
  /** How many ignored names there are in all. */
  ignoredTotal: number;
}

/** A project part of a message file name: what `cleanProjectName` can produce. */
const PROJECT_PART = '[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?';
const PROJECT_FILE_RE = new RegExp(`^(${PROJECT_PART})\\.(brief|retro)\\.txt$`);

/** `<project>.<kind>.txt` for a project name, or `null` when the name could not be part of a message file name. */
export function projectFileName(project: string, kind: MessageKind): string | null {
  return new RegExp(`^${PROJECT_PART}$`).test(project) && !project.includes('..') ? `${project}.${kind}.txt` : null;
}

/** The nearest existing ancestor's real path, with the missing tail put back (so a path that does not exist yet still compares). */
function realLoose(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const up = dirname(head);
      if (up === head) return abs;
      tail.unshift(basename(head));
      head = up;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}

/**
 * Look at the messages folder of `home`, never reading a file. Order of checks:
 * a home folder that is not absolute (nothing is read); a folder that does not exist
 * (nothing to do); a folder inside `nbDir` after `realpath` (refused: the shipped
 * scripts sync it); a folder that cannot be read. `nbDir` is the shared notebooks folder.
 */
export function listMessages(home: string, nbDir: string): MessageListing {
  const dir = messagesDirOf(home);
  const base: MessageListing = {
    state: 'absent',
    dir,
    exists: false,
    code: '',
    nbDir: '',
    names: [],
    projectFiles: { brief: [], retro: [] },
    ignored: [],
    ignoredTotal: 0,
  };
  if (!isAbsolute(home)) return { ...base, state: 'home-not-absolute' };
  try {
    statSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return base;
    return { ...base, state: 'unreadable', exists: true, code: code ?? 'error' };
  }
  const inside = isInside(realLoose(dir), realLoose(nbDir));
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (err) {
    return { ...base, state: 'unreadable', exists: true, code: (err as NodeJS.ErrnoException).code ?? 'error' };
  }
  const projectFiles: Record<MessageKind, string[]> = { brief: [], retro: [] };
  const ignored: string[] = [];
  let ignoredTotal = 0;
  for (const name of names) {
    if (name === 'brief.txt' || name === 'retro.txt') continue;
    const m = PROJECT_FILE_RE.exec(name);
    if (m !== null && !m[1]!.includes('..')) {
      projectFiles[m[2] as MessageKind].push(name);
    } else if (!name.startsWith('.')) {
      ignoredTotal++;
      if (ignored.length < MESSAGE_NAMES_SHOWN) ignored.push(name);
    }
  }
  const found = { names, projectFiles, ignored, ignoredTotal, exists: true };
  // Inside the notebooks folder the names are listed (so a file that exists can be reported
  // as not used) but no file is ever opened.
  return inside ? { ...base, ...found, state: 'inside-nb-dir', nbDir } : { ...base, ...found, state: 'present' };
}

// ---------------------------------------------------------------------------
// Reading the files
// ---------------------------------------------------------------------------

/** One message file as found. `absent` means no such name (or it vanished before it was opened). */
export type MessageFile =
  | { file: string; status: 'absent' }
  | { file: string; status: 'used'; text: string; chars: number; mtimeMs: number }
  | { file: string; status: 'refused'; reason: string };

export interface MessageSet {
  global: MessageFile;
  /** `null` when no project name selects a file. */
  project: MessageFile | null;
}

function readOne(listing: MessageListing, file: string, kind: MessageKind): MessageFile {
  if (!listing.names.includes(file)) return { file, status: 'absent' };
  const cap = MESSAGE_CHAR_CAP[kind];
  const r = readCheckedFile(join(listing.dir, file), messageByteCap(kind), { refuseUtf16Bom: true });
  if (!r.ok) {
    if (r.errno === 'ENOENT') return r.dangling === true ? { file, status: 'refused', reason: 'a broken link' } : { file, status: 'absent' };
    return { file, status: 'refused', reason: r.errno !== undefined ? `unreadable (${r.errno})` : r.why };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.bytes);
  } catch {
    return { file, status: 'refused', reason: NOT_UTF8_WHY };
  }
  const text = cleanMessage(decoded);
  if (text === '') return { file, status: 'refused', reason: 'empty' };
  const chars = [...text].length;
  if (chars > cap) return { file, status: 'refused', reason: `larger than ${cap} characters` };
  return { file, status: 'used', text, chars, mtimeMs: r.mtimeMs };
}

/**
 * Read the global file and the file of `project` of one kind. `project` is the name
 * that selects a file (already filtered by the caller: from `NB_PROJECT_SLUG` or the
 * git remote, not a Windows device name), or `null`. Only the cleaned name is ever
 * placed in a path, so a slug such as `../x` cannot leave the folder. Nothing is read
 * unless the folder is `present`; inside the notebooks folder an existing file is `refused`
 * unopened, so it is never silent.
 */
export function readMessages(listing: MessageListing, kind: MessageKind, project: string | null): MessageSet {
  const globalFile = `${kind}.txt`;
  if (listing.state !== 'present' && listing.state !== 'inside-nb-dir') return { global: { file: globalFile, status: 'absent' }, project: null };
  const pf = project === null ? null : projectFileName(project, kind);
  const one = (file: string): MessageFile =>
    listing.state === 'inside-nb-dir'
      ? listing.names.includes(file)
        ? { file, status: 'refused', reason: INSIDE_NOTEBOOKS_WHY }
        : { file, status: 'absent' }
      : readOne(listing, file, kind);
  return { global: one(globalFile), project: pf === null ? null : one(pf) };
}

/** The `<project>.<kind>.txt` names of the listing that belong to a project other than `project`, for `nb config`'s "other projects". */
export function otherProjectFiles(listing: MessageListing, project: string | null): string[] {
  const own = project === null ? null : [`${project}.brief.txt`, `${project}.retro.txt`];
  return [...listing.projectFiles.brief, ...listing.projectFiles.retro].filter((n) => own === null || !own.includes(n)).sort();
}
