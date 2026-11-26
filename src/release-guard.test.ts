import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #559: scripts/check-release.mjs refuses a release whose version is not the same
// everywhere it is written. Every case runs the real script on fixture zips (built by
// scripts/build-plugin.mjs, then changed in one place) and asserts the marker the script
// prints, not only the exit code: a crash (exit 2, or a missing file) is never counted as a
// refusal.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
const V = pkg.version;

/** A STORE zip as a Map of entry name to bytes (the build writes nothing else). */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8'), buf.subarray(start, start + size));
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}
/** A STORE zip from a Map; the checks read names and bytes only, so CRC and dates stay 0. */
function writeZip(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

let tmp: string;
let goodZip: Map<string, Buffer>;
let seq = 0;

/** A copy of the checker with its own repository files (the script reads them next to itself). */
function fixtureRoot(change: (r: string) => void = () => {}): string {
  const r = join(tmp, `root${seq++}`);
  mkdirSync(join(r, 'scripts'), { recursive: true });
  mkdirSync(join(r, 'examples', 'hooks', 'claude-code'), { recursive: true });
  cpSync(join(root, 'scripts', 'check-release.mjs'), join(r, 'scripts', 'check-release.mjs'));
  for (const f of ['package.json', 'package-lock.json', 'examples/hooks/claude-code/nb-hook-entry.cjs']) cpSync(join(root, f), join(r, f));
  change(r);
  return r;
}
const editJson = (path: string, edit: (j: any) => void): void => {
  const j = JSON.parse(readFileSync(path, 'utf-8'));
  edit(j);
  writeFileSync(path, JSON.stringify(j, null, 2) + '\n');
};
/** The good zip with one entry replaced, written to a file. */
function zipWith(change: (files: Map<string, Buffer>) => void): string {
  const files = new Map(goodZip);
  change(files);
  const path = join(tmp, `z${seq++}.zip`);
  writeFileSync(path, writeZip(files));
  return path;
}
const jsonEntry = (files: Map<string, Buffer>, name: string, edit: (j: any) => void): void => {
  const j = JSON.parse(files.get(name)!.toString('utf-8'));
  edit(j);
  files.set(name, Buffer.from(JSON.stringify(j, null, 2) + '\n'));
};
const textEntry = (files: Map<string, Buffer>, name: string, edit: (s: string) => string): void => {
  files.set(name, Buffer.from(edit(files.get(name)!.toString('utf-8'))));
};

function check(args: string[], r: string = root): { code: number | null; stdout: string; stderr: string } {
  const x = spawnSync(process.execPath, [join(r, 'scripts', 'check-release.mjs'), ...args], { cwd: tmp, encoding: 'utf-8', timeout: 30_000 });
  return { code: x.status, stdout: x.stdout, stderr: x.stderr };
}
/** The check refused: exit 1, one `::error::` line holding the marker, and nothing on stderr. */
function expectRefusal(r: { code: number | null; stdout: string; stderr: string }, marker: string): void {
  expect(r.stderr).toBe('');
  expect(r.stdout).toContain(`::error::${marker}`);
  expect(r.code).toBe(1);
}

let goodPath: string;
beforeAll(() => {
  expect(existsSync(join(root, 'dist', 'cli.js')), 'dist/ not built: run `npm run build` first').toBe(true);
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'check release ')));
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-plugin.mjs'), '--out', join(tmp, 'out')], { encoding: 'utf-8', timeout: 60_000 });
  expect(built.stderr).toBe('');
  expect(built.status).toBe(0);
  goodPath = join(tmp, 'out', `agent-notebook-plugin-${V}.zip`);
  goodZip = readZip(readFileSync(goodPath));
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('check-release.mjs lets a consistent release through (issue #559)', () => {
  test('the tag, the files and the zip of this repository agree', () => {
    const r = check(['--tag', `v${V}`, '--zip', goodPath]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('check-release: ok');
    expect(r.code).toBe(0);
  });

  test('--pr checks the repository files alone and passes', () => {
    const r = check(['--pr']);
    expect(r.stdout).toContain('repository files only');
    expect(r.code).toBe(0);
  });
});

describe('check-release.mjs refuses each disagreement with its own marker (issue #559)', () => {
  test('a tag that is not v<package.json version> names both values', () => {
    const r = check(['--tag', 'v9.9.9', '--zip', goodPath]);
    expectRefusal(r, 'tag (GITHUB_REF_NAME) is "v9.9.9" but "v' + V + '" was expected');
  });

  test('a tag of a shape the release job refuses is refused before npm is published', () => {
    const r = check(['--tag', 'v1.2', '--zip', goodPath]);
    expectRefusal(r, 'tag shape: "v1.2"');
  });

  test('package-lock.json version', () => {
    const r = fixtureRoot((d) => editJson(join(d, 'package-lock.json'), (j) => (j.version = '0.0.1')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', goodPath], r), 'package-lock.json version is "0.0.1"');
  });

  test('package-lock.json packages[""].version', () => {
    const r = fixtureRoot((d) => editJson(join(d, 'package-lock.json'), (j) => (j.packages[''].version = '0.0.2')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', goodPath], r), 'package-lock.json packages[""].version is "0.0.2"');
  });

  test("the zip's plugin.json version", () => {
    const z = zipWith((f) => jsonEntry(f, '.claude-plugin/plugin.json', (j) => (j.version = '0.0.3')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', z]), 'zip .claude-plugin/plugin.json version is "0.0.3"');
  });

  test("the zip's package.json version", () => {
    const z = zipWith((f) => jsonEntry(f, 'package.json', (j) => (j.version = '0.0.4')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', z]), 'zip package.json version is "0.0.4"');
  });

  test("the skill's version stamp, and a placeholder left in it", () => {
    const stale = zipWith((f) => textEntry(f, 'skills/agent-notebook/SKILL.md', (s) => s.replaceAll(V, '0.0.5')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', stale]), 'zip skills/agent-notebook/SKILL.md does not name version');
    const open = zipWith((f) => textEntry(f, 'skills/agent-notebook/SKILL.md', (s) => s + '\n{{VERSION}}\n'));
    expectRefusal(check(['--tag', `v${V}`, '--zip', open]), 'zip skills/agent-notebook/SKILL.md still has a {{placeholder}}');
  });

  test("the zip's engines differ from the repository's", () => {
    const z = zipWith((f) => jsonEntry(f, 'package.json', (j) => (j.engines = { node: '>=20' })));
    expectRefusal(check(['--tag', `v${V}`, '--zip', z]), 'zip package.json engines.node is ">=20"');
  });

  test("MIN_NODE of the entry differs from the engines' major, in the repository and in the zip", () => {
    const r = fixtureRoot((d) => {
      const f = join(d, 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs');
      writeFileSync(f, readFileSync(f, 'utf-8').replace(/^var MIN_NODE = \d+;$/m, 'var MIN_NODE = 20;'));
    });
    expectRefusal(check(['--pr'], r), 'nb-hook-entry.cjs MIN_NODE is "20" but "18" was expected');
    const z = zipWith((f) => textEntry(f, 'examples/hooks/claude-code/nb-hook-entry.cjs', (s) => s.replace(/^var MIN_NODE = \d+;$/m, 'var MIN_NODE = 16;')));
    expectRefusal(check(['--tag', `v${V}`, '--zip', z]), 'zip nb-hook-entry.cjs MIN_NODE is "16" but "18" was expected');
  });

  test('--pr refuses a lock that drifted, with the same marker', () => {
    const r = fixtureRoot((d) => editJson(join(d, 'package-lock.json'), (j) => (j.version = '0.0.1')));
    expectRefusal(check(['--pr'], r), 'package-lock.json version is "0.0.1"');
  });

  test('every disagreement of one run is reported, one error line each', () => {
    const z = zipWith((f) => {
      jsonEntry(f, 'package.json', (j) => (j.version = '0.0.4'));
      jsonEntry(f, '.claude-plugin/plugin.json', (j) => (j.version = '0.0.3'));
    });
    const r = check(['--tag', 'v9.9.9', '--zip', z]);
    expect(r.stdout.trim().split('\n')).toHaveLength(3);
    expect(r.code).toBe(1);
  });
});

describe('check-release.mjs: a crash or a usage error is never a refusal (issue #559)', () => {
  test('a bad command line exits 2 and prints no ::error:: marker', () => {
    for (const args of [[], ['--tag', `v${V}`], ['--zip', goodPath], ['--pr', '--tag', `v${V}`], ['--nope']]) {
      const r = check(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stdout).not.toContain('::error::');
      expect(r.stderr).toContain('usage:');
    }
  });

  test('a zip that is missing or not a zip exits 2', () => {
    expect(check(['--tag', `v${V}`, '--zip', join(tmp, 'absent.zip')]).code).toBe(2);
    const junk = join(tmp, 'junk.zip');
    writeFileSync(junk, 'not a zip');
    const r = check(['--tag', `v${V}`, '--zip', junk]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain('::error::');
  });
});
