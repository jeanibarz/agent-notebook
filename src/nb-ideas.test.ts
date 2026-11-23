import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Drives the REAL examples/ideas/nb-ideas.mjs against a throwaway ideas folder.
// Each test is written so that deleting the rule it names would make it fail.
// The wrapper finds the package by self-reference (this repo's own dist/, built
// by the pretest step), so no install is needed.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const wrapper = join(root, 'examples', 'ideas', 'nb-ideas.mjs');
const nbCli = join(root, 'dist', 'cli.js');

let tmp: string;
let ideasDir: string;
let logFile: string;

type Result = { status: number; stdout: string; stderr: string };

/** Env without anything of the host's that could steer the wrapper. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'NB_SESSION' || k === 'NB_DIR' || k === 'NB_BIN' || k.startsWith('NB_IDEAS_')) delete env[k];
  }
  return env;
}

/** Run the wrapper in `tmp` (not a git repo) with --project my-app unless told otherwise. */
function run(args: string[], env: Record<string, string> = {}, project: string | null = 'my-app'): Result {
  const argv = project === null ? args : [...args, '--project', project];
  const r = spawnSync('node', [wrapper, ...argv], {
    cwd: tmp,
    env: { ...cleanEnv(), NB_IDEAS_DIR: ideasDir, ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const add = (cat: string, line: string, session?: string, extra: string[] = [], env: Record<string, string> = {}) =>
  run(['add', cat, line, ...extra], { ...(session ? { NB_SESSION: session } : {}), ...env });
const vote = (shelf: string, id: string, sign: string, session?: string, extra: string[] = []) =>
  run(['vote', shelf, id, sign, ...extra], session ? { NB_SESSION: session } : {});

const LINE_A = 'src/legacy.ts: nothing imports this file -> delete it (keeps: the public exports)';
const LINE_B = 'docs/setup.md: the install step names a removed flag -> correct the flag (keeps: the quick start)';
const LINE_C = 'src/cache.ts: stale entries are never expired -> add a ttl check (keeps: the hit rate)';

type Idea = { shelf: string; id: string; score: number; text: string };
const ideas = (): Idea[] => JSON.parse(run(['show', '--json']).stdout);
const idOf = (shelf: string): string => ideas().find((i) => i.shelf === shelf)!.id;
const logRows = (): string[][] =>
  existsSync(logFile) ? readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nb-ideas-'));
  ideasDir = join(tmp, 'ideas');
  logFile = join(ideasDir, '.ideas-support.log');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('nb-ideas add: format rules', () => {
  test('an unknown category is refused with the list and records nothing', () => {
    const r = add('feature', LINE_A);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown category "feature"');
    expect(r.stderr).toContain('guidance, dead, duplicate');
    expect(existsSync(join(ideasDir, 'feature@my-app.md'))).toBe(false);
    expect(logRows()).toEqual([]);
  });

  test('a line that is not in the format is refused with the template', () => {
    for (const bad of ['just some words', 'src/a.ts: problem -> change', 'src/a.ts: problem (keeps: x)']) {
      const r = add('dead', bad);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('<target>: <problem> -> <change> (keeps:');
    }
    expect(ideas()).toEqual([]);
  });

  test('a good line is recorded, logged, and its new shelf gets the category definition', () => {
    const r = add('dead', LINE_A, 'task-1');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/added [0-9a-f]{6} to dead@my-app/);
    expect(ideas().map((i) => i.text)).toEqual([LINE_A]);
    expect(logRows().map((c) => [c[1], c[2], c[3]])).toEqual([['task-1', 'add', 'dead@my-app']]);
    const list = run(['list'], {}, null);
    expect(list.stdout).toContain('dead@my-app');
    expect(list.stdout).toContain('nothing uses: delete it');
  });

  test('the project slug is lower-cased and cleaned; without any project the add is refused', () => {
    expect(add('dead', LINE_A, undefined, [], { NB_IDEAS_PROJECT: 'x' }).status).toBe(0); // --project my-app wins
    expect(existsSync(join(ideasDir, 'dead@my-app.md'))).toBe(true);
    const r = run(['add', 'dead', LINE_B, '--project', 'My App'], {}, null);
    expect(r.status).toBe(0);
    expect(existsSync(join(ideasDir, 'dead@my-app.md'))).toBe(true);
    expect(run(['add', 'dead', LINE_C], { NB_IDEAS_PROJECT: 'Acme API' }, null).status).toBe(0);
    expect(existsSync(join(ideasDir, 'dead@acme-api.md'))).toBe(true);
    const none = run(['add', 'dead', LINE_C], {}, null); // tmp is not a git repository
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('--project');
  });
});

describe('nb-ideas add: line caps are passed to nb', () => {
  const long = (n: number, target = 'src/big.ts') => {
    const pad = n - `${target}:  -> shorten it (keeps: all callers)`.length;
    return `${target}: ${'x'.repeat(pad)} -> shorten it (keeps: all callers)`;
  };

  test('a 300-char line is accepted (cap 400), a line over 400 is refused', () => {
    const ok = long(300);
    expect(ok.length).toBe(300);
    expect(add('overbuilt', ok).status).toBe(0);
    const tooLong = long(420, 'src/other.ts');
    const r = add('overbuilt', tooLong, undefined, [], { NB_IDEAS_SIMILARITY: '0.99' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('20 over the cap of 400');
    expect(ideas()).toHaveLength(1);
  });

  test('NB_IDEAS_MAX_CHARS moves the cap', () => {
    expect(add('overbuilt', long(450, 'src/a.ts'), undefined, [], { NB_IDEAS_MAX_CHARS: '500' }).status).toBe(0);
    expect(add('overbuilt', long(310, 'src/b.ts'), undefined, [], { NB_IDEAS_MAX_CHARS: '300', NB_IDEAS_SIMILARITY: '0.99' }).status).toBe(2);
  });

  test('passthrough doctor runs with the ideas cap: no lesson-too-long for a 300-char line', () => {
    expect(add('overbuilt', long(300)).status).toBe(0);
    const r = run(['doctor'], {}, null);
    expect(r.stdout + r.stderr).not.toContain('lesson-too-long');
    expect(r.status).toBe(0);
    // Control: the same store checked with nb's default 200 cap does flag it,
    // so the assertion above depends on the ideas cap being passed.
    const plain = spawnSync('node', [nbCli, 'doctor'], {
      env: { ...cleanEnv(), NB_DIR: ideasDir },
      encoding: 'utf-8',
    });
    expect(plain.stdout + plain.stderr).toContain('lesson-too-long');
  });
});

describe('nb-ideas add: one idea per task', () => {
  test('a second add by the same task is refused, naming the first idea', () => {
    expect(add('dead', LINE_A, 'task-1').status).toBe(0);
    const id = idOf('dead@my-app');
    const r = add('guidance', LINE_B, 'task-1');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`already recorded idea ${id}`);
    expect(ideas()).toHaveLength(1);
  });

  test('another task may add', () => {
    expect(add('dead', LINE_A, 'task-1').status).toBe(0);
    expect(add('guidance', LINE_B, 'task-2').status).toBe(0);
    expect(ideas()).toHaveLength(2);
  });

  test('--new does not bypass the one-per-task rule', () => {
    expect(add('dead', LINE_A, 'task-1').status).toBe(0);
    expect(add('dead', LINE_B, 'task-1', ['--new']).status).toBe(2);
  });

  test('the rule is per project', () => {
    expect(add('dead', LINE_A, 'task-1').status).toBe(0);
    expect(run(['add', 'dead', LINE_A, '--project', 'other-app'], { NB_SESSION: 'task-1' }, null).status).toBe(0);
  });

  test('with NB_SESSION unset a note is printed and the add proceeds', () => {
    const r = add('dead', LINE_A);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NB_SESSION is unset');
    expect(add('dead', LINE_B).status).toBe(0); // no per-task limit without a session
    expect(logRows().map((c) => c[1])).toEqual(['', '']);
  });
});

describe('nb-ideas add: matching existing ideas', () => {
  test('an identical line, even under another category, becomes a +1 vote and is logged', () => {
    expect(add('dead', LINE_A, 'task-1').status).toBe(0);
    const r = add('unused', LINE_A, 'task-2', ['--because', 'hit it while grepping']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('counted as a vote');
    expect(existsSync(join(ideasDir, 'unused@my-app.md'))).toBe(false);
    expect(ideas()).toEqual([expect.objectContaining({ shelf: 'dead@my-app', score: 2 })]);
    const last = logRows().pop()!;
    expect(last.slice(1, 3)).toEqual(['task-2', 'vote']);
    expect(last[5]).toBe('+1');
    expect(last[6]).toBe('hit it while grepping');
  });

  test('an identical line without --because is logged with a default reason', () => {
    add('dead', LINE_A, 'task-1');
    add('dead', LINE_A, 'task-2');
    expect(logRows().pop()![6]).toBe('re-added the identical line');
  });

  test('an identical line is still a vote subject to one vote per task', () => {
    add('dead', LINE_A, 'task-1');
    expect(add('dead', LINE_A, 'task-2').status).toBe(0);
    expect(add('dead', LINE_A, 'task-2').status).toBe(2); // one add per task is checked first, then votes
    expect(ideas()[0].score).toBe(2);
  });

  test('the same target is refused with exit 3 and nothing is recorded', () => {
    add('dead', LINE_A, 'task-1');
    const other = 'src/legacy.ts: contains only unrelated helpers for zero callers -> remove the helpers (keeps: nothing)';
    const r = add('dead', other, 'task-2');
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('same target');
    expect(r.stdout).toContain('nb-ideas vote <shelf> <id> +1 --because');
    expect(r.stdout).toContain('--new');
    expect(ideas()).toHaveLength(1);
    expect(logRows()).toHaveLength(1);
  });

  test('the target comparison ignores case and surrounding spaces', () => {
    add('dead', LINE_A, 'task-1');
    const r = add('dead', 'SRC/Legacy.ts : a different complaint entirely -> do something else (keeps: other things)', 'task-2');
    expect(r.status).toBe(3);
  });

  test('similar text above the threshold is refused with exit 3, and the threshold is configurable', () => {
    const a = 'src/net/retry.ts: the retry loop never sleeps between attempts -> add a fixed delay (keeps: the retry count)';
    const b = 'src/net/client.ts: the retry loop never sleeps between attempts -> add a backoff delay (keeps: the retry count)';
    expect(add('fragile', a, 'task-1').status).toBe(0);
    const r = add('fragile', b, 'task-2');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/similarity 0\.\d\d/);
    expect(r.stdout).not.toContain('same target');
    expect(ideas()).toHaveLength(1);
    // A threshold above the measured similarity lets the same line through.
    expect(add('fragile', b, 'task-2', [], { NB_IDEAS_SIMILARITY: '0.99' }).status).toBe(0);
    expect(ideas()).toHaveLength(2);
  });

  test('dissimilar ideas on different targets are both recorded', () => {
    add('dead', LINE_A, 'task-1');
    expect(add('guidance', LINE_B, 'task-2').status).toBe(0);
    expect(add('fragile', LINE_C, 'task-3').status).toBe(0);
    expect(ideas()).toHaveLength(3);
  });

  test('--new bypasses the similarity check', () => {
    add('dead', LINE_A, 'task-1');
    const other = 'src/legacy.ts: a second, different problem in the same file -> split the file (keeps: its exports)';
    expect(add('tangled', other, 'task-2').status).toBe(3);
    const r = add('tangled', other, 'task-2', ['--new']);
    expect(r.status).toBe(0);
    expect(ideas()).toHaveLength(2);
  });
});

describe('nb-ideas vote', () => {
  beforeEach(() => {
    add('dead', LINE_A, 'task-1');
  });

  test('+1 without --because is refused', () => {
    const id = idOf('dead@my-app');
    const r = vote('dead', id, '+1', 'task-2');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--because');
    expect(ideas()[0].score).toBe(1);
  });

  test('+1 with --because (bare category or full shelf) counts and is logged with the reason', () => {
    const id = idOf('dead@my-app');
    expect(vote('dead', id, '+1', 'task-2', ['--because', 'found it unused']).status).toBe(0);
    expect(vote('dead@my-app', id, '+1', 'task-3', ['--because', 'unused again']).status).toBe(0);
    expect(ideas()[0].score).toBe(3);
    expect(logRows().slice(1).map((c) => [c[1], c[2], c[5], c[6]])).toEqual([
      ['task-2', 'vote', '+1', 'found it unused'],
      ['task-3', 'vote', '+1', 'unused again'],
    ]);
  });

  test('a task cannot vote twice on the same idea, but can vote on another', () => {
    const id = idOf('dead@my-app');
    expect(vote('dead', id, '+1', 'task-2', ['--because', 'one']).status).toBe(0);
    const again = vote('dead', id, '+1', 'task-2', ['--because', 'two']);
    expect(again.status).toBe(2);
    expect(again.stderr).toContain('already voted');
    expect(vote('dead', id, '-1', 'task-2').status).toBe(2); // any second vote
    expect(ideas()[0].score).toBe(2);
    add('guidance', LINE_B, 'task-3');
    expect(vote('guidance', idOf('guidance@my-app'), '+1', 'task-2', ['--because', 'other idea']).status).toBe(0);
  });

  test('a task cannot +1 the idea it added', () => {
    const id = idOf('dead@my-app');
    const r = vote('dead', id, '+1', 'task-1', ['--because', 'my own']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('own idea');
    expect(ideas()[0].score).toBe(1);
  });

  test('-1 needs no reason and lowers the score', () => {
    const id = idOf('dead@my-app');
    expect(vote('dead', id, '-1', 'task-2').status).toBe(0);
    expect(ideas()[0].score).toBe(0);
  });

  test('with NB_SESSION unset a note is printed and the vote proceeds', () => {
    const id = idOf('dead@my-app');
    const r = vote('dead', id, '+1', undefined, ['--because', 'no session']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('NB_SESSION is unset');
    expect(vote('dead', id, '+1', undefined, ['--because', 'again']).status).toBe(0);
  });

  test('an unknown id, a bad sign and a missing shelf are refused with exit 2', () => {
    expect(vote('dead', 'ffffff', '+1', 'task-2', ['--because', 'x']).status).toBe(2);
    expect(vote('dead', idOf('dead@my-app'), '2', 'task-2').status).toBe(2);
    expect(vote('tests', 'ffffff', '-1', 'task-2').status).toBe(2);
  });

  test('the side log keeps one line per event: tabs and newlines in the reason become spaces and it is capped', () => {
    const id = idOf('dead@my-app');
    const reason = `first\tsecond\nthird ${'y'.repeat(500)}`;
    expect(vote('dead', id, '+1', 'task-2', ['--because', reason]).status).toBe(0);
    const rows = logRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(7);
    expect(rows[1][6].startsWith('first second third y')).toBe(true);
    expect(rows[1][6].length).toBe(300);
  });
});

describe('nb-ideas show, support', () => {
  test('show lists the whole project highest score first', () => {
    add('dead', LINE_A, 'task-1');
    add('guidance', LINE_B, 'task-2');
    vote('guidance', idOf('guidance@my-app'), '+1', 'task-3', ['--because', 'hit']);
    const lines = run(['show']).stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^guidance@my-app {2}[0-9a-f]{6} {2}\[2\] {2}docs\/setup\.md:/);
    expect(lines[1]).toMatch(/^dead@my-app {2}[0-9a-f]{6} {2}\[1\] {2}src\/legacy\.ts:/);
    expect(run(['show'], {}, 'other-app').stdout).toContain('no ideas recorded for other-app');
  });

  test('support counts distinct tasks and needs BOTH thresholds to mark an idea promotable', () => {
    // B: added by t1, +1 from t2 and t3 -> score 3, 3 tasks: promotable.
    add('guidance', LINE_B, 't1');
    const b = idOf('guidance@my-app');
    vote('guidance', b, '+1', 't2', ['--because', 'hit']);
    vote('guidance', b, '+1', 't3', ['--because', 'hit too']);
    // A: added by t4, then score pushed to 4 with votes made directly on nb (not logged): score high, ONE task.
    add('dead', LINE_A, 't4');
    const a = idOf('dead@my-app');
    for (let i = 0; i < 3; i++) {
      spawnSync('node', [nbCli, 'vote', 'dead@my-app', a, '+1'], { env: { ...cleanEnv(), NB_DIR: ideasDir } });
    }
    // C: added by t5, +1 from t6 -> 2 tasks, but score 2 is under 3.
    add('fragile', LINE_C, 't5');
    vote('fragile', idOf('fragile@my-app'), '+1', 't6', ['--because', 'hit']);

    const rows: Array<Record<string, unknown>> = JSON.parse(run(['support', '--json']).stdout);
    const by = (shelf: string) => rows.find((r) => r.shelf === shelf)!;
    expect(by('guidance@my-app')).toMatchObject({ score: 3, tasks: 3, promotable: true });
    expect(by('dead@my-app')).toMatchObject({ score: 4, tasks: 1, promotable: false });
    expect(by('fragile@my-app')).toMatchObject({ score: 2, tasks: 2, promotable: false });
    expect(rows[0].shelf).toBe('guidance@my-app'); // promotable first, then by score
    // The thresholds are knobs.
    const loose = JSON.parse(run(['support', '--json'], { NB_IDEAS_PROMOTE_TASKS: '1' }).stdout);
    expect(loose.find((r: { shelf: string }) => r.shelf === 'dead@my-app').promotable).toBe(true);
    const text = run(['support']).stdout;
    expect(text).toMatch(/PROMOTABLE {2}guidance@my-app/);
  });

  test('support: a vote without a reason does not count as a supporting task, -1 neither', () => {
    add('dead', LINE_A, 't1');
    const id = idOf('dead@my-app');
    // A reason-less +1 can only reach the log through the converted-add path or a hand edit; the
    // wrapper itself refuses it, so write the row the way an older log might hold it.
    writeFileSync(logFile, readFileSync(logFile, 'utf-8') + `2026-01-01T00:00:00.000Z\tt2\tvote\tdead@my-app\t${id}\t+1\t\n`);
    vote('dead', id, '-1', 't3');
    const row = JSON.parse(run(['support', '--json']).stdout)[0];
    expect(row.tasks).toBe(1);
  });

  test('support: events with no session each count as a task and the row says how many', () => {
    add('dead', LINE_A);
    const id = idOf('dead@my-app');
    vote('dead', id, '+1', undefined, ['--because', 'a']);
    vote('dead', id, '+1', undefined, ['--because', 'b']);
    const row = JSON.parse(run(['support', '--json']).stdout)[0];
    expect(row).toMatchObject({ score: 3, tasks: 3, unattributed: 3, promotable: true });
    expect(run(['support']).stdout).toContain('3 unattributed');
  });
});

describe('nb-ideas categories, prompt, help, passthrough', () => {
  test('categories lists the defaults in tie-break order with definitions', () => {
    const lines = run(['categories'], {}, null).stdout.trim().split('\n');
    expect(lines.map((l) => l.split(':')[0])).toEqual([
      'guidance', 'dead', 'duplicate', 'overbuilt', 'tangled', 'unused', 'fragile', 'tests',
    ]);
    expect(lines[1]).toContain('nothing uses: delete it');
  });

  test('categories.txt in the ideas folder replaces the list; its order and definitions are used', () => {
    mkdirSync(ideasDir, { recursive: true });
    writeFileSync(join(ideasDir, 'categories.txt'), '# my list\n\nsecurity: a risk to close\ncleanup: something to tidy\n');
    expect(run(['categories'], {}, null).stdout).toBe('security: a risk to close\ncleanup: something to tidy\n');
    expect(add('dead', LINE_A).status).toBe(2); // a default no longer in the list
    expect(add('security', LINE_A).status).toBe(0);
    expect(run(['list'], {}, null).stdout).toContain('a risk to close');
    expect(run(['prompt']).stdout).toContain('security, cleanup');
  });

  test('a bad line in categories.txt is refused with its line number', () => {
    mkdirSync(ideasDir, { recursive: true });
    writeFileSync(join(ideasDir, 'categories.txt'), 'ok: fine\nBad Name: nope\n');
    const r = run(['categories'], {}, null);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('line 2');
  });

  test('prompt --session prefixes the commands with NB_SESSION; without it they are bare', () => {
    const withSession = run(['prompt', '--session', 'task-42']).stdout;
    expect(withSession).toContain('NB_SESSION=task-42 nb-ideas add <category>');
    expect(withSession).toContain('NB_SESSION=task-42 nb-ideas vote <shelf> <id> +1 --because');
    const bare = run(['prompt']).stdout;
    expect(bare).not.toContain('NB_SESSION=');
    for (const text of [withSession, bare]) {
      expect(text).toContain('in my-app');
      expect(text).toContain('Most tasks have nothing to record');
      expect(text).toContain('at most one idea');
      expect(text).toContain('<file or command>: <problem> -> <change> (keeps: <behaviour that must keep working>)');
      expect(text).toContain('guidance, dead, duplicate, overbuilt, tangled, unused, fragile, tests');
      expect(text).toContain('--new');
    }
  });

  test('help and --help print the usage with exit 0', () => {
    for (const arg of ['help', '--help']) {
      const r = run([arg], {}, null);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('nb-ideas add <category>');
    }
  });

  test('other commands go to nb against the ideas folder, never the caller NB_DIR', () => {
    const other = join(tmp, 'lessons');
    mkdirSync(other);
    const r = run(['path'], { NB_DIR: other }, null);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(ideasDir);
    add('dead', LINE_A, 't1');
    const id = idOf('dead@my-app');
    expect(run(['rm', 'dead@my-app', id, '--reason', 'other', '--note', 'promoted: link'], {}, null).status).toBe(0);
    expect(ideas()).toEqual([]);
  });

  test('NB_BIN replaces the nb command and sees the ideas environment', () => {
    const shim = join(tmp, 'fake-nb.sh');
    writeFileSync(shim, '#!/bin/sh\necho "dir=$NB_DIR chars=$NB_MAX_CHARS lines=$NB_MAX_LINES args=$*"\n', { mode: 0o755 });
    const r = run(['whatever', 'x'], { NB_BIN: shim, NB_IDEAS_MAX_LINES: '7' }, null);
    expect(r.stdout.trim()).toBe(`dir=${ideasDir} chars=400 lines=7 args=whatever x`);
  });
});

describe('nb-ideas: review fixes', () => {
  test('a target may contain ":" (file:line, Windows paths); the target is matched in full', () => {
    const r = add('fragile', 'src/a.ts:12: the catch swallows the error -> rethrow it (keeps: the retry)', 'task-1');
    expect(r.status).toBe(0);
    const same = add('fragile', 'src/a.ts:12: errors vanish in this catch -> log and rethrow (keeps: retry count)', 'task-2');
    expect(same.status).toBe(3);
    expect(same.stdout).toContain('same target');
  });

  test('parallel adds by one task record at most one idea', async () => {
    const { spawn } = await import('node:child_process');
    const lines = [LINE_A, LINE_B, LINE_C];
    const codes = await Promise.all(
      lines.map(
        (l) =>
          new Promise<number>((resolve) => {
            const p = spawn('node', [wrapper, 'add', 'guidance', l, '--project', 'my-app'], {
              cwd: tmp,
              env: { ...cleanEnv(), NB_IDEAS_DIR: ideasDir, NB_SESSION: 'same' },
              stdio: 'ignore',
            });
            p.on('close', (c) => resolve(c ?? 1));
          }),
      ),
    );
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(logRows().filter((c) => c[2] === 'add')).toHaveLength(1);
    expect(existsSync(join(ideasDir, '.ideas-adding-same@my-app'))).toBe(false); // marker released
  });

  test('support counts only events since the latest add: a removed line added again starts from zero', () => {
    expect(add('dead', LINE_A, 's1').status).toBe(0);
    const id = idOf('dead@my-app');
    expect(vote('dead', id, '+1', 's2', ['--because', 'hit it']).status).toBe(0);
    expect(run(['rm', 'dead@my-app', id, '--reason', 'wrong'], {}, null).status).toBe(0);
    expect(add('dead', LINE_A, 's3').status).toBe(0);
    const row = JSON.parse(run(['support', '--json']).stdout)[0];
    expect(row.tasks).toBe(1);
  });

  test('a +1 whose reason is only spaces is refused', () => {
    expect(add('dead', LINE_A, 's1').status).toBe(0);
    const r = vote('dead', idOf('dead@my-app'), '+1', 's2', ['--because', '   ']);
    expect(r.status).toBe(2);
  });

  test('a task may vote on two ideas of the same shelf', () => {
    expect(add('dead', LINE_A, 's1').status).toBe(0);
    expect(add('dead', LINE_C, 's2').status).toBe(0);
    const [a, c] = ideas().map((i) => i.id);
    expect(vote('dead', a, '+1', 's3', ['--because', 'x']).status).toBe(0);
    expect(vote('dead', c, '+1', 's3', ['--because', 'y']).status).toBe(0);
  });

  test('caps are clamped to the range nb accepts, and the message quotes the real cap', () => {
    const long = `src/x.ts: ${'p'.repeat(2100)} -> cut (keeps: y)`;
    const r = add('dead', long, 's1', [], { NB_IDEAS_MAX_CHARS: '3000' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('over the cap of 2000');
  });

  test('a stale add marker (a crashed add) is taken over; a fresh one refuses the add', () => {
    mkdirSync(ideasDir, { recursive: true });
    const marker = join(ideasDir, '.ideas-adding-s1@my-app');
    writeFileSync(marker, '1');
    expect(add('dead', LINE_A, 's1').status).toBe(2); // fresh: an add by this task is in progress
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(marker, old, old);
    expect(add('dead', LINE_A, 's1').status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a project slug is trimmed to start and end with a letter or digit, with no ".."', () => {
    expect(run(['add', 'dead', LINE_A, '--project', '_My..Repo (copy)_'], {}, null).status).toBe(0);
    expect(existsSync(join(ideasDir, 'dead@my.repo--copy.md'))).toBe(true);
  });
});
