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
  highPairs: { a: string; b: string; co: number; support: number; ratio: number; kind: 'fragment' | 'panel' }[];
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
      // patcher and repo-cartographer are DISTINCT roles → a panel, not a fragment.
      { a: 'patcher', b: 'repo-cartographer', co: 3, support: 3, ratio: 1, kind: 'panel' },
    ]);
    expect(coAccess.isolated).toEqual([]); // both are paired

    const human = runHuman();
    expect(human).toContain('── 5. Shelf co-access');
    expect(human).toContain('"patcher" + "repo-cartographer" — shown together in 3/3 session(s) (co-access 1)');
    expect(human).toContain('almost always opened together');
    // Distinct roles → the "don't merge" panel advice, not a merge suggestion.
    expect(human).toContain('distinct roles that co-fire');
    expect(human).not.toContain('likely one shelf split in two');
  });

  test('a near-identical role pair in the same scope is a fragment (merge advice), not a panel', () => {
    // `code-review` vs `code-reviews` — same (empty) scope, editSim ≥ 0.8 → one
    // role split in two, so the advice is to merge/namespace, unlike a panel.
    seed([
      row('code-review', 'show', 's1'),
      row('code-reviews', 'show', 's1'),
      row('code-review', 'show', 's2'),
      row('code-reviews', 'show', 's2'),
    ]);
    const { coAccess } = runJson();
    expect(coAccess.highPairs).toEqual([
      { a: 'code-review', b: 'code-reviews', co: 2, support: 2, ratio: 1, kind: 'fragment' },
    ]);
    const human = runHuman();
    expect(human).toContain('likely one shelf split in two');
    expect(human).not.toContain('distinct roles that co-fire');
  });

  test('intentional `.`-namespace siblings that co-fire are a panel, not a fragment (mirrors §2)', () => {
    // `build.ci@kookr` + `build.cd@kookr` share the `.`-stem `build`: §2 treats
    // these as intentional siblings (not a name-dup), so §5 must NOT advise a
    // merge on them — they classify as `panel`, not `fragment`. Regression guard
    // for an inversion where a shared stem wrongly routed to merge advice.
    seed([
      row('build.ci@kookr', 'show', 's1'),
      row('build.cd@kookr', 'show', 's1'),
      row('build.ci@kookr', 'show', 's2'),
      row('build.cd@kookr', 'show', 's2'),
    ]);
    const { coAccess } = runJson();
    expect(coAccess.highPairs).toEqual([
      { a: 'build.cd@kookr', b: 'build.ci@kookr', co: 2, support: 2, ratio: 1, kind: 'panel' },
    ]);
    expect(runHuman()).not.toContain('likely one shelf split in two');
  });

  test('a fragment pair is listed before a panel pair even when the panel has a higher ratio', () => {
    seed([
      // fragment (dup role names), ratio 0.8: co=4 over 5 shows each
      row('alpha-rev', 'show', 'f1'), row('alpha-revs', 'show', 'f1'),
      row('alpha-rev', 'show', 'f2'), row('alpha-revs', 'show', 'f2'),
      row('alpha-rev', 'show', 'f3'), row('alpha-revs', 'show', 'f3'),
      row('alpha-rev', 'show', 'f4'), row('alpha-revs', 'show', 'f4'),
      row('alpha-rev', 'show', 'f5'), row('alpha-revs', 'show', 'g5'),
      // panel (distinct roles), ratio 1.0
      row('orchestrator', 'show', 'p1'), row('patcher', 'show', 'p1'),
      row('orchestrator', 'show', 'p2'), row('patcher', 'show', 'p2'),
    ]);
    const kinds = runJson().coAccess.highPairs.map((p) => p.kind);
    expect(kinds[0]).toBe('fragment'); // fragment first despite its lower ratio (0.8 < 1.0)
    expect(kinds).toContain('panel');
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

  test('the typo-pair remedy is a score-preserving `nb move`, never a re-add (#408)', () => {
    mkShelf('build-and-test');
    mkShelf('build-and-tests');
    const human = runHuman();
    expect(human).toContain('nb move build-and-tests build-and-test <id>');
    expect(human).toContain('nb describe');
    expect(human).not.toMatch(/re-add/);
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

  test('the text view caps similar-name pairs at 25 with a --json pointer; --json keeps every pair (#461)', () => {
    // A numbered family (issue-101 … issue-160) yields pairs quadratically.
    for (let n = 101; n <= 160; n++) mkShelf(`issue-${n}`);
    const all = shelfDups();
    expect(all.length).toBeGreaterThan(25);
    const human = runHuman();
    const section = human.slice(human.indexOf('2. Near-duplicate shelf names'), human.indexOf('3. Likely duplicate lessons'));
    const shown = section.split('\n').filter((l) => l.includes('(name similarity '));
    expect(shown.length).toBe(25);
    // Strongest first, as before the cap: the first row is the top --json pair.
    expect(shown[0]).toContain(`"${all[0].a}" ~ "${all[0].b}" (name similarity ${all[0].sim})`);
    expect(section).toContain(`…(${all.length - 25} more pairs — run with --json)`);
  });

  test('exactly 25 similar-name pairs print in full with no "more" line (pins the > guard)', () => {
    // 25 disjoint typo pairs (`aaaaaaaaa`/`aaaaaaaaaz`, `bbbbbbbbb`/…): stems share
    // no letters, so no pair forms across stems.
    const stems = Array.from({ length: 25 }, (_, i) => String.fromCharCode(97 + i).repeat(9));
    for (const s of stems) {
      mkShelf(s);
      mkShelf(`${s}z`);
    }
    expect(shelfDups().length).toBe(25);
    const human = runHuman();
    const section = human.slice(human.indexOf('2. Near-duplicate shelf names'), human.indexOf('3. Likely duplicate lessons'));
    expect(section.split('\n').filter((l) => l.includes('(name similarity ')).length).toBe(25);
    expect(section).not.toContain('more pairs');
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
    // Lessons are DISTINCT (no shared content tokens) on purpose: near-identical
    // texts like "lesson 0".."lesson 11" make §3's paraphrase detector emit a
    // huge O(n²) dup matrix that bloats `--json` past an 8 KB pipe boundary and
    // trips a platform-specific partial-read in `execFileSync` here. The floor
    // check keys on SCORE, not text, so distinctness changes nothing it asserts.
    // 12 lessons all at +1 → floor=12 (≥10), fraction=1.0 (≥0.5): flagged.
    mkShelf('floored', Array.from({ length: 12 }, (_, i) => [1, `floornote${i}aa topic${i}bb`] as [number, string]));
    // 12 lessons all at +3 → floor=0: not flagged.
    mkShelf('reinforced', Array.from({ length: 12 }, (_, i) => [3, `strongidea${i}cc matter${i}dd`] as [number, string]));
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

// Section 4 — volume over time. gitHistory() must distinguish "NB_DIR is not a
// git repo" (no .git) from "git exists but `git log` failed" (its 5s timeout on
// a huge repo, git's dubious-ownership refusal, a corrupt repo, or git missing
// from PATH). Before the fix both collapsed to null and section 4 printed the
// flatly-false "not a git repo" line on a genuine git failure (issue #269).
const NOT_A_REPO = '(NB_DIR is not a git repo';
const GIT_FAILED = '(git history unavailable';

describe('nb-janitor section 4 — git history vs git failure (issue #269)', () => {
  test('no .git → "not a git repo" (unchanged for existing users)', () => {
    // Fresh temp NB_DIR has no .git at all; gitHistory never shells out to git.
    const human = runHuman();
    expect(human).toContain('── 4. Volume over time');
    expect(human).toContain(NOT_A_REPO);
    expect(human).not.toContain(GIT_FAILED);
  });

  test('.git present but `git log` fails → "git history unavailable", not "not a git repo"', () => {
    // existsSync('.git') is true, so the old guard would try git and swallow the
    // throw as null → the false "not a git repo" line. A gitfile pointing nowhere
    // makes `git log` exit non-zero deterministically (no walk-up to a parent
    // repo), standing in for timeout / dubious-ownership / corrupt-repo / no-PATH.
    writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent/nb-janitor-issue-269\n', 'utf-8');
    const human = runHuman(); // execFileSync throws on nonzero exit → also pins exit 0
    expect(human).toContain('── 4. Volume over time');
    expect(human).toContain(GIT_FAILED);
    expect(human).not.toContain(NOT_A_REPO);
  });

  test('a real git repo with notebook commits still renders the git volume line', () => {
    // The happy path must survive the three-way split: a readable repo reports
    // commits, never a degraded note.
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { env: gitEnv, stdio: 'ignore' });
    };
    git('init', '-q');
    writeFileSync(join(dir, 'readme.md'), 'x\n', 'utf-8');
    git('add', 'readme.md');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'nb add demo');
    const human = runHuman();
    expect(human).toContain('── 4. Volume over time');
    expect(human).toContain('git: 1 notebook commits');
    expect(human).toContain('add:1'); // "nb add …" subject → byCmd add:1
    expect(human).not.toContain(GIT_FAILED);
    expect(human).not.toContain(NOT_A_REPO);
  });

  test('a readable repo with zero commits in the window still reports git (pins the Array.isArray guard)', () => {
    // git log succeeds but --since filters everything out → gitHistory returns an
    // EMPTY array, the one success case the old `if (history)` truthiness and the
    // new `Array.isArray(history)` guard must treat alike: a readable (just quiet)
    // repo, never the "not a git repo" / "git failed" degrade. Commit far in the
    // past so it falls outside the default 30-day window.
    const old = '2000-01-01T00:00:00 +0000';
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_AUTHOR_DATE: old,
      GIT_COMMITTER_DATE: old,
    };
    const git = (...args: string[]): void => {
      execFileSync('git', ['-C', dir, ...args], { env: gitEnv, stdio: 'ignore' });
    };
    git('init', '-q');
    writeFileSync(join(dir, 'readme.md'), 'x\n', 'utf-8');
    git('add', 'readme.md');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'nb add demo');
    const human = runHuman();
    expect(human).toContain('git: 0 notebook commits on 0 active days');
    expect(human).not.toContain(GIT_FAILED);
    expect(human).not.toContain(NOT_A_REPO);
  });
});

// The usage ring is bounded by ROW COUNT, not time: sections 1/4/6/7 keep only
// rows within `now - --days`, but an active store rotates old rows out, so a wide
// window can reach back further than the ring retains and report a false
// all-clear. The janitor now detects this and prints a caveat (#275). These tests
// drive the real script against a seeded ring, overriding NB_USAGE_RING so a
// small, cheap log can reach "capacity".
describe('nb-janitor — --days window vs usage-ring span (#275)', () => {
  const DAY = 86400000;
  // A usage row whose timestamp is `daysAgo` whole days before now, so the test
  // is independent of the wall-clock date (unlike the fixed TS the other suites
  // use). Minimal columns: ts, shelf, command, status, ms, session(blank).
  function ageRow(shelf: string, command: string, daysAgo: number): string {
    return `${new Date(Date.now() - daysAgo * DAY).toISOString()}\t${shelf}\t${command}\tok\t2ms\t`;
  }
  function run(args: string[], ring?: string): string {
    const env = { ...process.env, NB_DIR: dir, ...(ring !== undefined ? { NB_USAGE_RING: ring } : {}) };
    return execFileSync('node', [janitor, ...args], { env, encoding: 'utf-8' });
  }
  type UsageWindow = {
    ring: number;
    rows: number;
    atCapacity: boolean;
    requestedDays: number;
    coverageDays: number | null;
    blind: boolean;
  };
  function usageWindow(args: string[], ring?: string): UsageWindow {
    return JSON.parse(run(['--json', ...args], ring)).usageWindow;
  }

  test('a full ring whose span is shorter than --days is flagged blind, with a caveat', () => {
    // 100 rows (the NB_USAGE_RING floor), all from ~2 days ago → the ring is at
    // capacity but spans only days, while --days 90 reaches back three months.
    seed(Array.from({ length: 100 }, () => ageRow('busy', 'show', 2)));
    const w = usageWindow(['--days', '90'], '100');
    expect(w.ring).toBe(100);
    expect(w.atCapacity).toBe(true);
    expect(w.coverageDays).toBe(2);
    expect(w.requestedDays).toBe(90);
    expect(w.blind).toBe(true);

    const human = run(['--days', '90'], '100');
    expect(human).toContain('partially blind');
    expect(human).toContain('raise NB_USAGE_RING');
    expect(human).toContain('retains only the last 2d of activity');
  });

  test('a ring below capacity is never flagged blind, even with a wide --days (young store, no false alarm)', () => {
    // Only 3 rows, far below the 100-row ring → nothing has been evicted; the
    // store is simply young. The window is not "blind" — raising the ring would
    // not help — so no caveat fires. This pins the capacity guard.
    seed([ageRow('new', 'show', 1), ageRow('new', 'show', 1), ageRow('new', 'show', 1)]);
    const w = usageWindow(['--days', '365'], '100');
    expect(w.atCapacity).toBe(false);
    expect(w.blind).toBe(false);
    expect(run(['--days', '365'], '100')).not.toContain('partially blind');
  });

  test('a full ring that already spans more than --days is not blind (the window fits the data)', () => {
    // 100 rows, the oldest 200 days old → the ring covers more than the 30-day
    // window, so every day the window asks for is backed by retained rows.
    const rows = Array.from({ length: 99 }, () => ageRow('busy', 'show', 1));
    rows.push(ageRow('busy', 'show', 200)); // oldest row predates the window
    seed(rows);
    const w = usageWindow(['--days', '30'], '100');
    expect(w.atCapacity).toBe(true);
    expect(w.blind).toBe(false);
    expect(run(['--days', '30'], '100')).not.toContain('partially blind');
  });

  test('no usage log → no blindness flag and no caveat (degrades cleanly)', () => {
    // No .nb-usage.log at all: coverage is unknown, nothing is blind.
    const w = usageWindow(['--days', '90']);
    expect(w.rows).toBe(0);
    expect(w.coverageDays).toBe(null);
    expect(w.blind).toBe(false);
    expect(run(['--days', '90'])).not.toContain('partially blind');
  });

  test('99 rows in a 100-row ring is below capacity — the >= guard is not off-by-one', () => {
    // One short of the ring: nothing has rotated out yet, so even a wide window
    // is fully backed by data. Pins the N-1 boundary of `usage.length >= ring`.
    seed(Array.from({ length: 99 }, () => ageRow('busy', 'show', 2)));
    const w = usageWindow(['--days', '90'], '100');
    expect(w.rows).toBe(99);
    expect(w.atCapacity).toBe(false);
    expect(w.blind).toBe(false);
    expect(run(['--days', '90'], '100')).not.toContain('partially blind');
  });

  test('mirrors the core NB_USAGE_RING clamp (floor 100, ceiling 100000, default 5000)', () => {
    // The capacity test is only meaningful if the janitor judges against the SAME
    // ring the core writes to. A wrong clamp would misfire on every real store
    // while these tests (which pass NB_USAGE_RING=100) stayed green — so pin it.
    seed([ageRow('x', 'show', 1)]);
    expect(usageWindow(['--days', '30'], '10').ring).toBe(100); // below floor clamps up
    expect(usageWindow(['--days', '30'], '0').ring).toBe(100); // a FINITE 0 clamps up to the floor, it does NOT fall back to 5000 (core clampInt parity)
    expect(usageWindow(['--days', '30'], '999999').ring).toBe(100000); // above ceiling clamps down
    expect(usageWindow(['--days', '30'], 'not-a-number').ring).toBe(5000); // unparseable → default
  });

  test('a full ring spanning only hours reports coverageDays 0 and an "under a day" caveat', () => {
    // Oldest row ~3 hours old → (now - oldest)/DAY floors to 0; exercises the
    // sub-day label branch the `2d` test does not reach.
    const ts = new Date(Date.now() - 3 * 3600000).toISOString();
    seed(Array.from({ length: 100 }, () => `${ts}\tbusy\tshow\tok\t2ms\t`));
    const w = usageWindow(['--days', '30'], '100');
    expect(w.coverageDays).toBe(0);
    expect(w.blind).toBe(true);
    expect(run(['--days', '30'], '100')).toContain('under a day');
  });
});

describe('nb-janitor ignores a *.md whose stem is not a legal shelf name (issue #369)', () => {
  test('a stray `review copy.md` is not counted as a shelf', () => {
    writeFileSync(join(dir, 'build.md'), '1\ta lesson\n', 'utf-8');
    const base = JSON.stringify(JSON.parse(execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' })));
    writeFileSync(join(dir, 'review copy.md'), '1\tstray\n', 'utf-8');
    const withStray = JSON.stringify(JSON.parse(execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir }, encoding: 'utf-8' })));
    expect(withStray).toBe(base);
    expect(withStray).not.toContain('review copy');
  });
});

// #403 — the janitor must read the usage rows the CLI itself writes: a comma
// list in `evicted` (mass eviction after lowering NB_MAX_LINES) and one batch
// vote row listing many ids. Rows are produced by the built CLI, not literals,
// so the reader cannot silently fall behind the writer again.
describe('nb-janitor — reads CLI-written batch rows (#403)', () => {
  const cli = join(here, '..', 'dist', 'cli.js');
  function nb(args: string[], extra: Record<string, string> = {}): string {
    return execFileSync('node', [cli, ...args], {
      env: { ...process.env, NB_DIR: dir, NB_SESSION: 'S1', ...extra },
      encoding: 'utf-8',
    });
  }
  function janitorJson(extra: Record<string, string> = {}): {
    lostLessons: { shelf: string; stillVoted: number }[];
    curation: { windowUpvotes: number; windowDownvotes: number };
  } {
    const out = execFileSync('node', [janitor, '--json'], { env: { ...process.env, NB_DIR: dir, ...extra }, encoding: 'utf-8' });
    return JSON.parse(out);
  }
  function seedShelf(): string {
    for (let i = 1; i <= 6; i++) nb(['add', 's', `lesson number ${i} about topic ${i}${i}${i}`]);
    const shown = JSON.parse(nb(['show', 's', '--json'])) as { entries: { id: string }[] };
    return shown.entries.map((e) => e.id).join(',');
  }

  test('a mass eviction of voted lessons is flagged and batch votes count per id', () => {
    const ids = seedShelf();
    nb(['vote', 's', ids, '+1']);
    nb(['vote', 's', ids, '+1']);
    nb(['add', 's', 'a brand new lesson that triggers the mass eviction'], { NB_MAX_LINES: '3' });
    const j = janitorJson({ NB_MAX_LINES: '3' });
    expect(j.curation.windowUpvotes).toBe(12);
    expect(j.curation.windowDownvotes).toBe(0);
    expect(j.lostLessons).toHaveLength(1);
    expect(j.lostLessons[0]?.shelf).toBe('s');
    expect(j.lostLessons[0]?.stillVoted).toBeGreaterThanOrEqual(2);
  });

  test('a single ordinary eviction of a voted lesson stays below the loss threshold', () => {
    const ids = seedShelf();
    nb(['vote', 's', ids, '+1']);
    nb(['vote', 's', ids, '+1']);
    nb(['add', 's', 'a brand new lesson that evicts exactly one'], { NB_MAX_LINES: '6' });
    expect(janitorJson({ NB_MAX_LINES: '6' }).lostLessons).toEqual([]);
  });
});
