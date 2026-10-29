#!/usr/bin/env node
// nb-git-wrapper — run the real `nb` CLI, then record a git commit per change.
//
// WHAT IT ADDS
//   The `agent-notebook` package is deliberately offline and git-unaware: it
//   just edits a plain file. This wrapper layers ONE optional behaviour on top —
//   when your notebooks directory (NB_DIR) is a git repository, each successful
//   *mutating* command (add/vote/merge/rm/split/describe) is committed. The
//   result is a reviewable, revertible history of your agent's memory forming
//   over time, and a base the daily backup job (nb-backup.sh) can push.
//
// HOW TO USE IT (pick one)
//   • Put it first on PATH as `nb` (shadowing the global `nb`):
//       mkdir -p ~/.local/bin && cp nb-git-wrapper.mjs ~/.local/bin/nb
//       chmod +x ~/.local/bin/nb         # ensure ~/.local/bin precedes npm's bin
//   • Or keep the real `nb` as-is and call this explicitly where you want commits.
//
//   Then make NB_DIR a repo once:  (cd "$(nb path)" && git init)
//
// PORTABILITY
//   Pure Node, no shell — works on Linux, macOS, and Windows alike. It resolves
//   whichever `agent-notebook` is installed (global or local), so it tracks the
//   package version you actually run; nothing is vendored or forked.
//
// SAFETY / FAIL-OPEN
//   The lesson is written to disk by the real CLI BEFORE any git call. If git is
//   missing, NB_DIR is not a repo, there is no commit identity, or a hook hangs,
//   the commit is quietly skipped — a git problem never fails an `nb` call or
//   loses a lesson (the daily backup sweeps any straggler). Opt out entirely with
//   NB_GIT_AUTOCOMMIT=0.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Commands that write a notebook — only these are worth a commit. Must match the
// package's mutating surface; a read-only command (show/list/search/stats/path)
// never commits.
const MUTATING = new Set(['add', 'vote', 'merge', 'rm', 'split', 'describe']);

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

/** The notebooks directory the CLI will use — mirrors the package's resolution. */
function notebooksDir() {
  const fromEnv = process.env.NB_DIR;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.agent-notebook', 'notebooks');
}

/** Resolve the installed `agent-notebook` package's compiled CLI entry. */
function resolveNbCliEntry() {
  const require = createRequire(import.meta.url);
  // The package only publishes its main export (dist/notebook.js); the CLI is its
  // sibling dist/cli.js. Resolve main, then import cli.js by absolute path, which
  // bypasses the package `exports` restriction.
  const main = require.resolve('agent-notebook');
  const entry = join(dirname(main), 'cli.js');
  if (!existsSync(entry)) throw new Error(`agent-notebook CLI not found at ${entry}`);
  return entry;
}

/** Commit a notebook change when NB_DIR is a git repo. Best-effort, fail-open. */
function autoCommit(dir, argv) {
  if (process.env.NB_GIT_AUTOCOMMIT === '0') return;
  if (!existsSync(join(dir, '.git'))) return;
  const env = cleanGitEnv();
  // Bounded + non-interactive: a hung pre-commit hook or a credential prompt must
  // never wedge this inline path. stdin is ignored; each git call has a timeout;
  // on timeout execFileSync throws and the catch below makes it fail-open.
  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000, env });
  try {
    run(['add', '-A']);
    try {
      run(['diff', '--cached', '--quiet']); // exit 0 → nothing staged → nothing to commit
      return;
    } catch {
      /* exit 1 → staged changes present → fall through to commit */
    }
    const cmd = (argv[0] ?? '').trim();
    const shelf = (argv[1] ?? '').trim();
    const msg = `nb ${cmd}${shelf ? ` ${shelf}` : ''}`.slice(0, 72);
    run(['commit', '--quiet', '-m', msg]);
  } catch {
    /* fail-open: never fail an nb call because the backup commit failed */
  }
}

async function main() {
  if (!process.env.NB_DIR || process.env.NB_DIR.trim() === '') {
    process.env.NB_DIR = notebooksDir();
  }
  let entry;
  try {
    entry = resolveNbCliEntry();
  } catch (e) {
    console.error(`[nb] ${e instanceof Error ? e.message : String(e)}`);
    console.error('[nb] Install the package: `npm install -g agent-notebook`.');
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  const argv = process.argv.slice(2);
  const code = await mod.runNbCli(argv);
  process.exitCode = code;
  if (code === 0 && MUTATING.has((argv[0] ?? '').trim())) {
    autoCommit(process.env.NB_DIR, argv);
  }
}

main().catch((e) => {
  console.error(`nb: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
