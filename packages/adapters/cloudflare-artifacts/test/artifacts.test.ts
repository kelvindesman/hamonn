import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsHost } from "@hamonn/adapter-local-fs";
import { describeGitHostContract } from "@hamonn/contract";
import type { RepoRef } from "@hamonn/core";
import { describe, expect, it } from "vitest";
import { ArtifactsHost } from "../src/index.ts";
import { FakeArtifacts } from "./fake-artifacts.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hamonn-art-"));
  const fs = new LocalFsHost(root);
  const binding = new FakeArtifacts(root);
  const host = new ArtifactsHost(binding);
  // Artifacts remotes are URLs; the fake serves the same repos from disk. Map name -> URL ref.
  const ref = (r: RepoRef): RepoRef => ({ name: r.name, remote: binding.remoteFor(r.name) });
  return { root, fs, binding, host, ref };
}

describeGitHostContract("cloudflare-artifacts (fake binding over real git)", async () => {
  const s = setup();
  return {
    host: s.host,
    embedsToken: true,
    seed: async (name, files) => s.ref(await s.fs.init(name, files)),
    commit: (repo, ref, files) =>
      s.fs.commit({ name: repo.name, remote: join(s.root, `${repo.name}.git`) }, ref, files),
    cleanup: async () => rmSync(s.root, { recursive: true, force: true }),
  };
});

describe("artifacts specifics", () => {
  it("strips ?expires= from the git secret, keeps the id, and releases every handle", async () => {
    const s = setup();
    try {
      const repo = s.ref(await s.fs.init("r", { "a.txt": "1\n" }));
      const t = await s.host.mintToken(repo, "write", 300);
      expect(t.secret).not.toContain("expires");
      expect(t.secret.startsWith("art_v1_")).toBe(true);
      expect(t.id).toBe("tok1");
      expect(s.host.remoteUrl(repo, t)).toBe(
        `https://x:${t.secret}@acct.artifacts.cloudflare.net/git/default/r.git`,
      );
      expect(s.host.remoteUrl(repo)).toBe(repo.remote);
      await s.host.revokeToken(repo, t.id);
      expect(s.binding.tokens.get(t.id)?.revoked).toBe(true);
      expect(s.binding.disposed).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("normalises token expiry from numbers, seconds, ms, missing values and unparsable strings", async () => {
    const make = (expiresAt: unknown, plaintext = "art_v1_abc?expires=4242") =>
      new ArtifactsHost(
        {
          get: async () =>
            ({
              createToken: async () => ({ plaintext, expiresAt }),
            }) as unknown as import("../src/index.ts").ArtifactsRepoHandle,
        },
        () => 1_000_000,
      ).mintToken({ name: "r", remote: "" }, "read", 60);
    expect((await make(1_700_000_000)).expiresAt).toBe(1_700_000_000);
    expect((await make(1_700_000_000_000)).expiresAt).toBe(1_700_000_000);
    expect((await make(new Date(5000))).expiresAt).toBe(5);
    expect((await make("garbage")).expiresAt).toBe(4242);
    expect((await make(undefined, "art_v1_abc")).expiresAt).toBe(1000 + 60);
    expect((await make(undefined)).id).toBe("art_v1_abc?expires=4242");
  });

  it("changedPaths handles file<->directory swaps and nested edits", async () => {
    const s = setup();
    try {
      const raw = await s.fs.init("r", { "a/b/c.txt": "1\n", x: "file\n", "keep/k.txt": "k\n" });
      const repo = s.ref(raw);
      const before = (await s.host.headSha(repo, "main")) as string;
      const after = await s.fs.commit(raw, "main", { "a/b/c.txt": "2\n", x: null, "x/inner.txt": "i\n" });
      expect(await s.host.changedPaths(repo, before, after)).toEqual(["a/b/c.txt", "x", "x/inner.txt"]);
      const back = await s.fs.commit(raw, "main", { "x/inner.txt": null, x: "file again\n" });
      expect(await s.host.changedPaths(repo, after, back)).toEqual(["x", "x/inner.txt"]);
      await expect(s.host.changedPaths(repo, "0".repeat(40), after)).rejects.toThrow(/not found/);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("mergeBase uses first-parent history in either direction and finds shared ancestors", async () => {
    const s = setup();
    try {
      const raw = await s.fs.init("r", { "a.txt": "1\n" });
      const repo = s.ref(raw);
      const base = (await s.host.headSha(repo, "main")) as string;
      const tip = await s.fs.commit(raw, "main", { "b.txt": "2\n" });
      expect(await s.host.mergeBase(repo, tip, base)).toBe(base); // b is an ancestor of a
      expect(await s.host.mergeBase(repo, base, tip)).toBe(base); // a is an ancestor of b
      const side = await s.fs.commit(raw, "side", { "s.txt": "s\n" }, "side");
      const other = await s.fs.commit(raw, "other", { "o.txt": "o\n" }, "other");
      expect(await s.host.mergeBase(repo, side, other)).toBe(tip); // both branched from main at `tip`
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("accepts tree entries expressed only by mode, and objects keyed by oid/sha", async () => {
    const entries = {
      t1: [
        { name: "dir", mode: "040000", oid: "d1" },
        { name: "f", mode: "100644", sha: "f1" },
      ],
      d1: [{ name: "inner", type: "blob", hash: "i1" }],
      t2: [
        { name: "dir", mode: 16384, oid: "d2" },
        { name: "f", mode: "100644", sha: "f1" },
      ],
      d2: [{ name: "inner", type: "blob", hash: "i2" }],
    } as Record<string, import("../src/index.ts").ArtifactsTreeEntry[]>;
    const host = new ArtifactsHost({
      get: async () =>
        ({
          readCommit: async (h: string) => ({ oid: h, tree: h === "c1" ? "t1" : "t2" }),
          readTree: async (h: string) => entries[h] ?? null,
        }) as unknown as import("../src/index.ts").ArtifactsRepoHandle,
    });
    expect(await host.changedPaths({ name: "r", remote: "" }, "c1", "c2")).toEqual(["dir/inner"]);
    expect(await host.changedPaths({ name: "r", remote: "" }, null, "c2")).toEqual(["dir/inner", "f"]);
    // a tree that readTree cannot find is treated as empty
    const missing = new ArtifactsHost({
      get: async () =>
        ({
          readCommit: async () => ({ tree: "nope" }),
          readTree: async () => null,
        }) as unknown as import("../src/index.ts").ArtifactsRepoHandle,
    });
    expect(await missing.changedPaths({ name: "r", remote: "" }, null, "c")).toEqual([]);
  });
});

describe("changedPaths diagnostics", () => {
  it("names the fields when a commit comes back without a tree", async () => {
    const handle = { readCommit: async () => ({ hash: "a".repeat(40), message: "m" }) };
    const host = new ArtifactsHost({ get: async () => handle } as never);
    await expect(host.changedPaths({ name: "r", remote: "" }, null, "a".repeat(40))).rejects.toThrow(
      /has no tree \(fields: hash,message\)/,
    );
  });

  it("accepts the older `tree` field", async () => {
    const handle = {
      readCommit: async () => ({ hash: "a".repeat(40), tree: "t" }),
      readTree: async () => [{ name: "f", type: "blob", hash: "b".repeat(40) }],
    };
    const host = new ArtifactsHost({ get: async () => handle } as never);
    expect(await host.changedPaths({ name: "r", remote: "" }, null, "a".repeat(40))).toEqual(["f"]);
  });
});
