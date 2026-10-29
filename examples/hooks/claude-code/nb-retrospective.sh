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

// Already did the retrospective for this session → allow the stop. (SubagentStop
// fires with the parent session id, so the first stop — a subagent's or the main
// agent's — claims the sentinel and later stops are let through: one nudge/session.)
if (fs.existsSync(sentinel)) process.exit(0);
try { fs.writeFileSync(sentinel, new Date().toISOString()); } catch {}

const reason = [
  `Before finishing, run the agent-notebook retrospective on the notebooks you opened this task (one pass, then stop):`,
  `  1. nb vote <shelf> <id> +1     — each lesson that actually helped`,
  `  2. nb vote <shelf> <id> -1     — each lesson shown to you that misled (vote takes no --reason)`,
  `  3. nb rm   <shelf> <id> --reason obsolete   — anything incorrect / no longer true`,
  `  4. nb merge/split <shelf> …    — only if a notebook is cluttered or full`,
  `  5. nb add  <shelf> "<=200-char lesson"   — at MOST one new, non-obvious lesson, to the notebook it fits (or none)`,
  `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome. Then stop.`,
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
NODE
exit 0
