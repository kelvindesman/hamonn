# Contributing to hamonn

Thanks for helping. hamonn is small on purpose; the best contributions are **adapters**, **bug reports with a failing
test**, and **sharper kernel rules**.

## Dev setup (≈5 minutes)
```bash
nvm use                       # Node 22 (.nvmrc)
rustup show                   # installs the pinned toolchain + wasm32 target (rust-toolchain.toml)
cargo install wasm-pack cargo-llvm-cov --locked
pnpm install
pnpm build:wasm               # Rust -> packages/core-wasm/pkg
pnpm check                    # lint + typecheck + rust tests + TS tests with coverage gates
```
Run one test file: `pnpm test:one packages/shell/test/service.test.ts`.

## Where does my change go?
| Change | Place |
|---|---|
| A rule about lanes, claims, readiness, landing | `crates/hamonn-core` (+ test, + `pnpm vectors`) |
| Orchestration, HTTP routes, UI | `packages/shell` |
| A new git host / store / landing engine | `packages/adapters/<name>` |
| Agent ergonomics | `apps/cli` |

## Write an adapter in an hour
A host adapter implements the `GitHost` port (`packages/shell/src/ports.ts`) — eight verbs:
`fork`, `mintToken`, `revokeToken`, `headSha`, `readFile`, `changedPaths`, `remoteUrl`, and optionally `mergeBase` / `subscribe`.

1. Create `packages/adapters/<host>/` with `src/index.ts` exporting a class that `implements GitHost`.
2. Write `test/<host>.test.ts`:
   ```ts
   import { describeGitHostContract } from "@hamonn/contract";
   describeGitHostContract("<host>", async () => ({ host, embedsToken, seed, commit, cleanup }));
   ```
   `seed`/`commit` create repos and commits on the (fake or real) host. A fake transport backed by real bare git repos
   (see `packages/adapters/github/test/fake-github.ts`) is the recommended way to test REST adapters offline.
3. Landing needs nothing from you: every host speaks git smart-HTTP, so `GitWire` implementations are host-independent.
4. Add a row to `docs/adapters.md` and be explicit about what is *live-tested* versus *fixture-tested*.

## Commits and PRs
Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). PRs ≤ 400 lines, link the `docs/spec.md`
section they implement, include a changeset (`pnpm changeset`) for user-visible changes. `fix:` commits add
`Detected-by:` and `Introduced-in:` trailers so we can measure how defects escape.

## Ground rules
Coverage gates are config, never lowered. No network in unit tests. No secrets in the repo (CI runs gitleaks).
Be kind: see `CODE_OF_CONDUCT.md`.
