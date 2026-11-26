/**
 * The per-repository on/off switch for the agent-facing loop (issue #514).
 *
 * agent-notebook reaches an agent through a session-start hook (the index), a
 * stop hook (the retrospective nudge) and a standing instruction (the
 * AGENTS.md/CLAUDE.md contract). A machine-wide install turns that loop on in
 * every repository; this module answers "is it on HERE?" so the hooks can stay
 * quiet in a repository where the user switched it off.
 *
 * Two inputs, highest priority first, and the default:
 *   1. `NB_ENABLED` (environment): `0`, `false`, `no`, `off` (any case) turn the
 *      loop off; any other non-blank value turns it on; unset or blank defers.
 *   2. `git config nb.enabled` (a git boolean), read from the working directory,
 *      so git's own scopes apply: the repository's `.git/config` (shared by all
 *      its worktrees, never committed), `--global`, `includeIf` folders, system.
 *   3. Neither set: on.
 *
 * It fails open: no `git` binary, a git error, or a value git refuses as a
 * boolean (exit 128 on `nb.enabled = maybe`) all resolve to on, with the problem
 * kept in `warning` so `nb enabled --why` and `nb config` can show it.
 *
 * Read-only. It spawns `git config` (in `readGitKey`); the only other module
 * that spawns a process is `loop.ts` (`git rev-parse`, issue #538). Three commands call it: `nb enabled`, `nb config`, and
 * the text form of `nb list`, which prints a "switched off" line in place of the
 * index (slice 2, for setups whose only surface is the instruction). `nb list
 * --json` and every other notebook command never call it.
 */
import { spawnSync } from 'node:child_process';

/** Which input decided the state: the env var, git config, or the built-in default (on). */
export type EnabledSource = 'env' | 'git' | 'default';

/** The resolved on/off state and where it came from. */
export interface EnabledState {
  enabled: boolean;
  source: EnabledSource;
  /** The deciding raw value: the `NB_ENABLED` string, or git's normalised `true`/`false`; `null` for the default. */
  value: string | null;
  /** For `source: 'git'`: the file as `git config --show-origin` reports it, e.g. `file:.git/config`; otherwise `null`. */
  origin: string | null;
  /** Why the git key was ignored (invalid value, git missing or failing), or `null`. The state is then the default, on. */
  warning: string | null;
}

/** The words that turn the loop off, matching the falsy set of `NB_ASCII`. */
const OFF_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse `NB_ENABLED`: `false` for an off word, `true` for any other non-blank
 * value, `undefined` when unset or blank (defer to git config).
 */
export function parseEnabledEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  return !OFF_WORDS.has(v);
}

/** What one `git config` run returned; `error` is set when git could not be started. */
export interface GitRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Run `git config --type=bool --show-origin --get nb.enabled` in `cwd`.
 * `--type=bool` needs git 2.18 and `--show-origin` 2.8; `--show-scope` is
 * deliberately not used, since git before 2.26 rejects it (exit 129) and the
 * switch would then be silently ignored.
 */
export function readGitKey(cwd: string): GitRun {
  const r = spawnSync('git', ['config', '--type=bool', '--show-origin', '--get', 'nb.enabled'], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message) : undefined,
  };
}

/**
 * Resolve whether the agent-facing loop is on for `cwd`. `runGit` is injectable
 * for tests; the CLI uses the real `git`.
 */
export function resolveEnabled(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = safeCwd(),
  runGit: (cwd: string) => GitRun = readGitKey,
): EnabledState {
  const fromEnv = parseEnabledEnv(env.NB_ENABLED);
  if (fromEnv !== undefined) {
    return { enabled: fromEnv, source: 'env', value: env.NB_ENABLED ?? null, origin: null, warning: null };
  }
  const on = (warning: string | null): EnabledState => ({
    enabled: true,
    source: 'default',
    value: null,
    origin: null,
    warning,
  });
  const r = runGit(cwd);
  if (r.error !== undefined) {
    return on(r.error === 'ENOENT' ? 'git not found; only NB_ENABLED applies' : `could not run git (${r.error})`);
  }
  if (r.status === 1) return on(null); // the key is not set in any scope
  const line = r.stdout.trim().split('\n').pop() ?? '';
  const fields = line.split('\t');
  const value = fields[fields.length - 1];
  if (r.status !== 0 || (value !== 'true' && value !== 'false')) {
    const why = r.stderr.trim().split('\n')[0] || `git config exited ${r.status}`;
    return on(`git config nb.enabled ignored: ${why}`);
  }
  return {
    enabled: value === 'true',
    source: 'git',
    value,
    origin: fields.slice(0, -1).join(' ') || null,
    warning: null,
  };
}

/** The working directory, or `.` when it no longer exists (git then fails and the state fails open). */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

/** `on` or `off`. */
export function stateWord(s: EnabledState): 'on' | 'off' {
  return s.enabled ? 'on' : 'off';
}

/**
 * The one-line explanation `nb enabled --why` prints after the state word, and
 * `nb config` prints as the `enabled=` line's tag.
 */
export function describeSource(s: EnabledState): string {
  if (s.source === 'env') return `env NB_ENABLED=${s.value}`;
  if (s.source === 'git') return `git config nb.enabled=${s.value}${s.origin ? `, ${s.origin}` : ''}`;
  if (s.warning !== null) return `default; ${s.warning}`;
  return 'default: neither NB_ENABLED nor git config nb.enabled is set';
}
