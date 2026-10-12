import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsHost } from "@hamonn/adapter-local-fs";
import { describeGitWireContract } from "@hamonn/contract";
import { startGitHttpServer } from "@hamonn/contract/git-http-server";
import http from "isomorphic-git/http/node";
import { describe, expect, it } from "vitest";
import { type FsError, IsomorphicWire, MemoryFS, normalize } from "../src/index.ts";

const TOKEN = "s3cr3t-token";

describeGitWireContract("isomorphic-git over git smart-HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "hamonn-iso-"));
  const host = new LocalFsHost(root);
  const server = await startGitHttpServer(root, { token: TOKEN });
  return {
    wire: new IsomorphicWire({ http }),
    host,
    seed: (name, files) => host.init(name, files),
    fork: (src, name) => host.fork(src, name),
    commit: (repo, ref, files) => host.commit(repo, ref, files),
    head: async (repo, ref) => (await host.headSha(repo, ref)) as string,
    remote: (repo) => `http://x:${TOKEN}@127.0.0.1:${server.port}/${repo.name}.git`,
    cleanup: async () => {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

describe("isomorphic wire specifics", () => {
  it("never leaks credentials in error messages", async () => {
    const wire = new IsomorphicWire({ http });
    const r = await wire.land({
      integrationRemote: "http://x:topsecret@127.0.0.1:1/none.git",
      laneRemote: "http://x:topsecret@127.0.0.1:1/none.git",
      integrationBranch: "main",
      laneBranch: "main",
      message: "m",
      author: { name: "a", email: "a@b.c" },
    });
    expect(r.kind).toBe("error");
    expect(JSON.stringify(r)).not.toContain("topsecret");
  });

  it("refuses checkouts over the size limit and stringifies non-Error failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "hamonn-iso-"));
    const server = await startGitHttpServer(root);
    try {
      const host = new LocalFsHost(root);
      const main = await host.init("m", { "big.txt": "x".repeat(10_000) });
      const lane = await host.fork(main, "l");
      const url = (n: string) => `http://127.0.0.1:${server.port}/${n}.git`;
      const input = {
        integrationRemote: url("m"),
        laneRemote: url("l"),
        integrationBranch: "main",
        laneBranch: "main",
        message: "m",
        author: { name: "a", email: "a@b.c" },
      };
      const tiny = await new IsomorphicWire({ http, maxBytes: 100 }).land(input);
      expect(tiny).toMatchObject({ kind: "error" });
      expect((tiny as { message: string }).message).toContain("landing limit");
      const boom = await new IsomorphicWire({
        http: { request: async () => Promise.reject({ toString: () => "weird failure" }) } as never,
      }).land(input);
      expect(boom).toEqual({ kind: "error", message: "weird failure" });
      void lane;
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MemoryFS", () => {
  it("implements the file, dir and symlink operations isomorphic-git relies on", async () => {
    const fs = new MemoryFS(() => 5);
    await fs.mkdir("/a");
    await fs.writeFile("/a/f.txt", "hello");
    await fs.writeFile("/a/g.bin", new Uint8Array([1, 2, 3]), { mode: 0o100755 });
    expect(await fs.readFile("/a/f.txt", "utf8")).toBe("hello");
    expect(await fs.readFile("/a/f.txt", { encoding: "utf8" })).toBe("hello");
    expect(Array.from((await fs.readFile("/a/g.bin")) as Uint8Array)).toEqual([1, 2, 3]);
    expect((await fs.stat("/a/g.bin")).mode).toBe(0o100755);
    await fs.chmod("/a/g.bin", 0o100644);
    expect((await fs.stat("/a/g.bin")).mode).toBe(0o100644);
    expect(await fs.readdir("/a")).toEqual(["f.txt", "g.bin"]);
    expect(await fs.readdir("/")).toEqual(["a"]);
    expect(fs.bytes).toBe(8);
    await fs.mkdir("/a/sub");
    await fs.writeFile("/a/sub/deep", "d");
    expect(await fs.readdir("/a")).toEqual(["f.txt", "g.bin", "sub"]);

    await fs.symlink("/a/f.txt", "/link");
    expect(await fs.readlink("/link")).toBe("/a/f.txt");
    expect(await fs.readFile("/link", "utf8")).toBe("hello");
    const l = await fs.lstat("/link");
    const s = await fs.stat("/link");
    expect([l.isSymbolicLink(), s.isFile(), s.isDirectory(), l.size > 0]).toEqual([true, true, false, true]);
    expect((await fs.stat("/a")).isDirectory()).toBe(true);
    await fs.chmod("/a", 0o777); // no-op on directories

    await fs.writeFile("/a/f.txt", "again");
    await fs.unlink("/a/f.txt");
    await fs.unlink("/link");
    await fs.unlink("/a/g.bin");
    await fs.unlink("/a/sub/deep");
    await fs.rmdir("/a/sub");
    await fs.rmdir("/a");
    expect(await fs.readdir("/")).toEqual([]);
    expect(normalize("/x/../y/./z//")).toBe("/y/z");
    expect(fs.promises).toBe(fs);
  });

  it("raises POSIX-style errors", async () => {
    const fs = new MemoryFS();
    const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as FsError).code;
    expect(await code(fs.readFile("/nope"))).toBe("ENOENT");
    expect(await code(fs.stat("/nope"))).toBe("ENOENT");
    expect(await code(fs.lstat("/nope"))).toBe("ENOENT");
    expect(await code(fs.unlink("/nope"))).toBe("ENOENT");
    expect(await code(fs.readdir("/nope"))).toBe("ENOENT");
    expect(await code(fs.rmdir("/nope"))).toBe("ENOENT");
    expect(await code(fs.readlink("/nope"))).toBe("ENOENT");
    expect(await code(fs.chmod("/nope", 1))).toBe("ENOENT");
    expect(await code(fs.writeFile("/missing/dir/f", "x"))).toBe("ENOENT");
    expect(await code(fs.mkdir("/missing/dir"))).toBe("ENOENT");
    await fs.mkdir("/d");
    await fs.writeFile("/d/f", "x");
    expect(await code(fs.mkdir("/d"))).toBe("EEXIST");
    expect(await code(fs.symlink("/t", "/d"))).toBe("EEXIST");
    expect(await code(fs.symlink("/t", "/missing/l"))).toBe("ENOENT");
    expect(await code(fs.readFile("/d"))).toBe("EISDIR");
    expect(await code(fs.writeFile("/d", "x"))).toBe("EISDIR");
    expect(await code(fs.unlink("/d"))).toBe("EISDIR");
    expect(await code(fs.readdir("/d/f"))).toBe("ENOTDIR");
    expect(await code(fs.rmdir("/d/f"))).toBe("ENOTDIR");
    expect(await code(fs.writeFile("/d/f/x", "x"))).toBe("ENOTDIR");
    expect(await code(fs.rmdir("/d"))).toBe("ENOTEMPTY");
    expect(await code(fs.readlink("/d/f"))).toBe("EINVAL");
  });
});
