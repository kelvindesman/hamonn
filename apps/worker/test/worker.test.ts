import { describe, expect, it } from "vitest";
import { RemoteRegistry } from "../src/do/project.ts";
import type { Env } from "../src/env.ts";
import worker, { createWorkerApp, toProject } from "../src/index.ts";
import { forwardPush, handleBatch, routePush } from "../src/queue/consumer.ts";
import { authed, makeEnv } from "./harness.ts";

const LEDGER = (id: number) => ({
  [`.lane/${id}/intent.md`]: "do it",
  [`.lane/${id}/handoff.md`]: "done",
});

async function createProject(h: ReturnType<typeof makeEnv>, mode: "fork" | "branch" = "fork") {
  const repo = h.host.init("demo-app", { "src/a.ts": "a" });
  const app = createWorkerApp();
  const res = await app.request(
    "/api/projects",
    authed("POST", { name: "demo", repo, requiredChecks: ["unit"], laneMode: mode }),
    h.env,
  );
  expect(res.status).toBe(201);
  return { app, repo };
}

describe("worker front", () => {
  it("serves health and the project index", async () => {
    const h = makeEnv();
    const app = createWorkerApp();
    expect(await (await app.request("/healthz", {}, h.env)).json()).toEqual({
      ok: true,
      runtime: "cloudflare-workers",
    });
    const empty = await (await app.request("/", {}, h.env)).text();
    expect(empty).toContain("no projects yet");
    await createProject(h);
    const listed = await (await createWorkerApp().request("/", {}, h.env)).text();
    expect(listed).toContain('<a href="/p/demo">demo</a>');
  });

  it("rejects project creation without a name, with bad JSON, and without the key", async () => {
    const h = makeEnv();
    const app = createWorkerApp();
    expect((await app.request("/api/projects", authed("POST", {}), h.env)).status).toBe(400);
    expect((await app.request("/api/projects", { method: "POST", body: "not json" }, h.env)).status).toBe(
      400,
    );
    const noKey = await app.request(
      "/api/projects",
      { method: "POST", body: JSON.stringify({ name: "x", repo: { name: "r", remote: "u" } }) },
      h.env,
    );
    expect(noKey.status).toBe(401);
    // a failed create is not indexed
    expect(await (await app.request("/", {}, h.env)).text()).toContain("no projects yet");
  });

  it("routes API + UI calls to the project's Durable Object", async () => {
    const h = makeEnv();
    const { app } = await createProject(h);
    const board = await app.request("/api/projects/demo", {}, h.env);
    expect(((await board.json()) as { project: { name: string } }).project.name).toBe("demo");
    expect((await app.request("/p/demo", {}, h.env)).status).toBe(200);
    expect((await app.request("/api/projects/nope", {}, h.env)).status).toBe(404);
    expect(h.projectNs.instances.size).toBe(2); // demo + nope
    expect((await app.request("/t/demo/T-1", {}, h.env)).status).toBe(404);
    expect((await app.request("/l/demo/1", {}, h.env)).status).toBe(404);
  });

  it("creates project repos in the Artifacts namespace, admin only", async () => {
    const h = makeEnv();
    const app = createWorkerApp();
    const post = (body: unknown, init: RequestInit = authed("POST", body)) =>
      app.request("/api/admin/repos", init, h.env);
    expect((await post({ name: "r" }, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post(undefined, { ...authed("POST"), body: "nope" })).status).toBe(400);
    expect((await post({ name: "-bad" })).status).toBe(400);
    expect((await post({ name: "demo-app" })).status).toBe(501);
    const calls: unknown[] = [];
    h.env.ARTIFACTS = {
      ...h.env.ARTIFACTS,
      create: async (name, opts) => {
        calls.push([name, opts]);
        return { name, remote: `https://acct.artifacts.cloudflare.net/git/hamonn/${name}.git`, token: "t" };
      },
    };
    const res = await post({ name: "demo-app" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      name: "demo-app",
      remote: "https://acct.artifacts.cloudflare.net/git/hamonn/demo-app.git",
      defaultBranch: "main",
      token: "t",
    });
    expect(calls).toEqual([["demo-app", { setDefaultBranch: "main", description: "hamonn project repo" }]]);
  });

  it("exports fetch/queue handlers and DO classes", async () => {
    const h = makeEnv();
    const res = await worker.fetch(new Request("http://x/healthz"), h.env, {});
    expect(res.status).toBe(200);
    await worker.queue({ messages: [] }, h.env);
    const direct = await toProject(h.env, "p", new Request("http://x/api/projects/p"));
    expect(direct.status).toBe(404);
  });
});

describe("ProjectDO", () => {
  it("requires the project header on first contact and remembers it afterwards", async () => {
    const h = makeEnv();
    const stub = h.env.PROJECT.get(h.env.PROJECT.idFromName("p"));
    const res = await stub.fetch(new Request("http://x/api/projects/p"));
    expect(res.status).toBe(400);
    await createProject(h);
    const demo = h.env.PROJECT.get(h.env.PROJECT.idFromName("demo"));
    // header omitted: the name is recovered from durable storage
    expect((await demo.fetch(new Request("http://x/api/projects/demo"))).status).toBe(200);
  });

  it("schedules an alarm on land and the alarm drains the queue serially", async () => {
    const h = makeEnv();
    const { app } = await createProject(h);
    const call = (path: string, body?: unknown) => app.request(path, authed("POST", body), h.env);
    const open = async (task: string, agent: string, claims: string[]) =>
      (
        (await (await call("/api/projects/demo/lanes", { task, agent, intent: agent, claims })).json()) as {
          lane: { id: number; repo: { name: string } };
        }
      ).lane;
    const lanes = [await open("T-1", "a", ["a/**"]), await open("T-2", "b", ["b/**"])];
    for (const [i, lane] of lanes.entries()) {
      const sha = h.host.commit(lane.repo.name, "main", { [`${i ? "b" : "a"}/x`]: "1", ...LEDGER(lane.id) });
      await call(`/api/projects/demo/lanes/${lane.id}/pushed`, { after: sha });
      await call(`/api/projects/demo/lanes/${lane.id}/checks`, { name: "unit", status: "pass" });
      expect((await call(`/api/projects/demo/lanes/${lane.id}/land`)).status).toBe(202);
    }
    const state = h.states.get("demo");
    expect(state?.alarms.length).toBe(2);
    const dos = h.projectNs.get("demo") as unknown as { alarm(): Promise<void> };
    await dos.alarm();
    const board = (await (await app.request("/api/projects/demo", {}, h.env)).json()) as {
      lanes: Record<string, unknown[]>;
      queue: number[];
    };
    expect(board.lanes.LANDED).toHaveLength(2);
    expect(board.queue).toEqual([]);
  });

  it("alarm is a no-op for a DO that never saw a project", async () => {
    const h = makeEnv();
    const stub = h.env.PROJECT.get(h.env.PROJECT.idFromName("ghost")) as unknown as {
      alarm(): Promise<void>;
    };
    await expect(stub.alarm()).resolves.toBeUndefined();
  });
});

describe("RegistryDO + RemoteRegistry", () => {
  it("round-trips fork registrations and unknown routes", async () => {
    const h = makeEnv();
    const reg = new RemoteRegistry(h.env.REGISTRY);
    expect(await reg.lookup("fork-1")).toBeNull();
    await reg.register("fork-1", "demo", 7);
    expect(await reg.lookup("fork-1")).toEqual({ project: "demo", laneId: 7 });
    const stub = h.env.REGISTRY.get(h.env.REGISTRY.idFromName("global"));
    expect((await stub.fetch(new Request("http://registry/nope"))).status).toBe(404);
    expect(await (await stub.fetch(new Request("http://registry/lookup"))).json()).toBeNull();
    expect(await (await stub.fetch(new Request("http://registry/by-repo"))).json()).toBeNull();
  });
});

describe("queue consumer", () => {
  async function laneWithPush(h: ReturnType<typeof makeEnv>) {
    const { app } = await createProject(h);
    const opened = (await (
      await app.request(
        "/api/projects/demo/lanes",
        authed("POST", { task: "T", agent: "a", intent: "i", claims: ["src/**"] }),
        h.env,
      )
    ).json()) as {
      lane: { id: number; repo: { name: string } };
    };
    const sha = h.host.commit(opened.lane.repo.name, "main", {
      "src/a.ts": "changed",
      ...LEDGER(opened.lane.id),
    });
    return { app, lane: opened.lane, sha };
  }

  it("forwards cf.artifacts.repo.pushed to the owning project and acks everything", async () => {
    const h = makeEnv();
    const { app, lane, sha } = await laneWithPush(h);
    const acked: string[] = [];
    const msg = (body: unknown, tag: string) => ({
      body,
      ack: () => acked.push(`ack:${tag}`),
      retry: () => acked.push(`retry:${tag}`),
    });
    await handleBatch(
      {
        messages: [
          msg(
            {
              type: "cf.artifacts.repo.pushed",
              source: { repoName: lane.repo.name },
              payload: { ref: "refs/heads/main", after: sha },
            },
            "push",
          ),
          msg({ type: "cf.artifacts.repo.forked", source: { repoName: "x" } }, "forked"),
          msg(
            { type: "cf.artifacts.repo.pushed", source: { repoName: "stranger" }, payload: { after: sha } },
            "stranger",
          ),
          msg(null, "null"),
        ],
      },
      h.env,
    );
    expect(acked).toEqual(["ack:push", "ack:forked", "ack:stranger", "ack:null"]);
    const view = (await (await app.request(`/api/projects/demo/lanes/${lane.id}`, {}, h.env)).json()) as {
      lane: { state: string; head: string };
    };
    expect(view.lane).toMatchObject({ state: "PUSHED", head: sha });
  });

  it("ignores pushes from other Artifacts namespaces when one is configured", async () => {
    const h = makeEnv();
    h.env.HAMONN_ARTIFACTS_NAMESPACE = "hamonn";
    const { app, lane, sha } = await laneWithPush(h);
    const acked: string[] = [];
    const push = (namespace: string) => ({
      body: {
        type: "cf.artifacts.repo.pushed",
        source: { namespace, repoName: lane.repo.name },
        payload: { ref: "refs/heads/main", after: sha },
      },
      ack: () => acked.push(`ack:${namespace}`),
      retry: () => acked.push(`retry:${namespace}`),
    });
    await handleBatch({ messages: [push("other")] }, h.env);
    const before = (await (await app.request(`/api/projects/demo/lanes/${lane.id}`, {}, h.env)).json()) as {
      lane: { state: string };
    };
    expect(before.lane.state).toBe("OPEN");
    await handleBatch({ messages: [push("hamonn")] }, h.env);
    const after = (await (await app.request(`/api/projects/demo/lanes/${lane.id}`, {}, h.env)).json()) as {
      lane: { state: string; head: string };
    };
    expect(after.lane).toMatchObject({ state: "PUSHED", head: sha });
    expect(acked).toEqual(["ack:other", "ack:hamonn"]);
  });

  it("acks pushes for lanes that can no longer accept them, retries real failures", async () => {
    const h = makeEnv();
    const { app, lane, sha } = await laneWithPush(h);
    const outcomes: string[] = [];
    const push = (after: string) => ({
      body: { type: "cf.artifacts.repo.pushed", source: { repoName: lane.repo.name }, payload: { after } },
      ack: () => outcomes.push("ack"),
      retry: () => outcomes.push("retry"),
    });
    await app.request(`/api/projects/demo/lanes/${lane.id}/archive`, authed("POST"), h.env);
    await handleBatch({ messages: [push(sha)] }, h.env); // archived lane: permanent 409
    h.host.changedPaths = async () => {
      throw new Error("host down");
    };
    const { lane: other, sha: otherSha } = await (async () => {
      const r = (await (
        await app.request(
          "/api/projects/demo/lanes",
          authed("POST", { task: "T2", agent: "b", intent: "i", claims: ["x/**"] }),
          h.env,
        )
      ).json()) as {
        lane: { id: number; repo: { name: string } };
      };
      return { lane: r.lane, sha: h.host.commit(r.lane.repo.name, "main", { "x/f": "1" }) };
    })();
    await handleBatch(
      {
        messages: [
          {
            body: {
              type: "cf.artifacts.repo.pushed",
              source: { repoName: other.repo.name },
              payload: { after: otherSha },
            },
            ack: () => outcomes.push("ack"),
            retry: () => outcomes.push("retry"),
          },
        ],
      },
      h.env,
    );
    expect(outcomes).toEqual(["ack", "retry"]);
  });

  it("routes branch-mode pushes by project repo + lane ref", async () => {
    const h = makeEnv();
    await createProject(h, "branch");
    const env: Env = h.env;
    expect(await routePush(env, { repoName: "demo-app", ref: "refs/heads/lane/3", after: "x" })).toBe("demo");
    expect(await routePush(env, { repoName: "demo-app", ref: "refs/heads/main", after: "x" })).toBeNull();
    expect(await routePush(env, { repoName: "unrelated", ref: "refs/heads/lane/3", after: "x" })).toBeNull();
    expect(await forwardPush(env, { repoName: "unrelated", after: "x" })).toEqual({ ignored: true });
  });
});
