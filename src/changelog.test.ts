import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #19: the repo ships a CHANGELOG in a
// recognizable Keep-a-Changelog shape, the README points at it, and the file
// is actually included in the published npm package (the whole motivation was
// that an npm user could not tell what changed between versions).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = () => readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');

describe('CHANGELOG.md', () => {
  test('exists at the repo root', () => {
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(true);
  });

  test('has an Unreleased heading', () => {
    expect(changelog()).toMatch(/^##\s*\[Unreleased\]/m);
  });

  test('lists the released 0.1.x versions', () => {
    const text = changelog();
    for (const v of ['0.1.0', '0.1.1', '0.1.2', '0.1.3']) {
      // Tagged releases are bracketed (and linked); untagged ones are plain.
      expect(text).toMatch(new RegExp(`^##\\s*\\[?${v.replace(/\./g, '\\.')}\\]?`, 'm'));
    }
  });

  test('is referenced by the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toContain('CHANGELOG.md');
  });

  test('is in the published package file list', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('CHANGELOG.md');
  });
});
