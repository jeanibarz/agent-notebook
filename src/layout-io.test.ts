import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureProjectsDir, layoutPath, readLayout, seenExists, writeLayout, writeSeen } from './layout-io.js';

// Issue #560, FR-PLACE-005, NFR-SAFE-001: the two files nb keeps in ~/.agent-notebook/projects/ are read and
// written without following a link, waiting on a special file or trusting another user's folder.
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let tmp: string;
let projects: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb layout io ')));
  projects = join(tmp, 'home', '.agent-notebook', 'projects');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const put = (content: string | Buffer): void => {
  mkdirSync(projects, { recursive: true, mode: 0o700 });
  writeFileSync(layoutPath(projects), content);
};

describe('readLayout: one word in a small regular file of this user (FR-PLACE-005)', () => {
  test('no projects folder, or no file in it: none', () => {
    expect(readLayout(projects)).toEqual({ state: 'none' });
    mkdirSync(projects, { recursive: true });
    expect(readLayout(projects)).toEqual({ state: 'none' });
  });

  test.each([
    ['plain', 'own', 'own'],
    ['a line end', 'ask\n', 'ask'],
    ['a CRLF', 'shared\r\n', 'shared'],
    ['a BOM and a CRLF', '\uFEFFown\r\n', 'own'],
  ])('%s is chosen', (_label, content, value) => {
    put(content);
    expect(readLayout(projects)).toMatchObject({ state: 'chosen', value });
  });

  test('the date comes from the file modification time', () => {
    put('own\n');
    utimesSync(layoutPath(projects), new Date('2026-01-02T12:00:00Z'), new Date('2026-01-02T12:00:00Z'));
    expect(readLayout(projects)).toEqual({ state: 'chosen', value: 'own', since: '2026-01-02' });
  });

  test.each([
    ['an unknown word', 'maybe\n'],
    ['two words', 'own ask\n'],
    ['an empty file', ''],
    ['a NUL', 'own\0\n'],
    ['upper case', 'OWN\n'],
    ['a file over 64 bytes holding the word first', 'own\n' + ' '.repeat(80)],
  ])('%s is unreadable', (_label, content) => {
    put(content);
    expect(readLayout(projects)).toMatchObject({ state: 'unreadable' });
  });

  test('a 10 MB file is unreadable and is not read into memory', () => {
    put(Buffer.alloc(10 * 1024 * 1024, 0x61));
    expect(readLayout(projects)).toMatchObject({ state: 'unreadable' });
  });

  test('a folder named .layout is unreadable', () => {
    mkdirSync(layoutPath(projects), { recursive: true });
    expect(readLayout(projects)).toEqual({ state: 'unreadable', since: null });
  });

  test('a symbolic link, even to a good file, is unreadable and is not followed', () => {
    if (isWin) return;
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, 'good'), 'own\n');
    symlinkSync(join(tmp, 'good'), layoutPath(projects));
    expect(readLayout(projects)).toEqual({ state: 'unreadable', since: null });
  });

  test('a FIFO is unreadable and the read does not wait for a writer', () => {
    if (isWin) return;
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    if (spawnSync('mkfifo', [layoutPath(projects)]).status !== 0) return; // no mkfifo here
    expect(readLayout(projects)).toEqual({ state: 'unreadable', since: null });
  });

  test('a projects folder that is a link is not read at all', () => {
    if (isWin) return;
    const real = join(tmp, 'real-projects');
    mkdirSync(real);
    writeFileSync(join(real, '.layout'), 'own\n');
    mkdirSync(join(tmp, 'home', '.agent-notebook'), { recursive: true });
    symlinkSync(real, projects);
    expect(readLayout(projects)).toEqual({ state: 'none' });
  });

  test('a file with a second hard link is still read as the word it holds', () => {
    if (isWin) return;
    put('ask\n');
    linkSync(layoutPath(projects), join(tmp, 'other-name'));
    expect(readLayout(projects)).toMatchObject({ state: 'chosen', value: 'ask' });
  });

  test('a file of another user is unreadable (the user id is injected, so this runs everywhere)', () => {
    put('own\n');
    expect(readLayout(projects, 4_000_000)).toMatchObject({ state: 'unreadable' });
    expect(readLayout(projects, typeof process.getuid === 'function' ? process.getuid() : null)).toMatchObject({ state: 'chosen', value: 'own' });
  });
});

describe('writeLayout: an exclusive 0600 temporary file, then a rename (FR-PLACE-005)', () => {
  test('makes projects/ (0700), writes the word and a line end, and leaves no temporary file', async () => {
    await writeLayout(projects, 'own');
    expect(readFileSync(layoutPath(projects), 'utf-8')).toBe('own\n');
    expect(readdirSync(projects)).toEqual(['.layout']);
    if (!isWin) {
      expect(statSync(layoutPath(projects)).mode & 0o777).toBe(0o600);
      expect(statSync(projects).mode & 0o777).toBe(0o700);
    }
  });

  test('a second answer replaces the first, whatever the first was (a corrupt file, a link)', async () => {
    put('garbage\0');
    await writeLayout(projects, 'ask');
    expect(readLayout(projects)).toMatchObject({ state: 'chosen', value: 'ask' });
    if (isWin) return;
    rmSync(layoutPath(projects));
    writeFileSync(join(tmp, 'elsewhere'), 'untouched\n');
    symlinkSync(join(tmp, 'elsewhere'), layoutPath(projects));
    await writeLayout(projects, 'shared');
    expect(readFileSync(join(tmp, 'elsewhere'), 'utf-8')).toBe('untouched\n');
    expect(readLayout(projects)).toMatchObject({ state: 'chosen', value: 'shared' });
  });

  test('a folder in the way of .layout is refused in one plain sentence, and nothing is left behind', async () => {
    mkdirSync(join(layoutPath(projects), 'x'), { recursive: true });
    await expect(writeLayout(projects, 'own')).rejects.toThrow(/could not record the choice \(\w+\)/);
    expect(readdirSync(projects)).toEqual(['.layout']);
  });

  test('a projects folder that is a link is refused, and the link target is untouched', async () => {
    if (isWin) return;
    const real = join(tmp, 'real-projects');
    mkdirSync(real);
    mkdirSync(join(tmp, 'home', '.agent-notebook'), { recursive: true });
    symlinkSync(real, projects);
    await expect(writeLayout(projects, 'own')).rejects.toThrow(/not a plain folder of yours/);
    expect(readdirSync(real)).toEqual([]);
  });

  test('a read-only parent is refused with the code, and nothing is made', async () => {
    if (isWin || isRoot) return;
    const parent = join(tmp, 'ro');
    mkdirSync(parent);
    chmodSync(parent, 0o500);
    try {
      await expect(writeLayout(join(parent, 'projects'), 'own')).rejects.toThrow(/could not make the folder .* \(EACCES\)/);
    } finally {
      chmodSync(parent, 0o700);
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  test('a temporary file left by a dead writer is swept once old, and a fresh one is left alone', async () => {
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    const old = join(projects, `.layout.123.${'a'.repeat(16)}.tmp`);
    const fresh = join(projects, `.layout.124.${'b'.repeat(16)}.tmp`);
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await writeLayout(projects, 'own');
    expect(readdirSync(projects).sort()).toEqual(['.layout', `.layout.124.${'b'.repeat(16)}.tmp`]);
  });

  test('50 writes at once leave one whole answer and no temporary file', async () => {
    const values = ['shared', 'own', 'ask'] as const;
    await Promise.all(Array.from({ length: 50 }, (_, i) => writeLayout(projects, values[i % 3]!)));
    expect(readLayout(projects)).toMatchObject({ state: 'chosen' });
    expect(readdirSync(projects)).toEqual(['.layout']);
  });
});

describe('.seen-<name>: an exclusive create, 0600 (FR-PLACE-005)', () => {
  test('the first call makes it, a second does not, and seenExists tells', () => {
    expect(seenExists(projects, 'acme-app')).toBe(false);
    expect(writeSeen(projects, 'acme-app')).toBe(true);
    expect(writeSeen(projects, 'acme-app')).toBe(false);
    expect(seenExists(projects, 'acme-app')).toBe(true);
    expect(readdirSync(projects)).toEqual(['.seen-acme-app']);
    expect(readFileSync(join(projects, '.seen-acme-app'), 'utf-8')).toBe('');
    if (!isWin) expect(statSync(join(projects, '.seen-acme-app')).mode & 0o777).toBe(0o600);
  });

  test.each(['', '..', '../x', 'a/b', 'a b', 'A', '-x', '.x', 'x\n', 'x'.repeat(101)])('a name that is not a cleaned project name (%j) makes no file and counts as settled', (name) => {
    expect(writeSeen(projects, name)).toBe(false);
    expect(seenExists(projects, name)).toBe(true);
    expect(existsSync(projects) ? readdirSync(projects) : []).toEqual([]);
  });

  test('50 racing creates have exactly one winner', async () => {
    const wins = await Promise.all(Array.from({ length: 50 }, async () => writeSeen(projects, 'acme-app')));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  test('a link named like the file counts as settled and is not written through', () => {
    if (isWin) return;
    mkdirSync(projects, { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, 'target'), 'keep\n');
    symlinkSync(join(tmp, 'target'), join(projects, '.seen-acme-app'));
    expect(seenExists(projects, 'acme-app')).toBe(true);
    expect(writeSeen(projects, 'acme-app')).toBe(false);
    expect(readFileSync(join(tmp, 'target'), 'utf-8')).toBe('keep\n');
  });

  test('a projects folder that is a link gets no file', () => {
    if (isWin) return;
    const real = join(tmp, 'real-projects');
    mkdirSync(real);
    mkdirSync(join(tmp, 'home', '.agent-notebook'), { recursive: true });
    symlinkSync(real, projects);
    expect(writeSeen(projects, 'acme-app')).toBe(false);
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('ensureProjectsDir', () => {
  test('makes the folder 0700 and accepts it again', () => {
    ensureProjectsDir(projects);
    ensureProjectsDir(projects);
    if (!isWin) expect(statSync(projects).mode & 0o777).toBe(0o700);
  });

  test('a file in its place is refused in a plain sentence', () => {
    mkdirSync(join(tmp, 'home', '.agent-notebook'), { recursive: true });
    writeFileSync(projects, 'not a folder');
    expect(() => ensureProjectsDir(projects)).toThrow(/could not make the folder/);
  });
});
