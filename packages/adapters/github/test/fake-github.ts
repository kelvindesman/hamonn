import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * A fake of the GitHub REST endpoints the adapter uses, served from real bare repos.
 * NOTE: response shapes are hand-modelled from the public REST docs, not recorded from github.com.
 * `owner/repo` maps to `<root>/owner/repo.git`.
 */
export class FakeGitHub {
  calls: string[] = [];
  forkProbeFailures = 0;
  constructor(
    readonly root: string,
    private user = "agent-user",
  ) {}

  path(fullName: string) {
    return join(this.root, `${fullName}.git`);
  }
  private git(fullName: string, ...args: string[]) {
    return execFileSync("git", ["--git-dir", this.path(fullName), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    this.calls.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    if (!headers.get("authorization")?.startsWith("Bearer "))
      return new Response("unauthorized", { status: 401 });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const full = m[1] as string;
    const rest = decodeURIComponent(m[2] ?? "");
    const accept = headers.get("accept") ?? "";
    try {
      if (init.method === "POST" && rest === "/forks") {
        const body = JSON.parse(String(init.body)) as { name: string; organization?: string };
        const forkFull = `${body.organization ?? this.user}/${body.name}`;
        execFileSync("git", ["clone", "-q", "--bare", this.path(full), this.path(forkFull)]);
        this.forkProbeFailures = 1; // forks are asynchronous: the first probe 404s
        return Response.json({ full_name: forkFull }, { status: 202 });
      }
      if (rest === "/commits" && u.searchParams.get("per_page") === "1") {
        if (this.forkProbeFailures > 0) {
          this.forkProbeFailures--;
          return new Response("{}", { status: 404 });
        }
        return Response.json([]);
      }
      const commit = /^\/commits\/(.+)$/.exec(rest);
      if (commit) {
        try {
          const sha = this.git(full, "rev-parse", "--verify", "-q", `${commit[1]}^{commit}`).trim();
          return accept.includes("sha") ? new Response(sha) : Response.json({ sha });
        } catch {
          return new Response("{}", { status: 422 });
        }
      }
      const contents = /^\/contents\/(.+)$/.exec(rest);
      if (contents) {
        const ref = u.searchParams.get("ref") ?? "HEAD";
        try {
          return new Response(this.git(full, "show", `${ref}:${contents[1]}`));
        } catch {
          return new Response("{}", { status: 404 });
        }
      }
      const cmp = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest);
      if (cmp) {
        const [a, b] = [cmp[1] as string, cmp[2] as string];
        let base: string;
        try {
          base = this.git(full, "merge-base", a, b).trim();
        } catch {
          return new Response("{}", { status: 404 });
        }
        const files = this.git(full, "diff", "--name-status", "-M", "-z", a, b).split("\0").filter(Boolean);
        const out: { filename: string; status: string; previous_filename?: string }[] = [];
        for (let i = 0; i < files.length; ) {
          const status = files[i++] as string;
          if (status.startsWith("R")) {
            const prev = files[i++] as string;
            out.push({ filename: files[i++] as string, status: "renamed", previous_filename: prev });
          } else out.push({ filename: files[i++] as string, status });
        }
        const per = Number(u.searchParams.get("per_page") ?? 30);
        const page = Number(u.searchParams.get("page") ?? 1);
        return Response.json({
          merge_base_commit: { sha: base },
          files: out.slice((page - 1) * per, page * per),
        });
      }
      const tree = /^\/git\/trees\/(.+)$/.exec(rest);
      if (tree) {
        const entries = this.git(full, "ls-tree", "-r", "-z", tree[1] as string)
          .split("\0")
          .filter(Boolean)
          .map((l) => ({ path: l.split("\t")[1] as string, type: l.split(" ")[1] as string }));
        return Response.json({ tree: entries, truncated: false });
      }
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };
}
