#!/bin/bash
# planted-posix.sh <zipdir>: a ./node planted in the project folder, with and without an empty/"." PATH element (Q1, Linux and macOS).
set -u
. "$(dirname "$0")/lib.sh"
ZD=$1; IP=$(ip_addr); PORT=18559; BASE="https://$IP:$PORT"
mkdir -p "$W/srv"; cp "$ZD"/plugin-v1.zip "$W/srv/"; mkcert "$W" "$IP"; start_server "$W/srv" $PORT "$IP"
node "$(native "$HERE/genmkt.mjs")" "$(native "$W/srv")" plugin-v1.zip 1.0.0 "$BASE"
export NODE_EXTRA_CA_CERTS=$(native "$W/cert.pem")
fresh_home planted; CL plugin install agent-notebook --marketplace "$BASE/marketplace.json" | tail -1
if [ "${RUNNER_OS:-}" = Windows ]; then kill $SRV_PID 2>/dev/null; echo "installed for the Windows probes: $H"; exit 0; fi
for p in c a b b2; do mkdir -p "$H/proj-$p"; done
for p in a b b2; do printf '#!/bin/sh\necho PLANTED-NODE\n' > "$H/proj-$p/node"; chmod +x "$H/proj-$p/node"; done
NB=$(dirname "$(command -v node)"); CB=$(dirname "$(command -v claude)")
echo "== control, nothing planted";                       env PATH="$NB:/usr/bin:/bin:$CB" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../out.jsonl 2>/dev/null; node '"$(native "$HERE/hookrep.mjs")"' ../out.jsonl | grep -v "SPIKE559-\|EXEC-"' _ "$H/proj-c"
echo "== planted ./node, normal PATH";                    env PATH="$NB:/usr/bin:/bin:$CB" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../out.jsonl 2>/dev/null; node '"$(native "$HERE/hookrep.mjs")"' ../out.jsonl | grep -v "SPIKE559-\|EXEC-"' _ "$H/proj-a"
echo "== planted ./node, empty first PATH element";       env PATH=":$NB:/usr/bin:/bin:$CB" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../out.jsonl 2>/dev/null; node '"$(native "$HERE/hookrep.mjs")"' ../out.jsonl | grep -v "SPIKE559-\|EXEC-"' _ "$H/proj-b"
echo "== planted ./node, '.' on PATH";                    env PATH=".:$NB:/usr/bin:/bin:$CB" bash -c 'cd "$1"; claude -p hi --output-format stream-json --verbose </dev/null >../out.jsonl 2>/dev/null; node '"$(native "$HERE/hookrep.mjs")"' ../out.jsonl | grep -v "SPIKE559-\|EXEC-"' _ "$H/proj-b2"
kill $SRV_PID 2>/dev/null; exit 0
