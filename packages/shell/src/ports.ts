import type { CheckResult, Lane, ProjectPolicy, QueueEntry, RepoRef, Task, WireResult } from "@hamonn/core";

/** Short-lived credential for one repo. `secret` is never persisted by the shell. */
export interface Token {
  id: string;
  secret: string;
  /** Unix seconds. */
  expiresAt: number;
}

export type HostKind = "cloudflare-artifacts" | "github" | "gitlab" | "bitbucket" | "local-fs";

export interface PushEvent {
  repoName: string;
  ref?: string;
  before?: string;
  after: string;
}

export type EventSink = (event: PushEvent) => Promise<void>;

/**
 * The only host-specific surface. Landing itself (`GitWire`) is identical for every host because
 * all of them speak git smart-HTTP; these verbs are everything a host must add.
 */
export interface GitHost {
  readonly kind: HostKind;
  fork(src: RepoRef, name: string): Promise<RepoRef>;
  mintToken(repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token>;
  revokeToken(repo: RepoRef, tokenId: string): Promise<void>;
  headSha(repo: RepoRef, ref: string): Promise<string | null>;
  readFile(repo: RepoRef, ref: string, path: string): Promise<string | null>;
  /** Paths that differ between `before` (null = empty tree) and `after`. Sorted, unique. */
  changedPaths(repo: RepoRef, before: string | null, after: string): Promise<string[]>;
  /**
   * Optional: best common ancestor of `a` and `b` as far as `repo` knows them, or null when
   * unknown (e.g. `b` was never pushed to this fork). Lets touched-path/drift detection start
   * from the point a rebased lane actually diverged; without it the shell falls back to the
   * integration head the lane was opened at.
   */
  mergeBase?(repo: RepoRef, a: string, b: string): Promise<string | null>;
  /** Optional push-event subscription; hosts without it rely on `hamonn push` posting `/pushed`. */
  subscribe?(repo: RepoRef, sink: EventSink): Promise<void>;
  /** URL for `git clone/push`, with `token` embedded when given. */
  remoteUrl(repo: RepoRef, token?: Token): string;
}

export interface LandInput {
  /** Integration remote with a short-lived *write* credential embedded. */
  integrationRemote: string;
  /** Lane remote with a short-lived *read* credential embedded. */
  laneRemote: string;
  integrationBranch: string;
  laneBranch: string;
  message: string;
  author: { name: string; email: string };
}

export interface AncestorInput {
  /** Any remote of the integration repo with a read credential. */
  remote: string;
  branch: string;
  ancestor: string;
  descendant: string;
}

/** Merges the lane into the integration branch over git smart-HTTP. Never touches a host API. */
export interface GitWire {
  land(input: LandInput): Promise<WireResult>;
  /** Independently re-fetch `branch` and report whether `ancestor` is reachable from `descendant`. */
  isAncestor(input: AncestorInput): Promise<boolean>;
}

export interface Project extends ProjectPolicy {
  repo: RepoRef;
  createdAt: number;
}

export interface ProjectEvent {
  at: number;
  kind: string;
  laneId?: number;
  detail?: string;
}

/** Persistence. One logical project is mutated at a time through `withLock`. */
export interface Store {
  withLock<T>(project: string, fn: () => Promise<T>): Promise<T>;
  putProject(p: Project): Promise<void>;
  getProject(name: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  nextLaneId(project: string): Promise<number>;
  putTask(project: string, t: Task): Promise<void>;
  getTask(project: string, id: string): Promise<Task | null>;
  listTasks(project: string): Promise<Task[]>;
  putLane(project: string, lane: Lane): Promise<void>;
  getLane(project: string, id: number): Promise<Lane | null>;
  listLanes(project: string): Promise<Lane[]>;
  putCheck(project: string, check: CheckResult): Promise<void>;
  listChecks(project: string, laneId?: number): Promise<CheckResult[]>;
  enqueue(project: string, entry: QueueEntry): Promise<void>;
  dequeue(project: string, laneId: number): Promise<void>;
  listQueue(project: string): Promise<QueueEntry[]>;
  appendEvent(project: string, ev: ProjectEvent): Promise<void>;
  listEvents(project: string, limit: number): Promise<ProjectEvent[]>;
}

/** Maps a lane's fork repo name back to its lane (events carry only the repo name). */
export interface Registry {
  register(repoName: string, project: string, laneId: number): Promise<void>;
  lookup(repoName: string): Promise<{ project: string; laneId: number } | null>;
}

export interface Clock {
  /** Unix milliseconds. */
  now(): number;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}
