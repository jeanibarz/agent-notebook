import { defineConfig } from 'vitest/config';

/**
 * Base Vitest config — the FULL gate (`npm test`, CI). It runs every suite,
 * including the `[slow]` property/fuzz tests described below, split across two
 * projects (see "Flaky wall-clock timing tests" for the `[timing]` split).
 *
 * ## Flaky wall-clock timing tests (issue #249)
 *
 * A handful of tests assert real-clock **upper bounds** — e.g. the lock-steal
 * test expects a crashed holder's lock to be reclaimed in well under 2s, and the
 * cross-process usage/lock tests spawn 8–12 real `nb` children. Those bounds only
 * break when a loaded runner stalls the event loop: under unbounded Vitest
 * parallelism a constrained CI leg oversubscribes its cores and one such test
 * overshoots, reddening a green commit on a single matrix leg with no retry (the
 * macos flake on run 42136281826). The fix is two-pronged and scoped so it cannot
 * mask a real logic regression:
 *
 *   - Those tests carry a ` [timing]` tag and run in a dedicated **`timing`**
 *     project with `retry: 2` — a transient stall is re-run and passes, while a
 *     genuine, repeatable failure still fails all three attempts.
 *   - The `timing` project runs its files serially in a **single worker**
 *     (`fileParallelism: false`) so the wall-clock suite does not oversubscribe by
 *     racing its own child-process tests against each other.
 *   - Every other test runs in the **`unit`** project with Vitest's normal
 *     parallel pool and **no retry**, so logic regressions surface immediately and
 *     the full suite stays fast. Retry is deliberately NOT global.
 *
 * The ` [timing]` tag is the single source of truth for the split: tag a new
 * wall-clock test's title ` [timing]` (and, if it lives outside the files the
 * `timing` project `include`s, add its file there) to move it into the retried,
 * single-worker suite.
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
 *
 * ## CI failing-test identity (issue #248)
 *
 * `reporters` is environment-driven (see `resolveReporters`): inside GitHub
 * Actions the `github-actions` and `junit` reporters are added on top of the
 * default so a red matrix leg annotates the failing test inline on the PR and
 * writes a machine-readable `junit.xml` (uploaded as an artifact on failure by
 * `.github/workflows/ci.yml`). Locally only the default reporter runs, so console
 * output and timing are unchanged and no `junit.xml` is written.
 *
 * ## On-demand coverage (issue #233)
 *
 * The `coverage` block below only takes effect when a run passes `--coverage`
 * (`npm run test:coverage`) — Vitest leaves coverage OFF by default, so `npm test`
 * and CI pay nothing for it. It is deliberately NOT gated on PR CI: coverage runs
 * on demand / at release (`.github/workflows/coverage.yml`) so the per-PR pipeline
 * stays fast and non-flaky, with no threshold gate. The provider is V8 (ships with
 * `@vitest/coverage-v8`, a dev-only dependency — the package itself stays zero-dep).
 */

// Built-in vitest reporters this project selects between. Kept as a narrow
// union so `resolveReporters` stays type-checked against real reporter names.
type BuiltinReporter = 'default' | 'github-actions' | 'junit';

/**
 * Choose test reporters from the environment so local runs stay untouched.
 *
 * Issue #248: when one PR CI matrix leg failed, nothing surfaced a
 * machine-readable failing-test identity — triage meant opening that one red
 * leg's raw log. Inside GitHub Actions (`GITHUB_ACTIONS=true`, which Actions
 * always sets on hosted and self-hosted runners) we add, on top of `default`:
 *   - `github-actions`: emits `::error::` workflow commands so each failing
 *     test is annotated inline on the PR, naming the test (no log scroll).
 *   - `junit`: writes a machine-readable result file that the CI workflow
 *     uploads as an artifact on failure (see `.github/workflows/ci.yml`).
 *
 * Outside CI only the `default` reporter runs, so local console output and
 * speed are exactly as before and no `junit.xml` is written locally.
 */
export function resolveReporters(
  env: NodeJS.ProcessEnv = process.env,
): BuiltinReporter[] {
  if (env.GITHUB_ACTIONS === 'true') {
    return ['default', 'github-actions', 'junit'];
  }
  return ['default'];
}

// A test whose FULL name (describe prefixes included) carries the ` [timing]`
// tag is a real-clock bound test (issue #249) and runs in the retried,
// single-worker `timing` project; everything else runs in the parallel, no-retry
// `unit` project. Kept as one regex source so both projects stay in lockstep.
const TIMING_TAG = '\\[timing\\]';

export default defineConfig({
  test: {
    // Issue #420: rebuild a missing/stale `dist/` before the suites exec it, so a
    // bare `npx vitest run` never tests an old build. No-op when dist/ is current.
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    // Reporters, outputFile and coverage are run-global: they stay at the root
    // (not inside a project) so the aggregate run annotates/records once and the
    // #248 and #233 wiring is unchanged by the #249 project split.
    reporters: resolveReporters(),
    // Only consulted when the `junit` reporter is active (i.e. in CI). Written
    // to the repo root under a stable name so the upload-artifact step can pick
    // it up by path.
    outputFile: { junit: './junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'html', 'lcov'],
      // Measure the shipped library/CLI source only; the test files and the
      // dev-only scripts/config are not the thing whose coverage we track.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    // Issue #249: two projects sharing this file's global config. See the module
    // doc comment for why. Tests are partitioned by the ` [timing]` title tag so
    // no test runs in both projects.
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          // Everything EXCEPT the [timing] tests: the full logic/property suite,
          // run with Vitest's normal parallel pool and no retry.
          // @ts-expect-error — vitest's project types omit `testNamePattern`, but it is honoured per project at runtime (the unit/timing split depends on it)
          testNamePattern: `^(?!.*${TIMING_TAG}).*$`,
        },
      },
      {
        test: {
          name: 'timing',
          // Only the files that hold [timing] tests, so this project does not
          // re-transform the whole tree just to run a few tests.
          include: ['src/notebook.test.ts', 'src/nb-retrospective.test.ts', 'src/timing-retry.test.ts'],
          // @ts-expect-error — same: accepted per project at runtime, missing from the types
          testNamePattern: TIMING_TAG,
          // Re-run a wall-clock test that lost a scheduling race; a real,
          // repeatable failure still fails every attempt (issue #249).
          retry: 2,
          // Run this project's wall-clock test files serially in a single worker
          // so they cannot oversubscribe by racing their own child-process tests
          // against each other.
          fileParallelism: false,
        },
      },
    ],
  },
});
