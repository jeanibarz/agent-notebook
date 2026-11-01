import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNbCli, settleCliExit } from './cli.js';
import { entryId, parseUsage } from './notebook.js';

const PKG_VERSION: string = createRequire(import.meta.url)('../package.json').version;

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-cli-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_MAX_LINES', 'NB_MAX_CHARS', 'NB_ROLE', 'NB_LOOP_N', 'NB_LOOP_WINDOW_S', 'NB_SESSION', 'NB_COVERAGE_HI', 'NB_RECALL_MISS_HI']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run runNbCli with stdout/stderr captured. When `stdin` is provided, it is fed
 * to the CLI through the injectable stdin reader (used by `nb add <shelf> -`), so
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

  test('show --json emits { shelf, description, entries } ordered highest-score-first (issue #87)', async () => {
    // Two lessons; vote the second one up so score ordering differs from insertion order.
    await run(['add', 'patcher', 'alpha lesson']);
    await run(['add', 'patcher', 'beta lesson']);
    const betaId = entryId('beta lesson');
    await run(['vote', 'patcher', betaId, '+1']); // beta: +2, alpha: +1
    await run(['describe', 'patcher', 'bug-fix lessons']);

    const r = await run(['show', 'patcher', '--json']);
    expect(r.code).toBe(0);
    // Exactly one JSON object on stdout, nothing else.
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(r.out);
    expect(parsed.role).toBe('patcher');
    expect(parsed.description).toBe('bug-fix lessons');
    // Highest score first (beta +2 before alpha +1); each entry carries id/score/text.
    expect(parsed.entries).toEqual([
      { id: betaId, score: 2, text: 'beta lesson' },
      { id: entryId('alpha lesson'), score: 1, text: 'alpha lesson' },
    ]);
    // The ids match what the human `show` prints, and the order matches render()
    // (skipping the leading `# desc:` header line that the human output carries).
    const plain = await run(['show', 'patcher']);
    const plainIds = plain.out
      .trim()
      .split('\n')
      .filter((l) => /^[0-9a-f]{6}\s/.test(l))
      .map((l) => l.split(/\s+/)[0]);
    expect(plainIds).toEqual(parsed.entries.map((e: { id: string }) => e.id));
  });

  test('show --json on an empty notebook yields { description: null, entries: [] } and exits 0 (issue #87)', async () => {
    const r = await run(['show', 'solo', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ role: 'solo', shelf: 'solo', description: null, entries: [] });
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

  test('--since with no value warns, renders empty quotes, and still resolves the shelf', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since']); // --since is the final arg
    expect(s.code).toBe(0);
    expect(s.err).toContain("unrecognized --since ''"); // empty-quote fallback for a missing value
    expect(s.err).toContain('showing 7d');
    expect(s.out).toContain('window 7d');
    expect(s.out).toContain('shelf patcher'); // shelf still parsed despite the dangling flag
  });

  test('the human stats table renders a detected anomaly line (with the shelf suffix)', async () => {
    // The --json path and the library's anomaly detection are both covered, but
    // the HUMAN table's anomaly rendering in renderStats (the `anomalies:` header
    // and the `[kind] command (shelf X): detail` line, including the conditional
    // shelf suffix) had no test. Seed a tight loop of calls into the usage log,
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
    expect(s.out).toContain('[loop] add (shelf patcher):'); // kind, command, and the conditional shelf suffix
    expect(s.out).not.toContain('anomalies: none');
    // The per-command table row is rendered too (the `add` command summary line).
    expect(s.out).toMatch(/^\s*add\s+\d+\s+\d+%/m);
  });

  test('the human stats table renders the ops-per-day activity sparkline line (issue #106)', async () => {
    // Seed a known pattern: the OLDEST 24h bucket (≈6.5 days ago) is the busiest.
    // The `stats` call self-logs one row into the NEWEST bucket, so only the
    // rightmost glyph can shift — the leftmost (busiest) glyph and the line
    // format stay deterministic.
    const now = Date.now();
    const DAY = 86_400_000;
    const rows: string[] = [];
    for (let k = 0; k < 8; k++) rows.push(`${new Date(now - 6.5 * DAY).toISOString()}\tpatcher\tshow\tok\t2ms\ts1`);
    rows.push(`${new Date(now - 2.5 * DAY).toISOString()}\tpatcher\tshow\tok\t2ms\ts1`);
    writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
    const s = await run(['stats', 'patcher']); // default table path (no --json)
    expect(s.code).toBe(0);
    // One `activity` line: 7 block glyphs for a 7d window + the "(7d, N ops)" label.
    expect(s.out).toMatch(/^ {2}activity {2}[▁▂▃▄▅▆▇█]{7} {2}\(7d, \d+ ops\)$/m);
    // The oldest bucket is the busiest (8 ops) → its glyph is the top block.
    const activityLine = s.out.split('\n').find((l) => l.includes('activity'))!;
    expect(activityLine).toContain('█'); // the busiest bucket renders as the full block
    expect(/activity {2}█/.test(activityLine)).toBe(true); // ...and it is the leftmost (oldest) glyph
  });

  test('stats --json exposes the per-day activity array (issue #106)', async () => {
    await run(['add', 'patcher', 'x']); // one `add` row; the stats read happens before stats self-logs
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out);
    expect(Array.isArray(rep.activity)).toBe(true);
    expect(rep.activity).toHaveLength(7); // default 7d window → 7 rolling-24h buckets
    expect(rep.activity.reduce((a: number, b: number) => a + b, 0)).toBe(rep.totalCalls);
    expect(rep.activity.at(-1)).toBe(1); // the single `add` is in the newest bucket
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

  test('--json composes with --since and a shelf, warning on stderr while stdout stays pure JSON', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '7days', '--json']); // bad window + shelf + json
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
    expect(out).toContain('notebooks: 2 shelves, 3 lines (cap 2/shelf)');
    // Whole-row, line-anchored assertions (^…$ on one line) so a regex can never
    // match across rows or treat 1/2 as a prefix of 1/20.
    expect(out.some((l) => /^patcher\s+2\/2\s+FULL$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\s+1\/2$/.test(l))).toBe(true); // below cap: no marker
  });

  test('stats table says "notebooks: none" when no shelf has a notebook', async () => {
    const s = await run(['stats']); // only the stats call itself is logged; no notebook files
    expect(s.code).toBe(0);
    expect(s.out).toContain('notebooks: none');
    expect(s.out).not.toContain('FULL');
  });

  test('stats <shelf> scopes the table inventory to that shelf (singular header)', async () => {
    await run(['add', 'patcher', 'a']);
    await run(['add', 'scout', 'b']); // a second shelf that must be excluded
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    const out = s.out.split('\n').map((l) => l.trim());
    expect(out).toContain('notebooks: 1 shelf, 1 lines (cap 50/shelf)'); // singular "shelf"
    expect(out.some((l) => /^patcher\s+1\/50$/.test(l))).toBe(true);
    expect(out.some((l) => /^scout\b/.test(l))).toBe(false); // the other shelf is not listed
  });

  test('stats --json includes per-shelf lines and the maxLines cap (issue #40)', async () => {
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
    expect(report.notebooks).toEqual([{ role: 'patcher', shelf: 'patcher', lines: 2, cap: 5 }]);
    expect(report.notebookTotals).toEqual({ roles: 1, shelves: 1, lines: 2, cap: 5 });
    expect(Array.isArray(report.signals)).toBe(true); // diagnostic signals (issue #72), additive
  });

  test('the human stats table renders a browse-without-use signal (issue #72)', async () => {
    // A show of a notebook in a session with no vote on it that session is the
    // browse-without-use signal. Drive it through the CLI with NB_SESSION set, so
    // the rendered `signals:` section (not the "none" line) is exercised.
    process.env.NB_SESSION = 'sess-A';
    await run(['add', 'reviewer', 'a lesson worth reading']);
    await run(['show', 'reviewer']); // browsed, but never voted this session
    const s = await run(['stats', 'reviewer']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('  signals:'); // the header branch, not the "none" line
    expect(s.out).toContain('[browse-without-use] shelf reviewer');
    expect(s.out).not.toContain('signals: none');
  });

  test('stats --json carries the browse-without-use signal (issue #72)', async () => {
    process.env.NB_SESSION = 'sess-B';
    await run(['show', 'solo']); // browse with no vote
    const s = await run(['stats', '--json']);
    const rep = JSON.parse(s.out);
    expect(rep.signals.some((x: { kind: string; shelf: string }) => x.kind === 'browse-without-use' && x.shelf === 'solo')).toBe(true);
  });

  test('the human stats table says "signals: none" when there is nothing to report', async () => {
    const s = await run(['stats']); // only the stats call itself is logged
    expect(s.out).toContain('signals: none');
  });

  test('the human stats table renders the surfacing metrics and readout (issue #81)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'alpha lesson']); // accepted
    await run(['vote', 'patcher', 'alpha', '+1']); // engages s1
    await run(['add', 'patcher', 'alpha lesson']); // dedup-blocked (same dedup key)
    const s = await run(['stats', 'patcher']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('surfacing: 1 engaged session');
    expect(s.out).toContain('coverage');
    expect(s.out).toContain('recall-miss');
    expect(s.out).toContain('precision-miss');
    expect(s.out).toContain('serendipity'); // issue #114
    // 1 accepted + 1 dedup-blocked ⇒ coverage .5 (HIGH) × recall .5 (HIGH) ⇒ churny.
    expect(s.out).toContain('readout: churny');
  });

  test('serendipity: a bare upvote is push-delivered (1.0), a searched-then-voted upvote is a pull (0.0) — issue #114', async () => {
    process.env.NB_SESSION = 'push-sess';
    await run(['add', 'patcher', 'bounded voted plain text memory']); // accepted
    await run(['vote', 'patcher', 'bounded', '+1']); // upvote, NO prior search → push
    const pushJson = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(pushJson.surfacing.upvotes).toBe(1);
    expect(pushJson.surfacing.serendipity).toBe(1); // arrived unbidden
    // The human table flags it as an approximate proxy, not a bound.
    const table = await run(['stats', 'patcher']);
    expect(table.out).toContain('serendipity');
    expect(table.out).toContain('arrived unbidden');
    expect(table.out).toMatch(/serendipity\s+~/); // the `~` approximate marker

    // A different session that PULLS the same lesson via `search` first, then
    // upvotes it: the upvote is a pull, so serendipity is 0 for that session.
    process.env.NB_SESSION = 'pull-sess';
    const searched = await run(['search', 'bounded']); // surfaces the entry, logs its id
    expect(searched.code).toBe(0);
    await run(['vote', 'patcher', 'bounded', '+1']); // upvote AFTER the search → pull
    const pullJson = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    // Deployment-wide pull evidence: the search row is shelf `-` yet the scoped
    // `nb stats patcher` still classifies the pull-session upvote correctly.
    expect(pullJson.surfacing.upvotes).toBe(2); // both sessions' upvotes counted
    expect(pullJson.surfacing.serendipity).toBe(0.5); // 1 push of 2 upvotes
  });

  test('nb search records the surfaced entry ids in the usage row (issue #114 provenance)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'retry with exponential backoff']); // accepted
    await run(['search', 'retry']);
    const searchRow = parseUsage(dir).at(-1)!;
    expect(searchRow.command).toBe('search');
    expect(searchRow.outcome).toBe('match');
    expect(searchRow.entries).toEqual([entryId('retry with exponential backoff')]);
    // A no-match search stays entry-less (keeps the failed-search gap-sensor intact).
    await run(['search', 'nonexistentterm']);
    const noMatch = parseUsage(dir).at(-1)!;
    expect(noMatch.outcome).toBe('no-match');
    expect(noMatch.entries).toEqual([]);
  });

  test('stats --json carries the surfacing metrics object (issue #81)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'alpha lesson']); // accepted
    await run(['vote', 'patcher', 'alpha', '+1']); // engages s1, one upvote
    await run(['add', 'patcher', 'alpha lesson']); // dedup-blocked
    const s = await run(['stats', 'patcher', '--json']);
    expect(s.code).toBe(0);
    const rep = JSON.parse(s.out);
    expect(rep.surfacing).toEqual({
      engagedSessions: 1,
      addAttempts: 2,
      coverage: 0.5,
      recallMiss: 0.5,
      votesActedOn: 1,
      precisionMiss: 0, // one upvote, zero downvotes
      upvotes: 1, // the single upvote (issue #114 — serendipity denominator)
      serendipity: 1, // that upvote had no same-session search → push-delivered
      readout: 'churny',
      engagementDiagnosis: null, // engaged ⇒ no zero-engagement breakdown (issue #105)
    });
  });

  test('the human stats table reports no engaged sessions when NB_SESSION is unset (issue #81)', async () => {
    delete process.env.NB_SESSION; // no session → the engagement gate finds nothing to score
    await run(['add', 'patcher', 'a lesson']);
    const s = await run(['stats', 'patcher']);
    // With NB_SESSION unset the zero-engagement line now names the blank-session
    // root cause (issue #105) rather than the old generic message.
    expect(s.out).toContain('surfacing: no engaged sessions — NB_SESSION was unset');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagedSessions).toBe(0);
    expect(json.surfacing.recallMiss).toBeNull(); // null, shown as — in the table, never a misleading 0%
    expect(json.surfacing.engagementDiagnosis.causes).toContain('blank-session');
  });

  test('zero-engagement table names the retrospective-not-landing cause (issue #105)', async () => {
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'a lesson']); // populates the notebook (not a read, not a vote)
    await run(['show', 'patcher']); // a deliberate read in s1, but no vote follows
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain("opened a notebook but cast no vote");
    expect(s.out).not.toContain('injection hook'); // a read happened ⇒ hook cause must be off
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual(['retrospective-not-landing']);
  });

  test("zero engagement with no identifiable cause falls back to the generic line (issue #105)", async () => {
    // NB_SESSION set (no blank-session), only the hook's global `nb list` ran (a
    // read ⇒ no injection-hook; not a deliberate read ⇒ no retrospective): none
    // of the three causes applies, so the original generic line is kept.
    process.env.NB_SESSION = 's1';
    await run(['add', 'patcher', 'a lesson']);
    await run(['list']); // the hook's index read (global shelf '-')
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain('surfacing: no engaged sessions in this window (set NB_SESSION');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual([]);
  });

  test('zero-engagement table names the injection-hook cause when nothing read (issue #105)', async () => {
    process.env.NB_SESSION = 's1'; // session set ⇒ not the blank-session cause
    await run(['add', 'patcher', 'a lesson']); // stored lesson, but `add` is not a read
    const s = await run(['stats', 'patcher']);
    expect(s.out).toContain('the SessionStart injection hook is probably not wired');
    const json = JSON.parse((await run(['stats', 'patcher', '--json'])).out);
    expect(json.surfacing.engagementDiagnosis.causes).toEqual(['injection-hook']);
  });

  test('unknown command exits 2', async () => {
    const r = await run(['frobnicate', 'patcher']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });

  test('a missing required argument exits 1', async () => {
    const r = await run(['show']); // no shelf
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <shelf>');
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

  test('path with no shelf prints the notebooks dir (respecting NB_DIR)', async () => {
    const r = await run(['path']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${dir}\n`); // bare path, pipeable into cat/$(...)
  });

  test('path <shelf> prints the resolved absolute shelf file path', async () => {
    const r = await run(['path', 'reviewer']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${join(dir, 'reviewer.md')}\n`);
    expect(r.out.trimEnd()).toMatch(/\/reviewer\.md$/);
  });

  test('path with an unsafe shelf name is rejected by the existing safe-shelf check', async () => {
    const r = await run(['path', '../escape']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/invalid shelf name/);
  });

  describe('list / ls / shelves — the notebook index (issue #71)', () => {
    test('empty/absent notebooks dir prints a friendly note on stderr, empty stdout, exit 0', async () => {
      const r = await run(['list']);
      expect(r.code).toBe(0);
      expect(r.out).toBe(''); // stdout stays empty so a pipe sees nothing
      expect(r.err).toMatch(/no notebooks yet/);
    });

    test('one richest-first line per notebook: name, lesson count, description', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['add', 'reviewer', 'another lesson']);
      await run(['add', 'patcher', 'b lesson']);
      await run(['describe', 'patcher', 'when fixing a reproduced bug']);
      const r = await run(['list']);
      expect(r.code).toBe(0);
      const lines = r.out.trimEnd().split('\n');
      expect(lines[0]).toBe(`agent-notebook notebooks — 2 in ${dir}`);
      // reviewer (2 lessons) outranks patcher (1) — richest first.
      expect(lines[1]).toContain('reviewer');
      expect(lines[1]).toMatch(/reviewer\s+2\s+/);
      expect(lines[2]).toContain('patcher');
      expect(lines[2]).toContain('when fixing a reproduced bug'); // explicit desc, no (auto)
      expect(lines[2]).not.toContain('(auto)');
    });

    test('ties in lesson count are broken by name, ascending', async () => {
      await run(['add', 'planner', 'x']);
      await run(['add', 'patcher', 'y']);
      await run(['add', 'reviewer', 'z']);
      const r = await run(['list']);
      const shelves = r.out.trimEnd().split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]);
      expect(shelves).toEqual(['patcher', 'planner', 'reviewer']);
    });

    test('a notebook with no description falls back to its top-scored lesson, marked (auto)', async () => {
      await run(['add', 'reviewer', 'low priority lesson']);
      await run(['add', 'reviewer', 'the important one']);
      await run(['vote', 'reviewer', 'important', '+1']); // make it the top-scored lesson
      const r = await run(['list']);
      const row = r.out.trimEnd().split('\n')[1];
      expect(row).toContain('the important one');
      expect(row).toContain('(auto)');
      expect(row).not.toContain('low priority lesson');
    });

    test('ls and shelves are aliases of list (identical output)', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['add', 'patcher', 'b lesson']);
      const list = await run(['list']);
      const ls = await run(['ls']);
      const roles = await run(['roles']);
      expect(ls.out).toBe(list.out);
      expect(roles.out).toBe(list.out);
    });

    test('a bare prefix filters by name (the `.` namespace convention)', async () => {
      await run(['add', 'review.security', 'a']);
      await run(['add', 'review.perf', 'b']);
      await run(['add', 'patcher', 'c']);
      const r = await run(['list', 'review.']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`2 matching "review." in ${dir}`);
      expect(r.out).toContain('review.security');
      expect(r.out).toContain('review.perf');
      expect(r.out).not.toContain('patcher');
    });

    test('a prefix that matches nothing prints a friendly note on stderr, exit 0', async () => {
      await run(['add', 'patcher', 'c']);
      const r = await run(['list', 'review.']);
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/no notebooks matching "review\."/);
    });

    test('--limit bounds the rows and the header reads "shown of total"', async () => {
      await run(['add', 'aaa', '1']);
      await run(['add', 'bbb', '1']);
      await run(['add', 'ccc', '1']);
      const r = await run(['list', '--limit', '2']);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`2 of 3 in ${dir}`);
      expect(r.out.trimEnd().split('\n')).toHaveLength(3); // header + 2 rows
    });

    test('an unparseable --limit warns on stderr and falls back to the default', async () => {
      await run(['add', 'reviewer', 'a']);
      const r = await run(['list', '--limit', 'abc']);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/unrecognized --limit 'abc'/);
      expect(r.out).toContain('reviewer'); // still listed with the default limit
    });

    test('--json emits the raw NotebookListing and nothing else on stdout', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      await run(['describe', 'reviewer', 'the trigger']);
      const r = await run(['list', '--json']);
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.out);
      expect(parsed.dir).toBe(dir);
      expect(parsed.total).toBe(1);
      expect(parsed.rows[0]).toEqual({ role: 'reviewer', shelf: 'reviewer', lessons: 1, desc: 'the trigger', auto: null });
    });

    test('a zero-lesson, no-description notebook is hidden (phantom debris)', async () => {
      // `nb describe <shelf> ""` on a fresh shelf writes an empty file with no
      // metadata and no entries — nothing to discover. It must not appear.
      await run(['describe', 'phantom', '']);
      await run(['add', 'real', 'a lesson']);
      const r = await run(['list']);
      expect(r.out).toContain('real');
      expect(r.out).not.toContain('phantom');
      expect(r.out).toContain(`1 in ${dir}`); // only the real notebook counts
    });

    test('a described-but-empty notebook IS shown (a deliberate trigger)', async () => {
      await run(['describe', 'placeholder', 'open me when onboarding a new repo']);
      const r = await run(['list']);
      expect(r.code).toBe(0);
      const row = r.out.trimEnd().split('\n')[1];
      expect(row).toContain('placeholder');
      expect(row).toMatch(/placeholder\s+0\s+/); // zero lessons, still listed
      expect(row).toContain('open me when onboarding a new repo');
      expect(row).not.toContain('(auto)'); // the trigger is the explicit description
    });

    test('excludes the .nb-usage.log / .nb.lock sidecars and stray non-.md files', async () => {
      await run(['add', 'reviewer', 'a lesson']);
      writeFileSync(join(dir, 'notes.txt'), 'not a notebook');
      const r = await run(['list']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('reviewer');
      expect(r.out).not.toContain('nb-usage');
      expect(r.out).not.toContain('nb.lock');
      expect(r.out).not.toContain('notes');
    });
  });

  describe('add <shelf> - reads the lesson from stdin (issue #38)', () => {
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
      expect(JSON.parse(r.out)).toEqual({ added: true, reason: 'added', evicted: null, size: 1, id: entryId('piped with json') });
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
      expect(parseOnly(r.out)).toEqual({ added: true, reason: 'added', evicted: null, size: 1, id: entryId('prefer execFileSync') });
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

    test('the flag is positional-order-independent and leaves the shelf/lesson intact', async () => {
      // --json between the shelf and the lesson must be stripped before positional
      // parsing, so the lesson is not swallowed and the shelf still resolves.
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

  describe('usage log records entry ids + outcome (issue #67)', () => {
    test('add logs the accepted outcome and the touched entry id', async () => {
      await run(['add', 'patcher', 'prefer execFileSync, array args']);
      const [row] = parseUsage(dir);
      expect(row.command).toBe('add');
      expect(row.ok).toBe(true);
      expect(row.outcome).toBe('accepted');
      expect(row.entries).toEqual([entryId('prefer execFileSync, array args')]);
    });

    test('a duplicate add logs dedup-blocked and the colliding entry id', async () => {
      await run(['add', 'patcher', 'run lint before done']);
      await run(['add', 'patcher', 'run lint before done']);
      const dupRow = parseUsage(dir).at(-1)!;
      expect(dupRow.outcome).toBe('dedup-blocked');
      expect(dupRow.collided).toBe(entryId('run lint before done'));
    });

    test('a resembling add still stores the lesson, warns on stderr, and logs the accepted row with the near-match id (FR-ADD-008)', async () => {
      process.env.NB_NEAR_DUP = '0.4';
      await run(['add', 'patcher', 'run lint before claiming done']);
      const nearId = entryId('run lint before claiming done');
      const r = await run(['add', 'patcher', 'run lint before claiming complete']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('added —'); // the lesson WAS stored (stdout, pipe-clean)
      expect(r.err).toContain('resembles'); // the advisory went to stderr
      expect(r.err).toContain(nearId);
      expect(r.err).toContain('nb merge');
      // The accepted row carries the resemblance as the measurable near-dup
      // signal — read it NOW, before any later command appends its own row.
      const row = parseUsage(dir).at(-1)!;
      expect(row.outcome).toBe('accepted');
      expect(row.collided).toBe(nearId);
      // Both lessons are kept — the advisory never blocks.
      expect((await run(['show', 'patcher'])).out).toContain('run lint before claiming complete');
      delete process.env.NB_NEAR_DUP;
    });

    test('a resembling add --json carries nearId; a dissimilar add does not warn', async () => {
      process.env.NB_NEAR_DUP = '0.4';
      await run(['add', 'patcher', 'run lint before claiming done']);
      const j = await run(['add', 'patcher', 'run lint before claiming complete', '--json']);
      expect(JSON.parse(j.out).nearId).toBe(entryId('run lint before claiming done'));
      const far = await run(['add', 'patcher', 'rotate the TLS certificate yearly']);
      expect(far.err).not.toContain('resembles');
      delete process.env.NB_NEAR_DUP;
    });

    test('vote logs the direction and the voted entry id', async () => {
      await run(['add', 'patcher', 'alpha lesson']);
      await run(['vote', 'patcher', 'alpha', '+1']);
      const voteRow = parseUsage(dir).at(-1)!;
      expect(voteRow.command).toBe('vote');
      expect(voteRow.outcome).toBe('up');
      expect(voteRow.entries).toEqual([entryId('alpha lesson')]);
    });

    test('NB_SESSION is threaded onto every row the call writes', async () => {
      process.env.NB_SESSION = 'cli-session-7';
      await run(['add', 'patcher', 'session threaded lesson']);
      expect(parseUsage(dir).at(-1)!.session).toBe('cli-session-7');
    });

    test('a read-only command (show) logs blank richer fields', async () => {
      await run(['show', 'patcher']);
      const [row] = parseUsage(dir);
      expect(row.command).toBe('show');
      expect(row.entries).toEqual([]);
      expect(row.outcome).toBe('');
      expect(row.session).toBe('');
    });
  });

  describe('split (issue #68)', () => {
    test('splits one entry into two, reflected by show', async () => {
      await run(['add', 'patcher', 'build then test the change']);
      const s = await run(['split', 'patcher', 'build', 'build the change', 'test the change after building']);
      expect(s.code).toBe(0);
      expect(s.out).toContain('split one entry into two');
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('build the change');
      expect(show.out).toContain('test the change after building');
      expect(show.out).not.toContain('build then test the change');
    });

    test('a missing lesson argument exits 1', async () => {
      await run(['add', 'patcher', 'overloaded entry here']);
      const r = await run(['split', 'patcher', 'overloaded', 'only one half']); // no second lesson
      expect(r.code).toBe(1);
      expect(r.err).toContain('missing <lessonB>');
    });

    test('an over-length half exits 1 and leaves the notebook unchanged', async () => {
      process.env.NB_MAX_CHARS = '30';
      await run(['add', 'patcher', 'overloaded entry']);
      const r = await run(['split', 'patcher', 'overloaded', 'short half', 'z'.repeat(50)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('max is 30');
      const show = await run(['show', 'patcher']);
      expect(show.out).toContain('overloaded entry'); // original intact
    });

    test('--json prints the SplitResult (source + two ids)', async () => {
      await run(['add', 'patcher', 'alpha and beta crammed in']);
      const r = await run(['split', 'patcher', 'alpha', 'alpha half of it', 'beta half of it', '--json']);
      expect(r.code).toBe(0);
      const obj = JSON.parse(r.out.trim());
      expect(obj.size).toBe(2);
      expect(obj.source).toBe(entryId('alpha and beta crammed in'));
      expect(obj.ids).toEqual([entryId('alpha half of it'), entryId('beta half of it')]);
    });

    test('logs the split outcome, the source+produced ids, and a recognized reason', async () => {
      await run(['add', 'patcher', 'two lessons in one line']);
      await run(['split', 'patcher', 'two lessons', 'first lesson alone', 'second lesson alone', '--reason', 'overloaded']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('split');
      expect(row.outcome).toBe('split');
      expect(row.reason).toBe('overloaded');
      expect(row.entries).toEqual([
        entryId('two lessons in one line'),
        entryId('first lesson alone'),
        entryId('second lesson alone'),
      ]);
    });

    test('an unrecognized reason is logged as other with the code kept in the note', async () => {
      await run(['add', 'patcher', 'overloaded compound lesson']);
      await run(['split', 'patcher', 'overloaded', 'half one here', 'half two here', '--reason', 'redundant', '--note', 'felt mixed']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.reason).toBe('other');
      expect(row.note).toBe('redundant: felt mixed');
    });

    test('--reason without a value exits 1 (never silently dropped)', async () => {
      await run(['add', 'patcher', 'overloaded compound lesson']);
      const r = await run(['split', 'patcher', 'overloaded', 'half one here', 'half two here', '--reason']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('--reason needs a value');
    });
  });

  describe('operation reasons on add/merge/rm (issue #69)', () => {
    test('merge logs a recognized reason (duplicate)', async () => {
      await run(['add', 'patcher', 'run the build first']);
      await run(['add', 'patcher', 'build before running tests']);
      const m = await run(['merge', 'patcher', 'run the build', 'build before', 'run the build before tests', '--reason', 'duplicate']);
      expect(m.code).toBe(0);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('merge');
      expect(row.outcome).toBe('merged');
      expect(row.reason).toBe('duplicate');
    });

    test('rm logs a recognized reason (obsolete) and the removed id', async () => {
      await run(['add', 'patcher', 'use the --cache flag always']);
      const r = await run(['rm', 'patcher', 'cache flag', '--reason', 'obsolete', '--note', 'flag was removed in v3']);
      expect(r.code).toBe(0);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('rm');
      expect(row.outcome).toBe('removed');
      expect(row.reason).toBe('obsolete');
      expect(row.note).toBe('flag was removed in v3');
      expect(row.entries).toEqual([entryId('use the --cache flag always')]);
    });

    test('rm with an unrecognized code is logged as other, code kept in the note', async () => {
      await run(['add', 'patcher', 'a lesson to drop']);
      await run(['rm', 'patcher', 'lesson to drop', '--reason', 'stale', '--note', 'no longer relevant']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.reason).toBe('other');
      expect(row.note).toBe('stale: no longer relevant');
    });

    test('add records a free-text note with an empty reason (no enum yet)', async () => {
      await run(['add', 'patcher', 'prefer execFileSync over execSync', '--note', 'learned from a shell-injection bug']);
      const row = parseUsage(dir).at(-1)!;
      expect(row.command).toBe('add');
      expect(row.outcome).toBe('accepted');
      expect(row.reason).toBe('');
      expect(row.note).toBe('learned from a shell-injection bug');
    });

    test('merge --reason without a value exits 1 (never silently dropped)', async () => {
      await run(['add', 'patcher', 'first lesson line']);
      await run(['add', 'patcher', 'second lesson line']);
      const r = await run(['merge', 'patcher', 'first lesson', 'second lesson', 'merged line', '--reason']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('--reason needs a value');
    });
  });
});

describe('nb move (score-preserving cross-shelf move, issue #103)', () => {
  test('moves an entry to another shelf keeping its score, and reports both sizes', async () => {
    await run(['add', 'thin', 'use execFileSync with array args']);
    await run(['vote', 'thin', 'execFileSync', '+1']); // score +2
    const m = await run(['move', 'thin', 'broad', 'execFileSync']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('moved [+2]');
    expect(m.out).toContain('"thin" now 0');
    expect(m.out).toContain('"broad" now 1');
    // the score survived the move — `show` on the target prints [+2], not the +1 add floor
    const show = await run(['show', 'broad']);
    expect(show.out).toMatch(/\[\+2\]\s+use execFileSync with array args/);
    expect((await run(['show', 'thin'])).out).toContain('is empty');
  });

  test('--json emits a MoveResult with the preserved score', async () => {
    await run(['add', 'from', 'portable lesson']);
    await run(['vote', 'from', 'portable', '+1']); // +2
    const m = await run(['move', '--json', 'from', 'to', 'portable']);
    expect(m.code).toBe(0);
    const r = JSON.parse(m.out);
    expect(r.reason).toBe('moved');
    expect(r.score).toBe(2);
    expect(r.id).toBe(entryId('portable lesson'));
    expect(r.fromSize).toBe(0);
    expect(r.toSize).toBe(1);
  });

  test('a near-duplicate in the target is skipped (exit 0), leaving the source intact', async () => {
    await run(['add', 'from', 'prefer execFileSync, array args']);
    await run(['add', 'to', 'prefer execfilesync array args']); // dedup-equal
    const m = await run(['move', 'from', 'to', 'execFileSync']);
    expect(m.code).toBe(0);
    expect(m.out).toContain('skipped');
    expect((await run(['show', 'from'])).out).toContain('prefer execFileSync');
  });

  test('moving into the same shelf exits 1', async () => {
    await run(['add', 's', 'only lesson']);
    const m = await run(['move', 's', 's', 'only']);
    expect(m.code).toBe(1);
    expect(m.err).toContain('two different shelves');
  });

  test('a missing operand exits 1', async () => {
    await run(['add', 'from', 'x']);
    const m = await run(['move', 'from', 'to']); // no selector
    expect(m.code).toBe(1);
    expect(m.err).toContain('missing <id|query>');
  });

  test('logs the move attributed to the source shelf, with the recognized reason', async () => {
    process.env.NB_SESSION = 'cli-move-1';
    await run(['add', 'from', 'a durable lesson']);
    await run(['move', 'from', 'to', 'durable', '--reason', 'consolidate']);
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('move');
    expect(row.role).toBe('from'); // attributed to the source shelf
    expect(row.outcome).toBe('moved');
    expect(row.reason).toBe('consolidate');
    expect(row.entries).toEqual([entryId('a durable lesson')]);
  });

  test('an unrecognized move reason is logged as other, code kept in the note', async () => {
    await run(['add', 'from', 'another lesson']);
    await run(['move', 'from', 'to', 'another', '--reason', 'tidying', '--note', 'end of sprint']);
    const row = parseUsage(dir).at(-1)!;
    expect(row.command).toBe('move');
    expect(row.reason).toBe('other');
    expect(row.note).toBe('tidying: end of sprint');
  });
});

// The CLI entrypoint is `settleCliExit(runNbCli(...))`. `runNbCli` try/catches
// every handled command error and resolves with an exit code, so no input makes
// the real promise reject today — the `.catch` guards against a *future* bug in
// the wrapper. These tests drive `settleCliExit` directly with synthetic
// promises to prove the contract: a rejection yields exit code 1 + a stderr
// line (so a crash can't look like success — DP-5), and a resolution forwards
// the code (so the happy path keeps exiting 0).
describe('settleCliExit', () => {
  // Mutating process.exitCode would otherwise leak into vitest's own exit; each
  // test captures stderr and restores both exitCode and stderr.write afterwards.
  async function withSettle(
    result: Promise<number>,
  ): Promise<{ exitCode: typeof process.exitCode; err: string }> {
    const savedExit = process.exitCode;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = '';
    // @ts-expect-error — test shim for capturing writes
    process.stderr.write = (s: string) => ((err += s), true);
    try {
      await settleCliExit(result);
      return { exitCode: process.exitCode, err };
    } finally {
      process.stderr.write = origErr;
      process.exitCode = savedExit;
    }
  }

  test('a rejected promise sets exit code 1 and writes a stderr line', async () => {
    const { exitCode, err } = await withSettle(Promise.reject(new Error('boom in the wrapper')));
    expect(exitCode).toBe(1);
    expect(err).toContain('boom in the wrapper');
    expect(err).toMatch(/^nb: fatal:/);
  });

  test('a non-Error rejection is stringified, still exit 1', async () => {
    const { exitCode, err } = await withSettle(Promise.reject('plain string failure'));
    expect(exitCode).toBe(1);
    expect(err).toContain('plain string failure');
  });

  test('an Error with no stack falls back to its message', async () => {
    const stackless = new Error('no-stack failure');
    stackless.stack = undefined;
    const { exitCode, err } = await withSettle(Promise.reject(stackless));
    expect(exitCode).toBe(1);
    expect(err).toContain('no-stack failure');
  });

  test('a resolved promise forwards the exit code and writes nothing to stderr', async () => {
    const zero = await withSettle(Promise.resolve(0));
    expect(zero.exitCode).toBe(0);
    expect(zero.err).toBe('');

    const two = await withSettle(Promise.resolve(2));
    expect(two.exitCode).toBe(2);
    expect(two.err).toBe('');
  });
});

describe('nb describe (issue #70)', () => {
  test('sets a description, then prints it back with no text operand', async () => {
    const set = await run(['describe', 'patcher', 'build / test gotchas for this repo']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('description set for shelf "patcher"');
    const get = await run(['describe', 'patcher']);
    expect(get.code).toBe(0);
    expect(get.out).toBe('build / test gotchas for this repo\n'); // bare line, pipe-friendly
  });

  test('`nb show` prints the description as a header above the lessons', async () => {
    await run(['add', 'patcher', 'run build before test']);
    await run(['describe', 'patcher', 'when debugging CI']);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out.split('\n')[0]).toBe('# desc: when debugging CI'); // header first
    expect(show.out).toContain('run build before test');
  });

  test('a notebook with no description shows no header (unchanged output)', async () => {
    await run(['add', 'patcher', 'a lesson']);
    const show = await run(['show', 'patcher']);
    expect(show.out.startsWith('#')).toBe(false);
    expect(show.out).toContain('a lesson');
  });

  test('reading a description that is not set warns on stderr (exit 0)', async () => {
    const get = await run(['describe', 'ghost']);
    expect(get.code).toBe(0);
    expect(get.out).toBe('');
    expect(get.err).toContain('no description set for shelf "ghost"');
  });

  test('an over-long description is rejected (exit 1), never truncated', async () => {
    process.env.NB_MAX_CHARS = '20';
    const r = await run(['describe', 'patcher', 'x'.repeat(21)]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/21 chars; max is 20/);
    expect((await run(['describe', 'patcher'])).err).toContain('no description set'); // nothing stored
  });

  test('the description round-trips through a later `add`', async () => {
    await run(['describe', 'patcher', 'the trigger']);
    await run(['add', 'patcher', 'a lesson']);
    expect((await run(['describe', 'patcher'])).out).toBe('the trigger\n');
  });

  test('an empty text operand clears the description', async () => {
    await run(['describe', 'patcher', 'temporary']);
    const clear = await run(['describe', 'patcher', '']);
    expect(clear.code).toBe(0);
    expect(clear.out).toContain('description cleared');
    expect((await run(['describe', 'patcher'])).err).toContain('no description set');
  });

  test('--json emits a structured result for both set and read', async () => {
    const set = await run(['describe', 'patcher', 'json trigger', '--json']);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.out)).toEqual({ role: 'patcher', shelf: 'patcher', desc: 'json trigger', set: true });
    const get = await run(['describe', 'patcher', '--json']);
    expect(JSON.parse(get.out)).toEqual({ role: 'patcher', shelf: 'patcher', desc: 'json trigger', set: false });
  });

  test('describe set is recorded in the usage log with a described outcome', async () => {
    await run(['describe', 'patcher', 'logged trigger']);
    const rows = parseUsage(dir).filter((r) => r.command === 'describe');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)!.outcome).toBe('described');
    expect(rows.at(-1)!.ok).toBe(true);
  });

  // Issue #91: `describe` must strip `--reason`/`--note` before reading its text
  // operand, like the other mutating commands — otherwise an option placed before
  // the text is silently stored as the description (a DP-5 violation).
  test('a --reason before the text is stripped, never stored as the description', async () => {
    const set = await run(['describe', 'patcher', '--reason', 'other', 'real text']);
    expect(set.code).toBe(0);
    expect(set.out).toContain('description set for shelf "patcher": real text');
    expect((await run(['describe', 'patcher'])).out).toBe('real text\n'); // the real text, not "--reason"
  });

  test('describe logs a stripped --reason/--note (bucketed to other, code kept in note)', async () => {
    await run(['describe', 'patcher', '--reason', 'triage', '--note', 'from a hook', 'the trigger']);
    const row = parseUsage(dir).filter((r) => r.command === 'describe').at(-1)!;
    expect(row.outcome).toBe('described');
    expect(row.reason).toBe('other'); // describe has no enum yet, so any code buckets to other
    expect(row.note).toBe('triage: from a hook'); // original code preserved for mining
  });

  test('--reason/--note after the text are also consumed, not treated as a second operand', async () => {
    const set = await run(['describe', 'patcher', 'the trigger', '--note', 'why']);
    expect(set.code).toBe(0);
    expect((await run(['describe', 'patcher'])).out).toBe('the trigger\n');
  });

  test('describe --reason without a value exits 1 (never silently dropped)', async () => {
    const r = await run(['describe', 'patcher', 'some text', '--reason']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--reason needs a value');
  });

  test('only a --reason and no text operand still reads, not sets (description stays unset)', async () => {
    const r = await run(['describe', 'patcher', '--reason', 'other']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('no description set for shelf "patcher"'); // read path, nothing stored
  });
});

describe('nb search — the demoted keyword fallback (issue #82)', () => {
  test('groups hits by notebook and prints each lesson id so the agent can vote it later', async () => {
    await run(['add', 'reviewer', 'run the build before vitest']);
    await run(['add', 'patcher', 'build the sandbox image first']);
    const r = await run(['search', 'build']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('reviewer');
    expect(r.out).toContain('patcher');
    expect(r.out).toContain('run the build before vitest');
    // Each hit line leads with the entry's stable id, as `nb show` does.
    expect(r.out).toMatch(/^\s+[0-9a-f]{6}\s+\[\+1\]\s+run the build before vitest/m);
  });

  test('the output names itself the secondary path (surfacing is primary)', async () => {
    await run(['add', 'reviewer', 'a lesson about locks']);
    const r = await run(['search', 'locks']);
    expect(r.out.toLowerCase()).toContain('secondary');
  });

  test('AND by default; --any switches to OR', async () => {
    await run(['add', 'reviewer', 'fresh worktree off origin main']);
    await run(['add', 'patcher', 'a mkdir spinlock guards the file']);
    const and = await run(['search', 'worktree spinlock']);
    expect(and.err).toContain('no lessons match'); // no single entry has both
    const or = await run(['search', 'worktree spinlock', '--any']);
    expect(or.code).toBe(0);
    expect(or.out).toContain('reviewer');
    expect(or.out).toContain('patcher');
  });

  test('a bare prefix operand scopes the search by shelf name', async () => {
    await run(['add', 'review.security', 'sanitize the lock input']);
    await run(['add', 'patcher', 'the lock is a spinlock']);
    const scoped = await run(['search', 'lock', 'review.']);
    expect(scoped.out).toContain('review.security');
    expect(scoped.out).not.toContain('\n  patcher');
  });

  test('a no-match search exits 0 (not an error), writes nothing to stdout, and notes the gap on stderr', async () => {
    await run(['add', 'reviewer', 'a stored lesson']);
    const r = await run(['search', 'absent-keyword']);
    expect(r.code).toBe(0); // found nothing is success, like a dedup-blocked add
    expect(r.out).toBe('');
    expect(r.err).toContain('no lessons match');
    expect(r.err.toLowerCase()).toContain('coverage gap');
  });

  test('--json emits the raw SearchResult', async () => {
    await run(['add', 'reviewer', 'run the build before vitest']);
    const r = await run(['search', 'vitest', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.terms).toEqual(['vitest']);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].shelf).toBe('reviewer');
    expect(parsed.groups[0].hits[0].id).toBe(entryId('run the build before vitest'));
  });

  test('the search is logged with a match/no-match outcome and the query in note (the gap-sensor row)', async () => {
    await run(['add', 'reviewer', 'a lesson about caching']);
    await run(['search', 'caching']);
    await run(['search', 'nothing-here']);
    const rows = parseUsage(dir).filter((r) => r.command === 'search');
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('match');
    expect(rows[0].note).toBe('caching');
    expect(rows[1].outcome).toBe('no-match');
    expect(rows[1].note).toBe('nothing-here');
    expect(rows[0].role).toBe('-'); // spans notebooks, like `list`
  });

  test('a missing query argument is a handled error (exit 1)', async () => {
    const r = await run(['search']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <query>');
  });

  test('a whitespace-only query logs no-terms (not no-match), so it is never a false coverage gap', async () => {
    process.env.NB_SESSION = 'cli-blank';
    const r = await run(['search', '   ']);
    expect(r.code).toBe(0);
    const row = parseUsage(dir).filter((x) => x.command === 'search').at(-1)!;
    expect(row.outcome).toBe('no-terms'); // not 'no-match' — the gap-sensor keys on no-match
    // A following add in the same session must NOT be flagged as a failed-search gap.
    await run(['add', 'reviewer', 'a lesson added after an empty search']);
    await run(['vote', 'reviewer', 'added after', '+1']);
    const stats = await run(['stats', '--json']);
    const signals = JSON.parse(stats.out).signals as { kind: string }[];
    expect(signals.some((s) => s.kind === 'failed-search')).toBe(false);
  });

  test('end-to-end: a failed CLI search then an add in the same session surfaces a failed-search signal', async () => {
    process.env.NB_SESSION = 'cli-gap';
    await run(['search', 'retry backoff']); // no notebooks yet → no-match
    await run(['add', 'reviewer', 'use exponential backoff on retries']);
    await run(['vote', 'reviewer', 'backoff', '+1']); // engagement, and exercises the normal path
    const stats = await run(['stats', '--json']);
    const report = JSON.parse(stats.out);
    const gap = report.signals.find((s: { kind: string }) => s.kind === 'failed-search');
    expect(gap).toBeDefined();
    expect(gap.shelf).toBe('reviewer');
    expect(gap.detail).toContain('retry backoff');
  });
});

describe('shelf terminology (role kept as a deprecated alias)', () => {
  test('show/list/search/stats --json carry `shelf` equal to the deprecated `role`', async () => {
    await run(['add', 'reviewer', 'check the lock file']);
    await run(['describe', 'reviewer', 'when reviewing']);

    const show = JSON.parse((await run(['show', 'reviewer', '--json'])).out);
    expect(show.shelf).toBe('reviewer');
    expect(show.shelf).toBe(show.role);

    const list = JSON.parse((await run(['list', '--json'])).out);
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].shelf).toBe(list.rows[0].role);
    expect(list.rows[0].shelf).toBe('reviewer');

    const search = JSON.parse((await run(['search', 'lock', '--json'])).out);
    expect(search.groups).toHaveLength(1);
    expect(search.groups[0].shelf).toBe(search.groups[0].role);
    expect(search.groups[0].shelf).toBe('reviewer');

    const st = JSON.parse((await run(['stats', '--json'])).out);
    expect(st.notebooks).toHaveLength(1);
    expect(st.notebooks[0].shelf).toBe(st.notebooks[0].role);
    expect(st.notebooks[0].shelf).toBe('reviewer');
    expect(st.notebookTotals.shelves).toBe(st.notebookTotals.roles);
    expect(st.notebookTotals.shelves).toBe(1);
  });

  test('`nb shelves` and `nb roles` print exactly what `nb list` prints', async () => {
    await run(['add', 'reviewer', 'a lesson']);
    await run(['add', 'patcher', 'another lesson']);
    const list = await run(['list']);
    const shelves = await run(['shelves']);
    const roles = await run(['roles']);
    expect(shelves.code).toBe(0);
    expect(shelves.out).toBe(list.out);
    expect(roles.out).toBe(list.out);
    expect(list.out).toContain('reviewer');
    const json = await run(['shelves', '--json']);
    expect(JSON.parse(json.out)).toEqual(JSON.parse((await run(['list', '--json'])).out));
  });

  test('help documents <shelf> and `nb shelves`, not <role>', async () => {
    const r = await run(['--help']);
    expect(r.out).toContain('<shelf>');
    expect(r.out).toContain('nb shelves');
    expect(r.out).not.toContain('<role>');
  });

  test('help states the line cap as 50 (matching maxLines and the README), not the stale 200 (issue #116)', async () => {
    const r = await run(['--help']);
    expect(r.out).toContain('at most 50 lines');
    expect(r.out).not.toContain('at most 200 lines');
  });

  test('help lists failed-search alongside the other three diagnostic signals (issue #116)', async () => {
    const r = await run(['--help']);
    // All four signals `nb stats` emits are documented...
    for (const kind of ['browse-without-use', 'eviction-while-still-voted', 'vote-reversal', 'failed-search']) {
      expect(r.out).toContain(kind);
    }
    // ...and failed-search is listed in the diagnostic-signals bullet itself, not only in the
    // `nb search` description where the token already appeared. Pin the specific entry text.
    expect(r.out).toContain('and failed-search (a search returned nothing');
  });
});
