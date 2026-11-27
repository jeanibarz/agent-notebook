import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

// Issue #560, FR-SETUP-004, FR-PLACE-005: many calls at once, through the built CLI. Spawn-heavy, so the tests carry [timing].
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');

let tmp: string;
let home: string;
let projects: string;
let shared: string;
let repo: string;

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') || k.startsWith('GIT_')) delete env[k];
  return { ...env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', NB_ASCII: '0', NB_ENABLED: '1', ...extra };
}
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb place default race ')));
  home = join(tmp, 'home');
  projects = join(home, '.agent-notebook', 'projects');
  shared = join(home, '.agent-notebook', 'notebooks');
  writeFileSync(join(tmp, 'gitconfig'), '');
  repo = join(tmp, 'app');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, env: childEnv() });
  execFileSync('git', ['config', 'remote.origin.url', 'git@github.com:acme/app.git'], { cwd: repo, env: childEnv() });
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  writeFileSync(join(projects, '.layout'), 'own\n');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: childEnv() });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });
}
const names = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
const noDebris = (): string[] => names(projects).filter((n) => /^\.(new|old)-|\.tmp$/.test(n));

describe('the answer applied by many starts at once (FR-SETUP-004)', { timeout: 120_000 }, () => {
  test('50 parallel nb brief in a new own project give exactly one folder, one .seen, no stranded shelf and no debris [timing]', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, () => run(['brief'])));
    expect(rs.map((r) => r.code)).toEqual(Array(50).fill(0));
    for (const r of rs) expect(r.out).toContain('## Your agent-notebook index');
    expect(names(projects)).toEqual(['.layout', '.seen-acme-app', 'acme-app']);
    expect(noDebris()).toEqual([]);
    expect(names(shared).filter((n) => n.endsWith('.md'))).toEqual([]);
    // The folder is whole: a later start finds it and leaves it alone.
    expect((await run(['brief'])).out).toContain('go to its own notebook');
    expect(names(projects)).toEqual(['.layout', '.seen-acme-app', 'acme-app']);
  });

  test('50 parallel starts while the project has shelves in the shared notebook move none and make no folder [timing]', async () => {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'build@acme-app.md'), '+1 a lesson\n');
    const rs = await Promise.all(Array.from({ length: 50 }, () => run(['brief'])));
    expect(rs.map((r) => r.code)).toEqual(Array(50).fill(0));
    expect(names(projects)).toEqual(['.layout']);
    expect(readFileSync(join(shared, 'build@acme-app.md'), 'utf-8')).toBe('+1 a lesson\n');
  });

  test('nb place default racing nb brief and nb place shared leaves one whole answer, no debris and no lost shelf [timing]', async () => {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'build@acme-app.md'), '+1 a lesson\n');
    const calls: string[][] = [];
    for (let i = 0; i < 6; i++) {
      calls.push(['place', 'default', i % 2 === 0 ? 'own' : 'ask'], ['brief'], ['brief'], ['place', 'shared'], ['place', 'own']);
    }
    const rs = await Promise.all(calls.map((a) => run(a)));
    for (const r of rs) expect([0, 1]).toContain(r.code);
    expect(['own', 'ask']).toContain(readFileSync(join(projects, '.layout'), 'utf-8').trim());
    expect(noDebris()).toEqual([]);
    // The lesson is in exactly one of the two notebooks, whole.
    const inShared = existsSync(join(shared, 'build@acme-app.md'));
    const inOwn = existsSync(join(projects, 'acme-app', 'build@acme-app.md'));
    expect(Number(inShared) + Number(inOwn)).toBe(1);
    expect(readFileSync(inShared ? join(shared, 'build@acme-app.md') : join(projects, 'acme-app', 'build@acme-app.md'), 'utf-8')).toBe('+1 a lesson\n');
  });
});
