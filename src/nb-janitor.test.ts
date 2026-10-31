import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// End-to-end coverage for the offline janitor's section 5 — shelf co-access
// (issue #107). The janitor is a standalone zero-dependency Node script, so we
// drive the REAL script with `node examples/nb-janitor.mjs` against a seeded
// temp NB_DIR and assert the rendered output and `--json`, exactly as a user
// runs it — not an in-process import of refactored internals.
const here = dirname(fileURLToPath(import.meta.url));
const janitor = join(here, '..', 'examples', 'nb-janitor.mjs');
const TS = '2026-10-31T12:00:00.000Z'; // fixed, recent enough to be in every window

// One usage-log row. Columns (see logUsage): ts, shelf, command, status, ms,
// session, … — co-access only needs the first six.
function row(shelf: string, command: string, session: string): string {
  return `${TS}\t${shelf}\t${command}\tok\t2ms\t${session}`;
}

let dir: string;
function seed(rows: string[]): void {
  writeFileSync(join(dir, '.nb-usage.log'), rows.join('\n') + '\n', 'utf-8');
}
function runHuman(): string {
  return execFileSync('node', [janitor], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' });
}
type CoAccess = {
  computed: boolean;
  sessions: number;
  highPairs: { a: string; b: string; co: number; support: number; ratio: number }[];
  isolated: { shelf: string; shows: number }[];
};
function runJson(): { coAccess: CoAccess } {
  const out = execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' });
  return JSON.parse(out);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-janitor-coaccess-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-janitor section 5 — shelf co-access (issue #107)', () => {
  test('a store with known co-open sessions yields the expected pair count and ratio', () => {
    // patcher + repo-cartographer shown together in 3 sessions; nothing else.
    seed([
      row('patcher', 'show', 's1'),
      row('repo-cartographer', 'show', 's1'),
      row('patcher', 'show', 's2'),
      row('repo-cartographer', 'show', 's2'),
      row('patcher', 'show', 's3'),
      row('repo-cartographer', 'show', 's3'),
    ]);
    const { coAccess } = runJson();
    expect(coAccess.computed).toBe(true);
    expect(coAccess.sessions).toBe(3);
    expect(coAccess.highPairs).toEqual([
      { a: 'patcher', b: 'repo-cartographer', co: 3, support: 3, ratio: 1 },
    ]);
    expect(coAccess.isolated).toEqual([]); // both are paired

    const human = runHuman();
    expect(human).toContain('── 5. Shelf co-access');
    expect(human).toContain('"patcher" + "repo-cartographer" — shown together in 3/3 session(s) (co-access 1)');
    expect(human).toContain('almost always opened together');
  });

  test('a shelf shown but never alongside another is reported as isolated', () => {
    seed([
      row('patcher', 'show', 's1'),
      row('repo-cartographer', 'show', 's1'), // a real pair, so ≥2 shelves shown overall
      row('patcher', 'show', 's2'),
      row('repo-cartographer', 'show', 's2'),
      row('changelog', 'show', 's3'), // alone
      row('changelog', 'show', 's4'), // alone again
    ]);
    const { coAccess } = runJson();
    expect(coAccess.isolated).toEqual([{ shelf: 'changelog', shows: 2 }]);
    const human = runHuman();
    expect(human).toContain('🏝️  changelog: shown in 2 session(s), never alongside another shelf — isolated.');
  });

  test('blank-session logs degrade to a one-line note, not an error (exit 0)', () => {
    // Two shows that WOULD be a pair, but both sessions are blank.
    seed([row('patcher', 'show', ''), row('repo-cartographer', 'show', '')]);
    const { coAccess } = runJson();
    expect(coAccess).toEqual({ computed: false, sessions: 0, highPairs: [], isolated: [] });

    // Human report degrades to the note and still exits 0 (execFileSync throws on nonzero).
    const human = runHuman();
    expect(human).toContain('no sessions with NB_SESSION set — co-access not computed');
    expect(human).toContain('── 5. Shelf co-access');
    // No pair/isolated lines leaked through the degrade path.
    expect(human).not.toContain('almost always opened together');
    expect(human).not.toContain('isolated.');
  });

  test('a pair sharing only ONE session is below support and is not reported (pins COACCESS_MIN_SUPPORT=2)', () => {
    // co=1, ratio=1.0 — only the min-support guard keeps it out. If MIN_SUPPORT
    // were 1, this would surface.
    seed([row('patcher', 'show', 's1'), row('repo-cartographer', 'show', 's1')]);
    const { coAccess } = runJson();
    expect(coAccess.highPairs).toEqual([]);
    expect(coAccess.isolated).toEqual([]); // they DO co-occur (co=1), so neither is isolated
    expect(runHuman()).toContain('✅ no pair of shelves is almost always opened together.');
  });

  test('a pair co-shown twice but with a low ratio is not reported (pins COACCESS_MIN_RATIO=0.8)', () => {
    // patcher & repo-cartographer co-shown in 2 sessions, but each is ALSO shown
    // alone 3 more times → shows=5 each, ratio = 2/5 = 0.4 < 0.8. co=2 meets
    // support, so only the ratio guard excludes it.
    seed([
      row('patcher', 'show', 'c1'),
      row('repo-cartographer', 'show', 'c1'),
      row('patcher', 'show', 'c2'),
      row('repo-cartographer', 'show', 'c2'),
      row('patcher', 'show', 'p1'),
      row('patcher', 'show', 'p2'),
      row('patcher', 'show', 'p3'),
      row('repo-cartographer', 'show', 'r1'),
      row('repo-cartographer', 'show', 'r2'),
      row('repo-cartographer', 'show', 'r3'),
    ]);
    const { coAccess } = runJson();
    expect(coAccess.highPairs).toEqual([]); // ratio 0.4 is below 0.8
    expect(coAccess.isolated).toEqual([]); // they co-occur, so neither is isolated
  });

  test('only `show` establishes co-access — a non-show command in the session is ignored (pins the command guard)', () => {
    // `add b` shares each session with `show a`. If any command counted, (a,b)
    // would be a co=2/ratio=1.0 high pair. With show-only, b is never "shown",
    // only a is shown (1 shelf) → no pair, no isolated.
    seed([
      row('a', 'show', 's1'),
      row('b', 'add', 's1'),
      row('a', 'show', 's2'),
      row('b', 'add', 's2'),
    ]);
    const { coAccess } = runJson();
    expect(coAccess.highPairs).toEqual([]);
    expect(coAccess.isolated).toEqual([]); // only 'a' was shown → <2 shelves, isolation not meaningful
  });

  test('isolation needs ≥2 distinct shelves shown — a lone shelf is not flagged (pins the ≥2 guard)', () => {
    seed([row('patcher', 'show', 's1'), row('patcher', 'show', 's2')]);
    const { coAccess } = runJson();
    expect(coAccess.computed).toBe(true); // a shelf WAS shown
    expect(coAccess.isolated).toEqual([]); // but only one shelf overall → not meaningful
    expect(runHuman()).toContain('✅ no isolated shelf');
  });

  test('a show with a blank shelf but a real session does not create a phantom shelf (pins the shelf guard)', () => {
    // The only show has an empty shelf field. It must be skipped, leaving no
    // shelf shown → degrade. If blank shelves counted, computed would be true.
    seed([row('', 'show', 's1')]);
    const { coAccess } = runJson();
    expect(coAccess.computed).toBe(false);
    expect(coAccess.sessions).toBe(0);
  });

  test('high pairs are ordered by ratio descending (pins the sort)', () => {
    // Pair (x,y): co=2, shows 2 each → ratio 1.0. Pair (x,z): co=2, but x shown
    // 2 extra times with y only? Build z with lower ratio: z shown 3 sessions,
    // co with x = 2 → ratio 2/min(shows(x),3). Keep shows(x) high enough that
    // (x,z) ratio (2/3≈0.67)… too low. Instead make both ≥0.8 but distinct.
    seed([
      // (x,y): both shown only together, 3 sessions → ratio 1.0
      row('x', 'show', 'xy1'),
      row('y', 'show', 'xy1'),
      row('x', 'show', 'xy2'),
      row('y', 'show', 'xy2'),
      row('x', 'show', 'xy3'),
      row('y', 'show', 'xy3'),
      // (m,n): co=4, and each shown once more alone → shows=5 each → ratio 4/5 = 0.8
      row('m', 'show', 'mn1'),
      row('n', 'show', 'mn1'),
      row('m', 'show', 'mn2'),
      row('n', 'show', 'mn2'),
      row('m', 'show', 'mn3'),
      row('n', 'show', 'mn3'),
      row('m', 'show', 'mn4'),
      row('n', 'show', 'mn4'),
      row('m', 'show', 'm5'),
      row('n', 'show', 'n5'),
    ]);
    const { coAccess } = runJson();
    const ratios = coAccess.highPairs.map((p) => p.ratio);
    expect(ratios.length).toBe(2);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a)); // descending
    expect(ratios[0]).toBe(1); // (x,y) first
    expect(ratios[1]).toBe(0.8); // (m,n) second
  });
});
