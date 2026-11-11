import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #399: nb-backup.sh must not stage/commit/push a store that is mid-merge
// or mid-rebase (`git add -A` would mark conflicts resolved and publish markers).
const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'nb-backup.sh');

let tmp: string;
let remote: string;
let a: string;

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

function conflict(mode: 'merge' | 'rebase'): void {
  const b = join(tmp, 'B');
  writeFileSync(join(a, 'review.md'), '+1\tbase\n');
  git(a, 'add', '-A');
  git(a, 'commit', '-qm', 'init');
  git(a, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, b);
  git(b, 'config', 'user.email', 't@t');
  git(b, 'config', 'user.name', 't');
  writeFileSync(join(b, 'review.md'), '+1\tbase\n+1\tfrom B\n');
  git(b, 'commit', '-qam', 'b');
  git(b, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(a, 'review.md'), '+1\tbase\n+1\tfrom A\n');
  git(a, 'commit', '-qam', 'a');
  git(a, 'fetch', '-q', 'origin');
  if (mode === 'merge') git(a, 'merge', 'origin/main');
  else git(a, 'rebase', 'origin/main');
}

function run() {
  const r = spawnSync('bash', [script], { env: { ...process.env, NB_DIR: a }, encoding: 'utf-8' });
  return { status: r.status, log: readFileSync(join(a, '.nb-backup.log'), 'utf-8') };
}

function remoteReview(): string {
  return git(remote, 'show', 'main:review.md').stdout;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nb-midmerge-'));
  remote = join(tmp, 'r.git');
  a = join(tmp, 'A');
  git(tmp, 'init', '-q', '-b', 'main', '--bare', remote);
  git(tmp, 'init', '-q', '-b', 'main', a);
  git(a, 'config', 'user.email', 't@t');
  git(a, 'config', 'user.name', 't');
  git(a, 'remote', 'add', 'origin', remote);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('nb-backup.sh refuses to conclude a conflicted merge/rebase (issue #399)', () => {
  test('mid-merge: no commit, no push, MERGE_HEAD kept, exits non-zero, one log line', () => {
    conflict('merge');
    expect(existsSync(join(a, '.git', 'MERGE_HEAD'))).toBe(true);
    const before = remoteReview();
    const { status, log } = run();
    expect(status).not.toBe(0);
    expect(log).toContain('MERGE IN PROGRESS');
    expect(log).not.toContain('committed straggler');
    expect(log).not.toContain('pushed');
    expect(existsSync(join(a, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(git(a, 'ls-files', '-u').stdout).not.toBe('');
    expect(remoteReview()).toBe(before);
    expect(remoteReview()).not.toMatch(/^<<<<<<<|^=======|^>>>>>>>/m);
    // lock released
    expect(existsSync(join(a, '.nb-git.lock'))).toBe(false);
  });

  test('mid-rebase: exits before the push step', () => {
    conflict('rebase');
    const before = remoteReview();
    const { status, log } = run();
    expect(status).not.toBe(0);
    expect(log).toContain('MERGE IN PROGRESS');
    expect(remoteReview()).toBe(before);
  });

  test('control: ordinary uncommitted changes still commit and push', () => {
    writeFileSync(join(a, 'review.md'), '+1\tbase\n');
    git(a, 'add', '-A');
    git(a, 'commit', '-qm', 'init');
    writeFileSync(join(a, 'review.md'), '+1\tfine\n');
    const { status, log } = run();
    expect(status).toBe(0);
    expect(log).toContain('committed straggler changes');
    expect(remoteReview()).toContain('fine');
  });
});
