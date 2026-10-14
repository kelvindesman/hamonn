# Video script (~7 min, narrated by the owner)

Setup: board open at `/p/demo`, terminal split into A / B / C / owner. Repo seeded with `demo/seed.sh`.

| Time | Scene | Say | Show |
|---|---|---|---|
| 0:00 | The problem | "886 concurrent agent sessions on one .git. ~20 named incidents. Every fix I wrote was a client-side hook, because the host has no idea agents exist." | `docs/pain-points.md` table; the hook file |
| 1:00 | Three lanes | "Each agent opens a lane — a fork with a token that only works on that fork." | `hamonn open` ×3; board columns; **C's overlap hint** |
| 2:00 | B wrecks its checkout | "reset --hard, stash, add -A: the commands that cost me work. Here they only hurt B's own fork." | B's script; board: nothing else moved; `⚠ DRIFT`, `gate: unsigned` |
| 2:45 | Kill A, resume | "Context lives in the repo." | delete A's dir, re-clone the lane, read `.lane/1/handoff.md` |
| 3:30 | Compare A vs C | "Two attempts at T-17: compare, pick, archive the loser with its context." | `/t/demo/T-17`; pick A |
| 4:30 | Land with proof | "`LANDED` isn't green CI; it's: the lane head is an ancestor of the integration head, re-read from the host." | `hamonn land` → `LANDED @ sha` = board head |
| 5:00 | BEHIND → rebase | "A peer landed first. The coordinator tells B exactly which file." | `BEHIND: src/cron/job.ts` → `hamonn rebase` → LANDED |
| 5:30 | Gate | "Human-only paths are enforced where landing happens." | owner clicks **sign** |
| 6:15 | Architecture | "Rust kernel, TypeScript shell, ports and adapters. Same core on Cloudflare Artifacts, GitHub, or a laptop." | `docs/architecture.md`; 100% kernel coverage; Node e2e |
| 6:45 | Limits + call to action | "Beta Artifacts, isomorphic-git bounds, claims are declared not enforced — all in the README." | repo link, Deploy button |

Honesty checklist before recording: say which adapters were live-tested (local-fs, workerd landing, Cloudflare Artifacts) and
which were fixture-tested (github), matching `docs/adapters.md`.

Recording: `demo/record/README.md` films this script against the live deployment (silent; voice over with `scenes.txt`).
