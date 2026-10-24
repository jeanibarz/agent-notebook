import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNbCli } from './cli.js';

const PKG_VERSION: string = createRequire(import.meta.url)('../package.json').version;

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-cli-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_ROLE']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Run runNbCli with stdout/stderr captured. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — test shim for capturing writes
  process.stdout.write = (s: string) => ((out += s), true);
  // @ts-expect-error — test shim for capturing writes
  process.stderr.write = (s: string) => ((err += s), true);
  try {
    const code = await runNbCli(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('runNbCli', () => {
  test('--help and no-args print usage and exit 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb — the Agent Notebook');
  });

  test('add then show round-trips a lesson', async () => {
    expect((await run(['add', 'patcher', 'prefer execFileSync, array args'])).code).toBe(0);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('prefer execFileSync, array args');
    expect(show.out).toMatch(/^[0-9a-f]{6}\s+\[\+1\]\s+prefer execFileSync/m); // stable id + score
  });

  test('vote by the id shown in `show` succeeds', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const show = await run(['show', 'patcher']);
    const id = show.out.trim().split('\n')[0].split(/\s+/)[0]; // first token of the top line
    const v = await run(['vote', 'patcher', id, '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('vote adjusts the score shown', async () => {
    await run(['add', 'patcher', 'run lint before done']);
    const v = await run(['vote', 'patcher', 'lint', '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('stats --since labels the window and returns 0', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '30m']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 30m');
  });

  test('a valid --since emits no warning', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '12h']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 12h');
    expect(s.err).toBe('');
  });

  test('a malformed --since warns naming the format and the window used, then proceeds', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days']);
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since '7days'");
    expect(s.err).toContain('Nd/Nh/Nm'); // names the accepted format
    expect(s.err).toContain('showing 7d'); // names the window actually used
    expect(s.err.trimEnd().split('\n')).toHaveLength(1); // one line, per the acceptance criteria
    expect(s.out).toContain('window 7d'); // falls back to the default and still reports
  });

  test('--since with no value warns, renders empty quotes, and still resolves the role', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since']); // --since is the final arg
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since ''"); // empty-quote fallback for a missing value
    expect(s.err).toContain('showing 7d');
    expect(s.out).toContain('window 7d');
    expect(s.out).toContain('role patcher'); // role still parsed despite the dangling flag
  });

  test('unknown command exits 2', async () => {
    const r = await run(['frobnicate', 'patcher']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });

  test('a missing required argument exits 1', async () => {
    const r = await run(['show']); // no role
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <role>');
  });

  test('a bad vote direction exits 1', async () => {
    await run(['add', 'patcher', 'x']);
    const r = await run(['vote', 'patcher', 'x', '2']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('+1 or -1');
  });

  test('--version (and -v / version) print the real package version', async () => {
    // Assert the exact package.json version, not just "a semver" — this also
    // catches a silent fallback (e.g. 0.0.0) if version resolution breaks.
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    for (const flag of ['--version', '-v', 'version']) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(`nb (agent-notebook) ${PKG_VERSION}\n`);
    }
  });

  test('an over-long add exits 1, is not stored, and tells the agent to retry', async () => {
    process.env.NB_MAX_CHARS = '25';
    const r = await run(['add', 'patcher', 'z'.repeat(60)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too long/i);
    expect(r.err).toMatch(/retry/i);
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('is empty');
  });

  test('merge consolidates two entries into one, reflected by show', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const m = await run(['merge', 'patcher', 'alpha', 'beta', 'merged lesson alpha+beta']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('merged two entries into one');
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('merged lesson alpha+beta');
    expect(show.out).not.toContain('alpha lesson one');
    expect(show.out).not.toContain('beta lesson two');
  });

  test('merge with a missing argument exits 1', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const r = await run(['merge', 'patcher', 'alpha', 'beta']); // no merged lesson
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <merged lesson>');
  });

  test('rm deletes an entry, reflected by show', async () => {
    await run(['add', 'patcher', 'keep this lesson']);
    await run(['add', 'patcher', 'drop this lesson']);
    const r = await run(['rm', 'patcher', 'drop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed');
    expect(r.out).toContain('drop this lesson');
    const show = await run(['show', 'patcher']);
    expect(show.out).not.toContain('drop this lesson');
    expect(show.out).toContain('keep this lesson');
  });

  test('rm with a missing argument exits 1', async () => {
    const r = await run(['rm', 'patcher']); // no id|query selector
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <id|query>');
  });

  test('path with no role prints the notebooks dir (respecting NB_DIR)', async () => {
    const r = await run(['path']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${dir}\n`); // bare path, pipeable into cat/$(...)
  });

  test('path <role> prints the resolved absolute role file path', async () => {
    const r = await run(['path', 'reviewer']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${join(dir, 'reviewer.md')}\n`);
    expect(r.out.trimEnd()).toMatch(/\/reviewer\.md$/);
  });

  test('path with an unsafe role name is rejected by the existing safe-role check', async () => {
    const r = await run(['path', '../escape']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid role name/);
  });
});
