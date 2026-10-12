import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CliIo } from "./io.ts";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

interface LaneState {
  url: string;
  project: string;
  laneId: number;
  task: string;
  branch: string;
}

const STATE_FILE = ".lane/lane.json";
const TERMINAL = new Set(["LANDED", "BEHIND", "FAILED", "ARCHIVED"]);

export const USAGE = `hamonn: land agent work without ever holding a write token to the integration branch

  hamonn open --task T-17 --agent claude-A --intent "..." --claim 'src/rss/**' [--claim ...] [--dir work] [--strict]
  hamonn push [-m msg]            commit everything, push to YOUR fork, notify hamonn
  hamonn handoff "<=10 lines"     write .lane/<id>/handoff.md and push
  hamonn evidence "text"          append to .lane/<id>/evidence.md and push
  hamonn checks unit=pass lint=fail [--check-url u]
  hamonn land [--timeout 120]     queue the lane; prints LANDED @ <sha> | BEHIND: <files> | FAILED: <msg>
  hamonn rebase                   fetch the integration branch, rebase, push
  hamonn status | token | archive
  hamonn setup                    print (or --run) the Cloudflare queue + subscription commands

env: HAMONN_URL, HAMONN_KEY, HAMONN_PROJECT   (flags --url --key --project override)`;

class Ctx {
  constructor(
    readonly io: CliIo,
    readonly url: string,
    readonly key: string,
    readonly project: string,
  ) {}

  async api<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; body: T }> {
    const res = await this.io.fetch(`${this.url.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep text
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const e = (parsed as { error?: { code?: string; message?: string } })?.error;
      throw new CliError(e ? `${e.code}: ${e.message}` : `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return { status: res.status, body: parsed as T };
  }

  async git(cwd: string, ...args: string[]): Promise<string> {
    const r = await this.io.git(args, { cwd });
    if (r.code !== 0)
      throw new CliError(`git ${args[0]} failed: ${scrub(r.stderr.trim() || r.stdout.trim())}`);
    return r.stdout;
  }
}

const scrub = (s: string) => s.replace(/\/\/[^/@\s]+@/g, "//***@");

function loadState(cwd: string): LaneState {
  const file = join(cwd, STATE_FILE);
  if (!existsSync(file)) throw new CliError(`no ${STATE_FILE} here: run \`hamonn open\` first`);
  return JSON.parse(readFileSync(file, "utf8")) as LaneState;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

interface Readiness {
  ready: boolean;
  reasons: { code: string; name?: string; paths?: string[]; state?: string }[];
}

function describeReasons(r: Readiness): string[] {
  return r.reasons.map((x) => {
    switch (x.code) {
      case "CHECK_MISSING":
      case "CHECK_FAILING":
      case "CHECK_PENDING":
        return `check ${x.name}: ${x.code.slice(6).toLowerCase()}`;
      case "DRIFT":
        return `drift outside claims: ${x.paths?.join(", ")}`;
      case "GATE_UNSIGNED":
        return "gated path touched: needs sign-off";
      case "INTENT_MISSING":
        return "intent ledger missing";
      case "HANDOFF_MISSING":
        return "handoff ledger missing";
      case "NO_PUSH":
        return "nothing pushed yet";
      default:
        return `${x.code.toLowerCase()} ${x.state ?? ""}`.trim();
    }
  });
}

async function connect(io: CliIo, values: Record<string, unknown>): Promise<Ctx> {
  const url = (values.url as string | undefined) ?? io.env.HAMONN_URL;
  const key = (values.key as string | undefined) ?? io.env.HAMONN_KEY;
  const project = (values.project as string | undefined) ?? io.env.HAMONN_PROJECT;
  if (!url) throw new CliError("HAMONN_URL (or --url) is required");
  if (!key) throw new CliError("HAMONN_KEY (or --key) is required");
  if (!project) throw new CliError("HAMONN_PROJECT (or --project) is required");
  return new Ctx(io, url, key, project);
}

const OPTIONS = {
  url: { type: "string" },
  key: { type: "string" },
  project: { type: "string" },
  task: { type: "string" },
  title: { type: "string" },
  agent: { type: "string" },
  intent: { type: "string" },
  claim: { type: "string", multiple: true },
  dir: { type: "string" },
  strict: { type: "boolean" },
  message: { type: "string", short: "m" },
  "check-url": { type: "string" },
  timeout: { type: "string" },
  run: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** `-c user.*` flags used only when git has no identity configured, so `commit` never fails on a fresh agent box. */
async function identityArgs(c: Ctx, cwd: string): Promise<string[]> {
  const has = (await c.io.git(["config", "user.email"], { cwd })).code === 0;
  return has ? [] : ["-c", "user.name=hamonn-agent", "-c", "user.email=agent@hamonn.invalid"];
}

async function commitAll(c: Ctx, cwd: string, message: string): Promise<void> {
  await c.git(cwd, "add", "-A");
  if ((await c.git(cwd, "status", "--porcelain")).trim()) {
    await c.git(cwd, ...(await identityArgs(c, cwd)), "commit", "-q", "-m", message);
  }
}

async function setRemote(c: Ctx, dir: string, remote: string): Promise<void> {
  const has = (await c.io.git(["remote", "get-url", "origin"], { cwd: dir })).code === 0;
  await c.git(dir, "remote", has ? "set-url" : "add", "origin", remote);
}

async function commands(
  c: Ctx,
  cmd: string,
  positionals: string[],
  v: Record<string, unknown>,
  cwd: string,
): Promise<number> {
  const { io } = c;
  switch (cmd) {
    case "open": {
      const task = v.task as string | undefined;
      const agent = v.agent as string | undefined;
      const intent = v.intent as string | undefined;
      const claims = (v.claim as string[] | undefined) ?? [];
      if (!task || !agent || !intent || claims.length === 0) {
        throw new CliError("open needs --task, --agent, --intent and at least one --claim");
      }
      const { body } = await c.api<{
        lane: { id: number; branch: string; repo: { name: string } };
        remote: string;
        overlaps: number[];
        hint?: string;
      }>("POST", `/api/projects/${c.project}/lanes${v.strict ? "?strict=1" : ""}`, {
        task,
        title: v.title,
        agent,
        intent,
        claims,
      });
      const dir = resolve(cwd, (v.dir as string | undefined) ?? ".");
      mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, ".git"))) await c.git(dir, "clone", "-q", body.remote, ".");
      else await setRemote(c, dir, body.remote);
      await c.git(dir, "checkout", "-q", "-B", body.lane.branch);
      const state: LaneState = {
        url: c.url,
        project: c.project,
        laneId: body.lane.id,
        task,
        branch: body.lane.branch,
      };
      writeFile(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
      appendFileSync(join(dir, ".git/info/exclude"), "\n.lane/lane.json\n");
      writeFile(join(dir, `.lane/${body.lane.id}/intent.md`), `${intent}\n\nclaims: ${claims.join(" ")}\n`);
      // Commit the intent now: an uncommitted ledger would not survive a `git reset --hard`.
      await commitAll(c, dir, `hamonn: open lane #${body.lane.id}`);
      io.out(`lane #${body.lane.id} opened on ${body.lane.repo.name} (${body.lane.branch}) in ${dir}`);
      if (body.hint) io.out(`⚠ ${body.hint}`);
      return 0;
    }
    case "push": {
      const s = loadState(cwd);
      await commitAll(c, cwd, (v.message as string | undefined) ?? `hamonn: lane #${s.laneId}`);
      // Safe by construction: this is the agent's own fork/branch, never the integration branch.
      await c.git(cwd, "push", "-q", "--force", "origin", `HEAD:refs/heads/${s.branch}`);
      const after = (await c.git(cwd, "rev-parse", "HEAD")).trim();
      const { body } = await c.api<{ lane: { state: string }; readiness: Readiness }>(
        "POST",
        `/api/projects/${s.project}/lanes/${s.laneId}/pushed`,
        { after },
      );
      io.out(`pushed ${after.slice(0, 7)}: ${body.lane.state}`);
      for (const line of describeReasons(body.readiness)) io.out(`  · ${line}`);
      return 0;
    }
    case "handoff": {
      const s = loadState(cwd);
      const text = positionals.join(" ").trim();
      if (!text) throw new CliError("handoff needs text (<=10 lines)");
      if (text.split("\n").filter((l) => l.trim()).length > 10)
        io.err("warning: handoff is longer than 10 lines");
      writeFile(join(cwd, `.lane/${s.laneId}/handoff.md`), `${text}\n`);
      return commands(c, "push", [], { message: `hamonn: handoff for lane #${s.laneId}` }, cwd);
    }
    case "evidence": {
      const s = loadState(cwd);
      const text = positionals.join(" ").trim();
      if (!text) throw new CliError("evidence needs text");
      appendFileSync(join(cwd, `.lane/${s.laneId}/evidence.md`), `${text}\n`);
      return commands(c, "push", [], { message: `hamonn: evidence for lane #${s.laneId}` }, cwd);
    }
    case "checks": {
      const s = loadState(cwd);
      if (positionals.length === 0) throw new CliError("checks needs name=pass|fail|pending pairs");
      for (const pair of positionals) {
        const [name, status] = pair.split("=");
        if (!name || !status) throw new CliError(`bad check ${pair}: use name=pass|fail|pending`);
        const { body } = await c.api<{ lane: { state: string } }>(
          "POST",
          `/api/projects/${s.project}/lanes/${s.laneId}/checks`,
          {
            name,
            status,
            url: v["check-url"],
          },
        );
        io.out(`${name}=${status} → ${body.lane.state}`);
      }
      return 0;
    }
    case "land": {
      const s = loadState(cwd);
      const queued = await c.api<{ queuePosition: number }>(
        "POST",
        `/api/projects/${s.project}/lanes/${s.laneId}/land`,
        undefined,
        [409],
      );
      if (queued.status === 409) {
        const lane = await c.api<{ readiness: Readiness }>(
          "GET",
          `/api/projects/${s.project}/lanes/${s.laneId}`,
        );
        io.err("cannot land yet:");
        for (const line of describeReasons(lane.body.readiness)) io.err(`  · ${line}`);
        return 1;
      }
      io.out(`queued (position ${queued.body.queuePosition})`);
      const deadline = Date.now() + Number((v.timeout as string | undefined) ?? 120) * 1000;
      for (;;) {
        const { body } = await c.api<{
          lane: { state: string; landedSha?: string; conflictFiles?: string[]; failure?: string };
        }>("GET", `/api/projects/${s.project}/lanes/${s.laneId}`);
        const l = body.lane;
        if (TERMINAL.has(l.state)) {
          if (l.state === "LANDED") io.out(`LANDED @ ${l.landedSha}`);
          else if (l.state === "BEHIND") io.out(`BEHIND: ${(l.conflictFiles ?? []).join(", ")}`);
          else if (l.state === "FAILED") io.out(`FAILED: ${l.failure}`);
          else io.out(l.state);
          return l.state === "LANDED" ? 0 : 1;
        }
        if (Date.now() > deadline) throw new CliError(`timed out waiting for landing (state ${l.state})`);
        await io.sleep(500);
      }
    }
    case "rebase": {
      const s = loadState(cwd);
      const { body } = await c.api<{ remote: string; branch: string }>(
        "POST",
        `/api/projects/${s.project}/integration-remote`,
      );
      await c.git(cwd, "fetch", "-q", body.remote, body.branch);
      const r = await io.git(["rebase", "FETCH_HEAD"], { cwd });
      if (r.code !== 0) {
        io.err("rebase stopped on conflicts. Resolve them, `git rebase --continue`, then `hamonn push`.");
        return 2;
      }
      return commands(c, "push", [], { message: `hamonn: rebase lane #${s.laneId}` }, cwd);
    }
    case "status": {
      const s = loadState(cwd);
      const { body } = await c.api<{
        lane: { state: string; head?: string; drift: string[] };
        readiness: Readiness;
      }>("GET", `/api/projects/${s.project}/lanes/${s.laneId}`);
      io.out(`lane #${s.laneId} ${body.lane.state} head=${(body.lane.head ?? "-").slice(0, 7)}`);
      io.out(body.readiness.ready ? "  ready to land" : "  not ready:");
      for (const line of describeReasons(body.readiness)) io.out(`  · ${line}`);
      return 0;
    }
    case "token": {
      const s = loadState(cwd);
      const { body } = await c.api<{ remote: string }>(
        "POST",
        `/api/projects/${s.project}/lanes/${s.laneId}/token`,
      );
      await setRemote(c, cwd, body.remote);
      io.out("fresh write token installed on origin");
      return 0;
    }
    case "archive": {
      const s = loadState(cwd);
      await c.api("POST", `/api/projects/${s.project}/lanes/${s.laneId}/archive`);
      io.out(`lane #${s.laneId} archived`);
      return 0;
    }
    default:
      throw new CliError(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

/** Cloudflare one-time setup: the queue and the event subscriptions hamonn listens on. */
async function setup(io: CliIo, v: Record<string, unknown>, repo?: string): Promise<number> {
  const cmds: string[][] = [
    ["wrangler", "queues", "create", "hamonn-events"],
    [
      "wrangler",
      "queues",
      "subscription",
      "create",
      "hamonn-events",
      "--source",
      "artifacts",
      "--events",
      "cf.artifacts.repo.created,cf.artifacts.repo.forked,cf.artifacts.repo.deleted",
    ],
  ];
  if (repo) {
    cmds.push([
      "wrangler",
      "queues",
      "subscription",
      "create",
      "hamonn-events",
      "--source",
      "artifacts.repo",
      "--namespace",
      "default",
      "--repo_name",
      repo,
      "--events",
      "cf.artifacts.repo.pushed",
    ]);
  }
  for (const c of cmds) {
    io.out(`npx ${c.join(" ")}`);
    if (v.run) {
      const r = await io.run("npx", c, { cwd: io.cwd });
      if (r.code !== 0) io.err(scrub(r.stderr.trim()));
    }
  }
  if (!v.run)
    io.out(
      "(dry run: add --run to execute; verify flag names with `npx wrangler queues subscription create --help`)",
    );
  return 0;
}

/** Entry point. Returns a process exit code; never calls `process.exit`. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [cmd, ...rest] = positionals;
    if (!cmd || values.help || cmd === "help") {
      io.out(USAGE);
      return cmd || values.help ? 0 : 1;
    }
    if (cmd === "setup") return await setup(io, values, rest[0]);
    const cwd = io.cwd;
    // commands inside an existing lane directory use the saved URL/project unless overridden
    const saved = existsSync(join(cwd, STATE_FILE)) ? loadState(cwd) : undefined;
    const merged = { ...values, url: values.url ?? saved?.url, project: values.project ?? saved?.project };
    const ctx = await connect(io, merged);
    return await commands(ctx, cmd, rest, values, cwd);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`hamonn: ${e.message}`);
      return e.exitCode;
    }
    io.err(`hamonn: ${scrub(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}
