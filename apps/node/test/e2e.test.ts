import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LocalFsHost } from "@hamonn/adapter-local-fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

// biome-ignore lint/suspicious/noExplicitAny: loosely-typed JSON in HTTP assertions
type Json = any;

const KEY = "e2e-key";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "agent",
      GIT_AUTHOR_EMAIL: "agent@example.invalid",
      GIT_COMMITTER_NAME: "agent",
      GIT_COMMITTER_EMAIL: "agent@example.invalid",
    },
  }).trim();
}

/** An agent: its own clone of its own lane repo. Everything it does is local to that fork. */
class Agent {
  dir: string;
  constructor(
    private api: Api,
    readonly name: string,
    root: string,
    readonly lane: { id: number; remote: string; branch: string },
  ) {
    this.dir = join(root, `wd-${name}`);
    git(root, "clone", "-q", lane.remote, this.dir);
  }
  write(files: Record<string, string>) {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, p)), { recursive: true });
      writeFileSync(join(this.dir, p), c);
    }
  }
  /** `hamonn push`: commit everything, push to *its own fork*, tell the service. */
  async push(message = "work") {
    git(this.dir, "add", "-A");
    git(this.dir, "commit", "-q", "--allow-empty", "-m", message);
    git(this.dir, "push", "-q", "-f", "origin", `HEAD:refs/heads/${this.lane.branch}`);
    const after = git(this.dir, "rev-parse", "HEAD");
    return this.api.post(`/api/projects/demo/lanes/${this.lane.id}/pushed`, { after });
  }
  ledger(extra: Record<string, string> = {}) {
    this.write({
      [`.lane/${this.lane.id}/intent.md`]: `${this.name}: do the thing\n`,
      [`.lane/${this.lane.id}/handoff.md`]: "state: done\nnext: land\n",
      ...extra,
    });
  }
}

class Api {
  constructor(private app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }) {}
  async post(path: string, body?: unknown) {
    return this.call("POST", path, body);
  }
  async get(path: string) {
    return this.call("GET", path);
  }
  private async call(method: string, path: string, body?: unknown) {
    const res = await this.app.request(path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }
}

describe("hamonn on node + local-fs: the full agent story over real git", () => {
  let root: string;
  let built: ReturnType<typeof buildApp>;
  let api: Api;
  let host: LocalFsHost;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "hamonn-e2e-"));
    built = buildApp({
      adminKey: KEY,
      root: join(root, "repos"),
      dbPath: ":memory:",
      log: { info() {}, warn() {} },
    });
    host = built.host as LocalFsHost;
    api = new Api(built.app);
  });
  afterAll(() => {
    built.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("isolates agents, flags drift, gates, compares candidates, lands with proof, and re-bases a BEHIND lane", async () => {
    const demo = await host.init("demo-app", {
      "src/rss/feed.ts": "export const feed = 0;\n",
      "src/cron/job.ts": "export const job = 0;\n",
      "src/db/schema.ts": "export const db = 0;\n",
      "README.md": "demo\n",
    });
    const created = await api.post("/api/projects", {
      name: "demo",
      repo: demo,
      gatedPaths: ["src/db/**"],
      requiredChecks: ["unit"],
    });
    expect(created.status).toBe(201);
    const mainAtStart = await host.headSha(demo, "main");

    // ── three agents open lanes concurrently; C overlaps A on the same task ──
    const open = async (task: string, agent: string, claims: string[]) => {
      const r = await api.post("/api/projects/demo/lanes", {
        task,
        agent,
        intent: `${agent} on ${task}`,
        claims,
      });
      expect(r.status).toBe(201);
      return r.body;
    };
    const [oa, ob] = await Promise.all([
      open("T-17", "claude-A", ["src/rss/**"]),
      open("T-18", "claude-B", ["src/cron/**"]),
    ]);
    const oc = await open("T-17", "claude-C", ["src/rss/feed.ts"]);
    expect(oc.overlaps).toEqual([oa.lane.id]);
    expect(oc.hint).toContain("compete as a candidate");

    const A = new Agent(api, "A", root, { id: oa.lane.id, remote: oa.lane.repo.remote, branch: "main" });
    const B = new Agent(api, "B", root, { id: ob.lane.id, remote: ob.lane.repo.remote, branch: "main" });
    const C = new Agent(api, "C", root, { id: oc.lane.id, remote: oc.lane.repo.remote, branch: "main" });

    // ── B wrecks its own checkout; nothing else moves ──
    B.write({ "src/cron/job.ts": "export const job = 1;\n" });
    git(B.dir, "reset", "--hard");
    git(B.dir, "stash", "-u");
    B.write({ "src/cron/job.ts": "export const job = 2;\n", "src/db/schema.ts": "export const db = 1;\n" });
    B.ledger();
    const pb = await B.push();
    expect(pb.body.lane.drift).toEqual(["src/db/schema.ts"]);
    expect(pb.body.lane.gateRequired).toBe(true);
    expect(await host.headSha(demo, "main")).toBe(mainAtStart);
    expect(await host.readFile(oa.lane.repo, "main", "src/rss/feed.ts")).toBe("export const feed = 0;\n");

    // ── A and C build competing versions of the same task ──
    A.write({ "src/rss/feed.ts": "export const feed = 'A';\n" });
    A.ledger();
    expect((await A.push()).body.lane.state).toBe("PUSHED");
    C.write({ "src/rss/feed.ts": "export const feed = 'C';\n" });
    await C.push(); // C never writes a ledger: not ready
    await api.post(`/api/projects/demo/lanes/${A.lane.id}/checks`, { name: "unit", status: "pass" });
    await api.post(`/api/projects/demo/lanes/${C.lane.id}/checks`, { name: "unit", status: "pass" });

    const compare = await api.get("/api/projects/demo/tasks/T-17");
    expect(compare.body.rows.map((r: Json) => r.laneId)).toEqual([A.lane.id, C.lane.id]);
    expect(compare.body.rows[0]).toMatchObject({ state: "READY", ledgerOk: true });
    expect(compare.body.rows[1]).toMatchObject({ state: "PUSHED", ledgerOk: false });

    // ── pick A: C is archived, A lands; the proof is the ancestor check ──
    const picked = await api.post("/api/projects/demo/tasks/T-17/pick", { lane: A.lane.id });
    expect(picked.body).toMatchObject({ winner: A.lane.id, archive: [C.lane.id], queuePosition: 0 });
    const drained = await api.post("/api/projects/demo/drain");
    expect(drained.body).toHaveLength(1);
    expect(drained.body[0]).toMatchObject({ laneId: A.lane.id, state: "LANDED" });
    const mainAfterA = await host.headSha(demo, "main");
    expect(mainAfterA).toBe(drained.body[0].landedSha);
    expect(mainAfterA).not.toBe(mainAtStart);
    expect(await host.readFile(demo, "main", "src/rss/feed.ts")).toBe("export const feed = 'A';\n");
    expect((await api.get(`/api/projects/demo/lanes/${C.lane.id}`)).body.lane.state).toBe("ARCHIVED");

    // ── B is blocked by drift + gate until the owner signs off and allows the drift ──
    await api.post(`/api/projects/demo/lanes/${B.lane.id}/checks`, { name: "unit", status: "pass" });
    const bBlocked = (await api.get(`/api/projects/demo/lanes/${B.lane.id}`)).body;
    expect(bBlocked.lane.state).toBe("PUSHED");
    expect(bBlocked.readiness.reasons.map((r: Json) => r.code)).toEqual(["DRIFT", "GATE_UNSIGNED"]);
    expect((await api.post(`/api/projects/demo/lanes/${B.lane.id}/land`)).status).toBe(409);

    // B removes its out-of-claim change and instead conflicts with a peer-landed change to its own file
    B.write({ "src/db/schema.ts": "export const db = 0;\n" });
    await B.push("revert out-of-claim edit");
    git(host.root, "--version");
    await host.commit(
      demo,
      "main",
      { "src/cron/job.ts": "export const job = 'peer';\n" },
      "peer edit lands on main",
    );
    await api.post(`/api/projects/demo/lanes/${B.lane.id}/checks`, { name: "unit", status: "pass" });
    const bReady = (await api.get(`/api/projects/demo/lanes/${B.lane.id}`)).body;
    expect(bReady.lane.state).toBe("READY");
    expect(bReady.lane.drift).toEqual([]);

    await api.post(`/api/projects/demo/lanes/${B.lane.id}/land`);
    const conflict = await api.post("/api/projects/demo/drain");
    expect(conflict.body[0]).toMatchObject({ state: "BEHIND", conflictFiles: ["src/cron/job.ts"] });

    // ── rebase: fetch main, resolve, push → PUSHED → READY → LANDED ──
    git(B.dir, "remote", "add", "integration", demo.remote);
    git(B.dir, "fetch", "-q", "integration", "main");
    try {
      git(B.dir, "rebase", "integration/main");
    } catch {
      // expected conflict on src/cron/job.ts: take B's version on top of the peer's
      writeFileSync(join(B.dir, "src/cron/job.ts"), "export const job = 'B-on-peer';\n");
      git(B.dir, "add", "-A");
      execFileSync("git", ["-c", "core.editor=true", "rebase", "--continue"], {
        cwd: B.dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "a",
          GIT_AUTHOR_EMAIL: "a@b.c",
          GIT_COMMITTER_NAME: "a",
          GIT_COMMITTER_EMAIL: "a@b.c",
        },
      });
    }
    const re = await B.push("rebased");
    expect(re.body.lane.state).toBe("PUSHED");
    await api.post(`/api/projects/demo/lanes/${B.lane.id}/checks`, { name: "unit", status: "pass" });
    expect((await api.post(`/api/projects/demo/lanes/${B.lane.id}/land`)).status).toBe(202);
    const landedB = await api.post("/api/projects/demo/drain");
    expect(landedB.body[0].state).toBe("LANDED");

    // ── landed proof: every landed lane head is an ancestor of the integration head ──
    const head = (await host.headSha(demo, "main")) as string;
    expect(head).toBe(landedB.body[0].landedSha);
    for (const lane of [A.lane, B.lane]) {
      const laneHead = (await api.get(`/api/projects/demo/lanes/${lane.id}`)).body.lane.head;
      expect(() => git(demo.remote, "merge-base", "--is-ancestor", laneHead, head)).not.toThrow();
    }
    expect(readFileSync(join(root, "wd-A", "src/rss/feed.ts"), "utf8")).toBe("export const feed = 'A';\n");

    // ── board & UI reflect everything ──
    const board = (await api.get("/api/projects/demo")).body;
    expect(board.lanes.LANDED.map((l: Json) => l.id)).toEqual([A.lane.id, B.lane.id]);
    expect(board.lanes.ARCHIVED.map((l: Json) => l.id)).toEqual([C.lane.id]);
    expect(board.integrationHead).toBe(head);
    const page = await built.app.request("/p/demo");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("LANDED (2)");
  }, 120_000);

  it("rejects writes without the admin key", async () => {
    const res = await built.app.request("/api/projects", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
