/**
 * Minimal in-memory POSIX-ish filesystem with the `fs.promises` surface isomorphic-git needs.
 * Everything lives in the isolate's heap; there is no persistence by design.
 */

interface FileNode {
  type: "file";
  data: Uint8Array;
  mode: number;
  ino: number;
  mtimeMs: number;
}
interface DirNode {
  type: "dir";
  ino: number;
  mtimeMs: number;
}
interface LinkNode {
  type: "symlink";
  target: string;
  ino: number;
  mtimeMs: number;
}
type Node = FileNode | DirNode | LinkNode;

export class FsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL",
    path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = "FsError";
  }
}

export interface Stats {
  type: "file" | "dir" | "symlink";
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: 1;
  gid: 1;
  dev: 1;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const parentOf = (path: string) => normalize(path.slice(0, path.lastIndexOf("/")) || "/");

export class MemoryFS {
  private nodes = new Map<string, Node>([["/", { type: "dir", ino: 1, mtimeMs: 0 }]]);
  private nextIno = 2;
  readonly promises: MemoryFS;

  constructor(private clock: () => number = () => Date.now()) {
    this.promises = this;
  }

  /** Total bytes held in files (used to bound landing size). */
  get bytes(): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.type === "file") n += node.data.byteLength;
    return n;
  }

  private get(path: string): Node | undefined {
    return this.nodes.get(normalize(path));
  }

  private requireParentDir(path: string): void {
    const parent = this.nodes.get(parentOf(path));
    if (!parent) throw new FsError("ENOENT", path);
    if (parent.type !== "dir") throw new FsError("ENOTDIR", path);
  }

  async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
    const node = this.get(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type === "dir") throw new FsError("EISDIR", path);
    if (node.type === "symlink") return this.readFile(node.target, options);
    const encoding = typeof options === "string" ? options : options?.encoding;
    return encoding ? decoder.decode(node.data) : node.data.slice();
  }

  async writeFile(
    path: string,
    data: Uint8Array | string,
    options?: string | { mode?: number; encoding?: string },
  ): Promise<void> {
    const p = normalize(path);
    this.requireParentDir(p);
    const existing = this.nodes.get(p);
    if (existing?.type === "dir") throw new FsError("EISDIR", path);
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    const mode = typeof options === "object" && options?.mode ? options.mode : 0o100644;
    this.nodes.set(p, {
      type: "file",
      data: bytes,
      mode,
      ino: existing?.ino ?? this.nextIno++,
      mtimeMs: this.clock(),
    });
  }

  async unlink(path: string): Promise<void> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type === "dir") throw new FsError("EISDIR", path);
    this.nodes.delete(p);
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type !== "dir") throw new FsError("ENOTDIR", path);
    const prefix = p === "/" ? "/" : `${p}/`;
    const names = new Set<string>();
    for (const key of this.nodes.keys()) {
      if (key !== p && key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] as string);
    }
    return [...names].sort();
  }

  async mkdir(path: string): Promise<void> {
    const p = normalize(path);
    if (this.nodes.has(p)) throw new FsError("EEXIST", path);
    this.requireParentDir(p);
    this.nodes.set(p, { type: "dir", ino: this.nextIno++, mtimeMs: this.clock() });
  }

  async rmdir(path: string): Promise<void> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type !== "dir") throw new FsError("ENOTDIR", path);
    if ((await this.readdir(p)).length > 0) throw new FsError("ENOTEMPTY", path);
    this.nodes.delete(p);
  }

  private stats(node: Node): Stats {
    const size =
      node.type === "file" ? node.data.byteLength : node.type === "symlink" ? node.target.length : 0;
    const mode = node.type === "file" ? node.mode : node.type === "dir" ? 0o040000 : 0o120000;
    return {
      type: node.type,
      mode,
      size,
      ino: node.ino,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => node.type === "file",
      isDirectory: () => node.type === "dir",
      isSymbolicLink: () => node.type === "symlink",
    };
  }

  async lstat(path: string): Promise<Stats> {
    const node = this.get(path);
    if (!node) throw new FsError("ENOENT", path);
    return this.stats(node);
  }

  async stat(path: string): Promise<Stats> {
    const node = this.get(path);
    if (!node) throw new FsError("ENOENT", path);
    return node.type === "symlink" ? this.stat(node.target) : this.stats(node);
  }

  async readlink(path: string): Promise<string> {
    const node = this.get(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type !== "symlink") throw new FsError("EINVAL", path);
    return node.target;
  }

  async symlink(target: string, path: string): Promise<void> {
    const p = normalize(path);
    if (this.nodes.has(p)) throw new FsError("EEXIST", path);
    this.requireParentDir(p);
    this.nodes.set(p, { type: "symlink", target, ino: this.nextIno++, mtimeMs: this.clock() });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = this.get(path);
    if (!node) throw new FsError("ENOENT", path);
    if (node.type === "file") node.mode = mode;
  }
}
