/**
 * The agent-facing loop (issue #538): `nb retro`, the end-of-task retrospective
 * said once per session.
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
 * This module spawns `git` (through `enabled.ts`, and once for the project name
 * of the extra prompt). It never writes stdout: `cli.ts` does.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { RETRO_LESSONS } from './agent-text.js';
import { resolveEnabled, type EnabledState } from './enabled.js';
import { expandHomeDir } from './notebook.js';

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
 * The project name for `{project}`: `NB_PROJECT_SLUG` when set, else the folder
 * that holds the repository's git common directory (one name for a checkout and
 * all its worktrees), asked in `cwd`. `''` when there is no usable name (not a
 * git directory, git missing or slow).
 */
export function projectName(env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.NB_PROJECT_SLUG) return cleanProjectName(env.NB_PROJECT_SLUG);
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = r.error || r.status !== 0 ? '' : (r.stdout || '').trim();
    if (out === '') return '';
    const common = realpathSync(resolve(cwd, out));
    return cleanProjectName(basename(dirname(common)));
  } catch {
    return '';
  }
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
    const project = asked === null ? (env.NB_PROJECT_SLUG ? cleanProjectName(env.NB_PROJECT_SLUG) : '') : projectName(env, asked);
    if (project !== '') {
      const values: Record<string, string> = { project, session };
      text = `${RETRO_LESSONS}\n\n${extra.text.replace(/\{(project|session)\}/g, (_, k: string) => values[k]!)}`;
    }
  }
  return { outcome: 'nudge', text, session, err };
}
