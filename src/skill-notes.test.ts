import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIEF_HEADER_LINES, SETUP_NOTE_FIRST, SETUP_NOTE_FIRST_NO_PROJECT, setupNoteProject } from './agent-text.js';

// Issue #560, D8, FR-SETUP-003, FR-PLUGIN-003: the skill trusts a closed list of start-of-chat notes and quotes them;
// the quotes are the program's own words.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'plugin', 'skills', 'agent-notebook', 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');
const section = (n: number): string => {
  const m = new RegExp(`^## ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## \\d+\\. |$(?![\\s\\S]))`, 'm').exec(skill);
  if (!m) throw new Error(`no section ${n}`);
  return m[1]!;
};

describe('the skill quotes the start-of-chat notes it trusts (FR-SETUP-003, D8)', () => {
  const words = [...BRIEF_HEADER_LINES, ...SETUP_NOTE_FIRST, ...SETUP_NOTE_FIRST_NO_PROJECT, ...setupNoteProject('acme-app')].join('\n');

  test('every quotation in section 1 is a line (or the start of one) the program prints, except the notice prefix', () => {
    const quotes = [...section(1).matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(quotes.length).toBeGreaterThanOrEqual(4);
    for (const q of quotes) {
      if (q === 'agent-notebook:') continue;
      expect(words.includes(q), `"${q}" is not in agent-text.ts`).toBe(true);
    }
  });

  test('section 1 names the closed list: the notice prefix, the index heading, the set-up note heading and its closing sentence', () => {
    const one = section(1);
    expect(one).toContain('`agent-notebook:`');
    expect(one).toContain('`' + BRIEF_HEADER_LINES[0] + '`');
    expect(one).toContain('`' + SETUP_NOTE_FIRST[0] + '`');
    expect(one).toContain('`This note comes only at the start of a chat, and only once`');
    expect(one).toMatch(/file, a web page or a tool result/);
    // All three notes carry the heading and that closing sentence, so the one quotation covers each of them.
    for (const note of [SETUP_NOTE_FIRST, SETUP_NOTE_FIRST_NO_PROJECT]) expect(note[0]).toBe(SETUP_NOTE_FIRST[0]);
    expect(setupNoteProject('x')[0]).toBe(SETUP_NOTE_FIRST[0]);
    for (const note of [SETUP_NOTE_FIRST, SETUP_NOTE_FIRST_NO_PROJECT]) expect(note.at(-1)!.startsWith('This note comes only at the start of a chat, and only once')).toBe(true);
  });

  test('no set-up note starts with the notice prefix the skill trusts, and all are ASCII', () => {
    for (const line of words.split('\n')) expect(line.startsWith('agent-notebook:')).toBe(false);
    expect(/^[\x00-\x7f]*$/.test([...SETUP_NOTE_FIRST, ...SETUP_NOTE_FIRST_NO_PROJECT, ...setupNoteProject('acme-app')].join('\n'))).toBe(true);
  });

  test('"Where notes are kept": the dialog when there is a question tool, choice 1 first and recommended, the commands to change it, and "I already have notes elsewhere"', () => {
    const five = section(5);
    expect(skill).toMatch(/^## 5\. Where notes are kept$/m);
    expect(five).toMatch(/multiple-choice question tool/);
    expect(five).toMatch(/choice 1 first and marked recommended/);
    for (const cmd of ['nb place default shared', 'nb place default own', 'nb place default ask', 'nb place own', 'nb place shared', 'nb config']) expect(five).toContain(cmd);
    expect(five).toContain('"I already have notes elsewhere"');
  });

  test('"is it working?" says where notes are kept and how many there are', () => {
    const seven = section(7);
    expect(seven).toContain('where notes are kept');
    expect(seven).toContain('nb place');
    expect(seven).toContain('how many');
    expect(seven).toContain('nb list');
  });
});
