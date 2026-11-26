/**
 * The project name (issue #540): which project the working directory belongs
 * to, derived once, here, for every command that needs it.
 *
 * The rules, first match wins:
 *   1. `NB_PROJECT_SLUG`, when non-empty: no git runs at all.
 *   2. `git rev-parse --git-common-dir`. Any failure (git missing, a timeout, any
 *      non-zero exit: not a repository, "dubious ownership", anything else)
 *      gives no name. git's own message is never read nor shown.
 *   3. `git config --get remote.origin.url`: its path, segments joined with `-`
 *      (`git@github.com:acme/app.git` gives `acme-app`). Exit 1 (no `origin`), a
 *      local path, or a URL that fails the safety check falls to rule 4. Any
 *      other exit or a timeout gives no name, so a loaded machine never gives a
 *      different name, only none.
 *   4. The folder of the repository: the parent of the common dir when it is
 *      `.git` or `.bare`, else the common dir's own name minus one `.git` suffix
 *      (a bare clone `app.git`, a submodule's `.git/modules/sub`).
 *   Outside a repository there is no name.
 *
 * Every name is cleaned by `cleanProjectName`, so it is always one path segment
 * of `[a-z0-9._-]`. A URL is never returned or printed, so a token in a remote
 * cannot reach any output.
 *
 * Read-only, never throws. It starts processes only through `git.ts`.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { runGit, type GitRun } from './git.js';

/** Which rule produced the name. `none` means no name (`name` is `''`). */
export type ProjectSource = 'env' | 'remote' | 'folder' | 'none';

export interface ProjectState {
  /** The cleaned name, `''` for `none`. */
  name: string;
  source: ProjectSource;
  /** One sentence written by nb saying why. Never a URL, never git's own words. */
  reason: string;
  /** The name the folder rule gives, when `source` is `remote` and it differs from `name`; `''` otherwise. */
  folderName: string;
}

/** How long each of the (at most two) git runs may take. */
export const PROJECT_GIT_TIMEOUT_MS = 2000;

/** The runner `resolveProject` uses; tests inject a fake. */
export type ProjectGit = (args: readonly string[], cwd: string) => GitRun;

const defaultGit: ProjectGit = (args, cwd) => runGit(args, cwd, PROJECT_GIT_TIMEOUT_MS);

/**
 * Clean a project name as the 0.12 Stop hook did for `{project}`: lower case,
 * `[a-z0-9._-]` only, no `..`, letter or digit at both ends, at most 100
 * characters. `''` when nothing usable is left.
 */
export function cleanProjectName(raw: string): string {
  const trimEnds = (s: string): string => s.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return trimEnds(
    trimEnds(
      String(raw)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '-')
        .replace(/\.{2,}/g, '.'),
    ).slice(0, 100),
  );
}

/**
 * The project name a remote URL gives, cleaned, or `''` when the URL is not an
 * identity (a local path, `file:`) or fails the safety check. The host is left
 * out; every path segment is kept (`group/sub/repo` gives `group-sub-repo`).
 *
 * Fail closed: after the scheme, userinfo, host and port are dropped, the path
 * must be only `[A-Za-z0-9._~/-]` with no `.` or `..` segment. Anything else
 * (`@ : ? # %`, a space, a control character, non-ASCII) gives `''`, so a
 * credential can never become part of the name.
 */
export function ownerRepo(url: string): string {
  const u = String(url).trim();
  if (u === '') return '';
  // Local: an absolute or relative path, a home path, a drive letter, file:.
  if (/^(\/|\.{1,2}([/\\]|$)|~|[A-Za-z]:([/\\]|$)|\\)/.test(u) || /^file:/i.test(u)) return '';
  let path: string;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(u);
  if (scheme) {
    const rest = u.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash < 0) return '';
    path = rest.slice(slash + 1);
  } else {
    // scp form `[user@]host:path`: a colon before any slash, and no scheme.
    const colon = u.indexOf(':');
    const slash = u.indexOf('/');
    if (colon <= 0 || (slash >= 0 && slash < colon)) return '';
    path = u.slice(colon + 1);
  }
  path = path.replace(/\/$/, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9._~/-]+$/.test(path)) return '';
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return '';
  return cleanProjectName(segments.join('-'));
}

/** The folder rule on a resolved common dir. */
function folderOf(commonDir: string): string {
  const b = basename(commonDir);
  if (b === '.git' || b === '.bare') return cleanProjectName(basename(dirname(commonDir)));
  return cleanProjectName(b.replace(/\.git$/i, ''));
}

/** Whether a name from this source groups the start-of-session index: only a name the user set or the remote gives. */
export function groupsIndex(state: ProjectState): boolean {
  return state.source === 'env' || state.source === 'remote';
}

const none = (reason: string): ProjectState => ({ name: '', source: 'none', reason, folderName: '' });

/** Why a failed git run gave no name, in nb's words. */
function failure(r: GitRun): string {
  if (r.error === 'ENOENT') return 'git not found';
  if (r.error === 'ETIMEDOUT') return 'git timed out';
  if (r.error !== undefined) return 'git could not be run';
  return `git failed (exit ${r.status})`;
}

/**
 * The project name of `cwd`. `git` is injectable for tests; the CLI uses the
 * real one with a 2-second timeout per run.
 */
export function resolveProject(env: NodeJS.ProcessEnv, cwd: string, git: ProjectGit = defaultGit): ProjectState {
  const slug = env.NB_PROJECT_SLUG;
  if (slug) {
    const name = cleanProjectName(slug);
    return { name, source: 'env', reason: name === '' ? 'env NB_PROJECT_SLUG has no usable character' : 'env NB_PROJECT_SLUG', folderName: '' };
  }

  const top = git(['rev-parse', '--git-common-dir'], cwd);
  if (top.error !== undefined) return none(failure(top));
  if (top.status !== 0) return none('not in a git repository, or git refused this folder');
  const out = top.stdout.trim();
  if (out === '') return none('git gave no repository folder');
  let folder: string;
  try {
    folder = folderOf(realpathSync(resolve(cwd, out)));
  } catch {
    return none('the repository folder could not be read');
  }

  const remote = git(['config', '--get', 'remote.origin.url'], cwd);
  if (remote.error !== undefined) return none(failure(remote));
  const fromFolder = (reason: string): ProjectState =>
    folder === '' ? none(`${reason}, and the folder name has no usable character`) : { name: folder, source: 'folder', reason, folderName: '' };
  if (remote.status === 1) return fromFolder('folder of the git repository (no origin remote)');
  if (remote.status !== 0) return none(failure(remote));
  // The whole value, never its first line: a URL holding a newline fails the safety check.
  const name = ownerRepo(remote.stdout.replace(/\r?\n$/, ''));
  if (name === '') return fromFolder('folder of the git repository (the origin remote is a local path or not usable as a name)');
  return { name, source: 'remote', reason: 'git remote origin', folderName: folder !== name ? folder : '' };
}

/** The one-line explanation `nb project --why` prints after the name. */
export function describeProject(s: ProjectState): string {
  if (s.name === '') return `(none: ${s.reason})`;
  return `${s.name} (${s.reason})`;
}
