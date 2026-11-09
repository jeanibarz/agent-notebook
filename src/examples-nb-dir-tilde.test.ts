import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// Issue #334: `nb` expands a leading `~` in NB_DIR itself. The shipped helper
// scripts resolve NB_DIR on their own, so they must agree — otherwise, with
// NB_DIR='~/nbx' set where no shell expands it (settings.json env, systemd, cron),
// the wrapper never commits, the retrospective hook mkdirs a literal `./~` in the
// project, and the janitor/backup scan a nonexistent directory. Each test drives
// the REAL script with a throwaway HOME and a throwaway cwd and asserts nothing
// named `~` appears in the cwd.
const here = dirname(fileURLToPath(import.meta.url));
const ex = join(here, '..', 'examples');

let home: string;
let cwd: string;
let nbDir: string; // <home>/nbx
const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, HOME: home, USERPROFILE: home, NB_DIR: '~/nbx', ...extra });

function seedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['-C', dir, 'config', k, v], { stdio: 'ignore' });
  }
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', 'seed'], { stdio: 'ignore' });
}
const commitCount = (dir: string) => Number(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf-8' }).trim());

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'nb-tilde-home-')));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'nb-tilde-cwd-')));
  nbDir = join(home, 'nbx');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('example scripts expand a leading ~ in NB_DIR like the package (issue #334)', () => {
  test('nb-git-wrapper commits into <home>/nbx and creates no ./~', () => {
    seedRepo(nbDir);
    const r = spawnSync('node', [join(ex, 'nb-git-wrapper.mjs'), 'add', 's', 'tilde lesson'], { cwd, env: env(), encoding: 'utf-8', timeout: 20000 });
    expect(r.status).toBe(0);
    expect(commitCount(nbDir)).toBe(2); // seed + the auto-commit
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('nb-retrospective.sh puts its sentinel under <home>/nbx and creates no ./~', () => {
    execFileSync('bash', [join(ex, 'hooks', 'claude-code', 'nb-retrospective.sh')], {
      cwd, env: env(), input: JSON.stringify({ session_id: 'sess1' }), encoding: 'utf-8',
    });
    expect(readdirSync(nbDir).some((f) => f.startsWith('.retro-'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('nb-janitor scans <home>/nbx', () => {
    mkdirSync(nbDir, { recursive: true });
    const out = JSON.parse(execFileSync('node', [join(ex, 'nb-janitor.mjs'), '--json'], { cwd, env: env(), encoding: 'utf-8' }));
    expect(out.dir).toBe(nbDir);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test('nb-backup.sh works on <home>/nbx and creates no ./~', () => {
    seedRepo(nbDir);
    const r = spawnSync('bash', [join(ex, 'nb-backup.sh')], { cwd, env: env({ XDG_RUNTIME_DIR: '' }), encoding: 'utf-8', timeout: 20000 });
    expect(r.status).toBe(0);
    expect(existsSync(join(nbDir, '.nb-backup.log'))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });
});
