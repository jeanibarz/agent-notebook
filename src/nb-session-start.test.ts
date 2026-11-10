import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Issue #303: the hook must distinguish a failing `nb list` from an empty one.
const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, '..', 'examples', 'hooks', 'claude-code', 'nb-session-start.sh');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-session-start-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(stubBody: string): string {
  const stub = join(dir, 'nb-stub');
  writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  return execFileSync('bash', [hook], {
    env: { ...process.env, NB_BIN: stub },
    encoding: 'utf-8',
  });
}

describe('nb-session-start.sh', () => {
  test('empty successful list → empty-store note only', () => {
    const out = run('exit 0');
    expect(out).toContain('no notebooks yet');
    expect(out).not.toContain('WARNING');
  });

  test('failing list → distinct error note, not the empty note', () => {
    const out = run('echo boom >&2; exit 3');
    expect(out).toContain('WARNING');
    expect(out).toContain('exit 3');
    expect(out).not.toContain('no notebooks yet');
  });

  test('rows → indented rows, no notes', () => {
    const out = run('printf "alpha  3  when a\\nbeta  1  when b\\n"');
    expect(out).toContain('  alpha  3  when a\n  beta  1  when b');
    expect(out).not.toContain('no notebooks yet');
    expect(out).not.toContain('WARNING');
  });

  test('missing nb → fail-open, no output', () => {
    const out = execFileSync('bash', [hook], {
      env: { ...process.env, NB_BIN: join(dir, 'does-not-exist') },
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });
});
