#!/usr/bin/env node
// Issue #231: a Vitest-free runtime smoke for the declared minimum engine, Node
// 18. CI *compiles* the package on Node 18 but — because Vitest 5 imports
// `styleText` from `node:util`, which needs Node 20.12+ — never RUNS it there
// (see scripts/check-node-for-tests.mjs). So a regression that breaks only on
// Node 18 would sail through CI. This script runs the built `dist/cli.js`
// through the core commands on whatever Node invokes it, wired into CI on the
// Node-18 leg only, and fails loudly if any command errors or drops its key
// output.
//
// Because it loads the real built CLI, it covers the acceptance criterion
// "introducing a Node-20-only runtime API into src/ makes the Node-18 step
// fail" for free: such an API throws at module load on Node 18, so even
// `nb --version` would exit non-zero here.
//
// Keep it dependency-free and fast (a couple of seconds): it is a floor-level
// smoke, not a second test tier. It intentionally does NOT import Vitest (which
// cannot load on Node 18).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

if (!existsSync(CLI)) {
  console.error(`smoke-node18: ${CLI} not found — run \`npm run build\` first.`);
  process.exit(1);
}

const NB_DIR = mkdtempSync(join(tmpdir(), 'nb-smoke-'));
let failures = 0;

/** Run `nb <args>` against the temp store; return {status, out}, never throw. */
function nb(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, NB_DIR },
      encoding: 'utf8',
    });
    return { status: 0, out: stdout };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
    if (detail) console.error(detail.split('\n').slice(0, 6).map((l) => `         ${l}`).join('\n'));
  }
}

/** Assert `nb <args>` exits 0 and its output contains every needle in `wants`. */
function expectOk(label, args, wants = []) {
  const r = nb(args);
  const ok = r.status === 0 && wants.every((w) => r.out.includes(w));
  check(label, ok, ok ? '' : `\`nb ${args.join(' ')}\` exit=${r.status}\n${r.out}`);
  return r;
}

try {
  console.log(`smoke-node18: Node ${process.versions.node}, NB_DIR=${NB_DIR}`);

  const LESSON = 'a durable smoke lesson about builds';
  expectOk('--version prints the package version', ['--version'], ['agent-notebook']);
  expectOk('--help prints usage', ['--help'], ['usage:']);
  expectOk('add stores a lesson', ['add', 'smoke', LESSON], ['added']);
  expectOk('show lists the lesson', ['show', 'smoke'], [LESSON]);

  // Recover the entry id from `show --json` to drive a real vote by id.
  let id = '';
  try {
    id = JSON.parse(nb(['show', 'smoke', '--json']).out)?.entries?.[0]?.id ?? '';
  } catch { /* leave id empty → the vote check below fails loudly */ }
  check('show --json exposes an entry id', Boolean(id));

  expectOk('search finds the lesson', ['search', 'builds'], ['smoke', LESSON]);
  if (id) {
    expectOk('vote raises the score to +2', ['vote', 'smoke', id, '+1'], ['+2']);
  } else {
    check('vote raises the score to +2', false, 'no id recovered from `show --json`');
  }
} finally {
  rmSync(NB_DIR, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`smoke-node18: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('smoke-node18: PASS');
