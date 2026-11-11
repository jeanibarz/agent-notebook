#!/usr/bin/env node
// nb-git-wrapper — run the real `nb` CLI, then record a git commit per change.
//
// WHAT IT ADDS
//   The `agent-notebook` package is deliberately offline and git-unaware: it
//   just edits a plain file. This wrapper layers ONE optional behaviour on top —
//   when your notebooks directory (NB_DIR) is a git repository, each successful
//   *mutating* command (add/vote/merge/rm/split/move/describe) is committed. The
//   result is a reviewable, revertible history of your agent's memory forming
//   over time, and a base the daily backup job (nb-backup.sh) can push.
//
// HOW TO USE IT (pick one)
//   • Put it first on PATH as `nb` (shadowing the global `nb`):
//       mkdir -p ~/.local/bin && cp nb-git-wrapper.mjs ~/.local/bin/nb-git-wrapper.mjs
//       printf '#!/bin/sh\nexec node "$(dirname "$0")/nb-git-wrapper.mjs" "$@"\n' > ~/.local/bin/nb
//       chmod +x ~/.local/bin/nb         # ensure ~/.local/bin precedes npm's bin
//     (Keep the .mjs name: older Node (e.g. 18, 22.5) cannot run an extensionless
//     ES module and stops at its first `import`. The shim works on all.)
//   • Or keep the real `nb` as-is and call this explicitly where you want commits.
//
//   Then make NB_DIR a repo once:  (cd "$(nb path)" && git init)
//   On its first commit the wrapper seeds a default .gitignore (only if one is
//   absent — an existing file is never touched) so the churning usage log, lock,
//   and other transient runtime files stay out of history.
//
// PORTABILITY
//   Pure Node, no shell — works on Linux, macOS, and Windows alike. It resolves
//   whichever `agent-notebook` is installed (global or local), so it tracks the
//   package version you actually run; nothing is vendored or forked.
//
// SAFETY / FAIL-OPEN
//   The lesson is written to disk by the real CLI BEFORE any lock or git call. If
//   git is missing, NB_DIR is not a repo, there is no commit identity, a hook
//   hangs, or the lock can't be taken, the commit is quietly skipped — a git
//   problem never fails an `nb` call or loses a lesson (the daily backup sweeps
//   any straggler). Opt out entirely with NB_GIT_AUTOCOMMIT=0.
//
// CONCURRENCY
//   Under the parallel-subagent workloads this project anticipates, two wrappers
//   race in the git section: with a plain `git add -A`, one stages the other's
//   already-written .md and bundles both under a single, mislabelled commit while
//   the loser finds nothing staged and drops its commit; and two concurrent git
//   invocations collide on `.git/index.lock`. Two independent guards fix this:
//     • autoCommit stages PER CHANGE — everything except `*.md`, then only the
//       shelves THIS command wrote — so a sibling's concurrently-written shelf is
//       never bundled in (see changedShelfPaths).
//     • a tiny per-NB_DIR mkdir lock (withGitLock) serializes the git section so
//       the invocations never collide on index.lock.
//   The lock guards ONLY the git calls — never the CLI write — so the lesson is
//   written first and is never delayed or lost by a git concern.

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, rmdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Commands that write a notebook — only these are worth a commit. Must match the
// package's mutating surface; a read-only command (show/list/search/stats/path)
// never commits.
const MUTATING = new Set(['add', 'vote', 'merge', 'rm', 'split', 'move', 'describe']);

// The transient runtime surface NB_DIR accumulates that must never enter history:
// the churning usage log and its sidecar/temp files (.nb-usage.log*), the lock,
// any *.tmp, retrospective sentinels (.retro-*), and backup logs (.nb-backup.*).
// Kept in sync with the git-versioning recipe in docs/harness-setup.md.
const DEFAULT_GITIGNORE = ['.nb-usage.log*', '.nb.lock', '*.tmp', '.retro-*', '.nb-backup.*'];

// Inherited GIT_* vars pin git to another repo/worktree/index and would override
// our `-C <NB_DIR>`. If `nb` is ever invoked from inside a git hook (e.g. a
// pre-push that runs a tool which calls nb), an unstripped `git -C <NB_DIR> add`
// could commit to the WRONG repo. Strip them so the commit always targets NB_DIR.
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
];

function cleanGitEnv() {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}

/** Expand a leading `~` / `~/…` (and `~\\…` on Windows) exactly like the package's
 *  `expandHomeDir` (issue #334): `NB_DIR` set where no shell expands it (settings.json
 *  `env`, systemd, cron) must not become a literal `~` directory. `~user/…` is left alone. */
function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (process.platform === 'win32' && value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** The notebooks directory the CLI will use — mirrors the package's resolution. */
function notebooksDir() {
  const fromEnv = process.env.NB_DIR;
  return fromEnv && fromEnv.trim() !== '' ? expandHome(fromEnv) : join(homedir(), '.agent-notebook', 'notebooks');
}

/** The global npm package root (`npm root -g`), or null if npm cannot report it. */
function globalNpmRoot() {
  try {
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32', // npm is npm.cmd on Windows
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Resolve the installed `agent-notebook` package's compiled CLI entry. */
function resolveNbCliEntry() {
  const require = createRequire(import.meta.url);
  // The package only publishes its main export (dist/notebook.js); the CLI is its
  // sibling dist/cli.js. Resolve main, then import cli.js by absolute path, which
  // bypasses the package `exports` restriction.
  let main;
  const searched = [`the wrapper's own location (${dirname(fileURLToPath(import.meta.url))})`];
  try {
    main = require.resolve('agent-notebook');
  } catch {
    // A copy in ~/.local/bin cannot see a global install by normal resolution, so
    // fall back to the global npm root (one subprocess, only on this failure path).
    const globalRoot = globalNpmRoot();
    if (globalRoot) {
      searched.push(`the global npm root (${globalRoot})`);
      try {
        main = require.resolve('agent-notebook', { paths: [globalRoot] });
      } catch {
        /* fall through to the not-found error below */
      }
    } else {
      searched.push('the global npm root (`npm root -g` failed)');
    }
  }
  if (!main) throw new Error(`Cannot find module 'agent-notebook'; searched ${searched.join(' and ')}`);
  const entry = join(dirname(main), 'cli.js');
  if (!existsSync(entry)) throw new Error(`agent-notebook CLI not found at ${entry}`);
  return entry;
}

/**
 * Seed a default .gitignore in NB_DIR so the churning usage log and other
 * transient runtime files never enter history. Idempotent and non-destructive:
 * writes only when no .gitignore exists, so a user's own file is never clobbered.
 */
function ensureGitignore(dir) {
  const path = join(dir, '.gitignore');
  if (existsSync(path)) return; // respect any existing ignore file — never overwrite
  writeFileSync(path, DEFAULT_GITIGNORE.join('\n') + '\n');
}

// How long a waiter spins for the lock before failing open and committing without
// serialization (fail-open — the lesson is already safe, written before the lock).
const GIT_LOCK_WAIT_MS = 12_000;
// Reclaim a lock this old: its holder has crashed. Set safely ABOVE the git-only
// critical section this lock guards — at most a few `git` calls, each capped at
// 5s by autoCommit's timeout, so ~20s worst case — so a live holder is never
// stolen. (The CLI write and its nested `.nb.lock` wait are OUTSIDE this lock, so
// they can't stretch the section, whatever NB_STALE_LOCK_MS is set to.)
const GIT_LOCK_STALE_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` while holding a per-NB_DIR lock that serializes the GIT SECTION (never
 * the CLI write) across concurrent wrapper processes, so their `git` invocations
 * cannot collide on `.git/index.lock`.
 *
 * The lock is an empty `.nb-git.lock` DIRECTORY — mkdir is atomic (it succeeds
 * only if the name did not already exist) and git never commits an empty dir, so
 * it needs no .gitignore entry. It is kept distinct from the package's own
 * `.nb.lock`, which it never touches.
 *
 * Crash recovery: a holder that dies leaves the lock behind, so a lock older than
 * the stale threshold is reclaimed. The threshold sits well above the git-only
 * critical section, so a live holder is never stolen mid-commit. The steal is
 * atomic — the lock is renamed aside first, so two waiters can't both delete it
 * and then clobber each other's fresh lock.
 *
 * FAIL-OPEN: a backup commit must never block or fail a lesson (already on disk
 * before this is ever called). On a non-EEXIST mkdir error (an unwritable store:
 * EACCES/EROFS/ENOSPC) the wait is abandoned at once; on a live holder that
 * outlasts the budget, `fn` runs anyway, unlocked.
 */
async function withGitLock(dir, fn) {
  const lock = join(dir, '.nb-git.lock');
  const deadline = Date.now() + GIT_LOCK_WAIT_MS;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock); // atomic empty-dir lock: succeeds only if it did not exist
      held = true;
      break;
    } catch (e) {
      if (e && e.code && e.code !== 'EEXIST') break; // fail fast on an unwritable store (#263)
      // Reclaim a crashed holder's lock. Claim it atomically by renaming it aside
      // first: only one racer's rename wins, so no two waiters both delete the
      // lock and then clobber a fresh successor.
      try {
        if (Date.now() - statSync(lock).mtimeMs > GIT_LOCK_STALE_MS) {
          const aside = `${lock}.stale.${process.pid}`;
          renameSync(lock, aside); // ENOENT here ⇒ another waiter already claimed it
          rmSync(aside, { recursive: true, force: true });
        }
      } catch {
        /* vanished, or we lost the steal race — just retry */
      }
      if (Date.now() > deadline) break; // fail-open: commit WITHOUT serialization
      await sleep(20);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) {
      // Our section is far shorter than the stale threshold, so our lock is never
      // stolen from under us; a plain rmdir removes our own, still-empty lock.
      try {
        rmdirSync(lock);
      } catch {
        /* best-effort release */
      }
    }
  }
}

// Mutating commands that accept `--reason <code>` / `--note <text>` BEFORE their
// shelf (cli.ts only strips these for this set). `vote` takes neither.
const REASON_COMMANDS = new Set(['add', 'merge', 'rm', 'split', 'describe', 'move']);

/**
 * The CLI's positional args, resolved exactly as cli.ts does, so we read the SAME
 * shelf it wrote. The global flags `--json` / `--reason <v>` / `--note <v>` may
 * precede the shelf (`nb add --json beta "…"`), so reading raw argv[1] would miss
 * it and leave the change uncommitted. Mirror the CLI parse: split at the `--`
 * end-of-options terminator (a `--` with a token after it), strip `--json` from
 * the head, strip `--reason`/`--note` and their values for the commands that take
 * them, then re-append the post-`--` operands. Kept in lockstep with cli.ts.
 */
function cliPositionals(argv) {
  const termIdx = argv.findIndex((a, i) => a === '--' && i < argv.length - 1);
  const head = termIdx === -1 ? argv : argv.slice(0, termIdx);
  const operands = termIdx === -1 ? [] : argv.slice(termIdx + 1);
  let args = head.includes('--json') ? head.filter((a) => a !== '--json') : head;
  if (REASON_COMMANDS.has((argv[0] ?? '').trim())) {
    for (const flag of ['--reason', '--note']) {
      const i = args.indexOf(flag);
      if (i !== -1 && i + 1 < args.length) args = args.slice(0, i).concat(args.slice(i + 2));
    }
  }
  return args.concat(operands);
}

/**
 * The shelf files THIS command wrote — the only `*.md` paths its commit may
 * stage, so a sibling's concurrently-written shelf is never bundled in. A shelf
 * `<name>` is the file `<name>.md` (notebook.ts `shelfFile`); every mutating
 * command's primary shelf is the first positional, and `move` also writes its
 * destination shelf (the second). `args` is the CLI-resolved positionals.
 */
function changedShelfPaths(cmd, args) {
  const names = [];
  const primary = (args[1] ?? '').trim();
  if (primary) names.push(primary);
  if (cmd === 'move') {
    const dst = (args[2] ?? '').trim();
    if (dst) names.push(dst);
  }
  return names.map((name) => `${name}.md`);
}

/** Commit a notebook change when NB_DIR is a git repo. Best-effort, fail-open.
 *  Runs AFTER the lesson is already on disk; only the git calls are serialized. */
async function autoCommit(dir, argv) {
  if (process.env.NB_GIT_AUTOCOMMIT === '0') return;
  if (!existsSync(join(dir, '.git'))) return;
  const env = cleanGitEnv();
  // Bounded + non-interactive: a hung pre-commit hook or a credential prompt must
  // never wedge this inline path. stdin is ignored; each git call has a timeout;
  // on timeout execFileSync throws and the catch below makes it fail-open.
  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000, env });
  const cmd = (argv[0] ?? '').trim();
  const args = cliPositionals(argv); // the CLI's view of the positionals (flags stripped)
  const shelf = (args[1] ?? '').trim();
  await withGitLock(dir, () => {
    try {
      ensureGitignore(dir); // seed the ignore file BEFORE staging so the log is never added
      // Stage every NON-shelf change (the seeded .gitignore, and whatever a bare
      // `git add -A` would sweep)...
      run(['add', '-A', '--', '.', ':(exclude)*.md']);
      // ...then add back ONLY the shelves THIS command wrote. A sibling wrapper's
      // already-written .md is a different path, so it is never bundled into our
      // commit — one commit per change, with an accurate message.
      const shelves = changedShelfPaths(cmd, args);
      if (shelves.length) run(['add', '-A', '--', ...shelves]);
      try {
        run(['diff', '--cached', '--quiet']); // exit 0 → nothing staged → nothing to commit
        return;
      } catch {
        /* exit 1 → staged changes present → fall through to commit */
      }
      const msg = `nb ${cmd}${shelf ? ` ${shelf}` : ''}`.slice(0, 72);
      run(['commit', '--quiet', '-m', msg]);
    } catch {
      /* fail-open: never fail an nb call because the backup commit failed */
    }
  });
}

async function main() {
  // Always normalise: fills the default AND expands a leading `~` (issue #334), so the
  // git section and the CLI child agree on one directory.
  process.env.NB_DIR = notebooksDir();
  let entry;
  try {
    entry = resolveNbCliEntry();
  } catch (e) {
    console.error(`[nb] ${e instanceof Error ? e.message : String(e)}`);
    console.error('[nb] Install the package: `npm install -g agent-notebook`.');
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  // The CLI installs these only when it is the main module, so a wrapper that imports
  // `runNbCli` must install them itself (issue #401): without them `nb show | head -1`
  // dies with an EPIPE stack trace and a SIGTERM strands `.nb.lock`. Optional calls
  // keep the wrapper working against an older installed package that lacks the exports.
  mod.installPipeGuards?.();
  mod.installSignalLockRelease?.();
  const argv = process.argv.slice(2);
  const dir = process.env.NB_DIR;

  // Lesson first: the CLI writes it before any lock or git call, so a git problem
  // can never delay or lose it. Only AFTER it is on disk do we commit a successful
  // mutating command — that git section is where the lock lives (see autoCommit).
  const code = await mod.runNbCli(argv);
  process.exitCode = code;
  if (code === 0 && MUTATING.has((argv[0] ?? '').trim())) {
    await autoCommit(dir, argv);
  }
}

main().catch((e) => {
  console.error(`nb: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
