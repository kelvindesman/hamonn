#!/usr/bin/env bash
# Seed the demo project. MODE=local (default): bare repo on disk for the Node server.
#                         MODE=artifacts:       the deployed Worker creates the repo in Artifacts.
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
  rm -rf "$REPO"; git init -q --bare -b main "$REPO"; git push -q "$REPO" main
  REMOTE="$REPO"
else
  # Ask the deployed Worker to create the repo through its Artifacts binding (no wrangler, no API token).
  REPO_NAME="${REPO_NAME:-demo-app}"
  CREATED="$(curl -fsS -X POST "$HAMONN_URL/api/admin/repos" -H "authorization: Bearer $HAMONN_KEY" \
    -H 'content-type: application/json' -d "{\"name\":\"$REPO_NAME\"}")"
  REMOTE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).remote)' "$CREATED")"
  TOKEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token.replace(/\?expires=\d+$/, ""))' "$CREATED")"
  git -c http.extraHeader="Authorization: Bearer $TOKEN" push -q "$REMOTE" main
fi

say "register project 'demo' (gated: wrangler.jsonc, src/db/**; required check: unit)"
curl -fsS -X POST "$HAMONN_URL/api/projects" -H "authorization: Bearer $HAMONN_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"demo\",\"repo\":{\"name\":\"${REPO_NAME:-demo-app}\",\"remote\":\"$REMOTE\"},\"gatedPaths\":[\"wrangler.jsonc\",\"src/db/**\"],\"requiredChecks\":[\"unit\"]}"; echo
echo "board: $HAMONN_URL/p/demo"
