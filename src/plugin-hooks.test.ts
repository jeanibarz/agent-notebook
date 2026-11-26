import { describe, test, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #559: plugin/hooks/hooks.json starts every event from nb-hook-entry.cjs with
// `node` and an argument list (no shell), and the twin commands only test that `node`
// exists. They never run it: a twin that ran `node -e` executed a node planted in the
// current folder through an empty PATH element.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PLUGIN = join(root, 'plugin');
const HOOK_DIR = 'examples/hooks/claude-code/';

interface Hook {
  type: string;
  command: string;
  args: string[];
}
type HooksFile = { hooks: Record<string, Array<{ hooks: Hook[] }>> };
const hooksJson = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf-8')) as HooksFile;
// A Windows checkout gives CRLF; the line-anchored patterns below read LF.
const entrySource = readFileSync(join(root, HOOK_DIR, 'nb-hook-entry.cjs'), 'utf-8').replace(/\r\n/g, '\n');
const NOTICE = /^var NOTICE = '([^']*)';$/m.exec(entrySource)![1]!;
const eventHooks = (event: string): Hook[] => hooksJson.hooks[event]!.flatMap((g) => g.hooks);
const entryHook = (event: string): Hook | undefined => eventHooks(event).find((h) => h.command === 'node');
const sh = eventHooks('SessionStart').find((h) => h.command === 'sh')!;
const ps = eventHooks('SessionStart').find((h) => h.command === 'powershell.exe')!;

const EVENTS: Array<[string, string]> = [
  ['SessionStart', 'session-start'],
  ['SubagentStart', 'subagent-start'],
  ['Stop', 'stop'],
];

describe('hooks.json runs the entry with node and an argument list (FR-PLUGIN-002, issue #559)', () => {
  test('it names exactly the three events', () => {
    expect(Object.keys(hooksJson.hooks).sort()).toEqual(['SessionStart', 'Stop', 'SubagentStart']);
  });

  for (const [event, arg] of EVENTS) {
    test(`${event}: command node, args the entry and "${arg}", no shell`, () => {
      const h = entryHook(event)!;
      expect(h).toEqual({ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${HOOK_DIR}nb-hook-entry.cjs`, arg] });
      expect(entryHook(event)).toBe(eventHooks(event).filter((x) => x.command === 'node')[0]);
    });
  }

  test('only SessionStart has more than the entry, and it has exactly the two twins', () => {
    expect(eventHooks('SubagentStart')).toHaveLength(1);
    expect(eventHooks('Stop')).toHaveLength(1);
    expect(eventHooks('SessionStart').map((h) => h.command)).toEqual(['node', 'sh', 'powershell.exe']);
    expect(sh.args.slice(0, 1)).toEqual(['-c']);
    expect(ps.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  });

  test('every command string starts a program directly: no hook is a shell string', () => {
    for (const [event] of EVENTS) for (const h of eventHooks(event)) expect(Array.isArray(h.args) && h.args.length > 0, `${event} ${h.command}`).toBe(true);
  });
});

describe('the node-check twins test that node exists and never run it (FR-PLUGIN-002, issue #559)', () => {
  test('each twin carries the entry\'s notice, byte for byte, exactly once', () => {
    for (const twin of [sh, ps]) {
      const script = twin.args[twin.args.length - 1]!;
      expect(script.split(NOTICE).length - 1).toBe(1);
    }
    expect(NOTICE).toMatch(/^[\x20-\x7e]+$/);
    expect(NOTICE).not.toMatch(/['"$`%&|^<>()!;]/);
  });

  test('the sh twin uses command -v and the PowerShell twin Get-Command', () => {
    expect(sh.args[1]).toContain('command -v node >/dev/null 2>&1 ||');
    expect(ps.args[3]).toContain('Get-Command node -CommandType Application');
  });

  test('neither twin runs node: no `node -e`, no `node ` invocation outside the existence test', () => {
    // Take out the two existence tests; what is left must not name node at all.
    const shell = sh.args[1]!.replace(NOTICE, '<NOTICE>').replace('command -v node >/dev/null 2>&1', '');
    const power = ps.args[3]!.replace(NOTICE, '<NOTICE>').replace('Get-Command node -CommandType Application', '');
    expect(shell).not.toMatch(/\bnode\b/);
    expect(power).not.toMatch(/\bnode\b/);
  });

  test.skipIf(process.platform === 'win32')('the sh twin runs no program from the current folder, not even uname, whatever the PATH', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nb twin ')));
    try {
      for (const name of ['uname', 'node', 'sh']) writeFileSync(join(dir, name), `#!/bin/sh\ntouch RAN-${name}\n`, { mode: 0o755 });
      for (const path of [':/usr/bin:/bin', '::', '', '.', 'rel:/usr/bin:/bin', '/usr/bin:/bin:', '/usr/bin::/bin']) {
        const r = spawnSync('/bin/sh', sh.args, { cwd: dir, env: { PATH: path }, encoding: 'utf-8' });
        expect(r.status, path).toBe(0);
      }
      expect(readdirSync(dir).filter((f) => f.startsWith('RAN-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('the sh twin stays quiet under Git Bash, MSYS and Cygwin, where the PowerShell twin speaks', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nb twin ')));
    try {
      for (const kernel of ['MINGW64_NT-10.0-26100', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0']) {
        writeFileSync(join(dir, 'uname'), `#!/bin/sh\necho ${kernel}\n`, { mode: 0o755 });
        // No node on this PATH: without the guard the twin would print the notice.
        expect(spawnSync('/bin/sh', sh.args, { env: { PATH: dir }, encoding: 'utf-8' }).stdout, kernel).toBe('');
      }
      writeFileSync(join(dir, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
      expect(spawnSync('/bin/sh', sh.args, { env: { PATH: dir }, encoding: 'utf-8' }).stdout).toBe(NOTICE + '\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the PowerShell twin stops first when CLAUDE_PLUGIN_ROOT is absent (WSL reaching a Windows powershell.exe)', () => {
    expect(ps.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(ps.args[3]!.startsWith('if (-not $env:CLAUDE_PLUGIN_ROOT) { exit 0 }; ')).toBe(true);
  });

  test.skipIf(process.platform === 'win32')('the sh twin prints the notice with no node, and runs nothing when a node is planted in the current folder', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nb twin ')));
    try {
      writeFileSync(join(dir, 'node'), '#!/bin/sh\ntouch RAN\n', { mode: 0o755 });
      const run = (path: string): string => spawnSync('/bin/sh', sh.args, { cwd: dir, env: { PATH: path }, encoding: 'utf-8' }).stdout;
      expect(run('/nonexistent')).toBe(NOTICE + '\n');
      // An empty PATH element means "the current folder": the twin may find the planted file, but must not run it.
      run(':/nonexistent');
      run('./:/nonexistent');
      expect(existsSync(join(dir, 'RAN'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hooks.json and print-settings start the same program (FR-PLUGIN-002, issue #559)', () => {
  const printed = JSON.parse(spawnSync(process.execPath, [join(root, HOOK_DIR, 'nb-claude-hook.mjs'), 'print-settings'], { encoding: 'utf-8' }).stdout) as HooksFile;
  const printedHook = (event: string): Hook => printed.hooks[event]![0]!.hooks[0]!;

  for (const [event, arg] of EVENTS) {
    test(`${event}: the same command and arguments, except the file name`, () => {
      const mine = entryHook(event)!;
      const theirs = printedHook(event);
      expect(mine.command).toBe(theirs.command);
      expect(mine.args).toHaveLength(theirs.args.length);
      expect(mine.args[1]).toBe(arg);
      expect(theirs.args[1]).toBe(arg);
      const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);
      expect(dirOf(mine.args[0]!).endsWith(HOOK_DIR)).toBe(true);
      expect(dirOf(theirs.args[0]!).endsWith(HOOK_DIR)).toBe(true);
      expect(mine.args[0]!.slice(dirOf(mine.args[0]!).length)).toBe('nb-hook-entry.cjs');
      expect(theirs.args[0]!.slice(dirOf(theirs.args[0]!).length)).toBe('nb-claude-hook.mjs');
    });
  }
});

describe('the skill and the manifest (FR-PLUGIN-003, issue #559)', () => {
  const skill = readFileSync(join(PLUGIN, 'skills', 'agent-notebook', 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!;

  test('SKILL.md has a name and a description that carries the cue for when the start-up step is off', () => {
    expect(/^name: agent-notebook$/m.test(front)).toBe(true);
    const description = /^description: (.+)$/m.exec(front)![1]!;
    expect(description).toContain('no agent-notebook index reached you at the start of this session');
  });

  test('it is short, stamps the version, and reaches the plugin\'s nb by the braced variable', () => {
    expect(skill.split('\n').length).toBeLessThan(90);
    expect(skill).toContain('{{VERSION}}');
    expect(skill).toContain('"${CLAUDE_PLUGIN_ROOT}/bin/nb"');
    expect(skill).toContain('& "${CLAUDE_PLUGIN_ROOT}\\bin\\nb.cmd"');
    expect(skill).toContain(`$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); 'the lesson' | & "\${CLAUDE_PLUGIN_ROOT}\\bin\\nb.cmd" add <name> -`);
    for (const path of ['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json', 'C:\\Program Files\\ClaudeCode\\managed-settings.json']) expect(skill).toContain(path);
  });

  test('plugin.json names the plugin, its author, home, repository and licence, and has no version', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf-8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: 'agent-notebook', author: { name: 'Jean Ibarz' }, homepage: 'https://github.com/jeanibarz/agent-notebook', repository: 'https://github.com/jeanibarz/agent-notebook', license: 'MIT' });
    expect(typeof manifest.description).toBe('string');
    expect(manifest).not.toHaveProperty('version');
    expect(manifest).not.toHaveProperty('userConfig');
  });
});
