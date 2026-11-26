/**
 * The one place the core starts a process: `git`, read-only, with a fixed
 * argument list, no shell, and piped output (so git never starts a pager).
 *
 * Two modules ask git something: `enabled.ts` (the per-repository switch,
 * `git config nb.enabled`) and `project.ts` (the project name, issue #540:
 * `git rev-parse --git-common-dir` and `git config --get remote.origin.url`).
 * Both go through `runGit`, so the spawn options are written once. The options
 * are exactly the ones `enabled.ts` used before this module existed, so moving
 * it here changed nothing `nb enabled` prints.
 */
import { spawnSync } from 'node:child_process';

/** What one git run returned; `error` is set when git could not be started or was killed (`ETIMEDOUT`). */
export interface GitRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run `git <args>` in `cwd`, waiting at most `timeoutMs`. Never throws: a
 * missing binary is `error: 'ENOENT'`, a run killed by the timeout is
 * `error: 'ETIMEDOUT'` (or the error code Node reports).
 */
export function runGit(args: readonly string[], cwd: string, timeoutMs: number): GitRun {
  try {
    const r = spawnSync('git', args as string[], {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message) : undefined,
    };
  } catch (e) {
    // spawnSync reports failures in `r.error`; this only guards an unexpected throw
    // (an invalid cwd type, for example), so the callers' "never throws" holds.
    return { status: null, stdout: '', stderr: '', error: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
}
