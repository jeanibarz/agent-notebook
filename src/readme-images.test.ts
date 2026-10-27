import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the acceptance criteria of issue #43: the README's explainer images
// must render on the npm package page, not just on GitHub. npm renders the
// README on npmjs.com where no local `assets/` sits next to it, and it does
// NOT rewrite relative paths inside raw <img> tags (only Markdown ![]() image
// syntax). So a relative `src="assets/..."` 404s on npm. The fix is an
// absolute URL that resolves anywhere; this test fails if anyone reintroduces
// a relative image source, and also checks each referenced asset is a real
// committed file so GitHub keeps rendering it in-repo.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = () => readFileSync(join(root, 'README.md'), 'utf-8');

// Every <img ... src="..."> in the README, with its raw src value.
function imageSources(md: string): string[] {
  const srcs: string[] = [];
  const imgTag = /<img\b[^>]*>/gi;
  const srcAttr = /\bsrc\s*=\s*"([^"]*)"/i;
  for (const tag of md.match(imgTag) ?? []) {
    const m = tag.match(srcAttr);
    if (m) srcs.push(m[1]);
  }
  return srcs;
}

describe('README explainer images (issue #43)', () => {
  test('the three explainer SVGs are referenced', () => {
    const srcs = imageSources(readme());
    for (const file of ['cat.svg', 'leaderboard.svg', 'gitdiff.svg']) {
      expect(srcs.some((s) => s.endsWith(`/assets/${file}`))).toBe(true);
    }
  });

  test('every image src is an absolute URL so it resolves on npmjs.com', () => {
    const srcs = imageSources(readme());
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      // A relative `assets/...` path (or any non-absolute, non-data src) is the
      // exact thing that 404s on the npm package page — reject it.
      expect(/^(https?:)?\/\/|^data:/.test(src)).toBe(true);
    }
  });

  test('each referenced asset is a committed file so GitHub still renders it', () => {
    const srcs = imageSources(readme());
    for (const src of srcs) {
      const m = src.match(/\/assets\/([^/?#]+)$/);
      if (!m) continue; // non-asset images (e.g. badges) are not our concern
      expect(existsSync(join(root, 'assets', m[1]))).toBe(true);
    }
  });
});
