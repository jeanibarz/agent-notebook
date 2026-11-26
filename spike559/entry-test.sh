#!/bin/bash
# entry-test.sh: run the candidate entry file under the current `node` (Q4).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); R=$(mktemp -d); D="$R/examples/hooks/claude-code"; mkdir -p "$D"
printf '{"name":"agent-notebook","version":"1.0.0","type":"module","engines":{"node":">=18"}}\n' > "$R/package.json"
git -C "$HERE/.." show origin/main:examples/hooks/claude-code/nb-claude-hook.mjs > "$D/nb-claude-hook.mjs" 2>/dev/null || cp "$HERE/../examples/hooks/claude-code/nb-claude-hook.mjs" "$D/"
cp "$HERE/nb-hook-entry.cjs" "$D/"
echo "=== node $(node -v) $(uname -sm)"
echo "--- adapter parsed directly:"; node "$D/nb-claude-hook.mjs" stop </dev/null >/dev/null 2>"$R/e1"; echo "exit $? stderr: $(head -c 160 "$R/e1" | tr '\n' ' ')"
for ev in session-start subagent-start stop print-settings; do
  echo "--- entry $ev:"; echo '{}' | node "$D/nb-hook-entry.cjs" $ev >"$R/o" 2>"$R/e"; c=$?; echo "exit $c"; echo "stdout: $(head -c 240 "$R/o" | tr '\n' ' ')"; echo "stderr: $(head -c 160 "$R/e" | tr '\n' ' ')"
done
MAJ=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJ" -ge 18 ]; then
cat > "$R/bench.cjs" <<'B'
var cp = require('child_process'), a = process.argv[2], b = process.argv[3];
function once(f) { var t = process.hrtime(); cp.spawnSync(process.execPath, [f, 'print-settings'], { input: '{}' }); var d = process.hrtime(t); return d[0] * 1e3 + d[1] / 1e6; }
function med(f) { var x = []; for (var i = 0; i < 3; i++) once(f); for (i = 0; i < 20; i++) x.push(once(f)); x.sort(function (p, q) { return p - q; }); return x[10]; }
var m1 = med(a), m2 = med(b), m3 = med(a), m4 = med(b);
console.log('median of 20 (ms): direct .mjs ' + m1.toFixed(1) + ' / ' + m3.toFixed(1) + '   via entry .cjs ' + m2.toFixed(1) + ' / ' + m4.toFixed(1) + '   (two interleaved rounds)');
B
node "$R/bench.cjs" "$D/nb-claude-hook.mjs" "$D/nb-hook-entry.cjs"
fi
