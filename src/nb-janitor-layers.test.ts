import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Issue #362 — two read-only janitor signals for stores that use `shelf@project` names:
//   * section 2 "possible slug drift": one base name under two slugs, the shorter slug
//     being the longer one with a leading part dropped;
//   * section 8 "exact duplicate lessons": equal `dedupKey` in two or more `@` shelves
//     that share a base name.
// Like the other janitor tests this drives the REAL script against a throwaway NB_DIR.
// All shelf names below are synthetic.
const here = dirname(fileURLToPath(import.meta.url));
const janitor = join(here, '..', 'examples', 'nb-janitor.mjs');
const nbCli = join(here, '..', 'dist', 'cli.js');

let dir: string;

/** Write `<name>.md` with `[score, text]` lessons (a raw line is written as-is when given a string). */
function shelf(name: string, lessons: ([number, string] | string)[]): void {
  const body = lessons.map((l) => (typeof l === 'string' ? l : `${l[0]}\t${l[1]}`)).join('\n');
  writeFileSync(join(dir, `${name}.md`), `# scope: global\n${body}\n`, 'utf-8');
}
function env(): NodeJS.ProcessEnv {
  return { ...process.env, NB_DIR: dir };
}
type Variant = {
  base: string;
  shortShelf: string;
  longShelf: string;
  shortSlug: string;
  longSlug: string;
  shortLessons: number;
  longLessons: number;
  inBoth: string[];
};
type Dup = {
  base: string;
  key: string;
  id: string;
  text: string;
  shelves: number;
  copies: { shelf: string; score: number }[];
  keep: string;
  sharedShelf: string;
  sharedHolds: boolean;
  blocked: 'conflict' | 'case-variant' | null;
  commands: string[];
};
type Report = { slugVariants: Variant[]; crossShelfDups: Dup[]; shelfDups: unknown[] };
function json(): Report {
  return JSON.parse(execFileSync('node', [janitor, '--json'], { env: env(), encoding: 'utf-8' }));
}
function human(): string {
  return execFileSync('node', [janitor], { env: env(), encoding: 'utf-8' });
}
function nb(...args: string[]): string {
  return execFileSync('node', [nbCli, ...args], { env: env(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}
/** Section `n` of the human report (from its heading to the next one). */
function section(out: string, n: number): string {
  const m = new RegExp(`── ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=\\n── \\d+\\. |$)`).exec(out);
  if (!m) throw new Error(`section ${n} not found`);
  return m[1];
}
function snapshot(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf-8')]));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-notebook-janitor-layers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-janitor section 2 — possible slug drift (issue #362)', () => {
  test('a slug that is another slug with its leading part dropped is reported, in --json and in the report', () => {
    shelf('code-review@app', [[3, 'lesson one'], [1, 'lesson two']]);
    shelf('code-review@acme-app', [[1, 'lesson three']]);
    const v = json().slugVariants;
    expect(v).toEqual([
      {
        base: 'code-review',
        shortShelf: 'code-review@app',
        longShelf: 'code-review@acme-app',
        shortSlug: 'app',
        longSlug: 'acme-app',
        shortLessons: 2,
        longLessons: 1,
        inBoth: [],
      },
    ]);
    const s2 = section(human(), 2);
    expect(s2).toContain('possible slug drift');
    expect(s2).toContain('"code-review@app" (2 lesson(s)) and "code-review@acme-app" (1)');
    expect(s2).toContain('nb move code-review@app code-review@acme-app <id>');
    expect(s2).not.toContain('no suspiciously similar shelf names'); // the all-clear must not hide it
  });

  test('several leading parts may be dropped (org-team-repo vs repo)', () => {
    shelf('orchestrator@repo', [[1, 'x']]);
    shelf('orchestrator@org-team-repo', [[1, 'y']]);
    expect(json().slugVariants.map((v) => [v.shortSlug, v.longSlug])).toEqual([['repo', 'org-team-repo']]);
  });

  test('three variants of one base report every (short, long) pair, in a stable order', () => {
    shelf('a@repo', [[1, 'x']]);
    shelf('a@team-repo', [[1, 'x2']]);
    shelf('a@org-team-repo', [[1, 'x3']]);
    expect(json().slugVariants.map((v) => `${v.shortSlug}|${v.longSlug}`)).toEqual([
      'repo|org-team-repo', // ordered by the short shelf's name, then the long shelf's
      'repo|team-repo',
      'team-repo|org-team-repo',
    ]);
  });

  test('slugs are compared ignoring case: `Acme-App` still contains `app`', () => {
    shelf('a@app', [[1, 'x']]);
    shelf('a@Acme-App', [[1, 'y']]);
    expect(json().slugVariants.length).toBe(1);
  });

  test('negative: different base name (same or different slugs) is not drift', () => {
    shelf('code-review@app', [[1, 'x']]);
    shelf('orchestrator@acme-app', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
    expect(section(human(), 2)).toContain('no suspiciously similar shelf names');
  });

  test('negative: the same slug on different bases is not drift', () => {
    shelf('code-review@acme-app', [[1, 'x']]);
    shelf('orchestrator@acme-app', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
  });

  test('negative: slugs that differ only by case are a case collision, not drift', () => {
    shelf('code-review@Acme-App', [[1, 'x']]);
    shelf('code-review@acme-app', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
  });

  test('negative: a base that differs only by case is another shelf, not drift', () => {
    shelf('Code-Review@app', [[1, 'x']]);
    shelf('code-review@acme-app', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
  });

  test('negative: the leading part must end at a `-` (app vs acme-webapp)', () => {
    shelf('a@app', [[1, 'x']]);
    shelf('a@acme-webapp', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
  });

  test('negative: a bare shelf has no slug, so it is never a variant', () => {
    shelf('code-review', [[1, 'x']]);
    shelf('code-review@acme-app', [[1, 'y']]);
    expect(json().slugVariants).toEqual([]);
  });

  test('does not change section 2 for same-scope near-duplicate names (shelfDups stays separate)', () => {
    shelf('code-review@app', [[1, 'x']]);
    shelf('code-review@acme-app', [[1, 'y']]);
    shelf('repo-cartographer@project-a', [[1, 'z']]);
    shelf('repo-cartographer@project-b', [[1, 'w']]);
    const r = json();
    expect(r.shelfDups).toEqual([]);
    expect(r.slugVariants.length).toBe(1);
  });

  test('lessons held under both variants are listed (nb move would refuse them)', () => {
    shelf('a@app', [[1, 'Same lesson.'], [1, 'only short']]);
    shelf('a@acme-app', [[1, 'same LESSON']]);
    const [v] = json().slugVariants;
    expect(v.inBoth.length).toBe(1);
    expect(section(human(), 2)).toContain(`nb rm a@app <id> --reason obsolete --note duplicate`);
  });
});

describe('nb-janitor section 8 — exact duplicate lessons across shelves sharing a base (issue #362)', () => {
  test('the same lesson in two `@` shelves of one base is reported with the best-scored copy and the fix', () => {
    shelf('orchestrator@proj-a', [[4, 'Run npm install in a fresh worktree']]);
    shelf('orchestrator@proj-b', [[1, 'Run npm install in a fresh worktree']]);
    const r = json();
    expect(r.crossShelfDups.length).toBe(1);
    const d = r.crossShelfDups[0];
    expect(d.base).toBe('orchestrator');
    expect(d.shelves).toBe(2);
    expect(d.copies).toEqual([
      { shelf: 'orchestrator@proj-a', score: 4 },
      { shelf: 'orchestrator@proj-b', score: 1 },
    ]);
    expect(d.keep).toBe('orchestrator@proj-a');
    expect(d.sharedShelf).toBe('orchestrator');
    expect(d.commands).toEqual([
      `nb move orchestrator@proj-a orchestrator ${d.id}`,
      `nb rm orchestrator@proj-b ${d.id} --reason obsolete --note duplicate`,
    ]);
    const s8 = section(human(), 8);
    expect(s8).toContain('appears in 2 shelves');
    expect(s8).toContain('orchestrator@proj-a (+4), orchestrator@proj-b (+1)');
    expect(s8).toContain(d.commands[0]);
    expect(s8).toContain(d.commands[1]);
  });

  test('the printed commands run as written against the real nb and leave one shared copy with its score', () => {
    shelf('orchestrator@proj-a', [[4, 'Run npm install in a fresh worktree'], [2, 'unrelated a']]);
    shelf('orchestrator@proj-b', [[1, 'run npm install in a fresh worktree!']]);
    const [d] = json().crossShelfDups;
    for (const cmd of d.commands) nb(...cmd.split(' ').slice(1)); // throws on a non-zero exit
    const shared = JSON.parse(nb('show', 'orchestrator', '--json'));
    expect(shared.entries.map((e: { id: string; score: number }) => [e.id, e.score])).toEqual([[d.id, 4]]);
    expect(JSON.parse(nb('show', 'orchestrator@proj-a', '--json')).entries.length).toBe(1); // only "unrelated a" left
    expect(JSON.parse(nb('show', 'orchestrator@proj-b', '--json')).entries).toEqual([]);
    expect(json().crossShelfDups).toEqual([]); // and the signal clears
  });

  test('when the bare base shelf already holds the lesson, only the removals are suggested (a move would be refused)', () => {
    shelf('orchestrator', [[2, 'Run npm install in a fresh worktree']]);
    shelf('orchestrator@proj-a', [[1, 'Run npm install in a fresh worktree']]);
    shelf('orchestrator@proj-b', [[3, 'Run npm install in a fresh worktree']]);
    const [d] = json().crossShelfDups;
    expect(d.sharedHolds).toBe(true);
    expect(d.commands.every((c) => c.startsWith('nb rm '))).toBe(true);
    expect(d.commands.length).toBe(2);
    for (const cmd of d.commands) nb(...cmd.split(' ').slice(1));
    expect(json().crossShelfDups).toEqual([]);
  });

  test('"appears in N shelves" counts every holder, and a tie on score is broken by shelf name', () => {
    shelf('code-review@c', [[2, 'Pin the base branch']]);
    shelf('code-review@a', [[2, 'Pin the base branch']]);
    shelf('code-review@b', [[1, 'Pin the base branch']]);
    const [d] = json().crossShelfDups;
    expect(d.shelves).toBe(3);
    expect(d.keep).toBe('code-review@a');
    expect(d.copies.map((c) => c.shelf)).toEqual(['code-review@a', 'code-review@c', 'code-review@b']);
    expect(d.commands.filter((c) => c.startsWith('nb rm ')).length).toBe(2);
  });

  test('"exact" is nb\'s own rule: case, punctuation and spacing are ignored', () => {
    shelf('a@one', [[1, "Don't   use `rm -rf` here!"]]);
    shelf('a@two', [[1, 'dont use rm rf here']]);
    // `Don't` normalises to `don t`, not `dont`: these two are NOT equal under nb's rule…
    expect(json().crossShelfDups).toEqual([]);
    shelf('a@two', [[1, "DON'T use rm   rf here"]]);
    // …and these are (case, punctuation and runs of spaces differ only).
    expect(json().crossShelfDups.length).toBe(1);
  });

  test('negative: a different base name is not grouped, even with the same lesson and the same slug', () => {
    shelf('code-review@acme', [[1, 'Pin the base branch']]);
    shelf('orchestrator@acme', [[1, 'Pin the base branch']]);
    shelf('orchestrator@other', [[1, 'Pin the base branch']]); // different base from code-review@acme: only this pair groups
    const groups = json().crossShelfDups;
    expect(groups.length).toBe(1);
    expect(groups[0].base).toBe('orchestrator');
  });

  test('negative: a base that differs only by case is another shelf, not grouped', () => {
    shelf('Orchestrator@proj-a', [[1, 'Pin the base branch']]);
    shelf('orchestrator@proj-b', [[1, 'Pin the base branch']]);
    expect(json().crossShelfDups).toEqual([]);
  });

  test('a copy in the bare base shelf counts as a holder: with one `@` shelf it is reported, and only the `@` copy is dropped', () => {
    shelf('orchestrator', [[1, 'Pin the base branch']]);
    shelf('orchestrator@proj-a', [[4, 'pin the base branch!']]);
    const [d] = json().crossShelfDups;
    expect(d.shelves).toBe(2);
    expect(d.sharedHolds).toBe(true);
    expect(d.blocked).toBeNull();
    expect(d.copies.map((c) => c.shelf)).toEqual(['orchestrator@proj-a', 'orchestrator']);
    expect(d.commands).toEqual([`nb rm orchestrator@proj-a ${d.id} --reason obsolete --note duplicate`]);
    for (const cmd of d.commands) nb(...cmd.split(' ').slice(1));
    expect(json().crossShelfDups).toEqual([]);
    expect(JSON.parse(nb('show', 'orchestrator', '--json')).entries.length).toBe(1);
  });

  test('negative: a bare shelf alone forms no group, and neither does a bare shelf of another base', () => {
    shelf('orchestrator', [[1, 'Pin the base branch']]);
    shelf('code-review@proj-a', [[1, 'Pin the base branch']]); // different base from the bare `orchestrator`
    expect(json().crossShelfDups).toEqual([]);
  });

  test('negative: twins inside one shelf, with the other shelf holding something else, report nothing', () => {
    shelf('orchestrator@proj-a', [[1, 'Pin the base branch'], [1, 'Pin the base branch.'] /* hand-edited twin, same shelf */]);
    shelf('orchestrator@proj-b', [[1, 'something else entirely']]);
    expect(json().crossShelfDups).toEqual([]);
    expect(section(human(), 8)).toContain('no lesson appears in more than one');
  });

  test('negative: a lesson and its negation are different lessons', () => {
    shelf('orchestrator@proj-a', [[1, 'Always rebase before merging']]);
    shelf('orchestrator@proj-b', [[1, 'Never rebase before merging']]);
    expect(json().crossShelfDups).toEqual([]);
  });

  test('negative: git merge-conflict marker lines and punctuation-only lines are not lessons', () => {
    const debris = ['<<<<<<< HEAD', '=======', '>>>>>>> branch', '!!!'];
    shelf('orchestrator@proj-a', debris);
    shelf('orchestrator@proj-b', debris);
    expect(json().crossShelfDups).toEqual([]);
  });

  test('a shelf holding git merge-conflict markers is left out (nb would refuse the printed commands)', () => {
    shelf('o@a', [[1, 'Pin the base'], '<<<<<<< HEAD', '=======', '>>>>>>> branch']);
    shelf('o@b', [[1, 'pin the base']]);
    expect(json().crossShelfDups).toEqual([]);
  });

  test('--json exits 0 when the reader closes the pipe early (no EPIPE crash)', () => {
    for (const base of ['w', 'x', 'y', 'z'])
      for (const slug of ['a', 'b'])
        shelf(`${base}@${slug}`, Array.from({ length: 50 }, (_, i): [number, string] => [1, `${base} shared lesson number ${i} about builds`]));
    const script = `node ${JSON.stringify(janitor)} --json | head -c 100 >/dev/null; echo "exit=\${PIPESTATUS[0]}"`;
    const out = execFileSync('bash', ['-c', script], { env: env(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out.trim()).toBe('exit=0');
  });

  test('no command is suggested when nb would refuse the shared `<base>` shelf (conflict markers, or a case variant of it)', () => {
    shelf('o', [[1, 'other'], '<<<<<<< HEAD', '=======', '>>>>>>> b']);
    shelf('o@a', [[3, 'Pin the base']]);
    shelf('o@b', [[1, 'pin the base']]);
    const [c] = json().crossShelfDups;
    expect(c.blocked).toBe('conflict');
    expect(c.commands).toEqual([]);
    expect(section(human(), 8)).toContain('holds git merge-conflict markers');
    rmSync(join(dir, 'o.md'));
    shelf('O', [[1, 'other']]);
    const [v] = json().crossShelfDups;
    expect(v.blocked).toBe('case-variant');
    expect(v.commands).toEqual([]);
    expect(section(human(), 8)).toContain('differs only by case');
  });

  test('the key and id match what the package computes from the file (control/zero-width chars are deleted, not spaced)', () => {
    const samples = [
      'Plain lesson',
      'MiXeD   case,  punctuation; and spacing!',
      'zero\u200Bwidth and bell\u0007 chars',
      'bom\uFEFFinside (U+FEFF is whitespace to JS regexes but deleted by nb)',
      'tab\tinside the text',
      'naïve café — non-ASCII becomes a space',
      '  leading and trailing  ',
    ];
    samples.forEach((text, i) => {
      shelf(`parity${i}@one`, [[1, text]]);
      shelf(`parity${i}@two`, [[1, text]]);
    });
    const groups = json().crossShelfDups;
    expect(groups.length).toBe(samples.length);
    samples.forEach((_, i) => {
      const d = groups.find((g) => g.base === `parity${i}`)!;
      const shown = JSON.parse(nb('show', `parity${i}@one`, '--json')).entries[0] as { id: string; key: string };
      expect(d.key).toBe(shown.key);
      expect(d.id).toBe(shown.id);
      nb('vote', `parity${i}@one`, shown.id, '+1'); // the id the janitor prints is one nb accepts
    });
  });

  test('a lesson with an invisible character still matches its plain twin (what nb itself would refuse as a duplicate)', () => {
    shelf('o@a', [[2, 'foo\uFEFFbar baz']]);
    shelf('o@b', [[1, 'foobar baz']]);
    const groups = json().crossShelfDups;
    expect(groups.length).toBe(1);
    const [d] = groups;
    for (const cmd of d.commands) nb(...cmd.split(' ').slice(1)); // the id it prints is one nb resolves
  });

  test('a BOM-prefixed shelf or a CRLF shelf parses like nb does: the description is not a lesson, and the printed ids resolve', () => {
    // A BOM-adding editor makes the first line `\uFEFF# desc: …`; nb reads that as the description.
    writeFileSync(join(dir, 'rev@a.md'), '\uFEFF# desc: when reviewing code\n+1\tlesson one\n', 'utf-8');
    writeFileSync(join(dir, 'rev@b.md'), '\uFEFF# desc: when reviewing code\n+2\tlesson two\n', 'utf-8');
    expect(json().crossShelfDups).toEqual([]); // the shared description is not a duplicate lesson
    // CRLF checkout (git autocrlf): the trailing \r must not change the key or the id.
    writeFileSync(join(dir, 'crlf@a.md'), '# desc: d\r\n+3\tShared CRLF lesson\r\n', 'utf-8');
    writeFileSync(join(dir, 'crlf@b.md'), '# desc: d\r\n+1\tshared crlf lesson\r\n', 'utf-8');
    const groups = json().crossShelfDups;
    expect(groups.map((g) => g.base)).toEqual(['crlf']);
    for (const cmd of groups[0].commands) nb(...cmd.split(' ').slice(1));
  });

  test('a BOM before `# desc:` still counts as described in section 7 (same reader)', () => {
    writeFileSync(join(dir, 'rev@a.md'), '\uFEFF# desc: when reviewing code\n+1\tlesson one\n', 'utf-8');
    expect((JSON.parse(execFileSync('node', [janitor, '--json'], { env: env(), encoding: 'utf-8' })) as { undescribed: { shelves: unknown[] } }).undescribed.shelves).toEqual([]);
  });

  test('a large --json report arrives whole through a pipe (the janitor must not exit before stdout drains)', () => {
    // ~200 duplicate groups ≈ 100 KB of JSON, far past one 8 KB pipe chunk. On macOS a process.exit() right
    // after stdout.write() used to truncate it mid-string, so JSON.parse failed.
    for (const base of ['w', 'x', 'y', 'z'])
      for (const slug of ['a', 'b'])
        shelf(
          `${base}@${slug}`,
          Array.from({ length: 50 }, (_, i): [number, string] => [1, `${base} shared lesson number ${i} about builds`]),
        );
    const raw = execFileSync('node', [janitor, '--json'], { env: env(), encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
    expect(raw.length).toBeGreaterThan(64 * 1024);
    expect((JSON.parse(raw) as Report).crossShelfDups.length).toBe(200);
  });

  test('is deterministic: the same store prints the same bytes whatever order the files were created in', () => {
    const names = ['q@z', 'q@m', 'q@a', 'r@y', 'r@b'];
    for (const n of names) shelf(n, [[1, `shared lesson for ${n[0]}`]]);
    const first = [human(), JSON.stringify(json())];
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    for (const n of [...names].reverse()) shelf(n, [[1, `shared lesson for ${n[0]}`]]);
    expect([human(), JSON.stringify(json())]).toEqual(first);
    // the larger-holder group (q, 3 shelves) sorts before the smaller (r, 2 shelves)
    expect(json().crossShelfDups.map((d) => d.base)).toEqual(['q', 'r']);
  });
});

describe('nb-janitor sections 2 & 8 — read-only and neutral (issue #362)', () => {
  test('an empty store reports both signals as clear (empty arrays in --json)', () => {
    const r = json();
    expect(r.slugVariants).toEqual([]);
    expect(r.crossShelfDups).toEqual([]);
    const out = human();
    expect(section(out, 2)).toContain('no suspiciously similar shelf names');
    expect(section(out, 8)).toContain('no lesson appears in more than one');
  });

  test('neither signal writes to the store', () => {
    shelf('a@app', [[1, 'dup lesson']]);
    shelf('a@acme-app', [[1, 'dup lesson']]);
    const before = snapshot();
    human();
    json();
    expect(snapshot()).toEqual(before);
  });

  test('the wording never calls a duplicate a "promotion" (the janitor stays harness-neutral)', () => {
    shelf('a@app', [[1, 'dup lesson']]);
    shelf('a@acme-app', [[1, 'dup lesson']]);
    expect(human()).not.toMatch(/promot/i);
    expect(JSON.stringify(json())).not.toMatch(/promot/i);
  });
});
