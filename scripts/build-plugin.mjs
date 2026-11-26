// Build the Claude Code plugin's zip (issue #559).
//
//   node scripts/build-plugin.mjs [--out DIR] [--version V]
//
// It stages the plugin in <out>/agent-notebook-plugin-<V>/ (a folder that
// `claude --plugin-dir` can load) and writes next to it
//   agent-notebook-plugin-<V>.zip          the same files, zipped
//   agent-notebook-plugin-<V>.zip.sha256   in `sha256sum` format
// and prints "<sha256>  <zip name>". <out> defaults to build/plugin, V to the
// version in package.json. --version exists for test fixtures only.
//
// The build must be repeatable: the same inputs give the same bytes on any
// machine, so anyone can rebuild a tag and compare the checksum. That is why this
// file writes the zip itself instead of calling `zip`: no timestamps, no file
// system modes, entries in a fixed order, and no external tool whose version
// changes the bytes. Text inputs are read with CRLF turned into LF, because a
// Windows checkout turns them into CRLF and the bytes would otherwise differ.
//
// It needs dist/ (run `npm run build` first) and imports only node:* modules:
// it is part of neither the npm package nor the zip.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The launcher for Windows. It is generated here, not stored, because the repo has no
// .gitattributes and an autocrlf checkout would rewrite a stored copy. `setlocal` and
// NoDefaultCurrentDirectoryInExePath stop cmd.exe from running a node.exe or node.cmd
// planted in the current folder.
const NB_CMD = ['@echo off', 'setlocal', 'set NoDefaultCurrentDirectoryInExePath=1', 'node "%~dp0..\\dist\\cli.js" %*', 'exit /b %errorlevel%', ''].join('\r\n');

const EXEC = 0o100755;
const FILE = 0o100644;
// Unix modes come from this table, never from the file system: a Windows checkout has no exec bits.
const EXEC_NAMES = new Set(['bin/nb', 'dist/cli.js']);

function fail(message) {
  process.stderr.write(`build-plugin: ${message}\n`);
  process.exit(1);
}

// ---- inputs ---------------------------------------------------------------------

/** A text input as a Buffer: valid UTF-8 only, CRLF turned into LF. */
function text(path) {
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (err) {
    fail(`${path} is not valid UTF-8 text (${err instanceof Error ? err.message : err})`);
  }
  return Buffer.from(s.replace(/\r\n/g, '\n'), 'utf-8');
}

/** The relative paths of all files under `dir`, `/`-separated. */
function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix + name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel + '/'));
    else out.push(rel);
  }
  return out;
}

/** Refuse an entry name that would unpack outside its folder or cannot exist on Windows. */
function checkName(name) {
  const bad = (why) => fail(`refusing entry name ${JSON.stringify(name)}: ${why}`);
  if (name.includes('\\')) bad('it has a backslash');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) bad('it is an absolute path');
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') bad(`it has a "${seg}" segment`);
    // CON, PRN, AUX, NUL, COM1-9, LPT1-9, with any extension, in any letter case.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) bad(`"${seg}" is a reserved name on Windows`);
  }
}

// ---- the zip writer: STORE only, so there is nothing to vary ------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE_1980_01_01 = 0x21; // year 1980 (0), month 1, day 1; the time stays 00:00:00
const UTF8_FLAG = 0x0800; // general-purpose bit 11: names are UTF-8

/** entries: [{ name, data: Buffer, mode }]. No directory entries and no extra fields. */
function zip(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf-8'), Buffer.from(b.name, 'utf-8')));
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of sorted) {
    const name = Buffer.from(e.name, 'utf-8');
    const crc = crc32(e.data);
    const size = e.data.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header
    lh.writeUInt16LE(10, 4); // version needed: 1.0
    lh.writeUInt16LE(UTF8_FLAG, 6);
    lh.writeUInt16LE(0, 8); // method 0: stored
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18); // compressed size
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28); // extra field length
    local.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory header
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    ch.writeUInt16LE(10, 6);
    ch.writeUInt16LE(UTF8_FLAG, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((e.mode << 16) >>> 0, 38); // external attributes: the Unix mode
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + size;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dir, end]);
}

// ---- main ------------------------------------------------------------------------

function main(argv) {
  let out = join(ROOT, 'build', 'plugin');
  let version;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1] !== undefined) out = resolve(argv[++i]);
    else if (argv[i] === '--version' && argv[i + 1] !== undefined) version = argv[++i];
    else fail(`unknown argument ${JSON.stringify(argv[i])} (usage: node scripts/build-plugin.mjs [--out DIR] [--version V])`);
  }
  const pkg = JSON.parse(text(join(ROOT, 'package.json')).toString('utf-8'));
  version ??= pkg.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) fail(`${JSON.stringify(version)} is not a version`);
  if (!existsSync(join(ROOT, 'dist', 'cli.js'))) fail('dist/cli.js is missing: run `npm run build` first');

  const files = new Map(); // entry name -> Buffer
  const add = (name, data) => {
    checkName(name);
    if (files.has(name)) fail(`entry ${JSON.stringify(name)} is listed twice`);
    files.set(name, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8'));
  };
  const json = (value) => JSON.stringify(value, null, 2) + '\n';

  const manifest = JSON.parse(text(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json')).toString('utf-8'));
  const { name: pluginName, ...rest } = manifest;
  add('.claude-plugin/plugin.json', json({ name: pluginName, version, ...rest }));
  add('package.json', json({ name: pkg.name, version, type: 'module', engines: pkg.engines, license: pkg.license }));
  add('LICENSE', text(join(ROOT, 'LICENSE')));
  add('bin/nb', text(join(ROOT, 'plugin', 'bin', 'nb')));
  add('bin/nb.cmd', NB_CMD); // CRLF on purpose: the one file that keeps it
  for (const f of walk(join(ROOT, 'dist')).filter((f) => f.endsWith('.js'))) add(`dist/${f}`, text(join(ROOT, 'dist', f)));
  for (const f of ['nb-claude-hook.mjs', 'nb-hook-entry.cjs']) add(`examples/hooks/claude-code/${f}`, text(join(ROOT, 'examples', 'hooks', 'claude-code', f)));
  add('hooks/hooks.json', text(join(ROOT, 'plugin', 'hooks', 'hooks.json')));
  const skill = text(join(ROOT, 'plugin', 'skills', 'agent-notebook', 'SKILL.md')).toString('utf-8').replaceAll('{{VERSION}}', version);
  if (skill.includes('{{')) fail('skills/agent-notebook/SKILL.md still has a {{placeholder}} after the version was filled in');
  add('skills/agent-notebook/SKILL.md', skill);

  const entries = [...files].map(([name, data]) => ({ name, data, mode: EXEC_NAMES.has(name) ? EXEC : FILE }));
  const base = `agent-notebook-plugin-${version}`;
  const stage = join(out, base);
  rmSync(stage, { recursive: true, force: true });
  for (const e of entries) {
    const dest = join(stage, ...e.name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
    chmodSync(dest, e.mode & 0o777); // the umask must not decide whether bin/nb can run
  }
  const zipBytes = zip(entries);
  const sha = createHash('sha256').update(zipBytes).digest('hex');
  writeFileSync(join(out, `${base}.zip`), zipBytes);
  writeFileSync(join(out, `${base}.zip.sha256`), `${sha}  ${base}.zip\n`);
  process.stdout.write(`${sha}  ${base}.zip\n`);
}

main(process.argv.slice(2));
