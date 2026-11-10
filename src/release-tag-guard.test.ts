import { describe, test, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard for issue #265: the release workflow triggers on any `v*.*.*` tag push
// and on workflow_dispatch from any ref, then publishes package.json as-is. A
// pre-publish step must reconcile the ref with package.json so a mismatched tag
// (e.g. pushing `v0.6.0` while package.json says 0.7.0) or a workflow_dispatch
// from a branch cannot ship the wrong release. This test pins the presence of
// that step AND its actual exit behavior by executing the extracted script and
// asserting both the exit code and the specific error marker — so a deliberate
// rejection is never confused with a crash (e.g. a missing `node`, exit 127).

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

// The publish job's own text. The `verify` job (issue #301) precedes it and has
// its own `npm ci`/`npm test`, so ordering checks must be scoped to this job.
const publishJob = release.slice(release.indexOf('\n  publish:'));

const STEP_NAME = 'Verify tag matches package.json version';
// Distinct stderr markers emitted by each of the two rejections in the guard.
const REF_MARKER = 'Release must run from a version tag';
const MISMATCH_MARKER = 'does not match package.json version';

// Isolate the guard step: from its `- name:` line to the next top-level step
// (a line beginning with six spaces then `- `) or end of file.
function guardStepBlock(): string {
  const start = release.indexOf(`- name: ${STEP_NAME}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = release.slice(start + 1);
  const nextStep = rest.search(/\n {6}- /);
  return nextStep === -1 ? release.slice(start) : release.slice(start, start + 1 + nextStep);
}

// Pull the `run: |` block-scalar body out of the step and dedent it so it can
// be executed as a standalone shell script — the same bytes CI runs.
function guardRunScript(): string {
  const block = guardStepBlock();
  const runIdx = block.indexOf('run: |');
  expect(runIdx).toBeGreaterThanOrEqual(0);
  const lines = block.slice(runIdx).split('\n').slice(1); // drop the `run: |` line
  const body: string[] = [];
  let indent: number | null = null;
  for (const line of lines) {
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (indent === null) indent = lead;
    if (lead < indent) break; // dedent => end of block scalar
    body.push(line.slice(indent));
  }
  const script = body.join('\n').trimEnd();
  expect(script.length).toBeGreaterThan(0);
  return script;
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    try {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

type GuardResult = { code: number; stderr: string };

// Run the guard script with the given GitHub ref env. If `version` is given (or
// `writePackageJson` defaulted on), a package.json holding it is written into a
// throwaway cwd; pass `writePackageJson: false` to exercise the missing-file
// path. `cwd` overrides the throwaway dir (used for the real repo root).
function runGuard(opts: {
  ref?: string;
  refName?: string;
  version?: string;
  cwd?: string;
  writePackageJson?: boolean;
}): GuardResult {
  let cwd = opts.cwd;
  if (!cwd) {
    cwd = mkdtempSync(join(tmpdir(), 'release-guard-'));
    tempDirs.push(cwd);
    if (opts.writePackageJson !== false) {
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 'fixture', version: opts.version ?? '0.0.0' }),
      );
    }
  }
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  // Set or explicitly unset the two refs so ambient CI values never leak in.
  if (opts.ref === undefined) delete env.GITHUB_REF;
  else env.GITHUB_REF = opts.ref;
  if (opts.refName === undefined) delete env.GITHUB_REF_NAME;
  else env.GITHUB_REF_NAME = opts.refName;
  try {
    execFileSync('bash', ['-c', guardRunScript()], { cwd, env, stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    // A non-numeric status (e.g. bash missing) should fail loudly, not pass.
    expect(typeof e.status).toBe('number');
    return { code: e.status as number, stderr: String(e.stderr ?? '') };
  }
}

describe('release.yml tag/version guard — static wiring', () => {
  test('a named guard step exists before the publish step', () => {
    const guardAt = publishJob.indexOf(`- name: ${STEP_NAME}`);
    const publishAt = publishJob.indexOf('npm publish');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThan(guardAt);
  });

  test('the guard runs before the build/test/publish steps (fails fast)', () => {
    const guardAt = publishJob.indexOf(`- name: ${STEP_NAME}`);
    for (const later of ['npm ci', 'npm run build', 'npm test', 'npm publish']) {
      expect(publishJob.indexOf(later)).toBeGreaterThan(guardAt);
    }
  });

  test('the guard reconciles GITHUB_REF_NAME with the package.json version', () => {
    const block = guardStepBlock();
    // Reads the published version from package.json...
    expect(block).toMatch(/node -p "require\('\.\/package\.json'\)\.version"/);
    // ...prefixes it with `v` and compares against the pushed ref name.
    expect(block).toContain('v${pkg_version}');
    expect(block).toMatch(/GITHUB_REF_NAME/);
  });

  test('the guard rejects refs that are not tags (workflow_dispatch from a branch)', () => {
    expect(guardStepBlock()).toMatch(/refs\/tags\/\*/);
  });
});

describe('release.yml tag/version guard — executed behavior', () => {
  let script: string;
  beforeAll(() => {
    script = guardRunScript();
  });

  test('the extracted script rejects with exit 1 (not a crash code)', () => {
    // Sanity: the script body is runnable and its rejection path is a clean
    // `exit 1`, so the discriminating assertions below are meaningful.
    expect(script).toContain('exit 1');
  });

  test('a tag whose name equals v<version> publishes (exit 0)', () => {
    expect(runGuard({ ref: 'refs/tags/v1.2.3', refName: 'v1.2.3', version: '1.2.3' }).code).toBe(0);
  });

  test('a tag that does NOT match package.json is rejected by the version check', () => {
    const r = runGuard({ ref: 'refs/tags/v0.6.0', refName: 'v0.6.0', version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(MISMATCH_MARKER);
    // It passed the ref check (it IS a tag) and failed specifically on version.
    expect(r.stderr).not.toContain(REF_MARKER);
  });

  test('a tag name missing the `v` prefix is rejected by the version check', () => {
    // Pins the `v` prefixing: a bare `1.2.3` tag must not match version 1.2.3.
    const r = runGuard({ ref: 'refs/tags/1.2.3', refName: '1.2.3', version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(MISMATCH_MARKER);
  });

  test('a pre-release tag not matching the plain version is rejected', () => {
    const r = runGuard({ ref: 'refs/tags/v1.2.3-rc.1', refName: 'v1.2.3-rc.1', version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(MISMATCH_MARKER);
  });

  test('workflow_dispatch from a branch is rejected specifically by the ref guard', () => {
    // Discriminates the tag-only guard: assert the REF marker, so deleting the
    // `case refs/tags/*` block (leaving only the version check) fails this test.
    const r = runGuard({ ref: 'refs/heads/main', refName: 'main', version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REF_MARKER);
    expect(r.stderr).not.toContain(MISMATCH_MARKER);
  });

  test('a branch literally named like the version is still rejected by the ref guard', () => {
    // Name equality alone must not green-light a publish: the ref must be a tag.
    const r = runGuard({ ref: 'refs/heads/v1.2.3', refName: 'v1.2.3', version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REF_MARKER);
  });

  test('a missing or unset GITHUB_REF is rejected by the ref guard', () => {
    const r = runGuard({ ref: undefined, refName: undefined, version: '1.2.3' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(REF_MARKER);
  });

  test('a missing package.json aborts the publish (node -p fails under set -e)', () => {
    // A tag ref that passes the first guard but whose version can't be read
    // must abort rather than publish — never reach `npm publish`.
    const r = runGuard({ ref: 'refs/tags/v1.2.3', refName: 'v1.2.3', writePackageJson: false });
    expect(r.code).not.toBe(0);
  });
});

describe('release.yml guard — against the real package.json', () => {
  const realVersion: string = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).version;

  test('the repo is self-consistent: the correct tag for the current version passes', () => {
    expect(
      runGuard({ ref: `refs/tags/v${realVersion}`, refName: `v${realVersion}`, cwd: root }).code,
    ).toBe(0);
  });

  test('a deliberately wrong tag for the current version is rejected on version', () => {
    const r = runGuard({
      ref: 'refs/tags/v0.0.0-wrong',
      refName: 'v0.0.0-wrong',
      cwd: root,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(MISMATCH_MARKER);
  });
});
