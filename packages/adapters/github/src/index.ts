import type { RepoRef } from "@hamonn/core";
import { type GitHost, HamonnError, type PushEvent, type Token, type WebhookNormalizer } from "@hamonn/shell";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubTokenProvider {
  mint(repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token>;
  revoke(repo: RepoRef, tokenId: string): Promise<void>;
}

export interface GithubOptions {
  /**
   * Credential used for the REST API *and* (by default) handed to agents as the git credential.
   * A PAT/fine-grained token is "passthrough": it is NOT scoped to one fork. See `tokens`.
   */
  token: string;
  apiBase?: string;
  webBase?: string;
  /** Fork lanes into this organization instead of the token owner's account. */
  forkOrg?: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Override credential minting, e.g. a GitHub App installation token restricted to one fork
   * (`POST /app/installations/{id}/access_tokens` with `repositories` + `permissions`). Without it,
   * agents receive `token` itself, which is weaker isolation; documented in docs/adapters.md.
   */
  tokens?: GithubTokenProvider;
}

const FORK_POLL_ATTEMPTS = 20;
const MAX_COMPARE_PAGES = 30;

/** `owner/repo` -> `{ name, remote }`. */
export function githubRepo(fullName: string, webBase = "https://github.com"): RepoRef {
  return { name: fullName, remote: `${webBase}/${fullName}.git` };
}

export class GithubHost implements GitHost {
  readonly kind = "github" as const;
  private api: string;
  private web: string;
  private fetchImpl: Fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(private opts: GithubOptions) {
    this.api = opts.apiBase ?? "https://api.github.com";
    this.web = opts.webBase ?? "https://github.com";
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  private async call(path: string, init: RequestInit & { accept?: string } = {}): Promise<Response> {
    const { accept, ...rest } = init;
    return this.fetchImpl(`${this.api}${path}`, {
      ...rest,
      headers: {
        accept: accept ?? "application/vnd.github+json",
        authorization: `Bearer ${this.opts.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "hamonn",
        ...(rest.body ? { "content-type": "application/json" } : {}),
      },
    });
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.call(path, init);
    if (!res.ok) throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async fork(src: RepoRef, name: string): Promise<RepoRef> {
    const body: Record<string, unknown> = { name, default_branch_only: false };
    if (this.opts.forkOrg) body.organization = this.opts.forkOrg;
    const forked = await this.json<{ full_name: string }>(`/repos/${src.name}/forks`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Forking is asynchronous: wait until the new repo answers.
    for (let i = 0; i < FORK_POLL_ATTEMPTS; i++) {
      const probe = await this.call(`/repos/${forked.full_name}/commits?per_page=1`);
      if (probe.ok) return githubRepo(forked.full_name, this.web);
      await this.sleep(500);
    }
    throw new Error(`fork ${forked.full_name} did not become ready`);
  }

  async mintToken(repo: RepoRef, scope: "read" | "write", ttlSec: number): Promise<Token> {
    if (this.opts.tokens) return this.opts.tokens.mint(repo, scope, ttlSec);
    // Passthrough: same credential for everyone, so `id` is derived and revocation is a no-op.
    return {
      id: `passthrough-${scope}`,
      secret: this.opts.token,
      expiresAt: Math.floor(this.now() / 1000) + ttlSec,
    };
  }

  async revokeToken(repo: RepoRef, tokenId: string): Promise<void> {
    await this.opts.tokens?.revoke(repo, tokenId);
  }

  async headSha(repo: RepoRef, ref: string): Promise<string | null> {
    const res = await this.call(`/repos/${repo.name}/commits/${encodeURIComponent(ref)}`, {
      accept: "application/vnd.github.sha",
    });
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new Error(`GitHub headSha ${repo.name}@${ref} -> ${res.status}`);
    return (await res.text()).trim();
  }

  async readFile(repo: RepoRef, ref: string, path: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.call(`/repos/${repo.name}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
      accept: "application/vnd.github.raw+json",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub readFile ${path}@${ref} -> ${res.status}`);
    return res.text();
  }

  async changedPaths(repo: RepoRef, before: string | null, after: string): Promise<string[]> {
    const out = new Set<string>();
    if (before === null) {
      const tree = await this.json<{ tree: { path: string; type: string }[]; truncated?: boolean }>(
        `/repos/${repo.name}/git/trees/${encodeURIComponent(after)}?recursive=1`,
      );
      if (tree.truncated) throw new Error(`tree of ${after} is too large to list through the API`);
      for (const e of tree.tree) if (e.type === "blob") out.add(e.path);
      return [...out].sort();
    }
    for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
      const cmp = await this.json<{ files?: { filename: string; previous_filename?: string }[] }>(
        `/repos/${repo.name}/compare/${encodeURIComponent(before)}...${encodeURIComponent(after)}?per_page=100&page=${page}`,
      );
      const files = cmp.files ?? [];
      for (const f of files) {
        out.add(f.filename);
        if (f.previous_filename) out.add(f.previous_filename);
      }
      if (files.length < 100) break;
    }
    return [...out].sort();
  }

  async mergeBase(repo: RepoRef, a: string, b: string): Promise<string | null> {
    const res = await this.call(
      `/repos/${repo.name}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}?per_page=1`,
    );
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new Error(`GitHub mergeBase -> ${res.status}`);
    return ((await res.json()) as { merge_base_commit?: { sha?: string } }).merge_base_commit?.sha ?? null;
  }

  remoteUrl(repo: RepoRef, token?: Token): string {
    return token
      ? repo.remote.replace(/^https:\/\//, `https://x-access-token:${token.secret}@`)
      : repo.remote;
  }
}

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time hex compare. */
function safeHexEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function githubSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))}`;
}

const NULL_SHA = /^0+$/;

/** `/hooks/github`: verify `X-Hub-Signature-256`, keep only branch pushes. */
export const normalizeGithubWebhook: WebhookNormalizer = async ({ body, headers, secret }) => {
  if (!secret) throw new HamonnError("UNAUTHORIZED", "HAMONN_HOOK_SECRET is not configured");
  const given = headers.get("x-hub-signature-256") ?? "";
  if (!safeHexEqual(given, await githubSignature(secret, body))) {
    throw new HamonnError("UNAUTHORIZED", "bad webhook signature");
  }
  if (headers.get("x-github-event") !== "push") return null;
  const p = JSON.parse(body) as {
    ref?: string;
    before?: string;
    after?: string;
    repository?: { full_name?: string };
  };
  if (!p.repository?.full_name || !p.after || NULL_SHA.test(p.after)) return null;
  const event: PushEvent = { repoName: p.repository.full_name, ref: p.ref, before: p.before, after: p.after };
  return event;
};
