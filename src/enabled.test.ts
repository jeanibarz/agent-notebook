import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { describeSource, parseEnabledEnv, resolveEnabled, type GitRun } from './enabled.js';

// Issue #514: a per-repository on/off switch for the agent-facing loop.
// NB_ENABLED first, then `git config nb.enabled` in the working directory, then on.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const HOOKS = join(here, '..', 'examples', 'hooks', 'claude-code');

let tmp: string;
let globalCfg: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nb-enabled-'));
  globalCfg = join(tmp, 'global.gitconfig');
  writeFileSync(globalCfg, '');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Env for a child: an empty global git config of our own, a private NB_DIR, nothing else NB_*. */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1', NB_DIR: join(tmp, 'store') };
  for (const k of Object.keys(env)) if (k.startsWith('NB_') && k !== 'NB_DIR') delete env[k];
  delete env.CLAUDE_PROJECT_DIR;
  return { ...env, ...extra };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: childEnv(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(name: string): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q');
  return d;
}

function nb(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: childEnv(extra), encoding: 'utf-8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const gitRun = (status: number, stdout = '', stderr = ''): (() => GitRun) => () => ({ status, stdout, stderr });

describe('NB_ENABLED and git config nb.enabled resolve the on/off state (issue #514)', () => {
  test('NB_ENABLED: off words turn it off, any other non-blank value on, blank or unset defers', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', ' False ']) expect(parseEnabledEnv(v), v).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on', 'anything']) expect(parseEnabledEnv(v), v).toBe(true);
    for (const v of [undefined, '', '   ']) expect(parseEnabledEnv(v), String(v)).toBeUndefined();
  });

  test('NB_ENABLED decides before git is consulted', () => {
    let called = false;
    const run = () => {
      called = true;
      return { status: 0, stdout: 'local\tfile:.git/config\ttrue\n', stderr: '' };
    };
    const st = resolveEnabled({ NB_ENABLED: 'off' }, '/x', run);
    expect(st).toMatchObject({ enabled: false, source: 'env', value: 'off' });
    expect(called).toBe(false);
  });

  test('a blank NB_ENABLED defers to git config', () => {
    const st = resolveEnabled({ NB_ENABLED: ' ' }, '/x', gitRun(0, 'global\tfile:/h/.gitconfig\tfalse\n'));
    expect(st).toMatchObject({ enabled: false, source: 'git', value: 'false', origin: 'global file:/h/.gitconfig' });
  });

  test('git config true/false decides; an unset key (exit 1) is the default, on', () => {
    expect(resolveEnabled({}, '/x', gitRun(0, 'local\tfile:.git/config\ttrue\n'))).toMatchObject({ enabled: true, source: 'git' });
    expect(resolveEnabled({}, '/x', gitRun(0, 'local\tfile:.git/config\tfalse\n'))).toMatchObject({ enabled: false, source: 'git' });
    expect(resolveEnabled({}, '/x', gitRun(1))).toEqual({ enabled: true, source: 'default', value: null, origin: null, warning: null });
  });

  test('fails open: an invalid value, a git error or a missing git resolve to on with a warning', () => {
    const bad = resolveEnabled({}, '/x', gitRun(128, '', "fatal: bad boolean config value 'maybe' for 'nb.enabled'\n"));
    expect(bad).toMatchObject({ enabled: true, source: 'default' });
    expect(bad.warning).toContain("bad boolean config value 'maybe'");
    const odd = resolveEnabled({}, '/x', gitRun(0, 'local\tfile:.git/config\tmaybe\n'));
    expect(odd).toMatchObject({ enabled: true, source: 'default' });
    expect(odd.warning).not.toBeNull();
    const missing = resolveEnabled({}, '/x', () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }));
    expect(missing).toMatchObject({ enabled: true, source: 'default', warning: 'git not found; only NB_ENABLED applies' });
  });

  test('describeSource names the deciding input', () => {
    expect(describeSource(resolveEnabled({ NB_ENABLED: '0' }, '/x', gitRun(1)))).toBe('env NB_ENABLED=0');
    expect(describeSource(resolveEnabled({}, '/x', gitRun(0, 'local\tfile:.git/config\tfalse\n')))).toBe(
      'git config nb.enabled=false, local file:.git/config',
    );
    expect(describeSource(resolveEnabled({}, '/x', gitRun(1)))).toBe('default: neither NB_ENABLED nor git config nb.enabled is set');
  });

  test('nb enabled prints exactly `on` by default and `off` under a repository setting', () => {
    const r = repo('r');
    expect(nb(r, ['enabled'])).toEqual({ code: 0, out: 'on\n', err: '' });
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['enabled'])).toEqual({ code: 0, out: 'off\n', err: '' });
    // From a subdirectory too.
    mkdirSync(join(r, 'sub'));
    expect(nb(join(r, 'sub'), ['enabled']).out).toBe('off\n');
  });

  test('NB_ENABLED wins over git config in both directions', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['enabled'], { NB_ENABLED: '1' }).out).toBe('on\n');
    git(r, 'config', 'nb.enabled', 'true');
    expect(nb(r, ['enabled'], { NB_ENABLED: 'no' }).out).toBe('off\n');
    expect(nb(r, ['enabled'], { NB_ENABLED: '' }).out).toBe('on\n');
  });

  test('the repository setting beats --global, and a fresh worktree inherits it', () => {
    git(tmp, 'config', '--file', globalCfg, 'nb.enabled', 'false');
    const r = repo('r');
    const outside = join(tmp, 'plain-dir');
    mkdirSync(outside);
    expect(nb(outside, ['enabled']).out).toBe('off\n'); // global applies outside any repository
    expect(nb(r, ['enabled']).out).toBe('off\n');
    git(r, 'config', 'nb.enabled', 'yes');
    expect(nb(r, ['enabled']).out).toBe('on\n');
    git(r, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'root');
    git(r, 'worktree', 'add', '-q', join(tmp, 'wt'));
    expect(nb(join(tmp, 'wt'), ['enabled']).out).toBe('on\n');
  });

  test('includeIf turns off every repository under a folder', () => {
    const inc = join(tmp, 'nb-off.inc');
    writeFileSync(inc, '[nb]\n\tenabled = false\n');
    writeFileSync(globalCfg, `[includeIf "gitdir:${join(tmp, 'clients')}/"]\n\tpath = ${inc}\n`);
    expect(nb(repo('clients/acme'), ['enabled']).out).toBe('off\n');
    expect(nb(repo('mine'), ['enabled']).out).toBe('on\n');
  });

  test('an invalid value stays on, warns on stderr, and --why says why', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'maybe');
    const plain = nb(r, ['enabled']);
    expect(plain.out).toBe('on\n');
    expect(plain.code).toBe(0);
    expect(plain.err).toMatch(/^nb enabled: warning: git config nb\.enabled ignored: .*maybe/);
    expect(nb(r, ['enabled', '--why']).out).toMatch(/^on \(default; git config nb\.enabled ignored: .*maybe.*\)\n$/);
  });

  test('without git on PATH it stays on (NB_ENABLED still applies)', () => {
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['enabled', '--why'], { PATH: bin }).out).toBe('on (default; git not found; only NB_ENABLED applies)\n');
    expect(nb(r, ['enabled'], { PATH: bin, NB_ENABLED: 'off' }).out).toBe('off\n');
  });

  test('--why and --json name the deciding input', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['enabled', '--why']).out).toBe('off (git config nb.enabled=false, local file:.git/config)\n');
    expect(nb(r, ['enabled', '--why'], { NB_ENABLED: 'on' }).out).toBe('on (env NB_ENABLED=on)\n');
    expect(JSON.parse(nb(r, ['enabled', '--json']).out)).toEqual({
      enabled: false,
      state: 'off',
      source: 'git',
      value: 'false',
      origin: 'local file:.git/config',
      warning: null,
    });
  });

  test('an unknown flag is refused, as for every command', () => {
    const r = nb(tmp, ['enabled', '--whyy']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });
});

describe('nb config reports the on/off state (issue #514)', () => {
  test('the text ends its known sections with an enabled= line naming the source', () => {
    const r = repo('r');
    expect(nb(r, ['config']).out).toMatch(/\n\nenabled=on {2}\(default: neither NB_ENABLED nor git config nb\.enabled is set\)\n$/);
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['config']).out).toMatch(/\nenabled=off {2}\(git config nb\.enabled=false, local file:\.git\/config\)\n$/);
  });

  test('--json carries an additive `enabled` object', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'false');
    const j = JSON.parse(nb(r, ['config', '--json']).out);
    expect(j.enabled).toEqual({ value: 'off', source: 'git', origin: 'local file:.git/config', warning: null });
    expect(j.maxLines.value).toBe(50);
  });

  test('NB_ENABLED is a recognised variable, never listed as not read by nb', () => {
    const out = nb(tmp, ['config'], { NB_ENABLED: '0' }).out;
    expect(out).toContain('enabled=off  (env NB_ENABLED=0)');
    expect(out).not.toContain('not read by nb');
    expect(JSON.parse(nb(tmp, ['config', '--json'], { NB_ENABLED: '0' }).out).unrecognized).toEqual([]);
  });

  test('an invalid git value is visible in nb config', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'maybe');
    expect(nb(r, ['config']).out).toMatch(/enabled=on {2}\(default; git config nb\.enabled ignored: .*maybe/);
  });
});

/** A stub `nb` for the hooks: answers `enabled` with `state` and logs every call. */
function stubNb(state: string, enabledExit = 0): { bin: string; log: string } {
  const bin = join(tmp, 'nb-stub');
  const log = join(tmp, 'nb-calls.log');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\necho "$PWD $*" >> '${log}'\nif [ "$1" = enabled ]; then printf '%s' '${state}'; exit ${enabledExit}; fi\necho "  some-shelf  3  when testing"\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

function sessionStart(env: Record<string, string>, cwd = tmp): string {
  return execFileSync('bash', [join(HOOKS, 'nb-session-start.sh')], { cwd, env: childEnv(env), encoding: 'utf-8' });
}

function stopHook(env: Record<string, string>, session = 's1', cwd = tmp): string {
  mkdirSync(join(tmp, 'store'), { recursive: true });
  return execFileSync('bash', [join(HOOKS, 'nb-retrospective.sh')], {
    cwd,
    env: childEnv(env),
    input: JSON.stringify({ session_id: session, stop_hook_active: false }),
    encoding: 'utf-8',
  });
}

const callLog = (log: string) => (existsSync(log) ? execFileSync('cat', [log], { encoding: 'utf-8' }) : '');

describe('the example hooks honour nb enabled (issue #514)', () => {
  test('session start: `off` prints the one skip line and never lists the index', () => {
    const { bin, log } = stubNb('off\n');
    const out = sessionStart({ NB_BIN: bin });
    expect(out).toBe(
      'agent-notebook is switched off for this repository: skip the notebook steps (no `nb list`, no end-of-task retrospective). `nb enabled --why` shows which setting decided.\n',
    );
    expect(callLog(log)).not.toContain(' list');
  });

  test('session start: `on`, or an old nb without the subcommand (exit 2, no stdout), shows the index', () => {
    for (const [state, code] of [['on\n', 0], ['', 2]] as const) {
      const { bin } = stubNb(state, code);
      const out = sessionStart({ NB_BIN: bin });
      expect(out, `state=${JSON.stringify(state)}`).toContain('some-shelf');
      expect(out).not.toContain('switched off');
    }
  });

  test('session start: asks from CLAUDE_PROJECT_DIR when set', () => {
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    const { bin, log } = stubNb('on\n');
    sessionStart({ NB_BIN: bin, CLAUDE_PROJECT_DIR: proj });
    expect(callLog(log)).toContain(`${proj} enabled`);
  });

  test('stop: `off` lets the stop through silently, and later stops do not ask again', () => {
    const { bin, log } = stubNb('off\n');
    expect(stopHook({ NB_BIN: bin })).toBe('');
    expect(stopHook({ NB_BIN: bin })).toBe('');
    expect(callLog(log).match(/ enabled/g)).toHaveLength(1);
  });

  test('stop: `on`, an old nb, or a missing nb still nudges once', () => {
    for (const [i, [state, code]] of ([['on\n', 0], ['', 2]] as const).entries()) {
      const { bin } = stubNb(state, code);
      expect(JSON.parse(stopHook({ NB_BIN: bin }, `on-${i}`)).decision).toBe('block');
    }
    expect(JSON.parse(stopHook({ NB_BIN: join(tmp, 'missing-nb') }, 'missing')).decision).toBe('block');
  });

  test('stop: asks from CLAUDE_PROJECT_DIR when set', () => {
    const proj = join(tmp, 'proj');
    mkdirSync(proj);
    const { bin, log } = stubNb('off\n');
    expect(stopHook({ NB_BIN: bin, CLAUDE_PROJECT_DIR: proj })).toBe('');
    expect(callLog(log)).toContain(`${proj} enabled`);
  });
});

describe('the README recipe: off everywhere except one repository (issue #514)', () => {
  test('global false + pilot true: the real hooks are on in the pilot only', () => {
    // A wrapper so the hooks run the built CLI as `$NB_BIN`.
    const bin = join(tmp, 'nb');
    writeFileSync(bin, `#!/usr/bin/env bash\nexec '${process.execPath}' '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    const pilot = repo('git/my-pilot');
    const other = repo('git/another-repo');
    git(tmp, 'config', '--file', globalCfg, 'nb.enabled', 'false');
    git(pilot, 'config', 'nb.enabled', 'true');

    const env = { NB_BIN: bin };
    expect(nb(pilot, ['enabled']).out).toBe('on\n');
    expect(nb(other, ['enabled', '--why']).out).toBe(`off (git config nb.enabled=false, global file:${globalCfg})\n`);

    expect(sessionStart(env, pilot)).toContain('## Your agent-notebook index');
    expect(sessionStart(env, other)).toContain('switched off for this repository');
    expect(JSON.parse(stopHook(env, 'pilot', pilot)).decision).toBe('block');
    expect(stopHook(env, 'other', other)).toBe('');
    // The env var beats git config: exporting NB_ENABLED=0 would switch the pilot off too.
    expect(nb(pilot, ['enabled'], { NB_ENABLED: '0' }).out).toBe('off\n');
    // Only the retro sentinels landed in the store; the switch wrote no notebook.
    expect(readdirSync(join(tmp, 'store')).filter((f) => !f.startsWith('.'))).toEqual([]);
  });
});
