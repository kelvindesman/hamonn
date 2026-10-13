// Records hamonn's self demo: starts a real hamonn server, drives the real demo scripts (real git, real CLI),
// and films the board + a live terminal in headless Chromium. Output: <OUT_DIR>/hamonn-demo.webm (+ poster, transcript).
//
//   docker build -t hamonn-demo . && docker run --rm -v "$PWD/demo-out:/out" hamonn-demo
//
// Fully offline: Tailwind CSS is pre-compiled and htmx served from node_modules (no CDN requests).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

const here = import.meta.dirname;
const ROOT = resolve(here, "../..");
const require = createRequire(import.meta.url);
const OUT = resolve(process.env.OUT_DIR ?? join(ROOT, "demo-out"));
const DWELL = Number(process.env.DWELL_MS ?? 4000); // how long each scripted step stays on screen
const KEY = "demo-key";
const HAMONN_PORT = 8787;
const STAGE_PORT = 8800;
const W = 1280;
const H = 720;
const SCRATCH = join(tmpdir(), `hamonn-selfdemo-${process.pid}`);

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const strip = (s) => s.replace(ANSI, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── shared stage state ────────────────────────────────────────────────────────
const state = { rev: 0, caption: "", sub: "", frame: "about:blank", log: [], card: null };
const set = (patch) => {
  Object.assign(state, patch);
  state.rev++;
};
const transcript = [];
const NOISE = /ExperimentalWarning|--trace-warnings/; // Node's node:sqlite notice: true, but not demo content
const logLine = (l) => {
  if (NOISE.test(l)) return;
  transcript.push(l);
  if (l.includes("⏎")) return; // pause markers are plumbing, not content
  state.log.push(l);
  if (l.startsWith("▶ ")) state.caption = l.slice(2);
  state.rev++;
};

// ── servers ───────────────────────────────────────────────────────────────────
const stageHtml = readFileSync(join(here, "stage.html"));
const stage = createServer((req, res) => {
  if (req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(stageHtml);
  }
});

const env = {
  ...process.env,
  HAMONN_ADMIN_KEY: KEY,
  HAMONN_KEY: KEY,
  HAMONN_URL: `http://localhost:${HAMONN_PORT}`,
  HAMONN_PROJECT: "demo",
  HAMONN_ROOT: join(SCRATCH, "repos"),
  HAMONN_DB: join(SCRATCH, "hamonn.db"),
  PORT: String(HAMONN_PORT),
  WORK: join(SCRATCH, "work"),
  DEMO_ECHO: "1",
  PAUSE: "1",
};

function pipeLines(stream) {
  createInterface({ input: stream }).on("line", (line) => logLine(strip(line)));
}

/** Run a demo script; feed it an Enter after `DWELL` each time it announces a pause (⏎). */
function runScript(file, args = [], extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("bash", [join(ROOT, "demo", file), ...args], {
      cwd: ROOT,
      env: { ...env, ...extraEnv },
    });
    for (const s of [child.stdout, child.stderr]) {
      createInterface({ input: s }).on("line", (line) => {
        logLine(strip(line));
        if (line.includes("⏎")) setTimeout(() => child.stdin.writable && child.stdin.write("\n"), DWELL);
      });
    }
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolveRun() : reject(new Error(`${file} exited ${code}`))));
  });
}

async function api(method, path, body) {
  const res = await fetch(`${env.HAMONN_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function waitFor(url, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
mkdirSync(env.HAMONN_ROOT, { recursive: true });
rmSync(join(OUT, "hamonn-demo.webm"), { force: true });

// Pre-compile the CSS the board needs (replaces the Tailwind CDN script).
const cssFile = join(SCRATCH, "board.css");
execFileSync(
  process.execPath,
  [
    require.resolve("tailwindcss/lib/cli.js"),
    "-c",
    join(here, "tailwind.config.cjs"),
    "-i",
    join(here, "input.css"),
    "-o",
    cssFile,
    "--minify",
  ],
  {
    cwd: here,
    stdio: "ignore",
  },
);
const css = readFileSync(cssFile, "utf8");
const htmx = readFileSync(join(require.resolve("htmx.org/package.json"), "../dist/htmx.min.js"), "utf8");

await new Promise((r) => stage.listen(STAGE_PORT, "0.0.0.0", r));

const server = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "apps/node/src/main.ts")], {
  cwd: ROOT,
  env,
});
pipeLines(server.stderr);
server.stdout.resume(); // structured server logs stay out of the on-screen terminal
let browser;
let failed;
try {
  await waitFor(`${env.HAMONN_URL}/healthz`);

  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: join(SCRATCH, "video"), size: { width: W, height: H } },
  });
  await context.route("https://cdn.tailwindcss.com/**", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `(()=>{const s=document.createElement("style");s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})()`,
    }),
  );
  await context.route("https://unpkg.com/htmx.org@2.0.4**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: htmx }),
  );
  const page = await context.newPage();
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`http://localhost:${STAGE_PORT}/`);

  // 0 ── title card
  set({
    card: {
      title: "hamonn",
      lines: [
        "Agents never hold a write token to your integration branch.",
        "Each works in its own fork (a lane). A coordinator lands the work, one lane at a time, with proof.",
        "This video is recorded by hamonn's own Docker image: real server, real git, real CLI, no mocks.",
      ],
      small: "github.com/kelvindesman/hamonn",
    },
    caption: "Self demo",
    sub: "recorded automatically inside Docker",
  });
  await sleep(5000);

  // 1 ── seed
  set({
    card: null,
    caption: "Seeding demo-app and registering the project",
    sub: "gated paths: wrangler.jsonc, src/db/** · required check: unit",
  });
  await runScript("seed.sh");
  set({ frame: `http://localhost:${HAMONN_PORT}/p/demo` });
  await sleep(2500);

  // 2 ── three agents
  set({ sub: "Agent A · the clean path (claims src/rss/**)" });
  await runScript("agent-a.sh");
  set({ sub: "Agent C · same task as A: sees the overlap hint, competes as a candidate" });
  await runScript("agent-c.sh");

  // 3 ── context lives in the repo
  set({ sub: "Pain point 4 · agent context dies with the session" });
  const board0 = await api("GET", "/api/projects/demo");
  const laneA = Object.values(board0.lanes)
    .flat()
    .find((l) => l.agent === "claude-A");
  const laneC = Object.values(board0.lanes)
    .flat()
    .find((l) => l.agent === "claude-C");
  await runScript("resume.sh", [String(laneA.id)]);
  await sleep(DWELL);

  // 4 ── compare candidates and pick the winner
  set({
    caption: "Two attempts at T-17: compare them, pick one",
    sub: "C wrote no handoff, so its ledger shows ✗ and it cannot land",
    frame: `http://localhost:${HAMONN_PORT}/t/demo/T-17`,
  });
  logLine("▶ Two attempts at T-17: compare them, pick one");
  await sleep(DWELL + 2500);
  logLine(`$ (owner) POST /api/projects/demo/tasks/T-17/pick {"lane":${laneA.id}}`);
  const pick = await api("POST", "/api/projects/demo/tasks/T-17/pick", { lane: laneA.id });
  logLine(
    `  winner #${pick.winner}; archived: ${pick.archive.map((i) => `#${i}`).join(", ") || "none"}; queued at position ${pick.queuePosition}`,
  );
  await sleep(DWELL);
  set({
    frame: `http://localhost:${HAMONN_PORT}/p/demo`,
    caption: "A lands; C is archived with its context",
    sub: `lane #${laneA.id} LANDED · lane #${laneC.id} ARCHIVED`,
  });
  await sleep(DWELL + 1500);

  // 5 ── B: wrecks its checkout, drifts, hits the gate, goes BEHIND, rebases
  set({ sub: "Agent B · reset --hard, stash, add -A: only B's own fork is at risk" });
  await runScript("agent-b.sh", [], { LAND: "1" });
  await sleep(DWELL);

  // 6 ── proof
  set({ sub: "LANDED means: the lane head is an ancestor of main, checked with plain git" });
  await runScript("verify.sh");
  await sleep(DWELL + 2000);

  // 7 ── outro
  set({
    card: {
      title: "3 agents · 1 duplicate · 1 conflict · 1 gate",
      lines: [
        "Nothing landed without an ancestor proof. Nothing an agent did could touch a peer or main.",
        "Same core on Cloudflare Artifacts, GitHub, or a laptop. Rust kernel, 100% covered.",
      ],
      small: "github.com/kelvindesman/hamonn · MIT",
    },
    caption: "hamonn",
    sub: "host-agnostic landing layer for concurrent agents",
  });
  await page.screenshot({ path: join(OUT, "poster.png") });
  await sleep(5000);

  const video = page.video();
  await page.close();
  await context.close();
  await video.saveAs(join(OUT, "hamonn-demo.webm"));
} catch (e) {
  failed = e;
} finally {
  writeFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n")}\n`);
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  stage.close();
}
if (failed) {
  console.error("demo recording failed:", failed);
  process.exit(1);
}
console.log(`recorded ${join(OUT, "hamonn-demo.webm")}`);
