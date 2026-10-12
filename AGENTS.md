# AGENTS.md — working on hamonn

hamonn is a **landing layer** for concurrent agents: each agent works in its own fork ("lane"), declares
claims, and a coordinator lands work server-side, one lane at a time, with an ancestor proof. It is host-agnostic
(Cloudflare Artifacts is the default adapter). Read `docs/spec.md` first; every PR should say which section it implements.

## Layout
- `crates/hamonn-core` — **Rust kernel**. Pure: no I/O, no async, no clocks. All business rules live here.
- `packages/core-wasm` (`@hamonn/core`) — wasm build + typed TS facade. `pkg/` is build output (gitignored).
- `packages/shell` (`@hamonn/shell`) — ports (`GitHost`, `GitWire`, `Store`, `Registry`), services, Hono API, HTML UI.
- `packages/adapters/*` — host/wire/store implementations + `contract/` (suites every adapter must pass).
- `apps/worker` (Cloudflare), `apps/node` (self-host), `apps/cli` (`hamonn`).
- `docs/` — spec, ADRs (`docs/adr/`), pain points, adapter guide, sprint plans (`docs/plans/`).

## Commands (one each, no hidden steps)
- `pnpm build:wasm` — build the kernel to `packages/core-wasm/pkg` (needs Rust + wasm-pack; run once before TS tests).
- `pnpm test` — all TS tests with the 100% coverage gate on `packages/shell`.
- `pnpm test:one <path>` — one test file. `pnpm test:rust` / `pnpm cov:rust` — kernel tests / 100% gate.
- `pnpm lint` (biome), `pnpm typecheck`, `pnpm check` (everything).
- `pnpm vectors` — regenerate `crates/hamonn-core/tests/vectors/*.json` after a kernel change (commit the result).
- `pnpm --filter @hamonn/worker build` — bundle the Worker (`wrangler deploy --dry-run`).

## Rules
1. **A rule that needs a test lives in Rust.** The shell fetches facts through ports, calls the kernel, persists the result.
   If you are writing an `if` about lane state, claims, readiness or landing in TypeScript, move it to the kernel.
2. Kernel stays at 100% lines + functions; `packages/shell` at 100% lines/branches/functions/statements. Never lower a threshold.
3. New adapter = implement the port + pass `packages/adapters/contract`. No network in unit tests; fakes are deterministic.
4. Landing proof is the product: never mark a lane LANDED without `is_ancestor` evidence (kernel enforces; keep it that way).
5. No secrets in the repo. Tokens are short-lived, minted per landing, never stored (`Token.secret` is not persisted).
6. Structured logs only (`log.info("event.name", {laneId, projectName})`), never `console.log("text")`.
7. Conventional commits; PRs ≤ 400 lines; add a changeset for user-visible changes; `fix:` commits carry
   `Detected-by:` / `Introduced-in:` trailers.
8. ADRs go in `docs/adr/NNN-title.md` (short MADR).

## Forbidden
Pushing to an integration branch from an agent lane; `git add -A` / `reset --hard` in a *shared* checkout (lanes make that
unnecessary: it is safe only inside your own fork); lowering coverage gates; skipping or deleting a failing test.
