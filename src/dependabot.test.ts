import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards issue #313: Dependabot must track the npm dev toolchain (which runs
// inside the OIDC-privileged release job) as well as the pinned GitHub Actions.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = readFileSync(join(root, '.github', 'dependabot.yml'), 'utf-8');
// Split the `updates:` list into one text block per `- package-ecosystem:` entry.
const entries = cfg
  .split(/^\s*- (?=package-ecosystem:)/m)
  .slice(1)
  .map((b) => b);
const entryFor = (eco: string) =>
  entries.find((e) => new RegExp(`^package-ecosystem:\\s*"${eco}"\\s*$`, 'm').test(e));

describe('.github/dependabot.yml', () => {
  test.each(['github-actions', 'npm'])('declares the %s ecosystem at the repo root', (eco) => {
    const e = entryFor(eco);
    expect(e, `no ${eco} entry`).toBeDefined();
    expect(e).toMatch(/^\s*directory:\s*"\/"\s*$/m);
    expect(e).toMatch(/^\s*interval:\s*"weekly"\s*$/m);
  });

  test('npm updates are grouped to keep PR volume low', () => {
    expect(entryFor('npm')).toMatch(/^\s*groups:\s*$/m);
  });
});
