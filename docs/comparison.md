# Comparison and limitations

## hamonn vs. "GitHub with agents on top"
| | GitHub / GitLab + agents | hamonn |
|---|---|---|
| Who may write the integration branch | any admin token (agents act as the admin) | only the coordinator, with a per-landing 600 s token |
| Isolation of concurrent agents | convention (branches, worktrees) | a fork per lane with a fork-scoped token |
| "Is it landed?" | green CI on a branch | lane head is an ancestor of the integration head, re-read from the host |
| Duplicate work | found in review | claim overlap flagged at open; candidates compared |
| Agent context | chat/memory outside the repo | `.lane/<id>/` ledger in the repo |
| Admission control | convention | serial landing queue |
| Human-only paths | commit-trailer hooks | gate sign-off enforced at landing |

hamonn is **complementary**: GitHub/GitLab remain the human-facing home (via adapters). The point is to put the coordination
layer where it can be enforced.

## Limitations (v0.1)
- **Cloudflare Artifacts** has been run live once, end to end (the demo, 2026-10-14; see `docs/adapters.md`), not under
  load. Artifacts is a beta (Workers Paid; billing from 2026-10-14).
- **Landing engine bounds (Workers):** isomorphic-git, in memory (64 MiB cap), no rename detection, single merge base — a
  criss-cross history fails the lane with an error ("rebase the lane"). Use `gitwire-system-git` (Node/container) for real
  recursive merges.
- **Claims are declared, not enforced** by the git host; hamonn detects and blocks landing, it cannot prevent a push to a fork.
- **Claim overlap is a heuristic** (literal-prefix based for glob-vs-glob): false positives possible, false negatives not.
- **Fork storage grows**; there is no archive GC yet.
- **No review UI, issues, or LFS.** Checks are reported to hamonn; it does not run CI.
- **GitHub tokens:** PAT passthrough is not fork-scoped; a GitHub App provider is required for true isolation.
- **Merge preview** (dry-run merge on each push) is not implemented; `mergePreview` stays `unknown` until a landing attempt.
- **GitLab/Bitbucket adapters are not written.**
- **The Deploy-to-Cloudflare button** needs the workspace packages published to npm (they are `workspace:*` today), and it is
  unverified whether the button auto-provisions the Artifacts binding. Fallback: deploy, enable Artifacts, run `hamonn setup`.
