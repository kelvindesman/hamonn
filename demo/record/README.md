# Self-demo video (Docker)

hamonn records its own demo. One container starts the real server, runs the real agents (`demo/agent-*.sh`, real git, the
real `hamonn` CLI) and films the board next to a live terminal in headless Chromium.

```bash
docker build -t hamonn-demo .
docker run --rm --init --ipc=host -v "$PWD/demo-out:/out" hamonn-demo
# -> demo-out/hamonn-demo.webm   (~100 s, 1280x720)
#    demo-out/poster.png         (last frame)
#    demo-out/transcript.txt     (everything shown in the terminal pane)
```
Or: `pnpm demo:video`. Convert for sharing: `ffmpeg -i demo-out/hamonn-demo.webm -c:v libx264 -pix_fmt yuv420p demo-out/hamonn-demo.mp4`.

## What the video shows
Title card → seed → **A** (clean path) → **C** (same task, overlap hint) → a fresh checkout resumes from the in-repo ledger →
**compare** A vs C and pick the winner → A lands, C archived → **B** wrecks its own checkout (`reset --hard`, `stash`), drifts,
hits a gated path, owner signs, peer **D** lands first → B is `BEHIND: src/cron/job.ts` → rebase → `LANDED` →
`verify.sh` checks with plain git that every landed lane head is an ancestor of `main` → outro card.

## Knobs
| Env | Default | |
|---|---|---|
| `DWELL_MS` | `4000` | how long each scripted step stays on screen (the recorder presses Enter for the scripts' `PAUSE=1` waits) |
| `OUT_DIR` | `/out` in Docker, `./demo-out` otherwise | output directory |

Behind a TLS-inspecting proxy, add `--secret id=extra-ca,src=/path/to/ca.pem` to `docker build`.

`--build-arg WASM_SOURCE=wasm-prebuilt` reuses a local `packages/core-wasm/pkg` instead of building the kernel from Rust
(handy when the Rust toolchain image is not reachable). Without Docker: `pnpm build:wasm && node demo/record/record.mjs`
(needs Chromium; set `PLAYWRIGHT_BROWSERS_PATH`).

## How it stays honest
The recorder only orchestrates timing and captions. Everything on screen is produced by the actual system: board HTML from the
server, terminal lines from the scripts' stdout, and the final proof from `git merge-base --is-ancestor`. The run fails (and
no video is written) if any scripted step exits non-zero. It is fully offline: the board's Tailwind CSS is pre-compiled
(`tailwind.config.cjs`) and htmx is served from `node_modules`, intercepted in place of the CDN URLs.

The video has captions but no voice-over; `docs/video-script.md` has the narration for a human recording.
