#!/usr/bin/env bash
# Claude Code Stop / SubagentStop hook — nudge the end-of-task RETROSPECTIVE once.
#
# Optional convenience for moment ④. When the agent tries to finish, this fires
# ONCE per session and asks it to maintain the notebooks it used (vote the lessons
# that helped, prune what misled, add at most one new lesson) before stopping. It
# blocks the stop a single time by emitting a `block` decision whose reason the
# model reads; a per-session sentinel guarantees it never loops.
#
# It does not guess a notebook. The agent already knows which
# notebooks it opened this task (moment ②) and votes/adds to those.
#
# Reads the hook JSON on stdin (session_id, stop_hook_active). Requires `node`
# (already needed for `nb`) to parse/emit JSON safely.
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

const session = data.session_id || 'nosession';
const fs = require('node:fs');
const path = require('node:path');
const sentinel = path.join(sentinelDir, `.retro-${session}`);

// Claim this session's sentinel atomically. (SubagentStop fires with the parent
// session id, so the first stop — a subagent's or the main agent's — claims the
// sentinel and later stops are let through: one nudge/session.) The `wx` flag
// makes create-if-absent a single OS-atomic step, so two hook processes racing
// on one parent session_id (parallel subagents stopping at once) can't both see
// the sentinel absent and both nudge: exactly one `writeFileSync` wins, the
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

const reason = [
  `Before finishing, run the agent-notebook retrospective on the notebooks you opened this task (one pass, then stop):`,
  `  1. nb vote <shelf> <id> +1     — each lesson that actually helped`,
  `  2. nb vote <shelf> <id> -1     — each lesson shown to you that misled (vote takes no --reason)`,
  `  3. nb rm   <shelf> <id> --reason obsolete   — anything incorrect / no longer true`,
  `  4. nb merge/split <shelf> …    — only if lessons repeat or a line holds two`,
  `  5. nb add  <shelf> "<=200-char lesson"   — at MOST one new, non-obvious lesson, to the notebook it fits (or none)`,
  `     Length: aim for ~150 chars / one clause, no preamble — over 200 is rejected, not truncated.`,
  `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome. Then stop.`,
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
NODE
exit 0
