# ADR-004: isomorphic-git landing on Workers, system git elsewhere

Status: accepted

Artifacts has no commit/merge/branch API (writes are git protocol only), so the coordinator must perform the merge itself over
smart-HTTP. On Workers there is no `git` binary, so landing uses isomorphic-git with a small in-memory `fs` (`MemoryFS`),
`http/web`, and token auth embedded in the remote URL. Verified in workerd (merge commit, push, ancestor proof).

Known bounds, reported as `error` rather than guessed: in-memory size cap (64 MiB default), no rename detection, a single merge
base (criss-cross histories fail → "rebase the lane"), Artifacts push is git protocol v1 only.

Fallback with an identical interface: `gitwire-system-git` (real `git merge --no-ff`), used by the Node runtime and available
to run inside a Sandbox/container for Workers when repos outgrow the in-memory limit.

The proof is never trusted from the wire: after a clean push the coordinator re-reads the integration head from the host and
re-fetches it to check ancestry (`isAncestor`).
