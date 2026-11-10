import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #233: on-demand/release coverage
// reporting (V8) that does NOT gate the per-PR pipeline. These assert the wiring
// is present and, crucially, that it stays OFF the pull_request path so PR CI
// timing and gating are unchanged.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const pkg = () => JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('coverage tooling (#233)', () => {
  test('npm run test:coverage runs vitest with --coverage behind the Node guard', () => {
    expect(pkg().scripts['test:coverage']).toBe(
      'node scripts/check-node-for-tests.mjs && vitest run --coverage',
    );
  });

  test('the V8 coverage provider is a DEV dependency, keeping the package zero-runtime-dep', () => {
    const p = pkg();
    expect(p.devDependencies?.['@vitest/coverage-v8']).toBeDefined();
    // DP-7 / NFR-PORT-001: the shipped package has no runtime dependencies.
    expect(p.dependencies ?? {}).toEqual({});
    expect(p.dependencies?.['@vitest/coverage-v8']).toBeUndefined();
  });

  test('vitest config selects the v8 provider and writes to ./coverage', () => {
    const cfg = read('vitest.config.ts');
    expect(cfg).toMatch(/provider:\s*'v8'/);
    expect(cfg).toMatch(/reportsDirectory:\s*'\.\/coverage'/);
  });

  test('coverage output is git-ignored', () => {
    expect(read('.gitignore')).toMatch(/^coverage\/$/m);
  });

  test('a dedicated workflow runs on demand / at release and uploads the report', () => {
    const wf = read('.github/workflows/coverage.yml');
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).toMatch(/release:/);
    expect(wf).toMatch(/npm run test:coverage/);
    expect(wf).toMatch(/upload-artifact/);
    expect(wf).toMatch(/path:\s*coverage\//);
  });

  test('the coverage workflow does NOT run on pull_request or push (PR pipeline untouched)', () => {
    // Inspect the trigger block (everything before the first job key) with
    // comment lines stripped, so the assertion sees the actual YAML directives
    // and not explanatory prose that may name these triggers to say it avoids them.
    const wf = read('.github/workflows/coverage.yml');
    const onBlock = wf
      .slice(0, wf.indexOf('\njobs:'))
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(onBlock).not.toMatch(/pull_request/);
    expect(onBlock).not.toMatch(/^\s*push:/m);
  });

  test('the per-PR CI pipeline adds no coverage step', () => {
    // Acceptance: "PR CI timing and gating are unchanged (no new per-PR coverage
    // step)." The whole ci.yml must stay coverage-free.
    expect(read('.github/workflows/ci.yml').toLowerCase()).not.toContain('coverage');
  });
});
