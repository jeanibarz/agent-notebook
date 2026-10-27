import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNbCli } from './cli.js';

const PKG_VERSION: string = createRequire(import.meta.url)('../package.json').version;

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-cli-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_ROLE', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run runNbCli with stdout/stderr captured. When `stdin` is provided, it is fed
 * to the CLI through the injectable stdin reader (used by `nb add <role> -`), so
 * the stdin path is exercised without touching the real `process.stdin`.
 */
async function run(
  argv: string[],
  stdin?: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — test shim for capturing writes
  process.stdout.write = (s: string) => ((out += s), true);
  // @ts-expect-error — test shim for capturing writes
  process.stderr.write = (s: string) => ((err += s), true);
  const reader = stdin === undefined ? undefined : async () => stdin;
  try {
    const code = await runNbCli(argv, reader);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('runNbCli', () => {
  test('--help and no-args print usage and exit 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb — the Agent Notebook');
  });

  test('add then show round-trips a lesson', async () => {
    expect((await run(['add', 'patcher', 'prefer execFileSync, array args'])).code).toBe(0);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('prefer execFileSync, array args');
    expect(show.out).toMatch(/^[0-9a-f]{6}\s+\[\+1\]\s+prefer execFileSync/m); // stable id + score
  });

  test('vote by the id shown in `show` succeeds', async () => {
    await run(['add', 'patcher', 'alpha one']);
    await run(['add', 'patcher', 'beta two']);
    const show = await run(['show', 'patcher']);
    const id = show.out.trim().split('\n')[0].split(/\s+/)[0]; // first token of the top line
    const v = await run(['vote', 'patcher', id, '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('vote adjusts the score shown', async () => {
    await run(['add', 'patcher', 'run lint before done']);
    const v = await run(['vote', 'patcher', 'lint', '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('vote accepts -1 and the ++/-- delta aliases through the CLI', async () => {
    // The CLI vote tests otherwise only drive +1 success and an invalid delta.
    // parseDelta also accepts `-1`, `++`, and `--`; exercise those branches end
    // to end so a break in the alias/negative parsing is caught at the CLI layer.
    await run(['add', 'patcher', 'tune this lesson']); // starts at +1
    const up = await run(['vote', 'patcher', 'tune', '++']); // alias for +1
    expect(up.code).toBe(0);
    expect(up.out).toContain('[+2]');
    const down = await run(['vote', 'patcher', 'tune', '-1']); // explicit -1
    expect(down.code).toBe(0);
    expect(down.out).toContain('[+1]');
    const down2 = await run(['vote', 'patcher', 'tune', '--']); // alias for -1
    expect(down2.code).toBe(0);
    expect(down2.out).toContain('[+0]'); // signed-zero formatting from fmt()
  });

  test('stats --since labels the window and returns 0', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '30m']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 30m');
  });

  test('a valid --since emits no warning', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '12h']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 12h');
    expect(s.err).toBe('');
  });

  test('a malformed --since warns naming the format and the window used, then proceeds', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days']);
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since '7days'");
    expect(s.err).toContain('Nd/Nh/Nm'); // names the accepted format
    expect(s.err).toContain('showing 7d'); // names the window actually used
    expect(s.err.trimEnd().split('\n')).toHaveLength(1); // one line, per the acceptance criteria
    expect(s.out).toContain('window 7d'); // falls back to the default and still reports
  });

  test('--since with no value warns, renders empty quotes, and still resolves the role', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since']); // --since is the final arg
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since ''"); // empty-quote fallback for a missing value
    expect(s.err).toContain('showing 7d');
    expect(s.out).toContain('window 7d');
    expect(s.out).toContain('role patcher'); // role still parsed despite the dangling flag
  });

  test('the human stats table renders a detected anomaly line (with the role suffix)', async () => {
    // The --json path and the library's anomaly detection are both covered, but
    // the HUMAN table's anomaly rendering in renderStats (the `anomalies:` header
    // and the `[kind] command (role X): detail` line, including the conditional
    // role suffix) had no test. Seed a tight loop of calls into the usage log,
    // then run `nb stats` WITHOUT --json and assert the rendered anomaly line, so
    // a regression in that user-facing formatting is caught.
    process.env.NB_LOOP_N = '3';
    process.env.NB_LOOP_WINDOW_S = '120';
    const now = Date.now();
    const rows = Array.from({ length: 4 }, (_, i) =>
      `${new Date(now - i * 1000).toISOString()}\tpatcher\tadd\tok\t2ms`,
    );
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']); // default table path (no --json)
    expect(s.code).toBe(0);
    expect(s.out).toContain('  anomalies:'); // the header branch, not the "none" line
    expect(s.out).toContain('[loop] add (role patcher):'); // kind, command, and the conditional role suffix
    expect(s.out).not.toContain('anomalies: none');
    // The per-command table row is rendered too (the `add` command summary line).
    expect(s.out).toMatch(/^\s*add\s+\d+\s+\d+%/m);
  });

  test('--json emits a single valid StatsReport object on stdout', async () => {
    await run(['add', 'patcher', 'x']); // records one `add` usage row
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out); // parses => valid JSON, exactly one object
    // Exactly one usage row exists at read time (the single `add`; this `stats`
    // row is logged only afterwards), so the counts are deterministic — assert
    // the concrete values, not just their types, or a miscount regression hides.
    expect(rep.window).toBe('7d'); // default window with no --since
    expect(rep.totalCalls).toBe(1);
    expect(rep.anomalies).toEqual([]); // one healthy call => no anomalies
    expect(rep.perCommand).toHaveLength(1); // only `add` recorded
    const add = rep.perCommand.find((c: { command: string }) => c.command === 'add');
    expect(add).toMatchObject({
      command: 'add',
      calls: 1,
      errors: 0,
      errorRate: 0,
      // latency is timing-dependent, but it must be a finite, non-negative number.
      p50ms: expect.any(Number),
      p95ms: expect.any(Number),
      lastUsed: expect.any(String),
    });
    expect(add.p50ms).toBeGreaterThanOrEqual(0);
    expect(add.lastUsed).not.toBe(''); // a real ISO timestamp was recorded
    expect(s.out).not.toContain('nb usage —'); // the human table is NOT emitted
  });

  test('--json composes with --since and a role, warning on stderr while stdout stays pure JSON', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days', '--json']); // bad window + role + json
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since '7days'"); // still warns on a bad window
    const rep = JSON.parse(s.out); // stdout is pure JSON despite the warning on stderr
    expect(rep.window).toBe('7d'); // bad window falls back to the default
  });

  test('without --json the default table path is unchanged; --json diverges only when asked', async () => {
    await run(['add', 'patcher', 'x']);
    const plain = await run(['stats', 'patcher', '--since', '30m']);
    const json = await run(['stats', 'patcher', '--since', '30m', '--json']);
    expect(plain.out).toContain('nb usage —'); // default path still renders the table
    expect(plain.out).toContain('window 30m');
    expect(() => JSON.parse(plain.out)).toThrow(); // the table is not JSON
    expect(plain.out).not.toBe(json.out); // the flag is the only thing that changes output
  });

  test('stats table shows the notebook inventory with a FULL marker at cap (issue #40)', async () => {
    process.env.NB_MAX_LINES = '2';
    await run(['add', 'patcher', 'alpha']);
    await run(['add', 'patcher', 'bravo']); // patcher now at cap 2/2
    await run(['add', 'scout', 'solo']); // scout below cap 1/2
    const s = await run(['stats']);
    expect(s.code).toBe(0);
    const out = s.out.split('\n').map((l) => l.trim());
    expect(out).toContain('notebooks: 2 roles, 3 lines (cap 2/role)');
    // Whole-row, line-anchored assertions (^…$ on one line) so a regex can never
    // match across rows or treat 1/2 as a prefix of 1/20.
    expect(out.some((l) => /^patcher\s+2\/2\s+FULL$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\s+1\/2$/.test(l))).toBe(true); // below cap: no marker
  });

  test('stats table says "notebooks: none" when no role has a notebook', async () => {
    const s = await run(['stats']); // only the stats call itself is logged; no notebook files
    expect(s.code).toBe(0);
    expect(s.out).toContain('notebooks: none');
    expect(s.out).not.toContain('FULL');
  });

  test('stats <role> scopes the table inventory to that role (singular header)', async () => {
    await run(['add', 'patcher', 'a']);
    await run(['add', 'scout', 'b']); // a second role that must be excluded
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    const out = s.out.split('\n').map((l) => l.trim());
    expect(out).toContain('notebooks: 1 role, 1 lines (cap 200/role)'); // singular "role"
    expect(out.some((l) => /^patcher\s+1\/200$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\b/.test(l))).toBe(false); // the other role is not listed
  });

  test('stats --json includes per-role lines and the maxLines cap (issue #40)', async () => {
    process.env.NB_MAX_LINES = '5';
    await run(['add', 'patcher', 'one']);
    await run(['add', 'patcher', 'two']);
    const s = await run(['stats', '--json']);
    expect(s.code).toBe(0);
    const report = JSON.parse(s.out);
    // old fields stay present and well-typed (additive contract)
    expect(report).toHaveProperty('window');
    expect(typeof report.totalCalls).toBe('number');
    expect(Array.isArray(report.perCommand)).toBe(true);
    expect(Array.isArray(report.anomalies)).toBe(true);
    // new inventory fields
    expect(report.notebooks).toEqual([{ role: 'patcher', lines: 2, cap: 5 }]);
    expect(report.notebookTotals).toEqual({ roles: 1, lines: 2, cap: 5 });
  });

  test('unknown command exits 2', async () => {
    const r = await run(['frobnicate', 'patcher']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });

  test('a missing required argument exits 1', async () => {
    const r = await run(['show']); // no role
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <role>');
  });

  test('a bad vote direction exits 1', async () => {
    await run(['add', 'patcher', 'x']);
    const r = await run(['vote', 'patcher', 'x', '2']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('+1 or -1');
  });

  test('--version (and -v / version) print the real package version', async () => {
    // Assert the exact package.json version, not just "a semver" — this also
    // catches a silent fallback (e.g. 0.0.0) if version resolution breaks.
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    for (const flag of ['--version', '-v', 'version']) {
      const r = await run([flag]);
      expect(r.code).toBe(0);
      expect(r.out).toBe(`nb (agent-notebook) ${PKG_VERSION}\n`);
    }
  });

  test('an over-long add exits 1, is not stored, and tells the agent to retry', async () => {
    process.env.NB_MAX_CHARS = '25';
    const r = await run(['add', 'patcher', 'z'.repeat(60)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/too long/i);
    expect(r.err).toMatch(/retry/i);
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('is empty');
  });

  test('add past NB_MAX_LINES evicts the lowest-scored entry and names it in the output', async () => {
    // Drive the CLI's eviction branch end to end: with a tiny cap, a third `add`
    // must evict the lowest-scored existing entry AND report it in the `added`
    // line — the exact feedback an agent relies on to know its memory changed.
    // notebook.test.ts covers the library eviction; this covers the CLI message
    // (a wrong count, a missing evicted suffix, or the wrong entry would be a
    // user-facing regression that the library-level tests do not catch).
    process.env.NB_MAX_LINES = '2';
    // Vote down the SECOND (younger) entry so the lowest-scored entry is NOT the
    // oldest — otherwise a FIFO-eviction regression (drop oldest, ignore score)
    // would still pass. alpha stays +1 (oldest), beta drops to 0 (lowest-scored).
    expect((await run(['add', 'patcher', 'alpha lesson one'])).code).toBe(0); // +1, oldest
    expect((await run(['add', 'patcher', 'beta lesson two'])).code).toBe(0); // +1 — notebook now full at the cap of 2
    expect((await run(['vote', 'patcher', 'beta', '-1'])).code).toBe(0); // beta → 0, now the lowest-scored but NOT the oldest
    const r = await run(['add', 'patcher', 'gamma lesson three']); // over the cap → must evict beta, not the older alpha
    expect(r.code).toBe(0);
    // Stable message (fixed single-space template, not padded whitespace): the
    // resulting size stays at the cap and the evicted lowest-scored entry is
    // named with its score.
    expect(r.out).toMatch(/added — 2 lines \(evicted lowest-scored: \[\+0\] beta lesson two\)/);
    // The eviction really happened by score, not by age: beta is gone while the
    // older alpha survives alongside the newest entry, and the cap held.
    const show = await run(['show', 'patcher']);
    expect(show.out).not.toContain('beta lesson two');
    expect(show.out).toContain('alpha lesson one');
    expect(show.out).toContain('gamma lesson three');
  });

  test('merge consolidates two entries into one, reflected by show', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const m = await run(['merge', 'patcher', 'alpha', 'beta', 'merged lesson alpha+beta']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('merged two entries into one');
    const show = await run(['show', 'patcher']);
    expect(show.out).toContain('merged lesson alpha+beta');
    expect(show.out).not.toContain('alpha lesson one');
    expect(show.out).not.toContain('beta lesson two');
  });

  test('merge with a missing argument exits 1', async () => {
    await run(['add', 'patcher', 'alpha lesson one']);
    await run(['add', 'patcher', 'beta lesson two']);
    const r = await run(['merge', 'patcher', 'alpha', 'beta']); // no merged lesson
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <merged lesson>');
  });

  test('rm deletes an entry, reflected by show', async () => {
    await run(['add', 'patcher', 'keep this lesson']);
    await run(['add', 'patcher', 'drop this lesson']);
    const r = await run(['rm', 'patcher', 'drop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('removed');
    expect(r.out).toContain('drop this lesson');
    const show = await run(['show', 'patcher']);
    expect(show.out).not.toContain('drop this lesson');
    expect(show.out).toContain('keep this lesson');
  });

  test('rm with a missing argument exits 1', async () => {
    const r = await run(['rm', 'patcher']); // no id|query selector
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <id|query>');
  });

  test('path with no role prints the notebooks dir (respecting NB_DIR)', async () => {
    const r = await run(['path']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${dir}\n`); // bare path, pipeable into cat/$(...)
  });

  test('path <role> prints the resolved absolute role file path', async () => {
    const r = await run(['path', 'reviewer']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${join(dir, 'reviewer.md')}\n`);
    expect(r.out.trimEnd()).toMatch(/\/reviewer\.md$/);
  });

  test('path with an unsafe role name is rejected by the existing safe-role check', async () => {
    const r = await run(['path', '../escape']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid role name/);
  });

  test('roles on an empty/absent notebooks dir prints a friendly note and exits 0', async () => {
    const r = await run(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(''); // stdout stays empty so the list pipes cleanly
    expect(r.err).toMatch(/no roles yet/);
  });

  test('roles lists each role file stem, sorted, one per line', async () => {
    await run(['add', 'reviewer', 'a lesson']);
    await run(['add', 'patcher', 'b lesson']);
    await run(['add', 'planner', 'c lesson']);
    const r = await run(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('patcher\nplanner\nreviewer\n'); // sorted, stems only, one per line
  });

  test('roles excludes the .nb-usage.log and .nb.lock sidecars', async () => {
    // `add` writes the role file AND appends a usage row (creating .nb-usage.log),
    // and takes the mkdir spinlock (.nb.lock) while writing — so both sidecars
    // are present in the dir and must not appear as roles.
    await run(['add', 'reviewer', 'a lesson']);
    const r = await run(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('reviewer\n');
    expect(r.out).not.toContain('nb-usage');
    expect(r.out).not.toContain('nb.lock');
  });

  test('roles excludes other non-.md entries that share the dir', async () => {
    await run(['add', 'reviewer', 'a lesson']);
    writeFileSync(join(dir, 'notes.txt'), 'not a notebook'); // a stray non-.md file
    const r = await run(['roles']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('reviewer\n'); // only the .md stem, not "notes"
  });

  describe('add <role> - reads the lesson from stdin (issue #38)', () => {
    test('happy path: a single piped line is stored and prints the usual added line', async () => {
      // The acceptance criterion: `printf '%s\n' 'run lint first' | nb add reviewer -`.
      const r = await run(['add', 'reviewer', '-'], 'run lint first\n');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 lines\n'); // the usual message, same as a quoted arg
      expect(r.err).toBe('');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('run lint first'); // stored verbatim, trailing newline stripped
    });

    test('a piped line with no trailing newline is stored just the same', async () => {
      const r = await run(['add', 'reviewer', '-'], 'no trailing newline');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 lines\n');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('no trailing newline');
    });

    test('multi-line stdin is REFUSED (exit 1) and nothing is stored, not flattened', async () => {
      // One entry = one line: sanitizeLesson would otherwise collapse the two
      // lines into one space-joined entry, silently losing the boundary. The CLI
      // must reject it before addEntry ever sees it.
      const r = await run(['add', 'reviewer', '-'], 'line one\nline two\n');
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/multi-line/i);
      expect(r.err).toMatch(/one entry = one line/i);
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('is empty'); // not stored, and definitely not flattened
      expect(show.out).not.toContain('line one line two');
    });

    test('CRLF and lone-CR line breaks are refused too, not flattened to a space', async () => {
      // sanitizeLesson collapses \r just like \n, so every line-ending
      // convention (LF, CRLF, old-Mac CR) must trigger the multi-line refusal —
      // otherwise a two-line paste would silently store one run-together entry.
      for (const raw of ['one\r\ntwo\r\n', 'alpha\rbeta\n']) {
        const r = await run(['add', 'reviewer', '-'], raw);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/multi-line/i);
      }
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('is empty'); // none of them were stored
    });

    test('a single trailing CRLF is stripped, leaving the clean line', async () => {
      const r = await run(['add', 'reviewer', '-'], 'windows line\r\n');
      expect(r.code).toBe(0);
      expect(r.out).toBe('added — 1 lines\n');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('windows line');
      expect(show.out).not.toContain('\r'); // the trailing CR was stripped, not stored
    });

    test('empty stdin falls through to the empty-lesson skip (exit 0), not a crash', async () => {
      const r = await run(['add', 'reviewer', '-'], '');
      expect(r.code).toBe(0);
      expect(r.out).toContain('skipped (empty lesson)');
      const show = await run(['show', 'reviewer']);
      expect(show.out).toContain('is empty');
    });

    test('--json composes with the stdin operand', async () => {
      // --json is stripped before positional parsing, so `-` is still args[2].
      const r = await run(['add', 'reviewer', '-', '--json'], 'piped with json\n');
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(JSON.parse(r.out)).toEqual({ added: true, reason: 'added', evicted: null, size: 1 });
    });
  });

  describe('--json on add/vote/rm/merge (issue #41)', () => {
    // A supervisor should branch on `reason`/`score` without regex-parsing the
    // English line, exactly as `stats --json` already allows for monitoring.
    /** stdout must be exactly one parseable JSON object and nothing else. */
    function parseOnly(out: string): unknown {
      expect(out.endsWith('\n')).toBe(true);
      expect(out.trimEnd().includes('\n')).toBe(false); // single line, no stray prose
      return JSON.parse(out);
    }

    test('add --json prints a parseable AddResult and nothing else (exit 0)', async () => {
      const r = await run(['add', 'patcher', 'prefer execFileSync', '--json']);
      expect(r.code).toBe(0);
      expect(r.err).toBe(''); // warnings/errors would be on stderr; there are none
      expect(parseOnly(r.out)).toEqual({ added: true, reason: 'added', evicted: null, size: 1 });
    });

    test('add --json on a duplicate emits reason:"duplicate" and stays exit 0', async () => {
      await run(['add', 'patcher', 'same lesson']);
      const r = await run(['add', 'patcher', 'same lesson', '--json']);
      expect(r.code).toBe(0); // a duplicate is a skip, not a failure
      expect(parseOnly(r.out)).toMatchObject({ added: false, reason: 'duplicate', size: 1 });
    });

    test('add --json on a too-long lesson emits reason:"too-long" on stdout but still exits 1', async () => {
      process.env.NB_MAX_CHARS = '25';
      const r = await run(['add', 'patcher', 'z'.repeat(60), '--json']);
      expect(r.code).toBe(1); // exit code unchanged from the text path
      expect(parseOnly(r.out)).toMatchObject({ added: false, reason: 'too-long', length: 60 });
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('is empty'); // and it was not stored
    });

    test('vote --json prints a parseable VoteResult', async () => {
      await run(['add', 'patcher', 'run lint before done']);
      const r = await run(['vote', 'patcher', 'lint', '+1', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toEqual({ text: 'run lint before done', score: 2 });
    });

    test('rm --json prints the removed entry', async () => {
      await run(['add', 'patcher', 'delete me']);
      const r = await run(['rm', 'patcher', 'delete me', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toEqual({ text: 'delete me', score: 1 });
    });

    test('merge --json prints the resulting AddResult', async () => {
      await run(['add', 'patcher', 'alpha lesson']);
      await run(['add', 'patcher', 'beta lesson']);
      const r = await run(['merge', 'patcher', 'alpha', 'beta', 'alpha+beta merged', '--json']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toMatchObject({ added: true, reason: 'added', size: 1 });
    });

    test('the flag is positional-order-independent and leaves the role/lesson intact', async () => {
      // --json between the role and the lesson must be stripped before positional
      // parsing, so the lesson is not swallowed and the role still resolves.
      const r = await run(['add', 'patcher', '--json', 'a lesson in the middle']);
      expect(r.code).toBe(0);
      expect(parseOnly(r.out)).toMatchObject({ added: true, reason: 'added', size: 1 });
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('a lesson in the middle'); // stored verbatim, flag not captured
    });

    test('without --json the English lines are unchanged', async () => {
      const r = await run(['add', 'patcher', 'plain text path']);
      expect(r.out).toBe('added — 1 lines\n');
    });
  });
});
