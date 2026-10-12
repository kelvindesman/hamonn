import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Everything the CLI touches outside its own process, injectable for tests. */
export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  git(args: string[], opts?: { cwd?: string }): Promise<GitResult>;
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<GitResult>;
  out(line: string): void;
  err(line: string): void;
  sleep(ms: number): Promise<void>;
}

export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    git: (args, opts) => run("git", args, opts?.cwd),
    run: (cmd, args, opts) => run(cmd, args, opts?.cwd),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
