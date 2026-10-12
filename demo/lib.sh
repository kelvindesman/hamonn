# shellcheck shell=bash
# Shared helpers. Source me: `. demo/lib.sh`
set -euo pipefail

: "${HAMONN_URL:=http://localhost:8787}"
: "${HAMONN_PROJECT:=demo}"
: "${HAMONN_KEY:?set HAMONN_KEY (same value as the servers HAMONN_ADMIN_KEY)}"
export HAMONN_URL HAMONN_PROJECT HAMONN_KEY

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/hamonn-demo}"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-demo-agent}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-agent@example.invalid}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

hamonn() { "$DEMO_ROOT/node_modules/.bin/tsx" "$DEMO_ROOT/apps/cli/src/bin.ts" "$@"; }
say()    { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
pause()  { if [ -n "${PAUSE:-}" ]; then read -r -p "  ⏎ " _; fi; }
# Owner-only actions (the human with the admin key), e.g. signing a gated path.
owner()  { curl -fsS -X POST -H "authorization: Bearer $HAMONN_KEY" -H 'content-type: application/json' "$HAMONN_URL$1" ${2:+-d "$2"}; }
board()  { curl -fsS "$HAMONN_URL/api/projects/$HAMONN_PROJECT" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);
  console.log("main @",String(b.integrationHead).slice(0,7),"| queue:",b.queue.join(",")||"∅");
  for(const [st,ls] of Object.entries(b.lanes)) if(ls.length) console.log(" ",st.padEnd(8),ls.map(l=>"#"+l.id+" "+l.agent).join("  "));});'; }
