import type { ArtifactsBinding } from "@hamonn/adapter-cloudflare-artifacts";

/** The slice of a Durable Object namespace hamonn uses (structural, so tests can fake it). */
export interface DoNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}

export interface Env {
  ARTIFACTS: ArtifactsBinding;
  PROJECT: DoNamespaceLike;
  REGISTRY: DoNamespaceLike;
  HAMONN_ADMIN_KEY: string;
  HAMONN_PUBLIC_URL?: string;
  /** Artifacts namespace this deployment owns; push events from other namespaces are ignored. */
  HAMONN_ARTIFACTS_NAMESPACE?: string;
}

/** The slice of `DurableObjectState` hamonn uses. */
export interface DoStateLike {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
    setAlarm(scheduledTime: number): Promise<void>;
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

export const PROJECT_HEADER = "x-hamonn-project";
