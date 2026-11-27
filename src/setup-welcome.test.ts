import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FIRST_START_EXPIRY_MS,
  formatPending,
  parseFirstStart,
  pendingExpired,
  setupDue,
  type FirstStartRead,
  type SetupFacts,
} from './layout.js';
import {
  claimFirstStart,
  confirmFirstStart,
  firstStartPath,
  prepareSessionStart,
  readFirstStart,
  sessionHash,
  writeSeen,
  type SessionStartDeps,
} from './layout-io.js';

// Issue #560, FR-SETUP-001 and FR-SETUP-002: who is not set up yet (the predicate), and the one-time claim
// `.first-start` (its grammar, its claim, its expiry, its confirmation).
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SESSION = 'abcdef12-3456-7890';
const T0 = Date.parse('2026-11-27T10:00:00.000Z');

describe('the .first-start grammar (FR-SETUP-002)', () => {
  test('a pending claim and a confirmed one parse, with a BOM, a CRLF and white space around them', () => {
    const text = formatPending(T0, sessionHash(SESSION));
    expect(text).toBe(`pending 2026-11-27T10:00:00.000Z ${sessionHash(SESSION)}\n`);
    expect(parseFirstStart(text)).toEqual({ state: 'pending', at: T0, hash: sessionHash(SESSION), raw: text });
    expect(parseFirstStart('﻿done\r\n')).toEqual({ state: 'done' });
    expect(parseFirstStart('  done  ')).toEqual({ state: 'done' });
    expect(sessionHash(SESSION)).toMatch(/^[0-9a-f]{16}$/);
  });

  test.each([
    '',
    'Done',
    'done done',
    'pending',
    'pending 2026-11-27T10:00:00.000Z',
    'pending 2026-11-27T10:00:00.000Z abcdef',
    'pending 2026-11-27T10:00:00.000Z ABCDEF0123456789',
    'pending 2026-11-27T10:00:00.000Z 0123456789abcdef0',
    'pending yesterday 0123456789abcdef',
    'pending 2026-13-45T10:00:00.000Z 0123456789abcdef',
    'pending 2026-11-27T10:00:00.000Z 0123456789abcdef\ndone',
    'done\0',
    'shared',
  ])('%j is neither', (raw) => {
    expect(parseFirstStart(raw)).toBeNull();
  });

  test('expired: over 60 minutes old, or dated in the future; a fresh one is not', () => {
    expect(FIRST_START_EXPIRY_MS).toBe(3_600_000);
    expect(pendingExpired(T0, T0 + 3_600_000)).toBe(false);
    expect(pendingExpired(T0, T0 + 3_600_001)).toBe(true);
    expect(pendingExpired(T0, T0)).toBe(false);
    // A claim written just after this start read its clock is not "in the future" (a race of two starts).
    expect(pendingExpired(T0 + 1, T0)).toBe(false);
    expect(pendingExpired(T0 + 300_000, T0)).toBe(false);
    expect(pendingExpired(T0 + 300_001, T0)).toBe(true);
    expect(pendingExpired(T0 + 365 * 86_400_000, T0)).toBe(true);
  });
});

/** The facts of a person who is plainly new; each row of the table changes one. */
function facts(over: Record<string, unknown> = {}): SetupFacts {
  const v = {
    welcome: true,
    envSet: false,
    projectsUsed: false,
    messagesPresent: false,
    notebooksUsed: false,
    firstStart: { state: 'none' } as FirstStartRead,
    nowMs: T0,
    switchOn: true,
    placeKnown: true,
    sessionLength: SESSION.length,
    fits: true,
    ...over,
  } as {
    welcome: boolean; envSet: boolean; projectsUsed: boolean; messagesPresent: boolean; notebooksUsed: boolean;
    firstStart: FirstStartRead; nowMs: number; switchOn: boolean; placeKnown: boolean; sessionLength: number; fits: boolean;
  };
  return {
    welcome: v.welcome,
    envSet: () => v.envSet,
    projectsUsed: () => v.projectsUsed,
    messagesPresent: () => v.messagesPresent,
    notebooksUsed: () => v.notebooksUsed,
    firstStart: () => v.firstStart,
    nowMs: v.nowMs,
    switchOn: () => v.switchOn,
    placeKnown: () => v.placeKnown,
    sessionLength: () => v.sessionLength,
    fits: () => v.fits,
  };
}
const pendingAt = (at: number): FirstStartRead => ({ state: 'pending', at, hash: sessionHash(SESSION), raw: formatPending(at, sessionHash(SESSION)) });

describe('setupDue: the predicate, one row per kind of person (FR-SETUP-001)', () => {
  test('a person who is new is due, with no takeover', () => {
    expect(setupDue(facts())).toEqual({ due: true, takeover: false, raw: null });
  });

  test.each([
    ['no --welcome (a person typing, Codex, a subagent, a resumed chat)', { welcome: false }],
    ['NB_DIR or NB_PROJECT_SLUG set', { envSet: true }],
    ['an own folder (or any entry) in projects/', { projectsUsed: true }],
    ['a messages folder', { messagesPresent: true }],
    ['a notebook with a shelf, a .git or a .nb.json', { notebooksUsed: true }],
    ['a confirmed claim', { firstStart: { state: 'done' } as FirstStartRead }],
    ['a fresh pending claim', { firstStart: pendingAt(T0 - 60_000) }],
    ['a pending claim exactly 60 minutes old', { firstStart: pendingAt(T0 - 3_600_000) }],
    ['an unreadable claim (a link, a folder, a FIFO, too big, garbage)', { firstStart: { state: 'unreadable' } as FirstStartRead }],
    ['the notebook switched off', { switchOn: false }],
    ['a place that cannot be decided', { placeKnown: false }],
    ['no session id', { sessionLength: 0 }],
    ['a session id of 7 characters', { sessionLength: 7 }],
    ['a note that does not fit --max-chars', { fits: false }],
  ])('not due: %s', (_label, over) => {
    const v = setupDue(facts(over));
    expect(v.due).toBe(false);
  });

  test('a session id of exactly 8 characters is enough', () => {
    expect(setupDue(facts({ sessionLength: 8 })).due).toBe(true);
  });

  test('an expired pending claim is due as a takeover, whether it is old or dated in the future', () => {
    const old = pendingAt(T0 - 3_600_001);
    expect(setupDue(facts({ firstStart: old }))).toEqual({ due: true, takeover: true, raw: (old as { raw: string }).raw });
    const future = pendingAt(T0 + 300_001);
    expect(setupDue(facts({ firstStart: future }))).toMatchObject({ due: true, takeover: true });
  });

  test('the facts are read in order: nothing later is read once a condition fails', () => {
    const read: string[] = [];
    const f = facts({ envSet: true });
    const spy = <T,>(name: string, fn: () => T) => (): T => (read.push(name), fn());
    setupDue({ ...f, envSet: spy('env', f.envSet), projectsUsed: spy('projects', f.projectsUsed), fits: spy('fits', f.fits), switchOn: spy('switch', f.switchOn) });
    expect(read).toEqual(['env']);
  });
});

let tmp: string;
let home: string;
let projects: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb first start ')));
  home = join(tmp, 'home');
  projects = join(home, '.agent-notebook', 'projects');
});
afterEach(() => {
  try {
    chmodSync(projects, 0o700);
  } catch {
    // not made
  }
  rmSync(tmp, { recursive: true, force: true });
});
const claimFile = (): string => firstStartPath(projects);
const put = (content: string | Buffer): void => {
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  writeFileSync(claimFile(), content);
};
const text = (): string => readFileSync(claimFile(), 'utf-8');
const files = (): string[] => readdirSync(projects).sort();

describe('the claim: an exclusive create in a real folder of this user (FR-SETUP-002)', () => {
  test('the first start makes projects/ (0700) and .first-start (0600), holding pending, the time and the session hash', () => {
    expect(claimFirstStart(projects, SESSION, T0)).toBe(true);
    expect(text()).toBe(`pending 2026-11-27T10:00:00.000Z ${sessionHash(SESSION)}\n`);
    expect(files()).toEqual(['.first-start']);
    if (!isWin) {
      expect(statModeOf(projects)).toBe(0o700);
      expect(statModeOf(claimFile())).toBe(0o600);
    }
    expect(readFirstStart(projects)).toMatchObject({ state: 'pending', at: T0, hash: sessionHash(SESSION) });
  });

  test('a second claim does not win, whatever the session', () => {
    expect(claimFirstStart(projects, SESSION, T0)).toBe(true);
    expect(claimFirstStart(projects, 'another-session', T0 + 1)).toBe(false);
    expect(text()).toContain(sessionHash(SESSION));
  });

  test.skipIf(isWin || isRoot)('a create that fails after projects/ is made (a full disk, a folder the user cannot write) claims nothing: the first start is still due', () => {
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    chmodSync(projects, 0o500);
    expect(claimFirstStart(projects, SESSION, T0)).toBe(false);
    expect(files()).toEqual([]);
    expect(readFirstStart(projects)).toEqual({ state: 'none' });
    chmodSync(projects, 0o700);
    expect(claimFirstStart(projects, SESSION, T0)).toBe(true);
  });

  test.skipIf(isWin)('projects/ as a link, or ~/.agent-notebook as a link, claims nothing and writes nothing', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    symlinkSync(elsewhere, projects);
    expect(claimFirstStart(projects, SESSION, T0)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    unlinkSync(projects);
    rmSync(join(home, '.agent-notebook'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.agent-notebook'));
    expect(claimFirstStart(projects, SESSION, T0)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('projects/ that is a file claims nothing and never throws', () => {
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    writeFileSync(projects, 'x');
    expect(claimFirstStart(projects, SESSION, T0)).toBe(false);
  });
});

function statModeOf(p: string): number {
  return Number(execFileSync(process.execPath, ['-e', `process.stdout.write(String(require('fs').statSync(${JSON.stringify(p)}).mode & 0o777))`], { encoding: 'utf-8' }));
}

describe('expiry: a pending claim older than 60 minutes, or dated in the future, is taken over once (FR-SETUP-002)', () => {
  test('an expired claim is renamed aside and replaced by the one process that takes it over; the aside file is gone', () => {
    expect(claimFirstStart(projects, SESSION, T0)).toBe(true);
    const seen = readFirstStart(projects);
    if (seen.state !== 'pending') throw new Error('expected pending');
    const later = T0 + 3_600_001;
    expect(claimFirstStart(projects, 'second-session', later, seen.raw)).toBe(true);
    expect(text()).toBe(`pending ${new Date(later).toISOString()} ${sessionHash('second-session')}\n`);
    expect(files()).toEqual(['.first-start']);
    // The loser of the same takeover (it saw the same old claim) finds a fresh one and takes nothing.
    expect(claimFirstStart(projects, 'third-session', later + 1, seen.raw)).toBe(false);
    expect(text()).toContain(sessionHash('second-session'));
    expect(files()).toEqual(['.first-start']);
  });

  test('a process that saw an old claim but finds a different file at the rename puts it back and claims nothing', () => {
    expect(claimFirstStart(projects, SESSION, T0)).toBe(true);
    const staleRaw = formatPending(T0 - 7_200_000, sessionHash('old-session'));
    expect(claimFirstStart(projects, 'late-session', T0 + 10, staleRaw)).toBe(false);
    expect(text()).toBe(`pending 2026-11-27T10:00:00.000Z ${sessionHash(SESSION)}\n`);
    expect(files()).toEqual(['.first-start']);
  });

  test('through prepareSessionStart with an injected clock: asked, not asked within the hour, asked again after it, and once only', () => {
    const d = deps({ nowMs: T0 });
    expect(prepareSessionStart(d).note?.kind).toBe('first');
    expect(prepareSessionStart({ ...d, session: 'second-session', nowMs: T0 + 3_599_000 }).note).toBeNull();
    expect(prepareSessionStart({ ...d, session: 'second-session', nowMs: T0 + 3_601_000 }).note?.kind).toBe('first');
    expect(prepareSessionStart({ ...d, session: 'third-session', nowMs: T0 + 3_602_000 }).note).toBeNull();
  });

  test('a claim dated in the future is expired: the next fresh start takes it over, once', () => {
    put(formatPending(T0 + 5 * 86_400_000, sessionHash('clock-was-wrong')));
    const d = deps({ nowMs: T0 });
    expect(prepareSessionStart(d).note?.kind).toBe('first');
    expect(prepareSessionStart({ ...d, session: 'second-session' }).note).toBeNull();
  });
});

describe('the confirmation: pending for this session becomes done, and nothing else changes (FR-SETUP-002)', () => {
  test('the session that was shown the note confirms it: done, by a temporary file and a rename, nothing left behind', () => {
    claimFirstStart(projects, SESSION, T0);
    confirmFirstStart(projects, SESSION);
    expect(text()).toBe('done\n');
    expect(files()).toEqual(['.first-start']);
    expect(readFirstStart(projects)).toEqual({ state: 'done' });
  });

  test('another session, no session, no claim, and a done claim change nothing', () => {
    confirmFirstStart(projects, SESSION);
    expect(existsSync(projects)).toBe(false);
    claimFirstStart(projects, SESSION, T0);
    confirmFirstStart(projects, 'another-session');
    confirmFirstStart(projects, '');
    expect(text()).toContain('pending');
    put('done\n');
    confirmFirstStart(projects, SESSION);
    expect(text()).toBe('done\n');
  });

  test('a confirmation that finds the claim taken over by another chat leaves the new claim alone', () => {
    claimFirstStart(projects, SESSION, T0);
    const seen = readFirstStart(projects);
    if (seen.state !== 'pending') throw new Error('expected pending');
    expect(claimFirstStart(projects, 'second-session', T0 + 3_700_000, seen.raw)).toBe(true);
    confirmFirstStart(projects, SESSION);
    expect(text()).toBe(`pending ${new Date(T0 + 3_700_000).toISOString()} ${sessionHash('second-session')}\n`);
  });

  test('a takeover that finds the claim confirmed meanwhile puts the done file back: the question is not asked again', () => {
    claimFirstStart(projects, SESSION, T0);
    const seen = readFirstStart(projects);
    if (seen.state !== 'pending') throw new Error('expected pending');
    confirmFirstStart(projects, SESSION);
    expect(claimFirstStart(projects, 'second-session', T0 + 3_700_000, seen.raw)).toBe(false);
    expect(text()).toBe('done\n');
    expect(files()).toEqual(['.first-start']);
  });

  test.skipIf(isWin || isRoot)('a write error is swallowed and leaves the claim pending', () => {
    claimFirstStart(projects, SESSION, T0);
    chmodSync(projects, 0o500);
    expect(() => confirmFirstStart(projects, SESSION)).not.toThrow();
    chmodSync(projects, 0o700);
    expect(text()).toContain('pending');
  });
});

describe('a hostile .first-start is never read through, never trusted and never a throw (NFR-SAFE-001)', () => {
  const bad: Array<[string, () => void]> = [
    ['a garbage word', () => put('hello\n')],
    ['an empty file', () => put('')],
    ['a NUL byte', () => put('done\0\n')],
    ['10 MB', () => put(Buffer.alloc(10 * 1024 * 1024, 100))],
    ['a folder', () => (mkdirSync(projects, { recursive: true }), mkdirSync(claimFile()))],
  ];
  if (!isWin) {
    bad.push(['a link to a file that says done', () => (put('x'), writeFileSync(join(tmp, 'done.txt'), 'done\n'), rmSync(claimFile()), symlinkSync(join(tmp, 'done.txt'), claimFile()))]);
    bad.push(['a FIFO', () => (mkdirSync(projects, { recursive: true }), execFileSync('mkfifo', [claimFile()]))]);
  }
  for (const [label, make] of bad) {
    test(`${label}: unreadable, no note, nothing claimed or replaced`, () => {
      make();
      const before = files();
      expect(readFirstStart(projects)).toEqual({ state: 'unreadable' });
      expect(prepareSessionStart(deps({})).note).toBeNull();
      confirmFirstStart(projects, SESSION);
      expect(files()).toEqual(before);
    });
  }
});

describe('a linked projects/ folder is never read or written through (NFR-SAFE-001)', () => {
  test.skipIf(isWin)('projects/ as a link to a folder holding a pending claim for this chat: unreadable, and the confirm leaves the target untouched', () => {
    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const claim = formatPending(T0, sessionHash(SESSION));
    writeFileSync(join(elsewhere, '.first-start'), claim);
    mkdirSync(join(home, '.agent-notebook'), { recursive: true });
    rmSync(projects, { recursive: true, force: true });
    symlinkSync(elsewhere, projects);
    expect(readFirstStart(projects)).toEqual({ state: 'unreadable' });
    confirmFirstStart(projects, SESSION);
    expect(readFileSync(join(elsewhere, '.first-start'), 'utf-8')).toBe(claim);
    expect(readdirSync(elsewhere)).toEqual(['.first-start']);
  });
});

/** Plain deps of a person who is new, in a project named from the git remote. */
function deps(over: Partial<SessionStartDeps>): SessionStartDeps {
  return {
    welcome: true,
    env: {},
    projectsDir: projects,
    messagesDir: join(home, '.agent-notebook', 'messages'),
    sharedDir: join(home, '.agent-notebook', 'notebooks'),
    session: SESSION,
    nowMs: T0,
    placeKind: 'shared',
    projectName: () => 'acme-app',
    canName: () => true,
    switchOn: () => true,
    fits: () => true,
    ...over,
  };
}

describe('prepareSessionStart: the one entry point (FR-SETUP-001, FR-SETUP-003)', () => {
  test('first start in a named project: note A, the claim made, the index grouped', () => {
    expect(prepareSessionStart(deps({}))).toEqual({ note: { kind: 'first', name: 'acme-app' }, group: true, seenWritten: false });
    expect(readFirstStart(projects).state).toBe('pending');
  });

  test('first start with no project name: note A prime, which still spends the claim', () => {
    const r = prepareSessionStart(deps({ projectName: () => null, canName: () => false }));
    expect(r).toEqual({ note: { kind: 'first-no-project', name: '' }, group: false, seenWritten: false });
    expect(readFirstStart(projects).state).toBe('pending');
  });

  test('a note that does not fit claims nothing, so the question is not spent unseen', () => {
    expect(prepareSessionStart(deps({ fits: () => false })).note).toBeNull();
    expect(existsSync(claimFile())).toBe(false);
    expect(prepareSessionStart(deps({})).note?.kind).toBe('first');
  });

  test('the switch off, an unknown place or a short session id claim nothing', () => {
    expect(prepareSessionStart(deps({ switchOn: () => false })).note).toBeNull();
    expect(prepareSessionStart(deps({ placeKind: 'unknown' })).note).toBeNull();
    expect(prepareSessionStart(deps({ session: 'short' })).note).toBeNull();
    expect(prepareSessionStart(deps({ session: '' })).note).toBeNull();
    expect(existsSync(claimFile())).toBe(false);
  });

  test('without --welcome nothing is claimed and no note is made, whatever else holds', () => {
    expect(prepareSessionStart(deps({ welcome: false }))).toEqual({ note: null, group: false, seenWritten: false });
    expect(existsSync(projects)).toBe(false);
  });

  test('NB_DIR or NB_PROJECT_SLUG set: nothing is read, nothing written', () => {
    expect(prepareSessionStart(deps({ env: { NB_DIR: join(tmp, 'x') } }))).toEqual({ note: null, group: false, seenWritten: false });
    expect(prepareSessionStart(deps({ env: { NB_PROJECT_SLUG: 'acme' } })).note).toBeNull();
    expect(existsSync(projects)).toBe(false);
  });

  test('NB_DIR set with both files present: no note A, no note B, no grouping, whatever they hold', () => {
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(claimFile(), 'done\n');
    writeFileSync(join(projects, '.layout'), 'ask\n');
    expect(prepareSessionStart(deps({ env: { NB_DIR: join(tmp, 'x') } }))).toEqual({ note: null, group: false, seenWritten: false });
    expect(files()).toEqual(['.first-start', '.layout']);
  });

  test('a blank NB_DIR or NB_PROJECT_SLUG counts as unset', () => {
    expect(prepareSessionStart(deps({ env: { NB_DIR: '  ', NB_PROJECT_SLUG: '' } })).note?.kind).toBe('first');
  });

  test.each([
    ['a project folder in projects/', (): void => void mkdirSync(join(projects, 'acme-app'), { recursive: true })],
    ['a messages folder', (): void => void mkdirSync(join(home, '.agent-notebook', 'messages'), { recursive: true })],
    ['a shelf in the notebook', (): void => (mkdirSync(join(home, '.agent-notebook', 'notebooks'), { recursive: true }), writeFileSync(join(home, '.agent-notebook', 'notebooks', 'build.md'), '- [+1] a lesson\n'))],
    ['a .git folder in the notebook', (): void => void mkdirSync(join(home, '.agent-notebook', 'notebooks', '.git'), { recursive: true })],
    ['a .nb.json in the notebook', (): void => (mkdirSync(join(home, '.agent-notebook', 'notebooks'), { recursive: true }), writeFileSync(join(home, '.agent-notebook', 'notebooks', '.nb.json'), '{}'))],
  ])('an existing user (%s) is not new', (_label, make) => {
    make();
    expect(prepareSessionStart(deps({})).note).toBeNull();
    expect(existsSync(claimFile())).toBe(false);
  });

  test('a dot-file or a non-markdown file in the notebook, and a dot-entry in projects/, do not make a person existing', () => {
    mkdirSync(join(home, '.agent-notebook', 'notebooks'), { recursive: true });
    writeFileSync(join(home, '.agent-notebook', 'notebooks', '.retro-abc'), '');
    writeFileSync(join(home, '.agent-notebook', 'notebooks', 'readme.txt'), '');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, '.layout.123.tmp'), '');
    expect(prepareSessionStart(deps({})).note?.kind).toBe('first');
  });

  test('50 starts in one process, one after another, give exactly one note', () => {
    const notes = Array.from({ length: 50 }, (_, i) => prepareSessionStart(deps({ session: `session-number-${i}` })).note).filter((n) => n !== null);
    expect(notes).toHaveLength(1);
  });

  test('the grouping follows the files: .layout or .first-start present groups from the first chat, neither does not', () => {
    expect(prepareSessionStart(deps({ welcome: false })).group).toBe(false);
    put('done\n');
    expect(prepareSessionStart(deps({ welcome: false })).group).toBe(true);
    expect(prepareSessionStart(deps({ welcome: false, canName: () => false })).group).toBe(false);
    rmSync(claimFile());
    writeFileSync(join(projects, '.layout'), 'own\n');
    expect(prepareSessionStart(deps({ welcome: false })).group).toBe(true);
  });
});

describe('note B: a new project, when the answer is ask (FR-SETUP-003)', () => {
  beforeEach(() => {
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(projects, '.layout'), 'ask\n');
    writeFileSync(claimFile(), 'done\n');
  });

  test('printed once, claimed by .seen-<name>, with its own group flag', () => {
    expect(prepareSessionStart(deps({}))).toEqual({ note: { kind: 'project', name: 'acme-app' }, group: true, seenWritten: true });
    expect(files()).toContain('.seen-acme-app');
    expect(prepareSessionStart(deps({})).note).toBeNull();
  });

  test('without --welcome, with another answer, for a project with shelves, a name from nowhere, or a place that is not shared: nothing', () => {
    expect(prepareSessionStart(deps({ welcome: false })).note).toBeNull();
    expect(prepareSessionStart(deps({ projectName: () => null })).note).toBeNull();
    expect(prepareSessionStart(deps({ placeKind: 'own' })).note).toBeNull();
    expect(prepareSessionStart(deps({ switchOn: () => false })).note).toBeNull();
    expect(prepareSessionStart(deps({ fits: () => false })).note).toBeNull();
    const shared = join(home, '.agent-notebook', 'notebooks');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'build@Acme-App.md'), '- [+1] a lesson\n');
    expect(prepareSessionStart(deps({})).note).toBeNull();
    expect(files()).not.toContain('.seen-acme-app');
    writeFileSync(join(projects, '.layout'), 'shared\n');
    rmSync(join(shared, 'build@Acme-App.md'));
    expect(prepareSessionStart(deps({})).note).toBeNull();
  });

  test('a project that was already settled (.seen) is not asked again', () => {
    expect(writeSeen(projects, 'acme-app')).toBe(true);
    expect(prepareSessionStart(deps({})).note).toBeNull();
  });

  test('note B does not touch .first-start', () => {
    prepareSessionStart(deps({}));
    expect(text()).toBe('done\n');
  });
});
