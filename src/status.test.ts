import { describe, test, expect } from 'vitest';
import { ageWords, decideStatus, renderStatus, statusJson, NAMES_HEADING, type StatusFacts, type StatusRow } from './status.js';
import { gatherFacts, releaseDateIn, ROW_COMMANDS, shown, tildify, validateRow, type FactsInput } from './status-facts.js';
import { KNOWN_COMMANDS } from './cli.js';
import type { UsageRow } from './usage.js';

// Issue #558, FR-STATUS-001..003: the verdicts and their fixed sentences (pure), the read-time validation
// and the merge of the logs (injected dependencies). The built CLI is run in status-cli.test.ts.
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const KEY = 'acme-app';

function iso(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

function row(secondsAgo: number, over: Partial<StatusRow> = {}): StatusRow {
  return {
    at: iso(secondsAgo),
    atMs: NOW - secondsAgo * 1000,
    command: 'brief',
    ok: true,
    label: 'tool-a.start',
    outcome: 'index',
    version: '0.13.0',
    project: KEY,
    errorClass: '',
    session: 'abcd1234',
    ...over,
  };
}

function facts(over: Partial<StatusFacts> = {}): StatusFacts {
  return {
    switch: { enabled: true, source: 'default' },
    place: { kind: 'shared' },
    project: { name: KEY, source: 'remote', keyKind: 'name', key: KEY },
    live: { folder: 'ok', log: 'ok' },
    rows: [],
    rowsRead: 0,
    since: null,
    notebook: { shelves: 3, lastAddAt: null },
    messages: { state: 'absent', files: [] },
    program: { version: '0.13.0', released: '2026-11-20', nodeVersion: 'v24.0.0', platform: 'linux' },
    shown: {
      projectName: KEY,
      folderAsked: '~/work/app',
      notebookFolder: '~/.agent-notebook/notebooks',
      notebookWhy: 'no project folders',
      programPaths: ['/usr/lib/node_modules/agent-notebook/dist/cli.js'],
      nodePath: '/usr/bin/node',
    },
    ...over,
  };
}

/** The rows and the counts a log of these rows gives. */
function withRows(rows: StatusRow[], over: Partial<StatusFacts> = {}): StatusFacts {
  return facts({ rows, rowsRead: rows.length, since: rows[0]?.at ?? null, ...over });
}

const lines12 = (f: StatusFacts): string[] => {
  const d = decideStatus(f, NOW);
  return [d.headline, d.next];
};

describe('age words (FR-STATUS-001)', () => {
  test.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [119, '1 minute ago'],
    [120, '2 minutes ago'],
    [3599, '59 minutes ago'],
    [3600, '1 hour ago'],
    [7200, '2 hours ago'],
    [86399, '23 hours ago'],
    [86400, '1 day ago'],
    [86400 * 40, '40 days ago'],
    [-5, 'just now'],
  ])('%i seconds is %s', (s, words) => {
    expect(ageWords(s)).toBe(words);
  });
});

describe('every verdict and every line variant, as text (golden, FR-STATUS-002)', () => {
  test('off: the switch is off here, set in git config', () => {
    expect(lines12(facts({ switch: { enabled: false, source: 'git' } }))).toEqual([
      'The notebook is switched off for this folder.',
      'It was switched off on purpose. To use it here again, ask your assistant to switch it back on.',
    ]);
  });

  test('off: the switch is off here, set in the environment', () => {
    expect(lines12(facts({ switch: { enabled: false, source: 'env' } }))).toEqual([
      'The notebook is switched off for this folder.',
      'A setting on this computer switched it off, possibly set by whoever manages it. Leave it unless you set it yourself.',
    ]);
  });

  test('off: the chats found it switched off while the terminal switch is on gives the git-config wording', () => {
    const f = withRows([row(7200, { outcome: 'off' })]);
    const d = decideStatus(f, NOW);
    expect(d.verdict).toBe('off');
    expect([d.headline, d.next]).toEqual([
      'Your chats here found the notebook switched off (last start 2 hours ago).',
      'It was switched off on purpose. To use it here again, ask your assistant to switch it back on.',
    ]);
  });

  test('off by the last start only: a later start that showed the index ends it', () => {
    const f = withRows([row(7200, { outcome: 'off' }), row(60)]);
    expect(decideStatus(f, NOW).verdict).toBe('running');
  });

  test('place_unknown', () => {
    const d = decideStatus(facts({ place: { kind: 'unknown' } }), NOW);
    expect(d.verdict).toBe('place_unknown');
    expect([d.headline, d.next]).toEqual([
      "The notebook can't tell where this project's lessons are kept, so it stays closed here for now. Your lessons are safe.",
      'Ask your assistant to look at the details below.',
    ]);
  });

  test('broken, live: the notebook folder cannot be read, or is not a folder', () => {
    for (const folder of ['unreadable', 'not-folder'] as const) {
      const d = decideStatus(facts({ live: { folder, log: 'absent' } }), NOW);
      expect(d.verdict).toBe('broken');
      expect([d.headline, d.next]).toEqual(["The notebook can't be opened right now, so chats can't use it.", 'Ask your assistant to look at the details below.']);
    }
  });

  test('broken, live: the usage log cannot be written', () => {
    const d = decideStatus(facts({ live: { folder: 'ok', log: 'unwritable' } }), NOW);
    expect(d.verdict).toBe('broken');
    expect(d.headline).toBe("The notebook can't note when a chat starts it (a file in it can't be written), so this check can't tell whether it works.");
    expect(d.next).toBe('Ask your assistant to look at the details below.');
  });

  test('broken, from this project\'s newest start row', () => {
    const d = decideStatus(withRows([row(3 * 3600, { outcome: 'broken' })]), NOW);
    expect(d).toMatchObject({ verdict: 'broken', scope: 'project', announce: true });
    expect([d.headline, d.next]).toEqual([
      'The notebook could not open when a chat last started it (3 hours ago).',
      'It opens now: start a new chat and ask again.',
    ]);
  });

  test('broken, from a newer row with key ? : scope notebook, not announced', () => {
    const d = decideStatus(withRows([row(7200), row(120, { project: '?', outcome: 'broken' })]), NOW);
    expect(d).toMatchObject({ verdict: 'broken', scope: 'notebook', announce: false });
    expect(d.headline).toBe('The notebook could not open when a chat last started it (2 minutes ago).');
  });

  test('a ? row older than this project\'s newest start does not count', () => {
    const d = decideStatus(withRows([row(7200, { project: '?', outcome: 'broken' }), row(120)]), NOW);
    expect(d.verdict).toBe('running');
  });

  test('a ? row with a good outcome never counts as a start for any project', () => {
    const d = decideStatus(withRows([row(60, { project: '?' })]), NOW);
    expect(d.verdict).toBe('not_seen');
  });

  test('the ? key of this terminal matches no row either', () => {
    const f = withRows([row(60, { project: '?' })], { project: { name: null, source: 'none', keyKind: 'undetermined', key: '?' } });
    expect(decideStatus(f, NOW).verdict).toBe('not_seen');
  });

  test('running, with the last lesson added', () => {
    const f = withRows([row(5)], { notebook: { shelves: 3, lastAddAt: iso(86400 * 2) } });
    const d = decideStatus(f, NOW);
    expect(d).toMatchObject({ verdict: 'running', scope: 'project', announce: false, problem: null });
    expect([d.headline, d.next]).toEqual([
      'The notebook was working when a chat last started it on its own, just now. Last lesson added 2 days ago.',
      'Nothing to do.',
    ]);
  });

  test('running, with no lessons yet', () => {
    const f = withRows([row(61)], { notebook: { shelves: 0, lastAddAt: null } });
    expect(decideStatus(f, NOW).headline).toBe(
      'The notebook was working when a chat last started it on its own, 1 minute ago. No lessons yet: they are added at the end of tasks.',
    );
  });

  test('running, with shelves but no lesson added in the record: the window is the days the record covers', () => {
    const f = withRows([row(60)], { since: iso(86400 * 3 + 5) });
    expect(decideStatus(f, NOW).headline).toBe(
      'The notebook was working when a chat last started it on its own, 1 minute ago. No lesson added in the last 4 days.',
    );
    const one = withRows([row(60)], { since: iso(3600) });
    expect(decideStatus(one, NOW).headline).toContain('No lesson added in the last day.');
  });

  test('running, from end rows only', () => {
    const f = withRows([row(3 * 86400, { command: 'retro', outcome: 'nudge', label: 'tool-a.stop' })], { notebook: { shelves: 2, lastAddAt: iso(86400) } });
    const d = decideStatus(f, NOW);
    expect(d.verdict).toBe('running');
    expect(d.headline).toBe(
      'The notebook was working when a chat asked for the end-of-task notes on its own 3 days ago; no automatic start is recorded. Last lesson added 1 day ago.',
    );
  });

  test('running with a refused start message: line 2 names the file and a fixed reason, and the problem is set', () => {
    const f = withRows([row(60)], {
      notebook: { shelves: 2, lastAddAt: iso(60) },
      messages: { state: 'present', files: [{ kind: 'brief', file: 'brief.txt', status: 'refused', reason: 'too_long' }] },
    });
    const d = decideStatus(f, NOW);
    expect(d.problem).toBe('message_ignored');
    expect(d.next).toBe('Your own start message (brief.txt) is not used: it is too long. Ask your assistant to show you why.');
  });

  test.each([
    ['empty', 'it is empty'],
    ['not_utf8', 'it is not saved as UTF-8'],
    ['inside_notebooks', 'its folder lies inside the notebook folder'],
    ['unreadable', 'it cannot be read'],
    ['other', 'it cannot be used'],
  ] as const)('a refused message file for %s reads "%s"', (reason, words) => {
    const f = withRows([row(60)], { messages: { state: 'present', files: [{ kind: 'brief', file: 'acme-app.brief.txt', status: 'refused', reason }] } });
    expect(decideStatus(f, NOW).next).toBe(`Your own start message (acme-app.brief.txt) is not used: ${words}. Ask your assistant to show you why.`);
  });

  test('a refused end-of-task message file does not touch line 2 of a start', () => {
    const f = withRows([row(60)], { messages: { state: 'present', files: [{ kind: 'retro', file: 'retro.txt', status: 'refused', reason: 'empty' }] } });
    expect(decideStatus(f, NOW)).toMatchObject({ next: 'Nothing to do.', problem: null });
  });

  test('not_seen with a missing or empty log uses the "yet" wording and no number of days', () => {
    const d = decideStatus(facts(), NOW);
    expect(d.verdict).toBe('not_seen');
    expect([d.headline, d.next]).toEqual([
      'This check has not seen a chat in this project start the notebook on its own yet.',
      'Start a new chat here and ask again. If it still says this, ask your assistant to look at the details below.',
    ]);
  });

  test('not_seen with rows of another project says how many days it looked at', () => {
    const f = withRows([row(86400 * 2 + 10, { project: 'other-app' })]);
    expect(decideStatus(f, NOW).headline).toBe('This check has not seen a chat in this project start the notebook on its own (it looked at the last 3 days).');
    expect(decideStatus(withRows([row(3600, { project: 'other-app' })]), NOW).headline).toContain('(it looked at the last day).');
  });

  test('not_seen after a chat start answered by an older program: the out-of-date sentence and the update line', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const d = decideStatus(withRows([old]), NOW);
    expect(d.verdict).toBe('not_seen');
    expect([d.headline, d.next]).toEqual([
      'This check has not seen a chat in this project start the notebook on its own (it looked at the last day). Part of the notebook seemed out of date the last time a chat tried (2 hours ago).',
      'Ask your assistant to help you update the notebook, then start a new chat. Your lessons are safe.',
    ]);
    expect(d.olderProgram).toEqual({ count: 1, at: old.at, ageSeconds: 7200 });
  });

  test('the out-of-date sentence only while no later row carries a version', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const noVersion = row(3600, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    expect(decideStatus(withRows([old, noVersion]), NOW).headline).toContain('(1 hour ago).');
    const later = row(60, { project: 'other-app' });
    const d = decideStatus(withRows([old, later]), NOW);
    expect(d.headline).not.toContain('out of date');
    expect(d.next).toContain('Start a new chat here');
    // a versioned row BEFORE the old answer does not cancel it
    const earlier = row(9000, { project: 'other-app' });
    expect(decideStatus(withRows([earlier, old]), NOW).headline).toContain('out of date');
  });

  test('an older program never makes a verdict of its own: with a running start it is only a detail', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const d = decideStatus(withRows([old, row(60)]), NOW);
    expect(d.verdict).toBe('running');
    expect(d.olderProgram?.count).toBe(1);
  });

  test('a row of another project, a row with no label and a failed call are never this project\'s start', () => {
    const rows = [row(60, { project: 'other-app' }), row(50, { label: '' }), row(40, { ok: false })];
    expect(decideStatus(withRows(rows), NOW).verdict).toBe('not_seen');
  });

  test('a start dated in the future ages to "just now" and never outranks a later row of the file', () => {
    const future = row(-86400 * 3);
    const d = decideStatus(withRows([future]), NOW);
    expect(d.headline).toContain('just now');
    expect(d.lastStart?.ageSeconds).toBe(0);
    const f = withRows([row(86400 * 2, { outcome: 'off' }), row(-86400, {})]);
    // the later row in the file is the newest, whatever its date
    expect(decideStatus(f, NOW).verdict).toBe('running');
    const g = withRows([row(-86400, { outcome: 'off' }), row(120)]);
    expect(decideStatus(g, NOW).verdict).toBe('running');
  });

  test('line 1 and line 2 never use the words hook, shelf or PATH, or a variable name', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const cases: StatusFacts[] = [
      facts({ switch: { enabled: false, source: 'git' } }),
      facts({ switch: { enabled: false, source: 'env' } }),
      withRows([row(60, { outcome: 'off' })]),
      facts({ place: { kind: 'unknown' } }),
      facts({ live: { folder: 'unreadable', log: 'absent' } }),
      facts({ live: { folder: 'ok', log: 'unwritable' } }),
      withRows([row(60, { outcome: 'broken' })]),
      withRows([row(60)], { messages: { state: 'present', files: [{ kind: 'brief', file: 'brief.txt', status: 'refused', reason: 'other' }] } }),
      withRows([row(60, { command: 'retro', outcome: 'nudge' })]),
      facts(),
      withRows([old]),
    ];
    for (const f of cases) {
      const d = decideStatus(f, NOW);
      for (const line of [d.headline, d.next]) {
        expect(line, line).not.toMatch(/hook|shelf|shelves|\bPATH\b|\bNB_[A-Z]/i);
        expect(line.includes('\n')).toBe(false);
      }
    }
  });

  test('line 1 and line 2 carry no path, even when the facts hold one', () => {
    const f = withRows([row(60)], {
      shown: { projectName: '/etc/passwd', folderAsked: '/home/x', notebookFolder: '/home/x/.nb', notebookWhy: 'a reason from disk', programPaths: ['/p'], nodePath: '/n' },
    });
    const [a, b] = lines12(f);
    expect(a + b).not.toMatch(/\/|a reason from disk/);
  });
});

describe('announce, scope and problem (FR-STATUS-003)', () => {
  test('announce is true only for place_unknown and a project-scoped broken', () => {
    const flags = (f: StatusFacts): boolean => decideStatus(f, NOW).announce;
    expect(flags(facts({ place: { kind: 'unknown' } }))).toBe(true);
    expect(flags(withRows([row(60, { outcome: 'broken' })]))).toBe(true);
    expect(flags(facts({ live: { folder: 'unreadable', log: 'absent' } }))).toBe(true);
    expect(flags(withRows([row(60, { project: '?', outcome: 'broken' })]))).toBe(false);
    expect(flags(facts({ switch: { enabled: false, source: 'git' } }))).toBe(false);
    expect(flags(withRows([row(60)]))).toBe(false);
    expect(flags(facts())).toBe(false);
  });

  test('scope is notebook only for a broken that rests on a ? row', () => {
    const scopes = [
      facts({ switch: { enabled: false, source: 'git' } }),
      facts({ place: { kind: 'unknown' } }),
      facts({ live: { folder: 'unreadable', log: 'absent' } }),
      withRows([row(60, { outcome: 'broken' })]),
      withRows([row(60)]),
      facts(),
    ].map((f) => decideStatus(f, NOW).scope);
    expect(scopes).toEqual(['project', 'project', 'project', 'project', 'project', 'project']);
    expect(decideStatus(withRows([row(60, { project: '?', outcome: 'broken' })]), NOW).scope).toBe('notebook');
    // this project's own broken row wins over an older ? row
    expect(decideStatus(withRows([row(600, { project: '?', outcome: 'broken' }), row(60, { outcome: 'broken' })]), NOW).scope).toBe('project');
  });

  test('the verdicts come in order: off, place_unknown, live broken, row broken, running, not_seen', () => {
    const all = withRows([row(60, { outcome: 'broken' })], {
      switch: { enabled: false, source: 'env' },
      place: { kind: 'unknown' },
      live: { folder: 'unreadable', log: 'unwritable' },
    });
    expect(decideStatus(all, NOW).verdict).toBe('off');
    expect(decideStatus({ ...all, switch: { enabled: true, source: 'default' } }, NOW).verdict).toBe('place_unknown');
    expect(decideStatus({ ...all, switch: { enabled: true, source: 'default' }, place: { kind: 'shared' } }, NOW).code).toBe('broken_folder');
    expect(decideStatus({ ...all, switch: { enabled: true, source: 'default' }, place: { kind: 'shared' }, live: { folder: 'ok', log: 'unwritable' } }, NOW).code).toBe('broken_log');
    expect(decideStatus({ ...all, switch: { enabled: true, source: 'default' }, place: { kind: 'shared' }, live: { folder: 'ok', log: 'ok' } }, NOW).code).toBe('broken_rows');
  });
});

describe('the JSON is the contract of design section 4 (FR-STATUS-003, golden)', () => {
  test('a running verdict', () => {
    const f = withRows([row(3600, { command: 'retro', outcome: 'nudge', label: 'tool-a.stop' }), row(5)], {
      notebook: { shelves: 3, lastAddAt: iso(86400) },
    });
    const d = decideStatus(f, NOW);
    expect(statusJson(f, d, NOW)).toEqual({
      schemaVersion: 1,
      verdict: 'running',
      scope: 'project',
      headline: 'The notebook was working when a chat last started it on its own, just now. Last lesson added 1 day ago.',
      next: 'Nothing to do.',
      announce: false,
      problem: null,
      now: '2026-11-26T12:00:00.000Z',
      evidence: {
        lastStart: { at: iso(5), ageSeconds: 5, label: 'tool-a.start', outcome: 'index', version: '0.13.0' },
        lastEnd: { at: iso(3600), ageSeconds: 3600, label: 'tool-a.stop', outcome: 'nudge', version: '0.13.0' },
        olderProgram: null,
        rowsRead: 2,
        since: iso(3600),
      },
      switch: { enabled: true, source: 'default' },
      place: { kind: 'shared' },
      project: { name: KEY, source: 'remote', key: 'name' },
      notebook: { shelves: 3, lastAddAt: iso(86400) },
      program: { version: '0.13.0', released: '2026-11-20', nodeVersion: 'v24.0.0', platform: 'linux' },
    });
  });

  test('a not_seen verdict: nulls where there is nothing, and a row with no version reads null', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const f = withRows([old], { project: { name: null, source: 'folder', keyKind: 'folder-hash', key: 'h:0123456789ab' } });
    const j = statusJson(f, decideStatus(f, NOW), NOW) as Record<string, any>;
    expect(j.verdict).toBe('not_seen');
    expect(j.evidence.lastStart).toBeNull();
    expect(j.evidence.olderProgram).toEqual({ count: 1, at: old.at, ageSeconds: 7200 });
    expect(j.project).toEqual({ name: null, source: 'folder', key: 'folder-hash' });
    expect(j.notebook.lastAddAt).toBeNull();
    const none = facts({ program: { version: '0.13.0', released: null, nodeVersion: 'v24.0.0', platform: 'linux' } });
    expect((statusJson(none, decideStatus(none, NOW), NOW) as Record<string, any>).program.released).toBeNull();
  });

  test('the JSON holds no path, whatever the facts show', () => {
    const f = withRows([row(60)], {
      shown: { projectName: 'x', folderAsked: '/secret/folder', notebookFolder: '/secret/nb', notebookWhy: 'at /secret', programPaths: ['/secret/cli.js'], nodePath: '/secret/node' },
    });
    expect(JSON.stringify(statusJson(f, decideStatus(f, NOW), NOW))).not.toContain('/secret');
  });
});

describe('the detail block (design section 5, golden)', () => {
  test('a running verdict: two lines, a blank line, the facts, then the names and paths last', () => {
    const f = withRows([row(3600, { command: 'retro', outcome: 'nudge', label: 'tool-a.stop', version: '0.12.9' }), row(5)], {
      notebook: { shelves: 1, lastAddAt: iso(86400) },
      messages: {
        state: 'present',
        files: [
          { kind: 'brief', file: 'brief.txt', status: 'used', reason: null },
          { kind: 'retro', file: 'retro.txt', status: 'refused', reason: 'too_long' },
        ],
      },
    });
    const out = renderStatus(f, decideStatus(f, NOW), NOW);
    expect(out).toBe(
      [
        'The notebook was working when a chat last started it on its own, just now. Last lesson added 1 day ago.',
        'Nothing to do.',
        '',
        'This shows the start step ran. It does not show that your assistant read the list or used a lesson.',
        'Version: 0.13.0 (released 2026-11-20)',
        'Node.js: v24.0.0 on linux',
        'Switch: on (the default), as seen from this terminal',
        'Place: shared',
        'Project: name from the git remote; the key is the project name',
        'Notebook: 1 shelf; last lesson added 1 day ago',
        'Message files: brief.txt used; retro.txt refused (it is too long)',
        'Record: 2 rows read, the oldest from 2026-11-26T11:00:00.000Z',
        'Last starts and ends of this project (time, kind, label, outcome, version, session):',
        '  2026-11-26T11:00:00.000Z  end  tool-a.stop  nudge  0.12.9  session ...abcd1234',
        '  2026-11-26T11:59:55.000Z  start  tool-a.start  index  0.13.0  session ...abcd1234',
        'More: nb doctor, nb config, nb enabled --why, nb place',
        '',
        NAMES_HEADING,
        'Project name: acme-app',
        'Folder asked: ~/work/app',
        'Notebook folder: ~/.agent-notebook/notebooks (no project folders)',
        'Program: /usr/lib/node_modules/agent-notebook/dist/cli.js',
        'Node.js: /usr/bin/node',
        '',
      ].join('\n'),
    );
  });

  test('a not_seen verdict carries the help sentence and the older-program and version lines', () => {
    const old = row(7200, { ok: false, label: '', outcome: '', version: '', project: '', errorClass: 'unknown_subcommand' });
    const f = withRows([old, row(30, { version: '0.12.9', project: 'other-app' })]);
    // the key is this project's; a row of another project is not a start
    const out = renderStatus(f, decideStatus(f, NOW), NOW);
    expect(out).toContain('An older program answered a chat start 1 time; the last was 2 hours ago.');
    expect(out).toContain('If you use the notebook through an instruction file or through start-up scripts from before version 0.13, this is expected.');
    expect(out).toContain('Last starts and ends of this project: none');
    const g = withRows([row(30, { version: '0.12.9' })]);
    expect(renderStatus(g, decideStatus(g, NOW), NOW)).toContain('The chats last used version 0.12.9; this terminal runs 0.13.0.');
  });

  test('the names and paths come last, under their heading', () => {
    const out = renderStatus(facts(), decideStatus(facts(), NOW), NOW);
    const at = out.indexOf(NAMES_HEADING);
    expect(at).toBeGreaterThan(0);
    const after = out.slice(at).split('\n').filter((l) => l !== '');
    expect(after.map((l) => l.split(':')[0])).toEqual([NAMES_HEADING.split(':')[0], 'Project name', 'Folder asked', 'Notebook folder', 'Program', 'Node.js']);
    // no path above the heading except the file name of the docs
    expect(out.slice(0, at)).not.toMatch(/[~/]\.agent-notebook|\/usr\/|\/work\//);
  });

  test('a program path list shows argv[1] too when it differs', () => {
    const f = facts({ shown: { ...facts().shown, programPaths: ['/a/cli.js', '/b/wrapper.mjs'] } });
    expect(renderStatus(f, decideStatus(f, NOW), NOW)).toContain('Program: /a/cli.js ; /b/wrapper.mjs');
  });

  test('a notebook that cannot be counted, and no lesson in the record', () => {
    const f = facts({ notebook: { shelves: null, lastAddAt: null }, live: { folder: 'unreadable', log: 'absent' } });
    expect(renderStatus(f, decideStatus(f, NOW), NOW)).toContain('Notebook: shelves could not be counted; no lesson added in the record');
  });
});

// ---------------------------------------------------------------------------
// status-facts.ts
// ---------------------------------------------------------------------------

function usageRow(over: Partial<UsageRow> = {}): UsageRow {
  return {
    ts: iso(60),
    role: '-',
    command: 'brief',
    ok: true,
    ms: 3,
    session: 'sess-abcdef12',
    entries: [],
    outcome: 'index',
    collided: '',
    evicted: '',
    reason: '',
    note: 'tool-a.start',
    errorClass: '',
    decayed: '',
    recovered: '',
    misses: 0,
    version: '0.13.0',
    project: KEY,
    ...over,
  };
}

describe('a row is validated again at read time, and a forged one is dropped whole (FR-STATUS-002)', () => {
  test('a good start row, a good end row and a row of another command pass', () => {
    expect(validateRow(usageRow())?.row).toMatchObject({ command: 'brief', label: 'tool-a.start', project: KEY, session: 'abcdef12' });
    expect(validateRow(usageRow({ command: 'retro', outcome: 'nudge' }))?.row?.command).toBe('retro');
    expect(validateRow(usageRow({ command: 'add', outcome: 'accepted', note: 'free text, any "thing"', version: '', project: '' }))).toMatchObject({ row: null, addAccepted: true });
  });

  test.each([
    ['a timestamp that is not ISO', { ts: '2026-11-26 12:00:00' }],
    ['a timestamp with a newline', { ts: '2026-11-26T12:00:00.000Z\nfoo' }],
    ['an impossible date', { ts: '2026-13-45T25:61:61Z' }],
    ['an unknown command', { command: 'frobnicate' }],
    ['an unknown outcome of brief', { outcome: 'working' }],
    ['an outcome of another command', { outcome: 'accepted' }],
    ['an empty outcome on a call that succeeded', { outcome: '' }],
    ['an upper-case label', { note: 'Tool-A.Start' }],
    ['a label with a space', { note: 'tool a' }],
    ['a label of 41 characters', { note: 'a'.repeat(41) }],
    ['a label with a newline', { note: 'tool-a\nstart' }],
    ['a version with a space', { version: '1.0 beta' }],
    ['a version of 33 characters', { version: '1'.repeat(33) }],
    ['a project key with a slash', { project: 'a/b' }],
    ['a project key of 65 characters', { project: 'a'.repeat(65) }],
    ['a project key that looks like a hash but is not', { project: 'h:XYZ' }],
    ['an error class with a capital', { errorClass: 'Unknown' }],
  ] as Array<[string, Partial<UsageRow>]>)('drops a row with %s', (_name, over) => {
    expect(validateRow(usageRow(over))).toBeNull();
  });

  test('a version or a key on a command that never writes one is forged', () => {
    expect(validateRow(usageRow({ command: 'list', outcome: '', note: '' }))).toBeNull();
    expect(validateRow(usageRow({ command: 'list', outcome: '', note: '', version: '', project: '' }))).not.toBeNull();
  });

  test('a failed call may have an empty outcome (the 0.12 answer to an unknown subcommand)', () => {
    const old = validateRow(usageRow({ ok: false, outcome: '', note: '', version: '', project: '', errorClass: 'unknown_subcommand' }));
    expect(old?.row).toMatchObject({ ok: false, errorClass: 'unknown_subcommand', version: '' });
  });

  test('the session is cut to its last 8 characters and cleaned', () => {
    expect(validateRow(usageRow({ session: 'x'.repeat(500) + 'é"$`\\n12' }))?.row?.session).toHaveLength(8);
    expect(validateRow(usageRow({ session: 'ab\u2028cdefgh' }))?.row?.session).toMatch(/^[0-9A-Za-z._?-]{8}$/);
  });

  test('ROW_COMMANDS is the CLI command list', () => {
    expect([...ROW_COMMANDS].sort()).toEqual([...KNOWN_COMMANDS].sort());
  });
});

function input(over: Partial<FactsInput> = {}): FactsInput {
  return {
    env: {},
    cwd: '/work/app',
    place: { kind: 'shared', dir: '/nb/shared', shared: '/nb/shared', reason: 'no project folders' },
    project: { name: KEY, source: 'remote', reason: 'r', oldName: '', bare: false, undetermined: false },
    messageProject: KEY,
    programFile: '/pkg/dist/cli.js',
    argv1: '/pkg/dist/cli.js',
    version: '0.13.0',
    now: NOW,
    ...over,
  };
}

const okDeps = (logs: Record<string, UsageRow[]>): Parameters<typeof gatherFacts>[1] => ({
  homedir: () => '/home/u',
  realpath: (p) => p,
  platform: 'linux',
  nodeVersion: 'v24.0.0',
  execPath: '/usr/bin/node',
  readUsage: (dir) => logs[dir] ?? [],
  stat: () => ({ isFile: () => true, isDirectory: () => true }),
  lstat: () => ({ isFile: () => true }),
  readdir: () => ['a.md', 'b.md', '.hidden.md', 'README.md', 'notes.txt'],
  writable: () => true,
  enabled: () => ({ enabled: true, source: 'default', value: null, origin: null, warning: null }),
  listMessages: () => ({ state: 'absent', dir: '', exists: false, code: '', nbDir: '', names: [], projectFiles: { brief: [], retro: [] }, ignored: [], ignoredTotal: 0 }),
  readMessages: () => ({ global: { file: 'x', status: 'absent' }, project: null }),
  changelog: () => null,
});

describe('the facts are read from two logs, merged by timestamp, and never throw (FR-STATUS-001, FR-STATUS-002)', () => {
  test('an own place reads its own log and the shared one; the own row wins a tie, and each log keeps its order', () => {
    const shared = [usageRow({ ts: iso(300), note: 'tool-a.s1' }), usageRow({ ts: iso(100), note: 'tool-a.s2' })];
    const own = [usageRow({ ts: iso(200), note: 'tool-a.o1' }), usageRow({ ts: iso(100), note: 'tool-a.o2' })];
    const f = gatherFacts(
      input({ place: { kind: 'own', dir: '/nb/own', shared: '/nb/shared', reason: 'own' } }),
      okDeps({ '/nb/shared': shared, '/nb/own': own }),
    );
    expect(f.rows.map((r) => r.label)).toEqual(['tool-a.s1', 'tool-a.o1', 'tool-a.s2', 'tool-a.o2']);
    expect(f.rowsRead).toBe(4);
  });

  test('a row dated more than five minutes after the clock is forged and dropped; a little skew is kept', () => {
    const rows = [usageRow({ ts: iso(-86400), note: 'tool-a.forged' }), usageRow({ ts: iso(-240), note: 'tool-a.skew' }), usageRow({ ts: iso(60), note: 'tool-a.ok' })];
    const f = gatherFacts(input(), okDeps({ '/nb/shared': rows }));
    expect(f.rows.map((r) => r.label)).toEqual(['tool-a.skew', 'tool-a.ok']);
    expect(f.rowsRead).toBe(2);
  });

  test('a shared or env place reads the shared log only', () => {
    const f = gatherFacts(input(), okDeps({ '/nb/shared': [usageRow()], '/nb/own': [usageRow({ note: 'tool-a.own' })] }));
    expect(f.rows.map((r) => r.label)).toEqual(['tool-a.start']);
    const e = gatherFacts(input({ place: { kind: 'env', dir: '/nb/shared', shared: '/nb/shared', reason: 'NB_DIR' } }), okDeps({ '/nb/shared': [usageRow()] }));
    expect(e.rows).toHaveLength(1);
  });

  test('the shelf count skips dotfiles, README.md and other files; the last add is the newest accepted add', () => {
    const adds = [
      usageRow({ ts: iso(900), command: 'add', outcome: 'accepted', note: '', version: '', project: '' }),
      usageRow({ ts: iso(600), command: 'add', outcome: 'accepted', note: '', version: '', project: '' }),
      usageRow({ ts: iso(300), command: 'add', outcome: 'dedup-blocked', note: '', version: '', project: '' }),
      usageRow({ ts: iso(100), command: 'add', ok: false, outcome: '', note: '', version: '', project: '' }),
    ];
    const f = gatherFacts(input(), okDeps({ '/nb/shared': adds }));
    expect(f.notebook).toEqual({ shelves: 2, lastAddAt: iso(600) });
    expect(f.rows).toEqual([]);
    expect(f.rowsRead).toBe(4);
    expect(f.since).toBe(iso(900));
  });

  test('the live checks: a missing folder is fine, an unreadable one and a file are not, an unwritable log is not', () => {
    const err = (code: string) => (): never => {
      throw Object.assign(new Error(code), { code });
    };
    const base = okDeps({});
    expect(gatherFacts(input(), { ...base, stat: err('ENOENT') }).live).toEqual({ folder: 'missing', log: 'absent' });
    // a folder that does not exist yet holds 0 shelves, not "could not be counted"
    expect(gatherFacts(input(), { ...base, stat: err('ENOENT') }).notebook.shelves).toBe(0);
    expect(gatherFacts(input(), { ...base, stat: err('EACCES') }).notebook.shelves).toBeNull();
    expect(gatherFacts(input(), { ...base, stat: err('EACCES') }).live.folder).toBe('unreadable');
    expect(gatherFacts(input(), { ...base, stat: () => ({ isFile: () => true, isDirectory: () => false }) }).live.folder).toBe('not-folder');
    expect(gatherFacts(input(), { ...base, readdir: err('EACCES') }).live.folder).toBe('unreadable');
    expect(gatherFacts(input(), { ...base, writable: () => { throw new Error('EACCES'); } }).live.log).toBe('unwritable');
    expect(gatherFacts(input(), { ...base, lstat: err('ENOENT') }).live.log).toBe('absent');
    expect(gatherFacts(input(), base).live.log).toBe('ok');
    // a log that is not a regular file (a FIFO) cannot be written to by a row
    const fifo = (p: string) => ({ isFile: () => !p.endsWith('.nb-usage.log'), isDirectory: () => p === '/nb/shared' });
    expect(gatherFacts(input(), { ...base, stat: fifo }).live.log).toBe('unwritable');
  });

  test('no dependency can make it throw', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    const f = gatherFacts(input(), {
      homedir: boom,
      realpath: boom,
      readUsage: boom,
      stat: boom,
      lstat: boom,
      readdir: boom,
      writable: boom,
      enabled: boom,
      listMessages: boom,
      readMessages: boom,
      changelog: boom,
    });
    expect(f.rows).toEqual([]);
    expect(f.messages.files).toEqual([]);
    expect(f.program.released).toBeNull();
    expect(f.shown.programPaths).toEqual(['/pkg/dist/cli.js']);
    expect(() => decideStatus(f, NOW)).not.toThrow();
  });

  test('a removed working folder has no key unless NB_PROJECT_SLUG names the project', () => {
    const none = gatherFacts(input({ cwd: null, project: { name: '', source: 'none', reason: 'gone', oldName: '', bare: false, undetermined: false } }), okDeps({}));
    expect(none.project).toMatchObject({ key: null, keyKind: 'none', name: null });
    const slug = gatherFacts(input({ cwd: null, project: { name: 'slugged', source: 'env', reason: 'env', oldName: '', bare: false, undetermined: false } }), okDeps({}));
    expect(slug.project).toMatchObject({ key: 'slugged', keyKind: 'name' });
  });

  test('a project that git could not answer gives the key ? and the kind undetermined', () => {
    const f = gatherFacts(input({ project: { name: '', source: 'none', reason: 'git timed out', oldName: '', bare: false, undetermined: true } }), okDeps({}));
    expect(f.project).toMatchObject({ key: '?', keyKind: 'undetermined' });
  });

  test('message refusals become fixed codes, never the text read from disk', () => {
    const deps = okDeps({});
    const f = gatherFacts(input(), {
      ...deps,
      listMessages: () => ({ ...deps.listMessages!('', ''), state: 'present' }),
      readMessages: (_l, kind) => ({
        global: { file: `${kind}.txt`, status: 'refused', reason: 'unreadable (EACCES: /secret/path)' },
        project: { file: `${KEY}.${kind}.txt`, status: 'refused', reason: 'larger than 1000 characters' },
      }),
    });
    expect(f.messages.files.map((m) => [m.kind, m.file, m.reason])).toEqual([
      ['brief', 'brief.txt', 'unreadable'],
      ['brief', 'acme-app.brief.txt', 'too_long'],
      ['retro', 'retro.txt', 'unreadable'],
      ['retro', 'acme-app.retro.txt', 'too_long'],
    ]);
  });

  test('the program paths show argv[1] too when it differs from the real path of cli.js', () => {
    const f = gatherFacts(input({ argv1: '/usr/local/bin/nb-wrapper.mjs' }), okDeps({}));
    expect(f.shown.programPaths).toEqual(['/pkg/dist/cli.js', '/usr/local/bin/nb-wrapper.mjs']);
  });
});

describe('every value shown is capped, escaped, and the home folder is ~ (design section 5)', () => {
  const homes = ['/home/jean', '/real/jean'];
  test('the home folder, by either spelling, on a path boundary only', () => {
    expect(tildify('/home/jean/work', homes, 'linux')).toBe('~/work');
    expect(tildify('/real/jean/work/x', homes, 'linux')).toBe('~/work/x');
    expect(tildify('/home/jean', homes, 'linux')).toBe('~');
    expect(tildify('/home/jean2/work', homes, 'linux')).toBe('/home/jean2/work');
    expect(tildify('/home/Jean/work', homes, 'linux')).toBe('/home/Jean/work');
    expect(tildify('/x/home/jean', homes, 'linux')).toBe('/x/home/jean');
    expect(tildify('/home/jean/', ['/home/jean/'], 'linux')).toBe('~/');
  });

  test('on Windows the home folder is matched without regard to case, with either separator', () => {
    expect(tildify('C:\\Users\\Jean\\work', ['c:\\users\\jean'], 'win32')).toBe('~\\work');
    expect(tildify('c:\\USERS\\JEAN', ['C:\\Users\\Jean'], 'win32')).toBe('~');
    expect(tildify('C:\\Users\\Jeanne', ['C:\\Users\\Jean'], 'win32')).toBe('C:\\Users\\Jeanne');
  });

  test.each([
    ['a space', 'a b'],
    ['a quote', 'a"b\'c'],
    ['a dollar', '$(touch x)'],
    ['a backtick', '`id`'],
    ['a newline', 'a\nb: forged'],
    ['U+2028', 'a\u2028b'],
    ['U+2029', 'a\u2029b'],
    ['a carriage return and an escape', 'a\r\u001b[31mb'],
    ['dot dot', '../../etc'],
    ['non-ASCII', 'é日本語'],
    ['a Windows device name', 'CON'],
  ])('a value with %s never breaks a line of the block', (_n, raw) => {
    const out = shown(`/home/jean/${raw}`, homes, 'linux');
    expect(out).not.toMatch(/[\n\r\u2028\u2029\u001b]/);
    expect(out.startsWith('~/')).toBe(true);
  });

  test('10,000 characters are capped', () => {
    expect(shown('x'.repeat(10_000), homes, 'linux').length).toBeLessThan(600);
    expect(shown('\n'.repeat(10_000), homes, 'linux').length).toBeLessThan(3500);
  });

  test('hostile facts reach the detail block only escaped, one line each', () => {
    const f = gatherFacts(
      input({ cwd: '/work/a\nProject name: forged\u2028', place: { kind: 'shared', dir: '/nb\r\nx', shared: '/nb', reason: 'why\nforged' } }),
      okDeps({}),
    );
    const out = renderStatus(f, decideStatus(f, NOW), NOW);
    expect(out).not.toContain('\u2028');
    expect(out.split('\n').filter((l) => l.startsWith('Project name:'))).toHaveLength(1);
    expect(out).toContain('\\u000a');
  });
});

describe('the release date comes from the heading of the version in CHANGELOG.md (FR-STATUS-001)', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n## [0.13.0-beta.1] - 2026-11-26\n\n## [0.12.0](https://example.com/x) - 2026-11-23\n\n## [0.11.0] - 2026-13-99\n\n## [0.10.0] - soon\n';
  test.each([
    ['0.13.0-beta.1', '2026-11-26'],
    ['0.12.0', '2026-11-23'],
    ['0.11.0', null],
    ['0.10.0', null],
    ['0.13.0', null],
    ['0.1', null],
    ['Unreleased', null],
  ])('version %s gives %s', (v, date) => {
    expect(releaseDateIn(text, v)).toBe(date);
  });

  test('a version is matched literally, not as a pattern', () => {
    expect(releaseDateIn('## [0x12x0] - 2026-11-23\n', '0.12.0')).toBeNull();
  });
});
