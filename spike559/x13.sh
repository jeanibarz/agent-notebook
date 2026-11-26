#!/bin/bash
# x13.sh: POSIX runs of the polyglot hook variants (plain exec form), node present and absent.
set -u
. "$(dirname "$0")/lib.sh"
echo "=== $(uname -sm) claude $(claude --version) node $(node -v) date $(date -u +%FT%TZ)"
G="$W/x13plugins"; node "$(native "$HERE/gen13.mjs")" "$(native "$G")"
fresh_home x13
NB=$(dirname "$(command -v node)"); CB=$(dirname "$(command -v claude)")
for v in a-lf b-crlf c-shebang-lf d-shebang-crlf e-crlf-comment f-shebang-crlf-comment; do
 for sc in present absent; do
  P="$NB:/usr/bin:/bin:$CB"; [ $sc = absent ] && P="/usr/bin:/bin:$CB"
  echo "== $v node $sc"; mkdir -p "$H/p"
  env PATH="$P" bash -c 'cd "$1"; claude -p hi --plugin-dir "$3" --output-format stream-json --verbose </dev/null >../o.jsonl 2>../e.txt; echo "[bytes out: $(wc -c <../o.jsonl) err: $(head -c 200 ../e.txt | tr "\n" " ")]"; grep -o "\"subtype\":\"[a-z_]*\"" ../o.jsonl | sort | uniq -c | tr "\n" " "; echo; "$2"/node '"$(native "$HERE/hookrep.mjs")"' ../o.jsonl' _ "$H/p" "$NB" "$(native "$G/$v--plain")"
 done
done
exit 0
