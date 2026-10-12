# Adapters

A host adapter implements the `GitHost` port. Landing is host-independent (`GitWire`), so adding a host means implementing
a handful of REST verbs and passing `packages/adapters/contract`.

## Capability matrix
| Verb | cloudflare-artifacts | github | gitlab | bitbucket | local-fs |
|---|---|---|---|---|---|
| fork | `repo.fork()` | `POST /repos/{o}/{r}/forks` (async; polled) | `POST /projects/:id/fork` | `POST /repositories/{ws}/{slug}/forks` | `git clone --bare` |
| mintToken | `createToken(scope, ttl)` — native, repo-scoped | PAT passthrough, or inject a GitHub App token provider | project access token | repository access token | n/a (issued, not enforced) |
| revokeToken | `revokeToken(id)` | provider hook (no-op for PAT) | revoke token | revoke token | bookkeeping only |
| headSha | `log({ref, limit: 1})` | `GET /commits/{ref}` (sha media type) | commits API | commit API | `git rev-parse` |
| readFile | `readFile({ref, path})` | contents API (raw) | files API | src API | `git show` |
| changedPaths | `readTree` walk | compare API (+ renames) | compare API | diffstat API | `git diff --name-only` |
| mergeBase (opt.) | first-parent `log` | compare `merge_base_commit` | compare | — | `git merge-base` |
| events | Queues event subscription | webhook `push` (HMAC) | webhook `Push Hook` | webhook `repo:push` | `hamonn push` posts |

## Status — be precise about what was verified how
| Adapter | Status | Evidence |
|---|---|---|
| `local-fs` | complete | contract suite against **real git**; used by the end-to-end test and the CLI test |
| `cloudflare-artifacts` | complete, **not yet live-tested** | contract suite against a fake binding backed by *real git objects*; response field names for `log`/`readCommit`/`readTree` are handled defensively because the docs do not spell them out. **First live run on a real account is the remaining verification step.** |
| `github` | complete, fixture-tested | contract suite against a fake REST server over real git. The fake's response shapes are *hand-modelled from the REST docs, not recorded* from github.com. Default token mode is PAT passthrough (**not** fork-scoped) |
| `gitlab`, `bitbucket` | planned | no code yet; tracked as `adapter-request` issues |

## Landing engines (`GitWire`)
| Engine | Where | Notes |
|---|---|---|
| `gitwire-isomorphic` | Workers, anywhere with `fetch` | in-memory checkout (default cap 64 MiB), no rename detection, single merge base. Verified **inside workerd** (`apps/worker/test/workerd/run-smoke.mjs`) against git smart-HTTP |
| `gitwire-system-git` | Node, containers | real `git merge --no-ff`; rename detection, recursive strategy |

## Stores
`store-sql` (one implementation over a tiny `SqlDriver`): `store-sqlite` (`node:sqlite`) and the Durable Object driver in
`apps/worker`. `store-memory` is for tests. All pass the same `describeStoreContract` suite.

## Writing one
See [CONTRIBUTING.md](../CONTRIBUTING.md#write-an-adapter-in-an-hour).

### GitHub: getting fork-scoped credentials
With PAT passthrough every agent holds the same credential, so lane isolation is by convention. For real isolation provide
`tokens` to `GithubHost`: mint a GitHub App installation token restricted to the lane's fork
(`POST /app/installations/{id}/access_tokens` with `repositories: [fork]` and `permissions: {contents: "write"}`) and revoke
with `DELETE /installation/token`.
