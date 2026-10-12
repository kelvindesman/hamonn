import type { PushEvent } from "@hamonn/shell";
import type { Env } from "../env.ts";
import { PROJECT_HEADER } from "../env.ts";

/** Artifacts event envelope (Queues event subscription). Only the fields hamonn reads. */
export interface ArtifactsEvent {
  type: string;
  source?: { type?: string; namespace?: string; repoName?: string };
  payload?: { ref?: string; before?: string; after?: string };
}

export interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}

/** Resolve which project (if any) owns a pushed repo: a lane fork, or a project repo on a `lane/<n>` ref. */
export async function routePush(env: Env, event: PushEvent): Promise<string | null> {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
  const lane = (await (
    await registry.fetch(new Request(`http://registry/lookup?repo=${encodeURIComponent(event.repoName)}`))
  ).json()) as {
    project: string;
  } | null;
  if (lane) return lane.project;
  if (!/^refs\/heads\/lane\/\d+$/.test(event.ref ?? "")) return null;
  const byRepo = await registry.fetch(
    new Request(`http://registry/by-repo?repo=${encodeURIComponent(event.repoName)}`),
  );
  return (await byRepo.json()) as string | null;
}

export async function forwardPush(env: Env, event: PushEvent): Promise<{ ignored: boolean }> {
  const project = await routePush(env, event);
  if (!project) return { ignored: true };
  const stub = env.PROJECT.get(env.PROJECT.idFromName(project));
  const res = await stub.fetch(
    new Request("http://project/internal/push", {
      method: "POST",
      headers: { [PROJECT_HEADER]: project, "content-type": "application/json" },
      body: JSON.stringify(event),
    }),
  );
  if (res.status >= 500) throw new Error(`project ${project} failed on push: ${res.status}`);
  // Any other non-2xx is permanent for this event (e.g. the lane was archived): don't retry it.
  if (!res.ok) return { ignored: true };
  return (await res.json()) as { ignored: boolean };
}

/** Queue consumer: `cf.artifacts.repo.pushed` -> the owning ProjectDO. Everything else is acknowledged. */
export async function handleBatch(batch: { messages: QueueMessage[] }, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const e = msg.body as ArtifactsEvent;
    try {
      if (e?.type === "cf.artifacts.repo.pushed" && e.source?.repoName && e.payload?.after) {
        await forwardPush(env, {
          repoName: e.source.repoName,
          ref: e.payload.ref,
          before: e.payload.before,
          after: e.payload.after,
        });
      }
      msg.ack();
    } catch (err) {
      console.warn(JSON.stringify({ level: "warn", event: "queue.push_failed", error: String(err) }));
      msg.retry();
    }
  }
}
