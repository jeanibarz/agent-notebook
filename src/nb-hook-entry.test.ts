import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Issue #559: the Claude Code plugin's hooks start from nb-hook-entry.cjs, an old-syntax
// file that a Node.js too old for the adapter can still parse. It says "too old" once, at
// session start, and otherwise hands over to nb-claude-hook.mjs unchanged.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const HOOKS = join(root, 'examples', 'hooks', 'claude-code');
const ENTRY = join(HOOKS, 'nb-hook-entry.cjs');
const ADAPTER = join(HOOKS, 'nb-claude-hook.mjs');
const SOURCE = readFileSync(ENTRY, 'utf-8');
const NOTICE = /^var NOTICE = '([^']*)';$/m.exec(SOURCE)![1]!;
// Making a directory symlink needs a privilege Windows runners may not grant.
const testLink = process.platform === 'win32' ? test.skip : test;
const BROKEN = "agent-notebook: the notebook's hook could not start. Tell the user: reinstall the agent-notebook plugin.";

let tmp: string; // contains a space on purpose
let store: string;
let globalCfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb entry ')));
  store = join(tmp, 'store');
  mkdirSync(store);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
  writeFileSync(join(store, 'build.md'), '# desc: building the app\n- [+1] build lesson 0\n');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('CLAUDE_')) delete env[k];
  const out: NodeJS.ProcessEnv = { ...env, HOME: join(tmp, 'home'), USERPROFILE: join(tmp, 'home'), GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, NB_DIR: store };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** Run a hook file with node; `oldNode` makes it see that Node.js version through a preload. */
function run(file: string, args: string[], opts: { env?: Record<string, string | undefined>; oldNode?: string; payload?: unknown; cwd?: string } = {}): Run {
  const pre: string[] = [];
  if (opts.oldNode) {
    const preload = join(tmp, 'old-node.cjs');
    writeFileSync(preload, `Object.defineProperty(process, 'versions', { value: Object.assign({}, process.versions, { node: ${JSON.stringify(opts.oldNode)} }) });\n`);
    pre.push('--require', preload);
  }
  const r = spawnSync(process.execPath, [...pre, file, ...args], {
    cwd: opts.cwd ?? tmp,
    env: childEnv(opts.env),
    input: JSON.stringify(opts.payload ?? {}),
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { code: r.status, out: String(r.stdout), err: String(r.stderr) };
}

/** A program that stands in for nb and says it ran. */
function fakeNb(dir: string, word: string): string {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'fake-nb.mjs');
  writeFileSync(f, `process.stdout.write(${JSON.stringify(word)} + '\\n');\n`);
  return f;
}

describe('the entry hands over to the adapter on a Node.js new enough (FR-HOOKS-002, issue #559)', () => {
  for (const event of ['session-start', 'subagent-start', 'stop']) {
    test(`${event}: the same output, byte for byte, as the adapter run directly`, () => {
      const payload = { session_id: `s-${event}` };
      const direct = run(ADAPTER, [event], { payload });
      rmSync(join(store, `.retro-s-${event}`), { force: true });
      for (const f of readdirSync(store)) if (f.startsWith('.retro-')) rmSync(join(store, f));
      const via = run(ENTRY, [event], { payload });
      expect(via.code).toBe(0);
      expect(direct.out.length).toBeGreaterThan(0);
      expect(via.out).toBe(direct.out);
    });
  }

  test('adapter arguments after the event reach the adapter (--max-chars)', () => {
    for (let i = 0; i < 40; i++) writeFileSync(join(store, `shelf-${i}.md`), `- [+1] lesson ${i}\n`);
    const direct = run(ADAPTER, ['session-start', '--max-chars', '1200']);
    const via = run(ENTRY, ['session-start', '--max-chars', '1200']);
    expect(via.out).toBe(direct.out);
    expect(via.out.length).toBeLessThanOrEqual(1200);
  });

  test('the version check lets the exact minimum through', () => {
    const r = run(ENTRY, ['session-start'], { oldNode: '18.0.0' });
    expect(r.out).toContain('build');
    expect(r.out).not.toContain(NOTICE);
  });
});

describe('the entry on a Node.js older than 18 (FR-HOOKS-002, issue #559)', () => {
  for (const v of ['10.24.1', '12.22.12', '16.20.2', '17.9.1']) {
    test(`Node ${v}: session-start prints the notice and nothing else, exit 0`, () => {
      const r = run(ENTRY, ['session-start'], { oldNode: v });
      expect(r.code).toBe(0);
      expect(r.out).toBe(NOTICE + '\n');
      expect(r.err).toContain(`Node.js ${v} is older than 18`);
    });
  }

  test('subagent-start and stop print nothing, write no sentinel, exit 0', () => {
    for (const event of ['subagent-start', 'stop', 'print-settings', 'bogus']) {
      const r = run(ENTRY, [event], { oldNode: '16.20.2', payload: { session_id: 'x' } });
      expect(r.code, event).toBe(0);
      expect(r.out, event).toBe('');
    }
    expect(readdirSync(store).filter((f) => f.startsWith('.retro-'))).toEqual([]);
  });

  test('NB_ENABLED off keeps the notice quiet, like the adapter diagnostic', () => {
    for (const v of ['0', 'false', 'OFF', ' no ']) expect(run(ENTRY, ['session-start'], { oldNode: '16.20.2', env: { NB_ENABLED: v } }).out).toBe('');
    expect(run(ENTRY, ['session-start'], { oldNode: '16.20.2', env: { NB_ENABLED: '1' } }).out).toBe(NOTICE + '\n');
  });
});

describe('the entry when the adapter cannot load (issue #559)', () => {
  test('a start event prints one fixed line, stop prints nothing, the detail goes to stderr', () => {
    const lone = join(tmp, 'lone');
    mkdirSync(lone);
    copyFileSync(ENTRY, join(lone, 'nb-hook-entry.cjs'));
    const start = run(join(lone, 'nb-hook-entry.cjs'), ['session-start']);
    expect(start.code).toBe(0);
    expect(start.out).toBe(BROKEN + '\n');
    expect(start.err).toContain('nb-claude-hook.mjs');
    const sub = run(join(lone, 'nb-hook-entry.cjs'), ['subagent-start']);
    expect(JSON.parse(sub.out)).toEqual({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: BROKEN } });
    const stop = run(join(lone, 'nb-hook-entry.cjs'), ['stop']);
    expect(stop.code).toBe(0);
    expect(stop.out).toBe('');
    expect(run(join(lone, 'nb-hook-entry.cjs'), ['session-start'], { env: { NB_ENABLED: '0' } }).out).toBe('');
  });
});

describe('which nb the entry lets the adapter run (issue #559)', () => {
  test('--managed ignores NB_BIN, even an absolute one, and is not passed on', () => {
    const fake = fakeNb(join(tmp, 'fake'), 'FAKE-NB');
    expect(run(ENTRY, ['session-start'], { env: { NB_BIN: fake } }).out).toBe('FAKE-NB\n');
    const managed = run(ENTRY, ['session-start', '--managed'], { env: { NB_BIN: fake } });
    expect(managed.out).not.toContain('FAKE-NB');
    expect(managed.out).toContain('build');
    // The flag can sit after the adapter's own arguments too.
    expect(run(ENTRY, ['session-start', '--max-chars', '9000', '--managed'], { env: { NB_BIN: fake } }).out).toContain('build');
  });

  test('the adapter gets the event and its arguments in order, without --managed', () => {
    const copy = join(tmp, 'copy');
    mkdirSync(copy);
    copyFileSync(ENTRY, join(copy, 'nb-hook-entry.cjs'));
    writeFileSync(join(copy, 'nb-claude-hook.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const argv = (args: string[]) => JSON.parse(run(join(copy, 'nb-hook-entry.cjs'), args).out);
    expect(argv(['session-start', '--max-chars', '9000'])).toEqual(['session-start', '--max-chars', '9000']);
    expect(argv(['session-start', '--managed', '--max-chars', '9000'])).toEqual(['session-start', '--max-chars', '9000']);
    expect(argv(['stop', '--max-chars', '9000', '--managed'])).toEqual(['stop', '--max-chars', '9000']);
    // Only the first --managed after the event is the entry's; a value equal to it is not looked at before the event.
    expect(argv(['--managed'])).toEqual(['--managed']);
  });

  testLink('a CLAUDE_PLUGIN_ROOT reached through a symlink still counts as the plugin', () => {
    const proj = join(tmp, 'project');
    fakeNb(join(proj, 'tools'), 'PROJECT-NB');
    const real = join(tmp, 'real-plugin');
    mkdirSync(join(real, 'examples', 'hooks', 'claude-code'), { recursive: true });
    copyFileSync(ENTRY, join(real, 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs'));
    writeFileSync(join(real, 'examples', 'hooks', 'claude-code', 'nb-claude-hook.mjs'), "process.stdout.write(String(process.env.NB_BIN));\n");
    const link = join(tmp, 'link');
    symlinkSync(real, link, 'dir');
    const entry = join(link, 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs');
    const rel = join('tools', 'fake-nb.mjs');
    for (const pluginRoot of [link, real]) {
      expect(run(entry, ['session-start'], { cwd: proj, env: { NB_BIN: rel, CLAUDE_PLUGIN_ROOT: pluginRoot } }).out, pluginRoot).toBe('undefined');
    }
    // A root that is set but does not exist fails closed: the relative NB_BIN is still ignored.
    expect(run(entry, ['session-start'], { cwd: proj, env: { NB_BIN: rel, CLAUDE_PLUGIN_ROOT: join(tmp, 'gone') } }).out).toBe('undefined');
    // Outside the plugin the value reaches the adapter untouched.
    expect(run(entry, ['session-start'], { cwd: proj, env: { NB_BIN: rel, CLAUDE_PLUGIN_ROOT: proj } }).out).toBe(rel);
  });

  test('inside an installed plugin, a relative NB_BIN is ignored and an absolute one is used', () => {
    const proj = join(tmp, 'project');
    fakeNb(join(proj, 'tools'), 'PROJECT-NB');
    const rel = join('tools', 'fake-nb.mjs');
    // Outside a plugin: the adapter's own rule (relative to the project folder) still applies.
    expect(run(ENTRY, ['session-start'], { cwd: proj, env: { NB_BIN: rel } }).out).toBe('PROJECT-NB\n');
    // From the plugin: ignored, so a cloned project's settings cannot pick the program.
    const plugin = run(ENTRY, ['session-start'], { cwd: proj, env: { NB_BIN: rel, CLAUDE_PLUGIN_ROOT: root } });
    expect(plugin.out).not.toContain('PROJECT-NB');
    expect(plugin.out).toContain('build');
    // An existing CLAUDE_PLUGIN_ROOT that does not contain the entry is not "the plugin".
    expect(run(ENTRY, ['session-start'], { cwd: proj, env: { NB_BIN: rel, CLAUDE_PLUGIN_ROOT: tmp } }).out).toBe('PROJECT-NB\n');
    const abs = fakeNb(join(tmp, 'abs'), 'ABSOLUTE-NB');
    expect(run(ENTRY, ['session-start'], { cwd: proj, env: { NB_BIN: abs, CLAUDE_PLUGIN_ROOT: root } }).out).toBe('ABSOLUTE-NB\n');
  });
});

describe('the entry stays readable by an old Node.js (issue #559)', () => {
  test('MIN_NODE equals the major of engines.node in package.json, and the notice names it', () => {
    const engines = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).engines.node as string;
    const min = Number(/^>=(\d+)$/.exec(engines)![1]);
    expect(Number(/^var MIN_NODE = (\d+);$/m.exec(SOURCE)![1])).toBe(min);
    expect(NOTICE).toContain(`Node.js ${min} or later`);
  });

  test('the notice is printable ASCII with no character a shell or PowerShell would treat specially', () => {
    expect(NOTICE).toMatch(/^[\x20-\x7e]+$/);
    expect(NOTICE).not.toMatch(/['"$`%&|^<>()!;\\]/);
    expect(NOTICE.startsWith('agent-notebook: ')).toBe(true);
  });

  test('no syntax newer than ES5 outside the one import() string', () => {
    const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
    for (const [what, re] of [
      ['an arrow function', /=>/],
      ['a template string', /`/],
      ['let or const', /\b(let|const)\s/],
      ['?. or ??', /\?\.|\?\?/],
      ['spread or rest', /\.\.\./],
      ['class', /\bclass\s/],
      ['async or await', /\b(async|await)\b/],
      ['import outside new Function', /\bimport\s*\(/],
    ] as const) {
      expect(re.test(code), what).toBe(false);
    }
    expect(SOURCE).toContain("new Function('u', 'return import(u)')");
    expect(SOURCE).not.toMatch(/process\.exit\(/);
  });

  test('it never writes beside itself', () => {
    const before = readdirSync(HOOKS).sort();
    run(ENTRY, ['session-start'], { oldNode: '12.22.12' });
    run(ENTRY, ['stop'], { payload: { session_id: 'w' } });
    expect(readdirSync(HOOKS).sort()).toEqual(before);
  });
});

describe('the entry under parallel stops (issue #559)', () => {
  test('20 stops of one session at once block exactly once [timing]', async () => {
    const one = (): Promise<string> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [ENTRY, 'stop'], { cwd: tmp, env: childEnv() });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('close', () => resolve(out));
        c.stdin.end(JSON.stringify({ session_id: 'race' }));
      });
    const outs = await Promise.all(Array.from({ length: 20 }, one));
    expect(outs.filter((o) => o.includes('"decision":"block"')).length).toBe(1);
    expect(outs.filter((o) => o !== '' && !o.includes('"decision":"block"'))).toEqual([]);
  }, 60_000);
});
