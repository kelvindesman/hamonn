#!/usr/bin/env bash
# Scene: the agent's session dies. A brand-new checkout of the lane carries the context in the repo itself.
. "$(dirname "$0")/lib.sh"
LANE="${1:?usage: resume.sh <laneId>}"
# A fresh session asks the coordinator for a new lane credential (the old one is revoked).
REMOTE="$(owner "/api/projects/$HAMONN_PROJECT/lanes/$LANE/token" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).remote')"
D="$WORK/agent-a-resumed"; rm -rf "$D"
say "A's session is gone. A fresh agent resumes from the lane's repo alone"
git clone -q "$REMOTE" "$D"; cd "$D"
[ -n "${DEMO_ECHO:-}" ] && printf '\033[36m$ cat .lane/%s/intent.md .lane/%s/handoff.md\033[0m\n' "$LANE" "$LANE"
cat ".lane/$LANE/intent.md" ".lane/$LANE/handoff.md"
