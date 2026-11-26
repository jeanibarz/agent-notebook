import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #559: the plugin's bin/nb and bin/nb.cmd run `node`, and must never run a program
// from the working directory in its place: a repository the user opens could plant one.
// The staged copy is built by scripts/build-plugin.mjs.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
const NODE_DIR = dirname(process.execPath);

let tmp: string;
let stage: string;
let cwd: string; // holds planted programs

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb launchers ')));
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-plugin.mjs'), '--out', join(tmp, 'out dir')], { cwd: root, encoding: 'utf-8' });
  expect(built.status, built.stderr).toBe(0);
  stage = join(tmp, 'out dir', `agent-notebook-plugin-${pkg.version}`);
  cwd = join(tmp, 'work');
  mkdirSync(cwd);
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Plant a program that prints PLANTED, as a POSIX script. */
function plant(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, '#!/bin/sh\necho PLANTED\n');
  chmodSync(f, 0o755);
}

describe('bin/nb never runs a program from the working directory (FR-PLUGIN-004, issue #559)', { skip: process.platform === 'win32', timeout: 30_000 }, () => {
  const nb = (path: string, args = ['--version'], dir = cwd) =>
    spawnSync(join(stage, 'bin', 'nb'), args, { cwd: dir, env: { PATH: path, NB_DIR: join(tmp, 'nbdir') }, encoding: 'utf-8' });
  const GOOD = `${NODE_DIR}:/usr/bin:/bin`;

  test('the staged bin/nb --version prints the package version', () => {
    const r = nb(GOOD);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`nb (agent-notebook) ${pkg.version}\n`);
    expect(r.status).toBe(0);
  });

  test('it passes its arguments through unchanged', () => {
    const r = nb(GOOD, ['list', "a b", '$x']);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('PLANTED');
  });

  test('a node and a dirname planted in the current folder are not run, with an empty first PATH element', () => {
    plant(cwd, 'node');
    plant(cwd, 'dirname');
    const r = nb(`:${GOOD}`);
    expect(r.stdout).toBe(`nb (agent-notebook) ${pkg.version}\n`);
    expect(r.stdout + r.stderr).not.toContain('PLANTED');
  });

  test('nor with a "." or a relative entry first, or an empty one in the middle or at the end', () => {
    plant(join(cwd, 'rel'), 'node');
    plant(join(cwd, 'rel'), 'dirname');
    for (const path of [`.:${GOOD}`, `rel:${GOOD}`, `./rel:${GOOD}`, `${NODE_DIR}::/usr/bin:/bin`, `${GOOD}:`]) {
      const r = nb(path);
      expect(r.stdout, path).toBe(`nb (agent-notebook) ${pkg.version}\n`);
      expect(r.stdout + r.stderr, path).not.toContain('PLANTED');
    }
  });

  test('a PATH with no absolute entry is not left empty, which would mean the current folder', () => {
    plant(cwd, 'node');
    for (const path of ['', 'rel', '.:rel', '::']) {
      const r = nb(path);
      expect(r.stdout + r.stderr, JSON.stringify(path)).not.toContain('PLANTED');
      expect(r.status, JSON.stringify(path)).not.toBe(0);
    }
  });

  test('it works when run from a folder that is not the plugin\'s, by a path with a space', () => {
    expect(stage).toContain(' ');
    expect(nb(GOOD, ['--version'], tmp).stdout).toBe(`nb (agent-notebook) ${pkg.version}\n`);
  });

  test('a * in PATH is not expanded into the folders it matches', () => {
    const globRoot = join(tmp, 'globroot');
    plant(join(globRoot, 'd1'), 'node');
    const r = nb(`${globRoot}/*:${GOOD}`);
    expect(r.stdout).toBe(`nb (agent-notebook) ${pkg.version}\n`);
    expect(r.stdout + r.stderr).not.toContain('PLANTED');
  });

  test('the staged file starts with the sh line and no program name before set -f', () => {
    const lines = readFileSync(join(stage, 'bin', 'nb'), 'utf-8').split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines.filter((l) => !l.startsWith('#') && l.trim() !== '')[0]).toBe('set -f');
    // Not even dirname: with a planted one first on a relative PATH it would run before the PATH is cleaned.
    expect(lines.filter((l) => !l.startsWith('#')).join('\n')).not.toMatch(/\bdirname\b/);
  });
});

describe('bin/nb.cmd never runs a program from the working directory (FR-PLUGIN-004, issue #559)', { skip: process.platform !== 'win32', timeout: 30_000 }, () => {
  test('a node.cmd planted in the current folder is not run', () => {
    writeFileSync(join(cwd, 'node.cmd'), '@echo PLANTED\r\n');
    const r = spawnSync('cmd', ['/d', '/c', join(stage, 'bin', 'nb.cmd'), '--version'], { cwd, encoding: 'utf-8' });
    expect(r.stdout).toBe(`nb (agent-notebook) ${pkg.version}\n`);
    expect(existsSync(join(cwd, 'node.cmd'))).toBe(true);
  });
});
