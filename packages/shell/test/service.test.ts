import { describe, expect, it } from "vitest";
import { HamonnError } from "../src/index.ts";
import { type Harness, harness, LEDGER, laneFiles } from "./harness.ts";

async function project(h: Harness, extra: Record<string, unknown> = {}) {
  return h.service.createProject({
    name: "demo",
    repo: h.repo,
    gatedPaths: ["wrangler.jsonc", "src/db/**"],
    requiredChecks: ["unit"],
    ...extra,
  });
}

async function open(h: Harness, task = "T-17", claims = ["src/rss/**"], agent = "claude-A") {
  return h.service.openLane("demo", { task, agent, intent: "feat: rss", claims });
}

/** Push `files` into the lane's fork and notify the service. */
async function push(h: Harness, laneId: number, files: Record<string, string>) {
  const lane = (await h.service.lane("demo", laneId)).lane;
  const sha = h.host.commit(lane.repo.name, lane.branch, laneFiles(laneId, files));
  return h.service.onPushed("demo", laneId, { after: sha });
}

describe("projects", () => {
  it("creates a project with defaults and rejects bad input", async () => {
    const h = harness();
    const p = await h.service.createProject({ name: "demo", repo: h.repo });
    expect(p).toMatchObject({
      integrationBranch: "main",
      laneMode: "fork",
      gatedPaths: [],
      requiredChecks: [],
    });
    await expect(h.service.createProject({ name: "demo", repo: h.repo })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(h.service.createProject({ name: "-bad", repo: h.repo })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      h.service.createProject({ name: "other", repo: h.repo, integrationBranch: "nope" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("unknown project / lane / task are 404s", async () => {
    const h = harness();
    await expect(h.service.board("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await project(h);
    await expect(h.service.lane("demo", 9)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.service.task("demo", "T-x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.service.pickWinner("demo", "T-x", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("openLane", () => {
  it("forks, mints a write token, registers the fork and reports overlaps", async () => {
    const h = harness();
    await project(h);
    const a = await open(h);
    expect(a.lane).toMatchObject({ id: 1, state: "OPEN", repo: { name: "demo-l1" }, branch: "main" });
    expect(a.remote).toContain("demo-l1");
    expect(a.token.secret).toBeTruthy();
    expect(h.host.minted[0]).toMatchObject({ scope: "write", ttl: 3600 });
    expect(await h.store.lookup("demo-l1")).toEqual({ project: "demo", laneId: 1 });

    const c = await open(h, "T-17", ["src/rss/feed.ts"], "claude-C");
    expect(c.overlaps).toEqual([1]);
    expect(c.hint).toContain("compete as a candidate");
    expect((await h.service.task("demo", "T-17")).lanes).toHaveLength(2);
  });

  it("strict mode rejects overlapping claims with CONFLICT_CLAIM", async () => {
    const h = harness();
    await project(h);
    await open(h);
    await expect(
      h.service.openLane("demo", {
        task: "T-18",
        agent: "b",
        intent: "x",
        claims: ["src/rss/**"],
        strict: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT_CLAIM", details: { overlaps: [1] } });
    // strict with no overlap is fine
    await expect(
      h.service.openLane("demo", {
        task: "T-18",
        agent: "b",
        intent: "x",
        claims: ["src/cron/**"],
        strict: true,
      }),
    ).resolves.toBeTruthy();
  });

  it("branch mode uses the project repo and lane/<id> branches", async () => {
    const h = harness();
    await project(h, { laneMode: "branch" });
    const a = await open(h);
    expect(a.lane.repo.name).toBe("demo-app");
    expect(a.lane.branch).toBe("lane/1");
    expect(h.host.heads.has("demo-l1")).toBe(false);
  });

  it("keeps a given task title and reuses an existing task", async () => {
    const h = harness();
    await project(h);
    await h.service.openLane("demo", {
      task: "T-1",
      title: "RSS",
      agent: "a",
      intent: "i",
      claims: ["a/**"],
    });
    await h.service.openLane("demo", {
      task: "T-1",
      title: "ignored",
      agent: "b",
      intent: "i",
      claims: ["b/**"],
    });
    expect((await h.service.task("demo", "T-1")).task.title).toBe("RSS");
  });

  it("fails when the integration branch has no commits and surfaces kernel validation", async () => {
    const h = harness();
    await project(h);
    h.host.heads.get("demo-app")?.delete("main");
    await expect(open(h)).rejects.toMatchObject({ code: "CONFLICT" });
    h.host.heads.get("demo-app")?.set("main", "c1000000");
    await expect(
      h.service.openLane("demo", { task: "T", agent: "a", intent: "i", claims: [] }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("push → READY", () => {
  it("computes touched/drift/gate and promotes to READY once checks pass", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const v1 = await push(h, 1, { "src/rss/feed.ts": "v1", ...LEDGER });
    expect(v1.lane.state).toBe("PUSHED");
    expect(v1.lane.touched).toEqual([".lane/1/handoff.md", ".lane/1/intent.md", "src/rss/feed.ts"]);
    expect(v1.lane.drift).toEqual([]);
    expect(v1.readiness.reasons).toEqual([{ code: "CHECK_MISSING", name: "unit" }]);

    const v2 = await h.service.recordCheck("demo", 1, { name: "unit", status: "pass", url: "https://ci/1" });
    expect(v2.lane.state).toBe("READY");

    // a failing check demotes it again
    const v3 = await h.service.recordCheck("demo", 1, { name: "unit", status: "fail" });
    expect(v3.lane.state).toBe("PUSHED");
    expect(v3.readiness.reasons).toEqual([{ code: "CHECK_FAILING", name: "unit" }]);
  });

  it("a re-push invalidates checks bound to the old head", async () => {
    const h = harness();
    await project(h);
    await open(h);
    await push(h, 1, { "src/rss/feed.ts": "v1", ...LEDGER });
    expect((await h.service.recordCheck("demo", 1, { name: "unit", status: "pass" })).lane.state).toBe(
      "READY",
    );
    const again = await push(h, 1, { "src/rss/feed.ts": "v2" });
    expect(again.lane.state).toBe("PUSHED");
    expect(again.readiness.reasons).toEqual([{ code: "CHECK_MISSING", name: "unit" }]);
  });

  it("flags drift and requires a gate sign-off for gated paths", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const v = await push(h, 1, { "src/rss/feed.ts": "v1", "wrangler.jsonc": "{x}", ...LEDGER });
    expect(v.lane.drift).toEqual(["wrangler.jsonc"]);
    expect(v.lane.gateRequired).toBe(true);
    await h.service.recordCheck("demo", 1, { name: "unit", status: "pass" });
    const signed = await h.service.sign("demo", 1, "owner");
    expect(signed.lane.gateSignedBy).toBe("owner");
    expect(signed.lane.state).toBe("PUSHED"); // drift still blocks
    expect(signed.readiness.reasons).toEqual([{ code: "DRIFT", paths: ["wrangler.jsonc"] }]);
  });

  it("measures touched paths from the merge-base when the host can compute it", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const laneRepo = (await h.service.lane("demo", 1)).lane.repo.name;
    // peer work lands on main; the lane rebases onto it (its fork now contains it) and adds its own file
    const peer = h.host.commit("demo-app", "main", { "src/peer.ts": "peer" });
    h.host.heads.get(laneRepo)?.set("main", peer);
    const sha = h.host.commit(laneRepo, "main", laneFiles(1, { "src/rss/feed.ts": "mine", ...LEDGER }));
    h.host.mergeBaseImpl = () => peer;
    const rebased = await h.service.onPushed("demo", 1, { after: sha });
    expect(rebased.lane.touched).toEqual([".lane/1/handoff.md", ".lane/1/intent.md", "src/rss/feed.ts"]);
    expect(rebased.lane.drift).toEqual([]);
  });

  it("falls back to the opening base when merge-base is unknown or the integration branch vanished", async () => {
    const h = harness();
    await project(h);
    await open(h);
    h.host.mergeBaseImpl = () => null;
    const laneRepo = (await h.service.lane("demo", 1)).lane.repo.name;
    const sha = h.host.commit(laneRepo, "main", { "src/rss/feed.ts": "v1" });
    expect((await h.service.onPushed("demo", 1, { after: sha })).lane.touched).toEqual(["src/rss/feed.ts"]);
    h.host.heads.get("demo-app")?.delete("main");
    const sha2 = h.host.commit(laneRepo, "main", { "src/rss/feed.ts": "v2" });
    expect((await h.service.onPushed("demo", 1, { after: sha2 })).lane.touched).toEqual(["src/rss/feed.ts"]);
  });

  it("is idempotent per head (queue event + CLI both post /pushed)", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const lane = (await h.service.lane("demo", 1)).lane;
    const sha = h.host.commit(lane.repo.name, "main", laneFiles(1, { "src/rss/feed.ts": "v1", ...LEDGER }));
    await h.service.onPushed("demo", 1, { after: sha });
    const before = h.logs.filter((l) => l.event === "lane.pushed").length;
    await h.service.onPushed("demo", 1, { after: sha });
    expect(h.logs.filter((l) => l.event === "lane.pushed").length).toBe(before);
  });

  it("rejects a push to a lane that can no longer accept one", async () => {
    const h = harness();
    await project(h);
    await open(h);
    await h.service.archive("demo", 1);
    await expect(push(h, 1, { a: "b" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("records a check on an OPEN lane without evaluating it", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const v = await h.service.recordCheck("demo", 1, { name: "unit", status: "pass" });
    expect(v.lane.state).toBe("OPEN");
    expect(v.readiness.reasons[0]).toEqual({ code: "WRONG_STATE", state: "OPEN" });
  });
});

describe("tokens & archive", () => {
  it("rotates a lane token, revoking the previous one", async () => {
    const h = harness();
    await project(h);
    const a = await open(h);
    const t = await h.service.mintLaneToken("demo", 1);
    expect(h.host.revoked).toContain(a.token.id);
    expect(t.token.id).not.toBe(a.token.id);
    expect((await h.service.lane("demo", 1)).lane.tokenId).toBe(t.token.id);
    await h.service.archive("demo", 1);
    await expect(h.service.mintLaneToken("demo", 1)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("survives revoke failures and tolerates lanes without a token", async () => {
    const h = harness();
    await project(h);
    await open(h);
    h.host.failRevoke = true;
    await h.service.archive("demo", 1);
    expect(h.logs.some((l) => l.event === "token.revoke_failed")).toBe(true);
    // a lane with no tokenId: archive must not call revoke
    await open(h, "T-2", ["docs/**"]);
    const l = (await h.service.lane("demo", 2)).lane;
    await h.store.putLane("demo", { ...l, tokenId: undefined });
    h.host.failRevoke = false;
    const before = h.host.revoked.length;
    await h.service.archive("demo", 2);
    expect(h.host.revoked.length).toBe(before);
  });
});

async function readyLane(
  h: Harness,
  claims: string[],
  files: Record<string, string>,
  task = "T-17",
  agent = "a",
) {
  const o = await h.service.openLane("demo", { task, agent, intent: "feat", claims });
  await push(h, o.lane.id, { ...files, ...LEDGER });
  await h.service.recordCheck("demo", o.lane.id, { name: "unit", status: "pass" });
  return o.lane.id;
}

describe("landing", () => {
  it("lands serially, proves ancestry, and revokes every landing token", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    const b = await readyLane(h, ["src/cron/**"], { "src/cron/job.ts": "B" }, "T-18", "b");
    expect(await h.service.enqueueLand("demo", a)).toEqual({ state: "READY", queuePosition: 0 });
    expect(await h.service.enqueueLand("demo", b)).toEqual({ state: "READY", queuePosition: 1 });
    // enqueue is idempotent
    expect((await h.service.enqueueLand("demo", b)).queuePosition).toBe(1);

    const out = await h.service.drainQueue("demo");
    expect(out.map((o) => [o.laneId, o.state])).toEqual([
      [a, "LANDED"],
      [b, "LANDED"],
    ]);
    const head = await h.host.headSha(h.repo, "main");
    expect(out[1]?.landedSha).toBe(head);
    const laneA = (await h.service.lane("demo", a)).lane;
    expect(laneA).toMatchObject({ state: "LANDED", landedSha: out[0]?.landedSha });
    expect(h.wire.lands).toHaveLength(2);
    expect(h.wire.lands[0]?.message).toContain(`Land lane #${a}`);
    // every landing token is revoked, plus the lane's long-lived token
    const landingTokens = h.host.minted.filter((m) => m.ttl === 600).map((m) => m.id);
    expect(landingTokens.length).toBe(6); // int(write)+lane(read)+verify(read) × 2
    for (const id of landingTokens) expect(h.host.revoked).toContain(id);
    expect(h.host.revoked).toContain(laneA.tokenId);
  });

  it("reports conflicts as BEHIND with the files, then re-lands after a re-push", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    h.wire.script = [{ kind: "conflict", files: ["src/rss/feed.ts"] }];
    await h.service.enqueueLand("demo", a);
    const [o] = await h.service.drainQueue("demo");
    expect(o).toMatchObject({ state: "BEHIND", conflictFiles: ["src/rss/feed.ts"] });
    const view = await push(h, a, { "src/rss/feed.ts": "A2" });
    expect(view.lane.state).toBe("PUSHED");
    await h.service.recordCheck("demo", a, { name: "unit", status: "pass" });
    await h.service.enqueueLand("demo", a);
    expect((await h.service.drainQueue("demo"))[0]?.state).toBe("LANDED");
  });

  it("turns wire exceptions and wire errors into FAILED", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    h.wire.script = [new Error("socket hang up")];
    await h.service.enqueueLand("demo", a);
    expect((await h.service.drainQueue("demo"))[0]).toMatchObject({
      state: "FAILED",
      message: "socket hang up",
    });
    h.wire.script = [new Error("x")];
    // non-Error rejections are stringified
    const b = await readyLane(h, ["src/cron/**"], { "src/cron/j.ts": "B" }, "T-2");
    h.wire.script = [];
    h.wire.land = async () => {
      throw "plain string";
    };
    await h.service.enqueueLand("demo", b);
    expect((await h.service.drainQueue("demo"))[0]).toMatchObject({
      state: "FAILED",
      message: "plain string",
    });
  });

  it("fails the lane when the ancestor proof is false or the proof check throws", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    h.wire.ancestorOverride = false;
    await h.service.enqueueLand("demo", a);
    const [o] = await h.service.drainQueue("demo");
    expect(o?.state).toBe("FAILED");
    expect(o?.message).toContain("landed proof failed");

    const b = await readyLane(h, ["src/cron/**"], { "src/cron/j.ts": "B" }, "T-2");
    h.wire.ancestorOverride = new Error("fetch failed");
    await h.service.enqueueLand("demo", b);
    expect((await h.service.drainQueue("demo"))[0]?.state).toBe("FAILED");
    expect(h.logs.some((l) => l.event === "land.proof_error")).toBe(true);
  });

  it("proves with an empty integration head when the host cannot read it", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    h.wire.script = [{ kind: "clean", sha: "zzz" }];
    h.host.headSha = async (_r, ref) => (ref === "main" && h.wire.lands.length > 0 ? null : "c1000000");
    h.wire.ancestorOverride = false;
    await h.service.enqueueLand("demo", a);
    expect((await h.service.drainQueue("demo"))[0]?.state).toBe("FAILED");
  });

  it("skips queue entries that stopped being READY and handles an empty queue", async () => {
    const h = harness();
    await project(h);
    expect(await h.service.drainQueue("demo")).toEqual([]);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    await h.service.enqueueLand("demo", a);
    await push(h, a, { "src/rss/feed.ts": "A2" }); // re-push demotes to PUSHED while queued
    const [o] = await h.service.drainQueue("demo");
    expect(o).toMatchObject({ laneId: a, state: "SKIPPED" });
    expect(h.logs.some((l) => l.event === "land.skipped")).toBe(true);
  });

  it("refuses to enqueue lanes that are not READY and calls scheduleDrain", async () => {
    const scheduled: string[] = [];
    const h = harness({ scheduleDrain: (p) => scheduled.push(p) });
    await project(h);
    await open(h);
    await expect(h.service.enqueueLand("demo", 1)).rejects.toMatchObject({ code: "WRONG_STATE" });
    const b = await readyLane(h, ["src/cron/**"], { "src/cron/j.ts": "B" }, "T-2");
    await h.service.enqueueLand("demo", b);
    expect(scheduled).toEqual(["demo"]);
  });

  it("caps a drain at 25 landings", async () => {
    const h = harness();
    await project(h);
    h.wire.land = async () => ({ kind: "conflict", files: ["x"] });
    for (let i = 0; i < 26; i++) {
      const id = await readyLane(h, [`d${i}/**`], { [`d${i}/f.ts`]: "x" }, `T-${i}`);
      await h.service.enqueueLand("demo", id);
    }
    expect(await h.service.drainQueue("demo")).toHaveLength(25);
    expect((await h.service.board("demo")).queue).toHaveLength(1);
  });
});

describe("candidates", () => {
  it("picks a winner: archives losers, queues the winner", async () => {
    const h = harness();
    await project(h);
    const a = await readyLane(h, ["src/rss/**"], { "src/rss/feed.ts": "A" });
    const c = await h.service.openLane("demo", {
      task: "T-17",
      agent: "c",
      intent: "rss again",
      claims: ["src/rss/**"],
    });
    await push(h, c.lane.id, { "src/rss/feed.ts": "C" });
    const view = await h.service.task("demo", "T-17");
    expect(view.rows.map((r) => r.laneId)).toEqual([a, c.lane.id]);

    const picked = await h.service.pickWinner("demo", "T-17", a);
    expect(picked).toMatchObject({ winner: a, archive: [c.lane.id], queuePosition: 0 });
    expect((await h.service.lane("demo", c.lane.id)).lane.state).toBe("ARCHIVED");
    expect((await h.service.task("demo", "T-17")).task.winnerLane).toBe(a);
    expect((await h.service.drainQueue("demo"))[0]?.state).toBe("LANDED");
  });

  it("refuses a winner that is not READY", async () => {
    const h = harness();
    await project(h);
    await open(h);
    await expect(h.service.pickWinner("demo", "T-17", 1)).rejects.toMatchObject({ code: "WRONG_STATE" });
  });
});

describe("events", () => {
  it("routes fork push events through the registry", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const sha = h.host.commit("demo-l1", "main", laneFiles(1, { "src/rss/feed.ts": "v1", ...LEDGER }));
    const view = await h.service.handlePushEvent({ repoName: "demo-l1", after: sha });
    expect(view?.lane.state).toBe("PUSHED");
  });

  it("routes branch-mode pushes by ref and ignores unrelated events", async () => {
    const h = harness();
    await project(h, { laneMode: "branch" });
    await open(h);
    h.host.heads.get("demo-app")?.set("lane/1", "c1000000");
    const sha = h.host.commit("demo-app", "lane/1", laneFiles(1, { "src/rss/feed.ts": "v1", ...LEDGER }));
    const view = await h.service.handlePushEvent({
      repoName: "demo-app",
      ref: "refs/heads/lane/1",
      after: sha,
    });
    expect(view?.lane.state).toBe("PUSHED");
    expect(
      await h.service.handlePushEvent({ repoName: "demo-app", ref: "refs/heads/main", after: sha }),
    ).toBeNull();
    expect(
      await h.service.handlePushEvent({ repoName: "other", ref: "refs/heads/lane/1", after: sha }),
    ).toBeNull();
    expect(await h.service.handlePushEvent({ repoName: "other", after: sha })).toBeNull();
  });
});

describe("board", () => {
  it("groups lanes by state and counts events", async () => {
    const h = harness();
    await project(h);
    await open(h);
    const a = await readyLane(h, ["src/cron/**"], { "src/cron/j.ts": "B" }, "T-2");
    await h.service.enqueueLand("demo", a);
    const b = await h.service.board("demo");
    expect(b.integrationHead).toBe("c1000000");
    expect(b.lanes.OPEN.map((l) => l.id)).toEqual([1]);
    expect(b.lanes.READY.map((l) => l.id)).toEqual([a]);
    expect(b.readiness[a]?.ready).toBe(true);
    expect(b.readiness[1]?.reasons[0]).toEqual({ code: "WRONG_STATE", state: "OPEN" });
    expect(b.queue).toEqual([a]);
    expect(b.events["lane.open"]).toBe(2);
    expect(b.recent.length).toBeGreaterThan(0);
  });
});

describe("HamonnError", () => {
  it("maps codes to statuses", () => {
    expect(new HamonnError("UNAUTHORIZED", "x").status).toBe(401);
    expect(new HamonnError("UNKNOWN_HOST", "x").status).toBe(404);
  });
});
