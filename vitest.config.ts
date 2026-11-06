import { defineConfig } from 'vitest/config';

/**
 * Base Vitest config — the FULL gate (`npm test`, CI). It keeps Vitest's defaults
 * (test discovery, the parallel worker pool, the default excludes) and runs every
 * suite, including the `[slow]` property/fuzz tests described below.
 *
 * ## The `test:fast` inner loop (issue #232)
 *
 * `npm test` runs the whole suite (~30s locally). Profiling showed the wall-time
 * cost is NOT spread across the child-process suites — those are 1–2.5s each and
 * run in parallel — but concentrated in a handful of **randomized property/fuzz
 * tests** that each perform hundreds of durable `fsync` writes (one invariant
 * sweep alone is ~19s). So `test:fast` (`vitest.fast.config.ts`) skips exactly the
 * tests whose title carries the ` [slow]` tag, giving a tight edit→test loop while
 * the full `npm test` and CI keep running them. The excluded set is defined in one
 * place — the ` [slow]` tag convention — not duplicated per script; to add a new
 * slow test to the fast-skip set, tag its title ` [slow]`.
 */
export default defineConfig({
  test: {},
});
