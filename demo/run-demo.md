# Demo walkthrough (local, no cloud) — ~7 minutes

```bash
pnpm install && pnpm build:wasm
export HAMONN_KEY=demo-key HAMONN_ADMIN_KEY=demo-key HAMONN_ROOT=$PWD/hamonn-data/repos
pnpm --filter @hamonn/node start &            # http://localhost:8787
bash demo/seed.sh                              # demo-app + project "demo"
open http://localhost:8787/p/demo              # the board; click "set admin key" and paste demo-key
```
Then, in order (set `PAUSE=1` to step with Enter, `LAND=1` to let the script land):

| Scene | Command | What to point at |
|---|---|---|
| 1. Three lanes open concurrently | `bash demo/agent-a.sh`, `bash demo/agent-b.sh` (stop before sign), `bash demo/agent-c.sh` | C's overlap hint on open |
| 2. B wrecks its checkout | (inside agent-b.sh) | nothing else moved; `⚠ DRIFT README.md` and `gate: unsigned` on B's card |
| 3. Resume from the ledger | delete `$WORK/agent-a`, re-clone the lane, read `.lane/1/handoff.md` | context survived the session |
| 4. Compare A vs C | open `/t/demo/T-17` | C: ledger ✗; pick A → C archived |
| 5. Land A with proof | `hamonn land` in A's dir | `LANDED @ <sha>` = board head; ancestor proof |
| 6. B BEHIND → rebase | `LAND=1 bash demo/agent-b.sh` (it has peer D land a conflicting change first) | `BEHIND: src/cron/job.ts` → rebase → LANDED |
| 7. Gate | owner clicks **sign** on B's card | blocked until signed |

Cloudflare: deploy the Worker, `MODE=artifacts bash demo/seed.sh`, and point `HAMONN_URL` at the workers.dev URL — nothing else changes.
