#!/bin/bash
# x16b.sh: POSIX, variants U/Q/X/N in a spaced+non-ASCII root and (Q,X) in a plain root with planted sh/uname. Only our hook is in the plugin.
set -u
. "$(dirname "$0")/lib.sh"
echo "=== $(uname -sm) claude $(claude --version) date $(date -u +%FT%TZ)"
SP="$W/x16b/$(printf "J\xc3\xb6hn D'oe \$x Spike")"; PL="$W/x16bplain"
node "$(native "$HERE/gen16.mjs")" "$(native "$SP")"; node "$(native "$HERE/gen16.mjs")" "$(native "$PL")"
fresh_home x16bhome
NB=$(dirname "$(command -v node)"); CB=$(dirname "$(command -v claude)")
run() { # label plugindir PATH plant
  local d="$H/p-$RANDOM"; mkdir -p "$d"
  for f in $4; do printf '#!/bin/sh\necho PLANTED-%s\n' "$f" > "$d/$f"; chmod +x "$d/$f"; done
  echo "== $1 | PATH=$3 | planted: ${4:-none}"
  env PATH="$3" bash -c 'cd "$1"; claude -p hi --plugin-dir "$4" --output-format stream-json --verbose </dev/null >../o.jsonl 2>/dev/null; "$2"/node "$3" ../o.jsonl' _ "$d" "$NB" "$(native "$HERE/x16rep.mjs")" "$(native "$2")"
}
for v in U Q X N; do
  run "spaced root, variant $v, node present" "$SP/v-$v" "$NB:/usr/bin:/bin:$CB" ""
  run "spaced root, variant $v, node absent" "$SP/v-$v" "/usr/bin:/bin:$CB" ""
done
for v in Q X; do
  run "plain root, variant $v, node absent, empty PATH element" "$PL/v-$v" ":/usr/bin:/bin:$CB" "sh uname"
  run "plain root, variant $v, node absent, dot on PATH" "$PL/v-$v" ".:/usr/bin:/bin:$CB" "sh uname"
  run "plain root, variant $v, node present, empty PATH element" "$PL/v-$v" ":$NB:/usr/bin:/bin:$CB" "sh uname"
done
exit 0
