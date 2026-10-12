#!/usr/bin/env bash
# Agent B — T-18 cron job. Wrecks its own checkout (safe: it's B's fork), drifts, hits a gate, goes BEHIND, rebases.
. "$(dirname "$0")/lib.sh"
D="$WORK/agent-b"; rm -rf "$D"
say "B: open T-18 claiming src/cron/** and the schema file"
hamonn open --task T-18 --title "nightly job" --agent claude-B --intent "feat: nightly job" --claim 'src/cron/**' --claim 'src/db/schema.ts' --dir "$D"; pause
cd "$D"
say "B: does everything that burned us on a shared checkout — inside its own fork"
echo 'export const nightly = (): string => "b1";' > src/cron/job.ts
git stash -u -q || true; git stash drop -q || true; git reset --hard -q
echo 'export const nightly = (): string => "b2";' > src/cron/job.ts
echo 'export const schema = "v2";' > src/db/schema.ts      # gated path
echo '# touched by accident' >> README.md                   # outside B's claims
hamonn push -m "feat(cron): nightly job"
echo "  (nothing outside B's fork moved; DRIFT and the gate are flagged above)"; pause
say "B: back out the accidental README edit; hand off; check"
git checkout -q -- . 2>/dev/null || true; git checkout -q HEAD~1 -- README.md 2>/dev/null || git show "$(git rev-list --max-parents=0 HEAD)":README.md > README.md
hamonn handoff "state: job + schema bump
next: land after owner sign-off"
hamonn checks unit=pass; hamonn status; pause
say "owner signs the gated path"
LANE="$(node -p "require('./.lane/lane.json').laneId")"
owner "/api/projects/$HAMONN_PROJECT/lanes/$LANE/sign" '{"by":"owner"}' >/dev/null && echo "signed"; pause
if [ -n "${LAND:-}" ]; then
  bash "$DEMO_ROOT/demo/peer-lands.sh"; cd "$D"; pause
  say "B: land (peer D just changed src/cron/job.ts on main → expect BEHIND with the files)"
  hamonn land || true; pause
  say "B: rebase onto main, resolve, push, re-check, land"
  hamonn rebase || { echo 'export const nightly = (): string => "b2+peer";' > src/cron/job.ts; git add -A; GIT_EDITOR=true git rebase --continue; hamonn push; }
  hamonn checks unit=pass; owner "/api/projects/$HAMONN_PROJECT/lanes/$LANE/sign" '{"by":"owner"}' >/dev/null || true
  hamonn land
fi
