import type { WireResult } from "@hamonn/core";
import type { AncestorInput, GitWire, LandInput } from "../../src/index.ts";
import type { FakeHost } from "./fake-host.ts";

const repoOf = (url: string) => url.slice(url.lastIndexOf("@") + 1).replace("fake://", "");

/**
 * Scriptable `GitWire`. By default it performs a trivially "clean" merge on the FakeHost:
 * a merge commit whose parents are (integration head, lane head).
 */
export class FakeWire implements GitWire {
  script: (WireResult | Error)[] = [];
  lands: LandInput[] = [];
  /** Force `isAncestor` regardless of the commit graph. */
  ancestorOverride: boolean | Error | undefined;

  constructor(private host: FakeHost) {}

  async land(input: LandInput): Promise<WireResult> {
    this.lands.push(input);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    const intRepo = repoOf(input.integrationRemote);
    const laneRepo = repoOf(input.laneRemote);
    const intHeads = this.host.heads.get(intRepo);
    const laneHead = this.host.heads.get(laneRepo)?.get(input.laneBranch);
    const intHead = intHeads?.get(input.integrationBranch);
    if (!intHeads || !laneHead || !intHead) return { kind: "error", message: "fake wire: missing refs" };
    const merged = { ...(this.host.trees.get(laneHead) ?? {}) };
    const sha = this.host.commit(intRepo, input.integrationBranch, merged, [intHead, laneHead]);
    return { kind: "clean", sha };
  }

  async isAncestor(input: AncestorInput): Promise<boolean> {
    if (this.ancestorOverride instanceof Error) throw this.ancestorOverride;
    if (this.ancestorOverride !== undefined) return this.ancestorOverride;
    return this.host.reachable(input.ancestor, input.descendant);
  }
}
