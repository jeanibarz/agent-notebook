import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// scripts/check-main-rule.mjs stops a release while `main` does not require a pull request
// (question 1 of issue #559). Every case runs the real script against a local HTTP server
// that plays GitHub's "rules for a branch" endpoint, and asserts the text the script prints
// as well as the exit code: "the rule is missing" (exit 1) and "could not tell" (exit 2)
// must never be taken for each other, and neither for "ok".
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'check-main-rule.mjs');

type Reply = { status?: number; body?: string; headers?: Record<string, string> };
type Seen = { url: string; authorization: string | undefined; accept: string | undefined };

let server: Server;
let api = '';
let replies: Reply[] = [];
let seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? '', authorization: req.headers.authorization, accept: req.headers.accept });
    // The last reply repeats, so "always 500" is one entry.
    const reply = replies.length > 1 ? replies.shift()! : (replies[0] ?? { status: 500, body: 'no reply set' });
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body ?? '[]');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Run the script without blocking this process, which also serves its requests. */
function check(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const clean: NodeJS.ProcessEnv = { ...process.env, GITHUB_API_URL: api };
    delete clean.GH_TOKEN;
    delete clean.GITHUB_TOKEN;
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
const withReplies = (...r: Reply[]): void => {
  replies = r;
  seen = [];
};
const rule = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type, ruleset_source_type: 'Repository', ruleset_source: 'o/r', ruleset_id: 7, ...extra });
const FAST = ['--repo', 'o/r', '--retry-ms', '1'];

describe('check-main-rule.mjs lets a release through when main requires a pull request (NFR-REL-001)', () => {
  test('a pull_request rule among the active rules is ok, and the ruleset is named', async () => {
    withReplies({ body: JSON.stringify([rule('deletion'), rule('non_fast_forward'), rule('pull_request', { parameters: { required_approving_review_count: 0 } })]) });
    const r = await check(FAST);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('check-main-rule: ok (main of o/r requires a pull request, ruleset 7)\n');
    expect(r.code).toBe(0);
  });

  test('it asks for the rules of main of the repository given, once, with the token it was handed', async () => {
    withReplies({ body: JSON.stringify([rule('pull_request')]) });
    const r = await check(FAST, { GH_TOKEN: 'tok-gh', GITHUB_TOKEN: 'tok-actions' });
    expect(r.code).toBe(0);
    expect(seen).toEqual([{ url: '/repos/o/r/rules/branches/main?per_page=100', authorization: 'Bearer tok-gh', accept: 'application/vnd.github+json' }]);
  });

  test('GITHUB_TOKEN is used when GH_TOKEN is not set, and no token means no Authorization header', async () => {
    withReplies({ body: JSON.stringify([rule('pull_request')]) });
    expect((await check(FAST, { GITHUB_TOKEN: 'tok-actions' })).code).toBe(0);
    expect(seen[0].authorization).toBe('Bearer tok-actions');
    withReplies({ body: JSON.stringify([rule('pull_request')]) });
    expect((await check(FAST)).code).toBe(0);
    expect(seen[0].authorization).toBeUndefined();
  });

  test('--branch names another branch, and a slash in it stays a path separator', async () => {
    withReplies({ body: JSON.stringify([rule('pull_request')]) });
    const r = await check([...FAST, '--branch', 'release/1.x']);
    expect(r.stdout).toContain('ok (release/1.x of o/r requires a pull request');
    expect(seen[0].url).toBe('/repos/o/r/rules/branches/release/1.x?per_page=100');
  });

  test('a server error is tried again, and the answer that follows decides', async () => {
    withReplies({ status: 502, body: 'bad gateway' }, { status: 500, body: '{}' }, { body: JSON.stringify([rule('pull_request')]) });
    const r = await check(FAST);
    expect(r.stdout).toContain('check-main-rule: ok');
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(3);
  });
});

describe('check-main-rule.mjs refuses a release when no active rule requires a pull request (NFR-REL-001)', () => {
  const expectRefusal = (r: { code: number | null; stdout: string; stderr: string }, found: string): void => {
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`::error::no active rule requires a pull request on main of o/r (${found}).`);
    expect(r.stdout.match(/::error::/g)).toHaveLength(1);
    expect(r.stdout).not.toContain('check-main-rule: ok');
    expect(r.code).toBe(1);
  };

  test('no rule at all: the answer GitHub gives for an unprotected branch, or a ruleset that is disabled', async () => {
    withReplies({ body: '[]' });
    const r = await check(FAST);
    expectRefusal(r, 'no active rule at all');
    expect(r.stdout).toContain('docs/releasing.md');
    expect(seen, 'a clear answer is not asked for twice').toHaveLength(1);
  });

  test('rules that do not require a pull request are named, and do not count', async () => {
    withReplies({ body: JSON.stringify([rule('non_fast_forward'), rule('deletion'), rule('deletion')]) });
    expectRefusal(await check(FAST), 'only deletion, non_fast_forward');
  });

  test('a rule whose type only resembles pull_request does not count', async () => {
    withReplies({ body: JSON.stringify([rule('pull_request_review'), rule('PULL_REQUEST')]) });
    expectRefusal(await check(FAST), 'only PULL_REQUEST, pull_request_review');
  });
});

describe('check-main-rule.mjs: an answer it could not read is neither ok nor a refusal (NFR-REL-001)', () => {
  const expectCannotTell = (r: { code: number | null; stdout: string; stderr: string }, marker: string): void => {
    expect(r.stdout).toContain('::error::check-main-rule: ');
    expect(r.stdout).toContain(marker);
    expect(r.stdout).not.toContain('no active rule requires');
    expect(r.stdout).not.toContain('check-main-rule: ok');
    expect(r.code).toBe(2);
  };

  test('a server that keeps failing is asked four times, then the check stops with exit 2', async () => {
    withReplies({ status: 503, body: 'unavailable' });
    expectCannotTell(await check(FAST), 'could not read the rules of the branch');
    expect(seen).toHaveLength(4);
  });

  test('a 404 (no such repository, or one the token cannot see) is not tried again', async () => {
    withReplies({ status: 404, body: '{"message":"Not Found"}' });
    const r = await check(FAST);
    expectCannotTell(r, '(HTTP 404)');
    expect(seen).toHaveLength(1);
  });

  test('a rate limit is tried again: 429, and 403 with no request left', async () => {
    withReplies({ status: 429, body: '{}' }, { status: 403, body: '{}', headers: { 'x-ratelimit-remaining': '0' } }, { body: JSON.stringify([rule('pull_request')]) });
    const r = await check(FAST);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(3);
  });

  test('a 403 that is not a rate limit is not tried again', async () => {
    withReplies({ status: 403, body: '{"message":"Resource not accessible by integration"}', headers: { 'x-ratelimit-remaining': '4999' } });
    expectCannotTell(await check(FAST), '(HTTP 403)');
    expect(seen).toHaveLength(1);
  });

  test('a body that is not JSON, not a list, or a list of things with no type is exit 2', async () => {
    withReplies({ body: '<html>maintenance</html>' });
    expectCannotTell(await check(FAST), 'could not read the rules of the branch');
    withReplies({ body: '{"message":"ok"}' });
    expectCannotTell(await check(FAST), 'did not answer with a list of rules');
    withReplies({ body: JSON.stringify([rule('pull_request'), { ruleset_id: 7 }]) });
    expectCannotTell(await check(FAST), 'did not answer with a list of rules');
    withReplies({ body: '[null]' });
    expectCannotTell(await check(FAST), 'did not answer with a list of rules');
  });

  test('nothing listening at the address is exit 2', async () => {
    withReplies({ body: '[]' });
    expectCannotTell(await check(FAST, { GITHUB_API_URL: 'http://127.0.0.1:9' }), 'could not read the rules of the branch');
    expect(seen).toHaveLength(0);
  });

  test('a usage error is exit 2 and asks GitHub nothing', async () => {
    withReplies({ body: JSON.stringify([rule('pull_request')]) });
    expectCannotTell(await check([]), '--repo must be OWNER/NAME');
    expectCannotTell(await check(['--repo', 'o/r/extra']), '--repo must be OWNER/NAME');
    expectCannotTell(await check(['--repo', 'o/r', '--branch', 'rel*']), '--branch must be one branch name');
    expectCannotTell(await check(['--repo', 'o/r', '--retry-ms', 'soon']), '--retry-ms must be a whole number');
    expectCannotTell(await check(['--repo']), '--repo needs a value');
    expectCannotTell(await check(['--repo', 'o/r', '--force']), 'unknown argument "--force"');
    expect(seen).toHaveLength(0);
  });
});

describe('the release and CI run check-main-rule.mjs where it counts (NFR-REL-001)', () => {
  const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf-8');
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf-8');
  const COMMAND = 'run: node scripts/check-main-rule.mjs --repo "$GH_REPO"';
  /** The step that runs the check: from its `- name:` line to the next step. */
  const stepIn = (workflow: string): string => {
    const at = workflow.indexOf(COMMAND);
    expect(at, 'the check-main-rule step').toBeGreaterThanOrEqual(0);
    const start = workflow.lastIndexOf('\n      - ', at);
    const end = workflow.indexOf('\n      - ', at);
    return workflow.slice(start, end === -1 ? undefined : end);
  };
  const jobOf = (workflow: string, name: string): string => {
    const from = workflow.indexOf(`\n  ${name}:\n`);
    expect(from, `job ${name}`).toBeGreaterThanOrEqual(0);
    const next = workflow.slice(from + 1).search(/\n {2}[A-Za-z][\w-]*:[ \t]*\n/);
    return next === -1 ? workflow.slice(from) : workflow.slice(from, from + 1 + next);
  };

  test('release.yml runs it once, in build-plugin, before anything is installed or built', () => {
    expect(release.split(COMMAND)).toHaveLength(2);
    const job = jobOf(release, 'build-plugin');
    const at = job.indexOf(COMMAND);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(job.indexOf('run: npm ci --ignore-scripts'));
    expect(at).toBeLessThan(job.indexOf('run: npm run build'));
    expect(at).toBeGreaterThan(job.indexOf('actions/setup-node@'));
  });

  test('publish waits for build-plugin, so a refusal comes before the npm publish', () => {
    expect(jobOf(release, 'publish')).toMatch(/\n {4}needs: \[verify, build-plugin\]\n/);
    expect(jobOf(release, 'github-release')).toMatch(/\n {4}needs: \[publish, build-plugin\]\n/);
  });

  test('the step is unconditional, cannot be skipped over, and gets the token and the repository through env', () => {
    const step = stepIn(release);
    expect(step).not.toMatch(/\n\s+if:/);
    expect(step).not.toMatch(/continue-on-error/);
    expect(step).toMatch(/\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
    expect(step).toMatch(/\n {10}GH_REPO: \$\{\{ github\.repository \}\}\n/);
    expect(jobOf(release, 'build-plugin')).not.toMatch(/continue-on-error/);
  });

  test('no step of release.yml only warns about the rule any more', () => {
    expect(release).not.toContain('Warn when no ruleset');
    expect(release).not.toMatch(/rules\/branches\/main[^\n]*\|\| echo 0/);
  });

  test('ci.yml runs the same command on pull requests, with the job token, except in a fork', () => {
    const step = stepIn(ci);
    expect(step).toMatch(/\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
    expect(step).toMatch(/\n {10}GH_REPO: \$\{\{ github\.repository \}\}\n/);
    expect(step).toMatch(/\n {8}if: matrix\.os == 'ubuntu-latest' && matrix\.node-version == 22 && !github\.event\.repository\.fork\n/);
    expect(step).not.toMatch(/continue-on-error/);
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches:\n {6}- main\n {2}pull_request:\n/m);
  });
});
