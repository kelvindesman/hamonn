#!/usr/bin/env bash
# A peer agent (D) lands a change to src/cron/job.ts through hamonn, so lane B ends up BEHIND.
# Works on any host: it uses the same lane flow every agent uses.
. "$(dirname "$0")/lib.sh"
D="$WORK/agent-d"; rm -rf "$D"
say "peer D: open, change src/cron/job.ts, hand off, check, land"
hamonn open --task T-19 --agent claude-D --intent "fix: nightly job output" --claim 'src/cron/job.ts' --dir "$D"
cd "$D"
echo 'export const nightly = (): string => "peer";' > src/cron/job.ts
hamonn push -m "fix(cron): nightly output"
hamonn handoff "state: output fixed"
hamonn checks unit=pass
hamonn land
