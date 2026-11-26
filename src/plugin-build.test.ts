import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

// Issue #559: scripts/build-plugin.mjs stages the Claude Code plugin and writes its zip
// with its own STORE writer, so that the same inputs give the same bytes anywhere.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SCRIPT = join(root, 'scripts', 'build-plugin.mjs');
/** A text file as the build packs it: a Windows checkout (and tsc there) writes CRLF, the build writes LF. */
const lf = (p: string): Buffer => Buffer.from(readFileSync(p, 'utf-8').replace(/\r\n/g, '\n'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string; engines: unknown; license: string; name: string };

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  mode: number;
  method: number;
  flags: number;
  dosDate: number;
  dosTime: number;
  madeBy: number;
  extraLen: number;
}

/** A small zip reader: walks the central directory of a STORE archive with no comment. */
function readZip(buf: Buffer): ZipEntry[] {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const size = buf.readUInt32LE(p + 24);
    const local = buf.readUInt32LE(p + 42);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8'),
      data: buf.subarray(dataStart, dataStart + size),
      crc: buf.readUInt32LE(p + 16),
      mode: buf.readUInt32LE(p + 38) >>> 16,
      method: buf.readUInt16LE(p + 10),
      flags: buf.readUInt16LE(p + 8),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      madeBy: buf.readUInt16LE(p + 4),
      extraLen,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** CRC-32 by the bit-by-bit definition, for Node.js versions without zlib.crc32. */
function referenceCrc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = (b: Buffer): number => (typeof (zlib as { crc32?: unknown }).crc32 === 'function' ? (zlib as unknown as { crc32(d: Buffer): number }).crc32(b) : referenceCrc32(b));

/** dist/**.js of the repo, `/`-separated. */
function distJs(dir = join(root, 'dist'), prefix = 'dist/'): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (statSync(join(dir, n)).isDirectory()) out.push(...distJs(join(dir, n), `${prefix}${n}/`));
    else if (n.endsWith('.js')) out.push(prefix + n);
  }
  return out;
}

interface Built {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Run the build script as a child; `umask` is changed through a preload (a no-op on Windows). */
function build(script: string, args: string[], opts: { env?: NodeJS.ProcessEnv; umask?: number; cwd?: string } = {}): Built {
  const pre: string[] = [];
  if (opts.umask !== undefined) {
    const preload = join(tmp, `umask-${opts.umask}.cjs`);
    writeFileSync(preload, `process.umask(${opts.umask});\n`);
    pre.push('--require', preload);
  }
  const r = spawnSync(process.execPath, [...pre, script, ...args], { cwd: opts.cwd ?? dirname(script), env: { ...process.env, ...opts.env }, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

let tmp: string;
let out: string; // the shared build, in a folder whose name has a space
let zipBytes: Buffer;
let entries: ZipEntry[];
const byName = (n: string): ZipEntry => entries.find((e) => e.name === n)!;
const base = `agent-notebook-plugin-${pkg.version}`;

beforeAll(() => {
  expect(existsSync(join(root, 'dist', 'cli.js')), 'dist/ not built: run `npm run build` first').toBe(true);
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb plugin build ')));
  out = join(tmp, 'shared out');
  const r = build(SCRIPT, ['--out', out], { cwd: root });
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  zipBytes = readFileSync(join(out, `${base}.zip`));
  entries = readZip(zipBytes);
  // The printed line and the .sha256 file both name the zip's real checksum.
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  expect(r.stdout).toBe(`${sha}  ${base}.zip\n`);
  expect(readFileSync(join(out, `${base}.zip.sha256`), 'utf-8')).toBe(`${sha}  ${base}.zip\n`);
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the plugin zip holds exactly these files (FR-PLUGIN-001, issue #559)', () => {
  test('the golden entry list, with the Unix mode of each', () => {
    const fixed: Array<[string, number]> = [
      ['.claude-plugin/plugin.json', 0o100644],
      ['CHANGELOG.md', 0o100644],
      ['LICENSE', 0o100644],
      ['bin/nb', 0o100755],
      ['bin/nb.cmd', 0o100644],
      ['examples/hooks/claude-code/nb-claude-hook.mjs', 0o100644],
      ['examples/hooks/claude-code/nb-hook-entry.cjs', 0o100644],
      ['hooks/hooks.json', 0o100644],
      ['package.json', 0o100644],
      ['skills/agent-notebook/SKILL.md', 0o100644],
    ];
    const dist: Array<[string, number]> = distJs().map((n) => [n, n === 'dist/cli.js' ? 0o100755 : 0o100644]);
    const expected = [...fixed, ...dist].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
    expect(entries.map((e) => [e.name, e.mode])).toEqual(expected);
    expect(dist.length).toBeGreaterThan(10);
  });

  test('entries are sorted by UTF-8 bytes, stored, dated 1980-01-01 00:00, with no directory entries and no extra fields', () => {
    const names = entries.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    for (const e of entries) {
      expect(e.name.endsWith('/'), `${e.name} is a directory entry`).toBe(false);
      expect(e.name).not.toContain('\\');
      expect(e.method, e.name).toBe(0);
      expect(e.dosDate, e.name).toBe(0x21);
      expect(e.dosTime, e.name).toBe(0);
      expect(e.flags, e.name).toBe(0x0800);
      expect(e.madeBy, e.name).toBe((3 << 8) | 20);
      expect(e.extraLen, e.name).toBe(0);
    }
  });

  test('every CRC-32 matches the bytes of its entry', () => {
    for (const e of entries) expect(e.crc, e.name).toBe(crc32(e.data));
  });

  test('the zip has no declaration files, no source maps and no node_modules', () => {
    expect(entries.filter((e) => /\.d\.ts$|\.map$|node_modules/.test(e.name)).map((e) => e.name)).toEqual([]);
  });

  test('the staged folder holds the same files, and bin/nb can run', () => {
    const stage = join(out, base);
    for (const e of entries) expect(readFileSync(join(stage, ...e.name.split('/'))).equals(e.data), e.name).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(stage, 'bin', 'nb')).mode & 0o111).toBe(0o111);
  });
});

describe('the build is reproducible (FR-PLUGIN-001, issue #559)', () => {
  test('two builds into folders with awkward names, one under another umask and time zone, give the same sha256', () => {
    const awkward = (n: string): string => join(tmp, `${n} it's $x \`b\` é`);
    const a = awkward('first');
    const b = awkward('second');
    const ra = build(SCRIPT, ['--out', a], { cwd: root, env: { TZ: 'UTC' }, umask: 0o022 });
    const rb = build(SCRIPT, ['--out', b], { cwd: root, env: { TZ: 'Pacific/Kiritimati' }, umask: 0o077 });
    expect([ra.code, rb.code, ra.stderr, rb.stderr]).toEqual([0, 0, '', '']);
    expect(ra.stdout).toBe(rb.stdout);
    expect(ra.stdout).toBe(`${createHash('sha256').update(zipBytes).digest('hex')}  ${base}.zip\n`);
    expect(readFileSync(join(b, `${base}.zip`)).equals(zipBytes)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(b, base, 'bin', 'nb')).mode & 0o777).toBe(0o755);
  });

  test('a CRLF checkout of the text inputs gives the same bytes (a Windows checkout)', () => {
    const copy = layout();
    for (const f of ['LICENSE', 'CHANGELOG.md', 'plugin/hooks/hooks.json', 'plugin/bin/nb', 'plugin/skills/agent-notebook/SKILL.md', 'examples/hooks/claude-code/nb-claude-hook.mjs', 'dist/cli.js']) {
      const p = join(copy, ...f.split('/'));
      writeFileSync(p, readFileSync(p, 'utf-8').replace(/\r?\n/g, '\r\n'));
    }
    const r = build(join(copy, 'scripts', 'build-plugin.mjs'), ['--out', join(copy, 'o')]);
    expect(r.code, r.stderr).toBe(0);
    // dist/ in the copy holds only cli.js, so compare the entries that exist in both.
    const crlf = readZip(readFileSync(join(copy, 'o', `${base}.zip`)));
    for (const e of crlf) expect(e.data.equals(byName(e.name).data) || e.name === 'dist/cli.js', e.name).toBe(true);
    expect(crlf.find((e) => e.name === 'dist/cli.js')!.data.equals(Buffer.from(readFileSync(join(root, 'dist', 'cli.js'), 'utf-8').replace(/\r\n/g, '\n')))).toBe(true);
  });
});

describe('what the zip contains matches the sources (FR-PLUGIN-001, issue #559)', () => {
  test('dist/*.js is byte-equal to the repo\'s dist/*.js', () => {
    for (const n of distJs()) expect(byName(n).data.equals(lf(join(root, n))), n).toBe(true);
  });

  test('the two hook files are byte-equal to examples/hooks/claude-code', () => {
    for (const f of ['nb-claude-hook.mjs', 'nb-hook-entry.cjs']) {
      expect(byName(`examples/hooks/claude-code/${f}`).data.equals(lf(join(root, 'examples', 'hooks', 'claude-code', f)))).toBe(true);
    }
  });

  test('package.json has the name, version, type, engines and license, and no dependencies or bin', () => {
    const p = JSON.parse(byName('package.json').data.toString('utf-8')) as Record<string, unknown>;
    expect(p).toEqual({ name: pkg.name, version: pkg.version, type: 'module', engines: pkg.engines, license: pkg.license });
    expect(Object.keys(p)).not.toContain('dependencies');
    expect(Object.keys(p)).not.toContain('bin');
  });

  test('plugin.json carries the package version, and the source file carries none', () => {
    const z = JSON.parse(byName('.claude-plugin/plugin.json').data.toString('utf-8')) as Record<string, unknown>;
    const src = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8')) as Record<string, unknown>;
    expect(z.version).toBe(pkg.version);
    expect(src).not.toHaveProperty('version');
    expect(src).not.toHaveProperty('userConfig');
    const { version: _v, ...rest } = z;
    expect(rest).toEqual(src);
  });

  test('--version stamps the zip and the skill, for test fixtures', () => {
    const o = join(tmp, 'fixture');
    const r = build(SCRIPT, ['--out', o, '--version', '9.9.9-test.1'], { cwd: root });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^[0-9a-f]{64} {2}agent-notebook-plugin-9\.9\.9-test\.1\.zip\n$/);
    const z = readZip(readFileSync(join(o, 'agent-notebook-plugin-9.9.9-test.1.zip')));
    const get = (n: string): string => z.find((e) => e.name === n)!.data.toString('utf-8');
    expect(JSON.parse(get('.claude-plugin/plugin.json')).version).toBe('9.9.9-test.1');
    expect(JSON.parse(get('package.json')).version).toBe('9.9.9-test.1');
    expect(get('skills/agent-notebook/SKILL.md')).toContain('9.9.9-test.1');
  });

  test('SKILL.md has no {{VERSION}} left and names the version', () => {
    const skill = byName('skills/agent-notebook/SKILL.md').data.toString('utf-8');
    expect(skill).not.toContain('{{');
    expect(skill).toContain(`agent-notebook ${pkg.version}`);
    expect(readFileSync(join(root, 'plugin', 'skills', 'agent-notebook', 'SKILL.md'), 'utf-8')).toContain('{{VERSION}}');
  });

  test('every ${CLAUDE_PLUGIN_ROOT} path in hooks.json is a file in the zip', () => {
    const text = byName('hooks/hooks.json').data.toString('utf-8');
    const paths = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(entries.map((e) => e.name), p).toContain(p);
  });

  test('CHANGELOG.md is the repo file with LF, byte-equal to what the npm package holds (FR-PLUGIN-001, issue #560)', () => {
    // package.json "files" puts the same CHANGELOG.md in the npm package; the release job compares the two.
    expect(byName('CHANGELOG.md').data.equals(lf(join(root, 'CHANGELOG.md')))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).files).toContain('CHANGELOG.md');
  });

  test('nb status run from the staged plugin prints the release date from the shipped CHANGELOG.md', () => {
    const staged = join(out, base);
    expect(existsSync(join(staged, 'CHANGELOG.md'))).toBe(true);
    const home = mkdtempSync(join(tmp, 'status home '));
    const r = spawnSync(process.execPath, [join(staged, 'dist', 'cli.js'), 'status'], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, NB_DIR: join(home, 'nb'), NB_HOME: join(home, 'nb') },
    });
    const heading = new RegExp(`^## \\[${pkg.version.replace(/[.+]/g, '\\$&')}\\] - (\\d{4}-\\d{2}-\\d{2})`, 'm').exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf-8'));
    expect(r.stdout).toContain(`Version: ${pkg.version}`);
    // The repo's heading for this version, if it has one yet, is what the staged copy must show.
    if (heading) expect(r.stdout).toContain(`Version: ${pkg.version} (released ${heading[1]})`);
    else expect(r.stdout).not.toContain('(released');
  }, 30_000);

  test('bin/nb.cmd is exactly these CRLF lines, and no other entry holds a carriage return', () => {
    const cmd = ['@echo off', 'setlocal', 'set NoDefaultCurrentDirectoryInExePath=1', 'node "%~dp0..\\dist\\cli.js" %*', 'exit /b %errorlevel%', ''].join('\r\n');
    expect(byName('bin/nb.cmd').data.toString('utf-8')).toBe(cmd);
    for (const e of entries) if (e.name !== 'bin/nb.cmd') expect(e.data.includes(13), `${e.name} has a carriage return`).toBe(false);
  });

  test('the build script imports only node: modules', () => {
    const src = readFileSync(SCRIPT, 'utf-8');
    const specs = [...src.matchAll(/^import\b[^;]*?\bfrom '([^']+)'/gm)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(3);
    for (const s of specs) expect(s.startsWith('node:'), s).toBe(true);
    expect(/\brequire\(|\bimport\(/.test(src.replace(/\/\/.*$/gm, ''))).toBe(false);
  });
});

/** A copy of the repo layout the script reads, with a stub dist/, in which an input can be spoiled. */
function layout(): string {
  const copy = mkdtempSync(join(tmp, 'layout '));
  mkdirSync(join(copy, 'scripts'));
  cpSync(SCRIPT, join(copy, 'scripts', 'build-plugin.mjs'));
  for (const f of ['package.json', 'LICENSE', 'CHANGELOG.md']) cpSync(join(root, f), join(copy, f));
  cpSync(join(root, 'plugin'), join(copy, 'plugin'), { recursive: true });
  cpSync(join(root, 'examples', 'hooks', 'claude-code'), join(copy, 'examples', 'hooks', 'claude-code'), { recursive: true });
  mkdirSync(join(copy, 'dist'));
  cpSync(join(root, 'dist', 'cli.js'), join(copy, 'dist', 'cli.js'));
  return copy;
}

describe('the build refuses what it should not pack (FR-PLUGIN-001, issue #559)', () => {
  const refused = (copy: string): Built => build(join(copy, 'scripts', 'build-plugin.mjs'), ['--out', join(copy, 'o')]);

  test('a file with a name that Windows reserves, with any extension', () => {
    for (const name of ['aux.js', 'CON.js', 'nul.x.js', 'com1.js', 'LPT9.js']) {
      const copy = layout();
      writeFileSync(join(copy, 'dist', name), 'x\n');
      const r = refused(copy);
      expect(r.code, name).toBe(1);
      expect(r.stderr, name).toMatch(/reserved name on Windows/);
      expect(existsSync(join(copy, 'o', `${base}.zip`)), name).toBe(false);
    }
  });

  test.skipIf(process.platform === 'win32')('a file name with a backslash', () => {
    const copy = layout();
    writeFileSync(join(copy, 'dist', 'a\\b.js'), 'x\n');
    const r = refused(copy);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/has a backslash/);
  });

  test('a text file that is not UTF-8', () => {
    const copy = layout();
    writeFileSync(join(copy, 'plugin', 'hooks', 'hooks.json'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    const r = refused(copy);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not valid UTF-8/);
  });

  test('a placeholder that the version does not fill', () => {
    const copy = layout();
    const p = join(copy, 'plugin', 'skills', 'agent-notebook', 'SKILL.md');
    writeFileSync(p, readFileSync(p, 'utf-8') + '\n{{OTHER}}\n');
    const r = refused(copy);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/placeholder/);
  });

  test('a missing dist/ tells the user to run the build', () => {
    const copy = layout();
    rmSync(join(copy, 'dist'), { recursive: true });
    const r = refused(copy);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/npm run build/);
  });
});
