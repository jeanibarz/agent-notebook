/**
 * The answer to "where should notes be kept?" (issue #560, FR-PLACE-005): the grammar
 * of the one-word `.layout` file and the plain sentences built from it. Pure: no
 * import, no read, no clock. `layout-io.ts` reads and writes the files; only `cli.ts`
 * imports either.
 *
 * `.layout` holds exactly one word: `shared`, `own` or `ask`. No file means no choice
 * was made, which means the recommended layout (shared). A file that is not exactly
 * one of the three words (too long, a link, a NUL, an unknown word) is `unreadable`:
 * it counts as no default, and it never overrides an existing project folder.
 */

/** What a person can choose. */
export const LAYOUT_VALUES = ['shared', 'own', 'ask'] as const;
export type Layout = (typeof LAYOUT_VALUES)[number];

/** The recommended choice, in effect when none was made or the file cannot be read. */
export const LAYOUT_RECOMMENDED: Layout = 'shared';

/** The most bytes `.layout` may hold: the longest word plus a line end, with room. */
export const LAYOUT_FILE_MAX_BYTES = 64;

/** What a read of `.layout` found. `since` is the file's date, `YYYY-MM-DD`. */
export type LayoutRead =
  | { state: 'none' }
  | { state: 'chosen'; value: Layout; since: string }
  | { state: 'unreadable'; since: string | null };

/** `shared`, `own` or `ask` from the file's text (a BOM and surrounding white space, a CRLF included, are trimmed), else `null`. */
export function parseLayout(raw: string): Layout | null {
  const word = raw.replace(/^﻿/, '').trim();
  return (LAYOUT_VALUES as readonly string[]).includes(word) ? (word as Layout) : null;
}

/** The date of a file's modification time, `YYYY-MM-DD` (UTC). */
export function layoutDate(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  return Number.isNaN(d.getTime()) ? 'an unknown date' : d.toISOString().slice(0, 10);
}

/** The choice in force and where it comes from, as `nb place default --json` prints it. */
export function effectiveLayout(r: LayoutRead): { default: Layout; source: 'chosen' | 'recommended' | 'unreadable' } {
  if (r.state === 'chosen') return { default: r.value, source: 'chosen' };
  return { default: LAYOUT_RECOMMENDED, source: r.state === 'unreadable' ? 'unreadable' : 'recommended' };
}

/** What each choice means, in a few plain words. */
export const LAYOUT_WORDS: Record<Layout, string> = {
  shared: 'one notebook for all projects, in sections per project',
  own: 'a separate notebook for each project',
  ask: 'you are asked in each new project',
};

/**
 * The one line `nb place`, `nb status` and `nb config` add, or `null` when there is no
 * `.layout` (so every output is what it was before this file existed). The caller never
 * asks for it when `NB_DIR` is set.
 */
export function layoutLine(r: LayoutRead): string | null {
  if (r.state === 'none') return null;
  if (r.state === 'chosen') return `Where notes are kept: ${LAYOUT_WORDS[r.value]} (chosen on ${r.since}). To change it: nb place default shared|own|ask.`;
  return `Where notes are kept: the choice could not be read, so ${LAYOUT_WORDS[LAYOUT_RECOMMENDED]} applies. To set it again: nb place default shared|own|ask.`;
}

/** The additive `layout` object of the JSON outputs, or `null` when there is no `.layout`. */
export function layoutJson(r: LayoutRead): { default: Layout; source: 'chosen' | 'unreadable'; since: string | null } | null {
  if (r.state === 'none') return null;
  const e = effectiveLayout(r);
  return { default: e.default, source: r.state === 'chosen' ? 'chosen' : 'unreadable', since: r.since };
}

/** `nb place default` with no value: the choice and its source, in words. */
export function renderDefault(r: LayoutRead, nbDirSet: boolean): string {
  const e = effectiveLayout(r);
  const source =
    r.state === 'chosen'
      ? `chosen on ${r.since}`
      : r.state === 'unreadable'
        ? 'the choice file could not be read, so the recommended choice applies'
        : 'the recommended choice';
  const lines = [`default: ${e.default} (${source})`, `  ${LAYOUT_WORDS[e.default]}.`];
  if (r.state === 'unreadable') lines.push('  To set it again: nb place default shared|own|ask.');
  if (nbDirSet) lines.push('  NB_DIR is set here, so this applies only where NB_DIR is not set.');
  return lines.join('\n') + '\n';
}

/** What the answer changed for the project the user is standing in. */
export interface DefaultOutcome {
  /** `NB_DIR` is set: nothing here follows the answer. */
  nbDirSet: boolean;
  /** The project's own folder exists now (made by this call, or already there). */
  here: boolean;
  /** `own`: the shared notebook already holds this project's shelves, so none was made and none moved. */
  shelvesStay: boolean;
  /** The folder has no project name the notebook can tell apart (no git, no remote). */
  noProject: boolean;
}

/** The one plain sentence `nb place default <value>` prints for an assistant to relay. It always ends with the way back. */
export function defaultDone(value: Layout, o: DefaultOutcome): string {
  const parts: string[] = [];
  if (value === 'own') {
    parts.push(`Done: from now on each project gets its own notebook${o.here ? ', starting with this one' : ''}.`);
    parts.push(
      o.shelvesStay
        ? 'This project already has notes in the shared notebook, so they stay there until you ask to move them.'
        : 'Notes already kept stay where they are until you ask to move them.',
    );
  } else if (value === 'ask') {
    parts.push('Done: from now on the notebook asks, in each new project, where its notes are kept.');
    parts.push('Notes already kept stay where they are.');
  } else {
    parts.push('Done: all projects keep their notes in one shared notebook, in sections per project.');
    parts.push('Notes already kept stay where they are.');
  }
  if (o.noProject) parts.push('This folder is not a project the notebook can tell apart, so its notes stay in the shared notebook.');
  if (o.nbDirSet) parts.push('Your notes are kept in the folder NB_DIR names here, so this choice applies only where NB_DIR is not set.');
  parts.push('To go back, just ask.');
  return parts.join(' ') + '\n';
}

/** The name of the file that records a project was already settled: `.seen-<name>`. */
export function seenFileName(name: string): string {
  return `.seen-${name}`;
}
