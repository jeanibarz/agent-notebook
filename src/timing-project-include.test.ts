import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig from '../vitest.config.js';

/**
 * Drift guard for the issue #249 project split (vitest.config.ts).
 *
 * The full gate partitions tests into two projects by a title tag: the `unit`
 * project runs every test whose name does NOT carry the tag, and the `timing`
 * project runs the tagged ones with retry + a single worker. For speed, the
 * `timing` project lists its files explicitly in `include` instead of scanning
 * the whole tree. That creates a trap: a tagged test added to a file NOT in that
 * list is excluded from `unit` by the negative-lookahead AND never collected by
 * `timing`, so it silently runs in neither project.
 *
 * This test closes the trap: it finds every test file that uses the tag and
 * asserts the `timing` project's `include` covers it. If someone tags a test in a
 * new file, this fails until they add the file to `include`.
 *
 * NOTE: this file deliberately never spells the tag literally (the token is built
 * from parts below) so that scanning file contents for it does not match this
 * guard itself.
 */

// The timing tag, assembled so the literal does not appear in this file's source.
const TAG = `[${'timing'}]`;

const srcDir = dirname(fileURLToPath(import.meta.url));

describe('timing project include stays in sync with the tag (issue #249)', () => {
  test('every test file that uses the tag is listed in the timing project include', () => {
    const projects = (vitestConfig.test?.projects ?? []) as Array<{
      test?: { name?: string; include?: string[] };
    }>;
    const timing = projects.find((p) => p.test?.name === 'timing');
    expect(timing, 'a project named "timing" must be defined').toBeDefined();
    const include = timing!.test?.include ?? [];

    const taggedFiles = readdirSync(srcDir)
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) => readFileSync(join(srcDir, f), 'utf-8').includes(TAG))
      .map((f) => `src/${f}`)
      .sort();

    // Sanity: the known tagged files must be found, or the scan itself is broken
    // (e.g. the tag was renamed) and the guard would pass vacuously.
    expect(taggedFiles).toContain('src/notebook.test.ts');
    expect(taggedFiles).toContain('src/timing-retry.test.ts');

    // The real guard: nothing tagged is left out of the timing project.
    for (const f of taggedFiles) {
      expect(
        include,
        `${f} contains a tagged test but is not in the timing project include — it would run in neither project`,
      ).toContain(f);
    }
  });
});
