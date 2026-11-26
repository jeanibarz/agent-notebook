#!/bin/bash
# managed.sh <zipdir>: Linux only. /etc/claude-code/managed-settings.json allowlists and managed hooks (Q5).
set -u
. "$(dirname "$0")/lib.sh"
ZD=$1; IP=$(ip_addr); PORT=18559; BASE="https://$IP:$PORT"
echo "=== $(uname -sm) claude $(claude --version) node $(node -v) ip=$IP date $(date -u +%FT%TZ)"
mkdir -p "$W/srv"; cp "$ZD"/plugin-v1.zip "$W/srv/"; mkcert "$W" "$IP"; start_server "$W/srv" $PORT "$IP"
node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" plugin-v1.zip 1.0.0 "$BASE"
sed 's/"nbloop"/"nbother"/' "$W/srv/marketplace.json" > "$W/srv/other.json"
export NODE_EXTRA_CA_CERTS="$W/cert.pem"
pol() { printf '%s' "$1" | sudo tee /etc/claude-code/managed-settings.json >/dev/null; echo "POLICY: $1"; }
sudo mkdir -p /etc/claude-code
add() { fresh_home "m-$1"; echo "[$1] marketplace add $2"; ( cd "$H/proj"; tt claude plugin marketplace add "$2" 2>&1 | tail -2 | tr '\n' ' ' ); echo; }
echo "################ P1: exact URL entry"
pol '{"strictKnownMarketplaces":[{"source":"url","url":"'"$BASE"'/marketplace.json"}]}'
add exact "$BASE/marketplace.json"
CL plugin install agent-notebook@nbloop | tail -2
add other "$BASE/other.json"
add query "$BASE/marketplace.json?x=1"
add httpvariant "http://$IP:$PORT/marketplace.json"
echo "################ P1b: empty list (blocks everything) and control without any policy"
pol '{"strictKnownMarketplaces":[]}'; add emptylist "$BASE/marketplace.json"
sudo rm -f /etc/claude-code/managed-settings.json; add nopolicy "$BASE/other.json"
echo "################ P2: hostPattern"
IPRE=$(echo "$IP" | sed 's/\./\\\\./g')
pol '{"strictKnownMarketplaces":[{"source":"hostPattern","hostPattern":"^'"$IPRE"'$"}]}'
add host-a "$BASE/marketplace.json"; add host-b "$BASE/other.json"
pol '{"strictKnownMarketplaces":[{"source":"hostPattern","hostPattern":"^nothing\\\\.example$"}]}'; add host-nomatch "$BASE/marketplace.json"
echo "################ P3: pathPattern (documented for file/directory sources) against a URL source"
pol '{"strictKnownMarketplaces":[{"source":"pathPattern","pathPattern":".*"}]}'; add path-dotstar "$BASE/marketplace.json"
pol '{"strictKnownMarketplaces":[{"source":"pathPattern","pathPattern":"^/marketplace\\\\.json$"}]}'; add path-narrow "$BASE/marketplace.json"
sudo rm -f /etc/claude-code/managed-settings.json
echo "################ P4: managed hooks with allowManagedHooksOnly"
fresh_home m-hooks; CL plugin install agent-notebook --marketplace "$BASE/marketplace.json" | tail -1; plugver
IP_=$(claude plugin list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const p of l)if(p.id.startsWith("agent-notebook"))console.log(p.installPath)')
echo "install path: $IP_"
for flag in false true; do
  H1='{"type":"command","command":"echo MANAGED-CONTROL root=[$CLAUDE_PLUGIN_ROOT]"}'
  H2='{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/examples/hooks/claude-code/nb-claude-hook.mjs","session-start"]}'
  H3='{"type":"command","command":"node","args":["'"$IP_"'/examples/hooks/claude-code/nb-claude-hook.mjs","session-start"]}'
  pol '{"allowManagedHooksOnly":'"$flag"',"hooks":{"SessionStart":[{"hooks":['"$H1,$H2,$H3"']}]}}'
  echo "--- allowManagedHooksOnly=$flag"; session "$H/proj"
done
sudo rm -f /etc/claude-code/managed-settings.json
echo "################ P5: path is version-stamped: update to v2 moves it"
cp "$ZD"/plugin-v2.zip "$W/srv/"; node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" plugin-v2.zip 2.0.0 "$BASE"
claude plugin marketplace update nbloop >/dev/null 2>&1; claude plugin update agent-notebook@nbloop 2>&1 | tail -1; plugver
kill $SRV_PID 2>/dev/null; exit 0
