#!/bin/sh
# Spike #559 only (never merged): assemble a built copy of the plugin from the
# real adapter and the real compiled CLI. Usage: sh spike559/build-plugin.sh <version>
set -eu
V=${1:?version}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
P="$ROOT/plugins/agent-notebook"
rm -rf "$P"
mkdir -p "$P/.claude-plugin" "$P/hooks" "$P/bin" "$P/skills/agent-notebook" "$P/examples/hooks/claude-code"
cp -R "$ROOT/dist" "$P/dist"
find "$P/dist" -name '*.d.ts' -delete
cp "$ROOT/examples/hooks/claude-code/nb-claude-hook.mjs" "$P/examples/hooks/claude-code/"
# The adapter finds the CLI through ../../../package.json named agent-notebook.
node -e 'const p=require(process.argv[1]);process.stdout.write(JSON.stringify({name:p.name,version:process.argv[2],type:p.type,engines:p.engines,bin:p.bin,license:p.license},null,2)+"\n")' "$ROOT/package.json" "$V" > "$P/package.json"
cat > "$P/.claude-plugin/plugin.json" <<J
{
  "name": "agent-notebook",
  "version": "$V",
  "description": "Spike #559: built copy of agent-notebook (adapter, skill, compiled nb)."
}
J
cp "$ROOT/spike559/hooks.json" "$P/hooks/hooks.json"
cp "$ROOT/spike559/SKILL.md" "$P/skills/agent-notebook/SKILL.md"
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/../dist/cli.js" "$@"' > "$P/bin/nb"
chmod +x "$P/bin/nb" "$P/dist/cli.js"
printf '%s\r\n' '@echo off' 'node "%~dp0..\dist\cli.js" %*' > "$P/bin/nb.cmd"
echo "$V" > "$P/SPIKE_VERSION"
