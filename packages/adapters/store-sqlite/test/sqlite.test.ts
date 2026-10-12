import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStoreContract } from "@hamonn/contract";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.ts";

describeStoreContract("sqlite (memory)", async () => {
  const store = new SqliteStore();
  return { store, cleanup: async () => store.close() };
});

describe("sqlite persistence", () => {
  it("survives reopening a file database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hamonn-sql-"));
    try {
      const path = join(dir, "h.db");
      const a = new SqliteStore(path);
      await a.nextLaneId("p");
      await a.nextLaneId("p");
      a.close();
      const b = new SqliteStore(path);
      expect(await b.nextLaneId("p")).toBe(3);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
