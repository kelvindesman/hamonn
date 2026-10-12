import { DatabaseSync } from "node:sqlite";
import { FakeHost } from "../../../packages/shell/test/fakes/fake-host.ts";
import { FakeWire } from "../../../packages/shell/test/fakes/fake-wire.ts";
import { ProjectDO } from "../src/do/project.ts";
import { RegistryDO } from "../src/do/registry.ts";
import type { DoNamespaceLike, DoStateLike, Env } from "../src/env.ts";

export const KEY = "worker-key";

export class FakeState implements DoStateLike {
  private db = new DatabaseSync(":memory:");
  private kv = new Map<string, unknown>();
  alarms: number[] = [];
  storage: DoStateLike["storage"] = {
    sql: {
      exec: (query, ...bindings) => {
        const rows = this.db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    setAlarm: async (t) => {
      this.alarms.push(t);
    },
    get: async <T>(k: string) => this.kv.get(k) as T | undefined,
    put: async (k, v) => {
      this.kv.set(k, v);
    },
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
}

class FakeNamespace<T extends { fetch(r: Request): Promise<Response> }> implements DoNamespaceLike {
  instances = new Map<string, T>();
  constructor(private make: (name: string) => T) {}
  idFromName(name: string) {
    return name;
  }
  get(id: unknown) {
    const name = String(id);
    let inst = this.instances.get(name);
    if (!inst) {
      inst = this.make(name);
      this.instances.set(name, inst);
    }
    return inst;
  }
}

export function makeEnv() {
  const host = new FakeHost();
  const wire = new FakeWire(host);
  const states = new Map<string, FakeState>();
  const registryNs = new FakeNamespace(() => new RegistryDO(new FakeState()));
  const projectNs = new FakeNamespace((name) => {
    const state = new FakeState();
    states.set(name, state);
    return new ProjectDO(state, env, { host, wire });
  });
  const env: Env = {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    PROJECT: projectNs,
    REGISTRY: registryNs,
    HAMONN_ADMIN_KEY: KEY,
  };
  return { env, host, wire, states, projectNs, registryNs };
}

export const authed = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
