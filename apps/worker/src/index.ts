import { landingPage } from "@hamonn/shell";
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
