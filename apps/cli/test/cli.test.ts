import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalFsHost } from "@hamonn/adapter-local-fs";
import { buildApp } from "@hamonn/node/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import { type CliIo, run } from "../src/io.ts";

const KEY = "cli-key";
const GIT_ENV = {
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.invalid",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.invalid",
};

let root: string;
let built: ReturnType<typeof buildApp>;
let host: LocalFsHost;

function io(cwd: string, lines: string[], extraEnv: Record<string, string> = {}): CliIo {
  return {
    cwd,
    env: { HAMONN_URL: "http://hamonn.test", HAMONN_KEY: KEY, HAMONN_PROJECT: "demo", ...extraEnv },
    fetch: async (url, init) => {
      const u = new URL(url);
      return built.app.request(u.pathname + u.search, init);
    },
    git: (args, opts) => run("git", args, opts?.cwd ?? cwd, GIT_ENV),
    run: (cmd, args, opts) => run(cmd, args, opts?.cwd ?? cwd, GIT_ENV),
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  };
}

async function hamonn(cwd: string, ...argv: string[]) {
  const lines: string[] = [];
  const code = await main(argv, io(cwd, lines));
  return { code, text: lines.join("\n"), lines };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hamonn-cli-"));
  built = buildApp({
    adminKey: KEY,
    root: join(root, "repos"),
    dbPath: ":memory:",
    log: { info() {}, warn() {} },
  });
  host = built.host as LocalFsHost;
  const repo = await host.init("demo-app", { "src/x.ts": "base\n", "src/y.ts": "y\n" });
  const res = await built.app.request("/api/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "demo", repo, requiredChecks: ["unit"], gatedPaths: ["infra/**"] }),
  });
  expect(res.status).toBe(201);
});
afterAll(() => {
  built.close();
  rmSync(root, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

describe("hamonn CLI against a real server and real git", () => {
  it("open → edit → handoff → checks → land, then conflict → BEHIND → rebase → land", async () => {
    const a = join(root, "agent-a");
    const b = join(root, "agent-b");
    const open = (dir: string, agent: string, claim: string) =>
      hamonn(
        root,
        "open",
        "--task",
        "T-1",
        "--agent",
        agent,
        "--intent",
        `${agent} works`,
        "--claim",
        claim,
        "--dir",
        dir,
      );

    const oa = await open(a, "A", "src/**");
    expect(oa.code).toBe(0);
    expect(oa.text).toContain("lane #1 opened");
    const ob = await open(b, "B", "src/x.ts");
    expect(ob.text).toContain("⚠ claims overlap open lane(s) #1");

    // both edit the same file; A goes first
    writeFileSync(join(a, "src/x.ts"), "A\n");
    writeFileSync(join(b, "src/x.ts"), "B\n");
    expect((await hamonn(a, "handoff", "done by A")).text).toContain("check unit: missing");
    expect((await hamonn(a, "checks", "unit=pass")).text).toContain("unit=pass → READY");
    const status = await hamonn(a, "status");
    expect(status.text).toContain("ready to land");
    const landed = await hamonn(a, "land");
    expect(landed.code).toBe(0);
    expect(landed.text).toMatch(/LANDED @ [0-9a-f]{40}/);
    expect(
      await host.readFile({ name: "demo-app", remote: join(root, "repos/demo-app.git") }, "main", "src/x.ts"),
    ).toBe("A\n");

    // B: not ready until handoff + checks; then its land conflicts with A's change
    await hamonn(b, "handoff", "done by B");
    const early = await hamonn(b, "land");
    expect(early.code).toBe(1);
    expect(early.text).toContain("cannot land yet");
    expect(early.text).toContain("check unit: missing");
    await hamonn(b, "checks", "unit=pass");
    const behind = await hamonn(b, "land");
    expect(behind.code).toBe(1);
    expect(behind.text).toContain("BEHIND: src/x.ts");

    // rebase hits the same conflict; the agent resolves it and pushes
    const rb = await hamonn(b, "rebase");
    expect(rb.code).toBe(2);
    expect(rb.text).toContain("rebase stopped on conflicts");
    writeFileSync(join(b, "src/x.ts"), "A+B\n");
    sh(b, "add", "-A");
    execFileSync("git", ["-c", "core.editor=true", "rebase", "--continue"], {
      cwd: b,
      env: { ...process.env, ...GIT_ENV },
    });
    expect((await hamonn(b, "push")).text).toContain("PUSHED");
    await hamonn(b, "checks", "unit=pass");
    const final = await hamonn(b, "land");
    expect(final.code).toBe(0);
    expect(final.text).toMatch(/LANDED @/);
    expect(readFileSync(join(a, "src/x.ts"), "utf8")).toBe("A\n");
    const head = (await host.headSha(
      { name: "demo-app", remote: join(root, "repos/demo-app.git") },
      "main",
    )) as string;
    expect(final.text).toContain(head);
  }, 120_000);

  it("clean rebase pushes automatically; evidence appends; token rotates; archive ends the lane", async () => {
    const c = join(root, "agent-c");
    const repo = { name: "demo-app", remote: join(root, "repos/demo-app.git") };
    await hamonn(
      root,
      "open",
      "--task",
      "T-2",
      "--agent",
      "C",
      "--intent",
      "c works",
      "--claim",
      "docs/**",
      "--dir",
      c,
    );
    await host.commit(repo, "main", { "src/y.ts": "y2\n" }); // main moves on after C opened
    mkdirSync(join(c, "docs"), { recursive: true });
    writeFileSync(join(c, "docs/note.md"), "note\n");
    const ev = await hamonn(c, "evidence", "ran the thing", "twice");
    expect(ev.text).toContain("PUSHED");
    expect(readFileSync(join(c, ".lane/3/evidence.md"), "utf8")).toBe("ran the thing twice\n");
    const rebased = await hamonn(c, "rebase");
    expect(rebased.code).toBe(0);
    expect(rebased.text).toContain("PUSHED");
    expect(rebased.text).not.toContain("drift"); // upstream y.ts change is not this lane's drift
    const tok = await hamonn(c, "token");
    expect(tok.text).toContain("fresh write token");
    expect((await hamonn(c, "push")).code).toBe(0);
    expect((await hamonn(c, "archive")).text).toContain("archived");
    writeFileSync(join(c, "docs/more.md"), "more\n");
    expect((await hamonn(c, "push")).code).toBe(1); // archived lanes accept no new pushes
  }, 60_000);

  it("reports usage and configuration errors without a stack trace", async () => {
    const lines = (code: number, l: string[]) => ({ code, text: l.join("\n") });
    const run1 = async (argv: string[], env: Record<string, string> = {}, cwd = root) => {
      const l: string[] = [];
      const code = await main(argv, { ...io(cwd, l), env });
      return lines(code, l);
    };
    expect((await run1([])).code).toBe(1);
    expect((await run1(["--help"])).text).toContain("hamonn open");
    expect((await run1(["help"])).code).toBe(0);
    expect((await run1(["bogus"], { HAMONN_URL: "u", HAMONN_KEY: "k", HAMONN_PROJECT: "p" })).text).toContain(
      "unknown command",
    );
    expect((await run1(["status"])).text).toContain("HAMONN_URL");
    expect((await run1(["status"], { HAMONN_URL: "u" })).text).toContain("HAMONN_KEY");
    expect((await run1(["status"], { HAMONN_URL: "u", HAMONN_KEY: "k" })).text).toContain("HAMONN_PROJECT");
    const env = { HAMONN_URL: "http://hamonn.test", HAMONN_KEY: KEY, HAMONN_PROJECT: "demo" };
    expect((await run1(["status"], env, mkdtempSync(join(tmpdir(), "empty-")))).text).toContain(
      "hamonn open",
    );
    expect((await run1(["open", "--task", "T"], env)).text).toContain("--claim");
    expect((await run1(["--nope"], env)).code).toBe(1);
    const bad = await run1(
      ["open", "--task", "T", "--agent", "a", "--intent", "i", "--claim", "x/**", "--project", "missing"],
      env,
    );
    expect(bad.text).toContain("NOT_FOUND");
    const wrongKey = await run1(["open", "--task", "T", "--agent", "a", "--intent", "i", "--claim", "x/**"], {
      ...env,
      HAMONN_KEY: "nope",
    });
    expect(wrongKey.text).toContain("UNAUTHORIZED");
  });

  it("validates handoff/evidence/checks input and prints the Cloudflare setup commands", async () => {
    const d = join(root, "agent-d");
    await hamonn(
      root,
      "open",
      "--task",
      "T-4",
      "--agent",
      "D",
      "--intent",
      "d",
      "--claim",
      "d/**",
      "--dir",
      d,
    );
    expect((await hamonn(d, "handoff")).text).toContain("needs text");
    expect((await hamonn(d, "evidence")).text).toContain("needs text");
    expect((await hamonn(d, "checks")).text).toContain("name=pass");
    expect((await hamonn(d, "checks", "unit")).text).toContain("bad check");
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    expect((await hamonn(d, "handoff", long)).text).toContain("longer than 10 lines");
    const setup = await hamonn(root, "setup", "demo-app");
    expect(setup.text).toContain("wrangler queues create hamonn-events");
    expect(setup.text).toContain("--repo_name demo-app");
    expect(setup.text).toContain("dry run");
    expect((await hamonn(root, "setup")).text).not.toContain("--repo_name");
    expect((await hamonn(root, "land", "--timeout", "1")).text).toContain("hamonn open");
  }, 60_000);
});
