#!/bin/bash
# loop.sh <zipdir>: install, update, rollback, uninstall from a loopback marketplace (Q2, Q3). Then the POSIX planted-node probes (Q1).
set -u
. "$(dirname "$0")/lib.sh"
ZD=$1; IP=$(ip_addr); PORT=18559; BASE="https://$IP:$PORT"
echo "=== $(uname -sm) claude $(claude --version) node $(node -v) ip=$IP date $(date -u +%FT%TZ)"
mkdir -p "$W/srv"; cp "$ZD"/plugin-v*.zip "$W/srv/"; mkcert "$W" "$IP"; start_server "$W/srv" $PORT "$IP"
setmkt() { node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" "$1" "$2" "$BASE"; }
CA=$(native "$W/cert.pem")
echo; echo "################ Q2a: archive URL over plain http loopback (expected refusal)"
fresh_home q2a; setmkt plugin-v1.zip 1.0.0
sed "s#$BASE/#http://127.0.0.1:18558/#" "$W/srv/marketplace.json" > "$W/srv/loop.json"
node "$(native "$HERE/serve.mjs")" "$(native "$W/srv")" 18558 127.0.0.1 > "$W/server-http.log" 2>&1 &
HTTP_PID=$!; sleep 2; cat "$W/srv/loop.json" | head -4 | cut -c1-200
CL plugin install agent-notebook --marketplace "http://127.0.0.1:18558/loop.json"; kill $HTTP_PID 2>/dev/null
echo; echo "################ Q2b: https on the runner's own non-loopback IP, no CA setting (expected TLS refusal)"
fresh_home q2b; setmkt plugin-v1.zip 1.0.0
CL plugin install agent-notebook --marketplace "$BASE/marketplace.json"
echo; echo "################ Q2c: NODE_EXTRA_CA_CERTS, then install -> update -> rollback -> uninstall"
fresh_home q2c; export NODE_EXTRA_CA_CERTS="$CA"
CL plugin install agent-notebook --marketplace "$BASE/marketplace.json"
plugver
setmkt plugin-v2.zip 2.0.0
CL plugin update agent-notebook@nbloop
echo "--- after marketplace update:"; CL plugin marketplace update nbloop; CL plugin update agent-notebook@nbloop; plugver
setmkt plugin-v1.zip 1.0.0
echo "--- rollback to the older zip:"; CL plugin marketplace update nbloop; CL plugin update agent-notebook@nbloop; plugver
CL plugin uninstall agent-notebook@nbloop
echo "settings.json after uninstall:"; cat "$H/.claude/settings.json"; echo; echo "installed_plugins.json:"; cat "$H/.claude/plugins/installed_plugins.json"; echo
echo "cache dirs left:"; find "$H/.claude/plugins/cache" -maxdepth 3 -type d | sed "s#$H#<home>#"
echo "--- session after reinstall: hook responses from the installed archive plugin"
setmkt plugin-v1.zip 1.0.0; CL plugin install agent-notebook@nbloop; session "$H/proj"
echo; echo "################ Q2d: SSL_CERT_FILE instead (NODE_EXTRA_CA_CERTS unset)"
unset NODE_EXTRA_CA_CERTS; fresh_home q2d; export SSL_CERT_FILE="$CA"
CL plugin install agent-notebook --marketplace "$BASE/marketplace.json"; unset SSL_CERT_FILE
echo; echo "################ Q3: which version field drives update (plugin.json vs marketplace entry)"
export NODE_EXTRA_CA_CERTS="$CA"
cp "$W/srv/plugin-v1.zip" "$W/srv/plugin-p1.zip"; cp "$W/srv/plugin-v2.zip" "$W/srv/plugin-p2.zip"
q3() { # q3 <label> <zip1> <ev1> <zip2> <ev2>
  fresh_home "q3"; echo "## $1: install ($2 entry=$3)"; setmkt "$2" "$3"; CL plugin install agent-notebook --marketplace "$BASE/marketplace.json" | tail -2; plugver
  setmkt "$4" "$5"; claude plugin marketplace update nbloop >/dev/null 2>&1; echo "   update ($4 entry=$5):"; CL plugin update agent-notebook@nbloop | tail -2; plugver
}
q3 "entry says 2, plugin.json says 1" plugin-v1.zip 2.0.0 plugin-v2.zip 2.0.0
q3 "entry missing" plugin-v2.zip none plugin-v1.zip none
q3 "same entry version, different zip content" plugin-v1.zip 1.0.0 plugin-p2.zip 1.0.0
q3 "entry 3 (plugin.json 1) then entry 4 (plugin.json 1)" plugin-v1.zip 3.0.0 plugin-p1.zip 4.0.0
echo; echo "################ Q6: claude plugin validate"
claude plugin validate "$(native "$H/../srv/marketplace.json")" 2>&1 | head -20 || true
[ "${1:-}" ] && kill $SRV_PID 2>/dev/null
exit 0
