import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsHost } from "@hamonn/adapter-local-fs";
import { describeGitWireContract } from "@hamonn/contract";
import { describe, expect, it } from "vitest";
import { SystemGitWire } from "../src/index.ts";

describeGitWireContract("system-git over local-fs", async () => {
  const root = mkdtempSync(join(tmpdir(), "hamonn-wire-"));
  const host = new LocalFsHost(root);
  return {
    wire: new SystemGitWire(),
    host,
    seed: (name, files) => host.init(name, files),
    fork: (src, name) => host.fork(src, name),
    commit: (repo, ref, files) => host.commit(repo, ref, files),
    head: async (repo, ref) => (await host.headSha(repo, ref)) as string,
    remote: (repo) => repo.remote,
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

describe("system-git specifics", () => {
  it("scrubs credentials from error messages", async () => {
    const wire = new SystemGitWire();
    const r = await wire.land({
      integrationRemote: "https://x:supersecret@127.0.0.1:1/none.git",
      laneRemote: "https://x:supersecret@127.0.0.1:1/none.git",
      integrationBranch: "main",
      laneBranch: "main",
      message: "m",
      author: { name: "a", email: "a@b.c" },
    });
    expect(r.kind).toBe("error");
    expect(JSON.stringify(r)).not.toContain("supersecret");
  });

  it("isAncestor throws on a failing fetch", async () => {
    const wire = new SystemGitWire();
    await expect(
      wire.isAncestor({ remote: "/definitely/not/here.git", branch: "main", ancestor: "a", descendant: "b" }),
    ).rejects.toThrow();
  });

  it("isAncestor throws when git cannot evaluate the revisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "hamonn-wire-"));
    try {
      const host = new LocalFsHost(root);
      const repo = await host.init("r", { "a.txt": "1\n" });
      const head = (await host.headSha(repo, "main")) as string;
      await expect(
        new SystemGitWire().isAncestor({
          remote: repo.remote,
          branch: "main",
          ancestor: head,
          descendant: "cafe",
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
