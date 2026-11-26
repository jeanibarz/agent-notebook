#!/bin/bash
# x16.sh <distdir-artifact>: build our STORE zip from the dist artifact, print its sha256, install by the archive route into a spaced non-ASCII home, POSIX sessions.
set -u
. "$(dirname "$0")/lib.sh"
DD=$1; IP=$(ip_addr); PORT=18559; BASE="https://$IP:$PORT"; V=0.0.1-e2e.1
echo "=== $(uname -sm) claude $(claude --version) node $(node -v) date $(date -u +%FT%TZ)"
rm -rf "$HERE/../dist"; cp -R "$DD" "$HERE/../dist"
node "$(native "$HERE/build-v1.mjs")" "$(native "$W/srv")" $V
echo "(e) sha256 of the zip built on this runner:"; node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$(native "$W/srv/plugin-$V.zip")"
git -C "$HERE/.." ls-files --eol LICENSE examples/hooks/claude-code/nb-claude-hook.mjs spike559/SKILL.md | sed 's/^/  eol: /'
mkcert "$W" "$IP"; start_server "$W/srv" $PORT "$IP"
node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" "plugin-$V.zip" none "$BASE"
export NODE_EXTRA_CA_CERTS=$(native "$W/cert.pem")
if [ "${RUNNER_OS:-}" = Windows ]; then NAME=$(printf 'Ana Mar\xc3\xada'); else NAME=$(printf "J\xc3\xb6hn D'oe \$x Spike"); fi
fresh_home "x16/$NAME"; echo "home: $HOME"
CL plugin install agent-notebook --marketplace "$BASE/marketplace.json" | tail -2; plugver
P=$(ls -d "$H"/.claude/plugins/cache/nbloop/agent-notebook/*); echo "plugin root: $P"; ls -l "$P/hooks/nb-node-check.cmd"
echo "installed file equals the built bytes? $(cmp <(unzip -p "$W/srv/plugin-$V.zip" hooks/nb-node-check.cmd) "$P/hooks/nb-node-check.cmd" && echo yes)"
[ "${RUNNER_OS:-}" = Windows ] && { kill $SRV_PID 2>/dev/null; echo "installed for the Windows probes: $H"; echo "$H" > "$W/x16home.txt"; exit 0; }
NB=$(dirname "$(command -v node)"); CB=$(dirname "$(command -v claude)")
sess() { # label PATH plantfiles
  local d="$H/p-$1"; mkdir -p "$d"
  for f in $3; do printf '#!/bin/sh\necho PLANTED-%s\n' "$f" > "$d/$f"; chmod +x "$d/$f"; done
  echo "== $1 (PATH=$2) planted: ${3:-none}"
  env PATH="$2" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../o.jsonl 2>/dev/null; "$2"/node "$3" ../o.jsonl' _ "$d" "$NB" "$(native "$HERE/x16rep.mjs")"
}
sess present "$NB:/usr/bin:/bin:$CB" ""
sess absent "/usr/bin:/bin:$CB" ""
sess absent-planted-empty-elem ":/usr/bin:/bin:$CB" "sh uname"
sess present-planted-empty-elem ":$NB:/usr/bin:/bin:$CB" "sh uname node"
sess absent-planted-dot ".:/usr/bin:/bin:$CB" "sh uname"
kill $SRV_PID 2>/dev/null; exit 0
