import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHttpServer {
  /** Base URL, e.g. `http://127.0.0.1:41234`. Repos are served at `<base>/<name>.git`. */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Serves every bare repo under `root` over git smart-HTTP (v1 + v2 fetch, push) by driving
 * `git http-backend`. Test support: lets HTTP-only wires (isomorphic-git) run against real git
 * without any cloud. When `token` is set, requests must carry Basic `x:<token>` like Artifacts.
 */
export async function startGitHttpServer(
  root: string,
  opts: { token?: string } = {},
): Promise<GitHttpServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (opts.token) {
        const auth = req.headers.authorization ?? "";
        const expected = `Basic ${Buffer.from(`x:${opts.token}`).toString("base64")}`;
        if (auth !== expected) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end("unauthorized");
          return;
        }
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const payload = await body(req);
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.receivepack",
        GIT_CONFIG_VALUE_0: "true",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(payload.length),
        REMOTE_USER: "x",
        REMOTE_ADDR: "127.0.0.1",
      };
      if (req.headers["content-encoding"])
        env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
      if (req.headers["git-protocol"]) env.GIT_PROTOCOL = String(req.headers["git-protocol"]);
      const child = spawn("git", ["http-backend"], { env });
      const out: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stdin.on("error", () => {});
      child.stdin.end(payload);
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
      const raw = Buffer.concat(out);
      const split = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, split < 0 ? 0 : split).toString("utf8");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split("\r\n").filter(Boolean)) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === "status") status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers).end(raw.subarray(split < 0 ? 0 : split + 4));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
