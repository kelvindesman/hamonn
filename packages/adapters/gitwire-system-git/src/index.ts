import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WireResult } from "@hamonn/core";
import type { AncestorInput, GitWire, LandInput } from "@hamonn/shell";

const run = promisify(execFile);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      maxBuffer: 256 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === "number" ? err.code : 128,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

async function must(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** Credentials live in the remote URL; never echo them into errors or logs. */
const scrub = (text: string) => text.replace(/\/\/[^/@\s]+@/g, "//***@");

/**
 * Lands a lane with a real `git merge --no-ff` in a throwaway clone, then pushes the merge commit.
 * Real three-way merge with rename detection, unlike the isomorphic-git wire. Needs the `git` binary.
 */
export class SystemGitWire implements GitWire {
  async land(input: LandInput): Promise<WireResult> {
    const dir = mkdtempSync(join(tmpdir(), "hamonn-land-"));
    try {
      const env = {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        GIT_COMMITTER_NAME: input.author.name,
        GIT_COMMITTER_EMAIL: input.author.email,
      };
      await must(dir, ["init", "-q", "-b", "land"]);
      await must(dir, [
        "fetch",
        "-q",
        input.integrationRemote,
        `+refs/heads/${input.integrationBranch}:refs/remotes/int/target`,
      ]);
      await must(dir, [
        "fetch",
        "-q",
        input.laneRemote,
        `+refs/heads/${input.laneBranch}:refs/remotes/lane/source`,
      ]);
      await must(dir, ["checkout", "-q", "-B", "land", "refs/remotes/int/target"]);
      const merge = await git(
        dir,
        ["merge", "--no-ff", "-m", input.message, "refs/remotes/lane/source"],
        env,
      );
      if (merge.code !== 0) {
        const unmerged = (await git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout;
        const files = unmerged.split("\0").filter(Boolean).sort();
        if (files.length > 0) return { kind: "conflict", files };
        return { kind: "error", message: scrub(merge.stderr.trim() || merge.stdout.trim()) };
      }
      const sha = (await must(dir, ["rev-parse", "HEAD"])).trim();
      await must(dir, ["push", "-q", input.integrationRemote, `HEAD:refs/heads/${input.integrationBranch}`]);
      return { kind: "clean", sha };
    } catch (e) {
      return { kind: "error", message: scrub(e instanceof Error ? e.message : String(e)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async isAncestor(input: AncestorInput): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), "hamonn-proof-"));
    try {
      await must(dir, ["init", "-q", "--bare"]);
      await must(dir, ["fetch", "-q", input.remote, `+refs/heads/${input.branch}:refs/heads/proof`]);
      // An ancestor the integration history has never seen cannot be reachable from it.
      const known = await git(dir, ["cat-file", "-e", `${input.ancestor}^{commit}`]);
      if (known.code !== 0) return false;
      const r = await git(dir, ["merge-base", "--is-ancestor", input.ancestor, input.descendant]);
      if (r.code === 0) return true;
      if (r.code === 1) return false;
      throw new Error(scrub(r.stderr.trim()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
