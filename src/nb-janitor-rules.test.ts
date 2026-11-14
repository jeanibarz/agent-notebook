import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Issue #484 — examples/nb-janitor.mjs ships standalone, so it keeps its own copies of two
// rules nb owns: how an integer env var is read (notebook.ts resolveIntEnv) and which `.md`
// files are shelves (notebook.ts assertSafeShelf). These tests run the REAL script and the
// REAL nb CLI against the same throwaway store and require the two to agree, so a later
// change to either rule that is not copied to the other fails here.
const here = dirname(fileURLToPath(import.meta.url));
const janitor = join(here, '..', 'examples', 'nb-janitor.mjs');
const nbCli = join(here, '..', 'dist', 'cli.js');

let dir: string;

/** The test process's env without the two caps under test, plus NB_DIR and `extra`. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NB_DIR: dir, ...extra };
  for (const k of ['NB_MAX_LINES', 'NB_USAGE_RING']) if (!(k in extra)) delete e[k];
  return e;
}
function shelf(name: string, lessons: string[]): void {
  writeFileSync(join(dir, `${name}.md`), `# scope: global\n${lessons.map((l) => `1\t${l}`).join('\n')}\n`, 'utf-8');
}
function janitorHuman(extra: Record<string, string> = {}): string {
  return execFileSync('node', [janitor], { env: env(extra), encoding: 'utf-8' });
}
type JanitorReport = { notebooks: number; totalLessons: number; fullShelves: string[]; usageWindow: { ring: number } };
function janitorJson(extra: Record<string, string> = {}): JanitorReport {
  return JSON.parse(execFileSync('node', [janitor, '--json'], { env: env(extra), encoding: 'utf-8' }));
}
function nbJson<T>(extra: Record<string, string>, ...args: string[]): T {
  return JSON.parse(
    execFileSync('node', [nbCli, ...args, '--json'], { env: env(extra), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }),
  );
}
type Config = Record<string, { value: number }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-janitor-rules-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-janitor reads integer env vars with nb’s rule (issue #484)', () => {
  // `1e3` and `abc` are not whole integers (nb ignores them → default 50); `0` and `99999`
  // clamp to the 1..5000 bounds; `" 7 "` is honored after trimming.
  test.each(['0', '1e3', '99999', 'abc', ' 7 ', '12.9', '50abc', '-5', '+7', ''])('NB_MAX_LINES=%j: the janitor’s cap equals nb config’s', (raw) => {
    shelf('alpha', ['one lesson only']);
    const extra = { NB_MAX_LINES: raw };
    const want = nbJson<Config>(extra, 'config').maxLines.value;
    expect(janitorHuman(extra)).toContain(`shelves are full (${want} lines)`);
  });

  test('the parity check is not vacuous: 1e3 gives 50 (not 1), 99999 gives 5000, 0 gives 1', () => {
    shelf('alpha', ['one lesson only']);
    expect(janitorHuman({ NB_MAX_LINES: '1e3' })).toContain('0 of 1 shelves are full (50 lines)');
    expect(janitorHuman({ NB_MAX_LINES: '99999' })).toContain('(5000 lines)');
    expect(janitorHuman({ NB_MAX_LINES: '0' })).toContain('1 of 1 shelves are full (1 lines)');
  });

  test.each(['1e3', '0', '999999', 'abc', ' 300 '])('NB_USAGE_RING=%j: the janitor’s ring equals nb config’s', (raw) => {
    const extra = { NB_USAGE_RING: raw };
    const want = nbJson<Config>(extra, 'config').usageRing.value;
    expect(janitorJson(extra).usageWindow.ring).toBe(want);
  });

  test('NB_USAGE_RING=1e3 is ignored (5000), not read as 1 and clamped to 100', () => {
    expect(janitorJson({ NB_USAGE_RING: '1e3' }).usageWindow.ring).toBe(5000);
  });
});

describe('nb-janitor counts the same shelves nb lists (issue #484)', () => {
  test('length cap and Windows device names: the janitor’s shelf set equals nb list’s', () => {
    const at128 = 'a'.repeat(128);
    const at129 = 'b'.repeat(129);
    const valid = ['real', at128, 'console', 'com10', 'aux-notes'];
    const invalid = [at129, 'con', 'nul.notes', 'LPT1', 'Readme', 'review copy', 'a..b'];
    for (const name of [...valid, ...invalid]) shelf(name, ['a lesson']);

    const listed = nbJson<{ rows: { shelf: string }[] }>({}, 'list').rows.map((r) => r.shelf);
    expect([...listed].sort()).toEqual([...valid].sort());

    // With a 1-line cap every shelf the janitor reads is "full", so `fullShelves` names its whole set.
    const report = janitorJson({ NB_MAX_LINES: '1' });
    expect([...report.fullShelves].sort()).toEqual([...listed].sort());
    expect(report.notebooks).toBe(listed.length);
    expect(report.totalLessons).toBe(valid.length);
  });

  // Each refused name alone, so a deleted guard cannot hide behind another one.
  test.each(['b'.repeat(129), 'con', 'nul.notes', 'com1', 'PRN', 'a..b', 'Readme', 'review copy'])('%j alone is not counted as a shelf', (name) => {
    shelf('real', ['a lesson']);
    shelf(name, ['a lesson']);
    expect(janitorJson().notebooks).toBe(1);
  });
});
