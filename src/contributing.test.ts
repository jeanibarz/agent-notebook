import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #47: the repo ships a dedicated
// CONTRIBUTING.md (GitHub's community-health entry point), it names the build/
// test commands, the Node 20+ test-runner fact, and the requirements spec, and
// the README points first-time contributors at it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const contributing = () => readFileSync(join(root, 'CONTRIBUTING.md'), 'utf-8');

describe('CONTRIBUTING.md', () => {
  test('exists at the repo root', () => {
    expect(existsSync(join(root, 'CONTRIBUTING.md'))).toBe(true);
  });

  test('names the build and test commands', () => {
    const text = contributing();
    expect(text).toContain('npm run build');
    expect(text).toContain('npm test');
  });

  test('records that the test runner needs Node 20.12+', () => {
    // The package runs on Node >=18 but vitest 5 needs node:util styleText,
    // which only exists on 20.12+ — the fact new contributors most need.
    expect(contributing()).toMatch(/20\.12/);
  });

  test('points at the requirements spec as the source of truth', () => {
    expect(contributing()).toContain('docs/requirements.md');
  });

  test('is linked from the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toContain('CONTRIBUTING.md');
  });
});
