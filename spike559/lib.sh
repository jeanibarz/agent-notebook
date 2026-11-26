# Shared bash helpers (Linux, macOS, Windows Git Bash). Spike #559: throwaway, never merged.
W=${RUNNER_TEMP:-/tmp}/w559; mkdir -p "$W"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
t() { perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 240 "$@" 2>&1 || true; }
tt() { if command -v perl >/dev/null 2>&1 && [ "${RUNNER_OS:-}" != Windows ]; then perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 240 "$@"; else "$@"; fi; }
ip_addr() { node -e 'const o=require("os").networkInterfaces();for(const k in o)for(const a of o[k])if(a.family==="IPv4"&&!a.internal&&!a.address.startsWith("169.254.")){console.log(a.address);process.exit(0)}process.exit(1)'; }
mkcert() { # mkcert <dir> <ip>
  cat > "$1/ssl.cnf" <<C
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=nb559
[v3]
subjectAltName=IP:$2
C
  MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1/key.pem" -out "$1/cert.pem" -days 2 -config "$1/ssl.cnf" 2>&1 | tail -1
}
start_server() { # start_server <srvdir> <port> <ip> ; sets SRV_PID
  node "$(native "$HERE/serve.mjs")" "$(native "$1")" "$2" "$3" "$(native "$1/../cert.pem")" "$(native "$1/../key.pem")" > "$W/server.log" 2>&1 &
  SRV_PID=$!; sleep 2; head -3 "$W/server.log"
}
fresh_home() { # fresh_home <name> ; sets H, exports HOME etc
  H="$W/$1"; rm -rf "$H"; mkdir -p "$H/proj"
  export HOME="$(native "$H")" USERPROFILE="$(native "$H")" CLAUDE_CONFIG_DIR="$(native "$H")/.claude" APPDATA="$(native "$H")/AppData/Roaming" LOCALAPPDATA="$(native "$H")/AppData/Local" DISABLE_AUTOUPDATER=1
  mkdir -p "$H/AppData/Roaming" "$H/AppData/Local"
}
CL() { echo "\$ claude $*"; ( cd "$H/proj" && tt claude "$@" < /dev/null 2>&1 ); echo "[exit $?]"; }
session() { # session <projdir> : one -p session, print hook events
  ( cd "$1" && tt claude -p hi --output-format stream-json --verbose < /dev/null > "$H/out.jsonl" 2> "$H/err.txt" ); echo "[session exit $?]"
  node "$(native "$HERE/hookrep.mjs")" "$(native "$H/out.jsonl")" | grep -v 'SPIKE559-\|EXEC-' || true
}
plugver() { claude plugin list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const p of l)if(p.id.startsWith("agent-notebook"))console.log("   installed:",p.id,"version",p.version,"path",p.installPath)'; }
