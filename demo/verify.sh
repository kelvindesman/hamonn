#!/usr/bin/env bash
# Prints the landing proof for every landed lane: its head must be an ancestor of the integration head,
# checked with plain git against the repo itself (not against hamonn's own word).
. "$(dirname "$0")/lib.sh"
REPO="${HAMONN_ROOT:?set HAMONN_ROOT}/demo-app.git"
MAIN="$(git --git-dir "$REPO" rev-parse main)"
say "verify: is every landed lane head an ancestor of main @ ${MAIN:0:7}?"
curl -fsS "$HAMONN_URL/api/projects/$HAMONN_PROJECT" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);
  for(const l of b.lanes.LANDED) console.log([l.id,l.agent,l.head,l.landedSha].join(" "));});' |
while read -r id agent head landed; do
  if git --git-dir "$REPO" merge-base --is-ancestor "$head" "$MAIN"; then
    echo "  ✓ lane #$id ($agent) head ${head:0:7} is an ancestor of main, landed as ${landed:0:7}"
  else
    echo "  ✗ lane #$id ($agent) NOT an ancestor of main"; exit 1
  fi
done
