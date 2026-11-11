import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Drift guard for docs/memory-layers.md (issue #363). The page is a convention
// guide whose value is that its commands work, so this test (1) runs every
// ```sh block as written against a throwaway NB_DIR, using the built CLI, (2)
// checks that its relative links resolve, and (3) checks AGENTS.md and the
// README still point at it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(root, 'docs', 'memory-layers.md');
const pageText = readFileSync(page, 'utf-8');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'nb-memory-layers-'));
  // The page says `nb ...`; give it an `nb` on PATH that is the freshly built CLI.
  const shim = join(tmp, 'bin', 'nb');
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(shim, `#!/usr/bin/env bash\nexec node "${join(root, 'dist', 'cli.js')}" "$@"\n`);
  chmodSync(shim, 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('docs/memory-layers.md (issue #363)', () => {
  test('every ```sh block runs as written against a throwaway store', () => {
    const blocks = [...pageText.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0); // not vacuous
    // `set -e` stops at the first failing command; the page sets NB_DIR itself.
    // HOME points into the temp dir too, so even if a block lost its `export NB_DIR`,
    // `nb` would write to the default store under THIS home, never the developer's.
    const home = join(tmp, 'home');
    mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${join(tmp, 'bin')}:${process.env.PATH}` };
    delete env.NB_DIR;
    delete env.NB_MAX_LINES;
    const r = spawnSync('bash', ['-e', '-c', blocks.join('\n')], {
      cwd: root,
      env,
      encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    // The promotion really happened: the moved lesson kept its score and sits in the domain shelf.
    expect(r.stdout).toContain('moved [+1] Give each OR\'d guard condition');
    // The cap demo evicted the lowest-scored line of the full target shelf.
    expect(r.stdout).toContain('evicted lowest-scored from "shared"');
  });

  test('relative links resolve to files that exist', () => {
    const links = [...pageText.matchAll(/\]\((?!https?:|#)([^)#\s]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(existsSync(resolve(dirname(page), l)), `broken link in docs/memory-layers.md: ${l}`).toBe(true);
    }
  });

  test('relative links with a #anchor point at a heading that exists', () => {
    const slug = (h: string) =>
      h.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
    const withAnchor = [...pageText.matchAll(/\]\((?!https?:)([^)#\s]*)#([^)\s]+)\)/g)];
    expect(withAnchor.length).toBeGreaterThan(0);
    for (const [, file, anchor] of withAnchor) {
      const text = file ? readFileSync(resolve(dirname(page), file), 'utf-8') : pageText;
      // A target is a heading (GitHub slug) or an explicit `<a id="...">` (requirements.md uses those).
      // `#` lines inside fenced code blocks are comments, not headings, so drop the fences first.
      const prose = text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, '');
      // GitHub suffixes a repeated heading's anchor with -1, -2, ... in document order.
      const seen = new Map<string, number>();
      const headingAnchors = [...prose.matchAll(/^#{1,6} +(.+?) *$/gm)].map((m) => {
        const base = slug(m[1]);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return n === 0 ? base : `${base}-${n}`;
      });
      const anchors = [
        ...headingAnchors,
        ...[...text.matchAll(/<a id="([^"]+)"/g)].map((m) => m[1]),
      ];
      expect(anchors, `${file || 'memory-layers.md'}#${anchor} has no matching heading`).toContain(anchor);
    }
  });

  test('AGENTS.md and the README link to the page', () => {
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).toContain('docs/memory-layers.md');
    expect(readFileSync(join(root, 'README.md'), 'utf-8')).toContain('docs/memory-layers.md');
  });

  test('the page states what nb does not do', () => {
    for (const phrase of ['not a feature', 'nb promote', 'scope filter', 'obsolete --note duplicate']) {
      expect(pageText, `memory-layers.md lost "${phrase}"`).toContain(phrase);
    }
  });
});
