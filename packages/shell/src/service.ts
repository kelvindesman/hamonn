import type {
  CandidateRow,
  CheckResult,
  CheckStatus,
  Kernel,
  Lane,
  LaneState,
  Readiness,
  RepoRef,
  Task,
} from "@hamonn/core";
import { HamonnError } from "./errors.ts";
import type {
  Clock,
  GitHost,
  GitWire,
  Logger,
  Project,
  ProjectEvent,
  PushEvent,
  Registry,
  Store,
  Token,
} from "./ports.ts";

export interface Deps {
  host: GitHost;
  store: Store;
  wire: GitWire;
  registry: Registry;
  kernel: Kernel;
  clock: Clock;
  log: Logger;
  /** Called (fire-and-forget) after a lane is queued: DO alarm on Workers, timer on Node. */
  scheduleDrain?: (project: string) => void;
  author?: { name: string; email: string };
}

export interface CreateProjectInput {
  name: string;
  repo: RepoRef;
  integrationBranch?: string;
  laneMode?: "fork" | "branch";
  gatedPaths?: string[];
  requiredChecks?: string[];
}

export interface OpenLaneInput {
  task: string;
  title?: string;
  agent: string;
  intent: string;
  claims: string[];
  strict?: boolean;
}

export interface OpenLaneResult {
  lane: Lane;
  remote: string;
  token: Token;
  overlaps: number[];
  hint?: string;
}

export interface LaneView {
  lane: Lane;
  readiness: Readiness;
}

export interface LandOutcome {
  laneId: number;
  state: LaneState | "SKIPPED";
  landedSha?: string;
  conflictFiles?: string[];
  message?: string;
}

export interface Board {
  project: Project;
  integrationHead: string | null;
  lanes: Record<LaneState, Lane[]>;
  /** Why each lane is (not) ready, keyed by lane id. */
  readiness: Record<number, Readiness>;
  queue: number[];
  events: Record<string, number>;
  recent: ProjectEvent[];
}

export interface TaskView {
  task: Task;
  lanes: Lane[];
  rows: CandidateRow[];
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const STATES: LaneState[] = ["OPEN", "PUSHED", "READY", "LANDING", "LANDED", "BEHIND", "ARCHIVED", "FAILED"];
const EVALUATED: LaneState[] = ["PUSHED", "READY"];
const DEFAULT_AUTHOR = { name: "hamonn", email: "hamonn@users.noreply.local" };
const LEDGER_FILES = ["intent", "handoff", "evidence"] as const;
/** Upper bound on landings per drain, so a runaway queue cannot pin an isolate. */
const MAX_DRAIN = 25;

export function createService(deps: Deps) {
  const { host, store, wire, registry, kernel, clock, log } = deps;
  const author = deps.author ?? DEFAULT_AUTHOR;

  async function mustProject(name: string): Promise<Project> {
    const p = await store.getProject(name);
    if (!p) throw new HamonnError("NOT_FOUND", `unknown project: ${name}`);
    return p;
  }

  async function mustLane(project: string, id: number): Promise<Lane> {
    const l = await store.getLane(project, id);
    if (!l) throw new HamonnError("NOT_FOUND", `unknown lane #${id} in ${project}`);
    return l;
  }

  async function record(project: string, kind: string, laneId?: number, detail?: string): Promise<void> {
    await store.appendEvent(project, { at: clock.now(), kind, laneId, detail });
    log.info(kind, { projectName: project, laneId, detail });
  }

  async function revokeQuietly(repo: RepoRef, tokenId: string | undefined): Promise<void> {
    if (!tokenId) return;
    try {
      await host.revokeToken(repo, tokenId);
    } catch (e) {
      log.warn("token.revoke_failed", { repo: repo.name, tokenId, error: String(e) });
    }
  }

  /** Re-run readiness; promote/demote PUSHED<->READY when the lane is in an evaluable state. */
  async function reevaluate(project: Project, lane: Lane): Promise<LaneView> {
    const checks = await store.listChecks(project.name, lane.id);
    const readiness = kernel.evaluate(lane, checks, project);
    let next = lane;
    if (EVALUATED.includes(lane.state)) {
      next = kernel.settle(lane, readiness, clock.now());
      if (next.state !== lane.state) await record(project.name, `lane.${next.state.toLowerCase()}`, lane.id);
    }
    await store.putLane(project.name, next);
    return { lane: next, readiness };
  }

  const service = {
    async createProject(input: CreateProjectInput): Promise<Project> {
      if (!NAME_RE.test(input.name))
        throw new HamonnError("BAD_REQUEST", `invalid project name: ${input.name}`);
      if (await store.getProject(input.name))
        throw new HamonnError("CONFLICT", `project exists: ${input.name}`);
      const integrationBranch = input.integrationBranch ?? "main";
      const head = await host.headSha(input.repo, integrationBranch);
      if (!head) {
        throw new HamonnError("BAD_REQUEST", `${input.repo.name} has no branch ${integrationBranch}`);
      }
      const project: Project = {
        name: input.name,
        repo: input.repo,
        integrationBranch,
        laneMode: input.laneMode ?? "fork",
        gatedPaths: input.gatedPaths ?? [],
        requiredChecks: input.requiredChecks ?? [],
        createdAt: clock.now(),
      };
      await store.putProject(project);
      await record(project.name, "project.created", undefined, host.kind);
      return project;
    },

    async openLane(projectName: string, input: OpenLaneInput): Promise<OpenLaneResult> {
      const project = await mustProject(projectName);
      return store.withLock(projectName, async () => {
        const base = await host.headSha(project.repo, project.integrationBranch);
        if (!base) throw new HamonnError("CONFLICT", `${project.integrationBranch} has no commits`);
        const laneId = await store.nextLaneId(projectName);
        const open = (await store.listLanes(projectName)).map((l) => ({
          id: l.id,
          taskId: l.taskId,
          state: l.state,
          claims: l.claims,
        }));
        const plan = kernel.planOpen(
          {
            project,
            laneId,
            taskId: input.task,
            agent: input.agent,
            intent: input.intent,
            claims: input.claims,
            base,
            now: clock.now(),
          },
          open,
        );
        if (input.strict && plan.overlaps.length > 0) {
          throw new HamonnError("CONFLICT_CLAIM", plan.hint!, { overlaps: plan.overlaps });
        }
        if (!(await store.getTask(projectName, input.task))) {
          await store.putTask(projectName, {
            id: input.task,
            projectName,
            title: input.title ?? input.task,
          });
        }
        const repo = plan.forkName ? await host.fork(project.repo, plan.forkName) : project.repo;
        const token = await host.mintToken(repo, "write", plan.tokenTtlSec);
        const lane: Lane = { ...plan.lane, repo, tokenId: token.id, tokenExpires: token.expiresAt };
        await store.putLane(projectName, lane);
        // Only forks are unique to a lane; in branch mode the shared repo must not map to one lane.
        if (plan.forkName) await registry.register(repo.name, projectName, laneId);
        await record(projectName, "lane.open", laneId, input.agent);
        return { lane, remote: host.remoteUrl(repo, token), token, overlaps: plan.overlaps, hint: plan.hint };
      });
    },

    async mintLaneToken(projectName: string, laneId: number): Promise<{ remote: string; token: Token }> {
      const lane = await mustLane(projectName, laneId);
      if (lane.state === "LANDED" || lane.state === "ARCHIVED") {
        throw new HamonnError("CONFLICT", `lane #${laneId} is ${lane.state}`);
      }
      return store.withLock(projectName, async () => {
        await revokeQuietly(lane.repo, lane.tokenId);
        const token = await host.mintToken(lane.repo, "write", 3600);
        await store.putLane(projectName, { ...lane, tokenId: token.id, tokenExpires: token.expiresAt });
        return { remote: host.remoteUrl(lane.repo, token), token };
      });
    },

    /** A push landed in a lane's repo (queue event, webhook or `hamonn push`). Idempotent per head. */
    async onPushed(
      projectName: string,
      laneId: number,
      push: { before?: string; after: string },
    ): Promise<LaneView> {
      const project = await mustProject(projectName);
      return store.withLock(projectName, async () => {
        const lane = await mustLane(projectName, laneId);
        if (lane.head === push.after) return reevaluate(project, lane);
        const integrationHead = await host.headSha(project.repo, project.integrationBranch);
        const forkPoint = integrationHead
          ? await host.mergeBase?.(lane.repo, push.after, integrationHead)
          : null;
        const touched = await host.changedPaths(lane.repo, forkPoint ?? lane.base, push.after);
        const [intent, handoff, evidence] = await Promise.all(
          LEDGER_FILES.map((f) => host.readFile(lane.repo, push.after, `.lane/${lane.id}/${f}.md`)),
        );
        const ledger = kernel.parseLedger({
          intent: intent ?? undefined,
          handoff: handoff ?? undefined,
          evidence: evidence ?? undefined,
        });
        const pushed = kernel.applyPush(
          lane,
          { head: push.after, touched, ledger, now: clock.now() },
          project,
        );
        await record(projectName, "lane.pushed", laneId, push.after.slice(0, 7));
        return reevaluate(project, pushed);
      });
    },

    /** Route a host push event (queue message / webhook) to its lane. Returns null when unrelated. */
    async handlePushEvent(event: PushEvent): Promise<LaneView | null> {
      const hit = await registry.lookup(event.repoName);
      if (hit) return service.onPushed(hit.project, hit.laneId, event);
      const m = /^refs\/heads\/lane\/(\d+)$/.exec(event.ref ?? "");
      if (!m) return null;
      const project = (await store.listProjects()).find((p) => p.repo.name === event.repoName);
      return project ? service.onPushed(project.name, Number(m[1]), event) : null;
    },

    async recordCheck(
      projectName: string,
      laneId: number,
      input: { name: string; status: CheckStatus; url?: string },
    ): Promise<LaneView> {
      const project = await mustProject(projectName);
      return store.withLock(projectName, async () => {
        const lane = await mustLane(projectName, laneId);
        const check: CheckResult = {
          laneId,
          name: input.name,
          status: input.status,
          url: input.url,
          head: lane.head,
          at: clock.now(),
        };
        await store.putCheck(projectName, check);
        await record(projectName, "check.recorded", laneId, `${input.name}=${input.status}`);
        return reevaluate(project, lane);
      });
    },

    async sign(projectName: string, laneId: number, by: string): Promise<LaneView> {
      const project = await mustProject(projectName);
      return store.withLock(projectName, async () => {
        const lane = kernel.sign(await mustLane(projectName, laneId), by, clock.now());
        await record(projectName, "lane.signed", laneId, by);
        return reevaluate(project, lane);
      });
    },

    async archive(projectName: string, laneId: number): Promise<Lane> {
      await mustProject(projectName);
      return store.withLock(projectName, () => archiveLocked(projectName, laneId));
    },

    async enqueueLand(
      projectName: string,
      laneId: number,
    ): Promise<{ state: LaneState; queuePosition: number }> {
      await mustProject(projectName);
      const lane = await mustLane(projectName, laneId);
      kernel.canEnqueue(lane);
      const queue = await store.listQueue(projectName);
      if (!queue.some((e) => e.laneId === laneId)) {
        await store.enqueue(projectName, { laneId, enqueuedAt: clock.now() });
        await record(projectName, "lane.enqueued", laneId);
      }
      deps.scheduleDrain?.(projectName);
      const position = kernel.queuePosition(await store.listQueue(projectName), laneId);
      return { state: lane.state, queuePosition: position! };
    },

    /** Land queued lanes one at a time until the queue is empty. */
    async drainQueue(projectName: string): Promise<LandOutcome[]> {
      const outcomes: LandOutcome[] = [];
      for (let i = 0; i < MAX_DRAIN; i++) {
        const outcome = await store.withLock(projectName, () => landNext(projectName));
        if (!outcome) break;
        outcomes.push(outcome);
      }
      return outcomes;
    },

    async pickWinner(projectName: string, taskId: string, laneId: number) {
      await mustProject(projectName);
      const task = await store.getTask(projectName, taskId);
      if (!task) throw new HamonnError("NOT_FOUND", `unknown task ${taskId}`);
      const lanes = (await store.listLanes(projectName)).filter((l) => l.taskId === taskId);
      const plan = kernel.pickWinner(task, lanes, laneId);
      await store.withLock(projectName, async () => {
        for (const id of plan.archive) await archiveLocked(projectName, id);
        await store.putTask(projectName, plan.task);
      });
      await record(projectName, "task.picked", laneId, taskId);
      const queued = await service.enqueueLand(projectName, plan.winner);
      return { ...plan, ...queued };
    },

    async lane(projectName: string, laneId: number): Promise<LaneView & { checks: CheckResult[] }> {
      const project = await mustProject(projectName);
      const lane = await mustLane(projectName, laneId);
      const checks = await store.listChecks(projectName, laneId);
      return { lane, checks, readiness: kernel.evaluate(lane, checks, project) };
    },

    async task(projectName: string, taskId: string): Promise<TaskView> {
      await mustProject(projectName);
      const task = await store.getTask(projectName, taskId);
      if (!task) throw new HamonnError("NOT_FOUND", `unknown task ${taskId}`);
      const lanes = (await store.listLanes(projectName)).filter((l) => l.taskId === taskId);
      const checks = await store.listChecks(projectName);
      return { task, lanes, rows: kernel.compare(lanes, checks) };
    },

    async board(projectName: string): Promise<Board> {
      const project = await mustProject(projectName);
      const lanes = Object.fromEntries(STATES.map((s) => [s, [] as Lane[]])) as Record<LaneState, Lane[]>;
      const checks = await store.listChecks(projectName);
      const readiness: Record<number, Readiness> = {};
      for (const l of await store.listLanes(projectName)) {
        lanes[l.state].push(l);
        readiness[l.id] = kernel.evaluate(l, checks, project);
      }
      const events: Record<string, number> = {};
      const all = await store.listEvents(projectName, 500);
      for (const e of all) events[e.kind] = (events[e.kind] ?? 0) + 1;
      return {
        project,
        integrationHead: await host.headSha(project.repo, project.integrationBranch),
        lanes,
        readiness,
        queue: kernel.queueOrder(await store.listQueue(projectName)),
        events,
        recent: all.slice(0, 20),
      };
    },
  };

  async function archiveLocked(projectName: string, laneId: number): Promise<Lane> {
    const lane = kernel.archive(await mustLane(projectName, laneId), clock.now());
    await store.putLane(projectName, lane);
    await store.dequeue(projectName, laneId);
    await revokeQuietly(lane.repo, lane.tokenId);
    await record(projectName, "lane.archived", laneId);
    return lane;
  }

  /** Pop and land the head of the queue. Must run under the project lock. */
  async function landNext(projectName: string): Promise<LandOutcome | null> {
    const project = await mustProject(projectName);
    const laneId = kernel.nextInQueue(await store.listQueue(projectName));
    if (laneId === null) return null;
    await store.dequeue(projectName, laneId);
    const lane = await mustLane(projectName, laneId);
    let plan: ReturnType<Kernel["planLand"]>;
    try {
      plan = kernel.planLand(lane, project, clock.now());
    } catch (e) {
      log.warn("land.skipped", { projectName, laneId, error: String(e) });
      return { laneId, state: "SKIPPED", message: (e as Error).message };
    }
    await store.putLane(projectName, plan.lane);
    await record(projectName, "lane.landing", laneId);

    const ttl = plan.tokenTtlSec;
    const intTok = await host.mintToken(project.repo, "write", ttl);
    const laneTok = await host.mintToken(lane.repo, "read", ttl);
    let result: Awaited<ReturnType<GitWire["land"]>>;
    try {
      result = await wire.land({
        integrationRemote: host.remoteUrl(project.repo, intTok),
        laneRemote: host.remoteUrl(lane.repo, laneTok),
        integrationBranch: plan.integrationBranch,
        laneBranch: plan.laneBranch,
        message: plan.message,
        author,
      });
    } catch (e) {
      result = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    }

    let proof: { integrationHead: string; isAncestor: boolean } | undefined;
    if (result.kind === "clean") {
      const integrationHead = (await host.headSha(project.repo, project.integrationBranch)) ?? "";
      const verifyTok = await host.mintToken(project.repo, "read", ttl);
      let isAncestor = false;
      try {
        isAncestor = await wire.isAncestor({
          remote: host.remoteUrl(project.repo, verifyTok),
          branch: project.integrationBranch,
          ancestor: plan.head,
          descendant: integrationHead,
        });
      } catch (e) {
        log.warn("land.proof_error", { projectName, laneId, error: String(e) });
      }
      await revokeQuietly(project.repo, verifyTok.id);
      proof = { integrationHead, isAncestor };
    }
    const landed = kernel.applyLandResult(plan.lane, result, proof, clock.now());
    await store.putLane(projectName, landed);
    await revokeQuietly(project.repo, intTok.id);
    await revokeQuietly(lane.repo, laneTok.id);
    if (landed.state === "LANDED") await revokeQuietly(lane.repo, lane.tokenId);
    await record(
      projectName,
      `lane.${landed.state.toLowerCase()}`,
      laneId,
      landed.landedSha ?? landed.failure,
    );
    return {
      laneId,
      state: landed.state,
      landedSha: landed.landedSha,
      conflictFiles: landed.conflictFiles,
      message: landed.failure,
    };
  }

  return service;
}

export type Service = ReturnType<typeof createService>;
