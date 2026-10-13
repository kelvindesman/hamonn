# syntax=docker/dockerfile:1.7
#
# hamonn self-demo video, fully in Docker:
#   docker build -t hamonn-demo .
#   docker run --rm --init --ipc=host -v "$PWD/demo-out:/out" hamonn-demo     # -> demo-out/hamonn-demo.webm
#
# What runs inside: the real hamonn server (Node + SQLite + system git), the real `hamonn` CLI and demo agents
# on real git repos, and headless Chromium filming the board plus a live terminal. No network is needed at run time
# (Tailwind CSS is pre-compiled, htmx is served locally).

# Where the wasm kernel comes from: build it from Rust (default), or reuse a pre-built packages/core-wasm/pkg:
#   docker build --build-arg WASM_SOURCE=wasm-prebuilt -t hamonn-demo .
ARG WASM_SOURCE=wasm-build

FROM rust:1-bookworm AS wasm-build
# (extra-ca: see the note on the demo stage below)
RUN --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export SSL_CERT_FILE=/run/secrets/extra-ca CARGO_HTTP_CAINFO=/run/secrets/extra-ca; fi; \
    rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export SSL_CERT_FILE=/run/secrets/extra-ca CARGO_HTTP_CAINFO=/run/secrets/extra-ca; fi; \
    wasm-pack build crates/hamonn-core --release --target web --out-dir /pkg --out-name hamonn_core

FROM scratch AS wasm-prebuilt
COPY packages/core-wasm/pkg /pkg

FROM ${WASM_SOURCE} AS wasm

# Playwright's image: Node 22, git, Chromium + fonts. Version must match demo/record/package.json (playwright 1.56.1).
FROM mcr.microsoft.com/playwright:v1.56.1-noble AS demo
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1 \
    OUT_DIR=/out
# Behind a TLS-inspecting proxy? Pass its CA:  docker build --secret id=extra-ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    npm install -g pnpm@10.28.0
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=extra-ca,required=false \
    if [ -f /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    pnpm install --frozen-lockfile
COPY --from=wasm /pkg packages/core-wasm/pkg
RUN node scripts/optimize-wasm.mjs
VOLUME /out
ENTRYPOINT ["node", "demo/record/record.mjs"]
