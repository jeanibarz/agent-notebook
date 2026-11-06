import { describe, test, expect } from 'vitest';

/**
 * Executable proof that the bounded `retry` configured for the `timing` project
 * (see vitest.config.ts, issue #249) actually rescues a transient event-loop
 * stall — the failure shape that reds a single CI leg on the real wall-clock
 * tests (lock-steal / cross-process) when a loaded runner oversubscribes its
 * cores.
 *
 * The test seeds exactly that stall on its FIRST attempt: it blocks the event
 * loop well past a tight upper bound, so the same `toBeLessThan` assertion the
 * real timing tests use fails. The `timing` project's `retry` re-runs it; the
 * second attempt injects no stall, so the bound holds and the test passes.
 *
 * Two regressions it guards against:
 *   - If `retry` is dropped from the `timing` project, attempt 1 is the only
 *     attempt and this test fails — so the flake protection cannot rot silently.
 *   - The `attempts >= 2` assertion proves the pass came THROUGH a retry, not
 *     from the first attempt accidentally meeting the bound.
 *
 * A genuine regression (a stall on EVERY attempt) would still exhaust the retries
 * and fail, so the retry masks only non-repeatable scheduling hiccups.
 *
 * The title carries the ` [timing]` tag so this file runs only in the retried,
 * single-worker `timing` project; the `unit` project skips it.
 */
describe('timing retry rescues a seeded event-loop stall (issue #249)', () => {
  // These persist across the retries of the single test below (same module
  // instance, same worker). Not shared with any other test.
  let attempts = 0;
  let stallInjected = false;

  test('a stalled wall-clock bound passes once the bounded retry re-runs it [timing]', () => {
    attempts++;
    // A wide margin between the bound and the stall: the unstalled retry only does
    // a couple of `Date.now()` calls, so it clears a 100ms bound with ~100x
    // headroom even on a loaded runner, while the 500ms stall blows it decisively.
    // This keeps the test itself from flaking on the very runners it protects.
    const UPPER_BOUND_MS = 100;
    const start = Date.now();
    if (attempts === 1) {
      // Emulate a loaded-runner stall: hold the event loop past the bound. A busy
      // wait (not a timer) mirrors the CPU oversubscription that makes the real
      // timing tests overshoot their wall-clock budgets.
      stallInjected = true;
      const stallUntil = Date.now() + UPPER_BOUND_MS * 5;
      while (Date.now() < stallUntil) {
        /* spin — the seeded stall */
      }
    }
    const elapsed = Date.now() - start;

    // Same assertion shape as the real wall-clock tests (an upper bound). Fails on
    // the stalled first attempt; holds on the unstalled retry.
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS);
    // Reached only because a retry ran: proves the pass came from the retry, not
    // from attempt 1 somehow meeting the bound, and that the stall path really ran
    // (so the test can never pass without having exercised the failure it rescues).
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(stallInjected).toBe(true);
  });
});
