#!/usr/bin/env bash
# Build command for Cloudflare Workers Builds (dashboard: Settings -> Build -> Build command).
# The build image has Node + pnpm but no Rust, so install a minimal toolchain, then build the wasm
# kernel the same way CI does. Deploy command: `pnpm --filter @hamonn/worker run deploy` (plain `pnpm deploy` is a pnpm builtin).
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown >/dev/null
command -v wasm-pack >/dev/null 2>&1 || npm install -g wasm-pack

corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile
pnpm build:wasm
