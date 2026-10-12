import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsHost } from "@hamonn/adapter-local-fs";
import { describeGitHostContract } from "@hamonn/contract";
import type { RepoRef } from "@hamonn/core";
import { describe, expect, it } from "vitest";
import { GithubHost, githubRepo, githubSignature, normalizeGithubWebhook } from "../src/index.ts";
import { FakeGitHub } from "./fake-github.ts";

function setup(extra: Partial<ConstructorParameters<typeof GithubHost>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hamonn-gh-"));
  const fs = new LocalFsHost(root);
  const gh = new FakeGitHub(root);
  const host = new GithubHost({ token: "ghp_secret", fetch: gh.fetch, sleep: async () => {}, ...extra });
  const local = (r: RepoRef): RepoRef => ({ name: r.name, remote: gh.path(r.name) });
  return { root, fs, gh, host, local };
}

describeGitHostContract("github (fake REST over real git)", async () => {
  const s = setup();
  return {
    host: s.host,
    embedsToken: true,
    seed: async (name, files) => githubRepo((await s.fs.init(`acme/${name}`, files)).name),
    commit: (repo, ref, files) => s.fs.commit(s.local(repo), ref, files),
    cleanup: async () => rmSync(s.root, { recursive: true, force: true }),
  };
});

describe("github specifics", () => {
  it("polls until an asynchronous fork is ready and honours forkOrg", async () => {
    const s = setup({ forkOrg: "lanes-org" });
    try {
      const src = githubRepo((await s.fs.init("acme/demo", { "a.txt": "1\n" })).name);
      const fork = await s.host.fork(src, "demo-l1");
      expect(fork).toEqual({ name: "lanes-org/demo-l1", remote: "https://github.com/lanes-org/demo-l1.git" });
      expect(s.gh.calls.filter((c) => c.includes("per_page=1")).length).toBe(2); // 404 then 200
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("gives up when the fork never appears and surfaces API failures", async () => {
    const s = setup();
    try {
      const src = githubRepo((await s.fs.init("acme/demo", { "a.txt": "1\n" })).name);
      const never = new GithubHost({
        token: "t",
        sleep: async () => {},
        fetch: async (url, init) => {
          if (String(url).includes("/commits?per_page=1")) return new Response("{}", { status: 404 });
          return s.gh.fetch(url, init);
        },
      });
      await expect(never.fork(src, "x")).rejects.toThrow(/did not become ready/);
      const broken = new GithubHost({ token: "t", fetch: async () => new Response("boom", { status: 500 }) });
      await expect(broken.headSha(src, "main")).rejects.toThrow(/-> 500/);
      await expect(broken.readFile(src, "main", "a")).rejects.toThrow(/-> 500/);
      await expect(broken.mergeBase(src, "a", "b")).rejects.toThrow(/-> 500/);
      await expect(broken.changedPaths(src, "a", "b")).rejects.toThrow(/-> 500/);
      const unauth = new GithubHost({ token: "t", fetch: async () => new Response("no", { status: 401 }) });
      await expect(unauth.fork(src, "x")).rejects.toThrow(/POST .*forks -> 401/);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("passes the PAT through by default and delegates to a token provider when given", async () => {
    const plain = setup();
    const t = await plain.host.mintToken(githubRepo("a/b"), "write", 100);
    expect(t.secret).toBe("ghp_secret");
    expect(plain.host.remoteUrl(githubRepo("a/b"), t)).toBe(
      "https://x-access-token:ghp_secret@github.com/a/b.git",
    );
    await expect(plain.host.revokeToken(githubRepo("a/b"), t.id)).resolves.toBeUndefined();
    rmSync(plain.root, { recursive: true, force: true });

    const revoked: string[] = [];
    const scoped = setup({
      tokens: {
        mint: async (repo, scope) => ({ id: `app-${scope}`, secret: `ghs_${repo.name}`, expiresAt: 1 }),
        revoke: async (_r, id) => {
          revoked.push(id);
        },
      },
    });
    const st = await scoped.host.mintToken(githubRepo("a/b"), "read", 100);
    expect(st).toEqual({ id: "app-read", secret: "ghs_a/b", expiresAt: 1 });
    await scoped.host.revokeToken(githubRepo("a/b"), st.id);
    expect(revoked).toEqual(["app-read"]);
    rmSync(scoped.root, { recursive: true, force: true });
  });

  it("changedPaths includes rename sources, follows pagination and rejects truncated trees", async () => {
    const s = setup();
    try {
      const raw = await s.fs.init("acme/r", {
        "old.txt": "content that is long enough to be detected as a rename\n",
        "keep.txt": "k\n",
      });
      const repo = githubRepo(raw.name);
      const before = (await s.host.headSha(repo, "main")) as string;
      const files: Record<string, string | null> = {
        "old.txt": null,
        "new.txt": "content that is long enough to be detected as a rename\n",
      };
      for (let i = 0; i < 120; i++) files[`many/f${String(i).padStart(3, "0")}.txt`] = `${i}\n`;
      const after = await s.fs.commit(raw, "main", files);
      const changed = await s.host.changedPaths(repo, before, after);
      expect(changed).toContain("old.txt");
      expect(changed).toContain("new.txt");
      expect(changed.filter((p) => p.startsWith("many/"))).toHaveLength(120);
      const truncating = new GithubHost({
        token: "t",
        fetch: async () => Response.json({ tree: [], truncated: true }),
      });
      await expect(truncating.changedPaths(repo, null, after)).rejects.toThrow(/too large/);
      const noFiles = new GithubHost({ token: "t", fetch: async () => Response.json({}) });
      expect(await noFiles.changedPaths(repo, "a", "b")).toEqual([]);
      expect(await noFiles.mergeBase(repo, "a", "b")).toBeNull();
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("github webhook", () => {
  const body = JSON.stringify({
    ref: "refs/heads/lane/3",
    before: "a".repeat(40),
    after: "b".repeat(40),
    repository: { full_name: "acme/demo" },
  });
  const call = async (opts: {
    event?: string;
    sig?: string | null;
    secret?: string | undefined;
    body?: string;
  }) => {
    const b = opts.body ?? body;
    const headers = new Headers({ "x-github-event": opts.event ?? "push" });
    const sig = opts.sig === undefined ? await githubSignature("hook-secret", b) : opts.sig;
    if (sig !== null) headers.set("x-hub-signature-256", sig);
    return normalizeGithubWebhook({
      body: b,
      headers,
      secret: "secret" in opts ? opts.secret : "hook-secret",
    });
  };

  it("verifies the HMAC and normalizes branch pushes", async () => {
    expect(await call({})).toEqual({
      repoName: "acme/demo",
      ref: "refs/heads/lane/3",
      before: "a".repeat(40),
      after: "b".repeat(40),
    });
  });

  it("rejects missing secrets and bad signatures, ignores non-push events and branch deletions", async () => {
    await expect(call({ secret: undefined })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call({ sig: "sha256=deadbeef" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(call({ sig: null })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await call({ event: "ping" })).toBeNull();
    const deleted = JSON.stringify({
      ref: "refs/heads/x",
      after: "0".repeat(40),
      repository: { full_name: "a/b" },
    });
    const headers = new Headers({
      "x-github-event": "push",
      "x-hub-signature-256": await githubSignature("hook-secret", deleted),
    });
    expect(await normalizeGithubWebhook({ body: deleted, headers, secret: "hook-secret" })).toBeNull();
    const noRepo = JSON.stringify({ ref: "refs/heads/x", after: "b".repeat(40) });
    const h2 = new Headers({
      "x-github-event": "push",
      "x-hub-signature-256": await githubSignature("hook-secret", noRepo),
    });
    expect(await normalizeGithubWebhook({ body: noRepo, headers: h2, secret: "hook-secret" })).toBeNull();
  });
});
