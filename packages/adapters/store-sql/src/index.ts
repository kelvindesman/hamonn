import type { CheckResult, Lane, QueueEntry, Task } from "@hamonn/core";
import type { Project, ProjectEvent, Registry, Store } from "@hamonn/shell";

/** The only thing a SQLite flavour must provide: run one statement, get rows back. */
export interface SqlDriver {
  run(sql: string, ...params: (string | number | null)[]): Record<string, unknown>[];
}

export const SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS counters (project TEXT PRIMARY KEY, last_lane_id INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tasks (project TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (project, id))",
  "CREATE TABLE IF NOT EXISTS lanes (project TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (project, id))",
  "CREATE TABLE IF NOT EXISTS checks (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, lane_id INTEGER NOT NULL, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS queue (project TEXT NOT NULL, lane_id INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, PRIMARY KEY (project, lane_id))",
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS forks (repo TEXT PRIMARY KEY, project TEXT NOT NULL, lane_id INTEGER NOT NULL)",
];

type Row = Record<string, unknown>;
const parse = <T>(row: Row | undefined): T | null => (row ? (JSON.parse(row.json as string) as T) : null);
const all = <T>(rows: Row[]): T[] => rows.map((r) => JSON.parse(r.json as string) as T);

/** `Store` + `Registry` written once against `SqlDriver`; drivers only differ in how they run SQL. */
export class SqlStore implements Store, Registry {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private sql: SqlDriver) {
    for (const stmt of SCHEMA) sql.run(stmt);
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

  async putProject(p: Project) {
    this.sql.run("INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)", p.name, JSON.stringify(p));
  }
  async getProject(name: string) {
    return parse<Project>(this.sql.run("SELECT json FROM projects WHERE name = ?", name)[0]);
  }
  async listProjects() {
    return all<Project>(this.sql.run("SELECT json FROM projects ORDER BY name"));
  }
  async nextLaneId(project: string) {
    this.sql.run(
      "INSERT INTO counters (project, last_lane_id) VALUES (?, 1) ON CONFLICT(project) DO UPDATE SET last_lane_id = last_lane_id + 1",
      project,
    );
    return this.sql.run("SELECT last_lane_id AS n FROM counters WHERE project = ?", project)[0]?.n as number;
  }
  async putTask(project: string, t: Task) {
    this.sql.run(
      "INSERT OR REPLACE INTO tasks (project, id, json) VALUES (?, ?, ?)",
      project,
      t.id,
      JSON.stringify(t),
    );
  }
  async getTask(project: string, id: string) {
    return parse<Task>(this.sql.run("SELECT json FROM tasks WHERE project = ? AND id = ?", project, id)[0]);
  }
  async listTasks(project: string) {
    return all<Task>(this.sql.run("SELECT json FROM tasks WHERE project = ? ORDER BY id", project));
  }
  async putLane(project: string, lane: Lane) {
    this.sql.run(
      "INSERT OR REPLACE INTO lanes (project, id, json) VALUES (?, ?, ?)",
      project,
      lane.id,
      JSON.stringify(lane),
    );
  }
  async getLane(project: string, id: number) {
    return parse<Lane>(this.sql.run("SELECT json FROM lanes WHERE project = ? AND id = ?", project, id)[0]);
  }
  async listLanes(project: string) {
    return all<Lane>(this.sql.run("SELECT json FROM lanes WHERE project = ? ORDER BY id", project));
  }
  async putCheck(project: string, check: CheckResult) {
    this.sql.run(
      "INSERT INTO checks (project, lane_id, json) VALUES (?, ?, ?)",
      project,
      check.laneId,
      JSON.stringify(check),
    );
  }
  async listChecks(project: string, laneId?: number) {
    return all<CheckResult>(
      laneId === undefined
        ? this.sql.run("SELECT json FROM checks WHERE project = ? ORDER BY seq", project)
        : this.sql.run(
            "SELECT json FROM checks WHERE project = ? AND lane_id = ? ORDER BY seq",
            project,
            laneId,
          ),
    );
  }
  async enqueue(project: string, e: QueueEntry) {
    this.sql.run(
      "INSERT OR REPLACE INTO queue (project, lane_id, enqueued_at) VALUES (?, ?, ?)",
      project,
      e.laneId,
      e.enqueuedAt,
    );
  }
  async dequeue(project: string, laneId: number) {
    this.sql.run("DELETE FROM queue WHERE project = ? AND lane_id = ?", project, laneId);
  }
  async listQueue(project: string) {
    return this.sql.run("SELECT lane_id, enqueued_at FROM queue WHERE project = ?", project).map((r) => ({
      laneId: r.lane_id as number,
      enqueuedAt: r.enqueued_at as number,
    }));
  }
  async appendEvent(project: string, ev: ProjectEvent) {
    this.sql.run("INSERT INTO events (project, json) VALUES (?, ?)", project, JSON.stringify(ev));
  }
  async listEvents(project: string, limit: number) {
    return all<ProjectEvent>(
      this.sql.run("SELECT json FROM events WHERE project = ? ORDER BY seq DESC LIMIT ?", project, limit),
    );
  }

  async register(repoName: string, project: string, laneId: number) {
    this.sql.run(
      "INSERT OR REPLACE INTO forks (repo, project, lane_id) VALUES (?, ?, ?)",
      repoName,
      project,
      laneId,
    );
  }
  async lookup(repoName: string) {
    const r = this.sql.run("SELECT project, lane_id FROM forks WHERE repo = ?", repoName)[0];
    return r ? { project: r.project as string, laneId: r.lane_id as number } : null;
  }
}
