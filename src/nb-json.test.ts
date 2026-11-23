import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNbCli } from './cli.js';
import { maxChars } from './notebook.js';

// RFC 0530 slice 1: `<notebooks folder>/.nb.json` may set `maxChars`. The folder
// wins over NB_MAX_CHARS, a bad file warns on stderr and never blocks, and the
// override is call-scoped (never process.env, never left set after a call).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');
const WRAPPER = join(ROOT, 'examples', 'nb-git-wrapper.mjs');
const LONG = 'x'.repeat(300);

const SAVED = { ...process.env };
let dir: string;
const extra: string[] = [];

beforeEach(() => {
  delete process.env.NB_MAX_CHARS;
  dir = mkdtempSync(join(tmpdir(), 'nb-json-'));
  extra.length = 0;
});
afterEach(() => {
  for (const k of ['NB_MAX_CHARS', 'NB_DIR']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
  for (const d of extra) rmSync(d, { recursive: true, force: true });
});

function nb(args: string[], env: NodeJS.ProcessEnv = {}, d = dir): { status: number; out: string; err: string } {
  const e: NodeJS.ProcessEnv = { ...process.env, NB_DIR: d, NB_SESSION: '', ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync('node', [CLI, ...args], { env: e, encoding: 'utf-8', timeout: 20000 });
  return { status: r.status ?? 1, out: r.stdout ?? '', err: (r.stderr ?? '').split('\n').filter((l) => !l.startsWith('note: created new shelf')).join('\n') };
}
const settings = (body: string, d = dir) => writeFileSync(join(d, '.nb.json'), body);
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'nb-json-b-'));
  extra.push(d);
  return d;
};

describe('.nb.json maxChars (RFC 0530)', () => {
  test('nb.json maxChars 400 accepts a 300-char add; the folder wins over NB_MAX_CHARS=200; no file refuses as today', () => {
    expect(nb(['add', 's', LONG]).status).toBe(1); // no file: refused as today
    settings('{ "maxChars": 400 }');
    const r = nb(['add', 's', LONG]);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    const d2 = tmp();
    settings('{ "maxChars": 400 }', d2);
    expect(nb(['add', 's', LONG], { NB_MAX_CHARS: '200' }, d2).status).toBe(0); // folder wins
    const d3 = tmp();
    expect(nb(['add', 's', LONG], { NB_MAX_CHARS: '200' }, d3).status).toBe(1); // env alone still refuses
    expect(nb(['add', 's', LONG], { NB_MAX_CHARS: '400' }, d3).status).toBe(0); // and env alone still works
  });

  test('nb.json out-of-range maxChars clamps to 20-2000 like the env value', () => {
    settings('{ "maxChars": 5000 }');
    const big = nb(['config', '--json']);
    expect(JSON.parse(big.out).maxChars).toMatchObject({ value: 2000, source: '.nb.json', status: 'clamped', rawValue: '5000' });
    settings('{ "maxChars": 5 }');
    expect(JSON.parse(nb(['config', '--json']).out).maxChars.value).toBe(20);
    expect(nb(['add', 's', 'y'.repeat(21)]).status).toBe(1); // 21 > the clamped 20
    expect(nb(['add', 's', 'y'.repeat(20)]).status).toBe(0);
  });

  test('nb.json invalid JSON, a non-object and an unknown key warn once on stderr and the command continues', () => {
    const path = join(dir, '.nb.json');
    settings('{ not json');
    let r = nb(['add', 's', 'short one']);
    expect(r.status).toBe(0);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toMatch(new RegExp(`^warning: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: invalid JSON .*; ignored\\n$`));
    expect(nb(['add', 's', LONG]).status).toBe(1); // default 200 in force

    for (const body of ['[400]', '400', 'null']) {
      settings(body);
      r = nb(['add', 's', 'short two']);
      expect(r.status).toBe(0);
      expect(r.err).toBe(`warning: ${path}: not a JSON object; ignored\n`);
    }

    settings('{ "maxChars": 400, "maxLines": 9, "kind": "x" }');
    r = nb(['add', 's', LONG]);
    expect(r.status).toBe(0); // the valid key is kept
    expect(r.err).toBe(`warning: ${path}: unknown keys "maxLines", "kind"; ignored\n`);

    settings('{ "maxChars": "400" }');
    r = nb(['add', 's', LONG]);
    expect(r.status).toBe(1); // a non-integer is dropped: default in force
    expect(r.err).toContain('maxChars is not an integer; ignored');

    settings('{ "maxChars": 400.5 }');
    r = nb(['add', 's', LONG]);
    expect(r.status).toBe(1); // a fractional number is not an integer either
    expect(r.err).toContain('maxChars is not an integer; ignored');
    expect(nb(['config']).out).toMatch(/^maxChars=200 +\(default\)$/m);

    settings('x\x1b]0;title\x07\x1b[2J');
    r = nb(['add', 's', 'short four']);
    expect(r.status).toBe(0);
    expect(r.err).toContain('invalid JSON');
    expect(r.err).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/); // no escape codes reach the terminal
  });

  test('nb.json that is unreadable (a directory) warns and continues; a missing file is silent', () => {
    mkdirSync(join(dir, '.nb.json'));
    const r = nb(['add', 's', 'short three']);
    expect(r.status).toBe(0);
    expect(r.err).toMatch(/^warning: .*\.nb\.json: unreadable \(EISDIR\); ignored\n$/);
    const d2 = tmp();
    expect(nb(['add', 's', 'short three'], {}, d2).err).toBe('');
  });

  test('nb.json with a UTF-8 byte-order mark applies; an integer too large to be exact clamps to 2000', () => {
    settings('\uFEFF{ "maxChars": 400 }'); // as Windows PowerShell 5 writes it
    const r = nb(['add', 's', LONG]);
    expect(r.status).toBe(0);
    expect(r.err).toBe('');
    settings('{ "maxChars": 1e30 }');
    const big = nb(['config']);
    expect(big.err).toBe('');
    expect(big.out).toMatch(/^maxChars=2000 +\(\.nb\.json: clamped to 2000 from \d+\)$/m);
    settings('{ "maxChars": -1e30 }');
    expect(nb(['config']).out).toMatch(/^maxChars=20 +\(\.nb\.json: clamped to 20 from -\d+\)$/m);
  });

  test('nb.json invalid-JSON warning keeps printable non-ASCII text and replaces CR, C1 and bidi controls', () => {
    settings('é');
    let r = nb(['add', 's', 'short six']);
    expect(r.status).toBe(0);
    expect(r.err).toContain('invalid JSON');
    expect(r.err).toContain('é');
    settings('x\r\u009b2J\u202e');
    r = nb(['add', 's', 'short seven']);
    expect(r.status).toBe(0);
    expect(r.err).toContain('invalid JSON');
    expect(r.err.trimEnd()).not.toMatch(/[\r\u009b\u202e]/);
  });

  test('nb.json is not looked for when NB_DIR is a file: no settings warning, only the command\'s own error', () => {
    const file = join(tmp(), 'not-a-folder');
    writeFileSync(file, 'x');
    const r = nb(['add', 's', 'short eight'], {}, file);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^nb add: /);
    expect(r.err).not.toContain('.nb.json');
  });

  test('nb.json override does not leak: a later in-process call on a folder without it refuses, and process.env is untouched', async () => {
    const a = dir;
    const b = tmp();
    settings('{ "maxChars": 400 }', a);
    const run = async (argv: string[], d: string): Promise<number> => {
      process.env.NB_DIR = d;
      const w = process.stdout.write.bind(process.stdout);
      const we = process.stderr.write.bind(process.stderr);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        return await runNbCli(argv);
      } finally {
        process.stdout.write = w;
        process.stderr.write = we;
      }
    };
    expect(await run(['add', 's', LONG], a)).toBe(0);
    expect(process.env.NB_MAX_CHARS).toBeUndefined();
    expect(maxChars()).toBe(200); // a library caller after the call sees no leftover override
    expect(await run(['add', 's', LONG], b)).toBe(1);
    process.env.NB_MAX_CHARS = '300';
    expect(await run(['add', 's', LONG], b)).toBe(0); // the env, not a stale override, decides
    expect(process.env.NB_MAX_CHARS).toBe('300');
  });

  test('nb.json override is cleared when a command throws', async () => {
    const b = tmp();
    settings('{ "maxChars": 400 }');
    const quiet = async (argv: string[], d: string): Promise<number> => {
      process.env.NB_DIR = d;
      const w = process.stdout.write.bind(process.stdout);
      const we = process.stderr.write.bind(process.stderr);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        return await runNbCli(argv);
      } finally {
        process.stdout.write = w;
        process.stderr.write = we;
      }
    };
    expect(await quiet(['add', 's', 'a'.repeat(500)], dir)).toBe(1); // refused over 400: the error path
    expect(maxChars()).toBe(200);
    expect(await quiet(['add'], dir)).toBe(1); // bad arguments: the catch path
    expect(maxChars()).toBe(200);
    expect(await quiet(['add', 's', LONG], b)).toBe(1); // the next folder is back to 200
  });

  test('nb.json maxChars applies through the git wrapper, which calls runNbCli in-process', () => {
    settings('{ "maxChars": 400 }');
    const r = spawnSync('node', [WRAPPER, 'add', 's', LONG], {
      env: { ...process.env, NB_DIR: dir, NB_GIT_AUTOCOMMIT: '0', NB_MAX_CHARS: '200', NB_SESSION: '' },
      encoding: 'utf-8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 's.md'), 'utf-8')).toContain(LONG);
  });

  test('nb.json maxChars also caps the git wrapper\'s Nb-Session trailer, equal to the usage log\'s session column', () => {
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, env: gitEnv, encoding: 'utf-8' });
    const gitEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(gitEnv)) if (k.startsWith('GIT_') && !k.startsWith('GIT_CONFIG')) delete gitEnv[k];
    if (git('--version').status !== 0) return;
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    settings('{ "maxChars": 20 }');
    const session = 's'.repeat(30); // over the file's 20, under the default 200
    const r = spawnSync('node', [WRAPPER, 'add', 'demo', 'short nine'], {
      env: { ...gitEnv, NB_DIR: dir, NB_GIT_AUTOCOMMIT: '1', NB_GIT_SESSION_TRAILER: '1', NB_SESSION: session },
      encoding: 'utf-8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    const capped = 's'.repeat(19) + '…';
    expect(git('log', '-1', '--format=%B').stdout.trim().split('\n')).toEqual(['nb add demo', '', `Nb-Session: ${capped}`]);
    const log = readFileSync(join(dir, '.nb-usage.log'), 'utf-8');
    expect(log).toContain(capped);
    expect(log).not.toContain(session);
  });

  test('nb.json source shows in nb config, text and --json; no file leaves the render unchanged', () => {
    const clean = nb(['config']).out;
    expect(clean).toMatch(/^maxChars=200 +\(default\)$/m);
    settings('{ "maxChars": 400 }');
    const text = nb(['config']).out;
    expect(text).toMatch(/^maxChars=400 +\(\.nb\.json\)$/m);
    expect(text.replace(/^maxChars=.*$/m, '')).toBe(clean.replace(/^maxChars=.*$/m, ''));
    const j = JSON.parse(nb(['config', '--json']).out);
    expect(j.maxChars).toEqual({ value: 400, source: '.nb.json', env: 'NB_MAX_CHARS', status: 'honored', rawValue: '400' });
    expect(j.maxLines.source).toBe('default');
    settings('{ "maxChars": 5000 }');
    expect(nb(['config']).out).toMatch(/^maxChars=2000 +\(\.nb\.json: clamped to 2000 from 5000\)$/m);
  });

  test('nb.json folder: nb doctor reports no lesson-too-long for a 300-char line', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.md'), `0\t${LONG}\n`);
    const before = nb(['doctor']);
    expect(before.out).toContain('lesson-too-long');
    settings('{ "maxChars": 400 }');
    expect(nb(['doctor']).out).not.toContain('lesson-too-long');
  });
});
