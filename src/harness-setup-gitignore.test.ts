import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// Guards the acceptance criteria of issue #203: the git-versioning recipe's
// .gitignore in docs/harness-setup.md must ignore every transient runtime file
// NB_DIR accumulates — including the `.nb-usage.log.count` sidecar (#135) and
// the `.nb-backup.cron.log` the cron example writes — so a recipe-initialized
// store stays diff-clean. We assert against real `git check-ignore` using the
// patterns extracted verbatim from the doc, so the test tracks whatever the
// recipe actually tells users to write.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Pull the single-quoted tokens the recipe's `printf ... > .gitignore` writes. */
function recipeGitignorePatterns(): string[] {
  const doc = readFileSync(join(root, 'docs', 'harness-setup.md'), 'utf-8');
  const line = doc
    .split('\n')
    .find((l) => l.includes('printf') && l.includes('> .gitignore'));
  expect(line, 'recipe should contain a `printf ... > .gitignore` line').toBeTruthy();
  const tokens = [...line!.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  // Drop the printf format string (`%s\n`); keep the pattern operands.
  return tokens.filter((t) => t !== '%s\\n');
}

// Files that MUST be ignored — the transient runtime surface of NB_DIR.
const MUST_IGNORE = [
  '.nb-usage.log',
  '.nb-usage.log.count', // the #135 sidecar, churns on every `nb` call
  '.nb.lock',
  'scratch.tmp', // matches *.tmp
  '.nb-usage.log.12345.tmp', // per-pid temp (also *.tmp)
  '.retro-abc', // matches .retro-*
  '.nb-backup.log',
  '.nb-backup.log.1', // rotated backup log
  '.nb-backup.cron.log', // the cron example's redirect target
];

// Files that MUST stay tracked — real notebook content and repo files.
const MUST_TRACK = ['build-and-test.md', 'code-review.md', 'README.md'];

describe('harness-setup.md git-versioning .gitignore recipe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nb-gitignore-'));
  let gitAvailable = true;

  beforeAll(() => {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      // Keep the probe hermetic regardless of the host's global gitignore.
      execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: dir });
    } catch {
      gitAvailable = false;
    }
    writeFileSync(join(dir, '.gitignore'), recipeGitignorePatterns().join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** True when git treats `name` as ignored in the recipe-initialized dir. */
  function isIgnored(name: string): boolean {
    const res = spawnSync('git', ['check-ignore', '-q', '--', name], { cwd: dir });
    return res.status === 0;
  }

  test('the recipe writes a non-trivial pattern list', () => {
    const patterns = recipeGitignorePatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(5);
  });

  test.each(MUST_IGNORE)('ignores transient file %s', (name) => {
    if (!gitAvailable) return; // no git in env — skip rather than false-fail
    expect(isIgnored(name)).toBe(true);
  });

  test.each(MUST_TRACK)('keeps %s tracked', (name) => {
    if (!gitAvailable) return;
    expect(isIgnored(name)).toBe(false);
  });
});
