#!/usr/bin/env bash
# Claude Code SessionStart hook — SHOW the agent its notebook before it plans.
#
# Implements moment ① of the AGENTS.md contract: the notebook is *presented*,
# not searched (requirements.md DP-8). Its stdout is added to the session context.
#
# Role selection: $NB_ROLE if set, else the current project's directory name, so a
# per-repo notebook is picked up automatically. Adjust to taste.
set -uo pipefail

ROLE="${NB_ROLE:-$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")}"
NB="${NB_BIN:-nb}"   # point NB_BIN at the git-versioning wrapper if you use one

# Fail-open: if `nb` is missing, inject nothing rather than erroring the session.
command -v "$NB" >/dev/null 2>&1 || exit 0

echo "## Your agent-notebook (role: ${ROLE})"
echo "Bounded, voted lessons from past '${ROLE}' tasks — highest-scored first. Use them,"
echo "and run the end-of-task retrospective (vote / prune / add ≤1) before you finish."
echo
"$NB" show "$ROLE" 2>/dev/null || echo "(no notebook for '${ROLE}' yet — you'll start one at task end)"
echo
echo "Other notebooks you could open instead (nb list):"
"$NB" list 2>/dev/null | sed 's/^/  /' || true
exit 0
