import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

// Issue #559: the `github-release` job of .github/workflows/release.yml is the only job that
// can write to the repository. These tests pin what the workflow file says about permissions,
// and run the job's real scripts (the bytes CI runs) against a fake `gh` and a fake `curl`
// on PATH that log their arguments and answer from fixture state.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(root, '.github', 'workflows', 'release.yml');
const release = readFileSync(WORKFLOW, 'utf-8');

// ---- a small reader of the workflow text (no YAML library in this repo) ---------------------

/** The text of the top-level job `name`, up to the next top-level job key. */
function jobBlock(name: string): string {
  const from = release.indexOf(`\n  ${name}:\n`);
  expect(from, `job ${name}`).toBeGreaterThanOrEqual(0);
  const rest = release.slice(from + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:[ \t]*\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
const jobNames = [...release.matchAll(/^ {2}([A-Za-z][\w-]*):[ \t]*$/gm)].map((m) => m[1]).filter((n) => release.includes(`\n  ${n}:\n`) && release.indexOf(`\n  ${n}:\n`) > release.indexOf('\njobs:'));
/** The steps of a job: each from its `      - ` line to the next one. */
function stepsOf(job: string): string[] {
  const from = job.indexOf('\n    steps:\n');
  expect(from).toBeGreaterThanOrEqual(0);
  return job.slice(from + 1).split(/\n(?= {6}- )/).slice(1).map((s) => s.replace(/\n(?: {0,4}#.*| *)$/gm, '').trimEnd());
}
/** The body of a step's `run: |`, dedented: the same bytes CI runs. */
function runOf(step: string): string {
  const at = step.indexOf('        run: |\n');
  expect(at, 'a run: | block').toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of step.slice(at).split('\n').slice(1)) {
    if (line.trim() === '') body.push('');
    else if (line.startsWith('          ')) body.push(line.slice(10));
    else break;
  }
  return body.join('\n').trimEnd();
}
const stripComments = (s: string): string => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const runsOf = (job: string): string[] => stepsOf(job).filter((s) => /^ {8}run: \|$/m.test(s)).map(runOf);
const permissionsOf = (job: string): string => {
  const m = /\n {4}permissions:\n((?: {6}.*\n?)+)/.exec(job);
  return m ? m[1] : '';
};

const release_ = jobBlock('github-release');
const stepByName = (start: string): string => {
  const s = stepsOf(release_).find((x) => x.includes(`name: ${start}`));
  expect(s, `step ${start}`).toBeDefined();
  return s!;
};

// ---- the workflow's shape --------------------------------------------------------------------

describe('release.yml holds the least permissions each job needs (NFR-REL-001, issue #559)', () => {
  test('the file keeps its name, and the publish job keeps the environment that npm Trusted Publishing keys on', () => {
    expect(existsSync(join(root, '.github', 'workflows', 'release.yml'))).toBe(true);
    expect(jobBlock('publish')).toMatch(/\n {4}environment: release\n/);
    expect(release_).toMatch(/\n {4}environment: release\n/);
  });

  test('the top-level permissions are empty and every job declares its own', () => {
    expect(release).toMatch(/^permissions: \{\}$/m);
    expect(release.match(/^permissions:/gm)).toHaveLength(1);
    expect(jobNames.sort()).toEqual(['build-plugin', 'github-release', 'publish', 'verify']);
    for (const n of jobNames) expect(permissionsOf(jobBlock(n)), `${n} permissions`).toMatch(/\S/);
  });

  test('only github-release can write contents, and no job has both id-token: write and contents: write', () => {
    for (const n of jobNames) {
      const p = permissionsOf(jobBlock(n));
      expect(/contents: write/.test(p), `${n} contents: write`).toBe(n === 'github-release');
      expect(/id-token: write/.test(p) && /contents: write/.test(p), `${n} both`).toBe(false);
    }
    expect(permissionsOf(release_).trim().split('\n')).toEqual(['contents: write']);
    expect(permissionsOf(jobBlock('publish'))).toMatch(/id-token: write/);
    for (const n of ['verify', 'build-plugin', 'publish']) expect(permissionsOf(jobBlock(n))).toMatch(/contents: read/);
  });

  test('github-release runs no repository code: no checkout, no setup-node, no npm', () => {
    const text = stripComments(release_);
    expect(text).not.toMatch(/actions\/checkout/);
    expect(text).not.toMatch(/actions\/setup-node/);
    for (const script of runsOf(release_)) {
      for (const line of stripComments(script).split('\n')) expect(line.trim(), line).not.toMatch(/^(npm|npx|pnpm|yarn|node)\s/);
    }
    expect(release_).toMatch(/\n {4}needs: \[publish, build-plugin\]\n/);
  });

  test('no run: script of github-release or build-plugin has a ${{ }} expression inside', () => {
    for (const n of ['github-release', 'build-plugin']) {
      const scripts = runsOf(jobBlock(n));
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(s).not.toContain('${{');
    }
  });

  test('download-artifact is pinned by a full commit SHA, takes the exact artifact name and no run id or token', () => {
    const step = stepsOf(release_)[0];
    expect(step).toMatch(/^ {6}- uses: actions\/download-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
    expect(step).toMatch(/^ {10}name: plugin-zip$/m);
    expect(step).not.toMatch(/run-id|github-token|repository:/);
  });

  test('every action in release.yml is pinned by a full commit SHA and every checkout keeps no credentials', () => {
    const uses = [...stripComments(release).matchAll(/^\s*- uses: (\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(5);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const checkouts = release.match(/uses: actions\/checkout@[^\n]*\n(?: {8}[^\n]*\n)*/g) ?? [];
    expect(checkouts).toHaveLength(3);
    for (const c of checkouts) expect(c).toMatch(/persist-credentials: false/);
  });

  test('build-plugin installs with --ignore-scripts, then uploads the artifact the release job downloads', () => {
    const job = jobBlock('build-plugin');
    expect(job).toMatch(/run: npm ci --ignore-scripts\n/);
    expect(job).not.toMatch(/run: npm ci\n/);
    expect(job).toMatch(/name: plugin-zip\n/);
    expect(job).toMatch(/retention-days: 30\n/);
    expect(job).toMatch(/sha256: \$\{\{ steps\.build\.outputs\.sha256 \}\}/);
    expect(jobBlock('publish')).toMatch(/\n {4}needs: \[verify, build-plugin\]\n/);
  });

  test('the artifact is exactly the zip, its checksum and SHA256SUMS: build-plugin writes and uploads no notes.md', () => {
    const job = jobBlock('build-plugin');
    expect(stripComments(job)).not.toContain('notes.md');
    const upload = job.slice(job.indexOf('actions/upload-artifact'));
    expect([...upload.matchAll(/^ {12}(release-out\/\S+)$/gm)].map((m) => m[1])).toEqual(['release-out/*.zip', 'release-out/*.zip.sha256', 'release-out/SHA256SUMS']);
  });

  test('the release is created with the notes the github-release job wrote, after the byte-compare step', () => {
    const names = stepsOf(release_).map((x) => /name: (.*)/.exec(x)?.[1]);
    expect(names.indexOf('Write the release notes')).toBeGreaterThan(names.indexOf('The zip equals the npm package and the tagged commit'));
    expect(names.indexOf('Write the release notes')).toBeLessThan(names.indexOf('Create the release, or confirm it already holds this zip'));
  });
});

// ---- running the job's scripts -----------------------------------------------------------------

const crc32 = (b: Buffer): number => {
  const f = (zlib as unknown as { crc32?: (d: Buffer) => number }).crc32;
  if (typeof f === 'function') return f(b);
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
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
function writeZip(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(10, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(10, 6);
    ch.writeUInt32LE(crc, 16);
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
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// The fake `gh` and `curl`: Node scripts that log each call as one JSON line (FAKE_LOG) and answer
// from FAKE_STATE: { release, immutable, assetPath, srcRoot, tarball, tagRef, tags }.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['gh', ...a]) + '\\n');
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
if (a[0] === 'release' && a[1] === 'view') {
  if (st.release === 'none') { process.stderr.write('release not found\\n'); process.exit(1); }
  if (opt('--json') === 'isImmutable') {
    if (st.immutable === 'unknown-field') { process.stderr.write('Unknown JSON field: "isImmutable"\\n'); process.exit(1); }
    process.stdout.write(String(st.immutable) + '\\n');
  } else process.stdout.write(st.release === 'draft' ? 'true\\n' : 'false\\n');
} else if (a[0] === 'release' && a[1] === 'download') {
  if (st.release !== 'published' || !st.assetPath) { process.stderr.write('no assets match\\n'); process.exit(1); }
  fs.copyFileSync(st.assetPath, require('path').join(opt('--dir'), opt('--pattern')));
} else if (a[0] === 'release') {
  // create, delete, upload, edit: a write; the test reads the log.
} else if (a[0] === 'api') {
  const p = a[1];
  let m;
  if ((m = /\\/contents\\/(.+)\\?ref=/.exec(p))) process.stdout.write(fs.readFileSync(require('path').join(st.srcRoot, m[1])).toString('base64').replace(/(.{60})/g, '$1\\n') + '\\n');
  else if (/\\/git\\/ref\\/tags\\//.test(p)) process.stdout.write(a.includes('.object.type') ? st.tagRef.type + '\\n' : st.tagRef.sha + '\\n');
  else if ((m = /\\/git\\/tags\\/(.+)$/.exec(p))) { const t = st.tags[m[1]]; process.stdout.write(a.includes('.object.type') ? t.type + '\\n' : t.sha + '\\n'); }
  else { process.stderr.write('fake gh: unexpected api ' + p + '\\n'); process.exit(1); }
} else { process.stderr.write('fake gh: unexpected ' + a.join(' ') + '\\n'); process.exit(1); }
`;
const FAKE_CURL = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['curl', ...a]) + '\\n');
const st = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.copyFileSync(st.tarball, a[a.indexOf('-o') + 1]);
`;

// The job runs on ubuntu-latest only. Its scripts use GNU tools (sha256sum, unzip, base64 -d) and
// bash 4 behaviour that macOS does not have, so the tests that run them run on Linux. The static
// pins above run everywhere.
const onLinux = { skip: process.platform !== 'linux' };

const GOOD = '1.2.3';
const BETA = '1.2.3-beta.1';
const COMMIT = 'c'.repeat(40);
let tmp: string;
let n = 0;
let bin: string;
const zips: Record<string, { path: string; files: Map<string, Buffer> }> = {};

interface World {
  ws: string; // the workspace: release-in/ beside check/
  state: Record<string, unknown>;
  log: () => string[][];
  run: (script: string, env?: Record<string, string>) => { code: number | null; out: string };
}

/** A CHANGELOG as the tagged commit holds it: an Unreleased stub, this version, an older one. */
const changelogFor = (v: string): string => `# Changelog\n\n## [Unreleased]\n\n- not yet\n\n## [${v}] - 2026-01-01\n\nFixture section for ${v}.\n\n- an item\n\n## [0.0.1] - 2020-01-01\n\nOld section.\n`;

/** A fresh workspace for version `v`: the downloaded artifact, the "npm tarball", and a "tagged commit". */
function world(v: string = GOOD, change: { zip?: (f: Map<string, Buffer>) => void; tarball?: (f: Map<string, Buffer>) => void; src?: (dir: string) => void } = {}): World {
  const ws = join(tmp, `ws${n++}`);
  const rin = join(ws, 'release-in');
  mkdirSync(rin, { recursive: true });
  const files = new Map(zips[v].files);
  change.zip?.(files);
  const zipName = `agent-notebook-plugin-${v}.zip`;
  const zipBytes = change.zip ? writeZip(files) : readFileSync(zips[v].path);
  writeFileSync(join(rin, zipName), zipBytes);
  writeFileSync(join(rin, `${zipName}.sha256`), `${sha(zipBytes)}  ${zipName}\n`);
  const sums = [...zips[v].files].sort(([x], [y]) => Buffer.compare(Buffer.from(x), Buffer.from(y))).map(([name, d]) => `${sha(d)}  ${name}`);
  writeFileSync(join(rin, 'SHA256SUMS'), sums.join('\n') + '\n');

  // The npm package: the zip's dist/ and hook files, the real LICENSE and CHANGELOG.md, a package.json with its fields.
  const tgzFiles = new Map<string, Buffer>();
  for (const [name, d] of zips[v].files) if (name.startsWith('dist/') || name.startsWith('examples/') || name === 'LICENSE' || name === 'CHANGELOG.md' || name === 'package.json') tgzFiles.set(name, d);
  change.tarball?.(tgzFiles);
  const pkgDir = join(ws, 'tgz', 'package');
  for (const [name, d] of tgzFiles) {
    mkdirSync(dirname(join(pkgDir, name)), { recursive: true });
    writeFileSync(join(pkgDir, name), d);
  }
  const tarball = join(ws, 'npm.tgz');
  expect(spawnSync('tar', ['-czf', tarball, '-C', join(ws, 'tgz'), 'package']).status).toBe(0);

  const srcRoot = join(ws, 'src');
  for (const f of ['hooks/hooks.json', 'bin/nb', '.claude-plugin/plugin.json', 'skills/agent-notebook/SKILL.md']) {
    mkdirSync(dirname(join(srcRoot, 'plugin', f)), { recursive: true });
    cpSync(join(root, 'plugin', f), join(srcRoot, 'plugin', f));
  }
  writeFileSync(join(srcRoot, 'CHANGELOG.md'), changelogFor(v));
  change.src?.(srcRoot);

  const statePath = join(ws, 'state.json');
  const logPath = join(ws, 'log.jsonl');
  const state: Record<string, unknown> = { release: 'none', immutable: true, srcRoot, tarball, tagRef: { type: 'commit', sha: COMMIT }, tags: {} };
  writeFileSync(logPath, '');
  const save = (): void => writeFileSync(statePath, JSON.stringify(state));
  save();
  return {
    ws,
    state,
    log: () => readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    run: (script, env = {}) => {
      save();
      const r = spawnSync('bash', ['-c', script], {
        cwd: rin,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
          FAKE_STATE: statePath,
          FAKE_LOG: logPath,
          TAG: `v${v}`,
          SHA256: sha(zipBytes),
          GH_REPO: 'o/r',
          GH_TOKEN: 'x',
          GITHUB_SHA: COMMIT,
          GITHUB_STEP_SUMMARY: join(ws, 'summary.md'),
          ...env,
        },
      });
      return { code: r.status, out: String(r.stdout) + String(r.stderr) };
    },
  };
}

beforeAll(() => {
  expect(existsSync(join(root, 'dist', 'cli.js')), 'dist/ not built: run `npm run build` first').toBe(true);
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'release job ')));
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['gh', FAKE_GH], ['curl', FAKE_CURL]]) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  for (const v of [GOOD, BETA]) {
    const out = join(tmp, `build-${v}`);
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'build-plugin.mjs'), '--out', out, '--version', v], { encoding: 'utf-8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const path = join(out, `agent-notebook-plugin-${v}.zip`);
    zips[v] = { path, files: readZip(readFileSync(path)) };
  }
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const WRITES = new Set(['create', 'delete', 'upload', 'edit']);
const writeCalls = (w: World): string[][] => w.log().filter((c) => c[0] === 'gh' && c[1] === 'release' && WRITES.has(c[2]));

describe('the github-release job creates the release or confirms it (NFR-REL-001, issue #559)', onLinux, () => {
  const step = runOf(stepByName('Create the release, or confirm it already holds this zip'));

  test('no release: one `release create --verify-tag` with the zip, its checksum and SHA256SUMS; a stable version is no prerelease', () => {
    const w = world(GOOD);
    const r = w.run(step);
    expect(r.code, r.out).toBe(0);
    const calls = writeCalls(w);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['gh', 'release', 'create', `v${GOOD}`, '--verify-tag', '--title', `v${GOOD}`, '--notes-file', '../notes.md', `agent-notebook-plugin-${GOOD}.zip`, `agent-notebook-plugin-${GOOD}.zip.sha256`, 'SHA256SUMS']);
  });

  test('a version with a hyphen is created as a prerelease', () => {
    const w = world(BETA);
    expect(w.run(step).code).toBe(0);
    const calls = writeCalls(w);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--prerelease');
    expect(calls[0]).toContain('--verify-tag');
  });

  test('a draft is deleted without --cleanup-tag, then created in one call', () => {
    const w = world(GOOD);
    w.state.release = 'draft';
    const r = w.run(step);
    expect(r.code, r.out).toBe(0);
    const calls = writeCalls(w);
    expect(calls.map((c) => c[2])).toEqual(['delete', 'create']);
    expect(calls[0]).toEqual(['gh', 'release', 'delete', `v${GOOD}`, '--yes']);
    expect(JSON.stringify(w.log())).not.toContain('--cleanup-tag');
    expect(calls[1]).toContain('--verify-tag');
  });

  test('a published release that holds this exact zip is left alone: no create, no upload, exit 0', () => {
    const w = world(GOOD);
    w.state.release = 'published';
    w.state.assetPath = join(w.ws, 'release-in', `agent-notebook-plugin-${GOOD}.zip`);
    const r = w.run(step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('already holds this exact zip');
    expect(writeCalls(w)).toEqual([]);
  });

  const MARKER = 'release v1.2.3 exists without this exact zip; a released archive is never replaced or added later; cut a new version.';
  test('a published release without the zip is refused with the marker and nothing is written', () => {
    const w = world(GOOD);
    w.state.release = 'published';
    const r = w.run(step);
    expect(r.out).toContain(`::error::${MARKER}`);
    expect(r.code).toBe(1);
    expect(writeCalls(w)).toEqual([]);
    expect(JSON.stringify(w.log())).not.toContain('--clobber');
  });

  test('a published release that holds a different zip is refused with the marker and nothing is written', () => {
    const w = world(GOOD);
    const other = join(w.ws, 'other.zip');
    writeFileSync(other, 'a different archive');
    w.state.release = 'published';
    w.state.assetPath = other;
    const r = w.run(step);
    expect(r.out).toContain(`::error::${MARKER}`);
    expect(r.code).toBe(1);
    expect(writeCalls(w)).toEqual([]);
  });

  test('the script never replaces an asset: no --clobber and no upload anywhere in the job', () => {
    expect(runsOf(release_).join('\n')).not.toMatch(/--clobber|release upload|--cleanup-tag/);
  });
});

describe('the github-release job fails when the release it made is not immutable (NFR-REL-001, issue #597)', onLinux, () => {
  const step = runOf(stepByName('The release is immutable'));
  const viewCalls = (w: World): string[][] => w.log().filter((c) => c[0] === 'gh' && c[1] === 'release' && c[2] === 'view');

  test('it is the last step, after the release is created and the summary written, and reads the value through env:', () => {
    const names = stepsOf(release_).map((x) => /name: (.*)/.exec(x)?.[1]);
    expect(names[names.length - 1]).toBe('The release is immutable');
    expect(names.indexOf('Create the release, or confirm it already holds this zip')).toBeLessThan(names.length - 1);
    const s = stepByName('The release is immutable');
    expect(s).toMatch(/^ {10}TAG: \$\{\{ github\.ref_name \}\}$/m);
    expect(s).toMatch(/^ {10}GH_TOKEN: \$\{\{ github\.token \}\}$/m);
    expect(s).toMatch(/^ {10}GH_REPO: \$\{\{ github\.repository \}\}$/m);
    expect(s).not.toMatch(/continue-on-error/);
    expect(s).not.toMatch(/^ {8}if:/m);
  });

  test('an immutable release passes, with one read and no write', () => {
    const w = world(GOOD);
    w.state.release = 'published';
    const r = w.run(step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`release v${GOOD} is immutable.`);
    expect(viewCalls(w)).toEqual([['gh', 'release', 'view', `v${GOOD}`, '--json', 'isImmutable', '--jq', '.isImmutable']]);
    expect(writeCalls(w)).toEqual([]);
  });

  test('a release that is not immutable fails the run with an error annotation, and nothing is written', () => {
    const w = world(GOOD);
    w.state.release = 'published';
    w.state.immutable = false;
    const r = w.run(step);
    expect(r.out).toContain(`::error::release v${GOOD} is not immutable (isImmutable: 'false')`);
    expect(r.code).toBe(1);
    expect(writeCalls(w)).toEqual([]);
  });

  test('an unreadable value fails closed: no release, an empty answer, or a gh that does not know the field', () => {
    const none = world(GOOD);
    const r1 = none.run(step);
    expect(r1.out).toContain(`::error::could not read whether release v${GOOD} is immutable.`);
    expect(r1.code).toBe(1);
    const unknown = world(GOOD);
    unknown.state.release = 'published';
    unknown.state.immutable = 'unknown-field';
    const r2 = unknown.run(step);
    expect(r2.out).toContain(`::error::could not read whether release v${GOOD} is immutable.`);
    expect(r2.code).toBe(1);
    for (const value of ['', 'null']) {
      const w = world(GOOD);
      w.state.release = 'published';
      w.state.immutable = value;
      const r = w.run(step);
      expect(r.out, value).toContain(`::error::release v${GOOD} is not immutable (isImmutable: '${value}')`);
      expect(r.code, value).toBe(1);
    }
  });
});

describe('the github-release job proves the zip equals the npm package and the tagged commit (NFR-REL-001, issue #559)', onLinux, () => {
  const step = runOf(stepByName('The zip equals the npm package and the tagged commit'));
  const DIFFER = (f: string): string => `::error::${f} in the zip differs from the npm package.`;
  const flip = (f: Map<string, Buffer>, name: string): void => {
    const b = Buffer.from(f.get(name)!);
    b[b.length >> 1] ^= 1;
    f.set(name, b);
  };

  test('a zip equal to the tarball and to plugin/ at the commit passes, asking the registry for this version', () => {
    const w = world(GOOD);
    const r = w.run(step);
    expect(r.code, r.out).toBe(0);
    const curl = w.log().find((c) => c[0] === 'curl')!;
    expect(curl[curl.length - 1]).toBe(`https://registry.npmjs.org/agent-notebook/-/agent-notebook-${GOOD}.tgz`);
  });

  test('one changed byte in a dist file of the tarball is refused, naming the file', () => {
    const w = world(GOOD, { tarball: (f) => flip(f, 'dist/cli.js') });
    const r = w.run(step);
    expect(r.out).toContain(DIFFER('dist/cli.js'));
    expect(r.code).toBe(1);
  });

  test('one changed byte in a dist file of the zip is refused too', () => {
    const w = world(GOOD, { zip: (f) => flip(f, 'dist/cli.js') });
    const r = w.run(step);
    expect(r.out).toContain(DIFFER('dist/cli.js'));
    expect(r.code).toBe(1);
  });

  test('a changed adapter or entry is refused', () => {
    for (const name of ['examples/hooks/claude-code/nb-claude-hook.mjs', 'examples/hooks/claude-code/nb-hook-entry.cjs']) {
      const r = world(GOOD, { zip: (f) => flip(f, name) }).run(step);
      expect(r.out, name).toContain(DIFFER(name));
      expect(r.code, name).toBe(1);
    }
  });

  test('a CHANGELOG.md in the zip that differs from the npm package is refused, and one missing from the zip too (issue #560)', () => {
    const r = world(GOOD, { zip: (f) => flip(f, 'CHANGELOG.md') }).run(step);
    expect(r.out).toContain(DIFFER('CHANGELOG.md'));
    expect(r.code).toBe(1);
    const missing = world(GOOD, { zip: (f) => f.delete('CHANGELOG.md') }).run(step);
    expect(missing.out).toContain("::error::the zip's file list differs");
    expect(missing.code).toBe(1);
  });

  test('an extra file in the zip is refused by the file list, before anything is unpacked', () => {
    const w = world(GOOD, { zip: (f) => f.set('hooks/extra.sh', Buffer.from('echo hi\n')) });
    const r = w.run(step);
    expect(r.out).toContain("::error::the zip's file list differs");
    expect(r.code).toBe(1);
  });

  test('a file missing from the zip is refused by the file list', () => {
    const w = world(GOOD, { zip: (f) => f.delete('bin/nb.cmd') });
    const r = w.run(step);
    expect(r.out).toContain("::error::the zip's file list differs");
    expect(r.code).toBe(1);
  });

  test('a plugin file that differs from the tagged commit is refused (hooks.json, bin/nb, plugin.json, SKILL.md)', () => {
    const cases: [string, string][] = [
      ['plugin/hooks/hooks.json', 'hooks/hooks.json in the zip differs from plugin/hooks/hooks.json'],
      ['plugin/bin/nb', 'bin/nb in the zip differs from plugin/bin/nb'],
      ['plugin/.claude-plugin/plugin.json', '.claude-plugin/plugin.json in the zip differs from plugin/.claude-plugin/plugin.json'],
      ['plugin/skills/agent-notebook/SKILL.md', 'skills/agent-notebook/SKILL.md in the zip differs from the source'],
    ];
    for (const [file, marker] of cases) {
      // JSON is compared parsed, so plugin.json gets a new key; the others get one more byte.
      const tamper = (d: string): void => {
        const text = readFileSync(join(d, file), 'utf-8');
        writeFileSync(join(d, file), file.endsWith('plugin.json') ? JSON.stringify({ ...JSON.parse(text), extra: 1 }) : text + ' ');
      };
      const w = world(GOOD, { src: tamper });
      const r = w.run(step);
      expect(r.out, file).toContain(`::error::${marker}`);
      expect(r.code, file).toBe(1);
    }
  });

  test("a zip whose package.json differs from the npm package's is refused", () => {
    const w = world(GOOD, {
      zip: (f) => {
        const j = JSON.parse(f.get('package.json')!.toString('utf-8'));
        j.license = 'Proprietary';
        f.set('package.json', Buffer.from(JSON.stringify(j, null, 2) + '\n'));
      },
    });
    const r = w.run(step);
    expect(r.out).toContain("::error::package.json in the zip differs from the npm package's");
    expect(r.code).toBe(1);
  });

  test('a changed bin/nb.cmd is refused, and the pinned sha256 is the one the build writes', () => {
    const pinned = /nb_cmd_sha256=([0-9a-f]{64})/.exec(step)?.[1];
    expect(pinned).toBeDefined();
    expect(sha(zips[GOOD].files.get('bin/nb.cmd')!)).toBe(pinned);
    const w = world(GOOD, { zip: (f) => f.set('bin/nb.cmd', Buffer.from('@echo off\r\nevil\r\n')) });
    const r = w.run(step);
    expect(r.out).toContain('::error::bin/nb.cmd in the zip is not the launcher this workflow pins');
    expect(r.code).toBe(1);
  });

  test('SHA256SUMS that does not describe the zip is refused', () => {
    const w = world(GOOD);
    writeFileSync(join(w.ws, 'release-in', 'SHA256SUMS'), `${'0'.repeat(64)}  LICENSE\n`);
    const r = w.run(step);
    expect(r.out).toContain('::error::SHA256SUMS does not match the files inside the zip.');
    expect(r.code).toBe(1);
  });

  test('a SHA256SUMS with a junk line, a missing entry, a ../ entry or a reordered line is refused; the exact file passes', () => {
    const good = readFileSync(join(world(GOOD).ws, 'release-in', 'SHA256SUMS'), 'utf-8');
    const lines = good.trimEnd().split('\n');
    const variants: Record<string, string> = {
      junk: good + 'this is not a checksum line\n',
      'missing entry': lines.slice(1).join('\n') + '\n',
      'dotdot entry': good + `${'0'.repeat(64)}  ../notes.md\n`,
      reordered: [lines[1], lines[0], ...lines.slice(2)].join('\n') + '\n',
      'no final newline': good.trimEnd(),
    };
    for (const [what, text] of Object.entries(variants)) {
      const w = world(GOOD);
      writeFileSync(join(w.ws, 'release-in', 'SHA256SUMS'), text);
      const r = w.run(step);
      expect(r.out, what).toContain('::error::SHA256SUMS does not match the files inside the zip.');
      expect(r.code, what).toBe(1);
    }
    const ok = world(GOOD).run(step);
    expect(ok.code, ok.out).toBe(0);
}, 120_000);

  test('the registry download waits up to 20 minutes for npm to serve a new tarball', () => {
    const curl = world(GOOD);
    expect(curl.run(step).code).toBe(0);
    const args = curl.log().find((c) => c[0] === 'curl')!;
    expect(args).toEqual(expect.arrayContaining(['--retry', '40', '--retry-delay', '30', '--retry-max-time', '1200', '--retry-all-errors']));
  });
});

describe('the github-release job validates its inputs and the tag (NFR-REL-001, issue #559)', onLinux, () => {
  const inputs = runOf(stepByName('Check the tag, the checksum and what the artifact holds'));
  const tagStep = runOf(stepByName('The tag still points at the commit this run started from'));

  test('a good tag, checksum and artifact pass', () => {
    const r = world(GOOD).run(inputs);
    expect(r.code, r.out).toBe(0);
  });

  test('a tag or checksum of the wrong shape is refused before anything else', () => {
    for (const tag of ['v1.2', 'v1.2.3; echo x', 'v1.2.3-Beta.1', '1.2.3', 'v1.2.3\nv1.2.4']) {
      const r = world(GOOD).run(inputs, { TAG: tag });
      expect(r.out, tag).toContain("::error::tag '");
      expect(r.code, tag).toBe(1);
    }
    for (const bad of ['abc', 'A'.repeat(64), '0'.repeat(63)]) {
      const r = world(GOOD).run(inputs, { SHA256: bad });
      expect(r.out, bad).toContain("::error::the build job's sha256");
      expect(r.code, bad).toBe(1);
    }
  });

  test('a zip that does not have the build job\'s checksum is refused', () => {
    const r = world(GOOD).run(inputs, { SHA256: '0'.repeat(64) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAILED');
  });

  test('a stray file in the artifact is refused', () => {
    const w = world(GOOD);
    writeFileSync(join(w.ws, 'release-in', 'evil.sh'), 'x');
    const r = w.run(inputs);
    expect(r.out).toContain('::error::the plugin-zip artifact holds unexpected files');
    expect(r.code).toBe(1);
  });

  test('the artifact must hold exactly the zip, its checksum and SHA256SUMS: a notes.md or a missing file is refused', () => {
    const extra = world(GOOD);
    writeFileSync(join(extra.ws, 'release-in', 'notes.md'), 'tampered\n');
    const r1 = extra.run(inputs);
    expect(r1.out).toContain('::error::the plugin-zip artifact holds unexpected files');
    expect(r1.code).toBe(1);
    const missing = world(GOOD);
    rmSync(join(missing.ws, 'release-in', 'SHA256SUMS'));
    const r2 = missing.run(inputs);
    expect(r2.out).toContain('::error::the plugin-zip artifact holds unexpected files');
    expect(r2.code).toBe(1);
  });

  test('a tag that still points at the run commit passes, also through an annotated tag object', () => {
    expect(world(GOOD).run(tagStep).code).toBe(0);
    const w = world(GOOD);
    w.state.tagRef = { type: 'tag', sha: 'a'.repeat(40) };
    w.state.tags = { ['a'.repeat(40)]: { type: 'commit', sha: COMMIT } };
    const r = w.run(tagStep);
    expect(r.code, r.out).toBe(0);
  });

  test('a tag that was moved to another commit is refused', () => {
    const w = world(GOOD);
    w.state.tagRef = { type: 'commit', sha: 'd'.repeat(40) };
    const r = w.run(tagStep);
    expect(r.out).toContain('the tag was moved');
    expect(r.code).toBe(1);
  });
});

describe('the build-plugin job writes the checksums and checks the CHANGELOG (NFR-REL-001, issue #559)', onLinux, () => {
  const step = runOf(stepsOf(jobBlock('build-plugin')).find((s) => s.includes('name: Build the plugin zip and check its versions'))!);
  const realPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
  const V = realPkg.version;

  /** A small copy of the repository, as the job's working directory. */
  function repoCopy(changelog?: string): string {
    const d = join(tmp, `repo${n++}`);
    mkdirSync(d, { recursive: true });
    for (const f of ['scripts', 'plugin', 'dist', 'examples', 'package.json', 'package-lock.json', 'LICENSE', 'CHANGELOG.md']) cpSync(join(root, f), join(d, f), { recursive: true });
    if (changelog !== undefined) writeFileSync(join(d, 'CHANGELOG.md'), changelog);
    return d;
  }
  const runStep = (d: string, ref = `v${V}`): { code: number | null; out: string } => {
    writeFileSync(join(d, 'out.txt'), '');
    const r = spawnSync('bash', ['-c', step], { cwd: d, encoding: 'utf-8', timeout: 120_000, env: { ...process.env, GITHUB_REF_NAME: ref, GITHUB_OUTPUT: join(d, 'out.txt') } });
    return { code: r.status, out: String(r.stdout) + String(r.stderr) };
  };

  test('SHA256SUMS lists every file of the zip, and no notes.md is written', () => {
    const d = repoCopy();
    const r = runStep(d);
    expect(r.code, r.out).toBe(0);
    const zipBytes = readFileSync(join(d, 'release-out', `agent-notebook-plugin-${V}.zip`));
    const files = readZip(zipBytes);
    const sums = readFileSync(join(d, 'release-out', 'SHA256SUMS'), 'utf-8').trimEnd().split('\n');
    expect(sums).toEqual([...files].sort(([x], [y]) => Buffer.compare(Buffer.from(x), Buffer.from(y))).map(([name, b]) => `${sha(b)}  ${name}`));
    expect(existsSync(join(d, 'release-out', 'notes.md'))).toBe(false);
    expect(readFileSync(join(d, 'out.txt'), 'utf-8')).toBe(`sha256=${sha(zipBytes)}\n`);
  }, 120_000);

  test('a version with no CHANGELOG section is refused', () => {
    const d = repoCopy('# Changelog\n\n## [Unreleased]\n\n- x\n');
    const r = runStep(d);
    expect(r.out).toContain(`::error::CHANGELOG.md has no section for version ${V}`);
    expect(r.code).toBe(1);
  }, 120_000);

  test('a tag that is not v<version> is refused by check-release.mjs, before any release file exists', () => {
    const d = repoCopy();
    const r = runStep(d, 'v9.9.9');
    expect(r.out).toContain('::error::tag (GITHUB_REF_NAME)');
    expect(r.code).toBe(1);
    expect(existsSync(join(d, 'release-out', 'SHA256SUMS'))).toBe(false);
  }, 120_000);
});

describe('the github-release job writes the release notes from values it verified (NFR-REL-001, issue #559)', onLinux, () => {
  const notesStep = runOf(stepByName('Write the release notes'));
  const createStep = runOf(stepByName('Create the release, or confirm it already holds this zip'));
  const session = ['hooks/hooks.json', 'examples/hooks/claude-code/nb-hook-entry.cjs', 'examples/hooks/claude-code/nb-claude-hook.mjs'];

  test('the notes carry the verified sha256 values and the CHANGELOG section; a tampered notes.md in the artifact is not what is published', () => {
    const w = world(GOOD);
    // A compromised build job leaves its own notes.md, with false values, in the artifact.
    writeFileSync(join(w.ws, 'release-in', 'notes.md'), 'Claude Code plugin: x sha256 deadbeef\nTAMPERED\n');
    const r = w.run(notesStep);
    expect(r.code, r.out).toBe(0);
    const notes = readFileSync(join(w.ws, 'notes.md'), 'utf-8');
    const zipName = `agent-notebook-plugin-${GOOD}.zip`;
    const zipSha = sha(readFileSync(join(w.ws, 'release-in', zipName)));
    const lines = notes.split('\n');
    expect(lines[0]).toBe(`Claude Code plugin: ${zipName} sha256 ${zipSha}`);
    for (const f of session) expect(lines).toContain(`- \`${f}\` sha256 ${sha(zips[GOOD].files.get(f)!)}`);
    expect(notes).toContain(`## [${GOOD}] - 2026-01-01\n\nFixture section for ${GOOD}.\n\n- an item`);
    expect(notes).not.toContain('Old section.');
    expect(notes).not.toContain('not yet');
    expect(notes).not.toContain('TAMPERED');
    expect(notes).not.toContain('deadbeef');

    // The create call is handed the file the job built, not the artifact's.
    const c = w.run(createStep);
    expect(c.code, c.out).toBe(0);
    const call = writeCalls(w)[0];
    expect(call[call.indexOf('--notes-file') + 1]).toBe('../notes.md');
    expect(readFileSync(join(w.ws, 'release-in', '../notes.md'), 'utf-8')).toBe(notes);
  });

  test('the session-start hashes are those of the zip the job holds, not the build job\'s claim', () => {
    const w = world(GOOD, { zip: (f) => f.set('hooks/hooks.json', Buffer.from('{"hooks":{}}\n')) });
    expect(w.run(notesStep).code).toBe(0);
    expect(readFileSync(join(w.ws, 'notes.md'), 'utf-8')).toContain(`\`hooks/hooks.json\` sha256 ${sha(Buffer.from('{"hooks":{}}\n'))}`);
  });

  test('a prerelease and the plain `## <version>` heading both find their section', () => {
    const w = world(BETA);
    expect(w.run(notesStep).code).toBe(0);
    expect(readFileSync(join(w.ws, 'notes.md'), 'utf-8')).toContain(`Fixture section for ${BETA}.`);
    const plain = world(GOOD, { src: (d) => writeFileSync(join(d, 'CHANGELOG.md'), `# Changelog\n\n## ${GOOD}\n\nPlain heading body.\n\n## 0.0.1\n\nold\n`) });
    expect(plain.run(notesStep).code).toBe(0);
    const notes = readFileSync(join(plain.ws, 'notes.md'), 'utf-8');
    expect(notes).toContain('Plain heading body.');
    expect(notes).not.toContain('old\n');
  });

  test('a CHANGELOG at the tagged commit with no section for the version is refused and no notes are written', () => {
    const w = world(GOOD, { src: (d) => writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- x\n\n## [9.9.9] - 2026-01-01\n\nother\n') });
    const r = w.run(notesStep);
    expect(r.out).toContain(`::error::CHANGELOG.md at ${COMMIT} has no section for version ${GOOD}`);
    expect(r.code).toBe(1);
    expect(existsSync(join(w.ws, 'notes.md'))).toBe(false);
  });

  test('the CHANGELOG is read through the API at the run commit', () => {
    const w = world(GOOD);
    w.run(notesStep);
    expect(w.log().some((c) => c[0] === 'gh' && c[1] === 'api' && c[2] === `repos/o/r/contents/CHANGELOG.md?ref=${COMMIT}`)).toBe(true);
  });
});

describe('the publish job skips a version that npm already holds (NFR-REL-001, issue #559)', onLinux, () => {
  const step = runOf(stepsOf(jobBlock('publish')).find((s) => s.includes('name: Check whether npm already has this version'))!);
  function run(npmScript: string): { code: number | null; out: string; output: string } {
    const d = join(tmp, `pub${n++}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }));
    writeFileSync(join(d, 'npm'), npmScript, { mode: 0o755 });
    writeFileSync(join(d, 'out.txt'), '');
    const r = spawnSync('bash', ['-c', step], { cwd: d, encoding: 'utf-8', env: { ...process.env, PATH: `${d}${delimiter}${process.env.PATH ?? ''}`, GITHUB_OUTPUT: join(d, 'out.txt') } });
    return { code: r.status, out: String(r.stdout) + String(r.stderr), output: readFileSync(join(d, 'out.txt'), 'utf-8') };
  }

  test('a version that `npm view` prints is skipped with a notice', () => {
    const r = run('#!/bin/sh\n[ "$*" = "view agent-notebook@1.2.3 version" ] && echo 1.2.3 || exit 1\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('::notice::agent-notebook@1.2.3 is already on npm; skipping the publish.');
    expect(r.output).toBe('published=true\n');
  });

  test('a version npm does not know (E404, exit 1) is published', () => {
    const r = run('#!/bin/sh\necho "npm error code E404" >&2\nexit 1\n');
    expect(r.code).toBe(0);
    expect(r.output).toBe('published=false\n');
  });

  test('the publish step runs only when that check found nothing', () => {
    const publish = stepsOf(jobBlock('publish')).find((s) => s.includes('name: Publish to npm'))!;
    expect(publish).toMatch(/^ {8}if: steps\.npm-has\.outputs\.published != 'true'$/m);
  });
});
