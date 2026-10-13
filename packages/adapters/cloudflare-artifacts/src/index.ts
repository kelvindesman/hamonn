import type { RepoRef } from "@hamonn/core";
import type { GitHost, Token } from "@hamonn/shell";

/**
 * Structural subset of the `Artifacts` Workers binding (see `wrangler types`) that this adapter
 * uses. Declared locally so the adapter compiles and is testable without Workers types, and so a
 * fake can stand in for the binding.
 */
export interface ArtifactsCommit {
  hash?: string;
  oid?: string;
  sha?: string;
  tree?: string;
  parents?: string[];
}
export interface ArtifactsTreeEntry {
  name: string;
  type?: string;
  mode?: string | number;
  hash?: string;
  oid?: string;
  sha?: string;
}
export interface ArtifactsTokenResult {
  id?: string;
  plaintext: string;
  expiresAt?: string | number | Date;
}
export interface ArtifactsRepoHandle {
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<{
    name: string;
    remote: string;
    defaultBranch?: string;
    token?: string;
  }>;
  info(): Promise<{ name: string; remote: string } | null>;
  createToken(scope: "read" | "write", ttlSec: number): Promise<ArtifactsTokenResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommit[]>;
  readCommit(hash: string): Promise<ArtifactsCommit | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
  [Symbol.dispose]?: () => void;
}
export interface ArtifactsBinding {
  get(name: string): Promise<ArtifactsRepoHandle>;
  /** Namespace-level create; returns the git remote and an initial write token. */
  create?(
    name: string,
    opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string },
  ): Promise<{ name: string; remote: string; defaultBranch?: string; token?: string }>;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_LOG = 1000;

const hashOf = (o: { hash?: string; oid?: string; sha?: string }): string =>
  (o.hash ?? o.oid ?? o.sha) as string;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
/** Directory entries are `type: "tree"`; otherwise fall back to the unix mode (octal string or number). */
function isTree(e: ArtifactsTreeEntry): boolean {
  if (e.type === "tree" || e.type === "dir") return true;
  if (e.type) return false;
  const mode = typeof e.mode === "number" ? e.mode : Number.parseInt(String(e.mode ?? ""), 8);
  return (mode & S_IFMT) === S_IFDIR;
}

function toUnixSeconds(value: unknown, plaintext: string, fallback: number): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  const m = /[?&]expires=(\d+)/.exec(plaintext);
  return m ? Number(m[1]) : fallback;
}

/**
 * `GitHost` over Cloudflare Artifacts. Control-plane verbs go through the Workers binding;
 * landing itself happens over git smart-HTTP with the credentials minted here.
 *
 * Artifacts has no commit/merge API, so `changedPaths` walks trees with `readTree` and
 * `mergeBase` only knows first-parent history (`log`).
 */
export class ArtifactsHost implements GitHost {
  readonly kind = "cloudflare-artifacts" as const;

  constructor(
    private artifacts: ArtifactsBinding,
    private now: () => number = () => Date.now(),
  ) {}

  private async with<T>(repo: RepoRef, fn: (h: ArtifactsRepoHandle) => Promise<T>): Promise<T> {
    const handle = await this.artifacts.get(repo.name);
    try {
      return await fn(handle);
    } finally {
      handle[Symbol.dispose]?.();
    }
  }

  async fork(src: RepoRef, name: string): Promise<RepoRef> {
    const forked = await this.with(src, (h) => h.fork(name, { defaultBranchOnly: false }));
    return { name: forked.name, remote: forked.remote };
  }

  async mintToken(repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token> {
    const t = await this.with(repo, (h) => h.createToken(scope, ttlSec));
    return {
      id: t.id ?? t.plaintext,
      // Git auth is Basic `x:<secret>`; the `?expires=` suffix is metadata, not part of the secret.
      secret: t.plaintext.replace(/\?expires=\d+$/, ""),
      expiresAt: toUnixSeconds(t.expiresAt, t.plaintext, Math.floor(this.now() / 1000) + ttlSec),
    };
  }

  async revokeToken(repo: RepoRef, tokenId: string): Promise<void> {
    await this.with(repo, (h) => h.revokeToken(tokenId));
  }

  async headSha(repo: RepoRef, ref: string): Promise<string | null> {
    return this.with(repo, async (h) => {
      if (SHA_RE.test(ref)) return (await h.readCommit(ref)) ? ref : null;
      const [head] = await h.log({ ref, limit: 1 });
      return head ? hashOf(head) : null;
    });
  }

  async readFile(repo: RepoRef, ref: string, path: string): Promise<string | null> {
    const blob = await this.with(repo, (h) => h.readFile({ ref, path }));
    return blob ? blob.text() : null;
  }

  async changedPaths(repo: RepoRef, before: string | null, after: string): Promise<string[]> {
    return this.with(repo, async (h) => {
      const treeOf = async (sha: string | null): Promise<string | null> => {
        if (!sha) return null;
        const c = await h.readCommit(sha);
        if (!c?.tree) throw new Error(`commit ${sha} not found in ${repo.name}`);
        return c.tree;
      };
      const cache = new Map<string, Promise<ArtifactsTreeEntry[]>>();
      const entries = (hash: string | null): Promise<ArtifactsTreeEntry[]> => {
        if (!hash) return Promise.resolve([]);
        let p = cache.get(hash);
        if (!p) {
          p = h.readTree(hash).then((e) => e ?? []);
          cache.set(hash, p);
        }
        return p;
      };
      const out = new Set<string>();
      const collect = async (hash: string, prefix: string) => {
        for (const e of await entries(hash)) {
          if (isTree(e)) await collect(hashOf(e), `${prefix}${e.name}/`);
          else out.add(`${prefix}${e.name}`);
        }
      };
      const diff = async (a: string | null, b: string | null, prefix: string): Promise<void> => {
        if (a === b) return;
        const [ea, eb] = await Promise.all([entries(a), entries(b)]);
        const byA = new Map(ea.map((e) => [e.name, e]));
        const byB = new Map(eb.map((e) => [e.name, e]));
        for (const name of new Set([...byA.keys(), ...byB.keys()])) {
          const x = byA.get(name);
          const y = byB.get(name);
          const path = `${prefix}${name}`;
          if (x && y && hashOf(x) === hashOf(y) && isTree(x) === isTree(y)) continue;
          if (x && isTree(x) && y && isTree(y)) {
            await diff(hashOf(x), hashOf(y), `${path}/`);
            continue;
          }
          // file added/changed/removed, or a file<->directory swap: enumerate both sides
          if (x) isTree(x) ? await collect(hashOf(x), `${path}/`) : out.add(path);
          if (y) isTree(y) ? await collect(hashOf(y), `${path}/`) : out.add(path);
        }
      };
      await diff(await treeOf(before), await treeOf(after), "");
      return [...out].sort();
    });
  }

  async mergeBase(repo: RepoRef, a: string, b: string): Promise<string | null> {
    return this.with(repo, async (h) => {
      const chain = async (tip: string) => (await h.log({ ref: tip, limit: MAX_LOG })).map(hashOf);
      const [fromA, fromB] = await Promise.all([chain(a), chain(b)]);
      if (fromA.includes(b)) return b;
      if (fromB.includes(a)) return a;
      const seen = new Set(fromB);
      return fromA.find((s) => seen.has(s)) ?? null;
    });
  }

  remoteUrl(repo: RepoRef, token?: Token): string {
    if (!token) return repo.remote;
    return repo.remote.replace(/^https:\/\//, `https://x:${token.secret}@`);
  }
}
