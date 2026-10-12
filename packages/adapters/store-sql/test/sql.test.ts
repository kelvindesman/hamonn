import { DatabaseSync } from "node:sqlite";
import { describeStoreContract } from "@hamonn/contract";
import { type SqlDriver, SqlStore } from "../src/index.ts";

/** The generic store over a bare node:sqlite driver, exactly as the Durable Object driver will use it. */
describeStoreContract("sql (generic driver)", async () => {
  const db = new DatabaseSync(":memory:");
  const driver: SqlDriver = { run: (sql, ...p) => db.prepare(sql).all(...p) as Record<string, unknown>[] };
  return { store: new SqlStore(driver), cleanup: async () => db.close() };
});
