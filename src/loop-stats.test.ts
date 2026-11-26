import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stats } from './stats.js';

// Issue #538: the example hooks move from `nb enabled` + `nb list` to `nb brief`
// and `nb retro`. Without these rules every upgraded user would read a false
// "went silent" for the old commands, and a burst of hook calls would read as a
// stuck agent.
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

let dir: string;
const saved = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb loop stats '));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...saved };
});

const now = Date.parse('2026-11-26T10:00:00Z');
const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
// ts shelf command status ms session entries outcome
const row = (msAgo: number, command: string, session = '', outcome = ''): string =>
  `${at(msAgo)}\t-\t${command}\tok\t3ms\t${session}\t\t${outcome}`;

function anomalies(lines: string[], kind: string) {
  writeFileSync(join(dir, '.nb-usage.log'), lines.join('\n') + '\n', 'utf-8');
  return stats(dir, { now, windowMs: 48 * 3600_000 }).anomalies.filter((a) => a.kind === kind);
}

describe('nb stats with the brief and retro hook commands (issue #538)', () => {
  test('ten blank-session retro rows in a minute are not reported as a loop', () => {
    process.env.NB_LOOP_N = '10';
    process.env.NB_LOOP_WINDOW_S = '120';
    const lines = Array.from({ length: 10 }, (_, i) => row(60_000 - i * 5000, 'retro', '', 'off'));
    expect(anomalies(lines, 'loop')).toEqual([]);
  });

  test('ten blank-session list rows in a minute are still a loop', () => {
    process.env.NB_LOOP_N = '10';
    process.env.NB_LOOP_WINDOW_S = '120';
    const lines = Array.from({ length: 10 }, (_, i) => row(60_000 - i * 5000, 'list'));
    expect(anomalies(lines, 'loop')).toHaveLength(1);
  });

  test('enabled and list do not went-silent while retro rows are in the window', () => {
    const old = 216 * 3600_000;
    const lines = [row(old, 'enabled'), row(old, 'list'), row(old, 'merge'), row(3600_000, 'retro', 's1', 'nudge')];
    expect(anomalies(lines, 'went-silent').map((a) => a.command)).toEqual(['merge']);
  });

  test('enabled still went-silent when no hook command runs in the window', () => {
    const old = 216 * 3600_000;
    const lines = [row(old, 'enabled'), row(3600_000, 'show')];
    expect(anomalies(lines, 'went-silent').map((a) => a.command)).toEqual(['enabled']);
  });
});

describe('nb config recognises the nb retro variables (issue #538)', () => {
  test('NB_RETRO_EXTRA_PROMPT, NB_RETRO_TTL_DAYS and NB_PROJECT_SLUG are not listed as not read by nb', () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NB_')) env[k] = v;
    Object.assign(env, {
      NB_DIR: dir,
      NB_RETRO_EXTRA_PROMPT: '/x/prompt.txt',
      NB_RETRO_TTL_DAYS: '3',
      NB_PROJECT_SLUG: 'acme',
      NB_TOTALLY_UNKNOWN: '1',
    });
    const r = spawnSync(process.execPath, [cli, 'config', '--json'], { env, encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const unrecognized: Array<{ name: string }> = JSON.parse(r.stdout).unrecognized;
    expect(unrecognized.map((u) => u.name)).toEqual(['NB_TOTALLY_UNKNOWN']);
  });
});
