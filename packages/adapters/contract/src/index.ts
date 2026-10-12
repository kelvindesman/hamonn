import type { Lane, RepoRef } from "@hamonn/core";
import type { GitHost, GitWire, Project, Registry, Store } from "@hamonn/shell";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** What an adapter test supplies so the suite can create repos/commits on the real (or faked) host. */
export interface HostFixture {
  host: GitHost;
  /** Create a repo with `main` holding `files`; returns its ref. */
  seed(name: string, files: Record<string, string>): Promise<RepoRef>;
  /** Commit on top of `ref`; a `null` value deletes the file. Returns the new sha. */
  commit(repo: RepoRef, ref: string, files: Record<string, string | null>): Promise<string>;
  /** Hosts that enforce auth embed the secret in the clone URL. */
  embedsToken: boolean;
  cleanup?(): Promise<void>;
}

/** Contract every `GitHost` adapter must satisfy (the "8 verbs"). */
export function describeGitHostContract(name: string, make: () => Promise<HostFixture>): void {
  describe(`GitHost contract: ${name}`, () => {
    let fx: HostFixture;
    let src: RepoRef;
    let n = 0;
    const unique = (p: string) => `${p}-${Date.now().toString(36)}-${++n}`;

    beforeAll(async () => {
      fx = await make();
      src = await fx.seed(unique("src"), { "README.md": "hi\n", "src/a.ts": "a1\n", "src/b.ts": "b1\n" });
    });
    afterAll(async () => fx.cleanup?.());

    it("exposes a kind", () => {
      expect(fx.host.kind).toMatch(/^(cloudflare-artifacts|github|gitlab|bitbucket|local-fs)$/);
    });

    it("headSha resolves branches and is null for missing refs", async () => {
      const head = await fx.host.headSha(src, "main");
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(await fx.host.headSha(src, "no-such-branch")).toBeNull();
      expect(await fx.host.headSha(src, head as string)).toBe(head);
    });

    it("readFile returns contents at a ref, null when missing", async () => {
      expect(await fx.host.readFile(src, "main", "src/a.ts")).toBe("a1\n");
      expect(await fx.host.readFile(src, "main", "nope.txt")).toBeNull();
      expect(await fx.host.readFile(src, "main", ".lane/intent.md")).toBeNull();
    });

    it("changedPaths reports exactly added, modified and deleted paths (sorted, unique)", async () => {
      const before = (await fx.host.headSha(src, "main")) as string;
      const after = await fx.commit(src, "main", {
        "src/a.ts": "a2\n",
        "src/new/c.ts": "c\n",
        "src/b.ts": null,
      });
      expect(await fx.host.changedPaths(src, before, after)).toEqual([
        "src/a.ts",
        "src/b.ts",
        "src/new/c.ts",
      ]);
      expect(await fx.host.changedPaths(src, after, after)).toEqual([]);
      const all = await fx.host.changedPaths(src, null, after);
      expect(all).toEqual(["README.md", "src/a.ts", "src/new/c.ts"]);
    });

    it("mergeBase (when supported) finds the fork point or null", async () => {
      if (!fx.host.mergeBase) return;
      const repo = await fx.seed(unique("mb"), { "a.txt": "1\n" });
      const base = (await fx.host.headSha(repo, "main")) as string;
      const featureHead = await fx.commit(repo, "feature", { "f.txt": "f\n" });
      const mainHead = await fx.commit(repo, "main", { "m.txt": "m\n" });
      expect(await fx.host.mergeBase(repo, featureHead, mainHead)).toBe(base);
      expect(await fx.host.mergeBase(repo, featureHead, "0".repeat(40))).toBeNull();
    });

    it("fork returns a distinct repo with the same history", async () => {
      const fork = await fx.host.fork(src, unique("fork"));
      expect(fork.name).not.toBe(src.name);
      expect(fork.remote).not.toBe(src.remote);
      expect(await fx.host.headSha(fork, "main")).toBe(await fx.host.headSha(src, "main"));
      // writes to the fork do not move the source
      const srcHead = await fx.host.headSha(src, "main");
      await fx.commit(fork, "main", { "fork-only.txt": "x\n" });
      expect(await fx.host.headSha(src, "main")).toBe(srcHead);
      expect(await fx.host.headSha(fork, "main")).not.toBe(srcHead);
    });

    it("mintToken honours scope + ttl and revokeToken accepts it", async () => {
      const t0 = Math.floor(Date.now() / 1000);
      const write = await fx.host.mintToken(src, "write", 600);
      const read = await fx.host.mintToken(src, "read", 60);
      expect(write.id).toBeTruthy();
      expect(write.secret).toBeTruthy();
      expect(write.id).not.toBe(read.id);
      expect(write.expiresAt).toBeGreaterThanOrEqual(t0 + 590);
      expect(write.expiresAt).toBeLessThanOrEqual(t0 + 700);
      expect(read.expiresAt).toBeLessThanOrEqual(t0 + 120);
      await expect(fx.host.revokeToken(src, write.id)).resolves.toBeUndefined();
      await expect(fx.host.revokeToken(src, read.id)).resolves.toBeUndefined();
    });

    it("remoteUrl names the repo and embeds a token only on hosts that enforce auth", async () => {
      const plain = fx.host.remoteUrl(src);
      expect(plain).toContain(src.name);
      const tok = await fx.host.mintToken(src, "read", 60);
      const withTok = fx.host.remoteUrl(src, tok);
      expect(withTok).toContain(src.name);
      if (fx.embedsToken) {
        expect(withTok).toContain(tok.secret);
        expect(plain).not.toContain(tok.secret);
      }
    });

    it("subscribe is optional but must not throw when present", async () => {
      if (fx.host.subscribe) await expect(fx.host.subscribe(src, async () => {})).resolves.toBeUndefined();
    });
  });
}

/** What a wire test supplies: repos that the wire can reach with the URLs from `remote()`. */
export interface WireFixture {
  wire: GitWire;
  host: GitHost;
  seed(name: string, files: Record<string, string>): Promise<RepoRef>;
  fork(src: RepoRef, name: string): Promise<RepoRef>;
  commit(repo: RepoRef, ref: string, files: Record<string, string | null>): Promise<string>;
  head(repo: RepoRef, ref: string): Promise<string>;
  /** Clone URL (credentials embedded where the host needs them) for the wire. */
  remote(repo: RepoRef): string;
  cleanup?(): Promise<void>;
}

const AUTHOR = { name: "hamonn", email: "hamonn@users.noreply.local" };

/** Contract every `GitWire` must satisfy: clean merge, conflict, errors, ancestor proof. */
export function describeGitWireContract(name: string, make: () => Promise<WireFixture>): void {
  describe(`GitWire contract: ${name}`, () => {
    let fx: WireFixture;
    let n = 0;
    beforeAll(async () => {
      fx = await make();
    });
    afterAll(async () => fx.cleanup?.());

    const scenario = async (files: Record<string, string>) => {
      const id = `${Date.now().toString(36)}-${++n}`;
      const main = await fx.seed(`main-${id}`, files);
      const lane = await fx.fork(main, `lane-${id}`);
      return { main, lane };
    };
    const input = (main: RepoRef, lane: RepoRef) => ({
      integrationRemote: fx.remote(main),
      laneRemote: fx.remote(lane),
      integrationBranch: "main",
      laneBranch: "main",
      message: "Land lane #1",
      author: AUTHOR,
    });

    it("lands a lane that diverged cleanly with a merge commit and pushes it", async () => {
      const { main, lane } = await scenario({ "src/a.ts": "a\n", "src/b.ts": "b\n" });
      const laneHead = await fx.commit(lane, "main", { "src/a.ts": "a-lane\n" });
      const mainHead = await fx.commit(main, "main", { "src/b.ts": "b-main\n" });
      const r = await fx.wire.land(input(main, lane));
      expect(r.kind).toBe("clean");
      if (r.kind !== "clean") return;
      expect(await fx.head(main, "main")).toBe(r.sha);
      expect(r.sha).not.toBe(mainHead);
      expect(await fx.host.readFile(main, "main", "src/a.ts")).toBe("a-lane\n");
      expect(await fx.host.readFile(main, "main", "src/b.ts")).toBe("b-main\n");
      // proof: lane head is an ancestor of the new integration head, the old main head too
      const proof = (ancestor: string) =>
        fx.wire.isAncestor({ remote: fx.remote(main), branch: "main", ancestor, descendant: r.sha });
      expect(await proof(laneHead)).toBe(true);
      expect(await proof(mainHead)).toBe(true);
    });

    it("lands a lane that is simply ahead (still a merge commit)", async () => {
      const { main, lane } = await scenario({ "a.txt": "1\n" });
      const before = await fx.head(main, "main");
      await fx.commit(lane, "main", { "b.txt": "2\n" });
      const r = await fx.wire.land(input(main, lane));
      expect(r.kind).toBe("clean");
      if (r.kind === "clean") {
        expect(r.sha).not.toBe(before);
        expect(await fx.host.readFile(main, "main", "b.txt")).toBe("2\n");
      }
    });

    it("reports conflicting files and leaves the integration branch untouched", async () => {
      const { main, lane } = await scenario({ "src/x.ts": "base\n", "src/y.ts": "y\n" });
      await fx.commit(lane, "main", { "src/x.ts": "lane\n", "src/y.ts": "y-lane\n" });
      const mainHead = await fx.commit(main, "main", { "src/x.ts": "main\n" });
      const r = await fx.wire.land(input(main, lane));
      expect(r).toEqual({ kind: "conflict", files: ["src/x.ts"] });
      expect(await fx.head(main, "main")).toBe(mainHead);
    });

    it("returns an error (never throws) when a remote or branch is missing", async () => {
      const { main, lane } = await scenario({ "a.txt": "1\n" });
      const bad = await fx.wire.land({ ...input(main, lane), laneBranch: "does-not-exist" });
      expect(bad.kind).toBe("error");
      const worse = await fx.wire.land({
        ...input(main, lane),
        integrationRemote: `${fx.remote(main)}-gone`,
      });
      expect(worse.kind).toBe("error");
    });

    it("isAncestor says no for a commit that is not reachable", async () => {
      const { main, lane } = await scenario({ "a.txt": "1\n" });
      const laneHead = await fx.commit(lane, "main", { "b.txt": "2\n" });
      const mainHead = await fx.head(main, "main");
      expect(
        await fx.wire.isAncestor({
          remote: fx.remote(main),
          branch: "main",
          ancestor: laneHead,
          descendant: mainHead,
        }),
      ).toBe(false);
    });
  });
}

/** Contract every `Store` + `Registry` implementation must satisfy. */
export function describeStoreContract(
  name: string,
  make: () => Promise<{ store: Store & Registry; cleanup?(): Promise<void> }>,
): void {
  describe(`Store contract: ${name}`, () => {
    let store: Store & Registry;
    let cleanup: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const m = await make();
      store = m.store;
      cleanup = m.cleanup;
    });
    afterAll(async () => cleanup?.());

    const project = (n: string): Project => ({
      name: n,
      repo: { name: `${n}-repo`, remote: `r://${n}` },
      integrationBranch: "main",
      laneMode: "fork",
      gatedPaths: ["a/**"],
      requiredChecks: ["unit"],
      createdAt: 1,
    });
    const lane = (id: number): Lane => ({
      id,
      taskId: "T-1",
      agent: "a",
      intent: "i",
      repo: { name: `l${id}`, remote: `r://l${id}` },
      branch: "main",
      state: "OPEN",
      base: "b",
      claims: ["x/**"],
      touched: [],
      drift: [],
      overlaps: [],
      gateRequired: false,
      ledger: { intent: false, handoff: false, evidence: false, handoffTooLong: false },
      allowDrift: false,
      openedAt: 1,
      updatedAt: 1,
    });

    it("round-trips projects and returns copies", async () => {
      const p = project("p1");
      await store.putProject(p);
      const got = await store.getProject("p1");
      expect(got).toEqual(p);
      (got as Project).gatedPaths.push("mutated");
      expect((await store.getProject("p1"))?.gatedPaths).toEqual(["a/**"]);
      expect(await store.getProject("nope")).toBeNull();
      await store.putProject(project("p2"));
      expect((await store.listProjects()).map((x) => x.name).sort()).toEqual(["p1", "p2"]);
    });

    it("allocates lane ids per project, monotonically", async () => {
      expect(await store.nextLaneId("ids-a")).toBe(1);
      expect(await store.nextLaneId("ids-a")).toBe(2);
      expect(await store.nextLaneId("ids-b")).toBe(1);
    });

    it("stores tasks and lanes, listing lanes by id", async () => {
      await store.putTask("p1", { id: "T-1", projectName: "p1", title: "t" });
      expect(await store.getTask("p1", "T-1")).toMatchObject({ title: "t" });
      expect(await store.getTask("p1", "T-9")).toBeNull();
      await store.putTask("p1", { id: "T-1", projectName: "p1", title: "t", winnerLane: 3 });
      expect((await store.listTasks("p1")).map((t) => t.winnerLane)).toEqual([3]);

      await store.putLane("p1", lane(2));
      await store.putLane("p1", lane(1));
      expect((await store.listLanes("p1")).map((l) => l.id)).toEqual([1, 2]);
      await store.putLane("p1", { ...lane(1), state: "PUSHED", head: "h" });
      expect(await store.getLane("p1", 1)).toMatchObject({ state: "PUSHED", head: "h" });
      expect(await store.getLane("p1", 7)).toBeNull();
      expect(await store.listLanes("empty-project")).toEqual([]);
    });

    it("keeps checks as an append-only history, filterable by lane", async () => {
      await store.putCheck("p1", { laneId: 1, name: "unit", status: "fail", at: 1 });
      await store.putCheck("p1", { laneId: 1, name: "unit", status: "pass", at: 2, head: "h" });
      await store.putCheck("p1", { laneId: 2, name: "unit", status: "pass", at: 3 });
      expect(await store.listChecks("p1")).toHaveLength(3);
      const l1 = await store.listChecks("p1", 1);
      expect(l1.map((c) => c.status)).toEqual(["fail", "pass"]);
      expect(l1[1]?.head).toBe("h");
    });

    it("keeps a queue keyed by lane", async () => {
      await store.enqueue("q", { laneId: 5, enqueuedAt: 10 });
      await store.enqueue("q", { laneId: 6, enqueuedAt: 20 });
      expect((await store.listQueue("q")).map((e) => e.laneId).sort()).toEqual([5, 6]);
      await store.dequeue("q", 5);
      await store.dequeue("q", 99);
      expect(await store.listQueue("q")).toEqual([{ laneId: 6, enqueuedAt: 20 }]);
    });

    it("lists events newest first with a limit", async () => {
      for (let i = 1; i <= 5; i++) await store.appendEvent("ev", { at: i, kind: `k${i}`, laneId: i });
      expect((await store.listEvents("ev", 3)).map((e) => e.kind)).toEqual(["k5", "k4", "k3"]);
      expect(await store.listEvents("none", 3)).toEqual([]);
    });

    it("registers forks and looks them up", async () => {
      await store.register("fork-1", "p1", 4);
      expect(await store.lookup("fork-1")).toEqual({ project: "p1", laneId: 4 });
      expect(await store.lookup("fork-x")).toBeNull();
    });

    it("withLock serialises critical sections per project and survives errors", async () => {
      const order: string[] = [];
      const slow = store.withLock("lock", async () => {
        order.push("a:start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a:end");
      });
      const fast = store.withLock("lock", async () => {
        order.push("b");
      });
      await Promise.all([slow, fast]);
      expect(order).toEqual(["a:start", "a:end", "b"]);
      await expect(
        store.withLock("lock", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await expect(store.withLock("lock", async () => 42)).resolves.toBe(42);
      // different projects do not block each other
      let other = false;
      const long = store.withLock("lock-a", () => new Promise<void>((r) => setTimeout(r, 40)));
      await store.withLock("lock-b", async () => {
        other = true;
      });
      expect(other).toBe(true);
      await long;
    });
  });
}
