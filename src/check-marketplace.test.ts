import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Issue #559: scripts/check-marketplace.mjs checks the marketplace file that a person is about to
// merge. Each rule gets a case that breaks only that rule and asserts the message the script prints
// (not only the exit code): a crash (exit 2) is never counted as a refusal. A local HTTP server
// stands in for the GitHub API and for the release download; the script takes its addresses
// as arguments, so no network is reached.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'check-marketplace.mjs');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const REL = 'https://github.com/jeanibarz/agent-notebook/releases/download';

/** A STORE zip from a Map (the script reads names and bytes only, so CRC and dates stay 0). */
function zipOf(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
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
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const pluginZip = (v: string, over: { plugin?: string; pkg?: string } = {}): Buffer =>
  zipOf({
    '.claude-plugin/plugin.json': over.plugin ?? JSON.stringify({ name: 'agent-notebook', version: v }),
    'package.json': over.pkg ?? JSON.stringify({ name: 'agent-notebook', version: v }),
    'dist/cli.js': `// ${v}\n`,
  });

interface Release {
  draft?: boolean;
  prerelease?: boolean;
  status?: number;
}
const market = (v: string, zip: Buffer, over: Record<string, unknown> = {}, source: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      name: 'agent-notebook',
      owner: { name: 'jeanibarz' },
      description: 'Plain-text memory for your AI assistant.',
      plugins: [{ name: 'agent-notebook', description: 'd', source: { source: 'archive', url: `${REL}/v${v}/agent-notebook-plugin-${v}.zip`, sha256: sha(zip), ...source } }],
      ...over,
    },
    null,
    2,
  );

let server: Server;
let base = '';
let dir = '';
// what the server answers: release metadata and zip bytes, by version; set by each case
const releases = new Map<string, Release>();
const zips = new Map<string, Buffer>();
const hits: string[] = [];
let n = 0;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nb-check-mkt-')));
  server = createServer((req, res) => {
    const url = req.url ?? '';
    hits.push(`${req.method} ${url} ${req.headers.authorization === undefined ? 'no-auth' : 'AUTH'}`);
    let m = /^\/repos\/jeanibarz\/agent-notebook\/releases\/tags\/v(.+)$/.exec(url);
    if (m) {
      const r = releases.get(m[1]);
      if (!r) return void ((res.statusCode = 404), res.end('{}'));
      res.statusCode = r.status ?? 200;
      return void res.end(JSON.stringify({ draft: r.draft ?? false, prerelease: r.prerelease ?? m[1].includes('-') }));
    }
    m = /^\/jeanibarz\/agent-notebook\/releases\/download\/v(.+)\/agent-notebook-plugin-.+\.zip$/.exec(url);
    if (m) {
      // the real download answers a redirect to another host: follow it here too
      res.statusCode = 302;
      res.setHeader('location', `/cdn/${m[1]}.zip`);
      return void res.end();
    }
    m = /^\/cdn\/(.+)\.zip$/.exec(url);
    const z = m && zips.get(m[1]);
    if (!z) return void ((res.statusCode = 404), res.end('no'));
    res.end(z);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Out {
  code: number | null;
  out: string;
  err: string;
  work: string;
  stage: string;
}
/** Runs the real script on a marketplace text (and optionally main's text and a pull request body). */
function run(marketText: string, opts: { main?: string; body?: string; args?: string[]; noEvent?: boolean } = {}): Promise<Out> {
  const d = join(dir, `case-${n++}`);
  mkdirSync(d);
  const file = join(d, 'marketplace.json');
  writeFileSync(file, marketText);
  const args = [script, '--file', file, '--api', base, '--download-base', base, '--work', join(d, 'work'), '--stage', join(d, 'stage')];
  if (opts.main !== undefined) {
    writeFileSync(join(d, 'main.json'), opts.main);
    args.push('--main-file', join(d, 'main.json'));
  }
  if (!opts.noEvent) {
    writeFileSync(join(d, 'event.json'), JSON.stringify({ pull_request: { body: opts.body ?? '' } }));
    args.push('--event', join(d, 'event.json'));
  }
  args.push(...(opts.args ?? []));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err, work: join(d, 'work'), stage: join(d, 'stage') }));
  });
}
/** A published release v<v> whose zip is `zip`. */
function publish(v: string, zip: Buffer, release: Release = {}): void {
  releases.set(v, release);
  zips.set(v, zip);
}
const refused = (r: Out, text: string | RegExp): void => {
  expect(r.err).toBe('');
  expect(r.code).toBe(1);
  expect(r.out).toMatch(text instanceof RegExp ? text : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
};

describe('the marketplace check accepts a good entry (FR-PLUGIN-006, issue #559)', () => {
  test('a published, matching beta release passes, and leaves what the end-to-end run needs', async () => {
    const z = pluginZip('0.13.0-beta.2');
    publish('0.13.0-beta.2', z);
    const r = await run(market('0.13.0-beta.2', z));
    expect(r.err).toBe('');
    expect(r.out).toContain(`check-marketplace: ok (0.13.0-beta.2, sha256 ${sha(z)}, main names no version)`);
    expect(r.code).toBe(0);
    // the zip was downloaded through the redirect, into the empty work folder, byte for byte
    expect(readFileSync(join(r.work, 'agent-notebook-plugin-0.13.0-beta.2.zip'))).toEqual(z);
    // staged for the end-to-end run: the unpacked tree and the three marketplace files
    expect(readFileSync(join(r.stage, 'agent-notebook-plugin-0.13.0-beta.2', 'dist', 'cli.js'), 'utf-8')).toBe('// 0.13.0-beta.2\n');
    const v2 = readFileSync(join(r.stage, 'v2.json'), 'utf-8');
    expect(readFileSync(join(r.stage, 'v1.json'), 'utf-8')).toBe(v2); // main names nothing: install and update are the same
    expect(JSON.parse(readFileSync(join(r.stage, 'bad.json'), 'utf-8')).plugins[0].source.sha256).toBe('0'.repeat(64));
    expect(readFileSync(join(r.stage, 'versions.txt'), 'utf-8')).toBe('0.13.0-beta.2\n0.13.0-beta.2\n');
  });

  test('a stable release passes, and no request carries a credential', async () => {
    const z = pluginZip('1.2.3');
    publish('1.2.3', z);
    hits.length = 0;
    const r = await run(market('1.2.3', z));
    expect(r.code).toBe(0);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.every((h) => h.endsWith('no-auth'))).toBe(true);
  });

  test('with a main file it stages both versions, main as v1 and the change as v2', async () => {
    const zw = pluginZip('0.13.0-beta.2');
    const zv = pluginZip('0.13.0-beta.3');
    publish('0.13.0-beta.2', zw);
    publish('0.13.0-beta.3', zv);
    const mainText = market('0.13.0-beta.2', zw);
    const r = await run(market('0.13.0-beta.3', zv), { main: mainText });
    expect(r.out).toContain('main names 0.13.0-beta.2');
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.stage, 'v1.json'), 'utf-8')).toBe(mainText);
    expect(existsSync(join(r.stage, 'agent-notebook-plugin-0.13.0-beta.2', 'package.json'))).toBe(true);
    expect(existsSync(join(r.stage, 'agent-notebook-plugin-0.13.0-beta.3', 'package.json'))).toBe(true);
    expect(readFileSync(join(r.stage, 'versions.txt'), 'utf-8')).toBe('0.13.0-beta.2\n0.13.0-beta.3\n');
  });
});

describe('the marketplace check refuses a file of the wrong shape (FR-PLUGIN-006, issue #559)', () => {
  const z = pluginZip('2.0.0');
  beforeAll(() => publish('2.0.0', z));
  const good = JSON.parse(market('2.0.0', z));
  const withPlugin = (change: (p: Record<string, any>) => void): string => {
    const j = structuredClone(good);
    change(j.plugins[0]);
    return JSON.stringify(j);
  };

  test('a file that is not JSON', async () => refused(await run('{ not json'), 'is not valid JSON'));
  test('a name other than agent-notebook', async () => refused(await run(market('2.0.0', z, { name: 'other' })), 'name is "other" but "agent-notebook" was expected'));
  test('no description', async () => refused(await run(market('2.0.0', z, { description: undefined })), 'it has no description'));
  test('a blank description', async () => refused(await run(market('2.0.0', z, { description: '  ' })), 'it has no description'));
  test('two plugins', async () => {
    const j = structuredClone(good);
    j.plugins.push(structuredClone(j.plugins[0]));
    refused(await run(JSON.stringify(j)), 'it must hold exactly one plugin, and it holds 2');
  });
  test('no plugin', async () => refused(await run(market('2.0.0', z, { plugins: [] })), 'it must hold exactly one plugin, and it holds 0'));
  test('a plugin with another name', async () => refused(await run(withPlugin((p) => (p.name = 'evil'))), 'the plugin is named "evil"'));
  test('a source that is not an archive', async () => refused(await run(withPlugin((p) => (p.source = { source: 'github', repo: 'jeanibarz/agent-notebook' }))), "source.source is \"github\" but \"archive\" was expected"));
  test.each([
    ['http instead of https', `http://github.com/jeanibarz/agent-notebook/releases/download/v2.0.0/agent-notebook-plugin-2.0.0.zip`],
    ['another repository', `https://github.com/evil/agent-notebook/releases/download/v2.0.0/agent-notebook-plugin-2.0.0.zip`],
    ['another host', `https://example.com/jeanibarz/agent-notebook/releases/download/v2.0.0/agent-notebook-plugin-2.0.0.zip`],
    ['a file name with another version', `${REL}/v2.0.0/agent-notebook-plugin-2.0.1.zip`],
    ['another file name', `${REL}/v2.0.0/evil.zip`],
    ['a query string', `${REL}/v2.0.0/agent-notebook-plugin-2.0.0.zip?x=1`],
    ['a version with no v', `${REL}/2.0.0/agent-notebook-plugin-2.0.0.zip`],
    ['a path inside the tag', `${REL}/v2.0.0/../v1.0.0/agent-notebook-plugin-2.0.0.zip`],
    ['a prerelease shape the release job refuses', `${REL}/v2.0.0-Beta/agent-notebook-plugin-2.0.0-Beta.zip`],
  ])('an archive url with %s', async (_what, url) => refused(await run(market('2.0.0', z, {}, { url })), 'is not https://github.com/jeanibarz/agent-notebook/releases/download/v<V>/agent-notebook-plugin-<V>.zip'));
  test.each([
    ['upper-case hex', sha(z).toUpperCase()],
    ['too short', sha(z).slice(0, 63)],
    ['too long', sha(z) + '0'],
    ['not hex', 'g'.repeat(64)],
  ])('a sha256 that is %s', async (_what, s) => refused(await run(market('2.0.0', z, {}, { sha256: s })), 'is not 64 lowercase hex digits'));
  test('it reports each miss, not only the first', async () => {
    const r = await run(market('2.0.0', z, { name: 'other', description: '' }));
    expect(r.out.match(/::error::/g)).toHaveLength(2);
  });
});

describe('the marketplace check looks the release up (FR-PLUGIN-006, issue #559)', () => {
  test('a release that does not exist', async () => {
    const z = pluginZip('3.0.0');
    zips.set('3.0.0', z);
    releases.delete('3.0.0');
    refused(await run(market('3.0.0', z)), 'release v3.0.0 does not exist');
  });
  test('a draft release', async () => {
    const z = pluginZip('3.0.1');
    publish('3.0.1', z, { draft: true });
    refused(await run(market('3.0.1', z)), 'release v3.0.1 is a draft');
  });
  test('a release that is a prerelease although the version has no "-"', async () => {
    const z = pluginZip('3.0.2');
    publish('3.0.2', z, { prerelease: true });
    refused(await run(market('3.0.2', z)), 'release v3.0.2 has prerelease=true but version 3.0.2 has no "-"');
  });
  test('a release that is not a prerelease although the version has a "-"', async () => {
    const z = pluginZip('3.0.3-beta.1');
    publish('3.0.3-beta.1', z, { prerelease: false });
    refused(await run(market('3.0.3-beta.1', z)), 'release v3.0.3-beta.1 has prerelease=false but version 3.0.3-beta.1 has "-"');
  });
  test('an API failure is a crash (exit 2), never a refusal', async () => {
    const z = pluginZip('3.0.4');
    publish('3.0.4', z, { status: 500 });
    const r = await run(market('3.0.4', z));
    expect(r.code).toBe(2);
    expect(r.err).toContain('HTTP 500');
  });
});

describe('the marketplace check looks at the zip (FR-PLUGIN-006, issue #559)', () => {
  test('a zip that is missing from the release', async () => {
    const z = pluginZip('4.0.0');
    releases.set('4.0.0', {});
    zips.delete('4.0.0');
    refused(await run(market('4.0.0', z)), 'does not exist (HTTP 404)');
  });
  test('a zip whose sha256 is not the entry\'s', async () => {
    const z = pluginZip('4.0.1');
    publish('4.0.1', pluginZip('4.0.1', { pkg: JSON.stringify({ version: '4.0.1', changed: true }) }));
    const r = await run(market('4.0.1', z));
    refused(r, `the zip's sha256 is ${sha(zips.get('4.0.1')!)} but the marketplace file says ${sha(z)}`);
    expect(existsSync(join(r.stage, 'v2.json'))).toBe(false);
  });
  test("a zip whose plugin.json says another version", async () => {
    const z = pluginZip('4.0.2', { plugin: JSON.stringify({ version: '4.0.3' }) });
    publish('4.0.2', z);
    refused(await run(market('4.0.2', z)), `the zip's .claude-plugin/plugin.json says version "4.0.3" but "4.0.2" was expected`);
  });
  test("a zip whose package.json says another version", async () => {
    const z = pluginZip('4.0.4', { pkg: JSON.stringify({ version: '4.0.5' }) });
    publish('4.0.4', z);
    refused(await run(market('4.0.4', z)), `the zip's package.json says version "4.0.5" but "4.0.4" was expected`);
  });
  test('a zip with no plugin.json', async () => {
    const z = zipOf({ 'package.json': JSON.stringify({ version: '4.0.6' }) });
    publish('4.0.6', z);
    refused(await run(market('4.0.6', z)), 'the zip has no .claude-plugin/plugin.json');
  });
  test('bytes that are not a zip', async () => {
    const z = Buffer.from('not a zip at all, but long enough to look at');
    publish('4.0.7', z);
    refused(await run(market('4.0.7', z)), 'the zip cannot be read');
  });
  test('a zip larger than 20 MB is refused, not downloaded in full', async () => {
    const z = zipOf({ 'big.bin': Buffer.alloc(21 * 1024 * 1024, 1), '.claude-plugin/plugin.json': '{}', 'package.json': '{}' });
    publish('4.0.8', z);
    refused(await run(market('4.0.8', z)), 'is larger than 20 MB');
  });
});

describe('the marketplace check compares with what main names (FR-PLUGIN-006, issue #559)', () => {
  const setup = (v: string, w: string): { z: Buffer; mainText: string } => {
    const zw = pluginZip(w);
    const zv = pluginZip(v);
    publish(w, zw);
    publish(v, zv);
    return { z: zv, mainText: market(w, zw) };
  };
  test('the same version again', async () => {
    const { z, mainText } = setup('5.0.0', '5.0.0');
    refused(await run(market('5.0.0', z), { main: mainText }), 'version 5.0.0 is the one main already names');
  });
  test('a lower version with no Rollback line', async () => {
    const { z, mainText } = setup('5.0.1', '5.0.2');
    refused(await run(market('5.0.1', z), { main: mainText, body: 'Points the entry back.' }), 'version 5.0.1 is lower than 5.0.2, which main names: a rollback needs a line "Rollback: <why>"');
  });
  test('a lower version with no event file at all', async () => {
    const { z, mainText } = setup('5.0.3', '5.0.4');
    refused(await run(market('5.0.3', z), { main: mainText, noEvent: true }), 'a rollback needs a line "Rollback:');
  });
  test('a lower version with a Rollback line passes', async () => {
    const { z, mainText } = setup('5.0.5', '5.0.6');
    const r = await run(market('5.0.5', z), { main: mainText, body: 'Why.\n\nRollback: 5.0.6 crashes at start.\nMore.' });
    expect(r.out).toContain('main names 5.0.6');
    expect(r.code).toBe(0);
  });
  test('a Rollback mention in the middle of a sentence is not the line', async () => {
    const { z, mainText } = setup('5.0.7', '5.0.8');
    refused(await run(market('5.0.7', z), { main: mainText, body: 'This is not a Rollback: it is fine.' }), 'a rollback needs a line');
  });
  test('an empty Rollback line is not a reason', async () => {
    const { z, mainText } = setup('5.1.0', '5.1.1');
    refused(await run(market('5.1.0', z), { main: mainText, body: 'Rollback:   \n' }), 'a rollback needs a line');
  });
  test('a higher version needs no Rollback line', async () => {
    const { z, mainText } = setup('5.2.1', '5.2.0');
    expect((await run(market('5.2.1', z), { main: mainText })).code).toBe(0);
  });
  test.each([
    ['0.13.0-beta.9', '0.13.0-beta.10', true], // the numbers of a prerelease are compared as numbers
    ['0.13.0-beta.10', '0.13.0-beta.9', false],
    ['0.13.0-beta.2', '0.13.0', true], // a prerelease is lower than its release
    ['0.13.0', '0.13.0-beta.2', false],
    ['0.12.9', '0.13.0-beta.1', true],
    ['0.13.0-alpha.1', '0.13.0-beta.1', true],
  ])('%s against main %s: a rollback is %s', async (v, w, lower) => {
    const { z, mainText } = setup(v, w);
    const r = await run(market(v, z), { main: mainText });
    if (lower) refused(r, 'a rollback needs a line');
    else expect(r.code).toBe(0);
  });
  test('a main file that cannot be read is an error, not a pass', async () => {
    const z = pluginZip('5.3.0');
    publish('5.3.0', z);
    refused(await run(market('5.3.0', z), { main: '{ nope' }), 'main marketplace.json is not valid JSON');
  });
});

describe('the marketplace check refuses a wrong call (FR-PLUGIN-006, issue #559)', () => {
  test('an unknown argument and a work folder that is not empty exit 2', async () => {
    const z = pluginZip('6.0.0');
    publish('6.0.0', z);
    const a = await run(market('6.0.0', z), { args: ['--nope', 'x'] });
    expect(a.code).toBe(2);
    expect(a.err).toContain('bad argument "--nope"');
    const d = join(dir, 'busy');
    mkdirSync(d);
    writeFileSync(join(d, 'old'), 'x');
    const b = await run(market('6.0.0', z), { args: ['--work', d] });
    expect(b.code).toBe(2);
    expect(b.err).toContain('is not empty');
  });
});
