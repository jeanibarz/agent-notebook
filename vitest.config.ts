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

export default defineConfig({
  test: {
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
  },
});
