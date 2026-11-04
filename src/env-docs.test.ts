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

  test('the three vars from issue #164 are documented by name', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf-8');
    for (const v of ['NB_ASCII', 'NB_STALE_LOCK_MS', 'NB_LOCK_GRACE_MS']) {
      expect(readme.includes(v), `${v} missing from README`).toBe(true);
    }
  });
});
