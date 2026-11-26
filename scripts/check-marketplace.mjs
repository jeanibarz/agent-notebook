// Check the plugin marketplace file before a person merges it (issue #559).
//
//   node scripts/check-marketplace.mjs [--file .claude-plugin/marketplace.json]
//        [--main-file <the file as it is on main>] [--event <pull request event json>]
//        [--api <url>] [--download-base <url>] [--work <empty folder>] [--stage <folder>]
//
// The file names the one release zip that every plugin user downloads at their next update, so
// this check runs on every pull request that changes it, and a person merges it only when it is
// green. It checks, in this order, and says every miss in one `::error::` line:
//   1. the file is JSON, `name` is "agent-notebook", it has a `description`, and it holds exactly one
//      plugin, "agent-notebook", whose source is an archive at
//      https://github.com/jeanibarz/agent-notebook/releases/download/v<V>/agent-notebook-plugin-<V>.zip
//      with a sha256 of 64 lowercase hex digits;
//   2. when main already has a marketplace file naming version W: V differs from W, and a V lower than W
//      needs a line "Rollback: <why>" in the pull request body (read from the event file, which
//      defaults to $GITHUB_EVENT_PATH);
//   3. release v<V> exists (public API, no token), is not a draft, and is a prerelease exactly when V has a "-";
//   4. the zip downloads (redirects followed, at most 20 MB), its sha256 is the entry's, and its
//      .claude-plugin/plugin.json and package.json both say V.
// With --stage <folder> it then leaves what the end-to-end run needs: the zip of V (and of W) unpacked into
// <folder>/agent-notebook-plugin-<version>/, and v1.json (main's file, or this one when main has none),
// v2.json (this file) and bad.json (this file with a wrong sha256). With $GITHUB_OUTPUT set it appends
// version=<V> and sha256=<sha256>, for the steps that rebuild the tag and compare.
//
// --api and --download-base default to https://api.github.com and https://github.com; the tests point
// them at a local server. Exit 0 when every rule holds, 1 when a rule is broken, 2 for a wrong call or a
// failure of the network itself (so a crash is never read as a refusal). Only node:* modules; it ships
// in neither the npm package nor the zip.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const REPO = 'jeanibarz/agent-notebook';
const MAX_ZIP = 20 * 1024 * 1024;
const URL_RE = /^https:\/\/github\.com\/jeanibarz\/agent-notebook\/releases\/download\/v([0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?)\/agent-notebook-plugin-\1\.zip$/;
const SHA_RE = /^[0-9a-f]{64}$/;

class Usage extends Error {}
const usage = (message) => {
  throw new Usage(`${message}\nusage: node scripts/check-marketplace.mjs [--file F] [--main-file F] [--event F] [--api URL] [--download-base URL] [--work DIR] [--stage DIR]`);
};

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

/** -1, 0 or 1: semantic-version order, where a prerelease is lower than its release. */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split(/-(.*)/s);
    return { nums: core.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^[0-9]+$/.test(p);
    const qn = /^[0-9]+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Problems of the file itself; `entry` is the one plugin when it can be named. */
function checkShape(text, label) {
  const errors = [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { errors: [`${label} is not valid JSON (${err.message})`] };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { errors: [`${label} is not a JSON object`] };
  if (json.name !== 'agent-notebook') errors.push(`${label}: name is ${JSON.stringify(json.name)} but "agent-notebook" was expected`);
  if (typeof json.description !== 'string' || json.description.trim() === '') errors.push(`${label}: it has no description`);
  const plugins = json.plugins;
  if (!Array.isArray(plugins) || plugins.length !== 1) {
    errors.push(`${label}: it must hold exactly one plugin, and it holds ${Array.isArray(plugins) ? plugins.length : 'none (plugins is not a list)'}`);
    return { errors, json };
  }
  const plugin = plugins[0];
  if (plugin?.name !== 'agent-notebook') errors.push(`${label}: the plugin is named ${JSON.stringify(plugin?.name)} but "agent-notebook" was expected`);
  const source = plugin?.source;
  if (source === null || typeof source !== 'object' || source.source !== 'archive') {
    errors.push(`${label}: the plugin's source.source is ${JSON.stringify(source?.source)} but "archive" was expected`);
    return { errors, json };
  }
  const m = typeof source.url === 'string' ? URL_RE.exec(source.url) : null;
  if (!m) errors.push(`${label}: the archive url ${JSON.stringify(source.url)} is not https://github.com/${REPO}/releases/download/v<V>/agent-notebook-plugin-<V>.zip`);
  if (typeof source.sha256 !== 'string' || !SHA_RE.test(source.sha256)) errors.push(`${label}: sha256 ${JSON.stringify(source.sha256)} is not 64 lowercase hex digits`);
  return { errors, json, url: m ? source.url : undefined, version: m?.[1], sha256: source.sha256 };
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'agent-notebook-check-marketplace' } });
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(`download of ${url} answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_ZIP) return { tooBig: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_ZIP) return { tooBig: true };
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks) };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const parseJson = (buf) => {
  try {
    return JSON.parse(buf.toString('utf-8'));
  } catch {
    return undefined;
  }
};

/** Writes the zip's files under dir (refusing any name that leaves it). */
function unpack(files, dir) {
  const root = resolve(dir);
  for (const [name, data] of files) {
    if (name.endsWith('/')) continue;
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`the zip has an entry outside its folder: ${name}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

async function main(argv) {
  const opt = { file: '.claude-plugin/marketplace.json', api: 'https://api.github.com', 'download-base': 'https://github.com' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--file', '--main-file', '--event', '--api', '--download-base', '--work', '--stage'].includes(key) || argv[i + 1] === undefined) usage(`bad argument ${JSON.stringify(key)}`);
    opt[key.slice(2)] = argv[++i];
  }
  opt.event ??= process.env.GITHUB_EVENT_PATH;
  let work = opt.work;
  if (work === undefined) work = mkdtempSync(join(tmpdir(), 'check-marketplace-'));
  else if (existsSync(work) && readdirSync(work).length > 0) usage(`--work ${work} is not empty`);
  mkdirSync(work, { recursive: true });
  if (opt.stage !== undefined && existsSync(opt.stage) && readdirSync(opt.stage).length > 0) usage(`--stage ${opt.stage} is not empty`);

  const errors = [];
  const fileText = readFileSync(opt.file, 'utf-8');
  const shape = checkShape(fileText, opt.file);
  errors.push(...shape.errors);

  // 2. against what main already names
  let mainShape;
  let mainText;
  if (opt['main-file'] !== undefined && existsSync(opt['main-file'])) {
    mainText = readFileSync(opt['main-file'], 'utf-8');
    mainShape = checkShape(mainText, 'main marketplace.json');
    if (mainShape.version === undefined) errors.push(...mainShape.errors.map((e) => `${e} (so this change cannot be compared with it)`));
  }
  const V = shape.version;
  const W = mainShape?.version;
  if (V !== undefined && W !== undefined) {
    if (V === W) errors.push(`version ${V} is the one main already names: a version is never reused, cut a new one`);
    else if (compareVersions(V, W) < 0) {
      let body = '';
      if (opt.event !== undefined && existsSync(opt.event)) body = parseJson(readFileSync(opt.event))?.pull_request?.body ?? '';
      if (!/^[ \t]*Rollback:[ \t]*\S/m.test(String(body))) errors.push(`version ${V} is lower than ${W}, which main names: a rollback needs a line "Rollback: <why>" in the pull request body`);
    }
  }
  if (V === undefined || shape.sha256 === undefined || !SHA_RE.test(shape.sha256)) {
    process.stdout.write(errors.map((e) => `::error::${e}`).join('\n') + '\n');
    return 1;
  }

  // 3. the release
  const apiUrl = `${opt.api.replace(/\/$/, '')}/repos/${REPO}/releases/tags/v${V}`;
  const rel = await fetch(apiUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-notebook-check-marketplace' } });
  let zipBytes;
  if (rel.status === 404) errors.push(`release v${V} does not exist: publish it before naming it here`);
  else if (!rel.ok) throw new Error(`${apiUrl} answered HTTP ${rel.status}`);
  else {
    const release = await rel.json();
    if (release.draft !== false) errors.push(`release v${V} is a draft: only a published release may be named here`);
    if (release.prerelease !== V.includes('-')) errors.push(`release v${V} has prerelease=${release.prerelease} but version ${V} ${V.includes('-') ? 'has' : 'has no'} "-", so it must be ${V.includes('-')}`);
  }

  // 4. the zip
  const fetched = async (url) => download(opt['download-base'].replace(/\/$/, '') + url.slice('https://github.com'.length));
  const dl = await fetched(shape.url);
  if (dl.missing) errors.push(`the zip ${shape.url} does not exist (HTTP 404)`);
  else if (dl.tooBig) errors.push(`the zip ${shape.url} is larger than 20 MB`);
  else {
    zipBytes = dl.bytes;
    writeFileSync(join(work, `agent-notebook-plugin-${V}.zip`), zipBytes);
    const got = sha256(zipBytes);
    if (got !== shape.sha256) errors.push(`the zip's sha256 is ${got} but the marketplace file says ${shape.sha256}`);
    else {
      let files;
      try {
        files = readZip(zipBytes);
      } catch (err) {
        errors.push(`the zip cannot be read: ${err.message}`);
      }
      if (files) {
        for (const [name, what] of [['.claude-plugin/plugin.json', "the zip's .claude-plugin/plugin.json"], ['package.json', "the zip's package.json"]]) {
          const data = files.get(name);
          if (data === undefined) errors.push(`the zip has no ${name}`);
          else if (parseJson(data)?.version !== V) errors.push(`${what} says version ${JSON.stringify(parseJson(data)?.version)} but ${JSON.stringify(V)} was expected`);
        }
        if (errors.length === 0 && opt.stage !== undefined) unpack(files, join(opt.stage, `agent-notebook-plugin-${V}`));
      }
    }
  }

  if (errors.length > 0) {
    process.stdout.write(errors.map((e) => `::error::${e}`).join('\n') + '\n');
    return 1;
  }

  if (opt.stage !== undefined) {
    if (mainShape?.version !== undefined) {
      const old = await fetched(mainShape.url);
      if (old.bytes === undefined) throw new Error(`the zip main names (${mainShape.url}) cannot be downloaded`);
      if (sha256(old.bytes) !== mainShape.sha256) throw new Error(`the zip main names (${mainShape.url}) does not match main's sha256`);
      unpack(readZip(old.bytes), join(opt.stage, `agent-notebook-plugin-${W}`));
    }
    const bad = JSON.parse(fileText);
    bad.plugins[0].source.sha256 = '0'.repeat(64);
    writeFileSync(join(opt.stage, 'v1.json'), mainText ?? fileText);
    writeFileSync(join(opt.stage, 'v2.json'), fileText);
    writeFileSync(join(opt.stage, 'bad.json'), JSON.stringify(bad, null, 2) + '\n');
    writeFileSync(join(opt.stage, 'versions.txt'), `${W ?? V}\n${V}\n`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${V}\nsha256=${shape.sha256}\n`);
  process.stdout.write(`check-marketplace: ok (${V}, sha256 ${shape.sha256}${W === undefined ? ', main names no version' : `, main names ${W}`})\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`check-marketplace: ${err instanceof Error ? err.message : err}\n`);
    process.exit(2);
  },
);
