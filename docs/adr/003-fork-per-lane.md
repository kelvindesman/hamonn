# ADR-003: A fork per lane, credentials scoped to the fork

Status: accepted

Shared-checkout incidents (reset --hard, stash pop, add -A, core.bare flips) come from N agents sharing one mutable `.git`. A
lane is a **fork** of the project repo with a write token that grants access to *only that fork*. The agent can do anything
inside its own fork; nothing it does can touch a peer or the integration branch. The coordinator is the only writer to
`main`, using a token minted per landing (600 s) and revoked.

`branch` mode (lane = `lane/<id>` on the project repo) is supported for hosts where forking per agent is unattractive; it is
weaker unless branch-scoped credentials exist, and is documented as such.

Cloudflare Artifacts makes this cheap (`repo.fork`, repo-scoped tokens, millions of repos). On GitHub, true scoping needs a
GitHub App token provider; PAT passthrough is a documented compromise.
