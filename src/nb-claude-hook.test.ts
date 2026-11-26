import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { BRIEF_EMPTY_LINE, BRIEF_HEADER_LINES, BRIEF_OFF_LINE, FRAMING_LINE, RETRO_LESSONS_LINES } from './agent-text.js';

// Issue #538 (FR-HOOKS-001): the Claude Code example hooks are one Node adapter,
// `nb-claude-hook.mjs`, behind the three 0.12 script names. These tests run the
// new hooks and the frozen 0.12 scripts (test/fixtures/hooks-0.12) against the
// same store and the same built `nb`, and compare what the model receives.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = join(root, 'dist', 'cli.js');
const HOOKS = join(root, 'examples', 'hooks', 'claude-code');
const ADAPTER = join(HOOKS, 'nb-claude-hook.mjs');
const OLD = join(root, 'test', 'fixtures', 'hooks-0.12');
const isWin = process.platform === 'win32';
// The 0.12 scripts and the trampolines need a POSIX shell.
const testSh = isWin ? test.skip : test;

let tmp: string; // contains a space on purpose
let store: string;
let globalCfg: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb hook ')));
  store = join(tmp, 'store');
  mkdirSync(store);
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_')) delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  return { ...env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, NB_DIR: store, ...extra };
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

const done = (r: ReturnType<typeof spawnSync>): Run => ({ code: r.status, out: String(r.stdout), err: String(r.stderr) });

/** The adapter itself, run by node (as print-settings registers it). */
function adapter(event: string, payload: unknown = {}, env: Record<string, string> = {}, cwd = tmp): Run {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return done(spawnSync(process.execPath, [ADAPTER, event], { cwd, env: childEnv(env), input, encoding: 'utf-8', timeout: 20_000 }));
}

/** A hook script by its 0.12 name: the new trampoline, or the frozen 0.12 script. */
function script(dir: string, name: string, payload: unknown = {}, env: Record<string, string> = {}, shell = 'bash'): Run {
  return done(spawnSync(shell, [join(dir, name)], { cwd: tmp, env: childEnv(env), input: JSON.stringify(payload), encoding: 'utf-8', timeout: 20_000 }));
}

/** An `nb` on disk that runs the built CLI, for the 0.12 scripts' NB_BIN. */
function nbBin(): string {
  const bin = join(tmp, 'nb-bin.sh');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return bin;
}

function shelf(name: string, lessons: number, desc?: string): void {
  const body = Array.from({ length: lessons }, (_, i) => `- [+1] ${name} lesson ${i}`).join('\n');
  writeFileSync(join(store, `${name}.md`), (desc ? `# desc: ${desc}\n` : '') + body + '\n');
}

/** The 0.12 text with the one line `nb brief` adds, after the instruction lines. */
function withFraming(old: string): string {
  const lines = old.split('\n');
  lines.splice(8, 0, FRAMING_LINE);
  return lines.join('\n');
}

const sentinels = () => readdirSync(store).filter((n) => n.startsWith('.retro-')).sort();

describe('the hooks send what the 0.12 scripts sent (FR-HOOKS-001, acceptance criterion 1)', () => {
  const stores: Array<[string, () => void, Record<string, string>]> = [
    ['an empty store', () => {}, {}],
    ['a flat index', () => (shelf('build', 3, 'building the app'), shelf('review', 1)), {}],
    ['a layered index', () => (shelf('build@acme', 2), shelf('review', 1), shelf('global', 1), shelf('x@other', 1)), { NB_PROJECT_SLUG: 'acme' }],
  ];

  for (const [name, seed, env] of stores) {
    testSh(`session start, ${name}: the 0.12 text plus the framing line`, () => {
      seed();
      const old = script(OLD, 'nb-session-start.sh', {}, { NB_BIN: nbBin(), ...env });
      const now = script(HOOKS, 'nb-session-start.sh', {}, env);
      expect(now.code).toBe(0);
      expect(now.out).toBe(withFraming(old.out));
    });

    testSh(`subagent start, ${name}: the same text, wrapped for a subagent`, () => {
      seed();
      const old = JSON.parse(script(OLD, 'nb-subagent-start.sh', {}, { NB_BIN: nbBin(), ...env }).out);
      const now = JSON.parse(script(HOOKS, 'nb-subagent-start.sh', {}, env).out);
      expect(now.hookSpecificOutput.hookEventName).toBe('SubagentStart');
      expect(now.hookSpecificOutput.additionalContext).toBe(withFraming(old.hookSpecificOutput.additionalContext));
    });
  }

  testSh('stop: the same block, byte for byte, with and without the extra prompt', () => {
    const extra = join(tmp, 'extra.txt');
    writeFileSync(extra, 'ideas for {project} in {session}');
    for (const [i, env] of ([{}, { NB_RETRO_EXTRA_PROMPT: extra, NB_PROJECT_SLUG: 'acme' }] as Record<string, string>[]).entries()) {
      const old = script(OLD, 'nb-retrospective.sh', { session_id: `old-${i}` }, { NB_BIN: nbBin(), ...env });
      const now = script(HOOKS, 'nb-retrospective.sh', { session_id: `new-${i}` }, env);
      expect(now.code).toBe(0);
      expect(JSON.parse(now.out)).toEqual(JSON.parse(old.out.replaceAll(`old-${i}`, `new-${i}`)));
      expect(now.out).toBe(old.out.replaceAll(`old-${i}`, `new-${i}`));
    }
  });

  testSh('an old copied Stop script and the new hook nudge once between them, in either order', () => {
    const env = { NB_BIN: nbBin() };
    expect(JSON.parse(script(OLD, 'nb-retrospective.sh', { session_id: 'a' }, env).out).decision).toBe('block');
    expect(script(HOOKS, 'nb-retrospective.sh', { session_id: 'a' }).out).toBe('');
    expect(JSON.parse(script(HOOKS, 'nb-retrospective.sh', { session_id: 'b' }).out).decision).toBe('block');
    expect(script(OLD, 'nb-retrospective.sh', { session_id: 'b' }, env).out).toBe('');
  });

  testSh('ten old scripts and ten new hooks racing on one session give exactly one block', async () => {
    const env = childEnv({ NB_BIN: nbBin() });
    const runs = [...Array.from({ length: 10 }, () => join(OLD, 'nb-retrospective.sh')), ...Array.from({ length: 10 }, () => join(HOOKS, 'nb-retrospective.sh'))];
    const children = runs.map((f) => spawn('bash', [f], { cwd: tmp, env }));
    const outs = children.map(
      (c) =>
        new Promise<{ out: string; code: number | null }>((resolve, reject) => {
          let out = '';
          c.stdout.on('data', (d) => (out += d));
          c.on('error', reject);
          c.on('close', (code) => resolve({ out, code }));
        }),
    );
    for (const c of children) c.stdin.end(JSON.stringify({ session_id: 'race' }));
    const results = await Promise.all(outs);
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(results.filter((r) => r.out.includes('"block"'))).toHaveLength(1);
    expect(sentinels()).toEqual(['.retro-race']);
  }, 60_000);
});

describe('the adapter (FR-HOOKS-001)', () => {
  test('the three events, run by node with no shell', () => {
    shelf('build', 1);
    expect(adapter('session-start').out).toContain('## Your agent-notebook index');
    expect(JSON.parse(adapter('subagent-start').out).hookSpecificOutput.additionalContext).toContain('  build  1  ');
    expect(JSON.parse(adapter('stop', { session_id: 's' }).out).decision).toBe('block');
    expect(adapter('stop', { session_id: 's' }).out).toBe('');
  });

  test('the stops that never nudge leave the session unclaimed', () => {
    for (const p of [
      { session_id: 'n', stop_hook_active: true },
      { session_id: 'n', hook_event_name: 'SubagentStop' },
      { session_id: 'n', agent_id: 'sub-1' },
      { session_id: 'n', background_tasks: [{ type: 'subagent', status: 'running' }] },
    ]) {
      expect(adapter('stop', p).out, JSON.stringify(p)).toBe('');
    }
    expect(sentinels()).toEqual([]);
    expect(JSON.parse(adapter('stop', { session_id: 'n' }).out).decision).toBe('block');
  });

  test('invalid or empty JSON on stdin is treated as an empty payload, never an error', () => {
    shelf('build', 1);
    for (const input of ['{not json', '', 'null', '[1,2]']) {
      const start = adapter('session-start', input);
      expect(start.code, input).toBe(0);
      expect(start.out).toContain('  build  1  ');
      expect(adapter('stop', input).code).toBe(0);
    }
  });

  test('hostile session ids become one safe argument and one sentinel inside the store', () => {
    for (const id of ['--json', '--', '-x', '../escape', '$(id)', '`id`', "a'b", 'c\nd', 'CON', 'é'.repeat(3), 'x'.repeat(10_000)]) {
      const r = adapter('stop', { session_id: id });
      expect(r.code, id.slice(0, 20)).toBe(0);
      expect(JSON.parse(r.out).decision).toBe('block');
    }
    expect(sentinels().every((n) => /^\.retro-[A-Za-z0-9._-]{1,128}$/.test(n))).toBe(true);
    expect(existsSync(join(tmp, 'escape'))).toBe(false);
  });

  test('a missing, failing or too old nb: one line naming the fix at start, nothing at stop, never exit 2', () => {
    const old = join(tmp, 'old-nb.mjs');
    writeFileSync(old, 'process.exit(2);\n');
    const failing = join(tmp, 'failing-nb.mjs');
    writeFileSync(failing, 'process.exit(7);\n');
    for (const [bin, why] of [
      [join(tmp, 'missing-nb'), /nb could not run \(ENOENT\)/],
      [old, /this nb is older than the hooks \(it has no "brief" command\)/],
      [failing, /nb exited 7/],
    ] as const) {
      const start = adapter('session-start', {}, { NB_BIN: bin });
      expect(start.code).toBe(0);
      expect(start.out).toMatch(why);
      expect(start.out).toMatch(/^agent-notebook: the session-start hook could not load the notebook index .*\n$/);
      const sub = adapter('subagent-start', {}, { NB_BIN: bin });
      expect(JSON.parse(sub.out).hookSpecificOutput.additionalContext).toMatch(why);
      const stop = adapter('stop', { session_id: 's' }, { NB_BIN: bin });
      expect(stop.code).toBe(0);
      expect(stop.out).toBe('');
      expect(stop.err).toContain('nb-claude-hook:');
    }
  });

  test('NB_BIN as a bare name is looked up on PATH, as a relative path from the working directory', () => {
    shelf('build', 1);
    const bin = join(tmp, 'bin dir');
    mkdirSync(bin);
    const name = isWin ? 'mynb.cmd' : 'mynb';
    writeFileSync(join(bin, name), isWin ? `@"${process.execPath}" "${CLI}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    if (!isWin) {
      const r = adapter('session-start', {}, { NB_BIN: 'mynb', PATH: `${bin}${delimiter}${process.env.PATH}` });
      expect(r.out).toContain('  build  1  ');
    }
    const rel = adapter('session-start', {}, { NB_BIN: './cli.js' }, dirname(CLI));
    expect(rel.out).toContain('  build  1  ');
  });

  test('a relative NB_DIR is the folder under the hook working directory, as for the 0.12 scripts', () => {
    shelf('build', 1);
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    // `nb` runs in the project directory, where `store` does not exist.
    const r = adapter('session-start', {}, { NB_DIR: 'store', CLAUDE_PROJECT_DIR: proj }, tmp);
    expect(r.out).toContain('  build  1  ');
  });

  test('--max-chars after the event reaches nb brief', () => {
    for (let i = 0; i < 40; i++) shelf(`s${i}-${'x'.repeat(100)}`, 50 - i, 'd'.repeat(150));
    const big = adapter('subagent-start');
    const small = done(spawnSync(process.execPath, [ADAPTER, 'subagent-start', '--max-chars', '3000'], { cwd: tmp, env: childEnv(), input: '{}', encoding: 'utf-8' }));
    console.log('DEBUG545', JSON.stringify({ big: [big.code, big.out.length, big.out.slice(0, 300), big.err], small: [small.code, small.out.length, small.out.slice(-400), small.err] }));
    expect(JSON.parse(big.out).hookSpecificOutput.additionalContext.length).toBeGreaterThan(3000);
    expect(JSON.parse(small.out).hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(3000);
  });

  test('an unknown event prints nothing and exits 0', () => {
    const r = adapter('PreToolUse');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toContain('unknown event');
  });

  test('print-settings prints a hooks block that runs node on this file for the three events', () => {
    const r = adapter('print-settings');
    const { hooks } = JSON.parse(r.out);
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'SubagentStart', 'Stop']);
    for (const [ev, arg] of [['SessionStart', 'session-start'], ['SubagentStart', 'subagent-start'], ['Stop', 'stop']]) {
      expect(hooks[ev][0].hooks[0]).toEqual({ type: 'command', command: 'node', args: [ADAPTER.replace(/\\/g, '/'), arg] });
    }
  });

  test('the hooks hold no instruction text of their own (acceptance criterion 2)', () => {
    const files = readdirSync(HOOKS).filter((f) => /\.(sh|mjs)$/.test(f));
    expect(files.sort()).toEqual(['nb-claude-hook.mjs', 'nb-retrospective.sh', 'nb-session-start.sh', 'nb-subagent-start.sh']);
    const text = files.map((f) => readFileSync(join(HOOKS, f), 'utf-8')).join('\n');
    const lines = [...BRIEF_HEADER_LINES, FRAMING_LINE, BRIEF_OFF_LINE, BRIEF_EMPTY_LINE, ...RETRO_LESSONS_LINES].map((l) => l.trim()).filter((l) => l.length >= 12);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(text, line).not.toContain(line);
  });
});

describe('the trampolines keep the 0.12 file names working (FR-HOOKS-001)', () => {
  testSh('they run under a POSIX sh (dash), not only bash', () => {
    shelf('build', 1);
    expect(script(HOOKS, 'nb-session-start.sh', {}, {}, 'sh').out).toContain('  build  1  ');
    expect(JSON.parse(script(HOOKS, 'nb-retrospective.sh', { session_id: 'd' }, {}, 'sh').out).decision).toBe('block');
  });

  testSh('a copied script without the adapter beside it: one line at start, nothing at stop, exit 0', () => {
    const copy = join(tmp, 'copy');
    mkdirSync(copy);
    for (const f of ['nb-session-start.sh', 'nb-subagent-start.sh', 'nb-retrospective.sh']) copyFileSync(join(HOOKS, f), join(copy, f));
    const start = script(copy, 'nb-session-start.sh');
    expect(start.code).toBe(0);
    expect(start.out).toMatch(/^agent-notebook: .*nb-claude-hook\.mjs is missing.*\n$/);
    expect(script(copy, 'nb-subagent-start.sh').out).toBe('');
    expect(script(copy, 'nb-retrospective.sh', { session_id: 's' }).out).toBe('');
    expect(sentinels()).toEqual([]);
  });

  testSh('a copied adapter outside the package uses the nb on PATH', () => {
    shelf('build', 1);
    const copy = join(tmp, 'hooks copy');
    const bin = join(tmp, 'bin');
    mkdirSync(copy);
    mkdirSync(bin);
    for (const f of ['nb-session-start.sh', 'nb-claude-hook.mjs']) copyFileSync(join(HOOKS, f), join(copy, f));
    writeFileSync(join(bin, 'nb'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
    chmodSync(join(bin, 'nb'), 0o755);
    const r = script(copy, 'nb-session-start.sh', {}, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    expect(r.out).toContain('  build  1  ');
  });
});
