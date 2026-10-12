import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RepoRef } from "@hamonn/core";
import type { GitHost, Token } from "@hamonn/shell";

const run = promisify(execFile);

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
}

async function must(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const r = await git(args, opts);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The well-known id of git's empty tree; always resolvable, even if no repo stores it. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const IDENT = {
  GIT_AUTHOR_NAME: "hamonn",
  GIT_AUTHOR_EMAIL: "hamonn@users.noreply.local",
  GIT_COMMITTER_NAME: "hamonn",
  GIT_COMMITTER_EMAIL: "hamonn@users.noreply.local",
};

/**
 * `GitHost` over bare repositories at `<root>/<name>.git`. There is no auth layer on a local
 * filesystem, so tokens are issued (with real expiry bookkeeping) but not enforced; this adapter
 * exists for development, tests and single-machine self-hosting.
 */
export class LocalFsHost implements GitHost {
  readonly kind = "local-fs" as const;
  private revoked = new Set<string>();

  constructor(
    readonly root: string,
    private now: () => number = () => Date.now(),
  ) {
    mkdirSync(root, { recursive: true });
  }

  private path(name: string): string {
    return join(this.root, `${name}.git`);
  }

  /** Create a bare repo whose `main` holds `files` (one root commit). */
  async init(name: string, files: Record<string, string> = { "README.md": "hello\n" }): Promise<RepoRef> {
    const bare = this.path(name);
    await must(["init", "--bare", "-b", "main", bare]);
    await this.commit({ name, remote: bare }, "main", files);
    return { name, remote: bare };
  }

  /** Test/demo helper: commit `files` on top of `ref` (a new ref starts from `main`, else empty). null deletes. */
  async commit(
    repo: RepoRef,
    ref: string,
    files: Record<string, string | null>,
    message = "commit",
  ): Promise<string> {
    const work = mkdtempSync(join(tmpdir(), "hamonn-lfs-"));
    try {
      await must(["init", "-q", "-b", "work", work]);
      const parent = (await this.headSha(repo, ref)) ?? (await this.headSha(repo, "main"));
      if (parent) {
        await must(["fetch", "-q", repo.remote, `refs/heads/${ref}`], { cwd: work }).catch(() =>
          must(["fetch", "-q", repo.remote, parent], { cwd: work }),
        );
        await must(["checkout", "-q", "--detach", parent], { cwd: work });
      }
      for (const [path, content] of Object.entries(files)) {
        const abs = join(work, path);
        if (content === null) {
          rmSync(abs, { force: true });
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      await must(["add", "-A"], { cwd: work });
      await must(["commit", "-q", "--allow-empty", "-m", message], { cwd: work, env: IDENT });
      const sha = (await must(["rev-parse", "HEAD"], { cwd: work })).trim();
      await must(["push", "-q", "-f", repo.remote, `HEAD:refs/heads/${ref}`], { cwd: work });
      return sha;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async fork(src: RepoRef, name: string): Promise<RepoRef> {
    const bare = this.path(name);
    await must(["clone", "-q", "--bare", src.remote, bare]);
    return { name, remote: bare };
  }

  async mintToken(_repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token> {
    const id = `${scope}-${randomBytes(6).toString("hex")}`;
    return { id, secret: randomBytes(16).toString("hex"), expiresAt: Math.floor(this.now() / 1000) + ttlSec };
  }

  async revokeToken(_repo: RepoRef, tokenId: string): Promise<void> {
    this.revoked.add(tokenId);
  }

  isRevoked(tokenId: string): boolean {
    return this.revoked.has(tokenId);
  }

  async headSha(repo: RepoRef, ref: string): Promise<string | null> {
    for (const candidate of [`refs/heads/${ref}`, `${ref}^{commit}`]) {
      const r = await git(["--git-dir", repo.remote, "rev-parse", "--verify", "-q", candidate]);
      if (r.ok) return r.stdout.trim();
    }
    return null;
  }

  async readFile(repo: RepoRef, ref: string, path: string): Promise<string | null> {
    const r = await git(["--git-dir", repo.remote, "show", `${ref}:${path}`]);
    return r.ok ? r.stdout : null;
  }

  async changedPaths(repo: RepoRef, before: string | null, after: string): Promise<string[]> {
    const out = await must([
      "--git-dir",
      repo.remote,
      "diff",
      "--name-only",
      "-z",
      before ?? EMPTY_TREE,
      after,
    ]);
    return [...new Set(out.split("\0").filter(Boolean))].sort();
  }

  async mergeBase(repo: RepoRef, a: string, b: string): Promise<string | null> {
    const r = await git(["--git-dir", repo.remote, "merge-base", a, b]);
    return r.ok ? r.stdout.trim() : null;
  }

  remoteUrl(repo: RepoRef): string {
    return repo.remote;
  }
}
