// Check that the version is the same everywhere it is written (issue #559).
//
//   node scripts/check-release.mjs --tag vX.Y.Z --zip <plugin zip>   release mode
//   node scripts/check-release.mjs --pr                              pull request mode
//
// Release mode compares the pushed tag, package.json, package-lock.json and what is
// inside the plugin zip: the manifest, the zip's own package.json, the skill's version
// stamp, the declared Node.js engines and the entry's MIN_NODE. The tag must also have
// the shape the release job accepts (vX.Y.Z, or vX.Y.Z-name.N for a prerelease). Pull request mode has
// no tag and no zip, so it checks only the files of the repository (package.json,
// package-lock.json, and MIN_NODE against the engines), which catches a version that
// drifted when the change is merged, not at release time.
//
// Every disagreement prints one `::error::` line naming both values (GitHub shows it as
// an annotation) and the exit code is 1; with no disagreement it prints "ok" and exits 0.
// A usage error exits 2, so a crash or a typo is never mistaken for a refusal.
// It imports only node:* modules and ships in neither the npm package nor the zip.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  process.stderr.write(`check-release: ${message}\nusage: node scripts/check-release.mjs --tag vX.Y.Z --zip FILE | --pr\n`);
  process.exit(2);
}

/** The files of a zip as a Map of entry name to Buffer (stored and deflated entries). */
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name} uses compression method ${method}`);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const readJson = (buf, what) => {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch (err) {
    throw new Error(`${what} is not valid JSON (${err.message})`);
  }
};
const major = (range) => /(\d+)/.exec(String(range))?.[1];

function main(argv) {
  let tag;
  let zipPath;
  let pr = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag' && argv[i + 1] !== undefined) tag = argv[++i];
    else if (argv[i] === '--zip' && argv[i + 1] !== undefined) zipPath = argv[++i];
    else if (argv[i] === '--pr') pr = true;
    else usage(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  if (pr && (tag !== undefined || zipPath !== undefined)) usage('--pr cannot be combined with --tag or --zip');
  if (!pr && (tag === undefined || zipPath === undefined)) usage('release mode needs both --tag and --zip');

  const errors = [];
  const differ = (what, got, want) => {
    if (got !== want) errors.push(`::error::${what} is ${JSON.stringify(got)} but ${JSON.stringify(want)} was expected`);
  };

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf-8'));
  const version = pkg.version;
  if (tag !== undefined) {
    differ('tag (GITHUB_REF_NAME)', tag, `v${version}`);
    // The release job refuses any other shape, so refuse it here, before npm is published.
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$/.test(tag)) errors.push(`::error::tag shape: ${JSON.stringify(tag)} is not vX.Y.Z or vX.Y.Z-name.N`);
  }
  differ('package-lock.json version', lock.version, version);
  differ('package-lock.json packages[""].version', lock.packages?.[''].version, version);

  const entry = readFileSync(join(ROOT, 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs'), 'utf-8');
  const minNode = /^var MIN_NODE = (\d+);$/m.exec(entry)?.[1];
  differ('nb-hook-entry.cjs MIN_NODE', minNode, major(pkg.engines?.node));

  if (zipPath !== undefined) {
    const files = readZip(readFileSync(zipPath));
    const need = (name) => {
      const data = files.get(name);
      if (data === undefined) throw new Error(`the zip has no ${name}`);
      return data;
    };
    differ('zip .claude-plugin/plugin.json version', readJson(need('.claude-plugin/plugin.json'), 'plugin.json').version, version);
    const zpkg = readJson(need('package.json'), 'the zip package.json');
    differ('zip package.json version', zpkg.version, version);
    differ('zip package.json engines.node', zpkg.engines?.node, pkg.engines?.node);
    const skill = need('skills/agent-notebook/SKILL.md').toString('utf-8');
    if (!skill.includes(version)) errors.push(`::error::zip skills/agent-notebook/SKILL.md does not name version ${JSON.stringify(version)}`);
    if (skill.includes('{{')) errors.push('::error::zip skills/agent-notebook/SKILL.md still has a {{placeholder}}');
    const zentry = need('examples/hooks/claude-code/nb-hook-entry.cjs').toString('utf-8');
    differ('zip nb-hook-entry.cjs MIN_NODE', /^var MIN_NODE = (\d+);$/m.exec(zentry)?.[1], major(zpkg.engines?.node));
  }

  if (errors.length > 0) {
    process.stdout.write(errors.join('\n') + '\n');
    process.exit(1);
  }
  process.stdout.write(`check-release: ok (${version}${zipPath === undefined ? ', repository files only' : ''})\n`);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`check-release: ${err instanceof Error ? err.message : err}\n`);
  process.exit(2);
}
