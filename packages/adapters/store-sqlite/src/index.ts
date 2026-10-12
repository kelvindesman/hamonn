import { DatabaseSync } from "node:sqlite";
import type { CheckResult, Lane, QueueEntry, Task } from "@hamonn/core";
import type { Project, ProjectEvent, Registry, Store } from "@hamonn/shell";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (project TEXT PRIMARY KEY, last_lane_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (project TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (project, id));
CREATE TABLE IF NOT EXISTS lanes (project TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (project, id));
CREATE TABLE IF NOT EXISTS checks (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, lane_id INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (project TEXT NOT NULL, lane_id INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, PRIMARY KEY (project, lane_id));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forks (repo TEXT PRIMARY KEY, project TEXT NOT NULL, lane_id INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(row.json as string) as T) : null);

/** `Store` + `Registry` on `node:sqlite` (built in since Node 22.5; no native build step). */
export class SqliteStore implements Store, Registry {
  private db: DatabaseSync;
  private locks = new Map<string, Promise<unknown>>();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  withLock<T>(project: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(project) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      project,
      run.catch(() => {}),
    );
    return run;
  }

  private one(sql: string, ...args: (string | number)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: (string | number)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  private exec(sql: string, ...args: (string | number)[]): void {
    this.db.prepare(sql).run(...args);
  }

  async putProject(p: Project) {
    this.exec("INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)", p.name, JSON.stringify(p));
  }
  async getProject(name: string) {
    return parse<Project>(this.one("SELECT json FROM projects WHERE name = ?", name));
  }
  async listProjects() {
    return this.all("SELECT json FROM projects ORDER BY name").map((r) => parse<Project>(r) as Project);
  }
  async nextLaneId(project: string) {
    this.exec(
      "INSERT INTO counters (project, last_lane_id) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET last_lane_id = last_lane_id + 1",
      project,
    );
    return this.one("SELECT last_lane_id AS n FROM counters WHERE project = ?", project)?.n as number;
  }
  async putTask(project: string, t: Task) {
    this.exec(
      "INSERT OR REPLACE INTO tasks (project, id, json) VALUES (?, ?, ?)",
      project,
      t.id,
      JSON.stringify(t),
    );
  }
  async getTask(project: string, id: string) {
    return parse<Task>(this.one("SELECT json FROM tasks WHERE project = ? AND id = ?", project, id));
  }
  async listTasks(project: string) {
    return this.all("SELECT json FROM tasks WHERE project = ? ORDER BY id", project).map(
      (r) => parse<Task>(r) as Task,
    );
  }
  async putLane(project: string, lane: Lane) {
    this.exec(
      "INSERT OR REPLACE INTO lanes (project, id, json) VALUES (?, ?, ?)",
      project,
      lane.id,
      JSON.stringify(lane),
    );
  }
  async getLane(project: string, id: number) {
    return parse<Lane>(this.one("SELECT json FROM lanes WHERE project = ? AND id = ?", project, id));
  }
  async listLanes(project: string) {
    return this.all("SELECT json FROM lanes WHERE project = ? ORDER BY id", project).map(
      (r) => parse<Lane>(r) as Lane,
    );
  }
  async putCheck(project: string, check: CheckResult) {
    this.exec(
      "INSERT INTO checks (project, lane_id, json) VALUES (?, ?, ?)",
      project,
      check.laneId,
      JSON.stringify(check),
    );
  }
  async listChecks(project: string, laneId?: number) {
    const rows =
      laneId === undefined
        ? this.all("SELECT json FROM checks WHERE project = ? ORDER BY seq", project)
        : this.all("SELECT json FROM checks WHERE project = ? AND lane_id = ? ORDER BY seq", project, laneId);
    return rows.map((r) => parse<CheckResult>(r) as CheckResult);
  }
  async enqueue(project: string, e: QueueEntry) {
    this.exec(
      "INSERT OR REPLACE INTO queue (project, lane_id, enqueued_at) VALUES (?, ?, ?)",
      project,
      e.laneId,
      e.enqueuedAt,
    );
  }
  async dequeue(project: string, laneId: number) {
    this.exec("DELETE FROM queue WHERE project = ? AND lane_id = ?", project, laneId);
  }
  async listQueue(project: string) {
    return this.all("SELECT lane_id, enqueued_at FROM queue WHERE project = ?", project).map((r) => ({
      laneId: r.lane_id as number,
      enqueuedAt: r.enqueued_at as number,
    }));
  }
  async appendEvent(project: string, ev: ProjectEvent) {
    this.exec("INSERT INTO events (project, json) VALUES (?, ?)", project, JSON.stringify(ev));
  }
  async listEvents(project: string, limit: number) {
    return this.all(
      "SELECT json FROM events WHERE project = ? ORDER BY seq DESC LIMIT ?",
      project,
      limit,
    ).map((r) => parse<ProjectEvent>(r) as ProjectEvent);
  }

  async register(repoName: string, project: string, laneId: number) {
    this.exec(
      "INSERT OR REPLACE INTO forks (repo, project, lane_id) VALUES (?, ?, ?)",
      repoName,
      project,
      laneId,
    );
  }
  async lookup(repoName: string) {
    const r = this.one("SELECT project, lane_id FROM forks WHERE repo = ?", repoName);
    return r ? { project: r.project as string, laneId: r.lane_id as number } : null;
  }
}
