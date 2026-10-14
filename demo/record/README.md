# Recording the demo video

`record.mjs` films the demo against a **live** hamonn deployment: it runs the real demo scripts (real git, real CLI, real
Cloudflare Artifacts) and records the live board next to a terminal in headless Chromium at 1920×1080. The video is silent;
`scenes.txt` gives each scene's timestamp and a suggested voice-over line.

```bash
cd demo/record && npm install && npx playwright install chromium && cd ../..
HAMONN_URL=https://hamonn.<sub>.workers.dev HAMONN_KEY=<admin key> HAMONN_PROJECT=<fresh project name> \
  node demo/record/record.mjs
ffmpeg -i demo-out/hamonn-demo.webm -c:v libx264 -pix_fmt yuv420p -crf 20 demo-out/hamonn-demo.mp4
```

Each run creates a new Artifacts repo `<project>-app` and a new project, so use a fresh `HAMONN_PROJECT` every time.
`DWELL_MS` (default 5000) sets how long each scripted step stays on screen. Outputs go to `demo-out/` (gitignored).
