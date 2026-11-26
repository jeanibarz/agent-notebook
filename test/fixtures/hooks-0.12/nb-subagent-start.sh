#!/usr/bin/env bash
# Claude Code SubagentStart hook — give a SUBAGENT the notebook index.
#
# Optional. `SessionStart` runs for the main session only, so a subagent never
# sees the index that nb-session-start.sh injects there. This hook runs that
# same script when a subagent starts and hands its output to the subagent.
#
# Why a wrapper and not nb-session-start.sh registered twice: for SubagentStart,
# plain stdout is NOT added to the subagent's context. Only a JSON object with
# `hookSpecificOutput.additionalContext` is (checked on Claude Code 2.1.328).
# Registering nb-session-start.sh directly under SubagentStart runs it and
# injects nothing, with no error.
#
# Cost: the whole index goes into EVERY subagent's context. With many shelves
# and many subagents per task, prefer one sentence of contract in each brief
# (docs/harness-setup.md#subagents) and leave this hook out.
#
# Expects nb-session-start.sh next to this file. Everything that script reads
# (NB_BIN, NB_DIR, NB_PROJECT_SLUG, the per-repository off switch) applies here
# unchanged. Requires `node` (already needed for `nb`) to emit the JSON safely.
# Fail-open: no script, no `nb`, or no output means nothing is injected.
set -uo pipefail

cat >/dev/null   # the hook payload on stdin is not needed

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/nb-session-start.sh" ] || exit 0

index="$(bash "$HERE/nb-session-start.sh" </dev/null 2>/dev/null)" || exit 0
[ -n "$index" ] || exit 0

node -e '
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: process.argv[1] },
}));
' "$index"
