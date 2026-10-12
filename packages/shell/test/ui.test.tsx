import type { Reason } from "@hamonn/core";
import { describe, expect, it } from "vitest";
import { BoardView, createUi, reasonText } from "../src/ui.tsx";
import { harness, LEDGER, laneFiles } from "./harness.ts";

async function scene() {
  const h = harness();
  const ui = createUi(h.service);
  await h.service.createProject({
    name: "demo",
    repo: h.repo,
    gatedPaths: ["wrangler.jsonc"],
    requiredChecks: ["unit"],
  });
  const open = async (task: string, claims: string[], agent: string) =>
    (await h.service.openLane("demo", { task, agent, intent: `work <${agent}>`, claims })).lane.id;
  const push = async (id: number, files: Record<string, string>) => {
    const lane = (await h.service.lane("demo", id)).lane;
    return h.service.onPushed("demo", id, {
      after: h.host.commit(lane.repo.name, lane.branch, laneFiles(id, files)),
    });
  };
  const get = async (path: string) => {
    const res = await ui.request(path);
    return { status: res.status, html: await res.text() };
  };
  return { h, ui, open, push, get };
}

describe("ui", () => {
  it("renders the board with every kind of lane card", async () => {
    const s = await scene();
    const a = await s.open("T-17", ["src/rss/**"], "claude-A"); // READY
    await s.push(a, { "src/rss/feed.ts": "A", ...LEDGER });
    await s.h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    const b = await s.open("T-18", ["src/cron/**"], "claude-B"); // PUSHED w/ drift + gate
    await s.push(b, { "src/cron/j.ts": "B", "wrangler.jsonc": "{changed}", ...LEDGER });
    await s.open("T-17", ["src/rss/**"], "claude-C"); // OPEN, overlaps A
    const d = await s.open("T-19", ["docs/**"], "claude-D"); // BEHIND
    await s.push(d, { "docs/x.md": "d", ...LEDGER });
    await s.h.service.recordCheck("demo", d, { name: "unit", status: "pass" });
    s.h.wire.script = [{ kind: "conflict", files: ["docs/x.md"] }];
    await s.h.service.enqueueLand("demo", d);
    await s.h.service.drainQueue("demo");
    const e = await s.open("T-20", ["e/**"], "claude-E"); // FAILED
    await s.push(e, { "e/x": "e", ...LEDGER });
    await s.h.service.recordCheck("demo", e, { name: "unit", status: "pass" });
    s.h.wire.script = [{ kind: "error", message: "wire exploded" }];
    await s.h.service.enqueueLand("demo", e);
    await s.h.service.drainQueue("demo");
    const f = await s.open("T-21", ["f/**"], "claude-F"); // LANDED
    await s.push(f, { "f/x": "f", ...LEDGER });
    await s.h.service.recordCheck("demo", f, { name: "unit", status: "pass" });
    await s.h.service.enqueueLand("demo", f);
    await s.h.service.drainQueue("demo");

    const { status, html } = await s.get("/p/demo");
    expect(status).toBe(200);
    expect(html).toContain("<title>demo</title>");
    expect(html).toContain('hx-get="/p/demo?partial=1"');
    expect(html).toContain("work &lt;claude-A&gt;"); // escaped
    expect(html).toContain("⚠ overlaps #1");
    expect(html).toContain("⚠ DRIFT wrangler.jsonc");
    expect(html).toContain("gate: unsigned");
    expect(html).toContain("conflicts: docs/x.md");
    expect(html).toContain("wire exploded");
    expect(html).toMatch(/@ [0-9a-f]{7}/);
    expect(html).toContain("check unit: missing");
    expect(html).toContain("LAND");
    expect(html).toContain("FAILED (1)");
    expect(html).not.toContain("ARCHIVED (");
    expect(html).toContain("events:");

    const partial = await s.get("/p/demo?partial=1");
    expect(partial.html.startsWith('<div id="board">')).toBe(true);
  });

  it("renders an empty board and archived column", async () => {
    const s = await scene();
    expect((await s.get("/p/demo")).html).toContain("queue: ∅");
    expect((await s.get("/p/demo")).html).toContain(
      "events: project.created"
        .replace("project.created", "1 project.created")
        .replace("events: ", "events: ") || "",
    );
    const id = await s.open("T-1", ["a/**"], "x");
    await s.h.service.archive("demo", id);
    expect((await s.get("/p/demo")).html).toContain("ARCHIVED (1)");
  });

  it("shows the queue on the board header and gate-signed lanes", async () => {
    const s = await scene();
    const id = await s.open("T-1", ["a/**", "wrangler.jsonc"], "x");
    await s.push(id, { "a/x": "1", "wrangler.jsonc": "{changed}", ...LEDGER });
    await s.h.service.recordCheck("demo", id, { name: "unit", status: "pass" });
    await s.h.service.sign("demo", id, "kelvin");
    await s.h.service.enqueueLand("demo", id);
    const html = (await s.get("/p/demo")).html;
    expect(html).toContain("queue: #1");
    expect(html).toContain("gate ✓ kelvin");
  });

  it("renders the candidates page and lets READY lanes be picked until a winner exists", async () => {
    const s = await scene();
    const a = await s.open("T-17", ["src/rss/**"], "claude-A");
    await s.push(a, { "src/rss/feed.ts": "A", ...LEDGER });
    await s.h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    const c = await s.open("T-17", ["src/rss/**"], "claude-C");
    await s.push(c, { "src/rss/feed.ts": "C" });
    const page = await s.get("/t/demo/T-17");
    expect(page.html).toContain("pick winner");
    expect(page.html).toContain("claude-C");
    expect(page.html).toContain('data-body="{&quot;lane&quot;:1}"');
    expect((await s.get("/t/demo/T-17?partial=1")).html.startsWith('<div id="candidates">')).toBe(true);
    await s.h.service.pickWinner("demo", "T-17", a);
    const after = await s.get("/t/demo/T-17");
    expect(after.html).toContain("winner #1");
    expect(after.html).not.toContain("pick winner");
  });

  it("renders the lane page, ready and not-ready variants", async () => {
    const s = await scene();
    const a = await s.open("T-1", ["a/**", "wrangler.jsonc"], "claude-A");
    await s.push(a, { "a/x": "1", "wrangler.jsonc": "{changed}", ...LEDGER });
    const notReady = await s.get(`/l/demo/${a}`);
    expect(notReady.html).toContain("check unit: missing");
    expect(notReady.html).toContain("gate: needs sign-off");
    expect(notReady.html).toContain(">sign<");
    expect(notReady.html).toContain("wrangler.jsonc");
    await s.h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    await s.h.service.sign("demo", a, "owner");
    const ready = await s.get(`/l/demo/${a}?partial=1`);
    expect(ready.html).toContain("ready to land");
    expect(ready.html).toContain("LAND");
    expect(ready.html).toContain("unit: pass @");
    expect(ready.html.startsWith('<div id="lane"')).toBe(true);
    // an OPEN lane: no head, default ledger, a check recorded before any push, no merge preview
    const o = await s.open("T-2", ["o/**"], "claude-O");
    await s.h.service.recordCheck("demo", o, { name: "unit", status: "pending" });
    const fresh = await s.get(`/l/demo/${o}`);
    expect(fresh.html).toContain("intent ✗ · handoff ✗ · evidence –");
    expect(fresh.html).toContain("unit: pending </li>");
    expect((await s.get("/t/demo/T-2")).html).toContain("<td>–</td>");
    // drifted paths are highlighted
    const dr = await s.open("T-3", ["d/**"], "claude-D");
    await s.push(dr, { "d/x": "1", "stray.txt": "2", ...LEDGER });
    expect((await s.get(`/l/demo/${dr}`)).html).toContain('<li class="text-red-400">stray.txt</li>');
    // lane without a token
    const b = await s.open("T-4", ["b/**"], "claude-B");
    const l = (await s.h.service.lane("demo", b)).lane;
    await s.h.store.putLane("demo", {
      ...l,
      tokenExpires: undefined,
      ledger: { intent: true, handoff: true, evidence: true, handoffTooLong: true },
    });
    const bare = await s.get(`/l/demo/${b}`);
    expect(bare.html).toContain("(too long)");
    expect(bare.html).toContain("–");
  });

  it("redirects / and propagates 404s", async () => {
    const s = await scene();
    const r = await s.ui.request("/");
    expect(r.status).toBe(302);
    const missing = await s.ui.request("/p/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("NOT_FOUND: unknown project: nope");
    expect((await s.ui.request("/t/demo/T-x")).status).toBe(404);
    expect((await s.ui.request("/l/demo/99")).status).toBe(404);
  });

  it("describes every readiness reason in words", () => {
    const reasons: Reason[] = [
      { code: "WRONG_STATE", state: "OPEN" },
      { code: "NO_PUSH" },
      { code: "CHECK_MISSING", name: "u" },
      { code: "CHECK_FAILING", name: "u" },
      { code: "CHECK_PENDING", name: "u" },
      { code: "INTENT_MISSING" },
      { code: "HANDOFF_MISSING" },
      { code: "DRIFT", paths: ["a", "b"] },
      { code: "GATE_UNSIGNED" },
    ];
    expect(reasons.map(reasonText)).toEqual([
      "state OPEN",
      "nothing pushed yet",
      "check u: missing",
      "check u: failing",
      "check u: pending",
      ".lane/intent.md missing",
      ".lane/handoff.md missing",
      "drift: a, b",
      "gate: needs sign-off",
    ]);
  });

  it("BoardView renders without events", async () => {
    const s = await scene();
    const board = await s.h.service.board("demo");
    board.events = {};
    const html = String(<BoardView board={board} />);
    expect(html).toContain("events: –");
  });
});
