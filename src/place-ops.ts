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
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, readShelf, releaseLock, staleLockMs, type LockHandle } from './notebook.js';

/** Test-only hooks, called synchronously inside the locked section (issue #551). Never set outside tests. */
export interface PlaceHooks {
  /** Both locks are held, before anything is read or decided. */
  onLocked?: () => void;
  /** Just before the shelves are linked. */
  beforeLink?: () => void;
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
async function withPlaceLocks<T>(shared: string, own: string, cmd: 'own' | 'shared', fn: (l: PlaceLocks) => T): Promise<T> {
  const start = performance.now();
  const sharedLock = await acquireLock(shared);
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
}

/** The name a shelf of a project's own folder takes in the shared notebook: `<x>@<project>` (kept when it already ends so). */
export function sharedName(shelf: string, project: string): string {
  return shelf.toLowerCase().endsWith(`@${project}`) ? shelf : `${shelf}@${project}`;
}

/** The shelves of a folder whose name ends in `@<project>` (in any letter case, as the write guard reads it), regular files only. */
function projectShelves(dir: string, project: string): string[] {
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

/** Remove `projects/.new-<project>-<pid>` folders whose process is gone: their links are copies, the shared files were never unlinked. */
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
    removeFlat(join(projectsDir, n));
  }
}

/** Remove a folder holding only files (never recursing into a subfolder); best effort. */
function removeFlat(dir: string): void {
  try {
    for (const n of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, n));
      } catch {
        // a subfolder or gone: rmdir below then fails and leaves it, which is safe
      }
    }
    rmdirSync(dir);
  } catch {
    // left in place; `nb place own` tries again next time
  }
}

/** Link each shelf of `from` into `to`; return the inodes linked and the ones kept. Exported for its test. */
export function linkAll(
  from: string,
  to: string,
  shelves: string[],
  kept: PlaceMove['kept'],
  rename: (shelf: string) => string = (x) => x,
): Map<string, Stats> {
  const linked = new Map<string, Stats>();
  for (const s of shelves) {
    const src = join(from, `${s}.md`);
    const dst = join(to, `${rename(s)}.md`);
    let st: Stats;
    try {
      st = lstatSync(src);
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
      let there: Stats | null = null;
      try {
        there = lstatSync(dst);
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
  linked: Map<string, Stats>,
  kept: PlaceMove['kept'],
  destOf?: (shelf: string) => string,
): string[] {
  const moved: string[] = [];
  for (const [s, st] of linked) {
    const src = join(from, `${s}.md`);
    // The destination must still be the file that was linked: a writer that renamed
    // its own file over it (one that bypasses the guard) keeps the source in place.
    if (destOf !== undefined) {
      let there: Stats | null = null;
      try {
        there = lstatSync(destOf(s));
      } catch {
        // gone: keep the source
      }
      if (there === null || there.ino !== st.ino || there.dev !== st.dev) {
        kept.push({ shelf: s, why: 'it changed during the move; run the command again' });
        continue;
      }
    }
    try {
      const now = lstatSync(src);
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
export async function placeOwn(shared: string, projectsDir: string, project: string, hooks: PlaceHooks = {}): Promise<PlaceMove> {
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
    hooks.onLocked?.();
    const kept: PlaceMove['kept'] = [];
    const created = l.own === null;
    if (created && present(target)) {
      throw new Error(`projects/${project} exists but is not a folder nb can use (a link, or another user's); nothing changed.`);
    }
    const into = created ? join(projectsDir, `.new-${project}-${process.pid}`) : target;
    if (created) mkdirSync(into, { mode: 0o700 });
    const shelves = projectShelves(shared, project);
    const lessons = new Map(shelves.map((s) => [s, lessonsIn(shared, s)]));
    let linked: Map<string, Stats>;
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
  });
}

/**
 * `unlinkSame`, unless a lock was taken over since the link (a stalled run): then
 * every source stays where it is, reported; a re-run finishes the move, since a
 * copy that is the same file counts as linked.
 */
function unlinkUnlessTakenOver(
  l: PlaceLocks,
  from: string,
  linked: Map<string, Stats>,
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
    /^\.nb-usage\.log\.\d+\.tmp$/.test(name) ||
    /^\.retro-/.test(name) ||
    /^.+\.md\.\d+\.tmp$/.test(name)
  );
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
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
  /** Set when the folder was already gone once the locks were held; nothing to move. */
  gone?: true;
};

/**
 * `nb place shared`: move every shelf of `projects/<project>/` back into the
 * shared notebook and remove the folder. Runs under both locks (issue #551): the
 * check of what stops it is made there, before anything moves, so a refusal always
 * means nothing changed. Returns `removed: false` when a write re-created a file in
 * the folder meanwhile, so the folder stays.
 */
export async function placeShared(shared: string, own: string, project: string, hooks: PlaceHooks = {}): Promise<PlaceSharedResult> {
  mkdirSync(shared, { recursive: true });
  const r = await withPlaceLocks(shared, own, 'shared', (l): Omit<PlaceSharedResult, 'removed'> => {
    const none = { dir: shared, created: false, moved: [], kept: [], renamed: [], lessons: 0 };
    if (l.own === null) return { ...none, gone: true };
    hooks.onLocked?.();
    const blocked = sharedBlockers(shared, own, project);
    if (blocked.foreign.length > 0 || blocked.clashes.length > 0) return { ...none, blocked };
    const kept: PlaceMove['kept'] = [];
    const shelves = allShelves(own);
    const lessons = new Map(shelves.map((s) => [s, lessonsIn(own, s)]));
    // Every shelf lands as `<x>@<project>`, so the write guard keeps every other call
    // off it in the shared notebook until the folder is gone, and a shelf written in
    // the project does not merge into a general shelf of the same name.
    hooks.beforeLink?.();
    const linked = linkAll(own, shared, shelves, kept, (x) => sharedName(x, project));
    const moved = unlinkUnlessTakenOver(l, own, linked, kept, (x) => join(shared, `${sharedName(x, project)}.md`));
    for (const n of readdirSync(own)) {
      if (isNbOwnFile(n)) {
        try {
          unlinkSync(join(own, n));
        } catch {
          // gone already
        }
      }
    }
    const renamed = moved.filter((x) => sharedName(x, project) !== x).map((x) => ({ from: x, to: sharedName(x, project) }));
    return { dir: shared, created: false, moved, kept, renamed, lessons: moved.reduce((n, s) => n + (lessons.get(s) ?? 0), 0) };
  });
  let removed = false;
  if (r.blocked === undefined && r.gone === undefined && r.kept.length === 0) {
    try {
      rmdirSync(own);
      removed = true;
    } catch {
      // a write landed meanwhile: the folder stays, and the caller says so
    }
  }
  return { ...r, removed };
}

/** Whether a folder is a git repository (a `.git` entry), for the "unversioned" warning. */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}
