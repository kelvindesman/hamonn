# Submission sheet — Cloudflare "Build the next-gen git platform" competition

Copy-paste text for each form field. **The entrant fills in and submits the form by hand**: the official rules void
automated entries. Deadline: **2026-10-14, 11:59 PM PDT**. Eligibility (legal resident of the US or Canada, 18+) is the
entrant's own declaration.

## Team
- Team name: **hamonn**
- Members: Kelvin Desman (solo)
- Email: kelvin@lokerdollar.com
- Location: *(entrant fills in)*

## Project name
hamonn: a landing layer for concurrent coding agents

## Live demo
<https://hamonn.kelvin-6d2.workers.dev>

## Public repository
<https://github.com/kelvindesman/hamonn> (MIT)

## Demo video
`hamonn-demo.mp4`: 5–10 minutes, voiced over. Recorded live against the deployment above with `demo/record/record.mjs`.

## Vision (what you built and why)
Coding agents now work in parallel, but git hosts still assume one human per working tree. I ran up to 886 concurrent agent
sessions on one production repository and logged about twenty named incidents. `reset --hard` wiped a peer's edits,
`add -A` swept 46 peer files, two agents built the same feature, and "green CI" was reported on a change that never shipped.
Every fix I wrote was a client-side hook, because the host has no idea agents exist.

hamonn moves those fixes to where agents cannot bypass them. Each agent works in its own fork, called a **lane**, with a
token that only works on that fork. It declares **claims** on the paths it will touch, and hamonn warns about overlap when
the lane opens. Work is re-checked for **drift** on every push. The agent's intent and handoff live in the repo as an
in-repo ledger, so a new session resumes where a dead one stopped. When several agents attempt the same task, the
**candidates** are compared side by side and one is picked; the rest are archived with their context.

A single coordinator is the only writer of `main`. It lands one lane at a time, server-side, with a merge commit. A lane is
marked **LANDED** only when its head is proven to be an ancestor of `main`, re-read from the host. Changes to human-only
paths need a sign-off. When a peer lands first, the lane is marked **BEHIND** with the exact files that conflict.

The rules live in a small Rust kernel with 100% test coverage, so the same guarantees hold on Cloudflare, on a laptop, or
in front of GitHub.

## How you used Cloudflare (Workers + Artifacts)
- **Artifacts is the git host.** Each project is one Artifacts repo, and each lane is an Artifacts **fork**.
  - Every lane gets its own short-lived **write token**, minted through the binding, so an agent can never push to `main`
    or to a peer's fork.
  - The coordinator mints a fresh token for each landing, merges over git smart-HTTP inside the Worker, then re-reads
    history through the binding (`log`, `readCommit`, `readTree`) to prove ancestry.
  - New project repos are created through the binding (`POST /api/admin/repos`), so no API token is ever stored.
- **Workers** serves the API, the CLI endpoint and the server-rendered board. Landing runs inside the Worker using the Rust
  kernel compiled to wasm.
- **Durable Objects** (SQLite-backed) give each project a single serialized state machine and landing queue, plus a
  registry DO for the project list. Serializing per project is what makes "one lane at a time" safe under concurrency.
- **Queues** carry Artifacts `repo.pushed` events into the coordinator (`hamonn-events`), so readiness updates whether an
  agent pushes through the CLI or with plain `git push`.
- **Workers Builds** deploys the Worker from an Artifacts repo that holds hamonn's own source. The platform hosts itself.

## Judging rubric map
- **Originality and quality of the agent-collaboration prototype (50%)**
  - Lanes as host-side forks with scoped tokens.
  - A single coordinator writer.
  - Landing with an ancestor proof that is checked again with plain git in the video (`demo/verify.sh`).
- **Concurrency, coordination, context preservation, review and conflict handling (25%)**
  - Three agents and a peer working concurrently.
  - Overlap hint when a lane opens; drift flagged on push.
  - Context resumed from the in-repo ledger after a session dies.
  - Candidate compare and pick; BEHIND with exact files, then rebase; gated sign-off.
- **Ease of use / UX (25%)**
  - One CLI (`hamonn open / push / handoff / checks / land / rebase`).
  - A live board with states encoded by label and glyph, and the ancestor proof shown on every landed card.
  - A candidate comparison page.
  - A one-command demo (`demo/*.sh`).

## How to run it
- **Hosted:** open <https://hamonn.kelvin-6d2.workers.dev>. Boards are public to read; actions need the admin key.
- **Your own Cloudflare account (Workers Paid, Artifacts enabled):**
  1. Import the repo into Artifacts.
  2. Go to Workers & Pages → Create → *Continue with Artifacts*.
  3. Set the build command to `bash scripts/cf-build.sh`.
  4. Set the deploy command to `pnpm --filter @hamonn/worker run deploy`.
  5. Create the queue `hamonn-events`.
  6. Add the `HAMONN_ADMIN_KEY` secret.
  7. Run:
     ```bash
     MODE=artifacts HAMONN_URL=<your worker URL> HAMONN_KEY=<key> bash demo/seed.sh
     ```
  8. Run `demo/agent-a.sh`, `agent-c.sh`, then `LAND=1 demo/agent-b.sh`.
- **Laptop, no cloud:**
  1. Run:
     ```bash
     pnpm install && pnpm build:wasm && pnpm --filter @hamonn/node start
     ```
  2. Run `bash demo/seed.sh` and the same agent scripts. Full steps are in `demo/run-demo.md`.

## Checklist before pressing Submit
- [ ] Video is MP4, between 5 and 10 minutes long, and voiced over.
- [ ] Repo is public and `LICENSE` is MIT.
- [ ] "Built using Workers and Artifacts" box is ticked.
- [ ] Eligibility confirmed by the entrant.
