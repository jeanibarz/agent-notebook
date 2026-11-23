#!/usr/bin/env bash
# Claude Code Stop hook — ask for the end-of-task IDEA, once per session.
#
# Optional companion to examples/ideas/nb-ideas.mjs (the `nb-ideas` command). The
# first time the lead agent stops with no subagent still running, this blocks the
# stop ONCE and shows the agent the end-of-task prompt printed by
# `nb-ideas prompt`: "did this task show that something should be deleted, merged,
# shortened, split, corrected or made to fail loudly? Most tasks have nothing to
# record, and then you just stop." A per-session sentinel guarantees it never loops.
#
# It is standalone and modelled on nb-retrospective.sh; the two can be registered
# together under Stop. When both block the same stop, the agent receives both
# reasons at that stop. Unlike the retrospective, this hook does NOT exit on
# `stop_hook_active`: the retrospective may have blocked the previous stop, and
# this hook's own sentinel is what prevents a loop.
#
# Stops that never ask, and never use up the session's one ask:
#   - a `SubagentStop`, or any payload with a non-empty `agent_id` (a subagent);
#   - a stop while the payload's `background_tasks` lists delegated work (a
#     subagent, workflow, teammate or cloud session) still `running` or `pending`;
#   - a repository where `nb enabled` prints `off` (checked in the project
#     directory and in the payload's `cwd`, with NB_BIN).
# If `nb-ideas prompt` fails or prints nothing (not installed, not in a git
# repository), the stop goes through and the sentinel is released.
#
# Reads the hook JSON on stdin (session_id, cwd, hook_event_name, agent_id,
# background_tasks). Requires `node`. Sentinels `.ideas-prompt-<session_id>` live
# in NB_IDEAS_DIR (default ~/.agent-notebook/ideas) and older ones than
# NB_RETRO_TTL_DAYS (default 7) are pruned. NB_IDEAS_BIN names the nb-ideas
# command (default `nb-ideas`).
set -uo pipefail

# A leading `~` / `~/` in NB_IDEAS_DIR is expanded here, like the package does for NB_DIR.
case "${NB_IDEAS_DIR:-}" in
  "~") NB_IDEAS_DIR="$HOME" ;;
  "~/"*) NB_IDEAS_DIR="$HOME/${NB_IDEAS_DIR#\~/}" ;;
esac
SENTINEL_DIR="${NB_IDEAS_DIR:-${HOME}/.agent-notebook/ideas}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true

INPUT="$(cat)"

node - "$INPUT" "$SENTINEL_DIR" <<'NODE'
const [, , input, sentinelDir] = process.argv;
let data = {};
try { data = JSON.parse(input || '{}'); } catch {}

// Subagents never get the ask: their last message is all their caller receives.
if (data.hook_event_name === 'SubagentStop') process.exit(0);
if (typeof data.agent_id === 'string' && data.agent_id !== '') process.exit(0);

// A lead that stops while delegated work is in flight is waiting, not finished.
// Let this stop through WITHOUT claiming the sentinel, so a later stop asks.
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

// session_id becomes part of a file name: keep [A-Za-z0-9._-], cap the length.
// (nb-ideas cleans NB_SESSION the same way, so ids match across both.)
// Without a session id there is no per-session sentinel and no task id to hand
// to nb-ideas, so do not ask at all.
if (typeof data.session_id !== 'string' || data.session_id === '') process.exit(0);
const session = data.session_id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sentinel = path.join(sentinelDir, `.ideas-prompt-${session}`);
const release = () => { try { fs.unlinkSync(sentinel); } catch {} };

// Claim the sentinel atomically (`wx`): the first stop wins, later ones are let
// through. This hook does not exit on `stop_hook_active` (the lessons
// retrospective may have blocked the previous stop), so the sentinel is its only
// loop guard: if it cannot be written for any reason, let the stop through
// rather than risk asking on every stop.
try {
  fs.writeFileSync(sentinel, new Date().toISOString(), { flag: 'wx' });
} catch {
  process.exit(0);
}

// Best-effort prune of sentinels older than the TTL.
try {
  const ttlDays = Number(process.env.NB_RETRO_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7) * 86400000;
  const cutoff = Date.now() - ttlMs;
  for (const name of fs.readdirSync(sentinelDir)) {
    if (!name.startsWith('.ideas-prompt-')) continue;
    const p = path.join(sentinelDir, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
} catch {}

// Per-repository switch, exactly as nb-retrospective.sh: `off` from the project
// directory keeps the sentinel; `off` from the payload cwd alone releases it.
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
    if (i > 0) release();
    process.exit(0);
  }
}

// The text comes from `nb-ideas prompt`, run where the agent worked so it names
// the right project. Any failure lets the stop through and releases the sentinel.
const cwd = typeof data.cwd === 'string' && data.cwd !== '' && fs.existsSync(data.cwd) ? data.cwd : projectDir;
const r = spawnSync(process.env.NB_IDEAS_BIN || 'nb-ideas', ['prompt', '--session', session], {
  cwd,
  encoding: 'utf-8',
  timeout: 15000,
  stdio: ['ignore', 'pipe', 'ignore'],
});
const reason = (r.stdout || '').trim();
if (r.error || r.status !== 0 || reason === '') {
  release();
  process.exit(0);
}

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
NODE
exit 0
