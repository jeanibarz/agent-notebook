import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Issue #595: scripts/plugin-e2e/hookrep.mjs reads the stream-json log of a `claude -p` session and
// checks what the plugin's SessionStart hooks did. These tests feed it hand-built streams shaped like
// the ones Claude Code 2.1.332 writes: a `hook_progress` event that is an early copy of a hook's output
// is not a second notice, any other event that holds the notice is, and a miss lists every such event.
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'plugin-e2e', 'hookrep.mjs');
const NOTICE = 'agent-notebook: the notebook needs Node.js 18 or later (test notice).';
const INDEX = '## Your agent-notebook index';

let dir: string;
let entry: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-hookrep-'));
  entry = join(dir, 'nb-hook-entry.cjs');
  writeFileSync(entry, `'use strict';\nvar NOTICE = '${NOTICE}';\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Ev = Record<string, unknown>;
const init: Ev = { type: 'system', subtype: 'init', plugins: [{ name: 'agent-notebook', version: '0.0.1-e2e.1', path: 'C:\\h\\0.0.1-e2e.1' }] };
const started = (id: string): Ev => ({ type: 'system', subtype: 'hook_started', hook_id: id, hook_name: 'SessionStart:startup', hook_event: 'SessionStart' });
const progress = (id: string, stdout: string): Ev => ({ type: 'system', subtype: 'hook_progress', hook_id: id, hook_name: 'SessionStart:startup', hook_event: 'SessionStart', stdout, stderr: '', output: stdout });
const response = (id: string, exit: number, stdout: string, stderr = ''): Ev => ({
  type: 'system', subtype: 'hook_response', hook_id: id, hook_name: 'SessionStart:startup', hook_event: 'SessionStart',
  output: stdout + stderr, stdout, stderr, exit_code: exit, outcome: exit === 0 ? 'success' : 'error',
});
const notFound = (id: string, exe: string): Ev => response(id, 1, '', `Executable not found in $PATH: "${exe}"`);
const result: Ev = { type: 'result', subtype: 'error_during_execution', is_error: true };

// Windows, no node on PATH: node and sh cannot start, the PowerShell twin prints the notice.
const winNoNode = (extra: Ev[] = []): Ev[] => [
  started('node'), started('sh'), started('ps'),
  ...extra,
  notFound('node', 'node'), notFound('sh', 'sh'), response('ps', 0, `${NOTICE}\r\n`),
  init, result,
];
// Windows, Node.js 22: the entry prints the index, sh cannot start, the twin is silent.
const winNewNode = (extra: Ev[] = []): Ev[] => [
  response('node', 0, `${INDEX}\nshelves\n`), notFound('sh', 'sh'), response('ps', 0, ''),
  init, ...extra, result,
];

function run(events: Ev[], expectMode: string): { code: number | null; out: string } {
  const file = join(dir, `stream-${Math.random().toString(36).slice(2)}.jsonl`);
  // CRLF and a BOM, as PowerShell 5.1 writes the log on Windows.
  writeFileSync(file, '\ufeff' + events.map((e) => JSON.stringify(e)).join('\r\n') + '\r\n');
  const r = spawnSync(process.execPath, [script, file, '--expect', expectMode, '--os', 'windows', '--entry', entry], { encoding: 'utf-8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('hookrep.mjs counts the notice once per hook (issue #595)', () => {
  test('nonode passes when the twin printed the notice once', () => {
    const r = run(winNoNode(), 'nonode');
    expect(r.out).toContain('ok: nonode');
    expect(r.code).toBe(0);
  });

  test('a hook_progress event that is an early copy of the twin\'s output is printed and not counted', () => {
    const r = run(winNoNode([progress('ps', `${NOTICE}\r\n`)]), 'nonode');
    expect(r.out).toContain('ok: nonode');
    expect(r.code).toBe(0);
    expect(r.out).toContain("hook SessionStart progress (an early copy of its hook's output) | stdout: agent-notebook: the notebook needs");
  });

  test('a hook_progress event of another hook is counted, and the failure names both events', () => {
    const r = run(winNoNode([progress('sh', `${NOTICE}\r\n`)]), 'nonode');
    expect(r.code).toBe(1);
    expect(r.out).toContain('hook SessionStart progress (matches no hook response)');
    expect(r.out).toContain('FAIL: 2 event(s) hold the notice and 1 hook(s) printed it as a line, expected exactly one of each');
    expect(r.out).toMatch(/^ {2}event system\/hook_progress SessionStart hook sh, in \[stdout,output\]: .*agent-notebook: the notebook needs/m);
    expect(r.out).toMatch(/^ {2}event system\/hook_response SessionStart hook ps, in \[output,stdout\]: .*agent-notebook: the notebook needs/m);
  });

  test('a progress event whose output is not the start of its hook\'s response is counted', () => {
    const r = run(winNoNode([progress('ps', `${NOTICE}\r\n${NOTICE}\r\n`)]), 'nonode');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: 2 event(s) hold the notice');
  });

  test('the notice in another kind of event fails and the failure names its type, subtype and a clip', () => {
    const r = run(winNoNode([{ type: 'system', subtype: 'hook_additional_context', content: [`Context: ${NOTICE}`] }]), 'nonode');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: 2 event(s) hold the notice and 1 hook(s) printed it as a line, expected exactly one of each');
    // The clip starts just before the notice, so it shows where the notice sits in the event.
    expect(r.out).toMatch(/^ {2}event system\/hook_additional_context, in \[content\]: .*"content":\["Context: agent-notebook: the notebook needs/m);
    expect(r.out).toMatch(/^ {2}event system\/hook_response SessionStart hook ps, in \[output,stdout\]: /m);
  });

  test('a notice in a session with Node.js 22 fails and lists the event that holds it, even an event with no subtype', () => {
    expect(run(winNewNode(), 'newnode').code).toBe(0);
    const r = run(winNewNode([{ type: 'assistant', message: { content: [{ type: 'text', text: NOTICE }] } }]), 'newnode');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL: a Node.js notice appeared in a session that has Node.js 22 or later');
    expect(r.out).toMatch(/^ {2}event assistant\/no subtype, in \[message\]: /m);
  });
});
