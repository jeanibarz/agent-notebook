/**
 * Where this directory's lessons live (issue #548, FR-PLACE-001): the one rule
 * that picks the notebooks folder for a call.
 *
 * A project has its own notebook when `~/.agent-notebook/projects/<project>/`
 * exists; otherwise it uses the shared notebook (`notebooksDir()`). There is no
 * setting. The rules, first match wins:
 *   1. `NB_DIR` set and not blank: `env`. Nothing under `projects/` is read and
 *      no git runs, so every output is what it was before this module existed.
 *   2. One `readdir` of `projects/`. Missing: `shared`, no process started. Any
 *      other read error: `unknown`.
 *   3. The valid folders: a real directory (not a symlink), owned by the current
 *      user on POSIX, whose name is already a cleaned project name and is not a
 *      Windows device name; dot-entries are skipped. None: `shared`, no git.
 *      This readdir is also the list `nb place` prints, so that list is complete
 *      by construction.
 *   4. The project name (`resolveProject`, issue #540), asked only now:
 *      - from `NB_PROJECT_SLUG` or the git remote, outside a bare repository,
 *        and naming a valid folder: `own`;
 *      - naming an entry that failed step 3 (a symlink, another owner): `unknown`;
 *      - git could not answer (`undetermined`): `unknown`;
 *      - anything else (no repository, git not found, a name from the folder,
 *        another name): `shared`. `sharedWriteRefusal` makes this loud for the
 *        shelves of a project that has its own folder.
 *
 * Read-only, never throws. `notebooksDir()` stays a pure function of the
 * environment: library callers and `nb --help` never reach this module.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { notebooksDir } from './notebook.js';
import { cleanProjectName, resolveProject, type ProjectState } from './project.js';

export type PlaceKind = 'env' | 'own' | 'shared' | 'unknown';

export interface Place {
  kind: PlaceKind;
  /** The folder this call reads and writes; `null` when `unknown`. */
  dir: string | null;
  /** The shared notebook (`notebooksDir()`, which is `NB_DIR` when set). */
  shared: string;
  /** `<home>/.agent-notebook/projects`. */
  projectsDir: string;
  /** The project state when it was asked (only when a valid folder exists), else `null`. */
  project: ProjectState | null;
  /** One sentence written by nb saying why. */
  reason: string;
  /** The valid project folder names, sorted. Empty when `NB_DIR` is set or there are none. */
  folders: string[];
}

/** Injectable file-system and git access, for tests. */
export interface PlaceDeps {
  home?: string;
  project?: (env: NodeJS.ProcessEnv, cwd: string) => ProjectState;
  /** The current user's id, or `null` where there is none (Windows). */
  uid?: number | null;
}

/** The folder holding the project notebooks, for a home folder. */
export function projectsDirOf(home: string = homedir()): string {
  return join(home, '.agent-notebook', 'projects');
}

/**
 * Whether a name is a device on Windows: `con`, `prn`, `aux`, `nul`, `com1`-`com9`,
 * `lpt1`-`lpt9`, alone or before an extension (`nul.txt` is `nul`), in any case.
 * Such a folder cannot be used on Windows, so it is never a project folder on any
 * system (Microsoft, "Naming Files, Paths, and Namespaces").
 */
export function isWindowsDeviceName(name: string): boolean {
  const stem = name.split('.')[0]!.toLowerCase();
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem);
}

/**
 * Why an entry of `projects/` that has a project name is not a project folder, or
 * `null` when it is one. A name nb never produces, or a Windows device name, is
 * not asked here: it can never be a project's name.
 */
function invalidReason(projectsDir: string, name: string, uid: number | null): string | null {
  let st;
  try {
    st = lstatSync(join(projectsDir, name));
  } catch {
    return 'could not be read';
  }
  if (st.isSymbolicLink()) return 'a symbolic link';
  if (!st.isDirectory()) return 'not a folder';
  if (uid !== null && st.uid !== uid) return 'owned by another user';
  return null;
}

/** The current user's id on POSIX, `null` elsewhere. */
function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * The project folders under `projectsDir` (rules 2 and 3), sorted, and the
 * entries that have a project name but fail the check (a symlink, another
 * user's folder), with why. `error` is `'missing'` when there is no such folder,
 * the error code when it cannot be read, `null` otherwise.
 */
export function scanProjects(projectsDir: string, uid: number | null = currentUid()): { folders: string[]; rejected: Map<string, string>; error: string | null } {
  const folders: string[] = [];
  const rejected = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(projectsDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { folders, rejected, error: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : (code ?? 'error') };
  }
  for (const name of names) {
    if (name.startsWith('.') || cleanProjectName(name) !== name || isWindowsDeviceName(name)) continue;
    const why = invalidReason(projectsDir, name, uid);
    if (why === null) folders.push(name);
    // A plain file is never a project folder, and never makes nb ask git (AC2).
    else if (why !== 'not a folder') rejected.set(name, why);
  }
  folders.sort();
  return { folders, rejected, error: null };
}

/**
 * Resolve where a call made in `cwd` (`null` when the working directory no
 * longer exists) reads and writes lessons.
 */
export function resolvePlace(env: NodeJS.ProcessEnv, cwd: string | null, deps: PlaceDeps = {}): Place {
  const shared = notebooksDir();
  const projectsDir = projectsDirOf(deps.home ?? homedir());
  const base = { shared, projectsDir, project: null, folders: [] as string[] };
  if (env.NB_DIR && env.NB_DIR.trim() !== '') {
    return { ...base, kind: 'env', dir: shared, reason: 'NB_DIR is set, so project folders are not used' };
  }
  const scan = scanProjects(projectsDir, deps.uid !== undefined ? deps.uid : currentUid());
  if (scan.error === 'missing') return { ...base, kind: 'shared', dir: shared, reason: 'no project folders' };
  if (scan.error !== null) return { ...base, kind: 'unknown', dir: null, reason: `the folder ${projectsDir} could not be read (${scan.error})` };
  const { folders, rejected } = scan;
  // No folder, and no entry that could be one (a project name that is a symlink, a
  // file, another user's folder): shared, and git is never started (AC2).
  if (folders.length === 0 && rejected.size === 0) return { ...base, kind: 'shared', dir: shared, reason: 'no project folders' };
  const withFolders = { ...base, folders };
  if (cwd === null && !env.NB_PROJECT_SLUG) {
    return { ...withFolders, kind: 'unknown', dir: null, reason: 'the working directory no longer exists' };
  }
  const st = (deps.project ?? resolveProject)(env, cwd ?? '.');
  const at = { ...withFolders, project: st };
  if (st.undetermined) return { ...at, kind: 'unknown', dir: null, reason: st.reason };
  const stable = (st.source === 'env' || st.source === 'remote') && st.name !== '' && !st.bare;
  if (stable && rejected.has(st.name)) {
    return { ...at, kind: 'unknown', dir: null, reason: `projects/${st.name} is ${rejected.get(st.name)}` };
  }
  if (stable && folders.includes(st.name)) {
    return { ...at, kind: 'own', dir: join(projectsDir, st.name), reason: `project ${st.name} (${sourceWords(st)}) has its own notebook` };
  }
  return { ...at, kind: 'shared', dir: shared, reason: sharedReason(st) };
}

function sourceWords(st: ProjectState): string {
  return st.source === 'env' ? 'NB_PROJECT_SLUG' : st.source === 'remote' ? 'git remote origin' : st.reason;
}

function sharedReason(st: ProjectState): string {
  if (st.name === '') return `no project name (${st.reason})`;
  if (st.bare) return `project ${st.name} is a bare repository, which never uses an own notebook`;
  if (st.source === 'folder') return `project ${st.name} is named from its folder, which another copy of it may not share`;
  return `project ${st.name} (${sourceWords(st)}) has no own notebook`;
}

/** The commands whose target shelf the write guard checks, and where that shelf is in the positionals. */
const GUARDED: Record<string, number> = { add: 1, vote: 1, merge: 1, split: 1, describe: 1, move: 2 };

/**
 * The write guard (FR-PLACE-001): the refusal message when this call would write
 * a shelf `<x>@<n>` while `<n>` has its own project folder and the call is not
 * resolved to that folder; `null` when the write may go ahead. `args` are the
 * CLI positionals (`args[0]` is the command). `rm` and the source of `move`
 * are not guarded, so a shelf left in the wrong notebook can be removed or moved.
 */
export function sharedWriteRefusal(place: Place, args: readonly string[]): string | null {
  if (place.kind === 'env' || place.kind === 'unknown' || place.folders.length === 0) return null;
  const cmd = args[0] ?? '';
  const at = GUARDED[cmd];
  if (at === undefined) return null;
  // `describe <shelf>` with no text only reads.
  if (cmd === 'describe' && args.length < 3) return null;
  const shelf = args[at] ?? '';
  const i = shelf.lastIndexOf('@');
  if (i < 0) return null;
  // Lower-cased: nb accepts upper case in shelf names, `nb brief` groups suffixes
  // ignoring case, and on macOS and Windows `x@Acme-App.md` is the file `x@acme-app.md`.
  // Folder names are already lower case (they are cleaned project names).
  const owner = shelf.slice(i + 1).toLowerCase();
  if (!place.folders.includes(owner)) return null;
  if (place.kind === 'own' && place.project?.name === owner) return null;
  const here = place.kind === 'own' ? `the own notebook of ${place.project!.name}` : 'the shared notebook';
  return (
    `${shelf} belongs to the project ${owner}, which has its own notebook (${join(place.projectsDir, owner)}), ` +
    `but this directory uses ${here} (${place.reason}). Nothing was written. ` +
    `Run nb from that project's repository, or see \`nb place\`.`
  );
}

/** The longest project name `nb place own` makes a folder for: with a 128-character shelf it keeps a typical Windows path under 260 characters. */
export const OWN_NAME_MAX = 64;

/**
 * Why `nb place own` or `nb place shared` must not act here, in plain words for a
 * person who may not know git, or `null` when it may (FR-PLACE-003). `st` is the
 * project state (asked by the caller when the place did not need it).
 */
export function placeRefusal(place: Place, st: ProjectState | null, action: 'own' | 'shared'): string | null {
  if (place.kind === 'env') {
    return `NB_DIR is set (${place.dir}), so project folders are not used. To use them, unset NB_DIR, or set NB_DIR for this project only.`;
  }
  if (place.kind === 'unknown') return `could not tell which notebook this project uses (${place.reason}).`;
  if (action === 'shared') return null; // not in an own notebook: nothing to move back, the caller says so
  if (place.kind === 'own') return null; // already own: a re-run sweeps what is left
  if (st === null || st.name === '') {
    return `no project name here (${st?.reason ?? 'the working directory no longer exists'}), so no own notebook can be made. In a git repository with an origin remote the name is found by itself; elsewhere set NB_PROJECT_SLUG for this project only.`;
  }
  if (st.source === 'folder') {
    return `this repository's name ("${st.name}") comes from its folder, which another copy of it may not share. Add an origin remote (it uploads nothing), or set NB_PROJECT_SLUG for this project only.`;
  }
  if (st.bare) return `this is a bare repository; run nb from one of its worktrees.`;
  if (isWindowsDeviceName(st.name)) return `"${st.name}" cannot be a folder name on Windows; set NB_PROJECT_SLUG to another name for this project.`;
  if (st.name.length > OWN_NAME_MAX) {
    return `the project name is ${st.name.length} characters long, over ${OWN_NAME_MAX} (paths would get too long on Windows); set a shorter NB_PROJECT_SLUG for this project.`;
  }
  let names: string[] = [];
  try {
    names = readdirSync(place.projectsDir);
  } catch {
    // no projects/ yet
  }
  const twin = names.find((n) => n !== st.name && n.toLowerCase() === st.name);
  if (twin !== undefined) return `${join(place.projectsDir, JSON.stringify(twin).slice(1, -1))} differs from "${st.name}" only in letter case; rename or remove it first.`;
  if (names.includes(st.name)) {
    return `${join(place.projectsDir, st.name)} exists but is not usable as a project folder (a symbolic link, a file, or another user's folder).`;
  }
  return null;
}

