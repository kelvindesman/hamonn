#!/usr/bin/env bash
# Agent C — T-17 again (a peer is already on it). Sees the overlap hint, competes as a candidate, loses.
. "$(dirname "$0")/lib.sh"
D="$WORK/agent-c"; rm -rf "$D"
say "C: open T-17 too → expect an overlap hint"
hamonn open --task T-17 --agent claude-C --intent "feat: rss feed (my take)" --claim 'src/rss/**' --dir "$D"; pause
cd "$D"
printf 'export const feed = (): string[] => Array.from({ length: 3 }, (_, i) => `c-${i}`);\n' > src/rss/feed.ts
hamonn push -m "feat(rss): C's version"
hamonn checks unit=pass; hamonn status
echo "  (C wrote no handoff: the compare table will show ledger ✗)"
