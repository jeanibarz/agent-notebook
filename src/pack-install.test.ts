import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Issue #268: every other suite exercises the CLI/library from the in-tree,
// freshly-built `dist/` (the `pretest` build) or from a hand-made symlink
// (`bin-symlink.test.ts`). Nothing proved that the *published artifact* — the
// exact tarball `npm publish` would upload, trimmed to package.json's `files`
// allow-list — actually installs and runs. A dropped `files` entry, a bin that
// isn't shipped, a missing type declaration, or an entry point that doesn't
// resolve from a consumer's `node_modules` would all slip past the rest of the
// suite and only break for real users on `npm install`.
//
// This test closes that gap end to end: `npm pack` the real tarball, `npm
// install` it into a throwaway consumer project, then assert against the
// INSTALLED copy that (1) the shipped `dist/` entry files are present, (2) the
// linked `nb` bin runs and prints the real version, and (3) the package's
// declared entry point loads and exports its public API when imported by
// specifier (the npm `exports` map resolving, not a file path we hand-built).
//
// Note on "`require('agent-notebook')`" from the acceptance criteria: this
// package is ESM-only (`"type": "module"`, and its sole `exports` entry resolves
// to the ESM `dist/notebook.js`), so a CommonJS `require()` is not a supported
// consumption path and `require(esm)` support varies across the Node 20/22 lines
// CI runs. We therefore verify the supported shape — loading the package by its
// bare specifier so Node's `exports`-map resolution runs — which is the thing the
// gap is actually about: that the published entry point resolves and executes.
//
// Tagged `[slow]`: a real pack + install spends a few seconds of I/O, so the
// `test:fast` inner loop skips it while `npm test` and CI still run it.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as {
  version: string;
};

// Child processes must NOT inherit the outer `npm test` run's npm lifecycle
// context: `npm test` exports `npm_config_*`, `npm_lifecycle_*` and
// `npm_package_*` into our environment, and letting those leak into the inner
// `npm pack`/`install` would run them under the parent run's config rather than
// a clean one. Strip them, then layer on just the overrides each child needs.
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^npm_(config|lifecycle|package)_/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

// npm honours $npm_config_cache; point it at a scratch dir so the test never
// mutates the developer's real npm cache and stays self-contained.
function npm(args: string[], cwd: string, cacheDir: string): string {
  return execFileSync('npm', args, {
    cwd,
    encoding: 'utf-8',
    env: cleanEnv({ npm_config_cache: cacheDir }),
  });
}

let work: string;
let installed: string; // node_modules/agent-notebook inside the consumer project

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'agent-notebook-pack-install-'));
  const cacheDir = join(work, '.npm-cache');
  const packDir = join(work, 'pack');
  const consumer = join(work, 'consumer');
  // `mkdtempSync` only made `work`; create the subdirs we need under it.
  for (const d of [cacheDir, packDir, consumer]) mkdirSync(d, { recursive: true });

  // `pretest` builds `dist/` before the suite, exactly as `bin-symlink.test.ts`
  // relies on, so the pack contains the compiled output. Guard it: if this file
  // is run directly without a build, `npm pack` would ship a stale/empty dist/
  // and the failure should name the fix rather than surface as a missing file.
  expect(
    existsSync(join(root, 'dist', 'cli.js')),
    'dist/ not built — run `npm run build` first',
  ).toBe(true);

  // 1. Pack the real tarball from the package root. `--json` keeps stdout to a
  //    single machine-readable array; the filename is the only field we need.
  const packed = JSON.parse(npm(
    ['pack', '--json', '--pack-destination', packDir],
    root,
    cacheDir,
  )) as Array<{ filename: string }>;
  expect(packed).toHaveLength(1);
  const tarball = join(packDir, packed[0].filename);
  expect(existsSync(tarball)).toBe(true);

  // 2. Install the tarball into a throwaway consumer project — a real install
  //    that links the `nb` bin as npm would on a user's machine. The package has
  //    zero runtime dependencies, so this needs no network.
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'pack-install-consumer', version: '1.0.0', private: true, type: 'module' }) + '\n',
  );
  npm(
    ['install', tarball, '--no-audit', '--no-fund', '--no-save', '--ignore-scripts'],
    consumer,
    cacheDir,
  );
  installed = join(consumer, 'node_modules', 'agent-notebook');
}, 180_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('install from the packed tarball [slow]', () => {
  test('ships the files its own manifest declares as bin, main and types', () => {
    // Derive the shipped targets from the INSTALLED manifest, not hardcoded
    // paths, so a renamed build output (with its package.json entry updated to
    // match) can't let this test silently go stale: if the `files` allow-list
    // ever drops `dist`, or a declared target isn't packed, the published
    // package breaks here instead of silently in the field.
    const manifest = JSON.parse(
      readFileSync(join(installed, 'package.json'), 'utf-8'),
    ) as { bin: { nb: string }; main: string; types: string };
    const targets = [manifest.bin.nb, manifest.main, manifest.types];
    for (const t of targets) {
      expect(
        existsSync(join(installed, t)),
        `declared entry target missing from the published package: ${t}`,
      ).toBe(true);
    }
    // And the acceptance-criteria files specifically (#268): bin, main and types
    // are exactly dist/cli.js, dist/notebook.js and dist/notebook.d.ts.
    expect(targets).toEqual(
      expect.arrayContaining([
        'dist/cli.js',
        'dist/notebook.js',
        'dist/notebook.d.ts',
      ]),
    );
  });

  test('the linked `nb` bin runs and prints the real version', () => {
    // Run through node_modules/.bin/nb — the npm-created symlink a user invokes,
    // the same shape `bin-symlink.test.ts` fakes but here produced by a real
    // install. Assert real output, not just exit 0, so a silent no-op regression
    // (see bin-symlink.test.ts) can't hide. NB_DIR is a scratch dir so the
    // version call's usage logging stays hermetic.
    const bin = join(installed, '..', '.bin', 'nb');
    expect(existsSync(bin)).toBe(true);
    const out = execFileSync(bin, ['--version'], {
      env: cleanEnv({ NB_DIR: join(work, 'nbdir') }),
      encoding: 'utf-8',
    });
    expect(out).toContain(`nb (agent-notebook) ${pkg.version}`);
  });

  test('the package main export loads and resolves by its bare specifier', () => {
    // Import the package the way a consumer does — by name, so Node's `exports`
    // map (`.` -> dist/notebook.js) has to resolve from the consumer's
    // node_modules — and confirm the module actually executes and surfaces its
    // public API. A path import would bypass the very resolution the gap is about.
    const consumer = dirname(dirname(installed)); // .../consumer
    const script = join(consumer, 'use-agent-notebook.mjs');
    writeFileSync(
      script,
      [
        "import * as nb from 'agent-notebook';",
        "if (typeof nb.assertSafeShelf !== 'function') { console.error('missing assertSafeShelf'); process.exit(2); }",
        "if (typeof nb.maxLines !== 'function') { console.error('missing maxLines'); process.exit(3); }",
        "console.log('EXPORTS_OK');",
        '',
      ].join('\n'),
    );
    const out = execFileSync(process.execPath, [script], {
      cwd: consumer,
      env: cleanEnv({ NB_DIR: join(work, 'nbdir') }),
      encoding: 'utf-8',
    });
    expect(out).toContain('EXPORTS_OK');
  });
});
