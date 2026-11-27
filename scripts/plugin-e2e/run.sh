#!/bin/bash
# The plugin end-to-end test for Linux and macOS (issue #559). Run by .github/workflows/plugin-e2e.yml;
# the Windows twin is run.ps1. Both follow the same steps and both leave the checking to hookrep.mjs and
# check.mjs, so a reader can compare them.
#
#   bash scripts/plugin-e2e/run.sh <build-dir>
#
# <build-dir> holds the two zips that `node scripts/build-plugin.mjs --out <build-dir> --version V` wrote
# for V = 0.0.1-e2e.1 and 0.0.1-e2e.2, each next to its staged folder.
#
# What it does, as a user would: it serves the two zips and a marketplace file over HTTPS from this
# computer's own network address (Claude Code refuses an archive over http, and on a loopback address),
# installs the plugin with `claude plugin install`, starts sessions with no Node.js, with Node.js 16 and
# with the Node.js of the runner, updates, rolls back, and uninstalls. Claude Code finds neither node, git,
# unzip nor tar on its PATH: the stub PATH is a folder of links to the system's programs without them.
# The home folder has a space, quotes, a dollar sign and a non-ASCII letter in its name.
#
# Real-asset mode (the marketplace-check workflow): with E2E_REAL=1, <build-dir> is what
# `node scripts/check-marketplace.mjs --stage <build-dir>` left: the unpacked folders
# agent-notebook-plugin-<W> and -<V> and v1.json, v2.json, bad.json whose entries name the real release
# zips on github.com (W: what main names, or V when main names none; V: the pull request's). The local
# server then serves only the marketplace files, E2E_MKT is the marketplace's own name, and when W is V
# the update and rollback steps are skipped.
#
# Needs in the environment: claude on PATH (installed by the workflow), node (the new one) on PATH, and
# NODE_OLD_DIR, the folder of a Node.js 16. E2E_WORK may name the work folder (default: $RUNNER_TEMP/nb-e2e).
# No secret and no login: a session never reaches a model, and the hooks run before that.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
VER1=0.0.1-e2e.1
VER2=0.0.1-e2e.2
MKT=nb-e2e
REAL=${E2E_REAL:-}
ID=agent-notebook@$MKT

fail() { echo "::error::plugin-e2e: $*"; echo "FAIL: $*"; exit 1; }
step() { echo; echo "################ $*"; }
[ $# -eq 1 ] && [ -d "$1" ] || fail "usage: bash run.sh <build-dir>"
ART=$(cd "$1" && pwd)
if [ -n "$REAL" ]; then
  MKT=${E2E_MKT:-agent-notebook}
  VER1=$(sed -n 1p "$ART/versions.txt" | tr -d '\r'); VER2=$(sed -n 2p "$ART/versions.txt" | tr -d '\r')
  [ -n "$VER1" ] && [ -n "$VER2" ] && [ -f "$ART/v1.json" ] && [ -f "$ART/v2.json" ] && [ -f "$ART/bad.json" ] || fail "$ART is not a check-marketplace --stage folder"
  for v in $VER1 $VER2; do [ -d "$ART/agent-notebook-plugin-$v" ] || fail "$ART has no agent-notebook-plugin-$v folder"; done
else
for v in $VER1 $VER2; do [ -f "$ART/agent-notebook-plugin-$v.zip" ] && [ -d "$ART/agent-notebook-plugin-$v" ] || fail "$ART has no agent-notebook-plugin-$v.zip with its staged folder"; done
fi
ID=agent-notebook@$MKT
[ -n "${NODE_OLD_DIR:-}" ] && [ -x "$NODE_OLD_DIR/node" ] || fail "NODE_OLD_DIR must name the folder of a Node.js 16"
CLAUDE_BIN=$(command -v claude) || fail "claude is not on PATH"
CLAUDE_DIR=$(dirname "$CLAUDE_BIN")
NODE_DIR=$(dirname "$(command -v node)")
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN
# A developer's shell, or an agent's session, may export NB_DIR and other NB_* settings. The plugin's hooks
# would then read and write that real notebook, not the one in the test's home folder, and the run would
# not test what the workflow tests. A runner sets none of them.
for v in $(env | sed -n 's/^\(NB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

# ---- the work folder, a home folder with a name that breaks careless code, the stub PATH ----
WORK=${E2E_WORK:-${RUNNER_TEMP:-/tmp}/nb-e2e}
rm -rf "$WORK"; mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
WORK_RE=$(printf '%s' "$WORK" | sed 's/[][\.*^$|/]/\\&/g')
redact() { sed "s|$WORK_RE|<work>|g"; }
H="$WORK/$(printf 'J\303\266hn D'"'"'oe $x Spike')"
PROJ="$H/proj"
PLANT="$H/proj-planted"
PLANT_NONODE="$H/proj-planted-nonode"
mkdir -p "$PROJ/.claude" "$PLANT" "$PLANT_NONODE" "$H/.claude" "$H/AppData/Roaming" "$H/AppData/Local"
export HOME="$H" USERPROFILE="$H" APPDATA="$H/AppData/Roaming" LOCALAPPDATA="$H/AppData/Local" CLAUDE_CONFIG_DIR="$H/.claude" DISABLE_AUTOUPDATER=1

FARM="$WORK/stubbin"
mkdir -p "$FARM"
for d in /usr/bin /bin /usr/sbin /sbin; do
  for f in "$d"/*; do
    b=${f##*/}
    case $b in node|nodejs|npm|npx|git|unzip|tar|bsdtar|gtar) continue ;; esac
    [ -e "$f" ] && [ ! -e "$FARM/$b" ] && ln -s "$f" "$FARM/$b"
  done
done
P_NONODE="$FARM:$CLAUDE_DIR"
P_OLD="$NODE_OLD_DIR:$FARM:$CLAUDE_DIR"
P_NEW="$NODE_DIR:$FARM:$CLAUDE_DIR"
for prog in node git unzip tar; do
  [ -z "$(PATH=$P_NONODE command -v $prog || true)" ] || fail "the stub PATH still finds $prog"
done

echo "=== $(uname -sm), claude $("$CLAUDE_BIN" --version), node $(node --version), old node $("$NODE_OLD_DIR/node" --version)"
echo "home: $H" | redact
echo "stub PATH: <work>/stubbin:<claude dir>  ($(ls "$FARM" | wc -l | tr -d ' ') links; no node, git, unzip, tar)"

# ---- helpers ----
# cl <PATH> <cwd> <claude arguments...>   runs claude, prints the command and its output, sets OUT and RC
cl() {
  local p=$1 cwd=$2; shift 2
  echo "\$ claude $*"
  OUT=$(cd "$cwd" && env PATH="$p" perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 300 "$CLAUDE_BIN" "$@" </dev/null 2>&1); RC=$?
  [ -n "$OUT" ] && printf '%s\n' "$OUT" | redact
  echo "[exit $RC]"
}
expect_ok() { [ "$RC" -eq 0 ] || fail "$1 (exit $RC)"; }
expect_out() { printf '%s' "$OUT" | grep -qF -- "$1" || fail "$2: the output has no \"$1\""; }
check() { node "$HERE/check.mjs" "$@" 2>&1 | redact; [ "${PIPESTATUS[0]}" -eq 0 ] || fail "check.mjs $1 failed"; }
# session <label> <PATH> <cwd> <expect> [plugin version]
session() {
  local label=$1 p=$2 cwd=$3 expect=$4 ver=${5:-}
  echo "--- session: $label"
  echo "\$ claude -p hi --output-format stream-json --verbose   (cwd $(printf '%s' "$cwd" | redact), PATH $(printf '%s' "$p" | redact))"
  ( cd "$cwd" && env PATH="$p" perl -e 'alarm shift; exec @ARGV or die "exec: $!"' 300 "$CLAUDE_BIN" -p hi --output-format stream-json --verbose </dev/null >"$WORK/session.jsonl" 2>"$WORK/session.err" )
  echo "[exit $?]"
  local entry="$ENTRY"; [ -f "$entry" ] || entry="$ART/agent-notebook-plugin-$VER1/examples/hooks/claude-code/nb-hook-entry.cjs"
  local extra=(); [ -n "$ver" ] && extra=(--plugin-version "$ver")
  node "$HERE/hookrep.mjs" "$WORK/session.jsonl" --expect "$expect" --os posix --entry "$entry" ${extra[@]+"${extra[@]}"} 2>&1 | redact
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail "session '$label': the hooks did not do what was expected (log above)"
}
list_field() { # list_field <field>: one field of the plugin in `claude plugin list --json`, or "absent"; prints nothing else
  ( cd "$PROJ" && env PATH="$P_NONODE" "$CLAUDE_BIN" plugin list --json </dev/null >"$WORK/list.json" 2>/dev/null )
  node "$HERE/check.mjs" installed "$WORK/list.json" "$ID" "$1"
}
ENTRY=""  # the installed hook entry, set after the install

# ---- the server: https on this computer's own address, a self-signed certificate that names it ----
step "serve the two builds over https on the runner's own address"
IP=$(node "$HERE/serve.mjs" --print-ip) || fail "no non-loopback IPv4 address on this computer"
SRV="$WORK/srv"; mkdir -p "$SRV"
[ -n "$REAL" ] || cp "$ART/agent-notebook-plugin-$VER1.zip" "$ART/agent-notebook-plugin-$VER2.zip" "$SRV/"
cat > "$WORK/ssl.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=nb-e2e
[v3]
subjectAltName=IP:$IP
EOF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 2 -config "$WORK/ssl.cnf" >/dev/null 2>&1 || fail "openssl could not make the certificate"
node "$HERE/serve.mjs" "$SRV" "$IP" 0 "$WORK/cert.pem" "$WORK/key.pem" "$WORK/ready" >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; echo; echo "--- server log"; redact < "$WORK/server.log"' EXIT
for _ in $(seq 1 50); do [ -s "$WORK/ready" ] && break; sleep 0.2; done
[ -s "$WORK/ready" ] || fail "the server did not start: $(cat "$WORK/server.log")"
BASE="https://$(cat "$WORK/ready")"
echo "serving $BASE (certificate for IP $IP, 2 days)"
if [ -n "$REAL" ]; then cp "$ART/v1.json" "$ART/v2.json" "$ART/bad.json" "$SRV/"
else node "$HERE/mkt.mjs" "$SRV" "$BASE" "$MKT" "agent-notebook-plugin-$VER1.zip" "agent-notebook-plugin-$VER2.zip"; fi
cp "$SRV/v1.json" "$SRV/mkt.json"
export NODE_EXTRA_CA_CERTS="$WORK/cert.pem"

# ---- validate ----
step "claude plugin validate, on the built folder and on the marketplace file"
cl "$P_NONODE" "$PROJ" plugin validate "$ART/agent-notebook-plugin-$VER1"
expect_ok "validate of the plugin folder"
printf '%s\n' "$OUT" > "$WORK/validate-plugin.txt"; check validate "$WORK/validate-plugin.txt"
cl "$P_NONODE" "$PROJ" plugin validate "$SRV/mkt.json"
expect_ok "validate of the marketplace file"
printf '%s\n' "$OUT" > "$WORK/validate-mkt.txt"; check validate "$WORK/validate-mkt.txt"

# ---- a wrong checksum is refused (in a separate Claude Code folder, so that it leaves nothing behind) ----
step "a marketplace entry with a wrong sha256 is refused"
SAVED_CFG=$CLAUDE_CONFIG_DIR
export CLAUDE_CONFIG_DIR="$WORK/bad-config"; mkdir -p "$CLAUDE_CONFIG_DIR"
cl "$P_NONODE" "$PROJ" plugin install agent-notebook --marketplace "$BASE/bad.json"
[ "$RC" -ne 0 ] || fail "a plugin with a wrong sha256 was installed"
expect_out "integrity check failed" "the wrong sha256"
export CLAUDE_CONFIG_DIR=$SAVED_CFG

# ---- before: the settings files, which we seed so that an overwrite would show ----
step "settings before the install"
printf '{\n  "cleanupPeriodDays": 30,\n  "env": { "NB_E2E_SEED": "1" }\n}\n' > "$H/.claude/settings.json"
printf '{\n  "env": { "NB_E2E_PROJECT_SEED": "1" }\n}\n' > "$PROJ/.claude/settings.json"
check snapshot "$WORK/settings-before.json" "$H/.claude" "$PROJ/.claude"

# ---- install ----
step "install from the marketplace, with no node and no git on PATH"
cl "$P_NONODE" "$PROJ" plugin install agent-notebook --marketplace "$BASE/mkt.json"
expect_ok "install"
expect_out "Successfully installed plugin: $ID" "install"
[ "$(list_field version)" = "$VER1" ] || fail "the installed version is not $VER1"
ROOT=$(list_field installPath)
echo "installed at: $(printf '%s' "$ROOT" | redact)"
check modes "$ROOT"
check same-tree "$ART/agent-notebook-plugin-$VER1" "$ROOT"
ENTRY="$ROOT/examples/hooks/claude-code/nb-hook-entry.cjs"
[ -f "$ENTRY" ] || fail "the installed plugin has no hook entry"

# ---- sessions ----
step "sessions of the installed plugin: no node, Node.js 16, a current Node.js"
session "no node on PATH" "$P_NONODE" "$PROJ" nonode "$VER1"
session "Node.js 16 on PATH" "$P_OLD" "$PROJ" oldnode "$VER1"
session "current Node.js on PATH" "$P_NEW" "$PROJ" newnode-first "$VER1"
[ -f "$H/.agent-notebook/projects/.first-start" ] || fail "the first chat left no .first-start claim"

# ---- planted programs ----
step "programs planted in the project folder never run"
for name in node sh uname dirname; do printf '#!/bin/sh\necho PLANTED-%s\n' "$name" > "$PLANT/$name"; chmod +x "$PLANT/$name"; done
# The sh twin keeps only absolute PATH entries, so a planted node, sh, uname and dirname behind an
# empty first PATH element are neither run nor taken for a real node.
# A literal "." element is left out of the sessions: Claude Code itself then starts ./sh (measured), which
# no plugin can prevent. bin/nb does cope with it, and is run with it below.
for name in node sh uname dirname; do cp "$PLANT/$name" "$PLANT_NONODE/$name"; done
session "planted node, sh, uname, dirname, no node, empty PATH element first" ":$P_NONODE" "$PLANT_NONODE" nonode "$VER1"
session "planted, Node.js 16, empty PATH element first" ":$P_OLD" "$PLANT" oldnode "$VER1"
session "planted, current Node.js, empty PATH element first" ":$P_NEW" "$PLANT" newnode "$VER1"
for pp in ":$P_NEW" ".:$P_NEW" "::$P_NEW" "bin:$P_NEW"; do
  echo "\$ (cd <project folder with planted node, sh, uname, dirname>; PATH=$(printf '%s' "$pp" | redact) <plugin>/bin/nb --version)"
  OUT=$(cd "$PLANT" && env PATH="$pp" "$ROOT/bin/nb" --version 2>&1); RC=$?
  printf '%s\n' "$OUT" | redact; echo "[exit $RC]"
  [ "$RC" -eq 0 ] || fail "bin/nb --version failed with PATH=$pp"
  case $OUT in *PLANTED*) fail "bin/nb ran a planted program with PATH=$pp" ;; esac
  case $OUT in *"$VER1"*) ;; *) fail "bin/nb --version did not print $VER1 with PATH=$pp" ;; esac
done

if [ "$VER1" != "$VER2" ]; then
# ---- update ----
step "update: the marketplace now names $VER2"
cp "$SRV/v2.json" "$SRV/mkt.json"
cl "$P_NONODE" "$PROJ" plugin marketplace update "$MKT"
expect_ok "marketplace update"
cl "$P_NONODE" "$PROJ" plugin update "$ID"
expect_ok "plugin update"
expect_out "updated from $VER1 to $VER2" "update"
[ "$(list_field version)" = "$VER2" ] || fail "the installed version is not $VER2 after the update"
ROOT2=$(list_field installPath)
check same-tree "$ART/agent-notebook-plugin-$VER2" "$ROOT2"
session "after the update" "$P_NEW" "$PROJ" newnode "$VER2"

# ---- rollback ----
step "rollback: the marketplace names $VER1 again"
cp "$SRV/v1.json" "$SRV/mkt.json"
cl "$P_NONODE" "$PROJ" plugin marketplace update "$MKT"
expect_ok "marketplace update"
cl "$P_NONODE" "$PROJ" plugin update "$ID"
expect_ok "plugin update"
expect_out "updated from $VER2 to $VER1" "rollback"
[ "$(list_field version)" = "$VER1" ] || fail "the installed version is not $VER1 after the rollback"
session "after the rollback" "$P_NEW" "$PROJ" newnode "$VER1"

fi

# ---- uninstall ----
step "uninstall"
cl "$P_NONODE" "$PROJ" plugin uninstall "$ID"
expect_ok "uninstall"
[ "$(list_field version)" = absent ] || fail "the plugin is still listed after the uninstall"
session "after the uninstall" "$P_NEW" "$PROJ" none

step "settings after the uninstall: only Claude Code's own keys may differ"
check snapshot "$WORK/settings-after.json" "$H/.claude" "$PROJ/.claude"
check settings-diff "$WORK/settings-before.json" "$WORK/settings-after.json" "$MKT"

echo
echo "plugin-e2e on $(uname -s): all checks passed"
