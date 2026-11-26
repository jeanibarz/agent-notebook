import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync, symlinkSync, realpathSync, utimesSync } from 'node:fs';
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
  // realpath: on macOS tmpdir() is under the /var -> /private/var symlink, and git
  // matches an includeIf `gitdir:` pattern against the real path.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb-enabled-')));
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
      return { status: 0, stdout: 'file:.git/config\ttrue\n', stderr: '' };
    };
    const st = resolveEnabled({ NB_ENABLED: 'off' }, '/x', run);
    expect(st).toMatchObject({ enabled: false, source: 'env', value: 'off' });
    expect(called).toBe(false);
  });

  test('a blank NB_ENABLED defers to git config', () => {
    const st = resolveEnabled({ NB_ENABLED: ' ' }, '/x', gitRun(0, 'file:/h/.gitconfig\tfalse\n'));
    expect(st).toMatchObject({ enabled: false, source: 'git', value: 'false', origin: 'file:/h/.gitconfig' });
  });

  test('git config true/false decides; an unset key (exit 1) is the default, on', () => {
    expect(resolveEnabled({}, '/x', gitRun(0, 'file:.git/config\ttrue\n'))).toMatchObject({ enabled: true, source: 'git' });
    expect(resolveEnabled({}, '/x', gitRun(0, 'file:.git/config\tfalse\n'))).toMatchObject({ enabled: false, source: 'git' });
    expect(resolveEnabled({}, '/x', gitRun(1))).toEqual({ enabled: true, source: 'default', value: null, origin: null, warning: null });
  });

  test('fails open: an invalid value, a git error or a missing git resolve to on with a warning', () => {
    const bad = resolveEnabled({}, '/x', gitRun(128, '', "fatal: bad boolean config value 'maybe' for 'nb.enabled'\n"));
    expect(bad).toMatchObject({ enabled: true, source: 'default' });
    expect(bad.warning).toContain("bad boolean config value 'maybe'");
    const odd = resolveEnabled({}, '/x', gitRun(0, 'file:.git/config\tmaybe\n'));
    expect(odd).toMatchObject({ enabled: true, source: 'default' });
    expect(odd.warning).not.toBeNull();
    // A git too old for a flag exits 129: still on, and the warning says so.
    const old = resolveEnabled({}, '/x', gitRun(129, '', "error: unknown option `type=bool'\n"));
    expect(old).toMatchObject({ enabled: true, source: 'default', warning: "git config nb.enabled ignored: error: unknown option `type=bool'" });
    const missing = resolveEnabled({}, '/x', () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT' }));
    expect(missing).toMatchObject({ enabled: true, source: 'default', warning: 'git not found; only NB_ENABLED applies' });
  });

  test('describeSource names the deciding input', () => {
    expect(describeSource(resolveEnabled({ NB_ENABLED: '0' }, '/x', gitRun(1)))).toBe('env NB_ENABLED=0');
    expect(describeSource(resolveEnabled({}, '/x', gitRun(0, 'file:.git/config\tfalse\n')))).toBe(
      'git config nb.enabled=false, file:.git/config',
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
    expect(nb(r, ['enabled', '--why']).out).toBe('off (git config nb.enabled=false, file:.git/config)\n');
    expect(nb(r, ['enabled', '--why'], { NB_ENABLED: 'on' }).out).toBe('on (env NB_ENABLED=on)\n');
    expect(JSON.parse(nb(r, ['enabled', '--json']).out)).toEqual({
      enabled: false,
      state: 'off',
      source: 'git',
      value: 'false',
      origin: 'file:.git/config',
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
    expect(nb(r, ['config']).out).toMatch(/\nenabled=off {2}\(git config nb\.enabled=false, file:\.git\/config\)\n$/);
  });

  test('--json carries an additive `enabled` object', () => {
    const r = repo('r');
    git(r, 'config', 'nb.enabled', 'false');
    const j = JSON.parse(nb(r, ['config', '--json']).out);
    expect(j.enabled).toEqual({ value: 'off', source: 'git', origin: 'file:.git/config', warning: null });
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

/** A stub `nb` that exits `code` with no output, as an `nb` older than `nb brief` / `nb retro` does (2). */
function stubNb(code: number): string {
  const bin = join(tmp, 'nb-stub');
  writeFileSync(bin, `#!/usr/bin/env bash\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const OFF_LINE =
  'agent-notebook is switched off for this repository: skip the notebook steps (no `nb list`, no end-of-task retrospective). `nb enabled --why` shows which setting decided.\n';

function sessionStart(env: Record<string, string>, cwd = tmp): string {
  return execFileSync('bash', [join(HOOKS, 'nb-session-start.sh')], { cwd, env: childEnv(env), encoding: 'utf-8' });
}

function stopHook(env: Record<string, string>, session = 's1', cwd = tmp, payload: Record<string, unknown> = {}): string {
  mkdirSync(join(tmp, 'store'), { recursive: true });
  return execFileSync('bash', [join(HOOKS, 'nb-retrospective.sh')], {
    cwd,
    env: childEnv(env),
    input: JSON.stringify({ session_id: session, stop_hook_active: false, ...payload }),
    encoding: 'utf-8',
  });
}

// Since issue #538 the hooks run `nb brief` / `nb retro`, which read the switch
// themselves; these run the real CLI (the package the hooks ship in) in real
// git repositories.
describe('the example hooks honour nb enabled (issue #514)', () => {
  function offRepo(): string {
    const r = repo('off-repo');
    git(r, 'config', 'nb.enabled', 'false');
    return r;
  }

  test('session start: `off` prints the one skip line and never lists the index', () => {
    expect(sessionStart({}, offRepo())).toBe(OFF_LINE);
  });

  test('session start: `on` shows the index; an nb without `brief` or a missing nb gives one line naming the fix', () => {
    expect(sessionStart({}, repo('on-repo'))).toContain('## Your agent-notebook index');
    const old = sessionStart({ NB_BIN: stubNb(2) });
    expect(old).toMatch(/^agent-notebook: the session-start hook could not load the notebook index \(this nb is older than the hooks/);
    expect(old.trimEnd().split('\n')).toHaveLength(1);
    expect(sessionStart({ NB_BIN: join(tmp, 'missing-nb') })).toMatch(/^agent-notebook: .*nb could not run/);
    // Switched off in the environment, even that line is skipped.
    expect(sessionStart({ NB_BIN: join(tmp, 'missing-nb'), NB_ENABLED: '0' })).toBe('');
  });

  test('session start: asks from CLAUDE_PROJECT_DIR when set', () => {
    expect(sessionStart({ CLAUDE_PROJECT_DIR: offRepo() }, tmp)).toBe(OFF_LINE);
  });

  test('stop: `off` lets the stop through silently, and later stops do not ask again', () => {
    const off = offRepo();
    expect(stopHook({}, 's1', off)).toBe('');
    expect(existsSync(join(tmp, 'store', '.retro-s1'))).toBe(true);
    expect(stopHook({}, 's1', off)).toBe('');
  });

  test('stop: `on` nudges once; an nb without `retro` or a missing nb sends nothing', () => {
    expect(JSON.parse(stopHook({}, 'on', repo('on-repo'))).decision).toBe('block');
    expect(stopHook({ NB_BIN: stubNb(2) }, 'old')).toBe('');
    expect(stopHook({ NB_BIN: join(tmp, 'missing-nb') }, 'missing')).toBe('');
  });

  test('stop: when off, old sentinels are still pruned (issue #165)', () => {
    mkdirSync(join(tmp, 'store'), { recursive: true });
    const stale = join(tmp, 'store', '.retro-old');
    writeFileSync(stale, 'x');
    const t = (Date.now() - 30 * 86400000) / 1000;
    utimesSync(stale, t, t);
    expect(stopHook({}, 's1', offRepo())).toBe('');
    expect(existsSync(stale)).toBe(false);
  });

  test('stop: asks from CLAUDE_PROJECT_DIR when set', () => {
    expect(stopHook({ CLAUDE_PROJECT_DIR: offRepo() }, 's1', tmp)).toBe('');
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
    expect(nb(other, ['enabled', '--why']).out).toBe(`off (git config nb.enabled=false, file:${globalCfg})\n`);

    expect(sessionStart(env, pilot)).toContain('## Your agent-notebook index');
    expect(sessionStart(env, other)).toContain('switched off for this repository');
    expect(JSON.parse(stopHook(env, 'pilot', pilot)).decision).toBe('block');
    expect(stopHook(env, 'other', other)).toBe('');
    // The env var beats git config: exporting NB_ENABLED=0 would switch the pilot off too.
    expect(nb(pilot, ['enabled'], { NB_ENABLED: '0' }).out).toBe('off\n');
    // Only the retro sentinels landed in the store; the switch wrote no notebook.
    expect(readdirSync(join(tmp, 'store')).filter((f) => !f.startsWith('.'))).toEqual([]);
    // About ten real processes (git, the hooks, nb): give it room on a loaded runner, as
    // CONTRIBUTING asks for a spawn-heavy test. It took 5.3 s on macOS CI after #573.
  }, 30_000);
});

describe('the Stop hook: off in the project directory or in the payload cwd wins (issue #517)', () => {
  // The session-start hook asks from the project directory; the agent's own
  // `nb list` runs in its working directory, which Claude Code passes to the Stop
  // hook as the payload `cwd`. Either may have told the agent to skip the
  // retrospective, so the hook lets the stop through when either says `off`.
  // These run the real CLI against two git repositories (a stub answers the same
  // everywhere, so it could not show which directory decided).
  function realNb(): string {
    const bin = join(tmp, 'nb-real');
    writeFileSync(bin, `#!/usr/bin/env bash\nexec '${process.execPath}' '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }
  function twoRepos(): { on: string; off: string } {
    const on = repo('on-repo');
    const off = repo('off-repo');
    git(off, 'config', 'nb.enabled', 'false');
    return { on, off };
  }

  test('project on, payload cwd off: no nudge', () => {
    const { on, off } = twoRepos();
    expect(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: on }, 's1', tmp, { cwd: off })).toBe('');
  });

  test('a stop in an off cwd does not use up the nudge: a later stop back in the on project still nudges once', () => {
    // The payload cwd changes per turn while the sentinel lasts the session, so
    // an off answer from the cwd alone must release the sentinel.
    const { on, off } = twoRepos();
    const env = { NB_BIN: realNb(), CLAUDE_PROJECT_DIR: on };
    expect(stopHook(env, 's1', tmp, { cwd: off })).toBe('');
    expect(existsSync(join(tmp, 'store', '.retro-s1'))).toBe(false);
    expect(JSON.parse(stopHook(env, 's1', tmp, { cwd: on })).decision).toBe('block');
    expect(stopHook(env, 's1', tmp, { cwd: on })).toBe(''); // still only once
  });

  test('project off, payload cwd on: no nudge (session start already said skip), and the sentinel is kept', () => {
    const { on, off } = twoRepos();
    expect(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: off }, 's1', tmp, { cwd: on })).toBe('');
    // The project directory does not change during a session, so its off
    // answer keeps the sentinel and later stops exit without asking again.
    expect(existsSync(join(tmp, 'store', '.retro-s1'))).toBe(true);
  });

  test('both on: the nudge still fires', () => {
    const on = repo('on-repo');
    const other = repo('another-on-repo');
    expect(JSON.parse(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: on }, 's1', tmp, { cwd: other })).decision).toBe('block');
  });

  test('a payload cwd that no longer exists fails only its own check', () => {
    const { on, off } = twoRepos();
    const gone = join(tmp, 'removed-worktree');
    expect(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: off }, 'a', tmp, { cwd: gone })).toBe('');
    expect(JSON.parse(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: on }, 'b', tmp, { cwd: gone })).decision).toBe('block');
    // The failed check may come first, too: a missing project directory still
    // lets an off payload cwd decide.
    expect(stopHook({ NB_BIN: realNb(), CLAUDE_PROJECT_DIR: gone }, 'c', tmp, { cwd: off })).toBe('');
  });

  test('without CLAUDE_PROJECT_DIR the hook working directory is the project side', () => {
    const { on, off } = twoRepos();
    expect(stopHook({ NB_BIN: realNb() }, 'a', on, { cwd: off })).toBe('');
    expect(stopHook({ NB_BIN: realNb() }, 'b', off, { cwd: on })).toBe('');
  });

  test('a payload cwd equal to the project directory, with a trailing slash or empty, still nudges', () => {
    const proj = repo('proj');
    const env = { CLAUDE_PROJECT_DIR: proj };
    expect(JSON.parse(stopHook(env, 'same', tmp, { cwd: `${proj}/` })).decision).toBe('block');
    expect(JSON.parse(stopHook({ CLAUDE_PROJECT_DIR: `${proj}/` }, 'slash', tmp, { cwd: proj })).decision).toBe('block');
    expect(JSON.parse(stopHook(env, 'empty', tmp, { cwd: '' })).decision).toBe('block');
  });

  test('a non-string payload cwd is ignored', () => {
    const { on, off } = twoRepos();
    expect(JSON.parse(stopHook({ CLAUDE_PROJECT_DIR: on }, 's1', off, { cwd: 42 })).decision).toBe('block');
  });
});

describe('nb list answers off here (issue #514 slice 2)', () => {
  const OFF_LINE =
    'agent-notebook is switched off for this repository: skip the notebook steps (no `nb show`, no end-of-task retrospective). ' +
    '`nb enabled --why` shows which setting decided; `NB_ENABLED=1 nb list` shows the index anyway.\n';

  /** A repository switched off in its own .git/config, with one shelf in the store. */
  function offRepo(): string {
    const r = repo('off-repo');
    git(r, 'config', 'nb.enabled', 'false');
    expect(nb(r, ['add', 'some-shelf', 'a lesson worth keeping']).code).toBe(0);
    return r;
  }

  /** A `bin` dir holding only an `nb` wrapper around the built CLI (no `git` on it). */
  function nbOnlyBin(): string {
    const binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'nb'), `#!/usr/bin/env bash\nexec '${process.execPath}' '${CLI}' "$@"\n`);
    chmodSync(join(binDir, 'nb'), 0o755);
    return binDir;
  }

  test('off: every alias, with a prefix or --limit, prints the one flush-left line and exits 0', () => {
    const r = offRepo();
    for (const args of [['list'], ['ls'], ['shelves'], ['roles'], ['list', 'some'], ['list', '--limit', '5']]) {
      const res = nb(r, args);
      expect(res.code, args.join(' ')).toBe(0);
      expect(res.out, args.join(' ')).toBe(OFF_LINE);
      // `roles` is a deprecated alias with its own stderr note; nothing else is added.
      if (args[0] !== 'roles') expect(res.err, args.join(' ')).toBe('');
    }
  });

  test('off: the usage row is logged with outcome `off`', () => {
    const r = offRepo();
    nb(r, ['list']);
    const rows = execFileSync('cat', [join(tmp, 'store', '.nb-usage.log')], { encoding: 'utf-8' }).trim().split('\n');
    const last = rows[rows.length - 1].split('\t');
    expect(last[2]).toBe('list');
    expect(last[7]).toBe('off');
  });

  test('off: the `nb list` row is not a read in the engagement diagnosis (issue #517)', () => {
    // The off line showed no index, so in a store used only from off
    // repositories `nb stats` still names the "hook not wired" cause.
    const r = offRepo();
    expect(nb(r, ['list']).out).toBe(OFF_LINE);
    const diag = JSON.parse(nb(r, ['stats', '--json']).out).surfacing.engagementDiagnosis;
    expect(diag.reads).toBe(0);
    expect(diag.causes).toContain('injection-hook');
    // The same `nb list` with the index shown is a read, and the cause goes.
    expect(nb(r, ['list'], { NB_ENABLED: '1' }).out).toContain('some-shelf');
    const after = JSON.parse(nb(r, ['stats', '--json']).out).surfacing.engagementDiagnosis;
    expect(after.reads).toBe(1);
    expect(after.causes).not.toContain('injection-hook');
  });

  test('NB_ENABLED=1 shows the index in an off repository, and --json never consults the switch', () => {
    const r = offRepo();
    const on = repo('on-repo');
    expect(nb(r, ['list'], { NB_ENABLED: '1' }).out).toContain('some-shelf');
    const offJson = nb(r, ['list', '--json']);
    expect(offJson.code).toBe(0);
    expect(offJson.out).toBe(nb(on, ['list', '--json']).out);
    expect(JSON.parse(offJson.out).rows.map((x: { shelf: string }) => x.shelf)).toEqual(['some-shelf']);
  });

  test('on, or a check that fails open, prints the same index as before, with no warning', () => {
    const r = offRepo();
    const expected = nb(r, ['list'], { NB_ENABLED: '1' });
    expect(expected.out).toContain('some-shelf');
    const plain = repo('plain');
    const invalid = repo('invalid');
    git(invalid, 'config', 'nb.enabled', 'maybe');
    for (const [label, cwd, extra] of [
      ['key unset', plain, {}],
      ['invalid value', invalid, {}],
      ['no git on PATH', r, { PATH: nbOnlyBin() }],
    ] as const) {
      const res = nb(cwd, ['list'], extra);
      expect(res.out, label).toBe(expected.out);
      expect(res.err, label).toBe(expected.err);
    }
  });

  test('bash completion still offers shelf names in an off repository', () => {
    const r = offRepo();
    const binDir = nbOnlyBin();
    const script = 'eval "$(nb completion bash)"; COMP_WORDS=(nb show ""); COMP_CWORD=2; _nb_complete; echo "${COMPREPLY[@]}"';
    const out = execFileSync('bash', ['-c', script], {
      cwd: r,
      env: childEnv({ PATH: `${binDir}:${process.env.PATH}` }),
      encoding: 'utf-8',
    });
    expect(out.trim()).toBe('some-shelf');
  });

  test('session start: on in CLAUDE_PROJECT_DIR shows the real index even from an off working directory', () => {
    const r = offRepo();
    const proj = repo('proj');
    const bin = join(nbOnlyBin(), 'nb');
    const out = sessionStart({ NB_BIN: bin, CLAUDE_PROJECT_DIR: proj }, r);
    expect(out).toContain('## Your agent-notebook index');
    expect(out).toContain('some-shelf');
    expect(out).not.toContain('switched off');
  });
});
