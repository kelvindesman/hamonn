import { loadKernel } from "@hamonn/core/node";
import { MemoryStore } from "@hamonn/store-memory";
import { createService, type Logger } from "../src/index.ts";
import { FakeHost } from "./fakes/fake-host.ts";
import { FakeWire } from "./fakes/fake-wire.ts";

export const kernel = loadKernel();

export function harness(opts: { scheduleDrain?: (p: string) => void } = {}) {
  const host = new FakeHost();
  const store = new MemoryStore();
  const wire = new FakeWire(host);
  let t = 1_000;
  const clock = { now: () => (t += 10) };
  const logs: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (event, fields) => logs.push({ level: "info", event, fields }),
    warn: (event, fields) => logs.push({ level: "warn", event, fields }),
  };
  const service = createService({
    host,
    store,
    wire,
    registry: store,
    kernel,
    clock,
    log,
    scheduleDrain: opts.scheduleDrain,
  });
  const repo = host.init("demo-app", { "src/rss/feed.ts": "v0", "README.md": "hi", "wrangler.jsonc": "{}" });
  return { host, store, wire, service, logs, repo, kernel, clock };
}

export type Harness = ReturnType<typeof harness>;

export const LEDGER = {
  ".lane/intent.md": "do the thing",
  ".lane/handoff.md": "state: done",
};
