import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// npmjs.com is expected to cut a package README at 65,536 characters. The
// 0.10.0 README was 71,929: a cut there falls inside the `## Programmatic use`
// code fence, which would drop Status, Changelog, Contributing and License and
// leave a fence open. These tests keep the README well under that limit and
// keep its links working on both GitHub and npm.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_BLOB = 'https://github.com/jeanibarz/agent-notebook/blob/main/';
const readme = (): string => readFileSync(join(root, 'README.md'), 'utf-8');

/** The Markdown with every fenced code block removed, so `# comment` lines are not headings. */
function withoutFences(md: string): string {
  return md.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');
}

/** GitHub's heading slug: lower-case, drop punctuation (keep letters, digits, `_`, `-`), spaces to `-`. */
export function githubSlug(heading: string): string {
  const text = heading
    .replace(/<[^>]*>/g, '') // inline HTML
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/[`*]/g, '') // code and emphasis markers
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

/** Every anchor a Markdown file defines: heading slugs (with GitHub's -1, -2 suffixes) and `<a id>`s. */
export function anchorsOf(md: string): Set<string> {
  const body = withoutFences(md);
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = githubSlug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of body.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  return anchors;
}

/** The targets of every Markdown link and `href` outside code fences. */
function linkTargets(md: string): string[] {
  const body = withoutFences(md);
  const out: string[] = [];
  for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  for (const m of body.matchAll(/\bhref="([^"]+)"/g)) out.push(m[1]);
  return out;
}

describe('README stays under the npm cut and its links resolve', () => {
  test('the README is under 60,000 characters (npm is expected to cut at 65,536)', () => {
    expect([...readme()].length).toBeLessThan(60_000);
  });

  test('the slugger matches slugs the docs already link to', () => {
    expect(githubSlug('Grouping notebooks — the `.` namespace convention')).toBe(
      'grouping-notebooks--the--namespace-convention',
    );
    expect(githubSlug('Discovering notebooks — `nb list`')).toBe('discovering-notebooks--nb-list');
    expect(githubSlug('Per-repository on/off')).toBe('per-repository-onoff');
    expect(githubSlug('Machine-readable `nb stats`')).toBe('machine-readable-nb-stats');
    expect([...anchorsOf('# A\n\n```\n# not a heading\n```\n## A\n')]).toEqual(['a', 'a-1']);
  });

  test('every #anchor link in the README points at a heading or an <a id> in it', () => {
    const md = readme();
    const anchors = anchorsOf(md);
    const local = linkTargets(md).filter((t) => t.startsWith('#'));
    expect(local.length).toBeGreaterThan(0);
    const broken = local.filter((t) => !anchors.has(t.slice(1)));
    expect(broken, `README links to missing anchors: ${broken.join(', ')}`).toEqual([]);
  });

  test('every link to a file in this repository names a file that exists, and its #anchor resolves', () => {
    const broken: string[] = [];
    for (const t of linkTargets(readme())) {
      if (!t.startsWith(REPO_BLOB)) continue;
      const [path, anchor] = t.slice(REPO_BLOB.length).split('#');
      const file = join(root, path);
      if (!existsSync(file)) {
        broken.push(`${t} (no such file)`);
        continue;
      }
      if (anchor && path.endsWith('.md') && !anchorsOf(readFileSync(file, 'utf-8')).has(anchor)) {
        broken.push(`${t} (no such anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test('every relative link points into the npm package, so it also works on npmjs.com', () => {
    const files: string[] = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).files;
    const relative = linkTargets(readme()).filter((t) => !/^(?:[a-z]+:|#)/i.test(t));
    expect(relative.length).toBeGreaterThan(0);
    const outside = relative.filter((t) => {
      const top = t.split('#')[0].replace(/^\.\//, '').split('/')[0];
      return !files.includes(top) || !existsSync(join(root, t.split('#')[0]));
    });
    expect(outside, `relative links to files npm does not ship: ${outside.join(', ')}`).toEqual([]);
  });
});
