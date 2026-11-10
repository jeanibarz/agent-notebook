import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #231: a Vitest-free runtime smoke that
// actually RUNS the built CLI on the declared minimum engine (Node 18), wired
// into CI on the Node-18 leg. These tests themselves need Node 20.12+ (they run
// under Vitest), but they exercise the same script CI runs on 18 and verify it
// is correctly wired and dependency-free.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'smoke-node18.mjs');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');

describe('Node-18 runtime smoke (#231)', () => {
  test('the smoke script runs the built CLI and passes', () => {
    // `pretest` builds dist/ before the suite, so dist/cli.js exists here.
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(out).toContain('smoke-node18: PASS');
    // It must actually exercise each command named in the acceptance criteria.
    for (const needle of ['--version', '--help', 'add', 'show', 'search', 'vote']) {
      expect(out).toContain(needle);
    }
  });

  test('CI runs the smoke on the Node-18 leg only', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node scripts\/smoke-node18\.mjs/);
    // The smoke step and the `== 18` guard must be adjacent, so the smoke runs on
    // exactly the leg where `npm test` is skipped.
    const block = ci.slice(ci.indexOf('smoke-node18.mjs'));
    expect(block).toMatch(/if:\s*matrix\.node-version == 18/);
    // And `npm test` stays gated off the Node-18 leg.
    expect(ci).toMatch(/npm test[\s\S]*?if:\s*matrix\.node-version != 18/);
  });

  test('the release workflow gates publish on a Node-18 smoke leg (#301)', () => {
    const rel = read('.github/workflows/release.yml');
    const publishAt = rel.indexOf('\n  publish:');
    const verify = rel.slice(rel.indexOf('\n  verify:'), publishAt);
    // A matrix job that includes Node 18 and runs the smoke on that leg only...
    expect(verify).toMatch(/node-version:\s*\[[^\]]*\b18\b[^\]]*\]/);
    expect(verify).toMatch(/node scripts\/smoke-node18\.mjs\s*\n\s*if:\s*matrix\.node-version == 18/);
    // ...and publish cannot start until that job succeeds.
    const publish = rel.slice(publishAt);
    expect(publish).toMatch(/^\s+needs:\s*(verify|\[[^\]]*\bverify\b[^\]]*\])\s*$/m);
    expect(publish).toContain('npm publish');
  });

  test('the smoke stays dependency-free (only node: builtins)', () => {
    const src = read('scripts/smoke-node18.mjs');
    const imports = [...src.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).toMatch(/^node:/);
    }
  });
});
