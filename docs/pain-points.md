# Pain points of traditional git in the agentic age

Every row is a real, dated incident from a single production repository (lokerdollar.com) that ran up to **886 concurrent
Claude Code sessions on one `.git`** and accumulated ~20 named incidents. Every mitigation that repo wrote was a *client-side
hook*, because the host has no concept of an agent. hamonn moves each mitigation to a place agents cannot bypass.

| # | Pain | Why git/GitHub can't help | Incident | hamonn primitive |
|---|---|---|---|---|
| 1 | One `.git` shared by N agents: HEAD, index, stash and config are global; last writer wins silently | git assumes one human per working tree | `reset --hard` destroyed a peer's unstaged edits (08-30); `stash pop` returned a peer's stash (08-17); `add -A` swept 46 peer files (07-22); `core.bare` flipped (08-10, 08-28); a test ran `add -A` and deleted 8,900 files (08-30) | **Lane = fork.** Token scoped to the fork only |
| 2 | Any admin token can write `main`; branch protection skips admins; agents act as the admin | auth is per-user, not per-task | a red merge (#2554, e2e red); "Auto merge when green" let a peer merge 1 PR/min | **Coordinator is the sole writer** of the integration branch |
| 3 | No ownership/claim model; agents rebuild what a peer is building or already landed | PRs are discovered after the fact | duplicate feature (08-27, 09-03); #4824 superseded by #4821 merged 9 minutes earlier; 09-05 | **Claims** declared at open; overlap check at open; drift check at every push |
| 4 | Agent context lives outside the repo (chat, memory files, a "brain" repo) and dies with the session | git stores code, not intent | stale brain (08-31); a 2 h build reaped uncommitted (07-29); a handoff runbook swept peer files (10-06) | **In-repo ledger** `.lane/<id>/{intent,handoff,evidence}.md` |
| 5 | No way to compare N attempts at the same task and pick one | the PR model is 1 branch = 1 change | none existed; agents competed by racing to merge | **Candidates** per task: compare table, pick a winner, losers archived with their context |
| 6 | Merge happens client-side or via squash; later pushes get stranded; one PR swallows another | squash rewrites history; the merge button races | #4155 squash stranding (08-28, 08-30); #4154 merged as a no-op | **Server-side merge commit**, serialized, conflict file list returned |
| 7 | "Green CI" ≠ "my change is on main" | CI runs on a branch head, not on the landed result | "green CI on your PR is not evidence your PR shipped" (08-28) | **Landed proof:** lane head is an ancestor of the integration head, else the lane FAILS loudly |
| 8 | Human-only paths enforced with commit-trailer regex hooks and owner runbooks | hooks are client-side, bypassable, per-machine | the HUMAN_GATE_PATHS runbook swept peer files (10-06) | **Path-gated sign-off**, enforced where landing happens |
| 9 | CI admission is a client-side convention ("≤2 PRs in flight") | the host has no queue concept for agents | 7 PRs in CI (09-21); preview deploys crashed above 2 runs; pr-train adopted on 3 of 200 merges | **Landing queue** is the admission control (one at a time) |
| 10 | Fan-out of worktrees fills disk/RAM; background agents are never woken | worktrees are local; CI waits are polled | a 13-wide fan-out filled the disk (07-21); a reap loop force-removed 52/60 worktrees (08-12); 6 agents stalled 48–110 min (09-14) | Forks live on the host; agents clone only what they need; **events push state** |
| 11 | Lock-in: fixes tied to GitHub Actions/hooks; moving host = rewriting the process | tooling targets one host's API | n/a (design goal) | **Ports/adapters:** the core knows no host |

## What hamonn deliberately does not claim
- It does not stop an agent from *writing* outside its claims in its own fork — that is the point of a fork. It makes the
  mismatch visible (`DRIFT`) and **refuses to land it** until the lane is fixed or explicitly allowed.
- It is not a code-review product, an issue tracker, or a CI system. Checks are reported *to* hamonn (`hamonn checks unit=pass`),
  bound to the head they ran against, and invalidated by any re-push.
