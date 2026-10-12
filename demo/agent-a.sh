#!/usr/bin/env bash
# Agent A — T-17 RSS feed. The clean path: open, build, hand off, check, land.
. "$(dirname "$0")/lib.sh"
D="$WORK/agent-a"; rm -rf "$D"
say "A: open a lane (fork) for T-17, claiming src/rss/**"
hamonn open --task T-17 --title "RSS feed" --agent claude-A --intent "feat: rss feed" --claim 'src/rss/**' --dir "$D"; pause
cd "$D"
say "A: build it, push to A's OWN fork"
printf 'export const feed = (): string[] => ["item-1", "item-2"];\n' > src/rss/feed.ts
hamonn push -m "feat(rss): feed items"; pause
say "A: hand off state in the repo (survives this session), report the check"
hamonn handoff "state: feed returns items
next: wire into src/index.ts after landing"
hamonn checks unit=pass; pause
hamonn status
[ -n "${LAND:-}" ] && { say "A: land"; hamonn land; }
