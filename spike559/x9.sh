#!/bin/bash
# x9.sh <zipdir>: our own STORE zip, installed from the https-on-runner-IP marketplace; modes, sessions (node 24 / absent / old), bin/nb launcher. Windows sessions: x9-windows.ps1.
set -u
. "$(dirname "$0")/lib.sh"
ZD=$1; IP=$(ip_addr); PORT=18559; BASE="https://$IP:$PORT"; V=0.0.1-e2e.1
echo "=== $(uname -sm) claude $(claude --version) node $(node -v) date $(date -u +%FT%TZ)"
mkdir -p "$W/srv"; cp "$ZD"/plugin-0.0.1-e2e.*.zip "$W/srv/"; mkcert "$W" "$IP"; start_server "$W/srv" $PORT "$IP"
node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" "plugin-$V.zip" none "$BASE"
export NODE_EXTRA_CA_CERTS=$(native "$W/cert.pem")
echo "zip method as stored:"; python3 -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(set(i.compress_type for i in z.infolist()),len(z.infolist()),'entries')" "$ZD/plugin-$V.zip" 2>/dev/null || echo "(no python3)"
fresh_home x9; CL plugin install agent-notebook --marketplace "$BASE/marketplace.json" | tail -2; plugver
P=$(ls -d "$H"/.claude/plugins/cache/nbloop/agent-notebook/*); echo "plugin dir: $P"; ls -l "$P/bin" "$P/dist/cli.js" "$P/hooks" | sed "s#$H#<home>#"
echo "--- claude plugin validate (installed plugin dir, author set)"; claude plugin validate "$(native "$P")" 2>&1 | grep -v '^$' | cut -c1-260 | head -40
echo "--- claude plugin validate (marketplace)"; claude plugin validate "$(native "$W/srv/marketplace.json")" 2>&1 | grep -v '^$' | head
echo "--- claude plugin validate --profile directory"; claude plugin validate --profile directory "$(native "$P")" 2>&1 | grep -v '^$' | cut -c1-200 | head -12; echo "[exit ${PIPESTATUS[0]}]"
[ "${RUNNER_OS:-}" = Windows ] && { kill $SRV_PID 2>/dev/null; echo "installed for the Windows probes: $H"; exit 0; }
NB=$(dirname "$(command -v node)"); CB=$(dirname "$(command -v claude)"); OLD=${NODE_OLD_DIR:-}
sess() { # label PATH
  echo "== $1 (PATH=$2)"; mkdir -p "$H/p-$1"
  env PATH="$2" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../o.jsonl 2>/dev/null; "$2"/node '"$(native "$HERE/hookrep.mjs")"' ../o.jsonl > ../o.txt; grep -v "SPIKE559" ../o.txt; echo "index lines: $(grep -c "Your agent-notebook index" ../o.txt)  notice lines: $(grep -c "Node.js 18 or later is needed" ../o.txt)"' _ "$H/p-$1" "$NB"
}
sess node24 "$NB:/usr/bin:/bin:$CB"
sess nonode "/usr/bin:/bin:$CB"
[ -n "$OLD" ] && sess node16 "$OLD:/usr/bin:/bin:$CB"
echo "== bin/nb from an assistant-like shell, planted ./node"
mkdir -p "$H/proj"; printf '#!/bin/sh\necho PLANTED\n' > "$H/proj/node"; chmod +x "$H/proj/node"
for PP in ":$NB:/usr/bin:/bin" ".:$NB:/usr/bin:/bin" "bin:$NB:/usr/bin:/bin" "::$NB:/usr/bin:/bin"; do echo "PATH=$PP => $(env PATH="$PP" /bin/sh -c "cd '$H/proj' && '$P/bin/nb' --version" 2>&1 | head -1)"; done
echo "control (node run directly, same PATH): $(env PATH=":$NB:/usr/bin:/bin" /bin/sh -c "cd '$H/proj' && node '$P/dist/cli.js' --version" 2>&1 | head -1)"
kill $SRV_PID 2>/dev/null; exit 0
