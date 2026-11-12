import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards issue #421: every `Proven by` line in docs/requirements.md cites a test
// by name, and nothing else checked that the name still exists. A renamed test,
// or a citation typed with a curly apostrophe instead of the straight one in the
// source, went unnoticed until a reviewer happened to look.
//
// What counts as a citation (everything else in a Proven-by paragraph, such as
// file names and prose like "the three `issue #335` tests", is ignored on purpose):
//   - a double-quoted string:            "a stable id keeps pointing at ..."
//   - a describe('...') inside backticks: `describe('caps')`
// A citation must equal a test/describe/it title in src/*.test.ts byte for byte.
// One containing an ellipsis (…) is an elided title: each piece between ellipses
// must appear, in order, inside a single title.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const TITLE_CALL = /\b(?:describe|it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Every describe/it/test title found in the given test-source texts. */
export function testTitles(sources: string[]): string[] {
  const titles: string[] = [];
  for (const src of sources) {
    for (const m of src.matchAll(TITLE_CALL)) titles.push(m[2].replace(/\\(.)/g, '$1'));
  }
  return titles;
}

/** The text of each `Proven by` paragraph, line breaks folded to single spaces. */
function provenByParagraphs(md: string): string[] {
  const paras: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/Proven by/.test(lines[i])) continue;
    const buf: string[] = [];
    for (; i < lines.length && lines[i].trim() !== ''; i++) buf.push(lines[i].trim());
    paras.push(buf.join(' '));
  }
  return paras;
}

/** The quoted test names cited in one Proven-by paragraph. */
function citations(para: string): string[] {
  const out: string[] = [];
  const rest = para.replace(/`describe\('((?:\\.|[^'\\])*)'\)`/g, (_, name: string) => {
    out.push(name);
    return ' ';
  });
  for (const m of rest.matchAll(/"((?:\\.|[^"\\])+)"/g)) out.push(m[1].replace(/\\"/g, '"'));
  return out;
}

function matchesTitle(citation: string, titles: string[]): boolean {
  // A title written as a template literal (`... ${code} ...`) stands for several tests.
  const templated = titles
    .filter((t) => t.includes('${'))
    .map((t) => new RegExp('^' + t.split(/\$\{[^}]*\}/).map((x) => x.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('.+') + '$'));
  if (templated.some((re) => re.test(citation))) return true;
  if (!citation.includes('…')) return titles.includes(citation);
  const pieces = citation.split('…').map((p) => p.trim()).filter(Boolean);
  return titles.some((t) => {
    let from = 0;
    for (const p of pieces) {
      const at = t.indexOf(p, from);
      if (at < 0) return false;
      from = at + p.length;
    }
    return true;
  });
}

/** Returns the citations in `md` that name no title in `titles`, and how many were checked. */
export function staleCitations(md: string, titles: string[]): { stale: string[]; checked: number } {
  const stale: string[] = [];
  let checked = 0;
  for (const para of provenByParagraphs(md)) {
    for (const c of citations(para)) {
      checked++;
      if (!matchesTitle(c, titles)) stale.push(c);
    }
  }
  return { stale, checked };
}

describe('docs/requirements.md Proven-by citations name existing tests (issue #421)', () => {
  const srcDir = join(root, 'src');
  const sources = readdirSync(srcDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(srcDir, f), 'utf8'));
  const titles = testTitles(sources);

  test('every quoted test name in a Proven-by line is a test title in src/', () => {
    const md = readFileSync(join(root, 'docs', 'requirements.md'), 'utf8');
    const { stale, checked } = staleCitations(md, titles);
    // A floor, so a parser that silently stops finding citations cannot pass.
    expect(checked).toBeGreaterThan(40);
    expect(stale, `stale Proven-by citation(s) in docs/requirements.md:\n${stale.map((s) => `  - ${s}`).join('\n')}`).toEqual([]);
  });

  const titlesFixture = ["it keeps the id", 'describe title', "the docked line's move"];
  const doc = (cite: string) => `text\n*Proven by:* \`x.test.ts\` → ${cite}.\n\nnext`;

  test('a cited test that was renamed is reported by name', () => {
    const { stale } = staleCitations(doc('"it keeps the identifier"'), titlesFixture);
    expect(stale).toEqual(['it keeps the identifier']);
  });

  test('a citation differing only by a curly apostrophe is reported', () => {
    expect(staleCitations(doc("\"the docked line's move\""), titlesFixture).stale).toEqual([]);
    expect(staleCitations(doc('"the docked line’s move"'), titlesFixture).stale).toEqual([
      'the docked line’s move',
    ]);
  });

  test('describe(...) citations and elided titles are checked too', () => {
    expect(staleCitations(doc("`describe('describe title')`"), titlesFixture).stale).toEqual([]);
    expect(staleCitations(doc("`describe('gone')`"), titlesFixture).stale).toEqual(['gone']);
    expect(staleCitations(doc('"it … id"'), titlesFixture).stale).toEqual([]);
    expect(staleCitations(doc('"id … it"'), titlesFixture).stale).toEqual(['id … it']);
  });

  test('a citation continued onto the next line is joined before checking', () => {
    const md = '*Proven by:* "it keeps\nthe id".\n';
    expect(staleCitations(md, titlesFixture).stale).toEqual([]);
  });
});
