import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #212: the repo ships GitHub issue
// templates so external reports arrive structured. Opening a new issue must
// offer a Bug and a Feature template; the bug template must prompt for
// `nb --version`, the OS, and a minimal repro; and config.yml must route
// security reports to SECURITY.md (not a public issue).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tplDir = join(root, '.github', 'ISSUE_TEMPLATE');
const read = (name: string) => readFileSync(join(tplDir, name), 'utf-8');

describe('.github/ISSUE_TEMPLATE', () => {
  test('offers both a Bug and a Feature template', () => {
    expect(existsSync(join(tplDir, 'bug_report.md'))).toBe(true);
    expect(existsSync(join(tplDir, 'feature_request.md'))).toBe(true);
    // The front-matter `name:` is what GitHub shows on the chooser.
    expect(read('bug_report.md')).toMatch(/^name:\s*Bug report\s*$/m);
    expect(read('feature_request.md')).toMatch(/^name:\s*Feature request\s*$/m);
  });

  test('each template carries a labels: front-matter field', () => {
    expect(read('bug_report.md')).toMatch(/^labels:\s*bug\s*$/m);
    expect(read('feature_request.md')).toMatch(/^labels:\s*enhancement\s*$/m);
  });

  test('the bug template prompts for nb --version, the OS, and a minimal repro', () => {
    const bug = read('bug_report.md');
    expect(bug).toContain('nb --version');
    expect(bug).toMatch(/OS/);
    expect(bug.toLowerCase()).toContain('repro');
  });

  test('config.yml routes security reports to SECURITY.md via a contact link', () => {
    const cfg = read('config.yml');
    // The routing must be a real contact_links URL, not a passing mention in a
    // comment — assert SECURITY.md is the target of a `url:` line.
    expect(cfg).toContain('contact_links:');
    expect(cfg).toMatch(/^\s*url:\s*\S*SECURITY\.md\s*$/m);
  });

  test('config.yml keeps the blank-issue escape hatch open so small reports are not deterred', () => {
    expect(read('config.yml')).toMatch(/^blank_issues_enabled:\s*true\s*$/m);
  });

  test('the files config.yml links to actually exist', () => {
    // A contact_link pointing at a missing path would 404 for every reporter.
    expect(existsSync(join(root, 'SECURITY.md'))).toBe(true);
    expect(existsSync(join(root, 'docs', 'requirements.md'))).toBe(true);
  });
});
