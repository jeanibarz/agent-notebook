import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #559: the JSON blocks of docs/enterprise.md#claude-code-plugin are pasted by administrators into
// managed settings, so they are parsed here, and the file they name must be one the plugin ships.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs', 'enterprise.md'), 'utf-8').replace(/\r\n/g, '\n');
const section = doc.slice(doc.indexOf('## Claude Code plugin\n'), doc.indexOf('## Multi-user / team topologies'));
const blocks = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as Record<string, any>);

describe('docs/enterprise.md#claude-code-plugin (issue #559)', () => {
  test('the section exists, that the plugin\'s skill points to', () => {
    expect(section.length).toBeGreaterThan(1000);
    expect(readFileSync(join(root, 'plugin', 'skills', 'agent-notebook', 'SKILL.md'), 'utf-8')).toContain('docs/enterprise.md');
  });

  test('the allowlist is the exact marketplace URL, not a host pattern', () => {
    const allow = blocks.find((b) => b.strictKnownMarketplaces);
    expect(allow?.strictKnownMarketplaces).toEqual([{ source: 'url', url: 'https://raw.githubusercontent.com/jeanibarz/agent-notebook/main/.claude-plugin/marketplace.json' }]);
  });

  test.each([
    ['POSIX', '/usr/local/bin/node', '/opt/agent-notebook'],
    ['Windows', 'C:/Program Files/nodejs/node.exe', 'C:/Program Files/agent-notebook'],
  ])('the %s managed block runs the entry of the three events with --managed and an absolute node', (_os, node, folder) => {
    const block = blocks.find((b) => b.hooks && JSON.stringify(b).includes(node));
    expect(block?.allowManagedHooksOnly).toBe(true);
    expect(Object.keys(block!.hooks)).toEqual(['SessionStart', 'SubagentStart', 'Stop']);
    const events = { SessionStart: 'session-start', SubagentStart: 'subagent-start', Stop: 'stop' } as const;
    for (const [event, arg] of Object.entries(events)) {
      const hooks = block!.hooks[event];
      expect(hooks).toHaveLength(1);
      expect(hooks[0].hooks).toEqual([{ type: 'command', command: node, args: [`${folder}/examples/hooks/claude-code/nb-hook-entry.cjs`, arg, '--managed'] }]);
    }
    expect(existsSync(join(root, 'examples', 'hooks', 'claude-code', 'nb-hook-entry.cjs'))).toBe(true);
  });

  test('every event of the block is one that the plugin\'s hooks.json also runs', () => {
    const hooks = JSON.parse(readFileSync(join(root, 'plugin', 'hooks', 'hooks.json'), 'utf-8')).hooks as Record<string, unknown>;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'SubagentStart', 'Stop']);
  });
});
