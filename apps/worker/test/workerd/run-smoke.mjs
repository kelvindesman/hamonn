// Usage: npx tsx test/workerd/run-smoke.mjs   (needs git + wrangler; no Cloudflare account)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitHttpServer } from "../../../../packages/adapters/contract/src/git-http-server.ts";
import { LocalFsHost } from "../../../../packages/adapters/local-fs/src/index.ts";

const root = mkdtempSync(join(tmpdir(), "hamonn-workerd-"));
const host = new LocalFsHost(root);
const server = await startGitHttpServer(root);
const main = await host.init("main", { "a.txt": "1\n", "b.txt": "2\n" });
const lane = await host.fork(main, "lane");
const laneHead = await host.commit(lane, "main", { "a.txt": "lane\n" });
await host.commit(main, "main", { "b.txt": "main\n" });

const dev = spawn(
  "npx",
  ["wrangler", "dev", "--local", "--port", "8798", "-c", "test/workerd/wrangler.jsonc"],
  {
    stdio: "ignore",
    detached: true,
  },
);
let up = false;
try {
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      up = (await fetch("http://localhost:8798/")).status === 400;
    } catch {}
  }
  if (!up) throw new Error("workerd did not start");
  const base = encodeURIComponent(`http://127.0.0.1:${server.port}`);
  const res = await (await fetch(`http://localhost:8798/?base=${base}&laneHead=${laneHead}`)).json();
  console.log(JSON.stringify(res));
  const head = await host.headSha(main, "main");
  const a = await host.readFile(main, "main", "a.txt");
  const b = await host.readFile(main, "main", "b.txt");
  console.log(JSON.stringify({ head, a, b }));
  if (
    res.result.kind !== "clean" ||
    res.result.sha !== head ||
    a !== "lane\n" ||
    b !== "main\n" ||
    res.proof !== true
  ) {
    process.exitCode = 1;
  } else {
    console.log("OK: landed inside workerd, ancestor proof true");
  }
} finally {
  try {
    process.kill(-dev.pid, "SIGKILL"); // the whole wrangler/workerd process group
  } catch {}
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
