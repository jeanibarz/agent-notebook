/**
 * `nb place own` and `nb place shared` (issue #548, FR-PLACE-003): move a
 * project's shelves between the shared notebook and its own folder
 * `~/.agent-notebook/projects/<project>/`.
 *
 * Whole shelf files move, by a hard link and then an unlink, so every byte,
 * score, order and id is kept (DP-4) and no lesson is deduplicated or evicted on
 * the way. A link never overwrites. A source is unlinked only when it is still
 * the file that was linked (same inode), so a write that replaced it meanwhile
 * (a stolen lock) keeps its lesson in place, reported. The caller has already
 * refused the cases nb cannot or must not act on (see `placeRefusal`).
 *
 * `own` holds the shared notebook's lock: it links the shelves into a staging
 * folder, renames that folder to `projects/<project>` (from that moment the
 * project resolves to it), then unlinks the shared copies. Any failure before
 * the rename removes the staging folder: nothing changed. Run again, it moves
 * what is left (shelves written to the shared notebook by calls that resolved
 * before the rename) and removes staging folders of dead processes.
 *
 * `shared` holds the project folder's lock: it links the shelves back, each as
 * `<x>@<project>` (a name already in the shared notebook was refused before),
 * unlinks them, removes
 * nb's own files, and then, the lock released, removes the folder without
 * recursing. A file it does not know (`.git`, `.nb.json`) was refused before.
 */
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, type BigIntStats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { acquireLock, readShelf, releaseLock, staleLockMs, type LockHandle } from './notebook.js';

/** Test-only hooks, called synchronously inside the locked section (issue #551). Never set outside tests. */
export interface PlaceHooks {
  /** Both locks are held, before anything is read or decided. */
  onLocked?: () => void;
  /**
   * Both locks are held, before anything else (even when the project has no folder). A caller that must record a
   * decision no later start may miss (the `.seen` marker of `nb place`, issue #560) does it here. Not test-only.
   */
  whenLocked?: () => void;
  /** Just before the shelves are linked. */
  beforeLink?: () => void;
  /** `nb place shared`'s rename of the folder away (a test can make it fail as Windows may). */
  rename?: (from: string, to: string) => void;
}

/** Whether `p` is a real directory (not a link), owned by this user on POSIX. */
export function isOwnRealDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    if (!st.isDirectory()) return false;
    return typeof process.getuid !== 'function' || st.uid === process.getuid();
  } catch {
    return false;
  }
}

/** The locks of one place command: the shared notebook's, and the project folder's when it exists. */
interface PlaceLocks {
  shared: LockHandle;
  own: LockHandle | null;
}

/**
 * The lock-order rule (issue #551, FR-LOCK-001): only `nb place own` and `nb place
 * shared` hold two locks, and always the shared notebook's first, then the project
 * folder's. Every other mutation takes one lock, so no process waits for a lock
 * while holding one except here, and both commands use this one order: no cycle.
 * Shared first because a folder that may not exist cannot be locked without creating
 * it; under the shared lock, whether `projects/<p>` exists is stable against every
 * nb CLI call, since only these two commands create or remove it, holding that lock.
 *
 * The folder's lock is waited for at most half the stale threshold from the
 * shared acquire, so the shared lock (never refreshed) cannot age into a steal
 * while we wait; then the command refuses with nothing changed. `fn` runs with both
 * locks held; they are released in reverse order.
 */
async function withPlaceLocks<T>(
  shared: string,
  own: string,
  cmd: 'own' | 'shared',
  fn: (l: PlaceLocks) => T,
  /** Called first thing, both locks held. */
  whenLocked?: () => void,
  /** Give up on the shared notebook's lock after this long (a start-of-session hook must not wait). */
  waitMs?: number,
): Promise<T> {
  const sharedLock = await acquireLock(
    shared,
    waitMs === undefined ? {} : { deadline: performance.now() + waitMs, busy: () => new Error('the shared notebook is in use by another nb call') },
  );
  // Counted from taking the first lock: that lock's age is what must stay under the threshold.
  const start = performance.now();
  let ownLock: LockHandle | null = null;
  try {
    if (isOwnRealDir(own)) {
      ownLock = await acquireLock(own, {
        noCreate: true,
        deadline: start + staleLockMs() / 2,
        busy: () =>
          new Error(
            `another assistant session (or nb command) is using this project's notebook (${own}), or one stopped mid-write; nothing changed. ` +
              `Run \`nb place ${cmd}\` again in about ${Math.max(1, Math.ceil(staleLockMs() / 1000))} seconds.`,
          ),
      });
    }
    const l = { shared: sharedLock, own: ownLock };
    assertHeld(l, cmd);
    whenLocked?.();
    return fn(l);
  } finally {
    if (ownLock !== null) releaseLock(ownLock);
    releaseLock(sharedLock);
  }
}

/** Refuse (nothing changed yet) when a lock no longer carries our token: a stalled run's lock was taken over. */
function assertHeld(l: PlaceLocks, cmd: 'own' | 'shared'): void {
  if (!stillHeld(l)) {
    throw new Error(`a lock of this move was taken over while nb waited (a stalled run); nothing changed. Run \`nb place ${cmd}\` again.`);
  }
}

function stillHeld(l: PlaceLocks): boolean {
  return l.shared.holds() && (l.own === null || l.own.holds());
}

/** What a move did. `moved` and `kept` are shelf names; `lessons` counts the moved lessons. */
export interface PlaceMove {
  dir: string;
  created: boolean;
  moved: string[];
  kept: { shelf: string; why: string }[];
  lessons: number;
  /** Set by `placeOwn(..., { onlyIfNoShelves })` when it made nothing because the shared notebook holds shelves of the project. */
  skipped?: true;
}

/** Options of `placeOwn` for callers that must never move a lesson (the answer applied at the start of a chat, `nb place default own`). */
export interface PlaceOwnOptions {
  /** Under the lock, make nothing and move nothing when the shared notebook holds a shelf `*@<project>`: the result is `skipped`. */
  onlyIfNoShelves?: boolean;
  /** Give up, throwing, when the shared notebook's lock is not free after this many milliseconds. */
  waitMs?: number;
  /** Asked once the locks are held; `false` makes nothing and moves nothing (the result is `skipped`). The caller's own re-check of what it decided before the lock. */
  precondition?: () => boolean;
}

/** The name a shelf of a project's own folder takes in the shared notebook: `<x>@<project>` (kept when it already ends so). */
export function sharedName(shelf: string, project: string): string {
  return shelf.toLowerCase().endsWith(`@${project}`) ? shelf : `${shelf}@${project}`;
}

/** The shelves of a folder whose name ends in `@<project>` (in any letter case, as the write guard reads it), regular files only. */
export function projectShelves(dir: string, project: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const suffix = `@${project}.md`;
  return names
    .filter((n) => n.toLowerCase().endsWith(suffix) && !n.startsWith('.') && isFile(join(dir, n)))
    .map((n) => n.slice(0, -3))
    .sort();
}

function isFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every regular `*.md` shelf of a folder, as shelf names. */
export function allShelves(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('.') && isFile(join(dir, n))).map((n) => n.slice(0, -3)).sort();
}

/** The number of lessons in a shelf file. */
function lessonsIn(dir: string, shelf: string): number {
  try {
    return readShelf(dir, shelf).entries.length;
  } catch {
    return 0;
  }
}

/** Whether a process id is alive (a staging folder of a dead process is left over). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove `projects/.new-<project>-<pid>` folders whose process is gone: their links
 * are copies, the shared files were never unlinked. Only a real folder of this user
 * is touched (a link is never followed), and only regular files in it are removed.
 */
function sweepStaging(projectsDir: string, project: string): void {
  let names: string[];
  try {
    names = readdirSync(projectsDir);
  } catch {
    return;
  }
  const prefix = `.new-${project}-`;
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const pid = Number(n.slice(prefix.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    const dir = join(projectsDir, n);
    if (isOwnRealDir(dir)) removeFlat(dir);
  }
}

/** Remove a folder holding only regular files (never following a link, never recursing); best effort. */
function removeFlat(dir: string): void {
  try {
    for (const n of readdirSync(dir)) {
      if (isFile(join(dir, n))) {
        try {
          unlinkSync(join(dir, n));
        } catch {
          // gone, or held open: rmdir below then fails and leaves it, which is safe
        }
      }
    }
    rmdirSync(dir);
  } catch {
    // left in place; `nb place own` tries again next time
  }
}

/** The name `nb place shared` gives the project folder while it empties it: `.old-<project>-<pid>-<16 hex>`. */
function oldName(project: string): string {
  return `.old-${project}-${process.pid}-${randomBytes(8).toString('hex')}`;
}

/** A folder `nb place shared` renamed away and has not finished: its path, its process, and whether it still holds shelves. */
export interface Unfinished {
  dir: string;
  pid: number;
  shelves: string[];
  inProgress: boolean;
}

/**
 * The `.old-<project>-…` folders of `projects/` (real folders of this user, by the
 * exact name rule). One is in progress while its process is alive and its lock is
 * fresh; otherwise its move stopped (a crash, a kill) and `nb place shared` finishes it.
 */
export function unfinishedMoves(projectsDir: string, project: string): Unfinished[] {
  let names: string[];
  try {
    names = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out: Unfinished[] = [];
  const prefix = `.old-${project}-`;
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const m = /^(\d+)-[0-9a-f]{16}$/.exec(n.slice(prefix.length));
    if (m === null) continue;
    const dir = join(projectsDir, n);
    if (!isOwnRealDir(dir)) continue;
    const pid = Number(m[1]);
    out.push({ dir, pid, shelves: allShelves(dir), inProgress: alive(pid) && freshLock(dir) });
  }
  return out.sort((x, y) => x.dir.localeCompare(y.dir));
}

/** Whether `dir` holds a lock (a real folder) younger than the stale threshold. */
function freshLock(dir: string): boolean {
  try {
    const st = lstatSync(join(dir, '.nb.lock'));
    return st.isDirectory() && Date.now() - st.mtimeMs <= staleLockMs();
  } catch {
    return false;
  }
}

/** Remove a dead holder's `.nb.lock` from a renamed-away folder: its `owner` and `reap`, never through a link. */
function removeDeadLock(dir: string): void {
  const lock = join(dir, '.nb.lock');
  try {
    if (!lstatSync(lock).isDirectory()) return;
  } catch {
    return;
  }
  if (isFile(join(lock, 'owner'))) {
    try {
      unlinkSync(join(lock, 'owner'));
    } catch {
      // gone
    }
  }
  try {
    if (lstatSync(join(lock, 'reap')).isDirectory()) rmdirSync(join(lock, 'reap'));
  } catch {
    // none
  }
  try {
    rmdirSync(lock);
  } catch {
    // not empty or gone: the folder then stays
  }
}

/** Remove nb's own files (regular files only) from a folder; never a shelf. */
function removeNbOwnFiles(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (isNbOwnFile(n) && isFile(join(dir, n))) {
      try {
        unlinkSync(join(dir, n));
      } catch {
        // gone already
      }
    }
  }
}

/** `rmdir` a renamed-away folder once it holds no shelf; `true` when it is gone. */
function finishOld(dir: string): boolean {
  if (!present(dir)) return true; // another place command finished it first
  if (allShelves(dir).length > 0) return false;
  removeNbOwnFiles(dir);
  removeDeadLock(dir);
  try {
    rmdirSync(dir);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Link each shelf of `from` into `to`; return the inodes linked and the ones kept. Exported for its test.
 * Inodes are compared as bigints: on Windows a 64-bit NTFS file id can exceed 2^53, and as a
 * number two different files could compare equal (issue #551).
 */
export function linkAll(
  from: string,
  to: string,
  shelves: string[],
  kept: PlaceMove['kept'],
  rename: (shelf: string) => string = (x) => x,
  linked: Map<string, BigIntStats> = new Map(),
): Map<string, BigIntStats> {
  // `linked` may be the caller's: if a link throws, it still holds the links made so far.
  for (const s of shelves) {
    const src = join(from, `${s}.md`);
    const dst = join(to, `${rename(s)}.md`);
    let st: BigIntStats;
    try {
      st = lstatSync(src, { bigint: true });
    } catch {
      continue; // removed meanwhile: nothing to move
    }
    try {
      linkSync(src, dst);
      linked.set(s, st);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw e;
      // The same file already there: an earlier run linked it and stopped before the
      // unlink (a crash). It counts as linked, so this run finishes the move.
      let there: BigIntStats | null = null;
      try {
        there = lstatSync(dst, { bigint: true });
      } catch {
        // gone again: keep the source
      }
      if (there !== null && there.ino === st.ino && there.dev === st.dev) linked.set(s, st);
      else kept.push({ shelf: s, why: 'a shelf of that name is already there' });
    }
  }
  return linked;
}

/** Unlink each linked source that is still the file that was linked; return the shelves moved. Exported for its test. */
export function unlinkSame(
  from: string,
  linked: Map<string, BigIntStats>,
  kept: PlaceMove['kept'],
  destOf?: (shelf: string) => string,
): string[] {
  const moved: string[] = [];
  for (const [s, st] of linked) {
    const src = join(from, `${s}.md`);
    // The destination must still be the file that was linked: a writer that renamed
    // its own file over it (one that bypasses the guard) keeps the source in place.
    if (destOf !== undefined) {
      let there: BigIntStats | null = null;
      try {
        there = lstatSync(destOf(s), { bigint: true });
      } catch {
        // gone: keep the source
      }
      if (there === null || there.ino !== st.ino || there.dev !== st.dev) {
        kept.push({ shelf: s, why: 'it changed during the move; run the command again' });
        continue;
      }
    }
    try {
      const now = lstatSync(src, { bigint: true });
      if (now.ino !== st.ino || now.dev !== st.dev) {
        kept.push({ shelf: s, why: 'it changed during the move; run the command again' });
        continue;
      }
      unlinkSync(src);
      moved.push(s);
    } catch (e) {
      // Only "already gone" means the linked copy is the shelf; any other error (a
      // file held open on Windows) leaves the source in place, and says so.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') moved.push(s);
      else kept.push({ shelf: s, why: `it could not be removed from its old place (${(e as NodeJS.ErrnoException).code ?? 'error'}); run the command again` });
    }
  }
  return moved;
}

/** Whether anything (a file, a folder, a link) has the name `p`. */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * `nb place own`: move the shared notebook's `*@<project>` shelves into
 * `projects/<project>/`, creating it (mode 0700) when it does not exist. Everything
 * is decided under the shared notebook's lock (issue #551): whether the folder
 * exists, and so which further lock is needed.
 */
export async function placeOwn(shared: string, projectsDir: string, project: string, hooks: PlaceHooks = {}, opts: PlaceOwnOptions = {}): Promise<PlaceMove> {
  const target = join(projectsDir, project);
  mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  mkdirSync(shared, { recursive: true });
  // A new folder is filled while it is still a staging folder, then renamed into
  // place. An existing folder is filled holding its own lock as well, since its
  // project's calls write it; the shared copies of its shelves are frozen meanwhile,
  // because the write guard refuses `<x>@<project>` in the shared notebook while the
  // folder exists (FR-PLACE-001).
  return withPlaceLocks(shared, target, 'own', (l) => {
    sweepStaging(projectsDir, project);
    for (const u of unfinishedMoves(projectsDir, project)) {
      if (!u.inProgress && u.shelves.length === 0) finishOld(u.dir);
      else {
        throw new Error(
          `an earlier \`nb place shared\` of this project did not finish (${u.dir}); nothing changed. Run \`nb place shared\` to finish it first.`,
        );
      }
    }
    hooks.onLocked?.();
    const kept: PlaceMove['kept'] = [];
    const created = l.own === null;
    if (opts.precondition !== undefined && !opts.precondition()) {
      return { dir: target, created: false, moved: [], kept, lessons: 0, skipped: true };
    }
    // Decided under the lock, so a shelf written between a caller's look and this point is still seen.
    if (opts.onlyIfNoShelves === true && projectShelves(shared, project).length > 0) {
      return { dir: target, created: false, moved: [], kept, lessons: 0, skipped: true };
    }
    if (created && present(target)) {
      throw new Error(`projects/${project} exists but is not a folder nb can use (a link, or another user's); nothing changed.`);
    }
    const into = created ? join(projectsDir, `.new-${project}-${process.pid}`) : target;
    if (created) mkdirSync(into, { mode: 0o700 });
    const shelves = projectShelves(shared, project);
    const lessons = new Map(shelves.map((s) => [s, lessonsIn(shared, s)]));
    let linked: Map<string, BigIntStats>;
    try {
      hooks.beforeLink?.();
      linked = linkAll(shared, into, shelves, kept);
      if (created) {
        if (present(target)) throw new Error(`projects/${project} appeared while nb place own ran; nothing changed. Run it again.`);
        renameSync(into, target);
      }
    } catch (e) {
      if (created) removeFlat(into);
      throw e;
    }
    const moved = unlinkUnlessTakenOver(l, shared, linked, kept, (x) => join(target, `${x}.md`));
    return { dir: target, created, moved, kept, lessons: moved.reduce((n, s) => n + (lessons.get(s) ?? 0), 0) };
  }, hooks.whenLocked, opts.waitMs);
}

/**
 * `unlinkSame`, unless a lock was taken over since the link (a stalled run): then
 * every source stays where it is, reported; a re-run finishes the move, since a
 * copy that is the same file counts as linked.
 */
function unlinkUnlessTakenOver(
  l: PlaceLocks,
  from: string,
  linked: Map<string, BigIntStats>,
  kept: PlaceMove['kept'],
  destOf: (shelf: string) => string,
): string[] {
  if (!stillHeld(l)) {
    for (const s of linked.keys()) kept.push({ shelf: s, why: 'a lock of this move was taken over (a stalled run); run the command again' });
    return [];
  }
  return unlinkSame(from, linked, kept, destOf);
}

/** nb's own files in a notebooks folder, removed by `nb place shared`: never lessons. */
export function isNbOwnFile(name: string): boolean {
  return (
    name === '.nb-usage.log' ||
    name === '.nb-usage.log.count' ||
    name === '.nb-usage.log.1' || // the ring's older generation (issue #576)
    /^\.nb-usage\.log\.\d+\.tmp$/.test(name) ||
    /^\.retro-/.test(name) ||
    /^.+\.md\.\d+\.tmp$/.test(name)
  );
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = lstatSync(a, { bigint: true });
    const y = lstatSync(b, { bigint: true });
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

/**
 * What in a project folder stops `nb place shared`: files that are neither
 * shelves nor nb's own (a `.git`, a `.nb.json`, a subfolder), and shelves whose
 * name the shared notebook already has. Empty lists mean it may go ahead.
 */
export function sharedBlockers(shared: string, own: string, project: string): { foreign: string[]; clashes: string[] } {
  const foreign: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(own);
  } catch {
    // unreadable: the move below reports the error
  }
  for (const n of names) {
    if (n === '.nb.lock') continue; // held by a running call, or stale: `withLock` handles it
    if (isNbOwnFile(n)) continue;
    if (n.endsWith('.md') && !n.startsWith('.') && isFile(join(own, n))) continue;
    foreign.push(n);
  }
  // A clash is a name the shared notebook already has, or two shelves of the folder
  // that would arrive under one name (`review` and `review@<project>`), compared in
  // lower case, as the write guard and a case-insensitive disk compare them.
  // A shared file that is the folder's shelf itself (same inode: a run that stopped
  // between link and unlink) is not a clash; the move counts it as linked.
  const seen = new Map<string, number>();
  const shelves = allShelves(own);
  const names2 = shelves.map((s) => sharedName(s, project));
  for (const n of names2) seen.set(n.toLowerCase(), (seen.get(n.toLowerCase()) ?? 0) + 1);
  const clashes = names2.filter(
    (s, i) => (present(join(shared, `${s}.md`)) && !sameFile(join(shared, `${s}.md`), join(own, `${shelves[i]}.md`))) || (seen.get(s.toLowerCase()) ?? 0) > 1,
  );
  return { foreign: foreign.sort(), clashes };
}

/** What `nb place shared` did: a move, or why it did nothing. */
export type PlaceSharedResult = PlaceMove & {
  removed: boolean;
  renamed: { from: string; to: string }[];
  /** Set when the folder holds something that stops the move; nothing changed. */
  blocked?: { foreign: string[]; clashes: string[] };
  /** Set when the folder was already gone once the locks were held (after finishing any unfinished move). */
  gone?: true;
  /** The renamed-away folder that still holds shelves (or could not be removed): nothing is lost there. */
  left?: string;
  /** Unfinished moves of an earlier run that this run finished. */
  resumed: string[];
};

/** Link every shelf of `from` into the shared notebook as `<x>@<project>`, then unlink each that is still the linked file. */
function moveOut(
  l: PlaceLocks,
  from: string,
  shared: string,
  project: string,
  kept: PlaceMove['kept'],
  hooks: PlaceHooks,
): { moved: string[]; lessons: number } {
  const shelves = allShelves(from);
  const lessons = new Map(shelves.map((s) => [s, lessonsIn(from, s)]));
  const linked = new Map<string, BigIntStats>();
  const dest = (x: string): string => join(shared, `${sharedName(x, project)}.md`);
  try {
    hooks.beforeLink?.();
    linkAll(from, shared, shelves, kept, (x) => sharedName(x, project), linked);
  } catch (e) {
    // A link failed for a reason a re-run would meet again (a name too long, a file
    // system without hard links, another device): take back the links made so far,
    // so every shelf is again only in `from`, and let the caller restore the folder.
    for (const [s, st] of linked) {
      try {
        const there = lstatSync(dest(s), { bigint: true });
        if (there.ino === st.ino && there.dev === st.dev) unlinkSync(dest(s));
      } catch {
        // gone: nothing to take back
      }
    }
    throw e;
  }
  const moved = unlinkUnlessTakenOver(l, from, linked, kept, dest);
  return { moved, lessons: moved.reduce((n, s) => n + (lessons.get(s) ?? 0), 0) };
}

/**
 * Put a renamed-away folder back as `projects/<project>` after its shelves could not
 * be linked (nothing moved), unless that name was taken meanwhile; returns the error
 * the command throws.
 */
function restore(away: string, own: string, ownLock: LockHandle | null, e: unknown): Error {
  const code = (e as NodeJS.ErrnoException).code ?? 'error';
  let back = false;
  if (!present(own)) {
    try {
      renameSync(away, own);
      ownLock?.rebase(own);
      back = true;
    } catch {
      // stays renamed away: the next run tries again
    }
  }
  return new Error(
    back
      ? `could not move the shelves to the shared notebook (${code}); nothing changed, the project keeps its own notebook (${own}). Run \`nb place shared\` again once the cause is fixed.`
      : `could not move the shelves to the shared notebook (${code}); nothing is lost, they are all in ${away}. Do not delete that folder; run \`nb place shared\` again once the cause is fixed.`,
  );
}

/**
 * `nb place shared`: move every shelf of `projects/<project>/` back into the
 * shared notebook and remove the folder (issue #551). Under both locks it first
 * finishes any move an earlier run left unfinished, then decides what stops this
 * one (a refusal means nothing changed), then renames the folder away to
 * `.old-<project>-<pid>-<hex>`: from that moment the project uses the shared
 * notebook and no nb call can write into the folder (a writer waiting on its lock
 * gets ENOENT and refuses). A refused rename (Windows, a file held open) changes
 * nothing. The shelves are then moved out of the renamed folder, which is removed
 * once empty; a shelf that could not move stays there, reported, and the next
 * `nb place shared` finishes it. nb never removes a folder that holds a shelf.
 */
export async function placeShared(shared: string, own: string, project: string, hooks: PlaceHooks = {}): Promise<PlaceSharedResult> {
  const projectsDir = dirname(own);
  mkdirSync(shared, { recursive: true });
  const r = await withPlaceLocks(shared, own, 'shared', (l): PlaceSharedResult => {
    const kept: PlaceMove['kept'] = [];
    const resumed: string[] = [];
    let moved: string[] = [];
    let lessons = 0;
    let left: string | undefined;
    for (const u of unfinishedMoves(projectsDir, project)) {
      if (u.inProgress) {
        throw new Error(`a move of this project is in progress (${u.dir}); nothing changed. Wait a few seconds, then run \`nb place shared\` again.`);
      }
      removeDeadLock(u.dir);
      let m: { moved: string[]; lessons: number };
      try {
        m = moveOut(l, u.dir, shared, project, kept, {});
      } catch (e) {
        throw restore(u.dir, own, null, e);
      }
      moved = moved.concat(m.moved);
      lessons += m.lessons;
      if (finishOld(u.dir)) resumed.push(u.dir);
      else left ??= u.dir;
    }
    const base = { dir: shared, created: false, kept, resumed, lessons, removed: false };
    const renamedOf = (xs: string[]): { from: string; to: string }[] =>
      xs.filter((x) => sharedName(x, project) !== x).map((x) => ({ from: x, to: sharedName(x, project) }));
    if (l.own === null) return { ...base, moved, renamed: renamedOf(moved), gone: true, ...(left === undefined ? {} : { left }) };
    hooks.onLocked?.();
    const blocked = sharedBlockers(shared, own, project);
    if (blocked.foreign.length > 0 || blocked.clashes.length > 0) return { ...base, moved, renamed: renamedOf(moved), blocked };
    assertHeld(l, 'shared');
    const away = join(projectsDir, oldName(project));
    try {
      (hooks.rename ?? renameSync)(own, away);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'error';
      throw new Error(
        `could not move ${own} aside (${code}): something may hold a file open in it. Nothing changed; run \`nb place shared\` again.`,
      );
    }
    l.own.rebase(away);
    const keptBefore = kept.length;
    let m: { moved: string[]; lessons: number };
    try {
      m = moveOut(l, away, shared, project, kept, hooks);
    } catch (e) {
      throw restore(away, own, l.own, e);
    }
    if (stillHeld(l)) removeNbOwnFiles(away);
    moved = moved.concat(m.moved);
    const r = { ...base, moved, renamed: renamedOf(moved), lessons: lessons + m.lessons, away, keptHere: kept.length - keptBefore };
    return { ...r, ...(left === undefined ? {} : { left }) };
  }, hooks.whenLocked);
  // The locks are released (ours inside the renamed folder with them): remove this run's
  // folder if it holds no shelf. A folder of an earlier run that it could not finish stays `left`.
  const { away, keptHere, ...rest } = r as PlaceSharedResult & { away?: string; keptHere?: number };
  if (rest.blocked !== undefined || rest.gone === true || away === undefined) return rest;
  if (keptHere === 0 && finishOld(away)) return { ...rest, removed: rest.left === undefined };
  return { ...rest, left: rest.left ?? away };
}

/** Whether a folder is a git repository (a `.git` entry), for the "unversioned" warning. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}
