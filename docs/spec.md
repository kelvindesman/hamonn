# hamonn spec (as built)

Source of truth for PRs: "Implements spec §N". This is the original plan trimmed to what exists, with deviations marked **[changed]**.
Rationale and incident evidence: `docs/pain-points.md`. Architecture: `docs/architecture.md`.

## §1 Thesis
Agents never hold a write token to the integration branch. Each works in its own fork (a *lane*), declares *claims*, carries
context in-repo, and a *coordinator* lands changes server-side one at a time with an ancestor proof. hamonn is the **landing
layer** between agents and any git host; Cloudflare Artifacts is the default adapter.

## §2 Domain (kernel: `crates/hamonn-core`)
- **LaneState**: `OPEN PUSHED READY LANDING LANDED BEHIND ARCHIVED FAILED`. Edges (exact):
  `OPEN→{PUSHED,ARCHIVED}  PUSHED→{PUSHED,READY,ARCHIVED}  READY→{PUSHED,LANDING,ARCHIVED}  LANDING→{LANDED,BEHIND,FAILED}
  BEHIND→{PUSHED,ARCHIVED}  FAILED→{PUSHED,ARCHIVED}  LANDED→∅  ARCHIVED→∅`.
- **READY** iff: pushed ∧ every required check's latest result *for the current head* is `pass` ∧ intent + handoff ledger
  present ∧ no drift (unless `allowDrift`) ∧ (no gated path touched ∨ signed). **[changed]** checks are bound to a head.
- **Kernel API** (`call(name, json)`): `transition planOpen applyPush evaluate settle sign archive canEnqueue planLand
  applyLandResult pickWinner queueOrder nextInQueue queuePosition claimsOverlap drift matches parseLedger compare`.
  **[changed]** `settle` (PUSHED↔READY), `sign`, `archive`, `canEnqueue`, `queueOrder/queuePosition` were added; `evaluate` takes
  no separate ledger argument (the lane carries it).
- **Claims**: glob dialect `? * ** **/`, trailing `/` = `dir/**`. Overlap is a conservative heuristic. Drift ignores `.lane/`.
- **Landing rule**: `applyLandResult` yields `LANDED` only for `clean ∧ proof.isAncestor`; `conflict → BEHIND(files)`;
  anything else `→ FAILED(reason)`.
- Constants: lane token TTL 3600 s; landing token TTL 600 s; handoff ≤ 10 non-empty lines (warning).

## §3 Ports (`packages/shell/src/ports.ts`)
`GitHost { kind, fork, mintToken, revokeToken, headSha, readFile, changedPaths, remoteUrl; mergeBase?, subscribe? }`,
`GitWire { land, isAncestor }`, `Store`, `Registry`, `Clock`, `Logger`. **[changed]** `mergeBase` was added (optional) so rebased
lanes are diffed from their real fork point; `isAncestor` lives on `GitWire` and re-fetches rather than trusting the push.

## §4 Services (`packages/shell/src/service.ts`)
`createProject openLane mintLaneToken integrationRemote onPushed handlePushEvent recordCheck sign archive enqueueLand
drainQueue pickWinner lane task board`. Every mutation runs under `store.withLock(project)`. `onPushed` is idempotent per head.

## §5 HTTP API (`packages/shell/src/http.ts`) — bearer `HAMONN_ADMIN_KEY` on all non-GET
`POST /api/projects` · `GET /api/projects/:p` (board) · `POST …/lanes[?strict=1]` · `GET …/lanes/:id` · `POST …/lanes/:id/{token,pushed,checks,sign,land,archive}` ·
`POST …/integration-remote` **[added]** · `POST …/drain` **[added]** · `GET …/tasks/:t` · `POST …/tasks/:t/pick` · `POST /hooks/:host` · `GET /healthz`.
UI: `/p/:project` board, `/t/:project/:task` candidates, `/l/:project/:id` lane (htmx poll every 2 s).

## §6 Landing (`GitWire`)
Merge commit (never FF, never squash) → push with a 600 s write token → coordinator re-reads integration head and re-checks
ancestry. Engines: `gitwire-isomorphic` (Workers) and `gitwire-system-git` (Node). Conflict → file list.

## §7 Ledger **[changed]**
`.lane/<laneId>/{intent,handoff,evidence}.md` (namespaced per lane; ADR-005).

## §8 Runtimes
- Worker: `ProjectDO` per project (SQLite, serial queue via alarm), `RegistryDO`, Queue consumer for `cf.artifacts.repo.pushed`.
- Node: Hono + `node:sqlite` + system git + `/hooks/github`.
- CLI: `open push handoff evidence checks land rebase status token archive setup`.

## §9 Quality gates
Kernel 100% lines/functions (`cargo llvm-cov`); `packages/shell` 100% lines/branches/functions/statements; contract suites for
every host, wire and store; end-to-end test over real git; landing verified inside workerd.

## §10 Not built (yet)
GitLab/Bitbucket adapters · merge preview · archive GC · live Artifacts run · Deploy-button verification · static Rust CLI · `gix` wire.
