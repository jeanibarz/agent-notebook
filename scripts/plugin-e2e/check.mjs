// The file and settings checks of the plugin end-to-end test (issue #559). The two drivers,
// run.sh and run.ps1, call it so that each check is written once, whatever the system.
//
//   node check.mjs modes <plugin-root>                      bin/nb and dist/cli.js are 0755 (POSIX)
//   node check.mjs installed <list.json> <plugin-id> <field>   print a field of `claude plugin list --json`, or "absent"
//   node check.mjs same-tree <staged-dir> <installed-dir>   the installed files are the built ones, byte for byte
//   node check.mjs validate <captured-output.txt>           "Validation passed", and no problem but the known two
//   node check.mjs snapshot <out.json> <dir>...             remember every settings*.json under the folders
//   node check.mjs settings-diff <before> <after> <name>    only Claude Code's own keys for marketplace <name> differ
//   node check.mjs lesson <nb-dir> <shelf> <text-file> <show.json>   a lesson was stored and read back byte-equal
//
// Each prints what it saw. A miss prints "FAIL: ..." and exits 1; a wrong call exits 2.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message) {
  console.log(`FAIL: ${message}`);
  process.exit(1);
}
function usage() {
  console.error('usage: node check.mjs modes|same-tree|validate|snapshot|settings-diff|lesson ... (see the top of this file)');
  process.exit(2);
}

/** Relative `/`-separated paths of all files under `dir` ([] when it is missing). */
function walk(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix + name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel + '/'));
    else out.push(rel);
  }
  return out.sort();
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const [cmd, ...a] = process.argv.slice(2);

if (cmd === 'modes' && a.length === 1) {
  for (const f of ['bin/nb', 'dist/cli.js']) {
    const mode = statSync(join(a[0], f)).mode & 0o777;
    console.log(`${f}: mode ${mode.toString(8)}`);
    if (mode !== 0o755) fail(`${f} has mode ${mode.toString(8)}, expected 755: the zip lost its executable bit`);
  }
  console.log('ok: modes');
} else if (cmd === 'same-tree' && a.length === 2) {
  const [staged, installed] = a;
  const want = walk(staged);
  const got = walk(installed);
  const missing = want.filter((f) => !got.includes(f));
  const extra = got.filter((f) => !want.includes(f));
  if (missing.length || extra.length) fail(`installed files differ from the built ones: missing [${missing}] extra [${extra}]`);
  for (const f of want) {
    if (sha(readFileSync(join(staged, f))) !== sha(readFileSync(join(installed, f)))) fail(`${f} differs between the built folder and the installed one`);
  }
  console.log(`ok: ${want.length} installed files equal the built ones`);
} else if (cmd === 'installed' && a.length === 3) {
  // Not a check: prints one field of one plugin of `claude plugin list --json`, or "absent".
  const found = JSON.parse(readFileSync(a[0], 'utf-8')).find((p) => p.id === a[1]);
  console.log(found ? String(found[a[2]]) : 'absent');
} else if (cmd === 'validate' && a.length === 1) {
  const out = readFileSync(a[0], 'utf-8');
  if (!/Validation passed/.test(out)) fail('claude plugin validate did not print "Validation passed"');
  // Allowed: the two directory-profile findings that do not change the result (no icon, no README
  // in the staged folder), and the note about hosts. Every other coded finding is a miss.
  const allowed = new Set(['ICON_MISSING', 'README_MISSING']);
  const codes = [...out.matchAll(/\(([A-Z][A-Z0-9_]+)\)/g)].map((m) => m[1]);
  const bad = codes.filter((c) => !allowed.has(c));
  if (bad.length) fail(`claude plugin validate reported ${[...new Set(bad)].join(', ')}`);
  console.log(`ok: validation passed${codes.length ? ` (known findings: ${[...new Set(codes)].join(', ')})` : ''}`);
} else if (cmd === 'snapshot' && a.length >= 2) {
  const [outFile, ...dirs] = a;
  const files = {};
  for (const dir of dirs.map((d) => resolve(d))) {
    for (const f of walk(dir).filter((f) => /(^|\/)settings[^/]*\.json$/.test(f))) {
      const buf = readFileSync(join(dir, f));
      files[join(dir, f)] = { sha256: sha(buf), text: buf.toString('utf-8') };
    }
  }
  writeFileSync(outFile, JSON.stringify(files, null, 2));
  for (const [f, v] of Object.entries(files)) console.log(`${v.sha256}  ${f}`);
  if (!Object.keys(files).length) console.log('(no settings file)');
} else if (cmd === 'settings-diff' && a.length === 3) {
  const before = JSON.parse(readFileSync(a[0], 'utf-8'));
  const after = JSON.parse(readFileSync(a[1], 'utf-8'));
  const name = a[2];
  let ok = true;
  for (const f of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[f];
    const c = after[f];
    if (b && c && b.sha256 === c.sha256) {
      console.log(`unchanged  ${f}`);
      continue;
    }
    const bj = b ? JSON.parse(b.text) : {};
    const cj = c ? JSON.parse(c.text) : null;
    if (cj === null) {
      console.log(`REMOVED    ${f}`);
      ok = false;
      continue;
    }
    // What Claude Code leaves of its own after an uninstall: the marketplace it was told about
    // and an empty record of enabled plugins. Take those out; the rest must be what was there.
    const rest = structuredClone(cj);
    const own = [];
    if (isPlain(rest.extraKnownMarketplaces) && name in rest.extraKnownMarketplaces && !(bj.extraKnownMarketplaces && name in bj.extraKnownMarketplaces)) {
      delete rest.extraKnownMarketplaces[name];
      own.push(`extraKnownMarketplaces.${name}`);
      if (Object.keys(rest.extraKnownMarketplaces).length === 0 && !('extraKnownMarketplaces' in bj)) delete rest.extraKnownMarketplaces;
    }
    if (isPlain(rest.enabledPlugins) && Object.keys(rest.enabledPlugins).length === 0 && !('enabledPlugins' in bj)) {
      delete rest.enabledPlugins;
      own.push('enabledPlugins (empty)');
    }
    const same = JSON.stringify(sortKeys(rest)) === JSON.stringify(sortKeys(bj));
    console.log(`${same ? 'own keys only' : 'CHANGED      '}  ${f}${b ? '' : ' (new file)'}`);
    console.log(`  before: ${JSON.stringify(sortKeys(bj))}`);
    console.log(`  after:  ${JSON.stringify(sortKeys(cj))}`);
    console.log(`  Claude Code's own keys: ${own.join(', ') || 'none'}`);
    if (!same) ok = false;
  }
  if (!ok) fail('a settings file differs by more than Claude Code\'s own keys (extraKnownMarketplaces.<marketplace>, empty enabledPlugins)');
  console.log('ok: settings differ only by Claude Code\'s own keys');
} else if (cmd === 'lesson' && a.length === 4) {
  const [dir, shelf, textFile, showFile] = a;
  const text = readFileSync(textFile, 'utf-8').replace(/\r?\n$/, '');
  const stored = join(dir, `${shelf}.md`);
  if (!existsSync(stored)) fail(`no shelf file ${stored}`);
  if (!readFileSync(stored, 'utf-8').includes(text)) fail(`the shelf file does not hold the lesson byte for byte: ${JSON.stringify(readFileSync(stored, 'utf-8'))}`);
  const shown = JSON.parse(readFileSync(showFile, 'utf-8').replace(/^﻿/, ''));
  const texts = (shown.entries ?? []).map((e) => e.text);
  if (!texts.includes(text)) fail(`nb show --json returned ${JSON.stringify(texts)}, not the lesson ${JSON.stringify(text)}`);
  console.log(`ok: the lesson ${JSON.stringify(text)} was stored and read back byte-equal`);
} else {
  usage();
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlain(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
