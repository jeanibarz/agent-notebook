import { describe, test, expect } from 'vitest';
import { LAYOUT_VALUES, defaultDone, effectiveLayout, layoutDate, layoutJson, layoutLine, parseLayout, renderDefault, seenFileName, type LayoutRead } from './layout.js';

// Issue #560, FR-PLACE-005: the grammar of `.layout` and the plain sentences built from it.
describe('the .layout grammar (FR-PLACE-005)', () => {
  test.each([
    ['shared', 'shared'],
    ['own\n', 'own'],
    ['ask\r\n', 'ask'],
    ['\uFEFFown\r\n', 'own'],
    ['  shared  \n\n', 'shared'],
  ])('%j is the word %s', (raw, word) => {
    expect(parseLayout(raw)).toBe(word);
  });

  test.each(['', '\n', 'Own', 'SHARED', 'own ask', 'own\nask\n', 'own\0', 'own\0\n', 'shared!', 'default', '1', 'ow n'])(
    '%j is not a choice',
    (raw) => {
      expect(parseLayout(raw)).toBeNull();
    },
  );

  test('the three words are exactly shared, own and ask', () => {
    expect([...LAYOUT_VALUES]).toEqual(['shared', 'own', 'ask']);
  });

  test('no file means the recommended choice (shared), an unreadable file means shared too, a chosen one itself', () => {
    expect(effectiveLayout({ state: 'none' })).toEqual({ default: 'shared', source: 'recommended' });
    expect(effectiveLayout({ state: 'unreadable', since: null })).toEqual({ default: 'shared', source: 'unreadable' });
    expect(effectiveLayout({ state: 'chosen', value: 'own', since: '2026-01-02' })).toEqual({ default: 'own', source: 'chosen' });
  });

  test('the date is the day of the modification time, in UTC', () => {
    expect(layoutDate(Date.UTC(2026, 0, 2, 23, 59))).toBe('2026-01-02');
    expect(layoutDate(Number.NaN)).toBe('an unknown date');
  });

  test('the file name of a project that is settled', () => {
    expect(seenFileName('acme-app')).toBe('.seen-acme-app');
  });
});

describe('the sentences (FR-PLACE-005)', () => {
  const chosen: LayoutRead = { state: 'chosen', value: 'own', since: '2026-01-02' };

  test('the one line of nb place, nb status and nb config: none without a file, golden otherwise', () => {
    expect(layoutLine({ state: 'none' })).toBeNull();
    expect(layoutJson({ state: 'none' })).toBeNull();
    expect(layoutLine(chosen)).toBe('Where notes are kept: a separate notebook for each project (chosen on 2026-01-02). To change it: nb place default shared|own|ask.');
    expect(layoutLine({ state: 'chosen', value: 'ask', since: '2026-01-02' })).toBe(
      'Where notes are kept: you are asked in each new project (chosen on 2026-01-02). To change it: nb place default shared|own|ask.',
    );
    expect(layoutLine({ state: 'unreadable', since: null })).toBe(
      'Where notes are kept: the choice could not be read, so one notebook for all projects, in sections per project applies. To set it again: nb place default shared|own|ask.',
    );
    expect(layoutJson(chosen)).toEqual({ default: 'own', source: 'chosen', since: '2026-01-02' });
    expect(layoutJson({ state: 'unreadable', since: null })).toEqual({ default: 'shared', source: 'unreadable', since: null });
  });

  test('nb place default with no value: golden for each source', () => {
    expect(renderDefault({ state: 'none' }, false)).toBe('default: shared (the recommended choice)\n  one notebook for all projects, in sections per project.\n');
    expect(renderDefault(chosen, false)).toBe('default: own (chosen on 2026-01-02)\n  a separate notebook for each project.\n');
    expect(renderDefault({ state: 'unreadable', since: null }, true)).toBe(
      'default: shared (the choice file could not be read, so the recommended choice applies)\n' +
        '  one notebook for all projects, in sections per project.\n' +
        '  To set it again: nb place default shared|own|ask.\n' +
        '  NB_DIR is set here, so this applies only where NB_DIR is not set.\n',
    );
  });

  test('every sentence for an assistant to relay ends with the way back, and own says it moves nothing', () => {
    const base = { nbDirSet: false, here: false, shelvesStay: false, noProject: false };
    for (const v of LAYOUT_VALUES) expect(defaultDone(v, base).endsWith(' To go back, just ask.\n')).toBe(true);
    expect(defaultDone('own', { ...base, here: true })).toBe(
      'Done: from now on each project gets its own notebook, starting with this one. Notes already kept stay where they are until you ask to move them. To go back, just ask.\n',
    );
    expect(defaultDone('own', { ...base, shelvesStay: true })).toBe(
      'Done: from now on each project gets its own notebook. This project already has notes in the shared notebook, so they stay there until you ask to move them. To go back, just ask.\n',
    );
    expect(defaultDone('own', { ...base, noProject: true })).toBe(
      'Done: from now on each project gets its own notebook. Notes already kept stay where they are until you ask to move them. ' +
        'This folder is not a project the notebook can tell apart, so its notes stay in the shared notebook. To go back, just ask.\n',
    );
    expect(defaultDone('ask', base)).toBe('Done: from now on the notebook asks, in each new project, where its notes are kept. Notes already kept stay where they are. To go back, just ask.\n');
    expect(defaultDone('shared', { ...base, nbDirSet: true })).toBe(
      'Done: all projects keep their notes in one shared notebook, in sections per project. Notes already kept stay where they are. ' +
        'Your notes are kept in the folder NB_DIR names here, so this choice applies only where NB_DIR is not set. To go back, just ask.\n',
    );
  });
});
