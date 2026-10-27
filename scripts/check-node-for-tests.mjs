#!/usr/bin/env node
// Guard for issue #44. vitest 5 imports `styleText` from `node:util`, which
// only exists on Node 20.12+. On Node 18 — the declared minimum engine — the
// test suite otherwise dies with an opaque bundler stack trace from
// node_modules (`SyntaxError: The requested module 'node:util' does not provide
// an export named 'styleText'`). Fail fast with one clear line before vitest is
// ever loaded.
//
// This intentionally does NOT raise `engines`: the library runtime may still be
// 18-safe; only the test runner needs 20.12+. Raising the minimum engine is a
// separate, reductive decision and must not ride in on this guard.
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_TEST_NODE = '20.12.0';

export const UNSUPPORTED_MESSAGE =
  'tests require Node 20.12+; the library still claims runtime >=18';

/**
 * Returns true when `version` (shaped like `process.versions.node`, e.g.
 * "20.12.0") can run the test suite, i.e. `node:util` exports `styleText`.
 * styleText was added in 20.12.0 and backported to the 21.x line only in
 * 21.7.0, so Node 21.0–21.6 lacks it even though 21 > 20 — we must reject that
 * window, not just everything below 20.12.
 */
export function nodeSupportsTests(version) {
  const [major = 0, minor = 0] = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  if (major > 21) return true;
  if (major < 20) return false;
  if (major === 20) return minor >= 12;
  // major === 21: styleText landed on this line in 21.7.0.
  return minor >= 7;
}

/**
 * True when this module is the process entry point (`node scripts/...`), false
 * when it is imported (e.g. by the tests). Compares real paths, not just
 * resolved ones: `import.meta.url` is the realpath of the entry module while
 * `process.argv[1]` is only resolved, so a symlinked invocation (or macOS's
 * /tmp -> /private/tmp) would otherwise make the two differ and the guard
 * silently do nothing — the exact fail-open fixed in commit 2a90b2f.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

// Run the check only when invoked directly, not when imported by the tests.
// NB_TEST_NODE_VERSION lets the tests exercise the real exit path against a
// simulated version.
if (isMainModule()) {
  const version = process.env.NB_TEST_NODE_VERSION ?? process.versions.node;
  if (!nodeSupportsTests(version)) {
    console.error(UNSUPPORTED_MESSAGE);
    process.exit(1);
  }
}
