import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// A subagent never receives the SessionStart index. nb-subagent-start.sh hands it
// the same text, in the only form Claude Code adds to a subagent's context: a JSON
// object with hookSpecificOutput.additionalContext (plain stdout is dropped).
const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(here, '..', 'examples', 'hooks', 'claude-code');
const hook = join(hooksDir, 'nb-subagent-start.sh');
const sessionStart = join(hooksDir, 'nb-session-start.sh');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-subagent-start-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stubNb(body: string): string {
  const stub = join(dir, 'nb-stub');
  writeFileSync(stub, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function run(script: string, nbBin: string): string {
  // NB_PROJECT_SLUG / NB_GLOBAL_SHELF are removed so a developer's own shell cannot
  // switch the layered index on; NB_ENABLED so it cannot switch the hook off.
  const env: NodeJS.ProcessEnv = { ...process.env, NB_BIN: nbBin };
  for (const k of ['NB_PROJECT_SLUG', 'NB_GLOBAL_SHELF', 'NB_ENABLED']) delete env[k];
  return execFileSync('bash', [script], {
    env,
    encoding: 'utf-8',
    input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'general-purpose' }),
  });
}

describe('nb-subagent-start.sh', () => {
  test('wraps the session-start index in SubagentStart additionalContext', () => {
    const rows = 'printf "alpha  3  when a\\nbeta  1  when \\"quoted\\" b\\n"';
    const nb = stubNb(rows);
    const out = JSON.parse(run(hook, nb)) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    // The injected text is exactly what the SessionStart hook prints (minus the
    // trailing newline the shell's $(...) strips), quotes and newlines intact.
    expect(out.hookSpecificOutput.additionalContext).toBe(run(sessionStart, nb).replace(/\n+$/, ''));
    expect(out.hookSpecificOutput.additionalContext).toContain('## Your agent-notebook index');
    expect(out.hookSpecificOutput.additionalContext).toContain('  beta  1  when "quoted" b');
  });

  test('off repository (FR-ENABLED-003) → the subagent gets the one "switched off" line, not the index', () => {
    const nb = stubNb('if [ "$1" = enabled ]; then echo off; else echo "alpha  1  when a"; fi');
    const out = JSON.parse(run(hook, nb)) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('switched off for this repository');
    expect(out.hookSpecificOutput.additionalContext).not.toContain('alpha');
    expect(out.hookSpecificOutput.additionalContext).toBe(run(sessionStart, nb).replace(/\n+$/, ''));
  });

  test('missing nb → fail-open, no output', () => {
    expect(run(hook, join(dir, 'does-not-exist'))).toBe('');
  });

  test('copied without nb-session-start.sh beside it → fail-open, no output', () => {
    const lone = join(dir, 'nb-subagent-start.sh');
    copyFileSync(hook, lone);
    expect(run(lone, stubNb('echo "alpha  1  when a"'))).toBe('');
  });

  test('the example settings.json registers it under SubagentStart', () => {
    const settings = JSON.parse(readFileSync(join(hooksDir, 'settings.json'), 'utf-8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const commands = (settings.hooks.SubagentStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands.some((c) => c.endsWith('/nb-subagent-start.sh'))).toBe(true);
  });
});
