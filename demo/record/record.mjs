// Records the hamonn demo against a LIVE deployment: drives the real demo scripts (real git, real CLI,
// real Cloudflare Artifacts) and films the live board next to a terminal in headless Chromium, 1920x1080.
//
//   HAMONN_URL=https://hamonn.<sub>.workers.dev HAMONN_KEY=<admin key> HAMONN_PROJECT=shop node demo/record/record.mjs
//
// Output in OUT_DIR (default demo-out/): hamonn-demo.webm, scenes.txt (timestamp, scene, suggested voice-over),
// transcript.txt. The video is silent; the voice-over is recorded separately against scenes.txt.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright";

const here = import.meta.dirname;
const ROOT = resolve(here, "../..");
const OUT = resolve(process.env.OUT_DIR ?? join(ROOT, "demo-out"));
const URL = (process.env.HAMONN_URL ?? "").replace(/\/$/, "");
const KEY = process.env.HAMONN_KEY ?? "";
const P = process.env.HAMONN_PROJECT ?? "shop";
const DWELL = Number(process.env.DWELL_MS ?? 5000); // how long each scripted step stays on screen
const STAGE_PORT = 8800;
const W = 1920;
const H = 1080;
const SCRATCH = join(tmpdir(), `hamonn-record-${process.pid}`);
const WORK = "/tmp/hamonn"; // short on purpose: these paths are printed on screen
if (!URL || !KEY) throw new Error("set HAMONN_URL and HAMONN_KEY");

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
const steps = [];
const NOISE = /ExperimentalWarning|--trace-warnings|^Cloning into|^remote:/;
const logLine = (l) => {
  if (NOISE.test(l)) return;
  transcript.push(l);
  if (l.includes("⏎")) return; // pause markers are plumbing, not content
  state.log.push(l);
  if (l.startsWith("▶ ")) {
    state.sub = l.slice(2); // each script step becomes the subtitle
    steps.push({ at: Date.now() - t0, text: l.slice(2) });
  }
  state.rev++;
};

// ── scenes: timestamps for the voice-over ─────────────────────────────────────
let t0 = 0;
const scenes = [];
const mmss = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(1, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
function scene(title, say, patch = {}) {
  scenes.push({ at: Date.now() - t0, title, say });
  set({ caption: title, sub: "", ...patch });
}

// ── stage server ──────────────────────────────────────────────────────────────
const stageHtml = readFileSync(join(here, "stage.html"));
const stage = createServer((req, res) => {
  if (req.url === "/state")
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
  else res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(stageHtml);
});

const env = {
  ...process.env,
  HAMONN_URL: URL,
  HAMONN_KEY: KEY,
  HAMONN_PROJECT: P,
  REPO_NAME: `${P}-app`,
  MODE: "artifacts",
  WORK,
  DEMO_ECHO: "1",
  PAUSE: "1",
};

/** Run a demo script; feed it an Enter after `DWELL` each time it announces a pause (⏎). */
function runScript(file, args = [], extraEnv = {}) {
  return new Promise((done, reject) => {
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
    child.on("exit", (code) => (code === 0 ? done() : reject(new Error(`${file} exited ${code}`))));
  });
}

async function api(method, path, body) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
const laneOf = (board, agent) =>
  Object.values(board.lanes)
    .flat()
    .find((l) => l.agent === agent);

// ── main ──────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, "hamonn-demo.webm"), { force: true });
await new Promise((r) => stage.listen(STAGE_PORT, "127.0.0.1", r));

let browser;
let failed;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    colorScheme: "dark",
    recordVideo: { dir: join(SCRATCH, "video"), size: { width: W, height: H } },
  });
  const page = await context.newPage();
  t0 = Date.now(); // the video starts with the page
  page.on("dialog", (d) => d.dismiss());
  await page.goto(`http://127.0.0.1:${STAGE_PORT}/`);

  // 0 ── title
  scene(
    "hamonn",
    "This is hamonn: a landing layer for many coding agents working on one repository at the same time.",
    {
      card: {
        title: "hamonn",
        lines: [
          "A landing layer for **many coding agents on one repository**.",
          "Each agent works in its own fork, a **lane**. A coordinator lands the work, one lane at a time, **with proof**.",
          "Everything you will see runs live: a Cloudflare Worker, Durable Objects, Queues, and **Artifacts** git repos.",
        ],
        small: `${URL.replace(/^https?:\/\//, "")} · github.com/kelvindesman/hamonn`,
      },
    },
  );
  await sleep(12000);

  // 1 ── the problem
  scene(
    "The problem",
    "I ran up to 886 agent sessions on one .git. Shared HEAD, shared stash, admin tokens on main. About twenty named incidents, and every fix was a client-side hook, because the host has no idea agents exist.",
    {
      card: {
        title: "The problem",
        lines: [
          "One production repo. Up to **886 concurrent agent sessions on one `.git`**. About 20 named incidents.",
          "`reset --hard` wiped a peer's edits. `stash pop` returned a peer's stash. `add -A` swept 46 peer files.",
          "Agents held admin tokens to `main`. Two agents built the same feature. Context died with the session.",
          "Every fix was a client-side hook, **because the git host has no idea agents exist**.",
        ],
        small: "docs/pain-points.md",
      },
    },
  );
  await sleep(26000);

  // 2 ── seed
  scene(
    "A repo in Cloudflare Artifacts",
    "The Worker creates the project repo through its Artifacts binding and registers it: two gated paths, one required check.",
    {
      card: null,
      sub: "gated paths: wrangler.jsonc, src/db/** · required check: unit",
    },
  );
  await runScript("seed.sh");
  set({ frame: `${URL}/p/${P}` });
  await sleep(DWELL);

  // 3 ── three lanes
  scene(
    "Agent A opens a lane",
    "Agent A opens a lane: a fork of the repo, and a token that only works on that fork. It declares what it will touch: src/rss.",
    {
      sub: "a lane = an Artifacts fork + a token scoped to that fork + declared claims",
    },
  );
  await runScript("agent-a.sh");
  scene(
    "Agent C takes the same task",
    "Agent C picks up the same task. hamonn warns at open time: overlap with lane 1, same task, so it competes as a candidate instead of racing to merge.",
    {
      sub: "overlap is detected when the lane opens, not after two PRs collide",
    },
  );
  await runScript("agent-c.sh");
  await sleep(DWELL);

  // 4 ── resume from ledger
  const b0 = await api("GET", `/api/projects/${P}`);
  const laneA = laneOf(b0, "claude-A");
  const laneC = laneOf(b0, "claude-C");
  scene(
    "A's session dies. Context does not.",
    "Now agent A's session dies. A brand-new agent clones the lane and reads the intent and handoff straight from the repo. The context lives in git, not in a chat window.",
    {
      sub: "the ledger .lane/<id>/{intent,handoff}.md travels with the code",
    },
  );
  await runScript("resume.sh", [String(laneA.id)]);
  await sleep(DWELL + 2000);

  // 5 ── compare and pick
  scene(
    "Two attempts at T-17",
    "Two attempts at the same task, side by side: claims, checks, ledger, drift. C never wrote a handoff, so it cannot land. The owner picks A.",
    {
      frame: `${URL}/t/${P}/T-17`,
      sub: "compare candidates, pick a winner; the loser is archived with its context",
    },
  );
  await sleep(DWELL * 2);
  logLine(`$ (owner) POST /api/projects/${P}/tasks/T-17/pick {"lane":${laneA.id}}`);
  const pick = await api("POST", `/api/projects/${P}/tasks/T-17/pick`, { lane: laneA.id });
  logLine(
    `  winner #${pick.winner} · archived: ${pick.archive.map((i) => `#${i}`).join(", ") || "none"} · queued at ${pick.queuePosition}`,
  );
  await sleep(DWELL);

  // 6 ── land with proof
  scene(
    "Landed, with proof",
    "Landing happens server-side, one lane at a time. LANDED is not green CI. It means the lane head is an ancestor of main, re-read from Artifacts after the push.",
    {
      frame: `${URL}/p/${P}`,
      sub: "LANDED ⇔ lane head is an ancestor of main, checked on the host",
    },
  );
  for (let i = 0; i < 30; i++) {
    const b = await api("GET", `/api/projects/${P}`);
    if (b.lanes.LANDED.some((l) => l.id === laneA.id)) break;
    await api("POST", `/api/projects/${P}/drain`).catch(() => {});
    await sleep(2000);
  }
  logLine(`  lane #${laneA.id} LANDED · lane #${laneC.id} ARCHIVED`);
  await sleep(DWELL * 2);

  // 7 ── B: wreck, drift, gate, BEHIND, rebase
  scene(
    "Agent B wrecks its own checkout",
    "Agent B runs the commands that cost me work: stash, reset hard, an accidental README edit, a schema change. In a lane they only hurt B's own fork. hamonn flags the drift and the gated path.",
    {
      sub: "stash · reset --hard · a file outside its claims · a gated path",
    },
  );
  await runScript("agent-b.sh", [], { LAND: "1" });
  await sleep(DWELL);

  // 8 ── verify with plain git
  scene(
    "Don't trust hamonn. Check with git.",
    "Last, verify with plain git against a fresh clone: every landed lane head is an ancestor of main.",
    {
      sub: "git merge-base --is-ancestor <lane head> main",
    },
  );
  await runScript("verify.sh");
  await sleep(DWELL * 2);

  // 9 ── architecture
  scene(
    "How it is built",
    "Rules live in a Rust kernel compiled to wasm, at 100 percent coverage. A TypeScript shell talks to the host through ports. On Cloudflare: a Worker, a Durable Object per project, a Queue for Artifacts push events, and Artifacts forks per lane.",
    {
      card: {
        title: "How it is built",
        lines: [
          "**Rust kernel** (wasm): lane states, claims, readiness, landing rules. Pure, **100% covered**.",
          "**TypeScript shell**: ports for git host, git wire, store. Hono API, server-rendered board, `hamonn` CLI.",
          "**On Cloudflare**: Worker + Durable Object per project (SQLite), Queues for Artifacts push events,",
          "**Artifacts**: one repo per project, one fork per lane, tokens minted per lane and per landing.",
          "Same kernel runs on a laptop (Node) or against GitHub. Deployed by Workers Builds from an Artifacts repo.",
        ],
        small: "docs/architecture.md · docs/spec.md",
      },
    },
  );
  await sleep(30000);

  // 10 ── limits + outro
  scene(
    "Limits, honestly",
    "What it does not claim: claims are declared, not enforced inside a fork, that is the point of a fork; it makes drift visible and refuses to land it. Artifacts is beta. It is MIT licensed, and the repo has a one-command demo.",
    {
      card: {
        title: "What it does not claim",
        lines: [
          "Claims are **declared, not enforced** inside a fork. hamonn makes drift visible and **refuses to land it**.",
          "Not a review tool, not CI: checks are reported to hamonn and bound to the head they ran on.",
          "Artifacts is in beta; merge-base walks first-parent history only.",
          "MIT · `bash demo/seed.sh` and the four agent scripts reproduce this video.",
        ],
        small: `${URL.replace(/^https?:\/\//, "")} · github.com/kelvindesman/hamonn`,
      },
    },
  );
  await sleep(24000);
  await page.screenshot({ path: join(OUT, "poster.png") });

  const video = page.video();
  await page.close();
  await context.close();
  await video.saveAs(join(OUT, "hamonn-demo.webm"));
} catch (e) {
  failed = e;
} finally {
  writeFileSync(join(OUT, "transcript.txt"), `${transcript.join("\n")}\n`);
  writeFileSync(
    join(OUT, "scenes.txt"),
    `${scenes
      .map((s, i) => {
        const end = scenes[i + 1]?.at ?? Number.POSITIVE_INFINITY;
        const sub = steps
          .filter((x) => x.at >= s.at && x.at < end)
          .map((x) => `      ${mmss(x.at)}  ▶ ${x.text}`);
        return [`${mmss(s.at)}  ${s.title}`, `      say: ${s.say}`, ...sub].join("\n");
      })
      .join("\n\n")}\n`,
  );
  await browser?.close().catch(() => {});
  stage.close();
}
if (failed) {
  console.error("demo recording failed:", failed);
  process.exit(1);
}
console.log(`recorded ${join(OUT, "hamonn-demo.webm")}`);
