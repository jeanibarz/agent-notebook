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
      // Anchor the end of the version so a prefix match can't pass: without the
      // trailing boundary, the `0.1.1` check would also be satisfied by a future
      // `## 0.1.13` heading even if 0.1.1 itself were missing from the file.
      expect(text).toMatch(new RegExp(`^##\\s*\\[?${v.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm'));
    }
  });

  test('has a released heading for the current package.json version', () => {
    // Issue #276: the checks above pin `[Unreleased]` and the literal historical
    // 0.1.x headings, but nothing tied the version the package actually ships
    // under to a *released* CHANGELOG section. A version bump that forgot to cut
    // the section — leaving the notes under `[Unreleased]`, or absent — passed
    // the whole suite and rode straight into a release (release.yml runs the
    // tests), the exact drift the CHANGELOG exists to prevent.
    const version: string = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf-8'),
    ).version;
    // Escape every regex metacharacter, not just `.`, so a version carrying
    // build metadata (e.g. `1.0.0+build`) can't smuggle a quantifier into the
    // pattern and mis-match.
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A released section carries the concrete version number — bracketed (and
    // linked) once tagged, or plain beforehand: `## [0.7.0]` or `## 0.7.0`. The
    // trailing boundary anchors the end of the version so a prefix can't pass:
    // without it `0.7.0` would also be satisfied by a future `## [0.7.01]`
    // heading even if 0.7.0 itself were missing (mirrors the 0.1.x guard above).
    const releasedHeading = new RegExp(`^##\\s*\\[?${escaped}\\]?(?:\\s|$)`, 'm');
    expect(
      changelog(),
      `CHANGELOG.md has no released heading for package.json version ${version} — cut its notes out of [Unreleased] before releasing`,
    ).toMatch(releasedHeading);
    // The matcher must be specific to the version: the `## [Unreleased]` stub
    // must never satisfy it, or notes left under Unreleased would count as
    // released — the exact drift this test exists to catch. This bites if the
    // matcher is ever loosened to accept any heading.
    expect('## [Unreleased]').not.toMatch(releasedHeading);
  });

  test('is referenced by the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toContain('CHANGELOG.md');
  });

  test('is in the published package file list', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('CHANGELOG.md');
  });
});
