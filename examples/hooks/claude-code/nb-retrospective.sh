#!/usr/bin/env bash
# Claude Code Stop / SubagentStop hook — run the end-of-task RETROSPECTIVE once.
#
# Implements moment ④ of the AGENTS.md contract. When the agent tries to finish,
# this fires ONCE per session and asks it to maintain the notebook (vote the
# lessons that helped, prune what misled, add at most one new lesson) before
# stopping. It blocks the stop a single time by emitting a `block` decision whose
# reason the model reads; a per-session sentinel guarantees it never loops.
#
# Reads the hook JSON on stdin (session_id, stop_hook_active). Requires `node`
# (already needed for `nb`) to parse/emit JSON safely.
set -uo pipefail

ROLE="${NB_ROLE:-$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")}"
NB_DIR_DEFAULT="${HOME}/.agent-notebook/notebooks"
SENTINEL_DIR="${NB_DIR:-$NB_DIR_DEFAULT}"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true

INPUT="$(cat)"

node - "$INPUT" "$SENTINEL_DIR" "$ROLE" <<'NODE'
const [, , input, sentinelDir, role] = process.argv;
let data = {};
try { data = JSON.parse(input || '{}'); } catch {}

// Never loop: if we already blocked once this stop cycle, let it finish.
if (data.stop_hook_active) process.exit(0);

const session = data.session_id || 'nosession';
const fs = require('node:fs');
const path = require('node:path');
const sentinel = path.join(sentinelDir, `.retro-${session}`);

// Already did the retrospective for this session → allow the stop.
if (fs.existsSync(sentinel)) process.exit(0);
try { fs.writeFileSync(sentinel, new Date().toISOString()); } catch {}

const reason = [
  `Before finishing, run the agent-notebook retrospective for role "${role}" (one pass, then stop):`,
  `  1. nb vote ${role} <id> +1        — the lessons that actually helped this task`,
  `  2. nb vote ${role} <id> -1 --reason wrong   — any that were shown to you but misled`,
  `  3. nb rm   ${role} <id> --reason obsolete    — anything that proved incorrect / no longer applies`,
  `  4. nb merge/split ${role} …        — only if the notebook is cluttered or full`,
  `  5. nb add  ${role} "<=200-char lesson"   — at MOST one genuinely new, non-obvious lesson (or none)`,
  `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome. Then stop.`,
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }));
NODE
exit 0
