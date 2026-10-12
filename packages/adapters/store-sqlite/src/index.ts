import { DatabaseSync } from "node:sqlite";
import { type SqlDriver, SqlStore } from "@hamonn/store-sql";

/** `Store` + `Registry` on `node:sqlite` (built in since Node 22.5; no native build step). */
export class SqliteStore extends SqlStore {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    const driver: SqlDriver = {
      run: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
    };
    super(driver);
    this.db = db;
  }

  close(): void {
    this.db.close();
  }
}
