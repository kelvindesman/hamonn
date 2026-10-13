import { landingPage, safeEqual } from "@hamonn/shell";
import { Hono } from "hono";
import { ProjectDO } from "./do/project.ts";
import { RegistryDO } from "./do/registry.ts";
import { type Env, PROJECT_HEADER } from "./env.ts";
import { handleBatch } from "./queue/consumer.ts";

export { ProjectDO, RegistryDO };

/** Forward a request to the ProjectDO that owns `project`. */
export function toProject(env: Env, project: string, req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set(PROJECT_HEADER, project);
  return env.PROJECT.get(env.PROJECT.idFromName(project)).fetch(new Request(req, { headers }));
}

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));

export function createWorkerApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/healthz", (c) => c.json({ ok: true, runtime: "cloudflare-workers" }));

  app.get("/", async (c) => {
    const rows = (await (await registry(c.env).fetch(new Request("http://registry/projects"))).json()) as {
      name: string;
      repo?: string;
    }[];
    return c.html(landingPage(rows));
  });

  // TEMPORARY live probe of raw Artifacts binding output (removed after the first live run).
  app.get("/api/admin/probe", async (c) => {
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!c.env.HAMONN_ADMIN_KEY || !safeEqual(given, c.env.HAMONN_ADMIN_KEY)) return c.text("no", 401);
    const out: Record<string, unknown> = {};
    const sha = c.req.query("sha") ?? "";
    for (const repo of (c.req.query("repos") ?? "").split(",")) {
      const h = await c.env.ARTIFACTS.get(repo);
      const r: Record<string, unknown> = {};
      const run = async (k: string, f: () => Promise<unknown>) => {
        try {
          r[k] = await f();
        } catch (e) {
          r[k] = `ERR ${String(e)}`;
        }
      };
      await run("info", () => h.info());
      await run("logMain", () => h.log({ ref: "main", limit: 3 }));
      await run("logSha", () => h.log({ ref: sha, limit: 2 }));
      await run("readCommit", () => h.readCommit(sha));
      await run("readTree", async () =>
        h.readTree(((await h.readCommit(sha)) as { treeHash: string }).treeHash),
      );
      out[repo] = r;
    }
    return c.json(out);
  });

  // Create a project repo in this deployment's Artifacts namespace (the binding is the only credential).
  app.post("/api/admin/repos", async (c) => {
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!c.env.HAMONN_ADMIN_KEY || !safeEqual(given, c.env.HAMONN_ADMIN_KEY)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } }, 401);
    }
    let name: unknown;
    try {
      name = ((await c.req.json()) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return c.json({ error: { code: "BAD_REQUEST", message: "valid repo name is required" } }, 400);
    }
    if (!c.env.ARTIFACTS.create) {
      return c.json(
        { error: { code: "NOT_SUPPORTED", message: "Artifacts binding cannot create repos" } },
        501,
      );
    }
    const r = await c.env.ARTIFACTS.create(name, {
      setDefaultBranch: "main",
      description: "hamonn project repo",
    });
    return c.json(
      { name: r.name, remote: r.remote, defaultBranch: r.defaultBranch ?? "main", token: r.token },
      201,
    );
  });

  // Project creation names its project in the body, so peek at it to pick the Durable Object.
  app.post("/api/projects", async (c) => {
    const text = await c.req.text();
    let name: unknown;
    try {
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    if (typeof name !== "string" || !name) {
      return c.json({ error: { code: "BAD_REQUEST", message: "name is required" } }, 400);
    }
    const res = await toProject(
      c.env,
      name,
      new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: text }),
    );
    if (res.status === 201) {
      const repo = (JSON.parse(text) as { repo?: { name?: string } }).repo?.name ?? "";
      await registry(c.env).fetch(
        new Request("http://registry/project", { method: "POST", body: JSON.stringify({ name, repo }) }),
      );
    }
    return res;
  });

  const forward = (c: { env: Env; req: { raw: Request; param(k: string): string } }) =>
    toProject(c.env, c.req.param("project"), c.req.raw);
  app.all("/api/projects/:project", forward);
  app.all("/api/projects/:project/*", forward);
  app.get("/p/:project", forward);
  app.get("/t/:project/:task", forward);
  app.get("/l/:project/:id", forward);

  return app;
}

const app = createWorkerApp();

export default {
  fetch: (req: Request, env: Env, ctx: unknown) => app.fetch(req, env, ctx as never),
  queue: (batch: { messages: import("./queue/consumer.ts").QueueMessage[] }, env: Env) =>
    handleBatch(batch, env),
};
