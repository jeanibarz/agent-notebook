import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDistStale, scrubInheritedEnv } from '../scripts/vitest-global-setup.mjs';

// Issue #420: bare `npx vitest run` must not test a stale `dist/`. The global
// setup rebuilds only when dist/cli.js is missing or older than a src/ file.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

let root: string;
const touch = (rel: string, secondsAgo: number) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(p, t, t);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nb-dist-stale-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('isDistStale', () => {
  test('stale when dist/cli.js is missing', () => {
    touch('src/cli.ts', 10);
    expect(isDistStale(root)).toBe(true);
  });

  test('stale when a src file (also nested) is newer than dist/cli.js', () => {
    touch('dist/cli.js', 100);
    touch('src/cli.ts', 200);
    touch('src/lib/deep.ts', 5);
    expect(isDistStale(root)).toBe(true);
  });

  test('current when dist/cli.js is newer than every src file', () => {
    touch('src/cli.ts', 200);
    touch('src/lib/deep.ts', 150);
    touch('dist/cli.js', 100);
    expect(isDistStale(root)).toBe(false);
  });

  test('editing only a *.test.ts file does not make dist stale (tsc excludes tests)', () => {
    touch('src/cli.ts', 200);
    touch('dist/cli.js', 100);
    touch('src/cli.test.ts', 1);
    expect(isDistStale(root)).toBe(false);
  });
});

describe('vitest config wiring', () => {
  test('the root config registers the global setup', () => {
    const cfg = readFileSync(join(repo, 'vitest.config.ts'), 'utf8');
    expect(cfg).toMatch(/globalSetup:\s*\[?\s*['"]\.\/scripts\/vitest-global-setup\.mjs['"]/);
  });

  test('the fast config registers it too (npm run test:fast is a bare vitest call)', () => {
    const cfg = readFileSync(join(repo, 'vitest.fast.config.ts'), 'utf8');
    expect(cfg).toMatch(/globalSetup/);
  });
});

// Issue #481: the global setup deletes inherited GIT_* and NB_* variables before
// any worker starts, so a hook's GIT_DIR or an ambient NB_MAX_LINES cannot reach
// the fixtures. The end-to-end decoy check lives in test-env-scrub.test.ts.
describe('scrubInheritedEnv', () => {
  test('removes every GIT_* and NB_* variable and keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/x/.git',
      GIT_WORK_TREE: '/x',
      GIT_INDEX_FILE: '/x/.git/index',
      GIT_CONFIG_GLOBAL: '/x/gitconfig',
      NB_DIR: '/nb',
      NB_MAX_LINES: '3',
      PATH: '/bin',
      HOME: '/home/u',
      MY_GIT_DIR: 'kept',
      NBX: 'kept',
      git_dir: 'kept',
    };
    expect(scrubInheritedEnv(env).sort()).toEqual(
      ['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'NB_DIR', 'NB_MAX_LINES'],
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', MY_GIT_DIR: 'kept', NBX: 'kept', git_dir: 'kept' });
  });

  test('the default export scrubs process.env before the dist check', () => {
    const src = readFileSync(join(repo, 'scripts', 'vitest-global-setup.mjs'), 'utf8');
    const body = src.slice(src.indexOf('export default function setup'));
    expect(body.indexOf('scrubInheritedEnv()')).toBeGreaterThan(-1);
    expect(body.indexOf('scrubInheritedEnv()')).toBeLessThan(body.indexOf('isDistStale()'));
  });
});
