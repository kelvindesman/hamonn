import { ArtifactsHost } from "@hamonn/adapter-cloudflare-artifacts";
import { createKernel } from "@hamonn/core";
import wasm from "@hamonn/core/hamonn_core_bg.wasm";
import { IsomorphicWire } from "@hamonn/gitwire-isomorphic";
import {
  consoleLogger,
  createApi,
  createService,
  createUi,
  type GitHost,
  type GitWire,
  normalizeError,
  type Registry,
  systemClock,
} from "@hamonn/shell";
import { SqlStore } from "@hamonn/store-sql";
import { Hono } from "hono";
import http from "isomorphic-git/http/web";
import { type DoNamespaceLike, type DoStateLike, type Env, PROJECT_HEADER } from "../env.ts";
import { doDriver } from "./registry.ts";

/** `Registry` backed by the global RegistryDO. */
export class RemoteRegistry implements Registry {
  constructor(private ns: DoNamespaceLike) {}
  private stub() {
    return this.ns.get(this.ns.idFromName("global"));
  }
  async register(repoName: string, project: string, laneId: number) {
    await this.stub().fetch(
      new Request("http://registry/register", {
        method: "POST",
        body: JSON.stringify({ repo: repoName, project, laneId }),
      }),
    );
  }
  async lookup(repoName: string) {
    const res = await this.stub().fetch(
      new Request(`http://registry/lookup?repo=${encodeURIComponent(repoName)}`),
    );
    return (await res.json()) as { project: string; laneId: number } | null;
  }
}

export interface ProjectDeps {
  host?: GitHost;
  wire?: GitWire;
}

/**
 * One instance per project. Owns that project's SQLite state and runs the *serial* landing queue
 * from its alarm, so two concurrent `land` calls can never race on the integration branch.
 * Everything public (REST + board) is the same Hono app the Node runtime serves.
 */
export class ProjectDO {
  private app?: Hono;
  private service?: ReturnType<typeof createService>;

  constructor(
    private state: DoStateLike,
    private env: Env,
    private deps: ProjectDeps = {},
  ) {}

  private async init(name: string): Promise<void> {
    if (this.app) return;
    await this.state.storage.put("project", name);
    const store = new SqlStore(doDriver(this.state));
    this.service = createService({
      host: this.deps.host ?? new ArtifactsHost(this.env.ARTIFACTS),
      store,
      wire: this.deps.wire ?? new IsomorphicWire({ http }),
      registry: new RemoteRegistry(this.env.REGISTRY),
      kernel: createKernel(wasm),
      clock: systemClock,
      log: consoleLogger,
      scheduleDrain: () => {
        // Alarms are durable and coalesce: one pending alarm drains the whole queue.
        void this.state.storage.setAlarm(Date.now() + 10);
      },
    });
    const service = this.service;
    const app = new Hono();
    app.route("/", createUi(service));
    app.route("/", createApi(service, { adminKey: this.env.HAMONN_ADMIN_KEY }));
    // Internal routes are only reachable through the DO stub; the public Worker never forwards /internal.
    app.post("/internal/push", async (c) => {
      try {
        const view = await service.handlePushEvent(await c.req.json());
        return c.json({ ignored: view === null });
      } catch (e) {
        // 4xx = the event can never succeed (archived lane, unknown lane): the consumer acks it.
        const err = normalizeError(e);
        return c.json({ error: { code: err.code, message: err.message } }, err.status);
      }
    });
    this.app = app;
  }

  async fetch(req: Request): Promise<Response> {
    const name = req.headers.get(PROJECT_HEADER) ?? (await this.state.storage.get<string>("project"));
    if (!name)
      return Response.json(
        { error: { code: "BAD_REQUEST", message: "missing project header" } },
        { status: 400 },
      );
    await this.state.blockConcurrencyWhile(() => this.init(name));
    return (this.app as Hono).fetch(req);
  }

  async alarm(): Promise<void> {
    const name = await this.state.storage.get<string>("project");
    if (!name) return;
    await this.state.blockConcurrencyWhile(() => this.init(name));
    await this.service?.drainQueue(name);
  }
}
