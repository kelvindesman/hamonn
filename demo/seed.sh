#!/usr/bin/env bash
# Seed the demo project. MODE=local (default): bare repo on disk for the Node server.
#                         MODE=artifacts:       creates the repo in Cloudflare Artifacts via wrangler.
. "$(dirname "$0")/lib.sh"
MODE="${MODE:-local}"
SEED="$WORK/seed-src"; rm -rf "$SEED"; mkdir -p "$SEED/src/rss" "$SEED/src/cron" "$SEED/src/db"
cd "$SEED"; git init -q -b main
cat > package.json <<'JSON'
{ "name": "demo-app", "type": "module", "scripts": { "test": "echo ok" } }
JSON
echo '{ "name": "demo-app", "main": "src/index.ts" }' > wrangler.jsonc
echo 'import { Hono } from "hono"; export default new Hono().get("/", (c) => c.text("demo"));' > src/index.ts
echo 'export const feed = (): string[] => [];' > src/rss/feed.ts
echo 'export const nightly = (): string => "noop";' > src/cron/job.ts
echo 'export const schema = "v1";' > src/db/schema.ts
printf '# demo-app\n' > README.md
printf 'export const t = 1;\n' > src/index.test.ts
git add -A && git commit -q -m "seed demo-app"

if [ "$MODE" = "local" ]; then
  REPO="${HAMONN_ROOT:-./hamonn-data/repos}/demo-app.git"; REPO="$(cd "$(dirname "$REPO")" 2>/dev/null && pwd || (mkdir -p "$(dirname "$REPO")" && cd "$(dirname "$REPO")" && pwd))/demo-app.git"
  rm -rf "$REPO"; git init -q --bare -b main "$REPO"; git push -q "$REPO" main 2>/dev/null
  REMOTE="$REPO"
else
  (cd "$DEMO_ROOT/apps/worker" && npx wrangler artifacts repos create demo-app --namespace default --default-branch main) | tee "$WORK/artifacts-create.txt"
  echo "Now push the seed with a write token:  cd $SEED && git push https://x:<token>@<ACCOUNT_ID>.artifacts.cloudflare.net/git/default/demo-app.git main"
  echo "(npx wrangler artifacts repos issue-token demo-app --namespace default --scope write --ttl 3600)"
  REMOTE="${ARTIFACTS_REMOTE:?set ARTIFACTS_REMOTE to the https remote printed above, then re-run}"
fi

say "register project 'demo' (gated: wrangler.jsonc, src/db/**; required check: unit)"
curl -fsS -X POST "$HAMONN_URL/api/projects" -H "authorization: Bearer $HAMONN_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"demo\",\"repo\":{\"name\":\"demo-app\",\"remote\":\"$REMOTE\"},\"gatedPaths\":[\"wrangler.jsonc\",\"src/db/**\"],\"requiredChecks\":[\"unit\"]}"; echo
echo "board: $HAMONN_URL/p/demo"
