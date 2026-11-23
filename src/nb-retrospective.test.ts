import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

// Regression test for issue #165: `nb-retrospective.sh` writes a
// `.retro-<session_id>` sentinel into NB_DIR once per session and nothing ever
// removed them, so on a busy machine they accumulated without bound. The hook
// now prunes `.retro-*` files older than a TTL (default 7 days, overridable via
// NB_RETRO_TTL_DAYS) after claiming the current session's sentinel — all
// best-effort so cleanup can never block the stop. These tests drive the real
// script to assert the sentinel is still claimed (the one-nudge contract holds)
// AND that stale sentinels are reaped while fresh ones and non-sentinel files
// are left alone — and that a failing unlink can never break the stop.
const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, '..', 'examples', 'hooks', 'claude-code', 'nb-retrospective.sh');

const DAY_MS = 86400000;

let dir: string;

// Set a file's mtime to `daysAgo` days in the past.
function ageFile(path: string, daysAgo: number): void {
  const when = (Date.now() - daysAgo * DAY_MS) / 1000;
  utimesSync(path, when, when);
}

// Create a `.retro-<name>` file aged `daysAgo` days and return its path.
function seedSentinel(name: string, daysAgo: number): string {
  const p = join(dir, `.retro-${name}`);
  writeFileSync(p, 'x');
  ageFile(p, daysAgo);
  return p;
}

// Run the Stop hook against NB_DIR=dir with the given hook-input JSON and env
// overrides. NB_RETRO_TTL_DAYS is stripped from the inherited env first, so a
// developer's or CI's ambient setting can never change the default-TTL tests —
// only an explicit `env` override here is seen. Returns the block decision JSON
// written to stdout (or '').
function runHook(input: Record<string, unknown>, env: Record<string, string> = {}): string {
  // NB_BIN points at a missing binary so the hook's `nb enabled` check (issue #514)
  // fails open without running whatever `nb` the host has on PATH.
  const base = { ...process.env, NB_DIR: dir, NB_BIN: join(dir, 'no-nb') } as Record<string, string>;
  delete base.NB_RETRO_TTL_DAYS;
  return execFileSync('bash', [hook], {
    input: JSON.stringify(input),
    env: { ...base, ...env },
    encoding: 'utf-8',
  });
}

// Spawn `n` hook processes that each block reading stdin (the hook reads its
// JSON via `cat` before doing anything), then release every process's stdin in
// the same tick so they contend on the sentinel claim together — the closest a
// multi-process test can get to a real concurrent-SubagentStop race. Resolves to
// each process's stdout and exit code. (Process-start jitter after stdin closes
// still means overlap at the claim isn't guaranteed on every run, which is why
// the race test is paired with a deterministic loser-path guard below.)
function raceHooks(
  n: number,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Array<{ out: string; code: number | null }>> {
  // NB_BIN points at a missing binary so the hook's `nb enabled` check (issue #514)
  // fails open without running whatever `nb` the host has on PATH.
  const base = { ...process.env, NB_DIR: dir, NB_BIN: join(dir, 'no-nb') } as Record<string, string>;
  delete base.NB_RETRO_TTL_DAYS;
  const payload = JSON.stringify(input);

  const children = Array.from({ length: n }, () =>
    spawn('bash', [hook], { env: { ...base, ...env } }),
  );
  const done = children.map(
    (child) =>
      new Promise<{ out: string; code: number | null }>((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ out, code }));
      }),
  );
  // Release every process's stdin together to maximize overlap at the claim.
  for (const child of children) child.stdin.end(payload);
  return Promise.all(done);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-retro-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retrospective.sh sentinel TTL prune (issue #165)', () => {
  test('claims the current session sentinel and blocks the stop once', () => {
    const out = runHook({ session_id: 'sess-1' });
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(true);
    expect(JSON.parse(out).decision).toBe('block');
  });

  test('a second stop (sentinel already present) lets the stop through', () => {
    runHook({ session_id: 'sess-1' });
    const out = runHook({ session_id: 'sess-1' });
    // No block decision emitted on the second stop.
    expect(out.trim()).toBe('');
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(true);
  });

  test('stop_hook_active short-circuits before writing OR pruning', () => {
    // A stale sentinel present: because the hook exits before the prune when
    // stop_hook_active is set, it must survive (guards against the prune being
    // moved above the early exit).
    const stale = seedSentinel('old', 10);
    const out = runHook({ session_id: 'sess-1', stop_hook_active: true });
    expect(out.trim()).toBe('');
    expect(existsSync(join(dir, '.retro-sess-1'))).toBe(false);
    expect(existsSync(stale)).toBe(true);
  });

  test('prunes a stale .retro-* sentinel older than the default 7d TTL', () => {
    const stale = seedSentinel('old', 10);

    const out = runHook({ session_id: 'sess-new' });

    expect(existsSync(stale)).toBe(false);
    // The new session still claimed its own sentinel and still blocked.
    expect(existsSync(join(dir, '.retro-sess-new'))).toBe(true);
    expect(JSON.parse(out).decision).toBe('block');
  });

  test('keeps a fresh .retro-* sentinel inside the TTL window', () => {
    const fresh = seedSentinel('recent', 1);
    runHook({ session_id: 'sess-new' });
    expect(existsSync(fresh)).toBe(true);
  });

  test('never reaps the session sentinel it just wrote, even under a tiny TTL', () => {
    // TTL ~14.4 min (0.01 d): comfortably above the sub-second cold start so
    // the just-written sentinel is never on the wrong side of the cutoff, yet a
    // 1-day-old control IS stale — proving the prune actually ran, not that it
    // simply pruned nothing.
    const stale = seedSentinel('control', 1);
    runHook({ session_id: 'sess-self' }, { NB_RETRO_TTL_DAYS: '0.01' });
    expect(existsSync(join(dir, '.retro-sess-self'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test('NB_RETRO_TTL_DAYS overrides the TTL', () => {
    const threeDays = seedSentinel('3d', 3);
    // TTL=1 day → a 3-day-old sentinel is stale and reaped.
    runHook({ session_id: 'sess-a' }, { NB_RETRO_TTL_DAYS: '1' });
    expect(existsSync(threeDays)).toBe(false);

    // Same age, default 7-day TTL → kept.
    const threeDaysAgain = seedSentinel('3d-again', 3);
    runHook({ session_id: 'sess-b' });
    expect(existsSync(threeDaysAgain)).toBe(true);
  });

  // Every invalid / non-positive value must fall back to the 7-day default —
  // NOT reap everything (which a `> 0` → `>= 0` slip would do under '0'), and
  // NOT reap the session's own just-written sentinel.
  test.each(['', '0', '-5', 'not-a-number', 'Infinity', 'NaN'])(
    'NB_RETRO_TTL_DAYS=%j falls back to the 7d default',
    (ttl) => {
      const old = seedSentinel('old', 10);
      const young = seedSentinel('young', 2);

      runHook({ session_id: 'sess-c' }, { NB_RETRO_TTL_DAYS: ttl });

      expect(existsSync(old)).toBe(false); // 10d > 7d → reaped
      expect(existsSync(young)).toBe(true); // 2d < 7d → kept
      expect(existsSync(join(dir, '.retro-sess-c'))).toBe(true); // own sentinel safe
    },
  );

  test('a failing unlink never breaks the stop (best-effort cleanup)', () => {
    // A `.retro-*` entry that is a DIRECTORY makes unlinkSync throw. The stop
    // must still complete (block JSON emitted), the session sentinel must still
    // be claimed, and other stale `.retro-*` files must still be reaped — i.e.
    // one failing entry neither aborts the sweep nor kills the hook.
    const retroDir = join(dir, '.retro-dir');
    mkdirSync(retroDir);
    ageFile(retroDir, 30);
    const staleA = seedSentinel('aaa-old', 30);
    const staleZ = seedSentinel('zzz-old', 30);

    const out = runHook({ session_id: 'sess-robust' });

    expect(JSON.parse(out).decision).toBe('block'); // hook did not crash
    expect(existsSync(join(dir, '.retro-sess-robust'))).toBe(true);
    expect(existsSync(retroDir)).toBe(true); // undeletable entry left in place
    // Both stale files reaped regardless of readdir order → the sweep continued
    // past the throwing directory entry.
    expect(existsSync(staleA)).toBe(false);
    expect(existsSync(staleZ)).toBe(false);
  });

  test('leaves non-sentinel files (notebooks, near-miss names) untouched', () => {
    const keep = [
      'change-verifier.md', // a notebook
      '.gitkeep', // an unrelated dotfile
      '.retrospective-notes', // `.retro` but NOT `.retro-` → must not match
      'my.retro-x', // contains `retro-` but does not start with `.retro-`
    ].map((name) => {
      const p = join(dir, name);
      writeFileSync(p, 'x');
      ageFile(p, 365);
      return p;
    });

    runHook({ session_id: 'sess-d' });

    for (const p of keep) expect(existsSync(p)).toBe(true);
    // Only the session's own sentinel should exist among `.retro-` entries.
    const retros = readdirSync(dir).filter((n) => n.startsWith('.retro-'));
    expect(retros).toEqual(['.retro-sess-d']);
  });
});

describe('nb-retrospective.sh atomic sentinel claim (issue #245)', () => {
  test('concurrent stops on one session_id: exactly one blocks, every process exits 0 [timing]', async () => {
    // Parallel subagents share the parent session_id and can stop at once. With
    // a non-atomic existsSync()-then-writeFileSync() claim, several processes
    // could all see the sentinel absent and all emit `block`. The atomic `wx`
    // create lets exactly one win; the losers throw EEXIST and exit 0. Spawn
    // many real hook processes against ONE session_id and release their stdin
    // together (see raceHooks) so they contend on the claim at once. Overlap at
    // the claim is timing-dependent, so run several independent rounds: the fix
    // holds the invariant every round, while a non-atomic claim breaks it as
    // soon as any one round actually overlaps.
    const N = 24;
    const ROUNDS = 3;
    for (let round = 0; round < ROUNDS; round++) {
      const session = `sess-race-${round}`;
      const runs = await raceHooks(N, { session_id: session });

      const blocks = runs.filter((r) => r.out.trim() !== '');
      expect(blocks).toHaveLength(1);
      expect(JSON.parse(blocks[0].out).decision).toBe('block');
      // Every other process let its stop through with no block decision …
      expect(runs.filter((r) => r.out.trim() === '')).toHaveLength(N - 1);
      // … and did so cleanly (exit 0), not by crashing with empty stdout.
      expect(runs.every((r) => r.code === 0)).toBe(true);
      // This round claimed exactly one sentinel and the losers left no stray
      // temp files: the `.retro-*` count grows by exactly one per round.
      const retros = readdirSync(dir).filter((n) => n.startsWith('.retro-'));
      expect(retros).toContain(`.retro-${session}`);
      expect(retros).toHaveLength(round + 1);
    }
    // 3 rounds x 24 real bash+node spawns is ~72 processes: well over Vitest's
    // 5 s default on a loaded macOS runner (issue #450), so size the timeout for it.
  }, 30_000);

  test('a loser finding the sentinel already present exits 0 without overwriting it', () => {
    // Deterministic companion to the race (whose overlap is timing-dependent):
    // the EEXIST path must allow the stop (no block) AND leave the existing
    // sentinel untouched — proving the claim uses `wx` (create-only), never `w`,
    // which would truncate and, by never throwing EEXIST, reintroduce the
    // double-nudge bug.
    const sentinel = join(dir, '.retro-sess-pre');
    writeFileSync(sentinel, 'ORIGINAL-CLAIM');
    const out = runHook({ session_id: 'sess-pre' });
    expect(out.trim()).toBe('');
    expect(readFileSync(sentinel, 'utf-8')).toBe('ORIGINAL-CLAIM');
  });
});

describe('nb-retrospective.sh length target (issue #342)', () => {
  test('the nudge gives an actionable ~150-char target while keeping the 200 cap', () => {
    const reason = (JSON.parse(runHook({ session_id: 'sess-len' })) as { reason: string }).reason;
    expect(reason).toContain('<=200-char lesson');
    expect(reason).toMatch(/aim for ~150 chars/);
    expect(reason).toMatch(/rejected, not truncated/);
  });
});

describe('nb-retrospective.sh session_id sanitizing (issue #460)', () => {
  test('a traversal id never writes outside the sentinel directory', () => {
    const store = join(dir, 'store');
    mkdirSync(store);
    const out = runHook({ session_id: 'x/../../escaped-file' }, { NB_DIR: store });
    expect(JSON.parse(out).decision).toBe('block');
    expect(existsSync(join(dir, 'escaped-file'))).toBe(false);
    expect(readdirSync(store)).toEqual(['.retro-x_.._.._escaped-file']);
  });

  test('a slash-containing id is nudged once, then later stops pass', () => {
    expect(JSON.parse(runHook({ session_id: 'a/b' })).decision).toBe('block');
    expect(runHook({ session_id: 'a/b' }).trim()).toBe('');
    expect(existsSync(join(dir, '.retro-a_b'))).toBe(true);
  });

  test('a UUID-shaped id keeps its file name', () => {
    const id = '123e4567-e89b-12d3-a456-426614174000';
    runHook({ session_id: id });
    expect(existsSync(join(dir, `.retro-${id}`))).toBe(true);
  });

  test('an over-long id is capped to 128 chars', () => {
    runHook({ session_id: 'a'.repeat(300) });
    expect(readdirSync(dir)).toEqual([`.retro-${'a'.repeat(128)}`]);
  });
});

// Issue #520: the one nudge went to the session's first stop. A lead that
// delegated to background subagents spent it the moment it began waiting, and a
// subagent that stopped first took it, its answer to the nudge then replacing the
// report its caller receives. Now a stop while a subagent is running, and every
// subagent stop, leave the nudge unspent for a later stop of the lead.
describe('nb-retrospective.sh nudge timing (issue #520)', () => {
  const running = (type: string, status = 'running') => ({ id: `t-${type}-${status}`, type, status });

  test('a lead stopping while a background subagent runs is not nudged, and is nudged at the next stop with none running', () => {
    const waiting = runHook({
      session_id: 'sess-wait',
      hook_event_name: 'Stop',
      background_tasks: [running('subagent'), running('shell')],
    });
    expect(waiting).toBe('');
    // The waiting stop must not use up the nudge.
    expect(existsSync(join(dir, '.retro-sess-wait'))).toBe(false);

    const done = runHook({
      session_id: 'sess-wait',
      hook_event_name: 'Stop',
      background_tasks: [running('subagent', 'completed')],
    });
    expect(JSON.parse(done).decision).toBe('block');
    expect(existsSync(join(dir, '.retro-sess-wait'))).toBe(true);

    // Still one nudge per session: a third stop is let through.
    expect(runHook({ session_id: 'sess-wait', hook_event_name: 'Stop', background_tasks: [] })).toBe('');
  });

  test('several waiting stops in a row never claim the sentinel', () => {
    for (let i = 0; i < 3; i++) {
      const out = runHook({ session_id: 'sess-many', hook_event_name: 'Stop', background_tasks: [running('subagent')] });
      expect(out).toBe('');
    }
    expect(readdirSync(dir).filter((n) => n.startsWith('.retro-'))).toEqual([]);
    expect(JSON.parse(runHook({ session_id: 'sess-many', hook_event_name: 'Stop' })).decision).toBe('block');
  });

  // Only a running subagent means "waiting". Anything else, including a payload
  // from a Claude Code that sends no background_tasks or a malformed one, nudges
  // exactly as before.
  // Every kind of delegated work Claude Code lists, running or not yet started,
  // holds the nudge back; the next stop with none in flight still gets it.
  test.each([
    ['a pending subagent', [running('subagent', 'pending')]],
    ['a running workflow', [running('workflow')]],
    ['a running teammate', [running('teammate')]],
    ['a running cloud session', [running('cloud session')]],
    ['a pending workflow next to a completed subagent', [running('subagent', 'completed'), running('workflow', 'pending')]],
  ])('a stop with %s is not nudged', (_label, tasks) => {
    expect(runHook({ session_id: 'sess-deleg', hook_event_name: 'Stop', background_tasks: tasks })).toBe('');
    expect(existsSync(join(dir, '.retro-sess-deleg'))).toBe(false);
    expect(JSON.parse(runHook({ session_id: 'sess-deleg', hook_event_name: 'Stop', background_tasks: [] })).decision).toBe('block');
  });

  test.each([
    ['a running shell only', [running('shell')]],
    ['a pending shell', [running('shell', 'pending')]],
    ['a completed workflow', [running('workflow', 'completed')]],
    ['a subagent with an unknown status', [running('subagent', 'killed')]],
    ['a running task of another type', [running('monitor')]],
    ['a running shell and another running task', [running('shell'), running('monitor')]],
    ['a completed subagent', [running('subagent', 'completed')]],
    ['a failed subagent', [running('subagent', 'failed')]],
    ['an empty list', []],
    ['a string', 'subagent running'],
    ['null', null],
    ['an object, not a list', { type: 'subagent', status: 'running' }],
    ['entries that are not objects', [null, 'subagent', 7, ['subagent', 'running']]],
  ])('background_tasks with %s still nudges', (_label, tasks) => {
    const out = runHook({ session_id: 'sess-other', hook_event_name: 'Stop', background_tasks: tasks });
    expect(out).not.toBe('');
    expect(JSON.parse(out).decision).toBe('block');
    expect(existsSync(join(dir, '.retro-sess-other'))).toBe(true);
  });

  test('a SubagentStop never nudges and leaves the nudge for the lead', () => {
    // A real SubagentStop payload: the parent's session_id, the subagent's own
    // id and type, and its own entry still `running` in background_tasks.
    const sub = runHook({
      session_id: 'sess-sub',
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-123',
      agent_type: 'general-purpose',
      background_tasks: [{ id: 'agent-123', type: 'subagent', status: 'running' }],
    });
    expect(sub).toBe('');
    expect(existsSync(join(dir, '.retro-sess-sub'))).toBe(false);

    const lead = runHook({ session_id: 'sess-sub', hook_event_name: 'Stop', background_tasks: [] });
    expect(JSON.parse(lead).decision).toBe('block');
  });

  test('a SubagentStop with nothing running is not nudged either', () => {
    // Guards the event check on its own: with no running subagent listed, only
    // `hook_event_name` tells this stop apart from the lead's.
    expect(runHook({ session_id: 'sess-sub2', hook_event_name: 'SubagentStop' })).toBe('');
    expect(existsSync(join(dir, '.retro-sess-sub2'))).toBe(false);
  });

  test('a payload with agent_id but no hook_event_name is treated as a subagent stop', () => {
    expect(runHook({ session_id: 'sess-sub3', agent_id: 'agent-9' })).toBe('');
    expect(existsSync(join(dir, '.retro-sess-sub3'))).toBe(false);
    // An empty agent_id is not a subagent: the lead's stop still nudges.
    expect(JSON.parse(runHook({ session_id: 'sess-sub3', agent_id: '' })).decision).toBe('block');
  });

  test('a Stop that carries agent_type but no agent_id (a session started with --agent) still nudges', () => {
    const out = runHook({ session_id: 'sess-agent', hook_event_name: 'Stop', agent_type: 'reviewer' });
    expect(JSON.parse(out).decision).toBe('block');
  });

  test('stop_hook_active still wins on a stop that would otherwise nudge', () => {
    expect(runHook({ session_id: 'sess-active', hook_event_name: 'Stop', stop_hook_active: true })).toBe('');
    expect(existsSync(join(dir, '.retro-sess-active'))).toBe(false);
  });

  test('concurrent lead stops after the subagents return produce one nudge [timing]', async () => {
    const runs = await raceHooks(12, {
      session_id: 'sess-race-520',
      hook_event_name: 'Stop',
      background_tasks: [running('subagent', 'completed')],
    });
    expect(runs.filter((r) => r.out.trim() !== '')).toHaveLength(1);
    expect(runs.every((r) => r.code === 0)).toBe(true);
  }, 30_000);

  test('the reason asks a subagent to end with its full report', () => {
    const reason = (JSON.parse(runHook({ session_id: 'sess-reason' })) as { reason: string }).reason;
    expect(reason).toMatch(/If you are a subagent, end by repeating your full final report after the retrospective/);
    expect(reason).toMatch(/your last message is all your caller receives/);
    // The report line comes after the checklist, right before the stop.
    expect(reason.trimEnd().endsWith('Then stop.')).toBe(true);
  });

  test('the example settings.json registers the hook under Stop and not under SubagentStop', () => {
    const settings = JSON.parse(readFileSync(join(dirname(hook), 'settings.json'), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const commands = (event: string) => (settings.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands('Stop').some((c) => c.endsWith('/nb-retrospective.sh'))).toBe(true);
    expect(settings.hooks.SubagentStop).toBeUndefined();
  });
});

// NB_RETRO_EXTRA_PROMPT: an optional text file appended to the block reason, with
// `{project}` (the repository folder shared by a checkout and its worktrees, or
// NB_PROJECT_SLUG) and `{session}` filled in. The file is read before the sentinel
// is claimed and a broken one only costs the extra text, never the lessons nudge.
describe('nb-retrospective.sh NB_RETRO_EXTRA_PROMPT', () => {
  const LESSONS = 'run the agent-notebook retrospective';
  const EXTRA = 'IDEAS for {project}: NB_SESSION={session} nb-ideas add dead@{project} "x"';

  // Like runHook, but returns stderr too (execFileSync only hands back stdout).
  function runFull(input: Record<string, unknown>, env: Record<string, string> = {}) {
    const base = { ...process.env, NB_DIR: dir, NB_BIN: join(dir, 'no-nb') } as Record<string, string>;
    for (const k of ['NB_RETRO_TTL_DAYS', 'NB_PROJECT_SLUG', 'NB_RETRO_EXTRA_PROMPT', 'CLAUDE_PROJECT_DIR']) delete base[k];
    const r = spawnSync('bash', [hook], {
      input: JSON.stringify(input),
      env: { ...base, ...env },
      encoding: 'utf-8',
      cwd: dir,
    });
    const reason = r.stdout ? (JSON.parse(r.stdout) as { reason: string }).reason : '';
    return { reason, stderr: r.stderr, code: r.status };
  }

  function extraFile(text = EXTRA): string {
    const p = join(dir, 'extra.txt');
    writeFileSync(p, text);
    return p;
  }

  // A git repository named `name` under dir/repos with one commit.
  function makeRepo(name: string): string {
    const repo = join(dir, 'repos', name);
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_DIR: undefined } as Record<string, string> });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
    return repo;
  }

  test('appends the file after the lessons text with {project} and {session} filled in', () => {
    const repo = makeRepo('my-app');
    const { reason } = runFull(
      { session_id: 'sess-x1', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: extraFile() },
    );
    const [head, tail] = reason.split('\n\n');
    expect(head).toContain(LESSONS);
    expect(tail).toBe('IDEAS for my-app: NB_SESSION=sess-x1 nb-ideas add dead@my-app "x"');
    expect(reason).not.toContain('{');
  });

  test('a leading ~/ in the path is expanded like NB_DIR', () => {
    const repo = makeRepo('tilde-app');
    writeFileSync(join(dir, 'extra.txt'), EXTRA);
    const { reason } = runFull(
      { session_id: 's', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: '~/extra.txt', HOME: dir },
    );
    expect(reason).toContain('IDEAS for tilde-app');
  });

  test('a main checkout and its git worktree give the same {project}', () => {
    const repo = makeRepo('shared-name');
    const wt = join(dir, 'elsewhere', 'wt-branch');
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feat', wt], { cwd: repo, stdio: 'ignore' });
    const env = { NB_RETRO_EXTRA_PROMPT: extraFile('{project}') };
    const main = runFull({ session_id: 'a', cwd: repo }, env).reason;
    rmSync(join(dir, '.retro-a'));
    const tree = runFull({ session_id: 'a', cwd: wt }, env).reason;
    expect(main.endsWith('\n\nshared-name')).toBe(true);
    expect(tree.endsWith('\n\nshared-name')).toBe(true);
  });

  test('NB_PROJECT_SLUG wins over the git folder name', () => {
    const repo = makeRepo('folder-name');
    const { reason } = runFull(
      { session_id: 's', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: extraFile('{project}'), NB_PROJECT_SLUG: 'acme-app' },
    );
    expect(reason.endsWith('\n\nacme-app')).toBe(true);
  });

  test('a cwd that is not a git directory leaves the extra text out but still nudges', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const { reason, code } = runFull(
      { session_id: 'sess-ng', cwd: plain },
      // GIT_CEILING_DIRECTORIES stops git walking up into an enclosing repository.
      { NB_RETRO_EXTRA_PROMPT: extraFile(), GIT_CEILING_DIRECTORIES: dir },
    );
    expect(code).toBe(0);
    expect(reason).toContain(LESSONS);
    expect(reason).not.toContain('IDEAS');
    expect(existsSync(join(dir, '.retro-sess-ng'))).toBe(true);
  });

  test('a missing file warns on stderr, sends the lessons alone and claims the sentinel', () => {
    const repo = makeRepo('my-app');
    const { reason, stderr } = runFull(
      { session_id: 'sess-miss', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: join(dir, 'does-not-exist.txt') },
    );
    expect(stderr).toMatch(/NB_RETRO_EXTRA_PROMPT/);
    expect(reason).toContain(LESSONS);
    expect(reason).not.toContain('IDEAS');
    expect(reason.trimEnd().endsWith('Then stop.')).toBe(true);
    expect(existsSync(join(dir, '.retro-sess-miss'))).toBe(true);
  });

  test('a relative path is treated like a missing file, even when it exists from the cwd', () => {
    const repo = makeRepo('my-app');
    extraFile(); // dir/extra.txt, and the hook runs with cwd = dir
    const { reason, stderr } = runFull(
      { session_id: 'sess-rel', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: 'extra.txt' },
    );
    expect(stderr).toMatch(/NB_RETRO_EXTRA_PROMPT/);
    expect(reason).toContain(LESSONS);
    expect(reason).not.toContain('IDEAS');
    expect(existsSync(join(dir, '.retro-sess-rel'))).toBe(true);
  });

  test('no session_id leaves the extra text out', () => {
    const repo = makeRepo('my-app');
    const { reason } = runFull({ cwd: repo }, { NB_RETRO_EXTRA_PROMPT: extraFile() });
    expect(reason).toContain(LESSONS);
    expect(reason).not.toContain('IDEAS');
  });

  test('a folder name that needs cleaning gives a valid {project}', () => {
    const repo = makeRepo('My_Repo (copy)');
    const { reason } = runFull(
      { session_id: 's', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: extraFile('{project}') },
    );
    expect(reason.endsWith('\n\nmy_repo--copy')).toBe(true);
  });

  test('the session is cleaned like the sentinel name', () => {
    const repo = makeRepo('my-app');
    const { reason } = runFull(
      { session_id: 'a/b c', cwd: repo },
      { NB_RETRO_EXTRA_PROMPT: extraFile('{session}') },
    );
    expect(reason.endsWith('\n\na_b_c')).toBe(true);
  });

  test('the shipped ideas prompt is short and uses both placeholders', () => {
    const text = readFileSync(join(dirname(hook), '..', 'ideas-end-prompt.txt'), 'utf-8');
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(12);
    expect(text).toContain('NB_SESSION={session} nb-ideas add <category>@{project}');
  });
});
