import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Regression test for a real published-package bug: `npm install` links the
// `nb` command as a SYMLINK (node_modules/.bin/nb -> ../agent-notebook/dist/cli.js).
// `import.meta.url` resolves through that symlink to the real file, but
// `process.argv[1]` is the symlink path itself — comparing them directly
// (the common "am I the entry point" idiom) never matches for a symlinked
// bin, so the CLI silently did nothing and exited 0. This test reproduces
// that exact symlink shape against the compiled dist/cli.js and asserts real
// output, not just exit code 0, so a regression can't hide behind "it didn't
// crash."
const here = dirname(fileURLToPath(import.meta.url));
const distCli = join(here, '..', 'dist', 'cli.js');

let dir: string;
let binDir: string;
let binPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-symlink-nbdir-'));
  binDir = mkdtempSync(join(tmpdir(), 'agent-notebook-symlink-bin-'));
  binPath = join(binDir, 'nb');
  symlinkSync(distCli, binPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('nb invoked through an npm-style bin symlink', () => {
  test('dist/cli.js is built (run `npm run build` if this fails)', () => {
    expect(existsSync(distCli)).toBe(true);
  });

  test('add + show actually produce output when run through a symlink, not just exit 0', () => {
    const out = execFileSync(binPath, ['add', 'shelf', 'symlinked lesson'], {
      env: { ...process.env, NB_DIR: dir },
      encoding: 'utf-8',
    });
    expect(out).toContain('added — 1 lines');

    const shown = execFileSync(binPath, ['show', 'shelf'], {
      env: { ...process.env, NB_DIR: dir },
      encoding: 'utf-8',
    });
    expect(shown).toContain('symlinked lesson');
  });
});
