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
  // HOME: never the developer's real ~/.agent-notebook/messages, which `nb brief` reads (issue #539).
  return { ...env, HOME: join(tmp, 'home'), USERPROFILE: join(tmp, 'home'), GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: tmp, NB_DIR: store, ...extra };
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

  // Eleven adapter runs, each a node process: 5.5 s was seen on a loaded Windows runner, over
  // Vitest's 5 s default. The time limit is raised; nothing here asserts a time.
  test('hostile session ids become one safe argument and one sentinel inside the store', { timeout: 30_000 }, () => {
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
    // Switched off in the environment, the start hooks skip even that line.
    for (const off of ['0', 'off']) {
      for (const ev of ['session-start', 'subagent-start']) {
        const r = adapter(ev, {}, { NB_BIN: join(tmp, 'missing-nb'), NB_ENABLED: off });
        expect(r.code).toBe(0);
        expect(r.out, `${ev} NB_ENABLED=${off}`).toBe('');
      }
    }
  });

  testSh('a copied adapter never runs an nb found through a relative PATH entry', () => {
    const copy = join(tmp, 'hooks copy');
    const proj = join(tmp, 'proj');
    mkdirSync(copy);
    mkdirSync(proj);
    copyFileSync(ADAPTER, join(copy, 'nb-claude-hook.mjs'));
    const marker = join(tmp, 'ran');
    writeFileSync(join(proj, 'nb'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const r = done(
      spawnSync(process.execPath, [join(copy, 'nb-claude-hook.mjs'), 'session-start'], {
        cwd: proj,
        env: childEnv({ PATH: '.', CLAUDE_PROJECT_DIR: proj }),
        input: '{}',
        encoding: 'utf-8',
      }),
    );
    expect(existsSync(marker)).toBe(false);
    expect(r.out).toMatch(/nb was not found/);
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
    // On macOS, where a write to a pipe is asynchronous, this also proves that a
    // reply above the 8 KiB pipe buffer reaches the reader whole (the adapter must
    // not call process.exit() after writing it).
    expect(JSON.parse(big.out).hookSpecificOutput.additionalContext.length).toBeGreaterThan(8192);
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

// Issue #558 (FR-HOOKS-001): the label every hook run records, `<harness>.<event>`, and
// the folder `nb` runs in. A stand-in `nb` (NB_BIN) records what it was called with.
describe('the harness label and the project folder (FR-HOOKS-001, issue #558)', () => {
  /** Runs the adapter with a stand-in `nb`; returns the `--hook` label and the folder `nb` ran in. */
  function probe(event: string, flags: string[], payload: unknown, env: Record<string, string | undefined> = {}) {
    const record = join(tmp, 'record.json');
    const fake = join(tmp, 'fake-nb.mjs');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
    const e = childEnv({ NB_BIN: fake });
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete e[k];
      else e[k] = v;
    }
    const r = spawnSync(process.execPath, [ADAPTER, event, ...flags], { cwd: tmp, env: e, input: JSON.stringify(payload), encoding: 'utf-8', timeout: 20_000 });
    expect(r.status).toBe(0);
    const seen = JSON.parse(readFileSync(record, 'utf-8')) as { argv: string[]; cwd: string };
    return { label: seen.argv[seen.argv.indexOf('--hook') + 1], argv: seen.argv, cwd: realpathSync(seen.cwd) };
  }

  test('--harness names the label, for every event', () => {
    expect(probe('session-start', ['--harness', 'codex'], {}).label).toBe('codex.session-start');
    expect(probe('subagent-start', ['--harness', 'codex'], {}).label).toBe('codex.subagent-start');
    expect(probe('stop', ['--harness', 'codex'], { session_id: 's' }).label).toBe('codex.stop');
  });

  test('an invalid or empty --harness is ignored, as if absent', () => {
    for (const bad of ['BAD!', '', '-x', '--max-chars', 'a'.repeat(25), 'Codex', 'a b', '.x', 'é']) {
      expect(probe('session-start', ['--harness', bad], {}, { CLAUDE_CODE_SESSION_ID: undefined }).label, JSON.stringify(bad)).toBe('hook.session-start');
      expect(probe('session-start', ['--harness', bad], { session_id: 'sid' }, { CLAUDE_CODE_SESSION_ID: 'sid' }).label, JSON.stringify(bad)).toBe('claude-code.session-start');
    }
    expect(probe('session-start', ['--harness'], {}, { CLAUDE_CODE_SESSION_ID: undefined }).label).toBe('hook.session-start');
    expect(probe('session-start', ['--harness', 'a'.repeat(24)], {}).label).toBe(`${'a'.repeat(24)}.session-start`);
  });

  test('without --harness, equal non-empty session ids make it claude-code', () => {
    expect(probe('session-start', [], { session_id: 'abc' }, { CLAUDE_CODE_SESSION_ID: 'abc' }).label).toBe('claude-code.session-start');
    expect(probe('stop', [], { session_id: 'abc' }, { CLAUDE_CODE_SESSION_ID: 'abc' }).label).toBe('claude-code.stop');
  });

  test('the ids are compared raw, before the adapter cleans the session id', () => {
    // 'a b' and 'a_b' are one id once cleaned; as sent they are two.
    expect(probe('session-start', [], { session_id: 'a b' }, { CLAUDE_CODE_SESSION_ID: 'a_b' }).label).toBe('hook.session-start');
    expect(probe('session-start', [], { session_id: 'a b' }, { CLAUDE_CODE_SESSION_ID: 'a b' }).label).toBe('claude-code.session-start');
  });

  test('without --harness, an unset, empty or different CLAUDE_CODE_SESSION_ID gives hook', () => {
    const payload = { session_id: 'abc' };
    expect(probe('session-start', [], payload, { CLAUDE_CODE_SESSION_ID: undefined }).label).toBe('hook.session-start');
    expect(probe('session-start', [], payload, { CLAUDE_CODE_SESSION_ID: '' }).label).toBe('hook.session-start');
    expect(probe('session-start', [], payload, { CLAUDE_CODE_SESSION_ID: 'other' }).label).toBe('hook.session-start');
  });

  test('an empty or missing payload session id gives hook, even beside an empty environment id', () => {
    expect(probe('session-start', [], { session_id: '' }, { CLAUDE_CODE_SESSION_ID: '' }).label).toBe('hook.session-start');
    expect(probe('session-start', [], {}, { CLAUDE_CODE_SESSION_ID: '' }).label).toBe('hook.session-start');
    expect(probe('session-start', [], { session_id: '' }, { CLAUDE_CODE_SESSION_ID: 'abc' }).label).toBe('hook.session-start');
    expect(probe('session-start', [], { session_id: 7 }, { CLAUDE_CODE_SESSION_ID: '7' }).label).toBe('hook.session-start');
  });

  test('--harness works before and after --max-chars, which still reaches nb brief', () => {
    for (const flags of [['--harness', 'codex', '--max-chars', '3000'], ['--max-chars', '3000', '--harness', 'codex']]) {
      const r = probe('session-start', flags, {});
      expect(r.label, flags.join(' ')).toBe('codex.session-start');
      expect(r.argv.slice(r.argv.indexOf('--max-chars'), r.argv.indexOf('--max-chars') + 2)).toEqual(['--max-chars', '3000']);
    }
  });

  test('an explicit --harness wins over a matching Claude Code session id', () => {
    expect(probe('session-start', ['--harness', 'codex'], { session_id: 'abc' }, { CLAUDE_CODE_SESSION_ID: 'abc' }).label).toBe('codex.session-start');
  });

  test('with --harness codex nb runs in the payload cwd, not the inherited CLAUDE_PROJECT_DIR', () => {
    const parent = join(tmp, 'parent project');
    const work = join(tmp, 'work dir');
    mkdirSync(parent);
    mkdirSync(work);
    expect(probe('session-start', ['--harness', 'codex'], { cwd: work }, { CLAUDE_PROJECT_DIR: parent }).cwd).toBe(work);
    expect(probe('stop', ['--harness', 'codex'], { session_id: 's', cwd: work }, { CLAUDE_PROJECT_DIR: parent }).cwd).toBe(work);
    // An unusable payload cwd falls back to the process folder, never to the inherited project.
    for (const cwd of [join(tmp, 'missing'), 'relative/dir', 7, undefined]) {
      expect(probe('session-start', ['--harness', 'codex'], { cwd }, { CLAUDE_PROJECT_DIR: parent }).cwd, String(cwd)).toBe(tmp);
    }
  });

  test('--harness claude-code keeps CLAUDE_PROJECT_DIR; so does the inferred label, even with mismatched ids', () => {
    const proj = join(tmp, 'proj');
    const work = join(tmp, 'work dir');
    mkdirSync(proj);
    mkdirSync(work);
    const env = { CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: 'other' };
    expect(probe('session-start', ['--harness', 'claude-code'], { cwd: work }, env).cwd).toBe(proj);
    const mismatched = probe('session-start', [], { cwd: work, session_id: 'abc' }, env);
    expect(mismatched.label).toBe('hook.session-start');
    expect(mismatched.cwd).toBe(proj);
    const matched = probe('session-start', [], { cwd: work, session_id: 'abc' }, { CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: 'abc' });
    expect(matched.label).toBe('claude-code.session-start');
    expect(matched.cwd).toBe(proj);
    // An invalid --harness is "as if absent": it does not move the folder either.
    expect(probe('session-start', ['--harness', 'BAD!'], { cwd: work }, { CLAUDE_PROJECT_DIR: proj }).cwd).toBe(proj);
  });

  test('print-settings is byte for byte what it was: Claude Code needs no flag', () => {
    const adapterPath = ADAPTER.replace(/\\/g, '/');
    const hook = (name: string) => [{ hooks: [{ type: 'command', command: 'node', args: [adapterPath, name] }] }];
    const expected = JSON.stringify({ hooks: { SessionStart: hook('session-start'), SubagentStart: hook('subagent-start'), Stop: hook('stop') } }, null, 2) + '\n';
    expect(adapter('print-settings').out).toBe(expected);
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
    for (const [f, p] of [['nb-subagent-start.sh', {}], ['nb-retrospective.sh', { session_id: 's' }]] as const) {
      const r = script(copy, f, p);
      expect(r.code, f).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toContain('nb-claude-hook.mjs is missing');
    }
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
