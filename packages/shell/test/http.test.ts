import { KernelError } from "@hamonn/core";
import { describe, expect, it } from "vitest";
import { normalizeError } from "../src/errors.ts";
import { createApi, safeEqual, type WebhookNormalizer } from "../src/http.ts";
import { consoleLogger, HamonnError, silentLogger, systemClock } from "../src/index.ts";
import { harness, LEDGER, laneFiles } from "./harness.ts";

// biome-ignore lint/suspicious/noExplicitAny: loosely-typed JSON in HTTP assertions
type Json = any;

const KEY = "s3cret";

function setup(hooks?: Record<string, WebhookNormalizer>, adminKey = KEY) {
  const h = harness();
  const app = createApi(h.service, { adminKey, hooks, hookSecret: "hs" });
  const call = async (method: string, path: string, body?: unknown, auth: string | null = KEY) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth !== null) headers.authorization = `Bearer ${auth}`;
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { h, app, call };
}

async function bootstrap(s: ReturnType<typeof setup>) {
  const p = await s.call("POST", "/api/projects", {
    name: "demo",
    repo: s.h.repo,
    gatedPaths: ["wrangler.jsonc"],
    requiredChecks: ["unit"],
  });
  expect(p.status).toBe(201);
}

describe("auth", () => {
  it("rejects missing/wrong bearer on writes, allows reads", async () => {
    const s = setup();
    expect((await s.call("POST", "/api/projects", {}, null)).status).toBe(401);
    expect((await s.call("POST", "/api/projects", {}, "nope")).status).toBe(401);
    expect((await s.call("GET", "/healthz", undefined, null)).body).toEqual({ ok: true });
    await bootstrap(s);
    expect((await s.call("GET", "/api/projects/demo", undefined, null)).status).toBe(200);
  });

  it("an unconfigured admin key locks every write", async () => {
    const s = setup(undefined, "");
    expect((await s.call("POST", "/api/projects", {}, "")).status).toBe(401);
  });

  it("safeEqual is exact", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
  });
});

describe("routes", () => {
  it("runs the full lane lifecycle over HTTP", async () => {
    const s = setup();
    await bootstrap(s);
    const opened = await s.call("POST", "/api/projects/demo/lanes", {
      task: "T-17",
      title: "rss",
      agent: "claude-A",
      intent: "feat: rss",
      claims: ["src/rss/**"],
    });
    expect(opened.status).toBe(201);
    expect(opened.body.lane.id).toBe(1);
    const sha = s.h.host.commit("demo-l1", "main", laneFiles(1, { "src/rss/feed.ts": "A", ...LEDGER }));
    const pushed = await s.call("POST", "/api/projects/demo/lanes/1/pushed", { before: "x", after: sha });
    expect(pushed.body.lane.state).toBe("PUSHED");
    const checked = await s.call("POST", "/api/projects/demo/lanes/1/checks", {
      name: "unit",
      status: "pass",
      url: "u",
    });
    expect(checked.body.lane.state).toBe("READY");
    expect((await s.call("GET", "/api/projects/demo/lanes/1")).body.checks).toHaveLength(1);
    const tokened = await s.call("POST", "/api/projects/demo/lanes/1/token");
    expect(tokened.body.token.secret).toBeTruthy();
    const queued = await s.call("POST", "/api/projects/demo/lanes/1/land");
    expect(queued).toMatchObject({ status: 202, body: { state: "READY", queuePosition: 0 } });
    const integration = await s.call("POST", "/api/projects/demo/integration-remote");
    expect(integration.body).toMatchObject({ branch: "main" });
    const drained = await s.call("POST", "/api/projects/demo/drain");
    expect(drained.body[0].state).toBe("LANDED");
    expect((await s.call("GET", "/api/projects/demo/tasks/T-17")).body.rows).toHaveLength(1);
    const archived = await s.call("POST", "/api/projects/demo/lanes/1/archive");
    expect(archived.status).toBe(409); // LANDED is terminal
  });

  it("signs gates, picks winners and archives", async () => {
    const s = setup();
    await bootstrap(s);
    await s.call("POST", "/api/projects/demo/lanes", {
      task: "T-1",
      agent: "a",
      intent: "i",
      claims: ["a/**", "wrangler.jsonc"],
    });
    const sha = s.h.host.commit(
      "demo-l1",
      "main",
      laneFiles(1, { "a/x": "1", "wrangler.jsonc": "{y}", ...LEDGER }),
    );
    await s.call("POST", "/api/projects/demo/lanes/1/pushed", { after: sha });
    await s.call("POST", "/api/projects/demo/lanes/1/checks", { name: "unit", status: "pass" });
    expect((await s.call("POST", "/api/projects/demo/lanes/1/sign", { by: "owner" })).body.lane.state).toBe(
      "READY",
    );
    const pick = await s.call("POST", "/api/projects/demo/tasks/T-1/pick", { lane: 1 });
    expect(pick.body).toMatchObject({ winner: 1, queuePosition: 0 });
  });

  it("strict open returns 409 CONFLICT_CLAIM", async () => {
    const s = setup();
    await bootstrap(s);
    const body = { task: "T-1", agent: "a", intent: "i", claims: ["a/**"] };
    await s.call("POST", "/api/projects/demo/lanes", body);
    const r = await s.call("POST", "/api/projects/demo/lanes?strict=1", body);
    expect(r).toMatchObject({ status: 409, body: { error: { code: "CONFLICT_CLAIM" } } });
  });
});

describe("validation", () => {
  it("returns 400 with a message for malformed input", async () => {
    const s = setup();
    await bootstrap(s);
    const bad = async (path: string, body: unknown) => {
      const r = await s.call("POST", path, body);
      expect(r.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      return r.body.error.message as string;
    };
    expect(await bad("/api/projects", "not json")).toMatch(/JSON object/);
    expect(await bad("/api/projects", "[1]")).toMatch(/JSON object/);
    expect(await bad("/api/projects", { name: "x" })).toMatch(/repo is required/);
    expect(await bad("/api/projects", { name: "x", repo: { name: "r" } })).toMatch(/remote/);
    expect(
      await bad("/api/projects", { name: "x", repo: { name: "r", remote: "u" }, laneMode: "zig" }),
    ).toMatch(/laneMode/);
    expect(
      await bad("/api/projects", { name: "x", repo: { name: "r", remote: "u" }, gatedPaths: "no" }),
    ).toMatch(/array of strings/);
    expect(
      await bad("/api/projects", { name: "x", repo: { name: "r", remote: "u" }, gatedPaths: [1] }),
    ).toMatch(/array of strings/);
    expect(await bad("/api/projects/demo/lanes", { task: "T", agent: "a", intent: "i" })).toMatch(
      /claims is required/,
    );
    expect(
      await bad("/api/projects/demo/lanes", { task: "", agent: "a", intent: "i", claims: ["a"] }),
    ).toMatch(/task/);
    expect(await bad("/api/projects/demo/lanes/x/pushed", { after: "a" })).toMatch(/invalid id/);
    expect(await bad("/api/projects/demo/lanes/0/pushed", { after: "a" })).toMatch(/invalid id/);
    expect(await bad("/api/projects/demo/lanes/1/checks", { name: "u", status: "meh" })).toMatch(/status/);
    expect(await bad("/api/projects/demo/tasks/T/pick", { lane: "1" })).toMatch(/integer/);
    expect(await bad("/api/projects/demo/lanes/1/sign", {})).toMatch(/by/);
  });

  it("maps domain errors to 404/409 and unknown failures to 500", async () => {
    const s = setup();
    await bootstrap(s);
    expect((await s.call("GET", "/api/projects/nope")).status).toBe(404);
    expect((await s.call("POST", "/api/projects/demo/lanes/9/archive")).status).toBe(404);
    s.h.service.board = async () => {
      throw new Error("boom");
    };
    const r = await s.call("GET", "/api/projects/demo");
    expect(r).toMatchObject({ status: 500, body: { error: { code: "INTERNAL", message: "boom" } } });
  });
});

describe("webhooks", () => {
  const push: WebhookNormalizer = async ({ body, secret }) => {
    if (secret !== "hs") throw new HamonnError("UNAUTHORIZED", "bad secret");
    const j = JSON.parse(body);
    return j.skip ? null : { repoName: j.repo, ref: j.ref, after: j.after };
  };

  it("normalizes and routes push events, ignores the rest", async () => {
    const s = setup({ fake: push });
    await bootstrap(s);
    await s.call("POST", "/api/projects/demo/lanes", {
      task: "T",
      agent: "a",
      intent: "i",
      claims: ["a/**"],
    });
    const sha = s.h.host.commit("demo-l1", "main", laneFiles(1, { "a/x": "1", ...LEDGER }));
    const ok = await s.app.request("/hooks/fake", {
      method: "POST",
      body: JSON.stringify({ repo: "demo-l1", after: sha }),
    });
    expect(await ok.json()).toEqual({ ignored: false });
    const unrelated = await s.app.request("/hooks/fake", {
      method: "POST",
      body: JSON.stringify({ repo: "zzz", after: sha }),
    });
    expect(await unrelated.json()).toEqual({ ignored: true });
    const skipped = await s.app.request("/hooks/fake", {
      method: "POST",
      body: JSON.stringify({ skip: true }),
    });
    expect(await skipped.json()).toEqual({ ignored: true });
    expect((await s.app.request("/hooks/nope", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("errors & util", () => {
  it("normalizeError covers kernel, hamonn and unknown values", () => {
    const he = new HamonnError("CONFLICT", "x");
    expect(normalizeError(he)).toBe(he);
    expect(normalizeError(new KernelError("INVALID_INPUT", "x")).code).toBe("BAD_REQUEST");
    expect(normalizeError(new KernelError("NOT_FOUND", "x")).code).toBe("NOT_FOUND");
    expect(normalizeError(new KernelError("WRONG_STATE", "x")).code).toBe("CONFLICT");
    expect(normalizeError("str")).toMatchObject({ code: "INTERNAL", message: "str" });
  });

  it("loggers emit structured output", () => {
    const lines: string[] = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (l: string) => lines.push(l);
    console.warn = (l: string) => lines.push(l);
    try {
      consoleLogger.info("a.b", { laneId: 1 });
      consoleLogger.warn("c.d");
    } finally {
      console.log = log;
      console.warn = warn;
    }
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { level: "info", event: "a.b", laneId: 1 },
      { level: "warn", event: "c.d" },
    ]);
    silentLogger.info("x");
    silentLogger.warn("x");
    expect(typeof systemClock.now()).toBe("number");
  });
});
