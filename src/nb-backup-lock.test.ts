import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
  mkdirSync,
  rmdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Guards issue #210: nb-backup.sh must NOT open its single-instance lock on a
// fixed, world-writable `/tmp/agent-notebook-backup.lock` (CWE-377). On a
// multi-user host that shared path lets any other user squat the lock (denying
// your backup) or plant a symlink that `exec 9>` follows and truncates. The
// lock must be user-scoped: the per-user `$XDG_RUNTIME_DIR` (0700, private) when
// it points at a writable dir, else the user-owned `$NB_DIR`. We drive the REAL
// script and assert its behavior, and pin that the fixed shared path is gone.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(root, 'examples', 'nb-backup.sh');
const source = readFileSync(script, 'utf-8');

const hasFlock = spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
const hasTimeout = spawnSync('timeout', ['--version'], { stdio: 'ignore' }).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let xdg: string;

/** A throwaway NB_DIR that is a git repo with no remote, so the script creates
 *  its lock, finds nothing to push, and exits 0 without touching the network. */
function seedRepo(): void {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
}

/** Run the real script; `xdgDir === null` removes XDG_RUNTIME_DIR from the env,
 *  a string (including '') sets it. Returns the script's exit code. */
function run(xdgDir: string | null): number {
  const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir };
  if (xdgDir === null) delete env.XDG_RUNTIME_DIR;
  else env.XDG_RUNTIME_DIR = xdgDir;
  const r = spawnSync('bash', [script], { env, encoding: 'utf-8' });
  return r.status ?? 1;
}

/** The lock patterns the shipped git-versioning recipe tells users to gitignore. */
function recipeGitignoreLine(): string {
  const doc = readFileSync(join(root, 'docs', 'harness-setup.md'), 'utf-8');
  const line = doc.split('\n').find((l) => l.includes('printf') && l.includes('> .gitignore'));
  expect(line, 'recipe should contain a `printf ... > .gitignore` line').toBeTruthy();
  return line!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-backup-nbdir-'));
  xdg = mkdtempSync(join(tmpdir(), 'agent-notebook-backup-xdg-'));
  seedRepo();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
});

describe('nb-backup.sh lock path is user-scoped (issue #210, CWE-377)', () => {
  test('the fixed world-writable /tmp lock path is gone from the source', () => {
    expect(source).not.toContain('/tmp/agent-notebook-backup.lock');
    // The lock dir must be derived from a per-user location, never a fixed /tmp
    // name, and the lock file hangs off it.
    expect(source).toMatch(/LOCK_DIR="\$\{XDG_RUNTIME_DIR:-\$\{?NB_DIR\}?\}"/);
    expect(source).toMatch(/LOCK_FILE="\$\{?LOCK_DIR\}?\/\.nb-backup\.lock"/);
  });

  test.skipIf(!hasFlock)('with a writable XDG_RUNTIME_DIR, the lock lands in that private per-user dir', () => {
    expect(run(xdg)).toBe(0);
    expect(existsSync(join(xdg, '.nb-backup.lock'))).toBe(true);
    // Not inside the repo, and not the old shared /tmp name.
    expect(existsSync(join(dir, '.nb-backup.lock'))).toBe(false);
  });

  test.skipIf(!hasFlock)('without XDG_RUNTIME_DIR, the lock falls back to the user-owned NB_DIR', () => {
    expect(run(null)).toBe(0);
    expect(existsSync(join(dir, '.nb-backup.lock'))).toBe(true);
  });

  test.skipIf(!hasFlock)('an empty XDG_RUNTIME_DIR is treated as unset, not as "/" (pins `:-`, not `-`)', () => {
    // A `-` instead of `:-` would make XDG_RUNTIME_DIR="" expand to "" and write
    // the lock at `/.nb-backup.lock`; `:-` must fall back to NB_DIR instead.
    expect(run('')).toBe(0);
    expect(existsSync(join(dir, '.nb-backup.lock'))).toBe(true);
    expect(existsSync('/.nb-backup.lock')).toBe(false);
  });

  test.skipIf(!hasFlock)('XDG_RUNTIME_DIR set to a non-writable/absent dir falls back to NB_DIR (no silent skip)', () => {
    // If `exec 9>` targeted an unwritable XDG dir it would fail and the run would
    // silently skip. The guard must fall back to the user-owned NB_DIR instead.
    const gone = join(xdg, 'does-not-exist');
    expect(run(gone)).toBe(0);
    expect(existsSync(join(dir, '.nb-backup.lock'))).toBe(true);
    expect(existsSync(join(gone, '.nb-backup.lock'))).toBe(false);
  });

  test.skipIf(!hasFlock)('the NB_DIR fallback lock is gitignored by the shipped recipe, so it is never committed', () => {
    // Use the exact patterns the git-versioning recipe writes, not a local guess,
    // so this test fails if the recipe ever stops covering the lock file.
    const recipeLine = recipeGitignoreLine();
    expect(recipeLine).toContain('.nb-backup.*'); // the pattern that must cover the lock
    const patterns = [...recipeLine.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((t) => t !== '%s\\n');
    writeFileSync(join(dir, '.gitignore'), patterns.join('\n') + '\n', 'utf-8');

    expect(run(null)).toBe(0);
    // The lock must actually have been created — otherwise the status check below
    // is vacuous.
    expect(existsSync(join(dir, '.nb-backup.lock'))).toBe(true);
    const tracked = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8' });
    expect(tracked).not.toContain('.nb-backup.lock');

    // Control: without the recipe's .gitignore, git WOULD see the lock — proving
    // the assertion above can fail, so it is the gitignore doing the work.
    unlinkSync(join(dir, '.gitignore'));
    const bare = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8' });
    expect(bare).toContain('.nb-backup.lock');
  });

  test.skipIf(!hasFlock)('a second run skips (exit 0) while another holds the lock — the lock still works', async () => {
    const lockPath = join(dir, '.nb-backup.lock');
    const ready = join(dir, '.holder-ready');
    const release = join(dir, '.holder-release');
    writeFileSync(release, '', 'utf-8'); // holder waits while this exists
    // Holder: acquire the exact lock path the script will use, signal readiness,
    // hold until the test deletes `release`. Marker-file sync, no timing races.
    const holder = spawn(
      'bash',
      ['-c', `exec 9>"${lockPath}"; flock -x -n 9 || exit 3; : > "${ready}"; while [ -e "${release}" ]; do sleep 0.02; done`],
      { stdio: 'ignore' },
    );
    try {
      for (let i = 0; i < 250 && !existsSync(ready); i++) await sleep(20); // up to ~5s
      expect(existsSync(ready), 'holder should have acquired the lock').toBe(true);

      expect(run(null)).toBe(0); // contended run skips cleanly, not errors
      const logTxt = readFileSync(join(dir, '.nb-backup.log'), 'utf-8');
      expect(logTxt).toContain('another nb-backup run is in progress');
    } finally {
      unlinkSync(release); // let the holder exit and release the lock
      await new Promise<void>((res) => holder.on('exit', () => res()));
    }
  });
});

// Shell source with comment-only lines stripped, so the static checks below match
// real code — not the explanatory comments that happen to mention the same flags.
// Without this, a commented-out guard (`# export GIT_TERMINAL_PROMPT=0`) or the
// header ENV docs would satisfy the assertions even if the real line were deleted.
const codeOnly = source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** True once a lock file can be re-acquired with a non-blocking flock — i.e. the
 *  previous holder has released fd 9. This is the real "the lock is free again"
 *  probe, as opposed to merely checking the lock FILE exists (it is never
 *  deleted, so its existence proves nothing about whether fd 9 is still held). */
function lockIsFree(lockPath: string): boolean {
  return spawnSync('bash', ['-c', `exec 9>"${lockPath}"; flock -n 9`]).status === 0;
}

describe('nb-backup.sh push fails fast instead of hanging on a credential prompt (issue #272)', () => {
  test('the push suppresses interactive git/ssh prompts (real code, not comments)', () => {
    // Without these, an expired credential, an SSH passphrase, or an unknown-host
    // prompt makes an unattended push block forever; because the push holds the
    // lock (fd 9) for its whole life, a hung push wedges every later run. Pin the
    // real guard lines (comments stripped) so a refactor can't silently drop them.
    expect(codeOnly).toMatch(/^\s*export GIT_TERMINAL_PROMPT=0\s*$/m);
    // GIT_SSH_COMMAND is defaulted to batch mode + a bounded connect, and only
    // when the user has not set it, so a custom ssh wrapper still wins.
    expect(codeOnly).toMatch(/^\s*if\s+\[\s+-z\s+"\$\{GIT_SSH_COMMAND:-\}"\s+\]/m);
    expect(codeOnly).toMatch(/^\s*export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=\d+"/m);
  });

  test('the push is wrapped in `timeout` when available, as a hard backstop', () => {
    // A finite ceiling guarantees the lock is released even if a credential helper
    // hangs some other way. It must be conditional on `timeout` existing (absent on
    // stock macOS) so the script never wedges where the command is missing.
    expect(codeOnly).toMatch(/command\s+-v\s+timeout/);
    expect(codeOnly).toMatch(/timeout\s+"\$PUSH_TIMEOUT"\s+git\s+push/);
    // The operator override is the real assignment, not just a mention in the docs.
    expect(codeOnly).toMatch(/PUSH_TIMEOUT="\$\{NB_BACKUP_PUSH_TIMEOUT:-\d+\}"/);
  });

  // Behavioral coverage of the DEFAULT (user has not set GIT_SSH_COMMAND): the
  // script must hand ssh `-o BatchMode=yes` (so passphrase/host-key prompts become
  // an immediate error) and export GIT_TERMINAL_PROMPT=0, then fail fast and
  // release the lock. We stub `ssh` first on PATH to capture what git actually ran.
  test.skipIf(!hasFlock)(
    'with GIT_SSH_COMMAND unset, the default passes ssh BatchMode and sets GIT_TERMINAL_PROMPT=0, then releases the lock',
    () => {
      writeFileSync(join(dir, 'note.txt'), 'x', 'utf-8');
      execFileSync('git', ['-C', dir, 'add', 'note.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@nb-backup.invalid:repo.git'], {
        stdio: 'ignore',
      });

      const binDir = mkdtempSync(join(tmpdir(), 'agent-notebook-backup-bin-'));
      const record = join(dir, 'ssh-invocation.txt');
      const stubSsh = join(binDir, 'ssh');
      // Record the argv git passed and the terminal-prompt env it exported, then
      // fail like a real ssh connection error (255) so the push returns at once.
      writeFileSync(
        stubSsh,
        `#!/bin/sh\n{ echo "ARGS: $*"; echo "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT-<unset>}"; } > "${record}"\nexit 255\n`,
        'utf-8',
      );
      chmodSync(stubSsh, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NB_DIR: dir,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      };
      delete env.XDG_RUNTIME_DIR; // lock falls back into NB_DIR
      delete env.GIT_SSH_COMMAND; // force the script's default branch

      const r = spawnSync('bash', [script], { env, stdio: 'ignore', timeout: 30_000 });

      expect(r.status).toBe(1); // a failed push keeps the existing retry-next-run path
      const rec = readFileSync(record, 'utf-8');
      expect(rec).toContain('BatchMode=yes'); // the default actually reaches ssh
      expect(rec).toContain('ConnectTimeout=30');
      expect(rec).toContain('GIT_TERMINAL_PROMPT=0'); // exported for git's own prompts
      // The stub exited, so the push released fd 9: the lock is genuinely free again.
      expect(lockIsFree(join(dir, '.nb-backup.lock'))).toBe(true);

      rmSync(binDir, { recursive: true, force: true });
    },
    30_000,
  );

  // Backstop: even a transport that NEVER responds (not merely one that errors)
  // must not hang the run. GNU `timeout` runs the push in its own process group
  // and kills the whole group on expiry, so the script exits, logs, and releases
  // the lock instead of holding fd 9 forever and wedging every subsequent run.
  test.skipIf(!hasTimeout || !hasFlock)(
    'a push that stalls on the SSH transport is killed by the timeout wrapper, releasing the lock',
    () => {
      writeFileSync(join(dir, 'note.txt'), 'x', 'utf-8');
      execFileSync('git', ['-C', dir, 'add', 'note.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@nb-backup.invalid:repo.git'], {
        stdio: 'ignore',
      });
      // Fake ssh: ignore git's args and block far longer than the push timeout, so
      // the push can only end by being killed — proving the timeout wrapper fires.
      const fakeSsh = join(dir, 'slow-ssh.sh');
      writeFileSync(fakeSsh, '#!/bin/sh\nexec sleep 30\n', 'utf-8');
      chmodSync(fakeSsh, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NB_DIR: dir,
        NB_BACKUP_PUSH_TIMEOUT: '2',
        GIT_SSH_COMMAND: fakeSsh, // the script must respect a user-set GIT_SSH_COMMAND
      };
      delete env.XDG_RUNTIME_DIR; // lock falls back into NB_DIR

      const started = Date.now();
      // `stdio: 'ignore'` so no inherited pipe can stall this spawn past the exit.
      const r = spawnSync('bash', [script], { env, stdio: 'ignore', timeout: 30_000 });
      const elapsedMs = Date.now() - started;

      // The run returned on its own (not force-killed by the spawn timeout) and
      // near the 2s push cap — nowhere near the 30s fake-ssh sleep.
      expect(r.signal, 'script should exit on its own, not be force-killed').toBeNull();
      expect(elapsedMs).toBeLessThan(20_000);
      // A killed push is a failed push: exit 1 and the existing retry-next-run log.
      expect(r.status).toBe(1);
      expect(readFileSync(join(dir, '.nb-backup.log'), 'utf-8')).toContain('PUSH FAILED');
      // The whole process group was killed, so fd 9 is released — not held by a
      // lingering transport child. A fresh contender can now acquire the lock.
      expect(lockIsFree(join(dir, '.nb-backup.lock'))).toBe(true);
    },
    30_000,
  );
});

// Guards issue #274: the straggler step used a bare `git add -A`, and LOG_FILE
// (`$NB_DIR/.nb-backup.log`) lives inside the worktree. A store set up WITHOUT the
// git-versioning recipe has no .gitignore, so every run staged the log line the
// PREVIOUS run had just written — an unbroken chain of "nb-backup <date>" commits
// that each carry only the last run's log, never the idempotent no-op the header
// promises. The fix seeds/tops up NB_DIR/.gitignore with the shipped recipe's
// patterns before `git add -A`. These tests drive the REAL script and pin that
// behavior end to end; none of them need `flock` (the script runs lockless when
// it is absent and the result is the same).
describe('nb-backup.sh seeds .gitignore so the straggler commit is idempotent (issue #274)', () => {
  /** Commit count on HEAD; 0 before the first commit (git errors on an unborn HEAD). */
  function commitCount(): number {
    const r = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf-8' });
    return r.status === 0 ? parseInt(r.stdout.trim() || '0', 10) : 0;
  }

  /** The patterns the shipped recipe's `printf ... > .gitignore` writes. */
  function recipePatterns(): string[] {
    return [...recipeGitignoreLine().matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((t) => t !== '%s\\n');
  }

  test('a store set up without the recipe stops churning a commit of its own log every run', () => {
    // No .gitignore (the recipe was never run) and a real shelf to back up.
    writeFileSync(join(dir, 'build-and-test.md'), 'first lesson\n', 'utf-8');

    // Run 1: seeds .gitignore, commits the straggler shelf + the ignore file.
    expect(run(null)).toBe(0);
    const afterFirst = commitCount();
    expect(afterFirst).toBeGreaterThan(0);

    // The script wrote its own log into NB_DIR...
    const logPath = join(dir, '.nb-backup.log');
    expect(existsSync(logPath)).toBe(true);
    // ...but the seeded ignore keeps it out of git, so there is nothing new to
    // stage next time. Without the fix the log line this run wrote would be an
    // uncommitted change the next run commits, and so on without end.
    expect(execFileSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf-8' })).not.toContain('.nb-backup.log');

    // Runs 2 and 3 are genuine no-ops: the commit count must not grow.
    expect(run(null)).toBe(0);
    expect(run(null)).toBe(0);
    expect(commitCount()).toBe(afterFirst);

    // The no-op is real, not vacuous: the log IS on disk and git reports it
    // ignored (`!!`), not untracked — so it is the seeded ignore doing the work,
    // and without it this file would be the churning uncommitted change.
    const ignored = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--ignored'], {
      encoding: 'utf-8',
    });
    expect(ignored).toMatch(/^!! \.nb-backup\.log$/m);
  });

  test('a .gitignore missing only some patterns gets exactly the missing ones appended (migration case)', () => {
    // A recipe-era store created before `.nb-backup.*` was added to the recipe: it
    // already ignores most transient files but not this script's own log, so it
    // kept churning until this run tops it up.
    const partial = ['.nb-usage.log*', '.nb.lock', '*.tmp', '.retro-*'];
    writeFileSync(join(dir, '.gitignore'), partial.join('\n') + '\n', 'utf-8');
    expect(run(null)).toBe(0);

    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n').filter(Boolean);
    // The previously-missing pattern was added...
    expect(lines).toContain('.nb-backup.*');
    // ...and every recipe pattern now appears EXACTLY once: only the missing one
    // is appended, the already-present ones are not re-added as duplicates.
    for (const pat of recipePatterns()) {
      expect(lines.filter((l) => l === pat)).toHaveLength(1);
    }
  });

  test('the auto-seeded .gitignore uses the shipped recipe patterns (kept in one place)', () => {
    writeFileSync(join(dir, 'build-and-test.md'), 'x\n', 'utf-8');
    expect(existsSync(join(dir, '.gitignore'))).toBe(false); // recipe never run
    expect(run(null)).toBe(0);

    const seeded = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
    // Every pattern the recipe would write is present, so the script and the doc
    // never drift into covering different transient files.
    const patterns = recipePatterns();
    for (const pat of patterns) expect(seeded).toContain(pat);
    // The pattern that actually covers this script's own log must be among them.
    expect(patterns).toContain('.nb-backup.*');
  });

  test('a pre-existing custom .gitignore is preserved and topped up without gluing lines', () => {
    // User's own ignore, with NO trailing newline and none of our patterns.
    writeFileSync(join(dir, '.gitignore'), 'node_modules', 'utf-8');
    expect(run(null)).toBe(0);

    const lines = readFileSync(join(dir, '.gitignore'), 'utf-8').split('\n');
    expect(lines).toContain('node_modules'); // user content kept verbatim
    expect(lines).toContain('.nb-backup.*'); // our pattern appended
    // The absent trailing newline must not glue our first pattern onto the user's
    // last line (that would both corrupt their ignore and never match).
    expect(lines).not.toContain('node_modules.nb-usage.log*');
  });

  test('an already-complete .gitignore is left byte-for-byte unchanged (no duplicate patterns)', () => {
    const initial = recipePatterns().join('\n') + '\n';
    writeFileSync(join(dir, '.gitignore'), initial, 'utf-8');
    expect(run(null)).toBe(0);
    // ensure_gitignore appended nothing because every pattern was already present.
    expect(readFileSync(join(dir, '.gitignore'), 'utf-8')).toBe(initial);
  });
});

// Guards issue #305: the straggler `git add`/`git commit` must run under the
// SAME `.nb-git.lock` mkdir-dir lock the git-wrapper takes (withGitLock), else a
// scheduled backup can collide with a live wrapper commit on `.git/index.lock`.
describe('nb-backup.sh serializes its commit on the wrapper\'s .nb-git.lock (issue #305)', () => {
  const gitLock = () => join(dir, '.nb-git.lock');
  const commitCount = () => {
    const r = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf-8' });
    return r.status === 0 ? parseInt(r.stdout.trim() || '0', 10) : 0;
  };
  const logText = () => (existsSync(join(dir, '.nb-backup.log')) ? readFileSync(join(dir, '.nb-backup.log'), 'utf-8') : '');
  const envWith = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir, ...extra };
    delete env.XDG_RUNTIME_DIR;
    return env;
  };

  test('a held lock blocks add/commit (no concurrent commit) and is left untouched', () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    mkdirSync(gitLock()); // a live wrapper commit is in flight
    const r = spawnSync('bash', [script], { env: envWith({ NB_BACKUP_GIT_LOCK_WAIT: '1' }), encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(commitCount()).toBe(0); // did not commit under the holder's feet
    expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf-8' })).toBe(''); // nor stage
    expect(existsSync(gitLock())).toBe(true); // not ours: never released by the backup
    expect(logText()).toContain('git lock');
  });

  test('waits for the holder, then commits and releases the lock cleanly', async () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    mkdirSync(gitLock());
    const child = spawn('bash', [script], { env: envWith({ NB_BACKUP_GIT_LOCK_WAIT: '15' }), stdio: 'ignore' });
    const exited = new Promise<number>((res) => child.on('exit', (c) => res(c ?? 1)));
    await sleep(700);
    expect(commitCount()).toBe(0); // still waiting while the lock is held
    rmdirSync(gitLock()); // wrapper finishes
    expect(await exited).toBe(0);
    expect(commitCount()).toBe(1);
    expect(existsSync(gitLock())).toBe(false); // released after our section
  });

  test('a stale lock (crashed holder) is reclaimed so the backup is never wedged', () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    mkdirSync(gitLock());
    const old = new Date(Date.now() - 120_000);
    utimesSync(gitLock(), old, old);
    const r = spawnSync('bash', [script], { env: envWith({ NB_BACKUP_GIT_LOCK_WAIT: '2' }), encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(commitCount()).toBe(1);
    expect(existsSync(gitLock())).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)('an undeletable stale lock cannot spin the backup forever (bounded by the wait)', () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    mkdirSync(gitLock());
    const old = new Date(Date.now() - 120_000);
    utimesSync(gitLock(), old, old);
    chmodSync(dir, 0o555); // mv/rm of the lock fails
    try {
      const r = spawnSync('bash', [script], {
        env: envWith({ NB_BACKUP_GIT_LOCK_WAIT: '1', XDG_RUNTIME_DIR: xdg }),
        encoding: 'utf-8',
        timeout: 20_000,
      });
      expect(r.signal).toBeNull(); // exited on its own, not killed
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test('a non-integer NB_BACKUP_GIT_LOCK_WAIT falls back to the default instead of breaking', () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    const r = spawnSync('bash', [script], { env: envWith({ NB_BACKUP_GIT_LOCK_WAIT: 'abc' }), encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(commitCount()).toBe(1);
  });

  test('an uncontended run takes and releases the lock (nothing left behind)', () => {
    writeFileSync(join(dir, 'shelf.md'), 'lesson\n', 'utf-8');
    expect(run(null)).toBe(0);
    expect(commitCount()).toBe(1);
    expect(existsSync(gitLock())).toBe(false);
  });
});

// Guards issue #311: NB_BACKUP_PUSH_TIMEOUT was only checked against the literal
// "0", never validated. A malformed duration (e.g. "5min", "abc") makes
// `timeout "$PUSH_TIMEOUT" git push` exit 125 ("invalid time interval"), which
// the push step logs as the generic "PUSH FAILED — will retry next run" on EVERY
// run — indistinguishable from a real transient failure. So a single typo
// permanently disables the off-machine backup while the operator believes it is
// retrying. The fix validates the value against the documented `timeout` grammar
// and, on a mismatch, logs a DISTINCT config error and falls back to the default.
describe('nb-backup.sh validates NB_BACKUP_PUSH_TIMEOUT (issue #311)', () => {
  /** Seed a commit + a REACHABLE local bare remote, then run the real script with
   *  the given NB_BACKUP_PUSH_TIMEOUT. With a reachable remote the ONLY thing that
   *  can fail the push is a malformed timeout, so the log distinguishes the fix
   *  (push succeeds after fallback) from the bug (`timeout bad …` → exit 125 →
   *  "PUSH FAILED"). The bare remote is always cleaned up, even if a later
   *  assertion throws, so a failing test can't leak a temp dir. */
  function runWithRemote(timeoutVal: string): { status: number; log: string } {
    const remote = mkdtempSync(join(tmpdir(), 'agent-notebook-backup-remote-'));
    try {
      execFileSync('git', ['init', '--bare', '-q', remote]);
      writeFileSync(join(dir, 'note.txt'), 'x', 'utf-8');
      execFileSync('git', ['-C', dir, 'add', 'note.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { stdio: 'ignore' });

      const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir, NB_BACKUP_PUSH_TIMEOUT: timeoutVal };
      delete env.XDG_RUNTIME_DIR;
      const r = spawnSync('bash', [script], { env, encoding: 'utf-8', timeout: 30_000 });
      return { status: r.status ?? 1, log: readFileSync(join(dir, '.nb-backup.log'), 'utf-8') };
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  }

  test('the duration is validated against the `timeout` grammar before use (real code, not comments)', () => {
    // Pin the real guard (comments stripped) so a refactor can't silently drop it
    // and let a malformed value reach `timeout` again. The pattern is anchored to
    // the s/m/h/d grammar but loose between the number and the suffix, so the
    // decimal group can evolve without re-pinning its exact spelling.
    expect(codeOnly).toMatch(/PUSH_TIMEOUT_RE=.*\^\[0-9\]\+.*\[smhd\]\?\$/);
    // The validator actually applies that pattern to the value.
    expect(codeOnly).toMatch(/\$PUSH_TIMEOUT"?\s*=~\s*\$PUSH_TIMEOUT_RE/);
    // The fallback is the documented default, not a disable (0).
    expect(codeOnly).toMatch(/PUSH_TIMEOUT=300/);
  });

  // Malformed values: each must be rejected with a DISTINCT config error, fall
  // back to the default 300 (not a disable), and still push — so one typo can no
  // longer masquerade as a permanent transient "PUSH FAILED". `5min` is the
  // issue's own example; `abc` a non-numeric typo.
  test.skipIf(!hasTimeout).each(['5min', 'abc', 'bad'])(
    'an invalid value (%s) logs a distinct config error, falls back to 300, and still pushes',
    (bad) => {
      const { status, log } = runWithRemote(bad);
      expect(status).toBe(0); // the backup is NOT wedged by the typo
      // A DISTINCT config-error diagnostic that names the offending variable...
      expect(log).toMatch(/CONFIG ERROR.*NB_BACKUP_PUSH_TIMEOUT/);
      // ...and explicitly falls back to 300 — proving the default, not a disable.
      expect(log).toMatch(/falling back to 300/);
      // ...NOT the generic transient-failure line it used to masquerade as.
      expect(log).not.toContain('PUSH FAILED');
      // The fallback actually pushed: the remote received the branch.
      expect(log).toMatch(/pushed .* OK/);
    },
    30_000,
  );

  // Valid durations must behave exactly as before: push cleanly, no config error.
  // `5m` is the documented example; `1.5` / `0.5s` are decimals GNU `timeout`
  // accepts, so the validator must NOT reject them (they are "any timeout
  // duration" per the header) — a regression guard on the grammar's breadth.
  test.skipIf(!hasTimeout).each(['300', '5m', '1.5', '0.5s'])(
    'a valid duration (%s) pushes with no config error',
    (good) => {
      const { status, log } = runWithRemote(good);
      expect(status).toBe(0);
      expect(log).toMatch(/pushed .* OK/);
      expect(log).not.toContain('CONFIG ERROR');
      expect(log).not.toContain('PUSH FAILED');
    },
    30_000,
  );

  test.skipIf(!hasTimeout)('"0" is a valid value: it disables the wrapper and is not flagged as a config error', () => {
    // The header documents "0" as "disables the cap". It matches the grammar, so
    // it must NOT trip the config-error guard, and the push (unwrapped) succeeds.
    const { status, log } = runWithRemote('0');
    expect(status).toBe(0);
    expect(log).not.toContain('CONFIG ERROR');
    expect(log).not.toContain('PUSH FAILED');
    expect(log).toMatch(/pushed .* OK/);
  });
});
