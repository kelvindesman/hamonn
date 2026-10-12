# Sprint 01 — 2026-10-12 (build day 1, executed in one session)

Status legend: ✅ done and verified · 🟡 done, verification pending · ⬜ not started

- ✅ Rust kernel: state machine, claims, ledger, readiness, landing rules, candidates, queue — 41 tests, 100% lines/functions
- ✅ wasm build + typed TS facade + vector replay (Rust → wasm → TS)
- ✅ Shell: ports, services, HTTP API, HTML board — 100% lines/branches/functions/statements
- ✅ Adapters: local-fs, system-git wire, isomorphic wire (verified inside workerd), store-sql/sqlite/memory
- ✅ Node runtime + end-to-end test over real git (3 agents, drift, gate, candidates, land, BEHIND → rebase → land)
- ✅ CLI (`hamonn`) tested against the Node server
- ✅ GitHub adapter (fake REST over real git) + webhook normalizer
- 🟡 Cloudflare Artifacts adapter: contract-tested against a fake binding over real git objects; **needs a live run**
- 🟡 Worker: bundles (256 KB gz, 267 KB wasm), boots in workerd, DO + wasm exercised; Artifacts binding cannot run locally
- ⬜ Deploy to a real Cloudflare account (needs `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID`); subscriptions via `hamonn setup`
- ⬜ Deploy-button test from a fresh account; npm publish of workspace packages
- ⬜ GitLab / Bitbucket adapters
- ⬜ Demo recording, dogfood registration

## Found by tests (and fixed)
1. Ledger collisions between landed lanes → per-lane ledger (ADR-005).
2. Rebased lanes showed upstream changes as drift → merge-base aware touched paths.
3. Branch mode registered the shared repo as one lane's fork → registry only for forks.
4. UI routes returned 500 for missing lanes/tasks → proper 404s.
5. Stale green checks survived a re-push → checks are bound to the head they ran on.
