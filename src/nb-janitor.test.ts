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

// Section 2 — near-duplicate shelf names. A shelf is `role@project` (or just
// `role`, and the role may use the `.`-namespace convention). Two shelves fragment
// memory only when they are near-duplicate ROLES within the SAME project scope and
// are not intentional `.`-namespace siblings. Shelf discovery is by `<name>.md`
// filename, so these tests seed files, not a usage log.
describe('nb-janitor section 2 — scope-aware shelf-name dedup', () => {
  function mkShelf(name: string): void {
    writeFileSync(join(dir, `${name}.md`), '# scope: global\n1\ta lesson\n', 'utf-8');
  }
  function shelfDups(): { a: string; b: string; sim: number }[] {
    const out = execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' });
    return JSON.parse(out).shelfDups;
  }

  test('different roles in the SAME project scope are not flagged (issue: @project false positive)', () => {
    mkShelf('orchestrator@jeanibarz-knowledge-base-mcp-server');
    mkShelf('patch-author@jeanibarz-knowledge-base-mcp-server');
    expect(shelfDups()).toEqual([]);
  });

  test('the SAME role in different project scopes is not flagged (pins the scope guard)', () => {
    mkShelf('repo-cartographer@project-a');
    mkShelf('repo-cartographer@project-b');
    expect(shelfDups()).toEqual([]);
  });

  test('a genuine near-duplicate role within one scope is still flagged (detection survives)', () => {
    mkShelf('code-review');
    mkShelf('code-reviews');
    const dups = shelfDups();
    expect(dups.length).toBe(1);
    expect([dups[0].a, dups[0].b].sort()).toEqual(['code-review', 'code-reviews']);
    expect(dups[0].sim).toBeGreaterThanOrEqual(0.8);
  });

  test('a role typo within the same project scope is still flagged', () => {
    mkShelf('orchestrator@proj');
    mkShelf('orchestratr@proj'); // dropped an 'o' — a typo split
    const dups = shelfDups();
    expect(dups.length).toBe(1);
    expect(dups[0].sim).toBeGreaterThanOrEqual(0.8);
  });

  test('intentional `.`-namespace siblings sharing a stem are not flagged (regression: PR #113 review)', () => {
    // `build.ci` / `build.cd` are edit-close (sim 0.88) but are the documented
    // `.`-namespace convention, not fragmentation. Must be suppressed.
    mkShelf('build.ci');
    mkShelf('build.cd');
    expect(shelfDups()).toEqual([]);
  });

  test('`.`-namespace siblings composed with an `@project` scope are not flagged', () => {
    // The `.` convention composes with `@` (README: `review.tests@your-repo`).
    // Use edit-close roles sharing a stem (`build.ci`/`build.cd`, sim 0.88) so this
    // genuinely pins the `.`-stem guard in the composed case — without it they flag.
    mkShelf('build.ci@your-repo');
    mkShelf('build.cd@your-repo');
    expect(shelfDups()).toEqual([]);
  });
});

describe('nb-janitor section 6 — curation: unreinforced +1-floor lessons (#223)', () => {
  // A shelf file: lessons is a list of [score, text]; an optional desc line.
  function mkShelf(name: string, lessons: [number, string][], desc?: string): void {
    const head = desc ? `# desc: ${desc}\n` : '';
    const body = lessons.map(([s, t]) => `${s >= 0 ? '+' : ''}${s}\t${t}`).join('\n');
    writeFileSync(join(dir, `${name}.md`), head + body + '\n', 'utf-8');
  }
  function voteRow(shelf: string, session: string, outcome: 'up' | 'down'): string {
    // ts, shelf, command, status, ms, session, entries, outcome
    return `${TS}\t${shelf}\tvote\tok\t2ms\t${session}\tabc123\t${outcome}`;
  }
  function json(): {
    curation: {
      windowUpvotes: number;
      windowDownvotes: number;
      floorShelves: { shelf: string; floor: number; total: number; fraction: number }[];
    };
  } {
    const out = execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  test('counts window upvotes vs downvotes and reports the one-sidedness', () => {
    mkShelf('v', [[1, 'a']]);
    seed([voteRow('v', 's1', 'up'), voteRow('v', 's1', 'up'), voteRow('v', 's2', 'down')]);
    const c = json().curation;
    expect(c.windowUpvotes).toBe(2);
    expect(c.windowDownvotes).toBe(1);
    expect(runHuman()).toContain('2 upvote(s), 1 downvote(s)');
  });

  test('a shelf dominated by never-reinforced +1 lessons is flagged; one above the floor is not', () => {
    // 12 lessons all at +1 → floor=12 (≥10), fraction=1.0 (≥0.5): flagged.
    mkShelf('floored', Array.from({ length: 12 }, (_, i) => [1, `lesson ${i}`] as [number, string]));
    // 12 lessons all at +3 → floor=0: not flagged.
    mkShelf('reinforced', Array.from({ length: 12 }, (_, i) => [3, `strong ${i}`] as [number, string]));
    seed([voteRow('floored', 's1', 'up')]);
    const floors = json().curation.floorShelves;
    expect(floors.map((f) => f.shelf)).toEqual(['floored']);
    expect(floors[0]).toMatchObject({ floor: 12, total: 12, fraction: 1 });
    const human = runHuman();
    expect(human).toContain('── 6. Curation');
    expect(human).toContain('floored: 12/12 lessons still at +1');
    // The JSON floorShelves equality above already pins that 'reinforced' is not
    // flagged; the human section does not print it as a floor pile.
    expect(human).not.toContain('reinforced: 12/12');
  });

  test('a small +1 pile below the minimum count is not flagged (pins FLOOR_MIN_LESSONS)', () => {
    mkShelf('small', Array.from({ length: 9 }, (_, i) => [1, `l ${i}`] as [number, string]));
    seed([voteRow('small', 's1', 'up')]);
    expect(json().curation.floorShelves).toEqual([]);
    expect(runHuman()).toContain('✅ no shelf is dominated by a large pile');
  });

  test('no downvotes in the window prints the "downvoting is unused" line', () => {
    mkShelf('v', [[1, 'a']]);
    seed([voteRow('v', 's1', 'up')]);
    expect(runHuman()).toContain('downvoting is unused');
  });
});

describe('nb-janitor section 7 — undescribed shelves ranked by browse-without-use (#223)', () => {
  function mkShelf(name: string, desc?: string): void {
    const head = desc ? `# desc: ${desc}\n` : '';
    writeFileSync(join(dir, `${name}.md`), head + '+1\ta lesson\n', 'utf-8');
  }
  function voteRow(shelf: string, session: string): string {
    return `${TS}\t${shelf}\tvote\tok\t2ms\t${session}\tabc123\tup`;
  }
  function json(): { undescribed: { computed: boolean; shelves: { shelf: string; browseWithoutUse: number }[] } } {
    const out = execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' });
    return JSON.parse(out);
  }

  test('lists undescribed shelves ranked by browse-without-use; a described shelf is excluded', () => {
    mkShelf('alpha'); // undescribed, browsed-without-use twice
    mkShelf('bravo'); // undescribed, browsed-without-use once
    mkShelf('charlie', 'open me when charlie-ing'); // described → never listed
    seed([
      row('alpha', 'show', 's1'),
      row('alpha', 'show', 's2'),
      row('bravo', 'show', 's1'),
      row('charlie', 'show', 's1'), // described, so excluded regardless
    ]);
    const u = json().undescribed;
    expect(u.computed).toBe(true);
    expect(u.shelves).toEqual([
      { shelf: 'alpha', browseWithoutUse: 2 },
      { shelf: 'bravo', browseWithoutUse: 1 },
    ]);
    const human = runHuman();
    expect(human).toContain('── 7. Undescribed shelves');
    expect(human).toContain('alpha — shown-but-not-voted in 2 session(s)');
    expect(human).not.toContain('charlie');
  });

  test('a shelf shown AND voted in the same session is not browse-without-use', () => {
    mkShelf('alpha');
    seed([row('alpha', 'show', 's1'), voteRow('alpha', 's1')]);
    expect(json().undescribed.shelves).toEqual([{ shelf: 'alpha', browseWithoutUse: 0 }]);
  });

  test('every shelf described → section 7 reports the all-clear', () => {
    mkShelf('alpha', 'trigger a');
    seed([row('alpha', 'show', 's1')]);
    expect(json().undescribed.shelves).toEqual([]);
    expect(runHuman()).toContain('✅ every shelf has an explicit # desc: trigger.');
  });
});
