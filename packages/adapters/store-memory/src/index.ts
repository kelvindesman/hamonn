import type { CheckResult, Lane, QueueEntry, Task } from "@hamonn/core";
import type { Project, ProjectEvent, Registry, Store } from "@hamonn/shell";

interface ProjectData {
  lastLaneId: number;
  tasks: Map<string, Task>;
  lanes: Map<number, Lane>;
  checks: CheckResult[];
  queue: QueueEntry[];
  events: ProjectEvent[];
  lock: Promise<unknown>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Reference `Store` + `Registry`. Values are cloned on the way in and out so callers cannot alias state. */
export class MemoryStore implements Store, Registry {
  private projects = new Map<string, Project>();
  private data = new Map<string, ProjectData>();
  private forks = new Map<string, { project: string; laneId: number }>();

  private of(project: string): ProjectData {
    let d = this.data.get(project);
    if (!d) {
      d = {
        lastLaneId: 0,
        tasks: new Map(),
        lanes: new Map(),
        checks: [],
        queue: [],
        events: [],
        lock: Promise.resolve(),
      };
      this.data.set(project, d);
    }
    return d;
  }

  withLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const d = this.of(project);
    const run = d.lock.then(fn, fn);
    d.lock = run.catch(() => {});
    return run;
  }

  async putProject(p: Project) {
    this.projects.set(p.name, clone(p));
  }
  async getProject(name: string) {
    const p = this.projects.get(name);
    return p ? clone(p) : null;
  }
  async listProjects() {
    return [...this.projects.values()].map(clone);
  }
  async nextLaneId(project: string) {
    const d = this.of(project);
    d.lastLaneId += 1;
    return d.lastLaneId;
  }
  async putTask(project: string, t: Task) {
    this.of(project).tasks.set(t.id, clone(t));
  }
  async getTask(project: string, id: string) {
    const t = this.of(project).tasks.get(id);
    return t ? clone(t) : null;
  }
  async listTasks(project: string) {
    return [...this.of(project).tasks.values()].map(clone);
  }
  async putLane(project: string, lane: Lane) {
    this.of(project).lanes.set(lane.id, clone(lane));
  }
  async getLane(project: string, id: number) {
    const l = this.of(project).lanes.get(id);
    return l ? clone(l) : null;
  }
  async listLanes(project: string) {
    return [...this.of(project).lanes.values()].map(clone).sort((a, b) => a.id - b.id);
  }
  async putCheck(project: string, check: CheckResult) {
    this.of(project).checks.push(clone(check));
  }
  async listChecks(project: string, laneId?: number) {
    const all = this.of(project).checks;
    return clone(laneId === undefined ? all : all.filter((c) => c.laneId === laneId));
  }
  async enqueue(project: string, entry: QueueEntry) {
    this.of(project).queue.push(clone(entry));
  }
  async dequeue(project: string, laneId: number) {
    const d = this.of(project);
    d.queue = d.queue.filter((e) => e.laneId !== laneId);
  }
  async listQueue(project: string) {
    return clone(this.of(project).queue);
  }
  async appendEvent(project: string, ev: ProjectEvent) {
    this.of(project).events.unshift(clone(ev));
  }
  async listEvents(project: string, limit: number) {
    return clone(this.of(project).events.slice(0, limit));
  }

  async register(repoName: string, project: string, laneId: number) {
    this.forks.set(repoName, { project, laneId });
  }
  async lookup(repoName: string) {
    const hit = this.forks.get(repoName);
    return hit ? { ...hit } : null;
  }
}
