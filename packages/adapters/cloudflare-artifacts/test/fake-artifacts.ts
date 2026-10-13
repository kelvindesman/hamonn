import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type {
  ArtifactsBinding,
  ArtifactsCommit,
  ArtifactsRepoHandle,
  ArtifactsTreeEntry,
} from "../src/index.ts";

/**
 * A stand-in for the Artifacts Workers binding backed by real bare git repositories, so the
 * adapter's tree-walking logic runs against genuine commit/tree objects.
 * Only the control-plane surface is faked; the field names mirror the documented result types.
 */
export class FakeArtifacts implements ArtifactsBinding {
  tokens = new Map<string, { repo: string; scope: string; revoked: boolean }>();
  disposed = 0;
  private seq = 0;
  constructor(
    private root: string,
    private account = "acct",
  ) {}

  private dir(name: string) {
    return join(this.root, `${name}.git`);
  }
  private git(name: string, ...args: string[]) {
    return execFileSync("git", ["--git-dir", this.dir(name), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** The `remote` URL Artifacts would hand out for `name` (we serve it from disk instead). */
  remoteFor(name: string) {
    return `https://${this.account}.artifacts.cloudflare.net/git/default/${name}.git`;
  }

  async get(name: string): Promise<ArtifactsRepoHandle> {
    this.git(name, "rev-parse", "--git-dir"); // throws when the repo does not exist
    const self = this;
    return {
      [Symbol.dispose]() {
        self.disposed++;
      },
      async info() {
        return { name, remote: self.remoteFor(name) };
      },
      async fork(forkName) {
        execFileSync("git", ["clone", "-q", "--bare", self.dir(name), self.dir(forkName)]);
        return {
          name: forkName,
          remote: self.remoteFor(forkName),
          defaultBranch: "main",
          token: "art_v1_x?expires=1",
        };
      },
      async createToken(scope, ttl) {
        const id = `tok${++self.seq}`;
        self.tokens.set(id, { repo: name, scope, revoked: false });
        const expires = Math.floor(Date.now() / 1000) + ttl;
        return {
          id,
          plaintext: `art_v1_${id.padEnd(40, "0")}?expires=${expires}`,
          expiresAt: new Date(expires * 1000).toISOString(),
        };
      },
      async revokeToken(id) {
        const t = self.tokens.get(id);
        if (t) t.revoked = true;
        return Boolean(t);
      },
      async log({ ref = "HEAD", limit = 50 } = {}) {
        try {
          const out = self.git(name, "log", "--first-parent", `-n${limit}`, "--format=%H %T", ref);
          return out
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const [hash, tree] = l.split(" ");
              return { hash, tree } as ArtifactsCommit;
            });
        } catch {
          return [];
        }
      },
      async readCommit(hash) {
        try {
          const tree = self.git(name, "rev-parse", `${hash}^{tree}`).trim();
          return { hash, treeHash: tree };
        } catch {
          return null;
        }
      },
      async readTree(hash) {
        try {
          return self
            .git(name, "ls-tree", hash)
            .split("\n")
            .filter(Boolean)
            .map((l): ArtifactsTreeEntry => {
              const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/.exec(l) as RegExpExecArray;
              return { mode: m[1], type: m[2], hash: m[3], name: m[4] as string };
            });
        } catch {
          return null;
        }
      },
      async readFile({ ref, path }) {
        try {
          return new Blob([self.git(name, "show", `${ref}:${path}`)], { type: "text/plain;charset=utf-8" });
        } catch {
          return null;
        }
      },
    };
  }
}
