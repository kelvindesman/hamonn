# ADR-002: Ports and adapters; landing is host-independent

Status: accepted

The core must not know which git host it runs on. Four ports: `GitHost` (fork, mintToken, revokeToken, headSha, readFile,
changedPaths, remoteUrl; optional mergeBase/subscribe), `GitWire` (land, isAncestor), `Store`/`Registry`, `Clock`/`Logger`.

Key insight: every host speaks git smart-HTTP, so merging+pushing (`GitWire`) is written once and shared; only a handful of
host *control-plane* verbs differ. Adding a host = implement `GitHost`, pass `packages/adapters/contract`.

Contract suites (`describeGitHostContract`, `describeGitWireContract`, `describeStoreContract`) run against every adapter with
the most faithful offline backing available: real git for local-fs, a fake binding over real git objects for Artifacts, a fake REST
server over real git for GitHub, `git http-backend` for the wires.

Consequence: "supports host X" is a claim backed by the same executable spec as every other host. Docs must state live vs fixture.
