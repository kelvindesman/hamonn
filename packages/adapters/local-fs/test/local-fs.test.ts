import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGitHostContract } from "@hamonn/contract";
import { describe, expect, it } from "vitest";
import { LocalFsHost } from "../src/index.ts";

describeGitHostContract("local-fs", async () => {
  const root = mkdtempSync(join(tmpdir(), "hamonn-fs-"));
  const host = new LocalFsHost(root);
  return {
    host,
    embedsToken: false,
    seed: (name, files) => host.init(name, files),
    commit: (repo, ref, files) => host.commit(repo, ref, files),
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

describe("local-fs specifics", () => {
  it("tracks revoked tokens and surfaces git failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "hamonn-fs-"));
    try {
      const host = new LocalFsHost(root, () => 1_000_000);
      const repo = await host.init("r", { "a.txt": "1\n" });
      const t = await host.mintToken(repo, "write", 100);
      expect(t.expiresAt).toBe(1000 + 100);
      expect(host.isRevoked(t.id)).toBe(false);
      await host.revokeToken(repo, t.id);
      expect(host.isRevoked(t.id)).toBe(true);
      await expect(host.fork({ name: "x", remote: join(root, "missing.git") }, "y")).rejects.toThrow(
        /git clone/,
      );
      // a commit on a brand-new branch starts from main
      const sha = await host.commit(repo, "fresh", { "only.txt": "x\n" });
      expect(await host.changedPaths(repo, null, sha)).toEqual(["a.txt", "only.txt"]);
      expect(await host.changedPaths(repo, await host.headSha(repo, "main"), sha)).toEqual(["only.txt"]);
      // commit by sha-less ref falls back when the branch ref cannot be fetched by name
      expect(await host.headSha(repo, "fresh")).toBe(sha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
