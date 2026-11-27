import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNbCli } from './cli.js';

// The README's opening example and the Codex CLI AGENTS.md snippet are copies of
// what `nb` prints and of the end-of-task steps in AGENTS.md. They drift when the
// CLI changes (issue #591: the new-shelf note grew a `nb describe` request in #590
// and neither copy followed). These tests tie each copy to its source.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf-8');

async function run(argv: string[]): Promise<string> {
  let text = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s: string) => ((text += s), true);
  process.stderr.write = (s: string) => ((text += s), true);
  try {
    await runNbCli(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return text;
}

describe('README opening example', () => {
  let dir: string;
  const saved = process.env.NB_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nb-readme-'));
    process.env.NB_DIR = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NB_DIR;
    else process.env.NB_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test('the `nb add` transcript matches what a fresh notebook prints', async () => {
    const cmd = 'nb add build-and-test "run lint before claiming done"';
    const readme = read('README.md');
    const at = readme.indexOf(`$ ${cmd}\n`);
    expect(at).toBeGreaterThan(-1);
    const shown = readme.slice(at + cmd.length + 3).split('\n\n')[0] + '\n';
    const printed = await run(['add', 'build-and-test', 'run lint before claiming done']);
    expect(shown).toBe(printed);
    expect(shown).toContain('nb describe build-and-test');
  });
});

describe('Codex CLI AGENTS.md snippet', () => {
  test('its end-of-task steps ask for a description on a new shelf, as AGENTS.md does', () => {
    expect(read('AGENTS.md')).toMatch(/If you start a new shelf, give it a description with `nb describe`/);
    const snippet = read('examples/hooks/codex-cli/AGENTS.snippet.md');
    expect(snippet).toMatch(/If you start a new shelf, give it a description with `nb describe/);
  });
});
