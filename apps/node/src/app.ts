import { normalizeGithubWebhook } from "@hamonn/adapter-github";
import { LocalFsHost } from "@hamonn/adapter-local-fs";
import { loadKernel } from "@hamonn/core/node";
import { SystemGitWire } from "@hamonn/gitwire-system-git";
import {
  consoleLogger,
  createApi,
  createService,
  createUi,
  type GitHost,
  type Logger,
  systemClock,
  type WebhookNormalizer,
} from "@hamonn/shell";
import { SqliteStore } from "@hamonn/store-sqlite";
import { Hono } from "hono";

export interface NodeConfig {
  adminKey: string;
  /** Directory of bare repos for the `local-fs` host. */
  root: string;
  /** SQLite file; `:memory:` for tests. */
  dbPath: string;
  hookSecret?: string;
  hooks?: Record<string, WebhookNormalizer>;
  /** Override the host (e.g. a GitHub adapter). Defaults to `LocalFsHost(root)`. */
  host?: GitHost;
  log?: Logger;
}

/** Wire the portable core to Node-side adapters. Returns the app plus handles for shutdown/tests. */
export function buildApp(config: NodeConfig) {
  const store = new SqliteStore(config.dbPath);
  const log = config.log ?? consoleLogger;
  const host = config.host ?? new LocalFsHost(config.root);
  const pending = new Set<string>();
  const scheduleDrain = (project: string) => {
    if (pending.has(project)) return;
    pending.add(project);
    setTimeout(() => {
      pending.delete(project);
      service
        .drainQueue(project)
        .catch((e) => log.warn("drain.failed", { projectName: project, error: String(e) }));
    }, 0);
  };
  const service = createService({
    host,
    store,
    wire: new SystemGitWire(),
    registry: store,
    kernel: loadKernel(),
    clock: systemClock,
    log,
    scheduleDrain,
  });
  const app = new Hono();
  app.route("/", createUi(service));
  app.route(
    "/",
    createApi(service, {
      adminKey: config.adminKey,
      hooks: { github: normalizeGithubWebhook, ...config.hooks },
      hookSecret: config.hookSecret,
    }),
  );
  return { app, service, store, host, close: () => store.close() };
}
