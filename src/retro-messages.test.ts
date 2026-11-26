import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETRO_LESSONS, USER_INSTRUCTIONS } from './agent-text.js';
import type { EnabledState } from './enabled.js';
import { retro, type RetroOptions } from './loop.js';
import type { ProjectState } from './project.js';

// The retro half of the user's message files (issue #539, FR-RETRO-001, FR-MSG-001): which
// outcomes read a message file, and how often the project is asked. In process, with a
// counting wrapper around `node:fs`, so "read nothing" is measured, not inferred from an
// empty output (a non-nudge prints nothing whether or not a file was read).
const touched = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <F extends (...a: any[]) => any>(f: F): F =>
    ((...a: any[]) => {
      if (typeof a[0] === 'string' && a[0].includes('.agent-notebook')) touched.paths.push(a[0]);
      return f(...a);
    }) as F;
  return { ...real, statSync: wrap(real.statSync), lstatSync: wrap(real.lstatSync), openSync: wrap(real.openSync), readdirSync: wrap(real.readdirSync), realpathSync: wrap(real.realpathSync) as typeof real.realpathSync };
});

const on = (enabled: boolean): EnabledState => ({ enabled, source: 'env', value: enabled ? '1' : '0', origin: null, warning: null });
const state = (over: Partial<ProjectState> = {}): ProjectState => ({ name: 'acme-app', source: 'remote', reason: 'r', oldName: '', bare: false, undetermined: false, ...over });

let tmp: string;
let home: string;
let store: string;
let plain: string;
let msgDir: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'nb retro msgs ')));
  home = join(tmp, 'home');
  store = join(tmp, 'store');
  plain = join(tmp, 'plain');
  msgDir = join(home, '.agent-notebook', 'messages');
  mkdirSync(msgDir, { recursive: true });
  mkdirSync(store);
  mkdirSync(plain);
  touched.paths.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(over: Partial<RetroOptions> = {}): ReturnType<typeof retro> {
  return retro({ session: 's1', dir: store, cwd: plain, env: {}, home, enabled: () => on(true), project: () => state(), ...over });
}
const messageTouches = (): string[] => touched.paths.filter((p) => p.includes('.agent-notebook'));

describe('nb retro reads a message file only after the claim, and only for a nudge (FR-RETRO-001, FR-MSG-001)', () => {
  beforeEach(() => {
    writeFileSync(join(msgDir, 'retro.txt'), 'global text');
    writeFileSync(join(msgDir, 'acme-app.retro.txt'), 'project text');
  });

  test('control: a nudge lists the folder and reads both files', () => {
    const r = run();
    expect(r.outcome).toBe('nudge');
    expect(r.text).toContain('global text');
    expect(messageTouches().length).toBeGreaterThan(0);
  });

  test('already: nothing under ~/.agent-notebook is touched', () => {
    writeFileSync(join(store, '.retro-s1'), 'x');
    const r = run();
    expect(r.outcome).toBe('already');
    expect(messageTouches()).toEqual([]);
  });

  test('off in the working directory: nothing is touched', () => {
    const r = run({ enabled: () => on(false) });
    expect(r.outcome).toBe('off');
    expect(messageTouches()).toEqual([]);
  });

  test('off in --work-dir only: nothing is touched, and the claim is released', () => {
    const wd = join(tmp, 'wd');
    mkdirSync(wd);
    const r = run({ workDir: wd, enabled: (_e, cwd) => on(cwd !== wd) });
    expect(r.outcome).toBe('off-work-dir');
    expect(messageTouches()).toEqual([]);
  });
});

describe('nb retro resolves the project once, after the claim, and only when needed (FR-RETRO-002, FR-MSG-001)', () => {
  const counted = (over: Partial<ProjectState> = {}): { project: NonNullable<RetroOptions['project']>; asks: Array<{ cwd: string }> } => {
    const asks: Array<{ cwd: string }> = [];
    return {
      asks,
      project: (_env, cwd) => {
        asks.push({ cwd });
        return state(over);
      },
    };
  };
  const extraFile = (text: string): Record<string, string> => {
    const p = join(tmp, 'extra.txt');
    writeFileSync(p, text);
    return { NB_RETRO_EXTRA_PROMPT: p };
  };

  test('one resolution serves the file lookup, both message files and the extra prompt', () => {
    writeFileSync(join(msgDir, 'retro.txt'), 'global {project}');
    writeFileSync(join(msgDir, 'acme-app.retro.txt'), 'project {project}');
    const c = counted();
    const r = run({ project: c.project, env: extraFile('extra {project}') });
    expect(c.asks).toHaveLength(1);
    expect(r.text).toBe(
      [
        RETRO_LESSONS,
        [
          USER_INSTRUCTIONS.globalLabel('retro.txt'),
          'global acme-app',
          USER_INSTRUCTIONS.end,
          USER_INSTRUCTIONS.projectLabel('acme-app', 'acme-app.retro.txt'),
          'project acme-app',
          USER_INSTRUCTIONS.end,
        ].join('\n'),
        'extra acme-app',
      ].join('\n\n'),
    );
  });

  test('not asked at all without a project file, a {project} token or an extra prompt', () => {
    writeFileSync(join(msgDir, 'retro.txt'), 'no tokens here, and {session}');
    const c = counted();
    const r = run({ project: c.project });
    expect(c.asks).toHaveLength(0);
    expect(r.text).toContain('no tokens here, and s1');
  });

  test('not asked for a global file that is refused, nor for an extra prompt with no session id', () => {
    writeFileSync(join(msgDir, 'retro.txt'), 'x'.repeat(4001) + ' {project}');
    const c = counted();
    expect(run({ project: c.project }).text).toContain('was not used (larger than 4000 characters)');
    expect(c.asks).toHaveLength(0);
    writeFileSync(join(msgDir, 'retro.txt'), 'g');
    expect(run({ project: c.project, session: '', env: extraFile('e {project}') }).text).not.toContain('e acme-app');
    expect(c.asks).toHaveLength(0);
  });

  test('asked once when only a project file exists, and its name is the one that selects it', () => {
    writeFileSync(join(msgDir, 'acme-app.retro.txt'), 'project text');
    const c = counted();
    expect(run({ project: c.project }).text).toContain('project text');
    expect(c.asks).toHaveLength(1);
  });

  test('asked in --work-dir when it is an existing directory, else in the working directory', () => {
    writeFileSync(join(msgDir, 'retro.txt'), '{project}');
    const wd = join(tmp, 'wd');
    mkdirSync(wd);
    const c = counted();
    run({ project: c.project, workDir: wd });
    run({ project: c.project, session: 's2' });
    run({ project: c.project, session: 's3', workDir: join(tmp, 'missing') });
    expect(c.asks.map((a) => a.cwd)).toEqual([wd, plain, plain]);
  });

  test('a working directory that is gone: only NB_PROJECT_SLUG names the project, and git is never asked', () => {
    writeFileSync(join(msgDir, 'retro.txt'), 'in {project}');
    writeFileSync(join(msgDir, 'acme-app.retro.txt'), 'project text');
    const c = counted();
    const r = run({ project: c.project, cwd: null, env: { NB_PROJECT_SLUG: 'Other One' } });
    expect(c.asks).toHaveLength(0);
    expect(r.text).toContain('in other-one');
    expect(r.text).not.toContain('project text');
    const r2 = run({ project: c.project, cwd: null, session: 's2', env: { NB_PROJECT_SLUG: 'Acme-App' } });
    expect(c.asks).toHaveLength(0);
    expect(r2.text).toContain('project text');
    expect(run({ project: c.project, cwd: null, session: 's3' }).text).not.toContain('in ');
  });

  test('a name from the folder fills {project} but selects no file; a device name selects none', () => {
    writeFileSync(join(msgDir, 'retro.txt'), 'in {project}');
    writeFileSync(join(msgDir, 'app.retro.txt'), 'folder file');
    const c = counted({ name: 'app', source: 'folder' });
    const r = run({ project: c.project });
    expect(r.text).toContain('in app');
    expect(r.text).not.toContain('folder file');
    writeFileSync(join(msgDir, 'con.retro.txt'), 'device file');
    const d = counted({ name: 'con', source: 'env' });
    const r2 = run({ project: d.project, session: 's2', isDeviceName: (n) => n === 'con' });
    expect(r2.text).toContain('in con');
    expect(r2.text).not.toContain('device file');
  });
});
