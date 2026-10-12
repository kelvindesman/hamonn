import { type SqlDriver, SqlStore } from "@hamonn/store-sql";
import type { DoStateLike } from "../env.ts";

const EXTRA_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS project_index (name TEXT PRIMARY KEY, repo_name TEXT NOT NULL)",
];

/** Driver over Durable Object SQL storage. */
export function doDriver(state: DoStateLike): SqlDriver {
  return { run: (sql, ...params) => state.storage.sql.exec(sql, ...params).toArray() };
}

/**
 * One global instance: maps fork repos -> lane, and project repos -> project, so a push event
 * (which only carries a repo name) can be routed to the right ProjectDO. Tiny JSON-over-fetch protocol.
 */
export class RegistryDO {
  private sql: SqlDriver;
  private forks: SqlStore;

  constructor(state: DoStateLike) {
    this.sql = doDriver(state);
    this.forks = new SqlStore(this.sql);
    for (const stmt of EXTRA_SCHEMA) this.sql.run(stmt);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/register") {
      const b = (await req.json()) as { repo: string; project: string; laneId: number };
      await this.forks.register(b.repo, b.project, b.laneId);
      return Response.json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/lookup") {
      return Response.json(await this.forks.lookup(url.searchParams.get("repo") ?? ""));
    }
    if (req.method === "POST" && url.pathname === "/project") {
      const b = (await req.json()) as { name: string; repo: string };
      this.sql.run("INSERT OR REPLACE INTO project_index (name, repo_name) VALUES (?, ?)", b.name, b.repo);
      return Response.json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/by-repo") {
      const rows = this.sql.run(
        "SELECT name FROM project_index WHERE repo_name = ?",
        url.searchParams.get("repo") ?? "",
      );
      return Response.json(rows[0]?.name ?? null);
    }
    if (req.method === "GET" && url.pathname === "/projects") {
      return Response.json(this.sql.run("SELECT name, repo_name FROM project_index ORDER BY name"));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
