import type { RepoRef } from "@hamonn/core";
import type { EventSink, GitHost, Token } from "../../src/index.ts";

type Tree = Record<string, string>;

/** Deterministic in-memory `GitHost` with a tiny commit graph. No network, no clocks. */
export class FakeHost implements GitHost {
  readonly kind = "local-fs" as const;
  heads = new Map<string, Map<string, string>>();
  trees = new Map<string, Tree>();
  parents = new Map<string, string[]>();
  revoked: string[] = [];
  minted: { repo: string; scope: string; ttl: number; id: string }[] = [];
  failRevoke = false;
  private seq = 0;
  sinks: EventSink[] = [];

  constructor() {
    // expose `mergeBase` only when a test opts in, so both code paths in the shell are exercised
    Object.defineProperty(this, "mergeBase", {
      configurable: true,
      get: () =>
        this.mergeBaseImpl
          ? async (_r: RepoRef, a: string, b: string) => this.mergeBaseImpl?.(a, b) ?? null
          : undefined,
    });
  }

  repo(name: string): RepoRef {
    return { name, remote: `fake://${name}` };
  }

  /** Create a repo with an initial commit on `main`. */
  init(name: string, files: Tree = { "README.md": "hi" }): RepoRef {
    this.heads.set(name, new Map());
    this.commit(name, "main", files, []);
    return this.repo(name);
  }

  /** Commit `files` (merged over the current tree of `ref`) and move the ref. */
  commit(name: string, ref: string, files: Tree, parents?: string[]): string {
    const heads = this.heads.get(name);
    if (!heads) throw new Error(`no repo ${name}`);
    const parent = heads.get(ref);
    const base = parent ? (this.trees.get(parent) ?? {}) : {};
    const sha = `c${++this.seq}`.padEnd(8, "0");
    this.trees.set(sha, { ...base, ...files });
    this.parents.set(sha, parents ?? (parent ? [parent] : []));
    heads.set(ref, sha);
    return sha;
  }

  async fork(src: RepoRef, name: string): Promise<RepoRef> {
    const heads = this.heads.get(src.name);
    if (!heads) throw new Error(`no repo ${src.name}`);
    this.heads.set(name, new Map(heads));
    return this.repo(name);
  }

  async mintToken(repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token> {
    const id = `tok${++this.seq}`;
    this.minted.push({ repo: repo.name, scope, ttl: ttlSec, id });
    return { id, secret: `secret-${id}`, expiresAt: 1000 + ttlSec };
  }

  async revokeToken(_repo: RepoRef, tokenId: string): Promise<void> {
    if (this.failRevoke) throw new Error("revoke failed");
    this.revoked.push(tokenId);
  }

  async headSha(repo: RepoRef, ref: string): Promise<string | null> {
    return this.heads.get(repo.name)?.get(ref) ?? null;
  }

  async readFile(_repo: RepoRef, ref: string, path: string): Promise<string | null> {
    return this.trees.get(ref)?.[path] ?? null;
  }

  async changedPaths(_repo: RepoRef, before: string | null, after: string): Promise<string[]> {
    const a = before ? (this.trees.get(before) ?? {}) : {};
    const b = this.trees.get(after) ?? {};
    const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...paths].filter((p) => a[p] !== b[p]).sort();
  }

  /** Set to enable the optional `mergeBase` verb. */
  mergeBaseImpl?: (a: string, b: string) => string | null;
  mergeBase?(repo: RepoRef, a: string, b: string): Promise<string | null>;

  async subscribe(_repo: RepoRef, sink: EventSink): Promise<void> {
    this.sinks.push(sink);
  }

  remoteUrl(repo: RepoRef, token?: Token): string {
    return token ? `fake://x:${token.secret}@${repo.name}` : `fake://${repo.name}`;
  }

  /** Is `a` reachable from `b` (inclusive)? */
  reachable(a: string, b: string): boolean {
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const s = stack.pop() as string;
      if (s === a) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.parents.get(s) ?? []));
    }
    return false;
  }
}
