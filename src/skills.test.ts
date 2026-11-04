import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_COMMANDS } from './cli.js';

// Repo root resolved from this test file (src/skills.test.ts → ..), mirroring the
// terminology / HELP-drift guards in cli.test.ts. The skills guard reads the
// SHIPPED `.claude/skills/**/SKILL.md` setup/explain instructions from here.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, '.claude', 'skills');

// Issue #170: the two shipped skills (`agent-notebook-setup`,
// `agent-notebook-explain`) teach users to run `nb` subcommands (`nb path`,
// `nb add/show/rm`, `nb list`, `nb stats`), but nothing tested those references
// stayed valid — unlike the HELP↔dispatch (#131) and `<role>`-term (#140) drift
// guards. A renamed or removed command would ship broken setup/explain
// instructions to every installer while the suite stayed green: the same
// silent-doc-drift class the repo already guards elsewhere.
//
// This guard extracts every `nb <token>` reference from each SKILL.md and asserts
// the token is a real command. The command set is NOT re-listed here: it is
// imported as `KNOWN_COMMANDS` from cli.ts — the single source the HELP /
// did-you-mean drift guards in cli.test.ts already pin to the dispatch switch
// (`KNOWN_COMMANDS covers every dispatched command`). So there is no third place
// to update: renaming a command updates cli.ts, and a now-stale `nb <old>` line
// in a SKILL.md turns THIS suite red.

// All `SKILL.md` files under `.claude/skills`, searched recursively so a skill
// nested in a subdirectory (the `**` in the issue's `**/SKILL.md` glob) is covered.
function findSkillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...findSkillFiles(p));
    else if (entry === 'SKILL.md') out.push(p);
  }
  return out;
}

/**
 * The command token of every `nb <token>` reference in `src`.
 *
 * Anchored on the command token only: the capture stops at the first word after
 * `nb`, so an argument-bearing invocation like `nb list index` yields just
 * `list` (never the prose/arg word `index`) — the false-positive the issue calls
 * out. `\w[\w-]*` matches a command-shaped token (letters, digits, `-`); a
 * `-`-prefixed flag such as `nb --help` has no word char after the gap and so is
 * never captured.
 *
 * The gap is `[ \t]+` (the issue's single-space `nb ` widened to also catch a
 * double-spaced `nb  show`) but deliberately NOT `\s+`: matching a newline would
 * pair a line-ending `nb` with the first word of the next line, turning wrapped
 * prose ("...the nb\ncommand...") into a spurious `command` reference — exactly
 * the prose false-positive this guard must avoid.
 */
function nbCommandRefs(src: string): string[] {
  return [...src.matchAll(/\bnb[ \t]+(\w[\w-]*)/g)].map((m) => m[1]);
}

const KNOWN = new Set<string>(KNOWN_COMMANDS);
const skillFiles = findSkillFiles(SKILLS_DIR);

describe('skills SKILL.md command-drift guard (issue #170)', () => {
  test('the shipped skills are actually discovered (guard is not vacuous)', () => {
    // A broken path or glob would silently test nothing; pin that the two
    // shipped skills are present so the per-file assertions below have teeth.
    expect(skillFiles.length).toBeGreaterThan(0);
    const names = skillFiles.map((p) => p.slice(REPO_ROOT.length));
    expect(names.some((n) => n.includes('agent-notebook-setup'))).toBe(true);
    expect(names.some((n) => n.includes('agent-notebook-explain'))).toBe(true);
  });

  test('the imported command set is non-empty and holds the commands the skills teach', () => {
    // Anti-vacuous: if KNOWN_COMMANDS resolved empty, every membership check
    // below would fail loudly rather than this one — but pin it, and pin the
    // specific commands the current SKILL.md files reference, so a regression in
    // the import surfaces here with a clear cause.
    expect(KNOWN.size).toBeGreaterThan(0);
    for (const cmd of ['path', 'add', 'show', 'rm', 'list', 'stats']) {
      expect(KNOWN.has(cmd)).toBe(true);
    }
  });

  // One case per shipped skill so a failure names the exact file and token.
  test.each(skillFiles.map((p) => [p.slice(REPO_ROOT.length + 1), p] as const))(
    'every `nb <command>` reference in %s is a real dispatched command',
    (_rel, path) => {
      const refs = nbCommandRefs(readFileSync(path, 'utf8'));
      // Each skill must reference at least one command, else its extraction
      // passed vacuously (e.g. the regex silently matched nothing).
      expect(refs.length).toBeGreaterThan(0);
      const stale = [...new Set(refs)].filter((cmd) => !KNOWN.has(cmd));
      // Named so a failure says exactly which stale token to fix.
      expect(stale).toEqual([]);
    },
  );
});
