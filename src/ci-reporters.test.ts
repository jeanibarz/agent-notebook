import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig, { resolveReporters } from '../vitest.config';

// Drift guard for issue #248: a failing PR CI matrix leg must surface a
// machine-readable failing-test identity instead of forcing a raw-log scroll.
// Two mechanisms carry that, and this test pins both so they cannot silently
// regress:
//   1. vitest.config.ts enables the `github-actions` + `junit` reporters in CI
//      (and ONLY the default reporter locally, so local output is unchanged).
//   2. .github/workflows/ci.yml uploads the JUnit result as an artifact, but
//      only on failure.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveReporters (vitest.config.ts)', () => {
  test('in GitHub Actions, enables github-actions + junit on top of default', () => {
    const reporters = resolveReporters({ GITHUB_ACTIONS: 'true' });
    expect(reporters).toContain('default');
    // Acceptance: a forced failure annotates the PR (github-actions reporter)
    // and a machine-readable JUnit file is produced (junit reporter).
    expect(reporters).toContain('github-actions');
    expect(reporters).toContain('junit');
  });

  test('outside GitHub Actions, only the default reporter runs (local unchanged)', () => {
    // Empty env, and the explicit non-"true" cases, must all stay default-only
    // so local console output and speed are exactly as before.
    for (const env of [{}, { GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: '1' }]) {
      const reporters = resolveReporters(env);
      expect(reporters).toEqual(['default']);
    }
  });

  test('the exported config actually wires in resolveReporters and the junit output path', () => {
    // Guard the WIRING, not just the helper: if someone drops the
    // resolveReporters() call or the junit outputFile, the #248 mechanism is
    // dead even though resolveReporters still returns the right list.
    expect(vitestConfig.test?.reporters).toEqual(resolveReporters());
    expect(vitestConfig.test?.outputFile).toEqual({ junit: './junit.xml' });
  });
});

describe('CI workflow JUnit artifact (.github/workflows/ci.yml)', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

  // Isolate the single upload step so every assertion is checked against THAT
  // step, not some unrelated step elsewhere in the workflow. The block runs
  // from its `- name:` to the next top-level `- ` step (or end of file).
  function uploadStepBlock(): string {
    const start = ci.indexOf('- name: Upload JUnit test results');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = ci.slice(start + 1);
    const nextStep = rest.search(/\n {6}- /);
    return nextStep === -1 ? ci.slice(start) : ci.slice(start, start + 1 + nextStep);
  }

  test('uploads a JUnit artifact only on failure', () => {
    const block = uploadStepBlock();
    expect(block).toMatch(/uses:\s*actions\/upload-artifact@[0-9a-f]{40}/);
    expect(block).toMatch(/path:\s*junit\.xml/);
    // The upload must be gated on failure() so green runs upload nothing.
    expect(block).toMatch(/if:\s*failure\(\)/);
    // And skipped on the Node 18 leg, where `npm test` never runs.
    expect(block).toMatch(/matrix\.node-version\s*!=\s*18/);
  });

  test('artifact name is unique per matrix leg so uploads never collide', () => {
    expect(uploadStepBlock()).toMatch(
      /name:\s*junit-\$\{\{\s*matrix\.os\s*\}\}-node\$\{\{\s*matrix\.node-version\s*\}\}/,
    );
  });
});
