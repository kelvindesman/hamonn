# ADR-001: Rust functional core, TypeScript imperative shell

Status: accepted (2026-10-12)

## Context
Every rule that decides whether work lands (lane state machine, claim overlap, drift, readiness, the landing proof) is a place
where a bug destroys someone's work. Those rules want exhaustive tests and zero ambient state. The surrounding code (Workers
bindings, Durable Objects, isomorphic-git, Hono, the Artifacts binding types) is TypeScript-native.

## Decision
- `crates/hamonn-core` (Rust): pure functions over serde types — zero I/O, zero async, no clock, no ids. Compiled natively
  (tests, coverage) and to `wasm32` (`wasm-pack --target web`, `initSync`), exposed as one JSON entry point `call(name, json)`.
- TypeScript shell: all I/O, calling the kernel for every decision. **The shell contains no business rule.**
- Quality gates: `cargo llvm-cov` 100% lines + functions; `proptest` for `transition` totality, claim-overlap symmetry and
  `drift ⊆ touched`; Rust-generated vectors replayed against the wasm from TS.

## Alternatives
| | TypeScript only | Rust everywhere |
|---|---|---|
| Workers runtime | native | `workers-rs`; no Artifacts types, no wasm git push library |
| Deploy button / Workers Builds | default path | needs a custom build command |
| Build time / reliability in a 2.5-day window | best | compile-fix loops |
| Rule safety | tests only | types + tests |

## Consequences
+ The decision logic is unit-tested to 100% and identical on Workers and Node.
+ Wasm instance is created once per isolate (`createKernel(module)`); 548 KB unoptimized (no `wasm-opt` in the build env yet).
− A Rust toolchain is needed to build `pkg/`; published npm packages ship the prebuilt wasm.
− Two type definitions (serde ↔ TS) are kept in sync by the vector replay, not generated.
Follow-ups: static `hamonn` Rust CLI for sandboxes; `gix`-based wire for Node.

## Deviations from the first plan (recorded for honesty)
- `wasm-pack --target web` (not `bundler`): Workers import `.wasm` as a `WebAssembly.Module`, which suits `initSync`.
- Node store uses built-in `node:sqlite` instead of `better-sqlite3` (no native build step).
- `evaluate` reads the ledger status from the lane instead of taking it as a separate argument (one source of truth).
