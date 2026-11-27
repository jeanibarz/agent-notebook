import { describe, test, expect } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Issue #560, FR-PLUGIN-003: inside the plugin a program that does not answer within the hook's 15 seconds is
// reported as slow, not as missing. The adapter's limit is fixed, so this waits for it: a wall-clock test.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = join(root, 'examples', 'hooks', 'claude-code', 'nb-claude-hook.mjs');

describe('the could-not-load line when nb does not answer (FR-PLUGIN-003)', () => {
  test('inside the plugin a timeout says it took too long and will try again; outside the plugin the old text [timing]', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb adapter timeout ')));
    try {
      const slow = join(tmp, 'slow-nb.mjs');
      writeFileSync(slow, 'setTimeout(() => {}, 120000);\n');
      const env = (plugin: boolean): NodeJS.ProcessEnv => {
        const e: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp, NB_BIN: slow };
        for (const k of Object.keys(e)) if ((k.startsWith('NB_') && k !== 'NB_BIN') || k.startsWith('CLAUDE_')) delete e[k];
        if (plugin) e.CLAUDE_PLUGIN_ROOT = root;
        return e;
      };
      const inside = spawnSync(process.execPath, [ADAPTER, 'session-start'], { cwd: tmp, env: env(true), input: '{"session_id":"abcdef12-3456","source":"startup"}', encoding: 'utf-8', timeout: 40_000 });
      expect(inside.status).toBe(0);
      expect(inside.stdout).toBe('agent-notebook: the notebook took too long to start; it will try again next chat.\n');
      const outside = spawnSync(process.execPath, [ADAPTER, 'session-start'], { cwd: tmp, env: env(false), input: '{}', encoding: 'utf-8', timeout: 40_000 });
      expect(outside.stdout).toMatch(/^agent-notebook: the session-start hook could not load the notebook index \(nb could not run \(ETIMEDOUT\)\)\. Tell the user: install or update agent-notebook \(npm i -g agent-notebook\), or point NB_BIN at nb\.\n$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
