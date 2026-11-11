import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Issue #303: the hook must distinguish a failing `nb list` from an empty one.
const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, '..', 'examples', 'hooks', 'claude-code', 'nb-session-start.sh');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-session-start-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(stubBody: string, extraEnv: Record<string, string> = {}): string {
  const stub = join(dir, 'nb-stub');
  writeFileSync(stub, `#!/usr/bin/env bash\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  // NB_PROJECT_SLUG / NB_GLOBAL_SHELF are removed first (truly unset, not empty) so a
  // developer's own shell cannot switch the layered variant on for the default tests.
  const env: NodeJS.ProcessEnv = { ...process.env, NB_BIN: stub, ...extraEnv };
  for (const k of ['NB_PROJECT_SLUG', 'NB_GLOBAL_SHELF']) if (!(k in extraEnv)) delete env[k];
  return execFileSync('bash', [hook], {
    env,
    encoding: 'utf-8',
  });
}

describe('nb-session-start.sh', () => {
  test('empty successful list → empty-store note only', () => {
    const out = run('exit 0');
    expect(out).toContain('no notebooks yet');
    expect(out).not.toContain('WARNING');
  });

  test('failing list → distinct error note, not the empty note', () => {
    const out = run('echo boom >&2; exit 3');
    expect(out).toContain('WARNING');
    expect(out).toContain('exit 3');
    expect(out).not.toContain('no notebooks yet');
  });

  test('rows → indented rows, no notes', () => {
    const out = run('printf "alpha  3  when a\\nbeta  1  when b\\n"');
    expect(out).toContain('  alpha  3  when a\n  beta  1  when b');
    expect(out).not.toContain('no notebooks yet');
    expect(out).not.toContain('WARNING');
  });

  test('missing nb → fail-open, no output', () => {
    const out = execFileSync('bash', [hook], {
      env: { ...process.env, NB_BIN: join(dir, 'does-not-exist') },
      encoding: 'utf-8',
    });
    expect(out).toBe('');
  });
});

// The optional layered variant (docs/memory-layers.md): off unless NB_PROJECT_SLUG
// is set, then it groups `nb list --json` rows by the text after the last `@`.
const row = (shelf: string, lessons = 1, desc: string | null = null) => ({
  role: shelf,
  shelf,
  lessons,
  desc,
  auto: `auto text of ${shelf}`,
});
// A stub `nb` that serves the given rows for `list --json` and the flat text for
// plain `list`, so a test can tell which of the two the hook asked for.
const layeredStub = (rows: unknown[], total = rows.length) =>
  `if [ "$1" = list ] && [ "$2" = --json ]; then printf '%s' '${JSON.stringify({ dir: '/x', total, rows })}'; else echo FLAT-LIST; fi`;

describe('nb-session-start.sh layered variant (NB_PROJECT_SLUG)', () => {
  const rows = [
    row('code-review@acme-app', 2, 'reviewing a diff in acme-app'),
    row('Build-And-Test@ACME-APP'), // case-insensitive slug match
    row('code-review'),
    row('release-notes', 3, 'writing release notes'),
    row('global'),
    row('code-review@acme-web'),
    row('a@b@acme-app'), // last `@` wins
    row('a@acme-app@other'), // last `@` wins: another project's shelf
  ];

  test('groups project / domain / global, project first, and counts the hidden shelves', () => {
    const out = run(layeredStub(rows), { NB_PROJECT_SLUG: 'acme-app' });
    const project = out.indexOf('### Project layer');
    const domain = out.indexOf('### Domain layer');
    const global = out.indexOf('### Global layer');
    expect(project).toBeGreaterThan(-1);
    expect(domain).toBeGreaterThan(project);
    expect(global).toBeGreaterThan(domain);
    const section = (from: number, to: number) => out.slice(from, to);
    const projectText = section(project, domain);
    expect(projectText).toContain('code-review@acme-app  2  reviewing a diff in acme-app');
    expect(projectText).toContain('Build-And-Test@ACME-APP');
    expect(projectText).toContain('a@b@acme-app');
    expect(projectText).not.toContain('code-review@acme-web');
    const domainText = section(domain, global);
    expect(domainText).toContain('code-review  1  auto text of code-review');
    expect(domainText).toContain('release-notes  3  writing release notes');
    expect(out.slice(global)).toContain('  global  1  auto text of global');
    expect(out).toContain('2 shelf(s) for other projects hidden (slug: acme-app); `nb list` shows all');
    expect(out).toContain('Precedence if lessons conflict: project > domain > global.');
    expect(out).not.toContain('FLAT-LIST');
  });

  test('NB_GLOBAL_SHELF names the global shelf', () => {
    const out = run(layeredStub([row('house-rules'), row('global')]), {
      NB_PROJECT_SLUG: 'acme-app',
      NB_GLOBAL_SHELF: 'house-rules',
    });
    expect(out.slice(out.indexOf('### Global layer'))).toContain('house-rules');
    expect(out.slice(out.indexOf('### Domain layer'), out.indexOf('### Global layer'))).toContain('  global  1');
  });

  test('a slug matching no shelf is loud, not a quiet empty section', () => {
    const out = run(layeredStub(rows), { NB_PROJECT_SLUG: 'wrong-slug' });
    expect(out).toContain('(none yet');
    expect(out).toContain('NONE end in @wrong-slug');
  });

  test('a surrounding-space slug is trimmed', () => {
    const out = run(layeredStub(rows), { NB_PROJECT_SLUG: '  acme-app  ' });
    expect(out).toContain('### Project layer (shelves ending in @acme-app)');
  });

  test('non-JSON output falls back to the flat index with a warning', () => {
    const out = run('echo not-json', { NB_PROJECT_SLUG: 'acme-app' });
    expect(out).toContain('WARNING: layered index unavailable');
    expect(out).toContain('not-json');
    expect(out).not.toContain('### Project layer');
  });

  test('a failing `nb list --json` falls back to the flat index, which reports the failure', () => {
    const out = run('exit 3', { NB_PROJECT_SLUG: 'acme-app' });
    expect(out).toContain('WARNING: layered index unavailable');
    expect(out).toContain('`nb list` failed with exit 3');
  });

  test('a blank or whitespace-only NB_PROJECT_SLUG counts as unset', () => {
    for (const blank of ['', '   ']) {
      const out = run(layeredStub(rows), { NB_PROJECT_SLUG: blank });
      expect(out).toContain('FLAT-LIST');
      expect(out).not.toContain('### Project layer');
    }
  });

  test('past the row limit, a line says how many shelves were not classified', () => {
    const out = run(layeredStub(rows, rows.length + 5), { NB_PROJECT_SLUG: 'acme-app' });
    expect(out).toContain('5 more shelf(s) were not classified');
  });

  test('past the row limit, an empty project layer does not claim no shelf ends in the slug', () => {
    // Only other-project shelves were fetched, but 5 more were cut off: the project's own
    // shelf may be among them, so the loud "NONE end in @slug" note would be a false claim.
    const out = run(layeredStub([row('code-review@acme-web')], 6), { NB_PROJECT_SLUG: 'acme-app' });
    expect(out).toContain('5 more shelf(s) were not classified');
    expect(out).not.toContain('NONE end in');
  });

  test('unset NB_PROJECT_SLUG keeps the flat index', () => {
    const out = run(layeredStub(rows));
    expect(out).toContain('FLAT-LIST');
    expect(out).not.toContain('### Project layer');
  });
});
