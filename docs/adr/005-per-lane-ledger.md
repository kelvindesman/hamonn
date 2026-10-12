# ADR-005: The in-repo ledger is namespaced per lane

Status: accepted (found by the end-to-end test)

The first design put the ledger at `.lane/{intent,handoff,evidence}.md`. When lane A landed, `main` gained A's
`.lane/intent.md`; lane B, which wrote the same path, then conflicted with it on every landing — the coordination layer was
creating the conflicts it exists to prevent.

Decision: `.lane/<laneId>/{intent,handoff,evidence}.md`. Lanes never collide; the ledger lands with the change and stays in
history as provenance (why this change exists, what state it was left in). `.lane/` paths never count as drift.

Related fix from the same test: touched-path detection starts from the **merge-base** with the integration head when the host
can compute it (`GitHost.mergeBase`), so a rebased lane does not inherit its peers' changes as false drift.
