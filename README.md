# hamonn

**A host-agnostic landing layer for concurrent coding agents.**
Agents never hold a write token to your integration branch. Each works in its own fork (a *lane*), declares *claims*,
keeps its context in the repo, and a coordinator **lands** the work server-side — one lane at a time — with proof.

[![CI](https://github.com/kelvindesman/hamonn/actions/workflows/ci.yml/badge.svg)](https://github.com/kelvindesman/hamonn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kelvindesman/hamonn/apps/worker)

> Built for the Cloudflare "Git platform for the agentic era" challenge. It is **not** "GitHub with agents on top": it is the
> layer that makes concurrent agents safe on *any* git host — Cloudflare Artifacts is the default adapter.

## Why
The idea comes from a production repo that ran **886 concurrent Claude Code sessions on one `.git`** and logged ~20 named
incidents: `git reset --hard` destroying a peer's edits, `add -A` sweeping 46 peer files, a squash-merge stranding later pushes,
"green CI" on a change that never shipped. Every mitigation was a client-side hook, because the host has no concept of agents.
hamonn moves each one to a place agents cannot bypass → [docs/pain-points.md](docs/pain-points.md).

| Primitive | What it replaces |
|---|---|
| **Lane = fork**, token scoped to the fork | one shared `.git`; admin tokens used by agents |
| **Coordinator is the sole writer** of the integration branch | client-side merge, squash, "auto-merge when green" races |
| **Claims** + overlap hint at open + **drift** check at every push | discovering duplicate work in review |
| **In-repo ledger** `.lane/<id>/{intent,handoff,evidence}.md` | context that dies with the chat session |
| **Candidates**: compare N attempts at a task, pick one, archive the rest | racing to merge |
| **Landing proof**: lane head must be an ancestor of the integration head, re-read from the host | "green CI ≠ shipped" |
| **Gates**: `sign` required to land human-only paths | commit-trailer regex hooks |
| **Landing queue** (serial) | "≤2 PRs in flight" conventions |

## See it work (no cloud needed, ~3 minutes)
```bash
pnpm install && pnpm build:wasm               # Rust + wasm-pack once; see CONTRIBUTING.md
export HAMONN_ADMIN_KEY=demo-key HAMONN_KEY=demo-key HAMONN_ROOT=$PWD/hamonn-data/repos
pnpm --filter @hamonn/node start &            # board: http://localhost:8787/p/demo
bash demo/seed.sh
bash demo/agent-a.sh && bash demo/agent-c.sh   # C sees the overlap hint with A
LAND=1 bash demo/agent-b.sh                    # drift + gate flagged → peer lands first → BEHIND → rebase → LANDED
```
Full walkthrough: [demo/run-demo.md](demo/run-demo.md). The same flow runs as an automated test:
`apps/node/test/e2e.test.ts` (three agents, real git, no mocks).

## The agent's view
```text
$ hamonn open --task T-17 --agent claude-A --intent "feat: rss" --claim 'src/rss/**'
lane #1 opened on demo-l1 (main) in .
$ hamonn push                       # git add -A && commit && push — to A's OWN fork
pushed 4d09596: PUSHED
  · check unit: missing
  · handoff ledger missing
$ hamonn handoff "state: feed returns items" && hamonn checks unit=pass
unit=pass → READY
$ hamonn land
queued (position 0)
LANDED @ 80e82a83fb9c666422b8f1fcc4bee6166812a2b7      # or  BEHIND: src/cron/job.ts   /   FAILED: <why>
```
`git add -A`, `reset --hard`, `stash` — everything that burned the shared checkout — is now safe, because it can only touch
the agent's own fork.

## Architecture in one picture
```
 agents ─ CLI / HTTP ─▶  kernel  (Rust → wasm, zero I/O, 100% covered)  ◀── decides everything
                         shell   (TypeScript: ports, services, Hono API, board)  ◀── does all I/O
        GitHost port ─ cloudflare-artifacts · github · local-fs        GitWire ─ isomorphic-git (Workers) · system git (Node)
        Store port   ─ Durable Object SQLite · node:sqlite · memory
        runtimes     ─ apps/worker (Cloudflare) · apps/node (anywhere) · apps/cli
```
**Functional core, imperative shell** ([ADR-001](docs/adr/001-language.md)): every rule about lane state, claims, readiness and
landing lives in the Rust kernel and nowhere else. **Landing is host-independent**: every host speaks git smart-HTTP, so only a
handful of control-plane verbs differ per host ([adapters](docs/adapters.md), [ADR-002](docs/adr/002-ports-and-adapters.md)).
More: [docs/architecture.md](docs/architecture.md).

## Status — what is verified, and how
| Piece | Verified by |
|---|---|
| Kernel (state machine, claims, ledger, readiness, landing proof) | 42 Rust tests incl. property tests; **100% lines + functions** (`cargo llvm-cov`), enforced in CI |
| Rust ↔ wasm ↔ TS boundary | Rust-generated vectors replayed against the compiled wasm from TS |
| Shell (services, API, UI) | 173 TS tests; **100% lines/branches/functions/statements** on `packages/shell`, enforced |
| local-fs host, system-git wire, SQL stores | shared contract suites against **real git** / real SQLite |
| isomorphic-git wire | contract suite against `git http-backend` with token auth, **and a landing run inside workerd** |
| Whole system | `apps/node/test/e2e.test.ts`, `apps/cli/test/cli.test.ts`, `demo/*.sh` — real git, real HTTP |
| Worker | bundles (995 KB / 256 KB gz incl. the 267 KB wasm kernel); boots in workerd with DO + wasm; queue/DO logic unit-tested |
| **Cloudflare Artifacts adapter** | contract suite against a fake binding over real git objects. **Not yet run against a live Artifacts account** — the first live run is the remaining verification step |
| GitHub adapter | contract suite against a fake REST server (shapes hand-modelled from the docs, **not recorded**). PAT passthrough is not fork-scoped |
| GitLab / Bitbucket | not built |

Honest limitations (Artifacts is a beta; isomorphic-git has no rename detection; claims are declared not enforced; …):
[docs/comparison.md](docs/comparison.md).

## Run it
### Self-host (Node ≥ 22.13, git)
[docs/self-hosting.md](docs/self-hosting.md) — `pnpm --filter @hamonn/node start`; `HAMONN_HOST=github` for GitHub.

### Cloudflare (Workers Paid + Artifacts)
```bash
cd apps/worker
cp .dev.vars.example .dev.vars && npx wrangler secret put HAMONN_ADMIN_KEY
npx wrangler queues create hamonn-events
npx wrangler deploy
npx tsx ../cli/src/bin.ts setup <project-repo>        # prints the queue-subscription commands; add --run to execute
```
Creates `ProjectDO`/`RegistryDO` (SQLite-backed), the `ARTIFACTS` binding (`namespace: default`), and consumes
`cf.artifacts.repo.pushed` from the `hamonn-events` queue. The Deploy button needs the workspace packages published to npm and
auto-provisioning of the Artifacts binding is unverified; if it does not provision it, deploy, enable Artifacts, then run `setup`.

## Repo map
`crates/hamonn-core` (kernel) · `packages/core-wasm` · `packages/shell` · `packages/adapters/*` · `apps/{worker,node,cli}` ·
`demo/` · `docs/` ([map](docs/repo-map.md)). Working on it with an agent? Read [AGENTS.md](AGENTS.md).

## Contributing
Adapters are the easiest high-impact contribution: [CONTRIBUTING.md](CONTRIBUTING.md#write-an-adapter-in-an-hour).
[Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Governance](GOVERNANCE.md) · MIT licensed.
