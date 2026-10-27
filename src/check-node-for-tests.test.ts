import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeSupportsTests, UNSUPPORTED_MESSAGE } from '../scripts/check-node-for-tests.mjs';

// Guards the acceptance criteria of issue #44: on Node 18 (the declared minimum
// engine) `npm test` must exit 1 with a one-line explanation before vitest
// loads, instead of crashing with an opaque `styleText` bundler stack trace;
// on Node 20.12+ it behaves as before; and `engines` stays `>=18`.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(root, 'scripts', 'check-node-for-tests.mjs');

// The exact text the issue fixes. Asserting against this literal — not the
// imported constant — means rewording or emptying the constant is caught.
const EXPECTED_MESSAGE = 'tests require Node 20.12+; the library still claims runtime >=18';

describe('nodeSupportsTests', () => {
  // styleText landed in node:util on 20.12.0, so that is the floor.
  test.each([
    ['18.20.4', false],
    ['20.0.0', false],
    ['20.11.1', false],
    ['20.12.0', true],
    ['20.19.0', true],
    ['22.0.0', true],
    ['24.11.1', true],
  ])('%s -> %s', (version, supported) => {
    expect(nodeSupportsTests(version as string)).toBe(supported);
  });

  test('the exported message is exactly the wording the issue specifies', () => {
    expect(UNSUPPORTED_MESSAGE).toBe(EXPECTED_MESSAGE);
  });

  test('malformed or missing versions fail closed (unsupported)', () => {
    expect(nodeSupportsTests('')).toBe(false);
    expect(nodeSupportsTests('v20.12.0')).toBe(false);
    // @ts-expect-error exercising a non-string input
    expect(nodeSupportsTests(undefined)).toBe(false);
  });
});

describe('check-node-for-tests.mjs CLI', () => {
  test('exits 1 with only the one-line message on simulated Node 18', () => {
    let caught: { status?: number; stderr?: string; stdout?: string } | undefined;
    try {
      execFileSync(process.execPath, [guard], {
        env: { ...process.env, NB_TEST_NODE_VERSION: '18.20.4' },
        encoding: 'utf-8',
      });
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught, 'guard should have exited non-zero').toBeDefined();
    expect(caught!.status).toBe(1);
    expect(caught!.stderr?.trim()).toBe(EXPECTED_MESSAGE);
    expect(caught!.stdout).toBe('');
  });

  test('exits 0 with no output on a simulated supported Node', () => {
    const out = execFileSync(process.execPath, [guard], {
      env: { ...process.env, NB_TEST_NODE_VERSION: '22.0.0' },
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });

  test('exits 0 on the real Node with no override (the suite runs on >=20.12)', () => {
    // Exercises the production `process.versions.node` path, not just the test
    // hook. This suite can only execute on a supported Node, so exit 0 is the
    // only correct outcome here.
    const env = { ...process.env };
    delete env.NB_TEST_NODE_VERSION;
    const out = execFileSync(process.execPath, [guard], { env, encoding: 'utf-8' });
    expect(out).toBe('');
  });
});

describe('package.json test wiring (issue #44)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

  test('engines stays >=18 (the guard does not raise the minimum runtime)', () => {
    expect(pkg.engines.node).toBe('>=18');
  });

  test('`npm test` chains the guard before vitest with && so a failed guard blocks vitest', () => {
    // Exact match on purpose: a `;` or `||` separator, or a reorder, would let
    // vitest load on Node 18 and still pass a looser substring/index check.
    expect(pkg.scripts.test).toBe('node scripts/check-node-for-tests.mjs && vitest run');
  });
});
