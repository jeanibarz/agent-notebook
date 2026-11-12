import { defineConfig } from 'vitest/config';

/**
 * Fast inner-loop config (issue #232): the full suite MINUS the ` [slow]`- and
 * ` [timing]`-tagged tests.
 *
 *   - ` [slow]` are the randomized property/fuzz tests whose hundreds of durable
 *     `fsync` writes dominate wall time (see `vitest.config.ts`).
 *   - ` [timing]` are the real-clock upper-bound / cross-process tests (issue
 *     #249). They are the flake-prone ones under load and buy little in a tight
 *     edit→test loop; the full `npm test` still runs them (retried, single-worker
 *     — see `vitest.config.ts`).
 *
 * Dropping both keeps the local run at a few seconds. This config does NOT use the
 * project split — it is a single fast pass, so the `[timing]` tests get no retry
 * here; that protection lives in the full gate.
 *
 * `testNamePattern` is a negative lookahead: run every test whose FULL name
 * (describe prefixes included) contains neither `[slow]` nor `[timing]`. A config
 * file (selected by `npm run test:fast`) rather than an inline CLI regex, so no
 * shell has to quote the pattern and the script stays cross-platform. The excluded
 * set lives in one place — the ` [slow]` / ` [timing]` tags on each test — so this
 * file never lists them.
 */
export default defineConfig({
  test: {
    // Issue #420: same stale-`dist/` guard as the base config.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    testNamePattern: '^(?!.*\\[(?:slow|timing)\\]).*$',
  },
});
