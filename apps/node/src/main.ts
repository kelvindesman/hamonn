#!/usr/bin/env -S npx tsx
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GithubHost } from "@hamonn/adapter-github";
import { serve } from "@hono/node-server";
import { buildApp } from "./app.ts";

const env = process.env;
const adminKey = env.HAMONN_ADMIN_KEY;
if (!adminKey) {
  console.error("HAMONN_ADMIN_KEY is required (all non-GET requests need it as a bearer token)");
  process.exit(1);
}
const root = resolve(env.HAMONN_ROOT ?? "./hamonn-data/repos");
mkdirSync(root, { recursive: true });
const dbPath = resolve(env.HAMONN_DB ?? "./hamonn-data/hamonn.db");
mkdirSync(dirname(dbPath), { recursive: true });

// HAMONN_HOST=github keeps the repos on GitHub (lanes are forks); local-fs keeps bare repos under HAMONN_ROOT.
let host: GithubHost | undefined;
if ((env.HAMONN_HOST ?? "local-fs") === "github") {
  if (!env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is required when HAMONN_HOST=github");
    process.exit(1);
  }
  host = new GithubHost({ token: env.GITHUB_TOKEN, forkOrg: env.GITHUB_FORK_ORG });
}
const { app } = buildApp({
  host,
  adminKey,
  root,
  dbPath,
  hookSecret: env.HAMONN_HOOK_SECRET,
});
const port = Number(env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ level: "info", event: "serve.listening", port: info.port, root }));
});
