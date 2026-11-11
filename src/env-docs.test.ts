import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drift guard for issue #164: every `NB_*` environment variable the shipping
// code reads must be documented in the README's env reference. Three knobs
// (NB_ASCII, NB_STALE_LOCK_MS, NB_LOCK_GRACE_MS) shipped undocumented because
// the "new knob, undocumented" miss is a manual step nothing enforced; this
// test turns that recurring gap into a CI failure instead of a code review a
// human has to remember to do.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Allow-list policy: a token listed here is intentionally NOT required in the
// README, and WHY must be stated next to it. Keep this list as short as the
// honesty of each entry allows — anything user-facing belongs in the docs, not
// here. An internal/test-only var is exempted EXPLICITLY (so the exemption is
// auditable) rather than slipping through silently.
//   - NB_TEST_NODE_VERSION: test-harness-only override (read by
//     scripts/check-node-for-tests.mjs, exercised in
//     src/check-node-for-tests.test.ts) used to simulate an unsupported Node
//     version; never read by shipping code and nothing a user would set, so it
//     is not a documented knob. It only appears in a *.test.ts file today, so
//     the test-file exclusion already drops it — this entry is the explicit,
//     auditable exemption point should it ever be referenced from shipping code.
const ALLOW_LIST = new Set<string>(['NB_TEST_NODE_VERSION']);

// Scan the SHIPPING sources only: `src/*.ts` minus `*.test.ts`. Test files read
// vars (env cleanup, simulated overrides) that are not part of the user-facing
// surface, so they are not a documentation obligation.
function shippingSourceFiles(): string[] {
  return readdirSync(join(root, 'src'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(root, 'src', f));
}

// Every distinct `NB_[A-Z_]+` token read across the shipping sources.
function envTokensInSource(): Set<string> {
  const tokens = new Set<string>();
  const re = /NB_[A-Z_]+/g;
  for (const file of shippingSourceFiles()) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(re)) tokens.add(m[0]);
  }
  return tokens;
}

describe('NB_* env-var documentation drift guard (issue #164)', () => {
  test('every NB_* var read by shipping code is documented in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    const tokens = [...envTokensInSource()].filter((t) => !ALLOW_LIST.has(t));

    // Sanity: the scan actually found vars (guards against a regex/glob break
    // that would make this test vacuously pass).
    expect(tokens.length).toBeGreaterThan(0);

    // Plain substring is enough: README documents each var by its literal name.
    const undocumented = tokens.filter((t) => !readme.includes(t)).sort();
    expect(undocumented, `undocumented NB_* env vars: ${undocumented.join(', ')}`).toEqual([]);
  });

  // Issue #380: the spec's §7 table claims to list every variable, and the repo
  // calls the spec its source of truth, so the README guard above stops one
  // document short. Names only: defaults and ranges are not machine-checked.
  test('every NB_* var read by shipping code is listed in the spec §7 configuration table', () => {
    const spec = readFileSync(join(root, 'docs', 'requirements.md'), 'utf-8');
    const start = spec.indexOf('\n## 7. Configuration');
    expect(start, '§7 heading not found').toBeGreaterThan(-1);
    const end = spec.indexOf('\n## ', start + 1);
    const section = spec.slice(start, end === -1 ? undefined : end);
    // Variables the code READS (`process.env.NB_X` or a tunable's `env: 'NB_X'`),
    // not every NB_* token: the source also names example-tool knobs and a
    // deliberate typo in messages, which the spec rightly keeps out of §7.
    const read = new Set<string>();
    for (const file of shippingSourceFiles()) {
      for (const m of readFileSync(file, 'utf-8').matchAll(/(?:\benv\.|\benv: ')(NB_[A-Z_]+)/g)) read.add(m[1]);
    }
    expect(read.size, 'scan found no env reads').toBeGreaterThan(10);
    const tokens = [...read].filter((t) => !ALLOW_LIST.has(t));
    const missing = tokens.filter((t) => !section.includes('`' + t + '`')).sort();
    expect(missing, `NB_* vars missing from docs/requirements.md §7: ${missing.join(', ')}`).toEqual([]);
  });

  test('the three vars from issue #164 are documented by name', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    for (const v of ['NB_ASCII', 'NB_STALE_LOCK_MS', 'NB_LOCK_GRACE_MS']) {
      expect(readme.includes(v), `${v} missing from README`).toBe(true);
    }
  });
});

// Drift guard for issue #207: the #164 guard above scans only `src/*.ts`, but
// the package also ships the `examples/**` scripts (they are in package.json
// `files`), and users copy those verbatim. Those scripts read their own `NB_*`
// knobs (e.g. NB_GIT_AUTOCOMMIT, NB_RETRO_TTL_DAYS, NB_BIN) that the src-only
// guard never sees — the exact "new knob ships undocumented" gap #164 exists to
// close, one directory over. This block extends the same discipline to the
// shipped example scripts.
//
// Documentation home (the decidable rule): an example knob counts as documented
// if its literal name appears in ANY shipped doc — the root README or any
// Markdown file under `examples/**` (all ship via package `files`). Keeping the
// home flexible but the check decidable mirrors the src guard, which likewise
// only asks whether the token appears in the README text.

// Allow-list for the examples scan: a token matched by the `NB_[A-Z_]+` regex
// that is intentionally NOT a documented user-facing knob. As with the src
// allow-list, WHY must be stated next to each entry and the list stays as short
// as honesty allows.
//   - NB_DIR_DEFAULT: a *local shell variable* in
//     examples/hooks/claude-code/nb-retrospective.sh
//     (`NB_DIR_DEFAULT="${HOME}/.agent-notebook/notebooks"`), used only to hold
//     the fallback for the real `NB_DIR` env var. It is never read from the
//     environment and is nothing a user sets, so it is not a knob to document;
//     it only matches the regex because the token prefix collides.
const EXAMPLE_ALLOW_LIST = new Set<string>(['NB_DIR_DEFAULT']);

// The scripts users copy: every file under `examples/**` that is NOT a Markdown
// doc. The `*.md` files are the DOCUMENTATION surface (scanned below as the doc
// home), not a token source. `readdirSync` is used recursively via an explicit
// walk (not the Node 20.1+ `recursive` option) so the test runs on Node 18 too.
function shippedExampleScriptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(join(root, 'examples'));
  return out;
}

// Every distinct `NB_[A-Z_]+` token read across the shipped example scripts.
function envTokensInExampleScripts(): Set<string> {
  const tokens = new Set<string>();
  const re = /NB_[A-Z_]+/g;
  for (const file of shippedExampleScriptFiles()) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(re)) tokens.add(m[0]);
  }
  return tokens;
}

// The concatenated text of every shipped doc an example knob may be documented
// in: the root README plus every Markdown file under `examples/**`.
function shippedDocText(): string {
  const docs = [join(root, 'README.md')];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) docs.push(full);
    }
  };
  walk(join(root, 'examples'));
  return docs.map((f) => readFileSync(f, 'utf-8')).join('\n');
}

// A token counts as documented only when it appears as a WHOLE token in a
// shipped doc. A bare `docs.includes(t)` would treat `NB_MAX` as documented by
// `NB_MAX_LINES`, or an example-only knob as documented merely because the
// README documents a same-named `src/` knob — both false "documented" passes.
// The `NB_[A-Z_]+` tokens contain only `[A-Z_]`, so the only way to over-match
// is an adjacent `[A-Z_]`; the lookarounds forbid exactly that.
function isDocumented(token: string, docs: string): boolean {
  return new RegExp(`(?<![A-Z_])${token}(?![A-Z_])`).test(docs);
}

// Anchor tokens that each live only in a particular examples subtree
// (`NB_GIT_AUTOCOMMIT` in a top-level `.mjs`, `NB_RETRO_TTL_DAYS` only under
// `hooks/claude-code/`). Requiring all of them in the scanned set proves the
// recursive walk reached the nested script dirs, so a broken recursion can't
// make the guard vacuously pass on a partial file set.
const EXAMPLE_SCAN_ANCHORS = ['NB_DIR', 'NB_GIT_AUTOCOMMIT', 'NB_RETRO_TTL_DAYS'];

describe('NB_* env-var documentation drift guard for shipped examples (issue #207)', () => {
  test('every NB_* var read by a shipped example script is documented in a shipped doc', () => {
    const docs = shippedDocText();
    const scanned = envTokensInExampleScripts();

    // The scan actually reached every example script subtree (and found vars),
    // so this test cannot pass vacuously on a broken walk/regex.
    for (const anchor of EXAMPLE_SCAN_ANCHORS) {
      expect(scanned.has(anchor), `scan missed ${anchor} — examples walk is incomplete`).toBe(true);
    }

    const tokens = [...scanned].filter((t) => !EXAMPLE_ALLOW_LIST.has(t));
    const undocumented = tokens.filter((t) => !isDocumented(t, docs)).sort();
    expect(
      undocumented,
      `undocumented example-script NB_* env vars: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  test('the example knobs called out in issue #207 are read by a script AND documented', () => {
    const docs = shippedDocText();
    const scanned = envTokensInExampleScripts();
    // Pin both halves: the knob is still actually read by a shipped script (so a
    // rename/removal is caught, not silently "documented") and is documented.
    for (const v of ['NB_RETRO_TTL_DAYS', 'NB_GIT_AUTOCOMMIT', 'NB_BIN']) {
      expect(scanned.has(v), `${v} is no longer read by any example script`).toBe(true);
      expect(isDocumented(v, docs), `${v} missing from shipped docs`).toBe(true);
    }
  });

  test('every examples allow-list entry is still read by a script (no stale exemptions)', () => {
    const scanned = envTokensInExampleScripts();
    // An allow-list entry exempts a token from the doc requirement; once the
    // script stops reading it, the exemption is dead weight that could later
    // hide a real knob reusing the name. Fail so it gets pruned.
    for (const entry of EXAMPLE_ALLOW_LIST) {
      expect(
        scanned.has(entry),
        `allow-list entry ${entry} no longer appears in any example script — remove it`,
      ).toBe(true);
    }
  });
});
