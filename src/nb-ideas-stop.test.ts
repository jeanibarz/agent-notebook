import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Drives the REAL examples/hooks/claude-code/nb-ideas-stop.sh. The hook asks the
// `nb-ideas` command for its text, so NB_IDEAS_BIN points at a small shim that
// runs the real examples/ideas/nb-ideas.mjs. NB_BIN points at a missing path so
// the hook's `nb enabled` check never runs whatever `nb` the host has.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const hook = join(root, 'examples', 'hooks', 'claude-code', 'nb-ideas-stop.sh');
const wrapper = join(root, 'examples', 'ideas', 'nb-ideas.mjs');

const DAY_MS = 86400000;
let tmp: string;
let ideasDir: string;
let shim: string;

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'NB_SESSION' || k === 'NB_DIR' || k === 'NB_BIN' || k === 'NB_RETRO_TTL_DAYS' || k.startsWith('NB_IDEAS_')) delete env[k];
  }
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

/** Run the hook; returns stdout (the block decision JSON, or ''). */
function runHook(input: Record<string, unknown>, env: Record<string, string> = {}): string {
  const r = spawnSync('bash', [hook], {
    cwd: tmp,
    input: JSON.stringify({ cwd: tmp, ...input }),
    env: {
      ...cleanEnv(),
      NB_IDEAS_DIR: ideasDir,
      NB_IDEAS_PROJECT: 'my-app',
      NB_IDEAS_BIN: shim,
      NB_BIN: join(tmp, 'no-nb'),
      ...env,
    },
    encoding: 'utf-8',
    timeout: 30000,
  });
  expect(r.status).toBe(0); // the hook never fails the stop
  return r.stdout;
}

const sentinel = (session: string) => join(ideasDir, `.ideas-prompt-${session}`);
const stop = (session: string, extra: Record<string, unknown> = {}) =>
  runHook({ session_id: session, hook_event_name: 'Stop', ...extra });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nb-ideas-stop-'));
  ideasDir = join(tmp, 'ideas');
  shim = join(tmp, 'nb-ideas');
  writeFileSync(shim, `#!/bin/sh\nexec node "${wrapper}" "$@"\n`, { mode: 0o755 });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('nb-ideas-stop.sh', () => {
  test('blocks the first stop of a session with the prompt text, then lets later stops through', () => {
    const out = stop('sess-1');
    const decision = JSON.parse(out);
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('Most tasks have nothing to record');
    expect(decision.reason).toContain('NB_SESSION=sess-1 nb-ideas add <category>'); // per-task rules work without an exported NB_SESSION
    expect(decision.reason).toContain('in my-app');
    expect(existsSync(sentinel('sess-1'))).toBe(true);
    expect(stop('sess-1')).toBe('');
    expect(JSON.parse(stop('sess-2')).decision).toBe('block'); // another session is asked once too
  });

  test('blocks on its first claim even when stop_hook_active is true (the lessons retrospective may have blocked before)', () => {
    expect(JSON.parse(stop('sess-1', { stop_hook_active: true })).decision).toBe('block');
    expect(stop('sess-1', { stop_hook_active: true })).toBe(''); // the sentinel, not the flag, prevents a loop
  });

  test('a SubagentStop never asks and does not use up the ask', () => {
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'SubagentStop' })).toBe('');
    expect(existsSync(sentinel('sess-1'))).toBe(false);
    expect(JSON.parse(stop('sess-1')).decision).toBe('block');
  });

  test('a payload with an agent_id (a subagent) never asks and does not use up the ask', () => {
    expect(stop('sess-1', { agent_id: 'agent-7' })).toBe('');
    expect(existsSync(sentinel('sess-1'))).toBe(false);
    expect(JSON.parse(stop('sess-1')).decision).toBe('block');
  });

  test('a running or pending delegated task defers the ask without claiming the sentinel', () => {
    for (const task of [
      { type: 'subagent', status: 'running' },
      { type: 'workflow', status: 'pending' },
    ]) {
      expect(stop('sess-1', { background_tasks: [task] })).toBe('');
      expect(existsSync(sentinel('sess-1'))).toBe(false);
    }
    expect(JSON.parse(stop('sess-1')).decision).toBe('block'); // the later stop gets it
  });

  test('a shell task, or a finished subagent, does not defer the ask', () => {
    expect(JSON.parse(stop('sess-1', { background_tasks: [{ type: 'shell', status: 'running' }] })).decision).toBe('block');
    expect(JSON.parse(stop('sess-2', { background_tasks: [{ type: 'subagent', status: 'completed' }] })).decision).toBe('block');
  });

  test('fails open when the nb-ideas command is missing: no block, sentinel released, a later stop still asks', () => {
    expect(stop('sess-1', {}) !== '').toBe(true);
    rmSync(sentinel('sess-1'));
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { NB_IDEAS_BIN: join(tmp, 'missing') })).toBe('');
    expect(existsSync(sentinel('sess-1'))).toBe(false);
    expect(JSON.parse(stop('sess-1')).decision).toBe('block');
  });

  test('fails open when the prompt command exits non-zero (here: no project can be found)', () => {
    // tmp is not a git repository and NB_IDEAS_PROJECT is blanked, so `nb-ideas prompt` exits 2.
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { NB_IDEAS_PROJECT: '' })).toBe('');
    expect(existsSync(sentinel('sess-1'))).toBe(false);
  });

  test('stays silent when `nb enabled` says off, and keeps the sentinel', () => {
    const off = join(tmp, 'nb-off');
    writeFileSync(off, '#!/bin/sh\necho off\n', { mode: 0o755 });
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'Stop' }, { NB_BIN: off })).toBe('');
    expect(existsSync(sentinel('sess-1'))).toBe(true);
  });

  test('a session id cannot escape the sentinel directory', () => {
    expect(JSON.parse(stop('../../evil')).decision).toBe('block');
    expect(existsSync(join(ideasDir, '.ideas-prompt-.._.._evil'))).toBe(true);
    expect(existsSync(join(tmp, 'evil'))).toBe(false);
  });

  test('prunes old .ideas-prompt-* sentinels only; fresh ones and other files stay', () => {
    mkdirSync(ideasDir, { recursive: true });
    const old = sentinel('old');
    const fresh = sentinel('fresh');
    const retro = join(ideasDir, '.retro-old');
    for (const p of [old, fresh, retro]) writeFileSync(p, 'x');
    const when = (Date.now() - 10 * DAY_MS) / 1000;
    utimesSync(old, when, when);
    utimesSync(retro, when, when);
    expect(JSON.parse(stop('sess-1')).decision).toBe('block');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(retro)).toBe(true);
    // NB_RETRO_TTL_DAYS moves the cutoff.
    const mid = sentinel('mid');
    writeFileSync(mid, 'x');
    const threeDays = (Date.now() - 3 * DAY_MS) / 1000;
    utimesSync(mid, threeDays, threeDays);
    stop('sess-2', {});
    expect(existsSync(mid)).toBe(true);
    runHook({ session_id: 'sess-3', hook_event_name: 'Stop' }, { NB_RETRO_TTL_DAYS: '1' });
    expect(existsSync(mid)).toBe(false);
  });
});
