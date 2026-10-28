#!/usr/bin/env bash
# Claude Code SessionStart hook — inject the NOTEBOOK INDEX so the agent sees it
# without spending a call. Optional convenience: the AGENTS.md/CLAUDE.md contract
# already tells the agent to run `nb list` itself; this just front-loads the
# result. Its stdout is added to the session context.
#
# Deliberately generic: it injects the INDEX of every notebook (each with its
# "open me when…" description), NOT a guessed per-project "role" notebook — so it
# works the same in every repo with no role logic to maintain. The agent reads the
# descriptions and opens whatever fits its task (that's moment ① → ②).
set -uo pipefail

NB="${NB_BIN:-nb}"   # point NB_BIN at the git-versioning wrapper if you use one

# Fail-open: if `nb` is missing, inject nothing rather than erroring the session.
command -v "$NB" >/dev/null 2>&1 || exit 0

echo "## Your agent-notebook index"
echo "These are your saved notebooks (bounded, voted, one-line lessons per role)."
echo "Open the one(s) whose description fits this task with \`nb show <role>\`, use"
echo "their lessons, and at the end run the retrospective (vote / prune / add ≤1)."
echo
"$NB" list 2>/dev/null | sed 's/^/  /' || echo "  (no notebooks yet — you'll start one at task end)"
exit 0
