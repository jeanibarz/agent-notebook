import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #559: the workflow that installs the plugin from a real marketplace on three systems, and
// the CI leg that runs the hook entry on Node 12 and 16. The workflows are read as text, with a
// tiny indentation reader, not with a YAML library (the package has no such dependency). A change
// that breaks one of these pins changes who can write to the repository or what the test proves, so it
// should be a decision, not an accident.
const here = dirname(fileURLToPath(import.meta.url));
// A Windows checkout gives CRLF; everything below reads LF.
const read = (file: string): string => readFileSync(join(here, '..', file), 'utf-8').replace(/\r\n/g, '\n');
const e2e = read('.github/workflows/plugin-e2e.yml');
const ci = read('.github/workflows/ci.yml');

/** The lines of the block under `key:` at `indent` spaces (up to the next line indented that much or less). */
function block(text: string, key: string, indent: number): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${' '.repeat(indent)}${key}:` || l.startsWith(`${' '.repeat(indent)}${key}: `));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}
const code = (text: string): string => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const listItems = (lines: string[]): string[] => lines.map((l) => /^\s*- (.*)$/.exec(l)?.[1]?.replace(/^'(.*)'$/, '$1')).filter((x): x is string => x !== undefined);

describe('the plugin end-to-end workflow (FR-PLUGIN-005, issue #559)', () => {
  test('it has no permission at the top: every job asks for what it needs', () => {
    expect(code(e2e)).toMatch(/^permissions: \{\}$/m);
    // The build job reads the repository; the matrix job asks for nothing at all.
    const jobs = block(e2e, 'jobs', 0);
    expect(block(jobs.join('\n'), 'e2e', 2).join('\n')).not.toMatch(/permissions:/);
  });

  test('it runs on the three systems', () => {
    const matrix = block(block(e2e, 'jobs', 0).join('\n'), 'e2e', 2).join('\n');
    expect(matrix).toMatch(/os: \[ubuntu-latest, macos-latest, windows-latest\]/);
    expect(matrix).toMatch(/fail-fast: false/);
  });

  test('it runs for the plugin and its inputs, not for src/', () => {
    const on = block(e2e, 'on', 0).join('\n');
    for (const trigger of ['pull_request', 'push']) {
      const paths = listItems(block(block(on, trigger, 2).join('\n'), 'paths', 4));
      expect(paths).toEqual(expect.arrayContaining(['plugin/**', '.claude-plugin/**', 'examples/hooks/claude-code/**', 'scripts/build-plugin.mjs', 'scripts/plugin-e2e/**', 'package.json', 'package-lock.json', '.github/workflows/plugin-e2e.yml']));
      expect(paths.some((p) => p.startsWith('src/'))).toBe(false);
    }
  });

  test('it also runs nightly and by hand, once a night', () => {
    expect(e2e).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(e2e.match(/^ {4}- cron: /gm)).toHaveLength(1);
  });

  test('every checkout drops the repository credentials', () => {
    const lines = e2e.split('\n');
    const checkouts = lines.map((l, i) => (l.includes('actions/checkout@') ? i : -1)).filter((i) => i >= 0);
    expect(checkouts.length).toBeGreaterThanOrEqual(2);
    for (const i of checkouts) expect(lines.slice(i + 1, i + 4).join('\n')).toMatch(/persist-credentials: false/);
  });

  test('Claude Code is pinned, and only the nightly run takes the latest', () => {
    expect(e2e).toMatch(/^ {2}CLAUDE_VERSION: \$\{\{ github\.event_name == 'schedule' && 'latest' \|\| '\d+\.\d+\.\d+' \}\}$/m);
  });

  test('it holds no secret, no login and no pull_request_target', () => {
    const text = code(e2e);
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request_target/);
    expect(text).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|claude (auth )?login/);
  });

  test('a pull request cancels its own superseded run', () => {
    expect(e2e).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  });

  test('it builds the two fixture versions that the drivers expect', () => {
    expect(e2e).toContain('--version 0.0.1-e2e.1');
    expect(e2e).toContain('--version 0.0.1-e2e.2');
    expect(e2e).toContain('bash scripts/plugin-e2e/run.sh');
    expect(e2e).toContain('run.ps1 -BuildDir');
  });
});

describe('the old-node-entry leg (FR-PLUGIN-002, issue #559)', () => {
  test('it runs the hook entry on Node 12 and Node 16', () => {
    const leg = block(block(ci, 'jobs', 0).join('\n'), 'old-node-entry', 2).join('\n');
    expect(leg).toMatch(/node-version: \[12, 16\]/);
    expect(leg).toContain('nb-hook-entry.cjs');
    expect(leg).toMatch(/persist-credentials: false/);
  });
});
