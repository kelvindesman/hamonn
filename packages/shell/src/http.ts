import type { CheckStatus } from "@hamonn/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { HamonnError, normalizeError } from "./errors.ts";
import type { PushEvent } from "./ports.ts";
import type { Service } from "./service.ts";

/** Parses + authenticates a host webhook. Returns null for events hamonn ignores (non-push). */
export type WebhookNormalizer = (input: {
  body: string;
  headers: Headers;
  secret: string | undefined;
}) => Promise<PushEvent | null>;

export interface ApiOptions {
  /** Bearer token required on every non-GET request. */
  adminKey: string;
  /** Per-host webhook normalizers, keyed by `:host` in `/hooks/:host`. */
  hooks?: Record<string, WebhookNormalizer>;
  hookSecret?: string;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function json(c: Context): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HamonnError("BAD_REQUEST", "body must be a JSON object");
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "")
    throw new HamonnError("BAD_REQUEST", `${key} must be a non-empty string`);
  return v;
}

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}

function strList(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new HamonnError("BAD_REQUEST", `${key} must be an array of strings`);
  }
  return v as string[];
}

function id(c: Context, name: string): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n < 1) throw new HamonnError("BAD_REQUEST", `invalid ${name}`);
  return n;
}

export function createApi(service: Service, opts: ApiOptions): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    const err = normalizeError(e);
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET") return next();
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!opts.adminKey || !safeEqual(given, opts.adminKey)) {
      throw new HamonnError("UNAUTHORIZED", "missing or invalid bearer token");
    }
    return next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.post("/api/projects", async (c) => {
    const b = await json(c);
    const repo = b.repo as Record<string, unknown> | undefined;
    if (!repo || typeof repo !== "object") throw new HamonnError("BAD_REQUEST", "repo is required");
    const mode = optStr(b, "laneMode");
    if (mode !== undefined && mode !== "fork" && mode !== "branch") {
      throw new HamonnError("BAD_REQUEST", "laneMode must be fork or branch");
    }
    const project = await service.createProject({
      name: str(b, "name"),
      repo: { name: str(repo, "name"), remote: str(repo, "remote") },
      integrationBranch: optStr(b, "integrationBranch"),
      laneMode: mode,
      gatedPaths: strList(b, "gatedPaths"),
      requiredChecks: strList(b, "requiredChecks"),
    });
    return c.json(project, 201);
  });

  app.get("/api/projects/:p", async (c) => c.json(await service.board(c.req.param("p"))));

  app.post("/api/projects/:p/lanes", async (c) => {
    const b = await json(c);
    const claims = strList(b, "claims");
    if (!claims) throw new HamonnError("BAD_REQUEST", "claims is required");
    const r = await service.openLane(c.req.param("p"), {
      task: str(b, "task"),
      title: optStr(b, "title"),
      agent: str(b, "agent"),
      intent: str(b, "intent"),
      claims,
      strict: c.req.query("strict") === "1",
    });
    return c.json(r, 201);
  });

  app.get("/api/projects/:p/lanes/:id", async (c) =>
    c.json(await service.lane(c.req.param("p"), id(c, "id"))),
  );

  app.post("/api/projects/:p/lanes/:id/token", async (c) =>
    c.json(await service.mintLaneToken(c.req.param("p"), id(c, "id"))),
  );

  app.post("/api/projects/:p/lanes/:id/pushed", async (c) => {
    const b = await json(c);
    return c.json(
      await service.onPushed(c.req.param("p"), id(c, "id"), {
        before: optStr(b, "before"),
        after: str(b, "after"),
      }),
    );
  });

  app.post("/api/projects/:p/lanes/:id/checks", async (c) => {
    const b = await json(c);
    const status = str(b, "status");
    if (status !== "pass" && status !== "fail" && status !== "pending") {
      throw new HamonnError("BAD_REQUEST", "status must be pass, fail or pending");
    }
    return c.json(
      await service.recordCheck(c.req.param("p"), id(c, "id"), {
        name: str(b, "name"),
        status: status as CheckStatus,
        url: optStr(b, "url"),
      }),
    );
  });

  app.post("/api/projects/:p/lanes/:id/sign", async (c) => {
    const b = await json(c);
    return c.json(await service.sign(c.req.param("p"), id(c, "id"), str(b, "by")));
  });

  app.post("/api/projects/:p/lanes/:id/land", async (c) =>
    c.json(await service.enqueueLand(c.req.param("p"), id(c, "id")), 202),
  );

  app.post("/api/projects/:p/lanes/:id/archive", async (c) =>
    c.json(await service.archive(c.req.param("p"), id(c, "id"))),
  );

  app.post("/api/projects/:p/integration-remote", async (c) =>
    c.json(await service.integrationRemote(c.req.param("p"))),
  );

  app.post("/api/projects/:p/drain", async (c) => c.json(await service.drainQueue(c.req.param("p"))));

  app.get("/api/projects/:p/tasks/:t", async (c) =>
    c.json(await service.task(c.req.param("p"), c.req.param("t"))),
  );

  app.post("/api/projects/:p/tasks/:t/pick", async (c) => {
    const b = await json(c);
    const lane = b.lane;
    if (typeof lane !== "number" || !Number.isInteger(lane))
      throw new HamonnError("BAD_REQUEST", "lane must be an integer");
    return c.json(await service.pickWinner(c.req.param("p"), c.req.param("t"), lane));
  });

  app.post("/hooks/:host", async (c) => {
    const normalize = opts.hooks?.[c.req.param("host")];
    if (!normalize) throw new HamonnError("UNKNOWN_HOST", `no webhook handler for ${c.req.param("host")}`);
    const event = await normalize({
      body: await c.req.text(),
      headers: c.req.raw.headers,
      secret: opts.hookSecret,
    });
    if (!event) return c.json({ ignored: true }, 202);
    const view = await service.handlePushEvent(event);
    return c.json({ ignored: view === null }, 202);
  });

  return app;
}
