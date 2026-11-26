#!/bin/sh
# Claude Code SubagentStart hook for agent-notebook. Kept so settings.json files that
# name this script keep working: it runs nb-claude-hook.mjs, which must sit in
# the same folder (issue #538). Register that file directly if you can:
#   node "$(npm root -g)/agent-notebook/examples/hooks/claude-code/nb-claude-hook.mjs" print-settings
here=$(dirname "$0")
why=''
command -v node >/dev/null 2>&1 || why='node was not found'
[ -n "$why" ] || [ -f "$here/nb-claude-hook.mjs" ] || why="nb-claude-hook.mjs is missing beside $0"
[ -n "$why" ] || exec node "$here/nb-claude-hook.mjs" subagent-start "$@"
echo "nb-subagent-start.sh: $why" >&2
:
exit 0
