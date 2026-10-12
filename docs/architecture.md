# Architecture

hamonn is a **landing layer**, not a git host. It sits between agents and any git host and makes one rule structural:
**agents never hold a write token to the integration branch.** A coordinator lands work, one lane at a time, and proves it.

```
                    ┌────────────────────────────────────────────────┐
  agents ──CLI/API─▶│  kernel  (Rust → wasm, zero I/O, 100% covered)   │
                    │  lane state machine · claims · ledger ·          │
                    │  readiness · landing decision + ancestor proof   │
                    └───────┬───────────────┬───────────────┬─────────┘
                    shell (TypeScript): ports + services + Hono API + board
                            │               │               │
                    GitHost port       Store port      GitWire port
          ┌─────────────────┼────┐   ┌─────┴──────────┐  ┌───┴──────────────────┐
          │ cloudflare-artifacts │   │ store-sql        │  │ gitwire-isomorphic    │
          │ github  local-fs     │   │  ├ node:sqlite   │  │  (Workers, in-memory) │
          │ (gitlab, bitbucket:  │   │  └ Durable Obj.  │  │ gitwire-system-git    │
          │  planned)            │   │ store-memory     │  │  (Node, containers)   │
          └──────────────────────┘   └──────────────────┘  └───────────────────────┘

  apps/worker  Cloudflare: Hono + ProjectDO (one per project, serial landing queue) + RegistryDO + Queue consumer
  apps/node    self-host:  Hono + node:sqlite + system git + webhook receiver
  apps/cli     `hamonn`:   what agents run
```

## Functional core, imperative shell (ADR-001)
The kernel (`crates/hamonn-core`) is a set of pure functions over serde types: *facts in, decision out*. It never reads a clock,
touches a network, or generates an id. The shell does all I/O — it fetches facts through ports, calls the kernel for every
decision, and persists the result. The boundary is `call(name, json) -> json`, so it is fully unit-tested natively and replayed
from TypeScript against the compiled wasm using committed vectors (`crates/hamonn-core/tests/vectors/`).

## Lane lifecycle
```
OPEN ─push→ PUSHED ─checks+ledger+no drift+gate signed→ READY ─enqueue→ (queue) ─drain→ LANDING ─┬→ LANDED
  │            ↑  ↑                 │                                                              ├→ BEHIND  (conflict files returned)
  └→ ARCHIVED  │  └── re-push ──────┘ (any push resets sign-off, merge preview and bound checks)    └→ FAILED  (wire error / proof false)
               └── BEHIND/FAILED lanes re-enter via a new push (after `hamonn rebase`)
```
The table is `crates/hamonn-core/src/state.rs`; a property test proves `transition` is total and agrees with it.

## Landing, and why "LANDED" means something
`GitWire.land` fetches the integration branch and the lane, makes a **merge commit** (never a squash; never a fast-forward),
and pushes it with a 600-second write token that exists only for this landing. The coordinator then **independently re-reads**
the integration head from the host and re-fetches it to check that the lane's head is an ancestor. Only
`WireResult::Clean ∧ is_ancestor` becomes `LANDED`; anything else is `FAILED` with the reason. The kernel enforces this in
`apply_land_result`, so no shell bug can mark a lane landed without proof.

The wire is host-independent because every host speaks git smart-HTTP. Two implementations exist and pass the same contract:
`gitwire-isomorphic` (runs in a Worker, in-memory; no rename detection, one merge base only) and `gitwire-system-git`
(real `git merge`, for Node and containers).

## Isolation: fork per lane
`openLane` forks the project repo (`fork` mode) and mints a write token scoped to *that fork*. The agent's `git add -A`,
`reset --hard`, `stash` can only hurt its own fork. `branch` mode (lane = `lane/<id>` on the project repo) exists for hosts
without fork appetite; it is weaker unless the host supports branch-scoped credentials.

## Ledger, drift and gates
- **Ledger** lives in the lane's own repo at `.lane/<id>/{intent,handoff,evidence}.md` — namespaced per lane so landed ledgers
  never conflict, and kept in history as provenance. READY requires intent + handoff.
- **Drift** = paths changed since the lane diverged (merge-base when the host can compute it) that fall outside its claims.
  `.lane/` is always allowed. Drift blocks READY unless `allowDrift`.
- **Gates** = `gatedPaths` globs. Touching one requires `sign`; a sign-off binds to one head and is voided by the next push.
- **Claims overlap** is a conservative heuristic (no false negatives, some false positives); see `claims.rs`.

## Concurrency
Per-project work is serialized: `ProjectDO` on Workers (one Durable Object per project; the landing queue drains from its
alarm), a per-project promise lock on Node. Two simultaneous `land` calls land one after the other; the second is merged on top
of the first (or comes back `BEHIND` with the conflicting files).

## What runs where
| Concern | Workers | Node |
|---|---|---|
| State | DO SQLite via `SqlStore` | `node:sqlite` via `SqlStore` |
| Events | Queues event subscription → consumer → ProjectDO | webhooks (`/hooks/github`) or `hamonn push` |
| Landing | isomorphic-git, in memory | system `git` in a temp clone |
| Drain | DO alarm | `setTimeout` after enqueue |
