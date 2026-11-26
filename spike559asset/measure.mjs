// Spike #559 step 7 (real release asset). Throwaway, lives on branch spike/559-asset only, never merged.
// node measure.mjs <phase>   phases: setup p1 p2 p3 p4a p4b p5 p7
// Each phase prints lines "RESULT item<N> ..." with the evidence; it never fails on a surprising answer.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import https from 'node:https';
import { homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const E2E = join(REPO, 'scripts', 'plugin-e2e');
const WIN = platform() === 'win32';
const OLD_V = '0.13.0-beta.1.559';
const NEW_V = '0.13.0-beta.2';
const NEW_SHA = '68b64348e8b7d8cd32bd4b8f9831fc5c0089ef385ec63d71003d07ce1627c5cf';
const ASSET = `https://github.com/jeanibarz/agent-notebook/releases/download/v${NEW_V}/agent-notebook-plugin-${NEW_V}.zip`;
const RAWBASE = 'https://raw.githubusercontent.com/jeanibarz/agent-notebook/refs/heads/spike/559-asset/spike559asset/raw';
const RAW = `${RAWBASE}/marketplace.json`;
const OTHER = `${RAWBASE}/other.json`;
const PROD = 'https://raw.githubusercontent.com/jeanibarz/agent-notebook/main/.claude-plugin/marketplace.json';
const MKT = 'agent-notebook';
const ID = `agent-notebook@${MKT}`;

const WORK = resolve(process.env.E2E_WORK || join(process.env.RUNNER_TEMP || tmpdir(), 'nb-asset'));
const REALHOME = process.env.REAL_HOME || homedir();
const H = join(WORK, WIN ? 'Ana Mar\u00eda' : "J\u00f6hn D'oe $x Spike");
const PROJ = join(H, 'proj');
const STAGE = join(WORK, 'stage');
const STATE = join(WORK, 'state.json');
const redact = (s) => String(s).split(WORK).join('<work>');
const say = (...a) => console.log(redact(a.join(' ')));
const ts = () => new Date().toISOString();
const res = (item, text) => say(`RESULT item${item} [${ts()}] ${text}`);
const rd = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const wr = (patch) => writeFileSync(STATE, JSON.stringify({ ...rd(), ...patch }, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeBin() {
  const names = WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [join(REALHOME, '.local', 'bin'), ...(process.env.PATH || process.env.Path || '').split(WIN ? ';' : ':')];
  for (const d of dirs) for (const n of names) if (d && existsSync(join(d, n))) return join(d, n);
  throw new Error('claude not found');
}
const CLAUDE = claudeBin();
const CLAUDE_DIR = dirname(CLAUDE);
const NODE_DIR = dirname(process.execPath);

// the stub PATH: system programs, no node, no git, no unzip, no tar
function stubPath() {
  if (WIN) {
    const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    return [CLAUDE_DIR, sys, process.env.SystemRoot, join(sys, 'WindowsPowerShell', 'v1.0')].join(';');
  }
  const farm = join(WORK, 'stubbin');
  if (!existsSync(farm)) {
    mkdirSync(farm, { recursive: true });
    for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      if (!existsSync(d)) continue;
      for (const b of readdirSync(d)) {
        if (/^(node|nodejs|npm|npx|git|unzip|tar|bsdtar|gtar)$/.test(b)) continue;
        try { if (!existsSync(join(farm, b))) symlinkSync(join(d, b), join(farm, b)); } catch {}
      }
    }
  }
  return `${farm}:${CLAUDE_DIR}`;
}
const PATH_NONODE = () => stubPath();
const PATH_NODE = () => (WIN ? `${NODE_DIR};${stubPath()}` : `${NODE_DIR}:${stubPath()}`);

function envFor(p, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(k)) delete env[k];
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = p;
  Object.assign(env, { HOME: H, USERPROFILE: H, APPDATA: join(H, 'AppData', 'Roaming'), LOCALAPPDATA: join(H, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: join(H, '.claude'), DISABLE_AUTOUPDATER: '1' }, extra);
  return env;
}
mkdirSync(PROJ, { recursive: true });
mkdirSync(join(H, '.claude'), { recursive: true });
mkdirSync(join(H, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(H, 'AppData', 'Local'), { recursive: true });

function cl(args, { path = PATH_NONODE(), cwd = PROJ, quiet = false, env = {} } = {}) {
  if (!quiet) say(`$ claude ${args.join(' ')}`);
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, args, { cwd, env: envFor(path, env), input: '', encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ms = Date.now() - t0;
  if (!quiet) { if (out) say(out); say(`[exit ${r.status}, ${ms} ms]`); }
  return { out, rc: r.status, ms, stdout: r.stdout || '' };
}
function installed() {
  const r = cl(['plugin', 'list', '--json'], { quiet: true });
  try { const f = JSON.parse(r.stdout).find((p) => p.id === ID); return f ? { version: f.version, installPath: f.installPath, folderVersion: f.folderVersion } : null; } catch { return { error: r.out.slice(0, 200) }; }
}
function node(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// ---- https helpers ----
function get(url, { head = false, body = true } = {}) {
  return new Promise((ok, bad) => {
    const req = https.get(url, { headers: { 'user-agent': 'spike559asset' } }, (res) => {
      if (!body) { res.destroy(); return ok({ status: res.statusCode, headers: res.headers }); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', bad);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}
async function chain(url) {
  const hops = [];
  for (let i = 0; i < 10; i++) {
    const r = await get(url, { body: false });
    const u = new URL(url);
    hops.push(`${r.status} ${u.host}${u.pathname.slice(0, 70)}`);
    if (r.status >= 300 && r.status < 400 && r.headers.location) url = new URL(r.headers.location, url).href;
    else break;
  }
  return hops;
}
async function download(url) {
  for (let i = 0; i < 10; i++) {
    const r = await get(url);
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.location, url).href; continue; }
    if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.body;
  }
  throw new Error('too many redirects');
}
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ---- zip ----
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl2 = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nl + el + cl2;
  }
  return files;
}
function unpack(files, dir) {
  const root = resolve(dir);
  for (const [name, data] of files) {
    if (name.endsWith('/')) continue;
    const t = resolve(root, name);
    if (!t.startsWith(root + sep)) throw new Error('zip entry outside folder');
    mkdirSync(dirname(t), { recursive: true });
    writeFileSync(t, data);
  }
}
const stagedOf = (v) => join(STAGE, `agent-notebook-plugin-${v}`);
const entryOf = (v) => join(stagedOf(v), 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs');

function version() {
  const r = cl(['--version'], { quiet: true });
  return r.out;
}
function session(label, expect, ver) {
  const path = expect === 'nonode' ? PATH_NONODE() : PATH_NODE();
  say(`--- session: ${label}`);
  const t0 = Date.now();
  const r = spawnSync(CLAUDE, ['-p', 'hi', '--output-format', 'stream-json', '--verbose'], { cwd: PROJ, env: envFor(path), input: '', encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const f = join(WORK, 'session.jsonl');
  writeFileSync(f, r.stdout || '');
  const h = node([join(E2E, 'hookrep.mjs'), f, '--expect', expect, '--os', WIN ? 'windows' : 'posix', '--entry', entryOf(NEW_V), '--plugin-version', ver]);
  say(h.out);
  say(`[session exit ${r.status}, ${Date.now() - t0} ms; hookrep exit ${h.rc}]`);
  return h.rc === 0;
}
function mktJson(url, sha256, name = MKT) { return { name, url, sha256 }; }

async function waitState(n) {
  const t0 = Date.now();
  say(`WAITING for ${RAW} to serve state=${n} (since ${ts()})`);
  for (let i = 0; ; i++) {
    const r = await get(RAW);
    const body = r.body.toString('utf8');
    if (r.status === 200 && body.includes(`state=${n}`)) {
      const sec = Math.round((Date.now() - t0) / 1000);
      const h = r.headers;
      res(2, `raw URL serves state=${n} after ${sec} s of polling (poll started ${new Date(t0).toISOString()}); headers: cache-control=${h['cache-control']} age=${h.age} x-cache=${h['x-cache']} etag=${h.etag} date=${h.date}`);
      return { sec, at: ts() };
    }
    if (i % 6 === 0) say(`  still not state=${n}: HTTP ${r.status}, ${(body.match(/state=\d/) || ['no state'])[0]}, age=${r.headers.age}`);
    if (Date.now() - t0 > 40 * 60 * 1000) { res(2, `GAVE UP waiting for state=${n} after 40 min`); return null; }
    await sleep(10000);
  }
}
function mktAge() {
  const f = join(H, '.claude', 'plugins', 'known_marketplaces.json');
  if (!existsSync(f)) return 'no known_marketplaces.json';
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const e = j[MKT];
  if (!e) return `no entry; keys ${Object.keys(j)}`;
  const age = e.lastUpdated ? `${Math.round((Date.now() - Date.parse(e.lastUpdated)) / 1000)} s ago` : 'no lastUpdated';
  return `lastUpdated=${e.lastUpdated} (${age}); entry=${JSON.stringify(e).slice(0, 300)}`;
}
// update: (a) plugin update alone, then if it says latest (b) marketplace update + update
function updateTo(want, item) {
  const before = installed();
  say(`installed before: ${JSON.stringify(before)}; marketplace cache: ${mktAge()}`);
  const a = cl(['plugin', 'update', ID]);
  const afterA = installed();
  res(item, `(a) "claude plugin update ${ID}" ALONE printed: ${JSON.stringify(a.out)} exit ${a.rc} (${a.ms} ms); installed now ${afterA && afterA.version}`);
  if (afterA && afterA.version === want) { res(item, `VERDICT update alone suffices: ${before && before.version} -> ${want}`); return { alone: true }; }
  const m = cl(['plugin', 'marketplace', 'update', MKT]);
  const b = cl(['plugin', 'update', ID]);
  const afterB = installed();
  res(item, `(b) after "marketplace update ${MKT}" (printed ${JSON.stringify(m.out)}) "plugin update" printed ${JSON.stringify(b.out)} exit ${b.rc}; installed now ${afterB && afterB.version}`);
  res(item, `VERDICT update alone did NOT suffice; marketplace update + update ${afterB && afterB.version === want ? 'reached' : 'did NOT reach'} ${want}`);
  return { alone: false };
}

const phase = process.argv[2];
async function main() {
  if (phase === 'setup') {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true }); mkdirSync(PROJ, { recursive: true }); mkdirSync(join(H, '.claude'), { recursive: true });
    mkdirSync(join(H, 'AppData', 'Roaming'), { recursive: true }); mkdirSync(join(H, 'AppData', 'Local'), { recursive: true });
    say(`=== ${platform()} ${process.arch}, claude ${version()}, node ${process.version}, date ${ts()}, home ${H}`);
    const hops = await chain(ASSET);
    res(4, `redirect chain of ${ASSET}:\n    ${hops.join('\n    ')}`);
    const hosts = hops.map((h) => h.split(' ')[1].split('/')[0]);
    res(4, `hosts reached: ${[...new Set(hosts)].join(', ')}`);
    const zip = await download(ASSET);
    res(8, `real zip size ${zip.length} bytes, sha256 ${sha(zip)} (expected ${NEW_SHA}): ${sha(zip) === NEW_SHA ? 'EQUAL' : 'DIFFERENT'}`);
    const sidecar = (await download(`${ASSET}.sha256`)).toString('utf8').trim();
    res(4, `.sha256 asset says: ${sidecar}`);
    unpack(readZip(zip), stagedOf(NEW_V));
    const old = await download(`${RAWBASE}/old/agent-notebook-plugin-${OLD_V}.zip`);
    res(1, `old zip served from raw: ${old.length} bytes sha256 ${sha(old)}`);
    unpack(readZip(old), stagedOf(OLD_V));
    wr({ oldSha: sha(old), t0: ts() });
    if (WIN) {
      for (const d of ['C:\\Program Files\\Git', 'C:\\msys64', 'C:\\Program Files\\PowerShell']) {
        if (existsSync(d)) { renameSync(d, `${d}-nb-hidden`); say(`hidden: ${d}`); }
      }
    }
    const prog = ['node', 'git', 'unzip', 'tar'];
    const found = prog.filter((p) => spawnSync(WIN ? 'where.exe' : 'sh', WIN ? [p] : ['-c', `command -v ${p}`], { env: { ...process.env, PATH: PATH_NONODE() }, encoding: 'utf8' }).status === 0);
    say(`programs found on the stub PATH: ${JSON.stringify(found)} (expected [])`);
  } else if (phase === 'p1') {
    say(`=== item 1: install from ${RAW} (state=1, old zip), no node and no git on PATH`);
    const raw = (await get(RAW)).body.toString('utf8');
    say(`marketplace file as served:\n${raw}`);
    const r = cl(['plugin', 'install', 'agent-notebook', '--marketplace', RAW]);
    const i = installed();
    res(1, `install exit ${r.rc} in ${r.ms} ms; output ${JSON.stringify(r.out)}; installed ${JSON.stringify(i)}`);
    res(8, `install time (marketplace fetch + 564 KB archive download from raw + unpack): ${r.ms} ms`);
    if (i && i.installPath) say(node([join(E2E, 'check.mjs'), 'same-tree', stagedOf(OLD_V), i.installPath]).out);
    res(1, `VERDICT ${r.rc === 0 && i && i.version === OLD_V ? 'installed ' + OLD_V + ' with neither node nor git on PATH' : 'FAILED'}`);
    wr({ tInstall: ts() });
    say(`marketplace cache after install: ${mktAge()}`);
  } else if (phase === 'p2') {
    say(`=== item 2: wait for the push naming the real asset`);
    await waitState(2);
    const u = updateTo(NEW_V, 2);
    const i = installed();
    res(2, `after: ${JSON.stringify(i)} (expected ${OLD_V} -> ${NEW_V}); marketplace cache ${mktAge()}`);
  } else if (phase === 'p3') {
    say('=== item 3: sessions and files after the update');
    const i = installed();
    say(`installed: ${JSON.stringify(i)}`);
    if (!i || !i.installPath) return;
    const ok1 = session('current Node.js on PATH', 'newnode', NEW_V);
    res(3, `session with node: ${ok1 ? 'index from the ' + NEW_V + ' folder, no notice (hookrep ok)' : 'FAILED (see log above)'}`);
    const ok2 = session('no node on PATH', 'nonode', NEW_V);
    res(3, `session without node: ${ok2 ? 'exactly one notice (hookrep ok)' : 'FAILED (see log above)'}`);
    if (!WIN) {
      const m = node([join(E2E, 'check.mjs'), 'modes', i.installPath]);
      say(m.out); res(3, `modes: ${m.rc === 0 ? 'bin/nb and dist/cli.js 0755' : 'FAILED'}`);
    } else {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$z=@(Get-ChildItem -Recurse -Force -LiteralPath '${i.installPath.replace(/'/g, "''")}' | Where-Object { -not $_.PSIsContainer } | Where-Object { Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }); 'zone-identifier files: ' + $z.Count`], { encoding: 'utf8' });
      say(ps.stdout + ps.stderr); res(3, `Windows: ${ps.stdout.trim()}`);
    }
    const t = node([join(E2E, 'check.mjs'), 'same-tree', stagedOf(NEW_V), i.installPath]);
    say(t.out); res(3, `same-tree vs the real zip: ${t.out}`);
  } else if (phase === 'p4a') {
    say('=== item 5a: roll back: wait for state=3 (old zip again)');
    await waitState(3);
    updateTo(OLD_V, 5);
    res(5, `after rollback: ${JSON.stringify(installed())}`);
  } else if (phase === 'p4b') {
    say('=== item 5b: roll forward again: wait for state=4 (real asset)');
    await waitState(4);
    updateTo(NEW_V, 5);
    res(5, `after roll forward: ${JSON.stringify(installed())}`);
    session('after roll forward, current Node.js', 'newnode', NEW_V);
  } else if (phase === 'p5') {
    say('=== item 6: uninstall');
    const cfg = join(H, '.claude');
    say(`settings.json before uninstall: ${existsSync(join(cfg, 'settings.json')) ? readFileSync(join(cfg, 'settings.json'), 'utf8') : '(none)'}`);
    const r = cl(['plugin', 'uninstall', ID]);
    res(6, `uninstall exit ${r.rc}: ${JSON.stringify(r.out)}; plugin list now: ${JSON.stringify(installed())}`);
    const f = join(cfg, 'settings.json');
    res(6, `settings.json after uninstall: ${existsSync(f) ? readFileSync(f, 'utf8').replace(/\s+/g, ' ') : '(none)'}`);
    const ip = join(cfg, 'plugins', 'installed_plugins.json');
    res(6, `installed_plugins.json after: ${existsSync(ip) ? readFileSync(ip, 'utf8').replace(/\s+/g, ' ') : '(none)'}`);
    const km = join(cfg, 'plugins', 'known_marketplaces.json');
    res(6, `known_marketplaces.json after: ${existsSync(km) ? readFileSync(km, 'utf8').replace(/\s+/g, ' ').slice(0, 400) : '(none)'}`);
    const cache = join(cfg, 'plugins', 'cache', MKT, 'agent-notebook');
    res(6, `cache folders left: ${existsSync(cache) ? readdirSync(cache).join(', ') : '(none)'}`);
    session('after uninstall', 'none', NEW_V);
  } else if (phase === 'p7') {
    say('=== item 7 (Linux): managed settings, strictKnownMarketplaces');
    const POL = '/etc/claude-code/managed-settings.json';
    const sudo = (args, input) => spawnSync('sudo', args, { input, encoding: 'utf8' });
    const pol = (obj) => { sudo(['mkdir', '-p', '/etc/claude-code']); sudo(['tee', POL], JSON.stringify(obj)); say(`POLICY: ${JSON.stringify(obj)}`); };
    const fresh = () => { rmSync(join(H, '.claude'), { recursive: true, force: true }); mkdirSync(join(H, '.claude'), { recursive: true }); };
    const inst = (url) => cl(['plugin', 'install', 'agent-notebook', '--marketplace', url]);
    pol({ strictKnownMarketplaces: [{ source: 'url', url: RAW }] });
    fresh(); let r = inst(RAW); let i = installed();
    res(7, `A policy names the exact branch URL; install from it: exit ${r.rc}, ${JSON.stringify(r.out)}, installed ${JSON.stringify(i)} (this includes the archive download from github.com and its redirect host)`);
    fresh(); r = inst(OTHER); res(7, `B same policy, another raw path on the same host (${OTHER.slice(OTHER.indexOf('spike559'))}): exit ${r.rc}, ${JSON.stringify(r.out)}, installed ${JSON.stringify(installed())}`);
    pol({ strictKnownMarketplaces: [{ source: 'url', url: PROD }] });
    fresh(); r = inst(RAW); res(7, `C policy names the would-be production URL, install from the branch URL: exit ${r.rc}, ${JSON.stringify(r.out)}, installed ${JSON.stringify(installed())}`);
    fresh(); r = inst(PROD); res(7, `D (control) policy names the production URL, install from it (404 on main today): exit ${r.rc}, ${JSON.stringify(r.out)}`);
    sudo(['rm', '-f', POL]);
    fresh(); r = inst(OTHER); res(7, `E (control) no policy, the other raw path: exit ${r.rc}, ${JSON.stringify(r.out)}, installed ${JSON.stringify(installed())}`);
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
}
main().catch((e) => { say(`PHASE ${phase} ERROR: ${e && e.stack || e}`); }).finally(() => process.exit(0));
