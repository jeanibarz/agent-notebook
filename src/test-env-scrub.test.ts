import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// Issue #481: git exports GIT_DIR to hooks, so `npm test` run from a
// pre-commit/pre-push hook used to make the fixtures' `git init`/`config`/
// `commit` act on the caller's repository. This runs a real git-fixture suite in
// a nested vitest with GIT_DIR pointed at a throwaway decoy repository (never a
// real checkout) and asserts the decoy gains no commit and no config change.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');

let decoy: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', decoy, ...args], { encoding: 'utf-8', env: cleanEnv() }).trim();

/** This worker's env minus GIT_* (already scrubbed, but be explicit), the
 *  VITEST_* bookkeeping of the outer run, and GITHUB_ACTIONS (so the nested run
 *  does not add the junit reporter and overwrite the outer run's junit.xml). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_') || k.startsWith('VITEST') || k === 'GITHUB_ACTIONS') delete env[k];
  }
  return env;
}

beforeAll(() => {
  decoy = mkdtempSync(join(tmpdir(), 'nb-git-decoy-'));
  execFileSync('git', ['init', '-q', decoy], { env: cleanEnv() });
  git('config', 'user.email', 'decoy@decoy');
  git('config', 'user.name', 'decoy');
  git('commit', '--quiet', '--allow-empty', '-m', 'decoy-root');
});
afterAll(() => rmSync(decoy, { recursive: true, force: true }));

describe('inherited environment is scrubbed before the suites run (issue #481)', () => {
  test('a hook-style GIT_DIR and ambient NB_* do not reach the git fixtures', () => {
    const configPath = join(decoy, '.git', 'config');
    const configBefore = readFileSync(configPath, 'utf-8');
    const headBefore = git('rev-parse', 'HEAD');

    const r = spawnSync(
      process.execPath,
      [vitestBin, 'run', '--project', 'unit', '--reporter', 'dot', 'src/nb-git-wrapper.test.ts', '-t', 'a mutating command'],
      {
        cwd: root,
        env: { ...cleanEnv(), GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy, NB_MAX_LINES: '3', NB_ASCII: '1' },
        encoding: 'utf-8',
        timeout: 60000,
      },
    );

    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    // The filter must have selected a real seeding test, not zero tests.
    expect(r.stdout).toMatch(/Tests\s+1 passed/);
    expect(git('rev-parse', 'HEAD')).toBe(headBefore);
    expect(git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(readFileSync(configPath, 'utf-8')).toBe(configBefore);
  }, 60000); // spawns a whole nested vitest run: allow a loaded CI runner
});
