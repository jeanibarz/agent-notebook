// Vitest global setup (issue #420): the suites exec the built `dist/cli.js`, so a
// bare `npx vitest run` after editing `src/` used to test a stale build. This
// rebuilds `dist/` only when it is missing or older than a source file, so a
// current `dist/` (e.g. right after `npm test`'s own `pretest` build) costs nothing.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Newest mtime (ms) of any compiled source under `dir`. `*.test.ts` files are
// skipped: tsconfig.json excludes them, so editing one changes nothing in dist/.
function newestSourceMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(path));
    else if (!entry.name.endsWith('.test.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

// True when `dist/cli.js` is absent or older than any non-test file under `src/`.
export function isDistStale(rootDir = root) {
  let distMtime;
  try {
    distMtime = statSync(join(rootDir, 'dist', 'cli.js')).mtimeMs;
  } catch {
    return true;
  }
  return newestSourceMtime(join(rootDir, 'src')) > distMtime;
}

// Issue #481: delete every inherited `GIT_*` and `NB_*` variable from `env`.
// Git exports `GIT_DIR` (and friends) to hooks, so `npm test` run from a
// pre-commit/pre-push hook used to make the fixtures' `git init`/`config`/
// `commit` act on the caller's repository; an ambient `NB_*` tunable changed
// the notebook under test the same way. Tests that need one of these set it
// themselves, after this runs. Returns the removed names, for the test.
export function scrubInheritedEnv(env = process.env) {
  const removed = Object.keys(env).filter((k) => k.startsWith('GIT_') || k.startsWith('NB_'));
  for (const k of removed) delete env[k];
  return removed;
}

export default function setup() {
  scrubInheritedEnv();
  if (!isDistStale()) return;
  console.log('dist/ is missing or older than src/; running `npm run build` first');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
