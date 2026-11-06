import { defineConfig } from 'vitest/config';

/**
 * Fast inner-loop config (issue #232): the full suite MINUS the ` [slow]`-tagged
 * tests. Those are the randomized property/fuzz tests whose hundreds of durable
 * `fsync` writes dominate wall time (see `vitest.config.ts`); dropping them takes
 * the local run from ~30s to a few seconds, keeping the edit→test loop tight.
 *
 * `testNamePattern` is a negative lookahead: run every test whose FULL name
 * (describe prefixes included) does NOT contain `[slow]`. A config file (selected
 * by `npm run test:fast`) rather than an inline CLI regex, so no shell has to quote
 * the pattern and the script stays cross-platform. The excluded set lives in one
 * place — the ` [slow]` tag on each slow test — so this file never lists them.
 */
export default defineConfig({
  test: {
    testNamePattern: '^(?!.*\\[slow\\]).*$',
  },
});
