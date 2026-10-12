# Security policy

## Reporting a vulnerability
Please report privately via GitHub's **Security → Report a vulnerability** on `kelvindesman/hamonn`
(private advisory). Do not open a public issue. You will get an acknowledgement within 72 hours.

## What hamonn protects, and what it does not
- **Agents never hold a write credential to the integration branch.** They receive a short-lived token scoped to their own
  fork (Cloudflare Artifacts, local-fs) or — on GitHub with the default PAT passthrough — a token that is *not* fork-scoped
  (weaker; use a GitHub App token provider, see `docs/adapters.md`).
- Landing tokens are minted per landing (TTL 600 s), used once, revoked, and never persisted.
- Every non-GET API request needs `HAMONN_ADMIN_KEY` (constant-time compared). Treat it like a root credential: anyone who
  has it can open, sign and land lanes.
- Gate sign-off (`gatedPaths`) is enforced by the coordinator, but **claims are declared, not enforced** by the git host:
  a lane can still push outside its claims to its own fork; hamonn flags it as drift and refuses to land it.
- Webhooks are authenticated with an HMAC secret (`HAMONN_HOOK_SECRET`). The Worker's `/internal/*` routes are reachable only
  through the Durable Object stub.

## Handling secrets
Never commit `.dev.vars`/`.env`. Git credentials embedded in remote URLs are scrubbed from error messages and logs, but
agents' `.git/config` will contain their short-lived fork token — rotate with `hamonn token`.
