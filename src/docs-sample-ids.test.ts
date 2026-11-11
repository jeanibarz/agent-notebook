import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryId } from './notebook.js';

// Guards issue #400: a copy-pasteable example in the docs must not vote by an
// id the lesson above it never gets. Ids are derived from the lesson text, so
// inside one fenced code block every 6-hex id that we can pair with an
// `nb add` in the same block must equal entryId() of that add's text.
// Anything we cannot pair unambiguously (blocks with no `nb add`, truncated
// "text…" samples, ids of lessons added elsewhere) is ignored on purpose, so
// sample-output prose does not become test-pinned.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function fencedBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) blocks.push(m[1]);
  return blocks;
}

const ADD = /^(?:\$ )?nb add \S+ "([^"]+)"/;
const SELECTOR = /^(?:\$ )?nb (?:vote|rm|merge|split|move) \S+ ([0-9a-f]{6})(?=\s|$)/;
const SHOW = /^([0-9a-f]{6})  \[[+-]?\d+\]  (.+?)\s*$/;

/** Returns [doc id, expected id, line] mismatches and the count of pairs checked. */
export function checkBlock(block: string): { bad: string[]; checked: number } {
  const lines = block.split('\n');
  const texts = lines.map((l) => ADD.exec(l)?.[1]).filter((t): t is string => !!t);
  const ids = new Set(texts.map(entryId));
  const bad: string[] = [];
  let checked = 0;
  if (texts.length === 0) return { bad, checked };
  for (const line of lines) {
    const sel = SELECTOR.exec(line);
    if (sel) {
      checked++;
      if (!ids.has(sel[1])) bad.push(`${line}  (known ids: ${[...ids].join(', ')})`);
      continue;
    }
    const show = SHOW.exec(line);
    if (show && texts.includes(show[2])) {
      checked++;
      if (show[1] !== entryId(show[2])) bad.push(`${line}  (real id: ${entryId(show[2])})`);
    }
  }
  return { bad, checked };
}

describe('doc sample ids match entryId (issue #400)', () => {
  for (const file of ['README.md', 'docs/getting-started.md']) {
    test(`${file}: ids paired with an nb add in the same code block are real`, () => {
      const results = fencedBlocks(readFileSync(join(root, file), 'utf-8')).map(checkBlock);
      expect(results.flatMap((r) => r.bad)).toEqual([]);
      expect(results.reduce((n, r) => n + r.checked, 0)).toBeGreaterThan(0);
    });
  }

  test('the checker flags a wrong id (not vacuous)', () => {
    const block = 'nb add s "run lint"\nnb vote s 3f9a2c +1\n';
    expect(checkBlock(block).bad).toHaveLength(1);
    const ok = `nb add s "run lint"\nnb vote s ${entryId('run lint')} +1\n`;
    expect(checkBlock(ok)).toEqual({ bad: [], checked: 1 });
  });
});
