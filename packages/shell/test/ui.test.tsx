import type { Reason } from "@hamonn/core";
import { describe, expect, it } from "vitest";
import { BoardView, createUi, landingPage, REPO_URL, reasonText } from "../src/ui.tsx";
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
    const c = await s.open("T-17", ["src/rss/**"], "claude-C"); // OPEN, overlaps A
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
    expect(html.startsWith("<!doctype html><html")).toBe(true);
    expect(html).toContain("<title>demo: hamonn</title>");
    expect(html).toContain('hx-get="/p/demo?partial=1"');
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('<dialog id="keydlg"');
    expect(html).toContain("work &lt;claude-A&gt;"); // escaped
    expect(html).toContain("overlaps #1");
    expect(html).toContain('data-tone="alert">drift: wrangler.jsonc');
    expect(html).toContain("gate: needs sign-off");
    expect(html).toContain("conflicts: <code>docs/x.md</code>");
    expect(html).toContain("wire exploded");
    expect(html).toMatch(
      /main@[0-9a-f]{7}<span class="sup" aria-hidden="true">⊇<\/span><span class="sr">contains<\/span>lane@[0-9a-f]{7}/,
    );
    expect(html).toContain("check unit: missing");
    expect(html).toContain(`id="land-${a}"`);
    expect(html).toContain(`id="sign-${b}"`);
    expect(html).toContain('data-col="FAILED" aria-label="Failed: 1"');
    expect(html).toContain('data-col="LANDED"');
    expect(html).not.toContain('data-col="ARCHIVED"');
    expect(html).toContain(`data-lane="${a}" data-state="READY"`);
    expect(html).toContain('<li data-kind="lane.landed">');
    expect(html).toContain("merge clean");
    expect(html).toContain("waiting for the first push");
    expect(html).not.toContain("state OPEN");

    const partial = await s.get("/p/demo?partial=1");
    expect(partial.html.startsWith('<div id="board">')).toBe(true);

    // lane pages for the BEHIND, FAILED, LANDED and overlapping lanes
    expect((await s.get(`/l/demo/${d}`)).html).toContain("Conflicts with main: docs/x.md");
    expect((await s.get(`/l/demo/${e}`)).html).toContain('<p class="note">wire exploded</p>');
    const landed = (await s.get(`/l/demo/${f}`)).html;
    expect(landed).toContain('class="proof big"');
    expect(landed).toContain("Nothing to land while the lane is landed.");
    expect(landed).not.toContain(`id="archive-${f}-d"`);
    expect((await s.get(`/l/demo/${c}`)).html).toContain(`<dd>#${a}</dd>`);
  });

  it("renders an empty board and archived column", async () => {
    const s = await scene();
    const empty = (await s.get("/p/demo")).html;
    expect(empty).toContain('Landing queue<span class="muted">empty</span>');
    expect(empty).toContain('aria-label="Open: no lanes"');
    expect(empty).toContain("1 events, UTC");
    expect(empty).toContain('<span class="k">project created</span>');
    const id = await s.open("T-1", ["a/**"], "x");
    await s.push(id, { "a/x": "1" });
    expect((await s.get("/p/demo")).html).toContain("1 file<");
    await s.h.service.archive("demo", id);
    expect((await s.get("/p/demo")).html).toContain('aria-label="Archived: 1"');
  });

  it("shows the queue on the board header and gate-signed lanes", async () => {
    const s = await scene();
    const id = await s.open("T-1", ["a/**", "wrangler.jsonc"], "x");
    await s.push(id, { "a/x": "1", "wrangler.jsonc": "{changed}", ...LEDGER });
    await s.h.service.recordCheck("demo", id, { name: "unit", status: "pass" });
    await s.h.service.sign("demo", id, "kelvin");
    await s.h.service.enqueueLand("demo", id);
    const html = (await s.get("/p/demo")).html;
    expect(html).toContain('<li><a href="/l/demo/1">#1</a></li>');
    expect(html).toContain("gate signed by kelvin");
  });

  it("renders the candidates page and lets READY lanes be picked until a winner exists", async () => {
    const s = await scene();
    const a = await s.open("T-17", ["src/rss/**"], "claude-A");
    await s.push(a, { "src/rss/feed.ts": "A", ...LEDGER });
    await s.h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    const c = await s.open("T-17", ["src/rss/**"], "claude-C");
    await s.push(c, { "src/rss/feed.ts": "C", "stray.txt": "x" });
    await s.h.service.recordCheck("demo", c, { name: "unit", status: "fail" });
    const page = await s.get("/t/demo/T-17");
    expect(page.html).toContain("Pick winner");
    expect(page.html).toContain("claude-C");
    expect(page.html).toContain("2 candidate lanes");
    expect(page.html).toContain('<span class="no">incomplete</span>');
    expect(page.html).toContain('<span class="no">1</span>');
    expect(page.html).toContain('<a href="/p/demo">demo</a>');
    expect(page.html).toContain('data-body="{&quot;lane&quot;:1}"');
    expect((await s.get("/t/demo/T-17?partial=1")).html.startsWith('<div id="candidates"')).toBe(true);
    await s.h.service.pickWinner("demo", "T-17", a);
    const after = await s.get("/t/demo/T-17");
    expect(after.html).toContain("Winner #1");
    expect(after.html).toContain("<tr data-winner");
    expect(after.html).not.toContain("Pick winner");
    await s.open("T-9", ["z/**"], "claude-Z");
    expect((await s.get("/t/demo/T-9")).html).toContain("1 candidate lane<");
  });

  it("renders the lane page, ready and not-ready variants", async () => {
    const s = await scene();
    const a = await s.open("T-1", ["a/**", "wrangler.jsonc"], "claude-A");
    await s.push(a, { "a/x": "1", "wrangler.jsonc": "{changed}", ...LEDGER });
    const notReady = await s.get(`/l/demo/${a}`);
    expect(notReady.html).toContain("check unit: missing");
    expect(notReady.html).toContain("gate: needs sign-off");
    expect(notReady.html).toContain(`id="sign-${a}-d"`);
    expect(notReady.html).toContain("wrangler.jsonc");
    expect(notReady.html).toContain("<dd>needs sign-off</dd>");
    expect(notReady.html).toContain("No checks reported yet.");
    expect(notReady.html).toContain('<a href="/t/demo/T-1">Task T-1</a>');
    await s.h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    await s.h.service.sign("demo", a, "owner");
    const ready = await s.get(`/l/demo/${a}?partial=1`);
    expect(ready.html).toContain("Ready to land");
    expect(ready.html).toContain(`id="land-${a}-d"`);
    expect(ready.html).toContain("<dd>signed by owner</dd>");
    expect(ready.html).toMatch(/<td>unit<\/td><td>pass<\/td><td><code>[0-9a-f]{7}<\/code>/);
    expect(ready.html.startsWith('<div id="lane"')).toBe(true);
    // an OPEN lane: no head, default ledger, a check recorded before any push, no merge preview
    const o = await s.open("T-2", ["o/**"], "claude-O");
    await s.h.service.recordCheck("demo", o, { name: "unit", status: "fail" });
    const fresh = await s.get(`/l/demo/${o}`);
    expect(fresh.html).toContain('<span data-ok="0">intent ✗</span>');
    expect(fresh.html).toContain('<span data-ok="-">evidence –</span>');
    expect(fresh.html).toContain('<td class="no">fail</td><td><code>–</code></td>');
    expect(fresh.html).toContain("Nothing pushed yet.");
    expect(fresh.html).toContain("<dd>not gated</dd>");
    expect(fresh.html).toContain("<dd>none</dd>");
    expect((await s.get("/t/demo/T-2")).html).toContain("<td>–</td>");
    // drifted paths are highlighted
    const dr = await s.open("T-3", ["d/**"], "claude-D");
    await s.push(dr, { "d/x": "1", "stray.txt": "2", ...LEDGER });
    expect((await s.get(`/l/demo/${dr}`)).html).toContain('<li data-drift=""><code>stray.txt</code></li>');
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
    expect(bare.html).toContain('<span data-ok="1">evidence ✓</span>');
    expect(bare.html).toContain("<dt>Push token</dt><dd>–</dd>");
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

  it("renders the landing page with and without projects, escaping names", () => {
    const empty = landingPage([]);
    expect(empty.startsWith("<!doctype html>")).toBe(true);
    expect(empty).toContain("no projects yet");
    expect(empty).toContain(REPO_URL);
    expect(empty).toContain("A landing layer for concurrent coding agents");
    const listed = landingPage([{ name: "demo", repo: "demo-app" }, { name: "a<b>&c" }]);
    expect(listed).toContain('<a href="/p/demo">demo</a><code>demo-app</code>');
    expect(listed).toContain('<a href="/p/a%3Cb%3E%26c">a&lt;b&gt;&amp;c</a></li>');
    expect(listed).not.toContain("no projects yet");
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
    expect(html).toContain("0 events, UTC");
  });
});
