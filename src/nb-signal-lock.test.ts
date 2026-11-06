import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { releaseHeldLock, withLock } from './notebook.js';
import { installSignalLockRelease } from './cli.js';

// The built CLI, used to drive the signal handler in a REAL child process (the
// handler only fires for an actual OS signal, and only the entrypoint under
// `isMainModule()` installs it). `pretest` builds dist first.
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

// Issue #247: an interrupt (Ctrl-C / SIGTERM) delivered while a mutation holds the
// mkdir lock used to terminate the process via the signal's default disposition,
// skipping withLock's `finally` release and stranding `.nb.lock` until the next
// caller could steal it (staleLockMs + lockGraceMs ≈ 12s). The fix tracks lock
// ownership in notebook.ts and installs SIGINT/SIGTERM handlers in cli.ts that
// release only a lock THIS process owns, then exit 128+signo.

describe('installSignalLockRelease — wiring (issue #247)', () => {
  // Driven with a fake emitter and injected release/onExit spies so the handler
  // logic is tested without delivering real signals to the test runner. Mirrors
  // the installPipeGuards unit tests.
  test('a SIGINT releases the held lock, then exits with 130 (128 + SIGINT)', () => {
    const target = new EventEmitter();
    const release = vi.fn();
    const exits: number[] = [];
    installSignalLockRelease(release, (code) => exits.push(code), target);

    target.emit('SIGINT');

    expect(release).toHaveBeenCalledTimes(1); // the lock is released...
    expect(exits).toEqual([130]); // ...before exiting with the conventional code
  });

  test('a SIGTERM releases the held lock, then exits with 143 (128 + SIGTERM)', () => {
    const target = new EventEmitter();
    const release = vi.fn();
    const exits: number[] = [];
    installSignalLockRelease(release, (code) => exits.push(code), target);

    target.emit('SIGTERM');

    expect(release).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([143]);
  });

  test('release runs BEFORE exit — never the reverse (exit would abort first)', () => {
    const target = new EventEmitter();
    const order: string[] = [];
    installSignalLockRelease(
      () => order.push('release'),
      () => order.push('exit'),
      target,
    );
    target.emit('SIGINT');
    expect(order).toEqual(['release', 'exit']);
  });

  test('each configured signal gets its own handler; an unrelated signal is ignored', () => {
    const target = new EventEmitter();
    const release = vi.fn();
    const exits: number[] = [];
    installSignalLockRelease(release, (code) => exits.push(code), target);

    target.emit('SIGHUP'); // not in the configured set
    expect(release).not.toHaveBeenCalled();
    expect(exits).toEqual([]);

    target.emit('SIGTERM');
    target.emit('SIGINT');
    expect(release).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([143, 130]);
  });

  test('defaults register exactly one new SIGINT and one new SIGTERM listener on process', () => {
    // Exercises the default `target`/`signals` wiring — the real entrypoint lives
    // under `/* c8 ignore */`, so without this a regression that dropped SIGTERM
    // (or pointed at the wrong emitter) would go uncaught. Record pre-existing
    // listeners, install with a no-op onExit so nothing actually exits, assert
    // exactly one new listener per signal, then remove precisely those.
    const intBefore = process.listeners('SIGINT');
    const termBefore = process.listeners('SIGTERM');
    installSignalLockRelease(() => {}, () => {});
    const added = (sig: NodeJS.Signals, before: unknown[]): unknown[] =>
      process.listeners(sig).filter((l) => !before.includes(l));
    try {
      expect(added('SIGINT', intBefore)).toHaveLength(1);
      expect(added('SIGTERM', termBefore)).toHaveLength(1);
    } finally {
      for (const l of added('SIGINT', intBefore)) {
        process.removeListener('SIGINT', l as (...a: unknown[]) => void);
      }
      for (const l of added('SIGTERM', termBefore)) {
        process.removeListener('SIGTERM', l as (...a: unknown[]) => void);
      }
    }
  });
});

describe('releaseHeldLock — ownership (issue #247)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nb-signal-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    // Never leave a lock this process "owns" set between tests.
    releaseHeldLock();
  });

  test('releases the lock THIS process owns while it is held (the owned path)', async () => {
    const lock = join(dir, '.nb.lock');
    let heldDuringFn = false;
    let goneAfterRelease = false;
    // withLock sets the ownership flag once it wins the atomic acquire, so inside
    // fn() the lock exists AND we own it. Calling releaseHeldLock there is exactly
    // what a signal handler does mid-mutation: it removes the owned lock.
    await withLock(dir, () => {
      heldDuringFn = existsSync(lock);
      releaseHeldLock();
      goneAfterRelease = !existsSync(lock);
    });
    expect(heldDuringFn).toBe(true); // we genuinely held it
    expect(goneAfterRelease).toBe(true); // the owned lock was removed promptly
    expect(existsSync(lock)).toBe(false); // withLock's finally is a safe no-op after
  });

  test('is idempotent: a second release (the finally after a handler) never throws or double-removes', async () => {
    const lock = join(dir, '.nb.lock');
    // Release once from inside fn (simulating the signal handler), then let
    // withLock's finally call releaseHeldLock again. The second call must be a
    // no-op — the ownership flag was cleared — so it cannot remove a lock a later
    // acquire might own.
    await expect(
      withLock(dir, () => {
        releaseHeldLock(); // first (handler-style) release
        releaseHeldLock(); // immediate second release — still a no-op
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(lock)).toBe(false);

    // A fresh acquire afterwards still works and still releases on completion,
    // proving the flag was left in a clean state (not stuck pointing at a path).
    let reacquired = false;
    await withLock(dir, () => {
      reacquired = existsSync(lock);
    });
    expect(reacquired).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test('never removes a lock this process does not own (no held lock → no-op)', () => {
    // A foreign `.nb.lock` — held by some OTHER process — must survive a stray
    // releaseHeldLock(). This process owns no lock, so the flag is null and the
    // call does nothing. This is the core safety guarantee of the signal handler:
    // it may only ever reap its OWN lock.
    const lock = join(dir, '.nb.lock');
    mkdirSync(lock); // planted by "another process"; we never acquired it
    releaseHeldLock();
    expect(existsSync(lock)).toBe(true); // untouched — not ours to remove
  });

  test('after releasing an owned lock, the next acquire is immediate (not blocked)', async () => {
    // Acquire, release early from inside fn (handler-style), then immediately make
    // another mutation. If the lock were stranded the second acquire would spin on
    // it; instead it acquires at once — the "next call does not block" criterion.
    await withLock(dir, () => releaseHeldLock());
    const started = Date.now();
    await withLock(dir, () => {});
    expect(Date.now() - started).toBeLessThan(500); // no ~12s stale-steal wait
  });
});

describe('signal handler in the real built CLI (issue #247)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nb-signal-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Drive the REAL handler in a separate OS process under a REAL signal, without a
  // timing race. A tiny driver imports the built `installSignalLockRelease`, calls
  // it exactly as the CLI entrypoint does, writes a readiness marker, then idles.
  // The test waits for the marker — written synchronously right after the handlers
  // are installed, so its appearance PROVES they are in place — then plants a
  // foreign lock the driver never owns, sends the signal, and asserts the
  // conventional exit code plus that the un-owned lock survives. A bare
  // sleep-before-kill would instead race module load under parallel-test load
  // (SIGINT landing pre-install would kill by the default disposition); the marker
  // is the deterministic readiness gate.
  const CLI_URL = pathToFileURL(CLI).href;
  const DRIVER = [
    `import { installSignalLockRelease } from ${JSON.stringify(CLI_URL)};`,
    `import { writeFileSync } from 'node:fs';`,
    `installSignalLockRelease();`,
    `writeFileSync(process.env.NB_SIGNAL_MARKER, 'ready');`,
    `setInterval(() => {}, 1 << 30);`, // keep the event loop alive until signalled
  ].join('\n');

  async function runSignalCase(
    signal: NodeJS.Signals,
  ): Promise<{ code: number | null; sig: NodeJS.Signals | null; lockKept: boolean }> {
    const driverPath = join(dir, 'signal-driver.mjs');
    const marker = join(dir, 'ready');
    const lock = join(dir, '.nb.lock');
    writeFileSync(driverPath, DRIVER);
    mkdirSync(lock); // a foreign lock the driver never acquired — must survive
    const child = spawn(process.execPath, [driverPath], {
      env: { ...process.env, NB_SIGNAL_MARKER: marker },
      stdio: 'ignore',
    });
    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.on('exit', (code, sig) => resolve({ code, sig }));
        child.on('error', reject);
      },
    );
    // Deterministic readiness: poll for the marker rather than sleeping blindly.
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('driver never signalled readiness');
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    child.kill(signal);
    const { code, sig } = await exited;
    return { code, sig, lockKept: existsSync(lock) };
  }

  test('a real SIGINT exits 130 and leaves a lock it does not own intact', async () => {
    const { code, sig, lockKept } = await runSignalCase('SIGINT');
    // Exited via our handler's process.exit(128+signo), NOT the default
    // disposition (which would report signal 'SIGINT' and a null code).
    expect(sig).toBeNull();
    expect(code).toBe(130); // 128 + SIGINT(2)
    expect(lockKept).toBe(true); // the un-owned foreign lock was never removed
  }, 15_000);

  test('a real SIGTERM exits 143 and leaves a lock it does not own intact', async () => {
    const { code, sig, lockKept } = await runSignalCase('SIGTERM');
    expect(sig).toBeNull();
    expect(code).toBe(143); // 128 + SIGTERM(15)
    expect(lockKept).toBe(true);
  }, 15_000);
});
