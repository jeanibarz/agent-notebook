#!/usr/bin/env bash
# Claude Code Stop hook — nudge the RETROSPECTIVE once per session.
#
# Optional convenience for moment ④. The first time the lead agent stops with no
# subagent still running (the end of a turn, which is not always the end of the
# task: see "What the hooks do not cover" in docs/harness-setup.md), this fires
# ONCE per session and asks it to maintain the notebooks it used (vote the lessons
# that helped, prune what misled, add at most one new lesson) before stopping. It
# blocks the stop a single time by emitting a `block` decision whose reason the
# model reads; a per-session sentinel guarantees it never loops.
#
# Two kinds of stop never nudge and never use up the session's nudge (issue #520):
#   - a stop while the payload's `background_tasks` lists delegated work (a
#     subagent, workflow, teammate or cloud session) that is still `running` or
#     `pending`: the lead is waiting for it, not finished, so the nudge is kept
#     for a later stop;
#   - a `SubagentStop`: a subagent gets the retrospective from its brief. Blocking
#     its stop would make its answer to the nudge its last message, which is all
#     its caller receives, and would leave the lead without a nudge. Registering
#     this script under `SubagentStop` is therefore a no-op.
#
# It does not guess a notebook. The agent already knows which
# notebooks it opened this task (moment ②) and votes/adds to those.
#
# Reads the hook JSON on stdin (session_id, stop_hook_active, cwd,
# hook_event_name, agent_id, background_tasks). Requires `node`
# (already needed for `nb`) to parse/emit JSON safely. When `nb enabled` prints
# `off` (issue #514) in the project directory or in the payload's `cwd` (issue
# #517), it lets the stop through without a nudge.
set -uo pipefail

# A leading `~` / `~/` in NB_DIR is expanded here, exactly like the package does (issue #334):
# a value set where no shell expands it (settings.json env, systemd, cron) would otherwise
# create a literal `~` directory in the current project. `~user/...` is left alone.
case "${NB_DIR:-}" in
  "~") NB_DIR="$HOME" ;;
  "~/"*) NB_DIR="$HOME/${NB_DIR#\~/}" ;;
esac
NB_DIR_DEFAULT="${HOME}/.agent-notebook/notebooks"
SENTINEL_DIR="${NB_DIR:-$NB_DIR_DEFAULT}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true

INPUT="$(cat)"

node - "$INPUT" "$SENTINEL_DIR" <<'NODE'
const [, , input, sentinelDir] = process.argv;
let data = {};
try { data = JSON.parse(input || '{}'); } catch {}

// Never loop: if we already blocked once this stop cycle, let it finish.
if (data.stop_hook_active) process.exit(0);

// A subagent's stop never nudges (issue #520). `SubagentStop` fires with the
// parent's session_id, so before this check the first subagent to stop took the
// session's one nudge, and its answer to it replaced the report its caller
// receives. Internal agents (prompt suggestions, side questions) fire
// `SubagentStop` too. `agent_id` is only set when a hook fires inside a subagent,
// so it covers a payload that lacks `hook_event_name`. Both checks sit above the
// sentinel claim, so a skipped stop leaves the nudge for the lead.
if (data.hook_event_name === 'SubagentStop') process.exit(0);
if (typeof data.agent_id === 'string' && data.agent_id !== '') process.exit(0);

// A lead that stops while work it delegated is still in flight is waiting, not
// finished (issue #520): it will be woken when that work comes back. Let this
// stop through without claiming the sentinel, so the nudge goes to a later stop
// with nothing delegated in flight. Delegated work is a task whose `type` is one
// of the labels Claude Code (2.1.330) gives agent work: `subagent`, `workflow`,
// `teammate` and `cloud session`. It counts while its `status` is `running` or
// `pending` (started but not yet running). Shells, monitors and other
// background tasks do not count, and a missing or malformed `background_tasks`
// keeps the old behaviour.
const DELEGATED_TYPES = new Set(['subagent', 'workflow', 'teammate', 'cloud session']);
const IN_FLIGHT = new Set(['running', 'pending']);
if (
  Array.isArray(data.background_tasks) &&
  data.background_tasks.some(
    (t) => t !== null && typeof t === 'object' && DELEGATED_TYPES.has(t.type) && IN_FLIGHT.has(t.status),
  )
) {
  process.exit(0);
}

// session_id is untrusted input that becomes part of a file name: keep only
// [A-Za-z0-9._-] (so a `/` or `../` can never leave the sentinel directory or hit
// ENOENT and fail open into a nudge on every stop) and cap the length. UUID-shaped
// ids pass through unchanged, so the documented `.retro-<session_id>` names hold.
const session = String(data.session_id || 'nosession').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
const fs = require('node:fs');
const path = require('node:path');
const sentinel = path.join(sentinelDir, `.retro-${session}`);

// Claim this session's sentinel atomically: the first stop that gets here claims
// it and later stops are let through, one nudge per session. The `wx` flag
// makes create-if-absent a single OS-atomic step, so two hook processes racing
// on one session_id (the script registered in two settings files, or a
// subagent stop whose payload carries neither field checked above) can't both
// see the sentinel absent and both nudge: exactly one `writeFileSync` wins, the
// other throws EEXIST and allows its stop. Any OTHER write error fails open —
// fall through and still nudge rather than silently drop the retrospective.
try {
  fs.writeFileSync(sentinel, new Date().toISOString(), { flag: 'wx' });
} catch (err) {
  if (err && err.code === 'EEXIST') process.exit(0); // already claimed → allow stop
  // Non-EEXIST (e.g. permission): fail open — fall through and nudge anyway.
}

// Bound the sentinel pile (issue #165): having claimed this session's sentinel,
// sweep `.retro-*` files older than a TTL so they never accumulate without
// bound. Best-effort only — every step is wrapped so a failed readdir/stat/
// unlink can never block the stop. The TTL (days, default 7, overridable via
// NB_RETRO_TTL_DAYS) must stay well above any plausible session length so an
// in-flight session's sentinel is never reaped early; our own, just written, is
// fresh and so never a prune candidate.
try {
  const ttlDays = Number(process.env.NB_RETRO_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7) * 86400000;
  const cutoff = Date.now() - ttlMs;
  for (const name of fs.readdirSync(sentinelDir)) {
    if (!name.startsWith('.retro-')) continue;
    const p = path.join(sentinelDir, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
} catch {}

// Per-repository switch (issue #514): ask `nb enabled` on the stop that would
// nudge (later stops already exit on the sentinel claim above, so this costs at
// most two `nb` starts per session, not per turn). It runs after the prune, so
// old sentinels are still reaped in an off repository. Only the literal word
// `off` lets the stop through silently; a missing `nb`, an older `nb` without
// the subcommand, or any error keeps the nudge.
//
// Two directories are asked, and `off` from either one wins (issue #517): the
// project directory (`CLAUDE_PROJECT_DIR`, else this hook's working directory),
// which is where the session-start hook asked, and the `cwd` Claude Code passes
// in the hook payload, which is where the agent's own `nb list` ran. Either one
// may already have told the agent to skip the retrospective, so a nudge would
// contradict it. The second check is skipped when both are the same directory,
// and a payload `cwd` that no longer exists (a removed worktree) only fails that
// one check.
//
// The project directory is fixed for the session, so its `off` keeps the
// sentinel: later stops exit on the claim without asking again. The payload
// `cwd` changes from turn to turn, so an `off` from it alone releases the
// sentinel: a turn that ends in an off repository must not use up the one nudge
// of a session that later goes back to the on project. Such stops ask again,
// which costs `nb` starts only while the agent stops in an off directory.
{
  const { spawnSync } = require('node:child_process');
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const dirs = [projectDir];
  if (typeof data.cwd === 'string' && data.cwd !== '' && path.resolve(data.cwd) !== projectDir) {
    dirs.push(path.resolve(data.cwd));
  }
  for (const [i, cwd] of dirs.entries()) {
    const r = spawnSync(process.env.NB_BIN || 'nb', ['enabled'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!r.error && (r.stdout || '').trim() === 'off') {
      if (i > 0) {
        try { fs.unlinkSync(sentinel); } catch {}
      }
      process.exit(0);
    }
  }
}

const reason = [
  `Before finishing, run the agent-notebook retrospective on the notebooks you opened this task (one pass, then stop):`,
  `  1. nb vote <shelf> <id> +1     — each lesson that actually helped`,
  `  2. nb vote <shelf> <id> -1     — each lesson shown to you that misled (vote takes no --reason)`,
  `  3. nb rm   <shelf> <id> --reason obsolete   — anything incorrect / no longer true`,
  `  4. nb merge/split <shelf> …    — only if lessons repeat or a line holds two`,
  `  5. nb add  <shelf> "<=200-char lesson"   — at MOST one new, non-obvious lesson, to the notebook it fits (or none)`,
  `     Length: aim for ~150 chars / one clause, no preamble — over 200 is rejected, not truncated.`,
  `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome.`,
  `If you are a subagent, end by repeating your full final report after the retrospective: your last message is all your caller receives. Then stop.`,
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
NODE
exit 0
