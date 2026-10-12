# Self-hosting (Node, any cloud/VM/Docker)

```bash
pnpm install && pnpm build:wasm           # wasm kernel (needs Rust + wasm-pack once)
export HAMONN_ADMIN_KEY=$(openssl rand -hex 24)
pnpm --filter @hamonn/node start          # http://localhost:8787  (board at /p/<project>)
```
| Env | Default | Meaning |
|---|---|---|
| `HAMONN_ADMIN_KEY` | required | bearer token for every non-GET request |
| `HAMONN_HOST` | `local-fs` | `local-fs` or `github` |
| `HAMONN_ROOT` | `./hamonn-data/repos` | bare repos for `local-fs` |
| `HAMONN_DB` | `./hamonn-data/hamonn.db` | SQLite file |
| `PORT` | `8787` | |
| `GITHUB_TOKEN`, `GITHUB_FORK_ORG` | | for `HAMONN_HOST=github` |
| `HAMONN_HOOK_SECRET` | | HMAC secret for `/hooks/github` |

Requires Node ≥ 22.13 (`node:sqlite`) and the `git` binary (landing uses real `git merge`).

## Try it locally (no cloud)
```bash
git init --bare -b main /tmp/hamonn/repos/demo-app.git   # or seed with demo/seed.sh
curl -X POST localhost:8787/api/projects -H "authorization: Bearer $HAMONN_ADMIN_KEY" \
  -d '{"name":"demo","repo":{"name":"demo-app","remote":"/tmp/hamonn/repos/demo-app.git"},"requiredChecks":["unit"]}'
```
See `demo/run-demo.md` for the full multi-agent walkthrough.
