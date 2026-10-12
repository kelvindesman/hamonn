import type { WireResult } from "@hamonn/core";
import type { AncestorInput, GitWire, LandInput } from "@hamonn/shell";
import git from "isomorphic-git";
import { MemoryFS } from "./memory-fs.ts";

export { FsError, MemoryFS, normalize } from "./memory-fs.ts";

/** The `http` client isomorphic-git should use: `isomorphic-git/http/web` on Workers. */
export type GitHttp = Parameters<typeof git.clone>[0]["http"];

export interface IsomorphicWireOptions {
  http: GitHttp;
  /** Abort a landing whose in-memory checkout grows past this many bytes (default 64 MiB). */
  maxBytes?: number;
  /** Clock override for deterministic commits in tests. */
  now?: () => number;
}

const DIR = "/work";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Credentials sit in the URL (`https://x:<secret>@host/...`); isomorphic-git lifts them into headers. */
const scrub = (text: string) => text.replace(/\/\/[^/@\s]+@/g, "//***@");

function message(e: unknown): string {
  return scrub(e instanceof Error ? e.message : String(e));
}

/**
 * Lands a lane with isomorphic-git in an in-memory checkout. Runs anywhere `fetch` does (Workers).
 * Known limits, reported as `error` rather than guessed at: no rename detection, a single merge
 * base only (criss-cross histories fail), and the whole checkout must fit in memory.
 */
export class IsomorphicWire implements GitWire {
  private maxBytes: number;

  constructor(private opts: IsomorphicWireOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private ts(): number {
    return Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
  }

  async land(input: LandInput): Promise<WireResult> {
    const fs = new MemoryFS(this.opts.now);
    const { http } = this.opts;
    const author = { ...input.author, timestamp: this.ts(), timezoneOffset: 0 };
    try {
      await git.clone({
        fs,
        http,
        dir: DIR,
        url: input.integrationRemote,
        ref: input.integrationBranch,
        remote: "origin",
        singleBranch: true,
        noTags: true,
      });
      await git.addRemote({ fs, dir: DIR, remote: "lane", url: input.laneRemote });
      await git.fetch({
        fs,
        http,
        dir: DIR,
        remote: "lane",
        ref: input.laneBranch,
        singleBranch: true,
        tags: false,
      });
      if (fs.bytes > this.maxBytes) {
        return {
          kind: "error",
          message: `checkout is ${fs.bytes} bytes, over the ${this.maxBytes}-byte landing limit`,
        };
      }
      try {
        await git.merge({
          fs,
          dir: DIR,
          ours: input.integrationBranch,
          theirs: `refs/remotes/lane/${input.laneBranch}`,
          fastForward: false,
          abortOnConflict: true,
          message: input.message,
          author,
          committer: author,
        });
      } catch (e) {
        const conflict = e as { code?: string; data?: { filepaths?: string[] } };
        if (conflict.code === "MergeConflictError") {
          return { kind: "conflict", files: [...new Set(conflict.data?.filepaths ?? [])].sort() };
        }
        throw e;
      }
      const sha = await git.resolveRef({ fs, dir: DIR, ref: input.integrationBranch });
      await git.push({
        fs,
        http,
        dir: DIR,
        remote: "origin",
        ref: input.integrationBranch,
        remoteRef: input.integrationBranch,
      });
      return { kind: "clean", sha };
    } catch (e) {
      return { kind: "error", message: message(e) };
    }
  }

  async isAncestor(input: AncestorInput): Promise<boolean> {
    const fs = new MemoryFS(this.opts.now);
    await git.clone({
      fs,
      http: this.opts.http,
      dir: DIR,
      url: input.remote,
      ref: input.branch,
      singleBranch: true,
      noTags: true,
      noCheckout: true,
    });
    try {
      await git.readCommit({ fs, dir: DIR, oid: input.ancestor });
    } catch {
      return false; // an ancestor the integration history has never seen cannot be reachable from it
    }
    return git.isDescendent({ fs, dir: DIR, oid: input.descendant, ancestor: input.ancestor, depth: -1 });
  }
}
