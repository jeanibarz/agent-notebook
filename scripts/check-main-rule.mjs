// Refuse a release while the default branch does not require a pull request.
//
//   node scripts/check-main-rule.mjs --repo OWNER/NAME [--branch main] [--retry-ms 5000]
//
// The release workflow's last job holds `contents: write`. With no rule on `main`, a
// compromised step of that job could push to `main`: a marketplace file that names another
// zip, or code that the next release publishes to npm (docs/releasing.md). So the release
// stops here, in `build-plugin`, before anything is published. CI runs the same command on
// every pull request, so the check is proven against the real API long before a tag is
// pushed, and a `main` that lost its rule turns CI red at once.
//
// It asks GitHub for the rules that are active on the branch
// (GET /repos/{repo}/rules/branches/{branch}) and looks for one of type `pull_request`.
// GitHub lists only rules of rulesets that are enforced: a ruleset that is disabled or in
// "evaluate" mode gives none. Two things this cannot see with a job token: who may bypass
// the ruleset, and classic branch protection. Keep the bypass list empty by hand.
//
// Exit 0 and "check-main-rule: ok" when the rule is there. Exit 1 and one `::error::` line
// when it is not: the refusal. Exit 2 when the answer could not be read (a usage error, the
// network, an answer of the wrong shape), so "could not tell" is never mistaken for either
// of the others; the release stops in that case too.
//
// The token comes from GH_TOKEN or GITHUB_TOKEN and the API address from GITHUB_API_URL
// (GitHub Actions sets it). It imports nothing and ships in neither the npm package nor the zip.

const USAGE = 'usage: node scripts/check-main-rule.mjs --repo OWNER/NAME [--branch main] [--retry-ms 5000]';
const ATTEMPTS = 4;

/** Could not tell: exit 2, with an annotation so the run's summary shows why it stopped. */
function cannotTell(message) {
  process.stdout.write(`::error::check-main-rule: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { repo: '', branch: 'main', retryMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--repo' && flag !== '--branch' && flag !== '--retry-ms') cannotTell(`unknown argument ${JSON.stringify(flag)}. ${USAGE}`);
    if (value === undefined) cannotTell(`${flag} needs a value. ${USAGE}`);
    if (flag === '--repo') opts.repo = value;
    else if (flag === '--branch') opts.branch = value;
    else opts.retryMs = /^\d+$/.test(value) ? Number(value) : NaN;
    i++;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) cannotTell(`--repo must be OWNER/NAME, got ${JSON.stringify(opts.repo)}. ${USAGE}`);
  // A wildcard would not be an error for GitHub: it answers "no rule", which would read as a refusal.
  if (!/^[A-Za-z0-9_./-]+$/.test(opts.branch)) cannotTell(`--branch must be one branch name, got ${JSON.stringify(opts.branch)}. ${USAGE}`);
  if (!Number.isFinite(opts.retryMs)) cannotTell(`--retry-ms must be a whole number of milliseconds. ${USAGE}`);
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The parsed answer, after up to ATTEMPTS tries. Only a 200 with a JSON body is an answer. */
async function readRules(url, headers, retryMs) {
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (res.status === 200) return JSON.parse(await res.text());
      last = `HTTP ${res.status}`;
      // 404 (no such repository, or one this token cannot see), 401 and 403 without a
      // rate limit do not change on a retry. GitHub marks a rate limit on a 403 with no
      // request left (the primary limit) or with a retry-after header (the secondary one).
      const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
      if (res.status < 500 && !limited) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (attempt < ATTEMPTS) await sleep(retryMs);
  }
  return cannotTell(`could not read the rules of the branch from ${url} (${last}). Nothing says the branch is unprotected, but the release stops until this can be read.`);
}

const opts = parseArgs(process.argv.slice(2));
const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const url = `${api}/repos/${opts.repo}/rules/branches/${opts.branch.split('/').map(encodeURIComponent).join('/')}?per_page=100`;
const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-notebook-check-main-rule' };
if (token) headers.authorization = `Bearer ${token}`;

const rules = await readRules(url, headers, opts.retryMs);
if (!Array.isArray(rules) || rules.some((r) => r === null || typeof r !== 'object' || typeof r.type !== 'string')) {
  cannotTell(`${url} did not answer with a list of rules that each have a type.`);
}

const rule = rules.find((r) => r.type === 'pull_request');
if (!rule) {
  const found = rules.length === 0 ? 'no active rule at all' : `only ${[...new Set(rules.map((r) => r.type))].sort().join(', ')}`;
  process.stdout.write(
    `::error::no active rule requires a pull request on ${opts.branch} of ${opts.repo} (${found}). ` +
      'The release job holds contents: write, so without that rule a compromised step could push to the branch, ' +
      'and that push would reach every plugin user and the next npm release. ' +
      'Add a ruleset on the branch that requires a pull request, with an empty bypass list, then re-run the failed jobs (docs/releasing.md).\n',
  );
  process.exit(1);
}
process.stdout.write(`check-main-rule: ok (${opts.branch} of ${opts.repo} requires a pull request${rule.ruleset_id === undefined ? '' : `, ruleset ${rule.ruleset_id}`})\n`);
