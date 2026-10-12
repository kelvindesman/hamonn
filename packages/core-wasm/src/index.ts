import { call as wasmCall, initSync } from "../pkg/hamonn_core.js";
import type * as T from "./types.ts";

export type * from "./types.ts";

export type KernelErrorCode =
  | "INVALID_TRANSITION"
  | "INVALID_INPUT"
  | "WRONG_STATE"
  | "NOT_FOUND"
  | "UNKNOWN_FUNCTION"
  | "JSON";

/** A decision the kernel refused. `code` is stable and machine-readable. */
export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "KernelError";
  }
}

const ERROR_RE = /^([A-Z_]+): ([\s\S]*)$/;

function toKernelError(e: unknown): KernelError {
  const m = ERROR_RE.exec(e instanceof Error ? e.message : String(e));
  return m ? new KernelError(m[1] as KernelErrorCode, m[2] ?? "") : new KernelError("JSON", String(e));
}

/** Raw JSON-in/JSON-out call. Throws `KernelError`. */
export function invoke<O>(name: string, input: unknown): O {
  try {
    return JSON.parse(wasmCall(name, JSON.stringify(input))) as O;
  } catch (e) {
    throw toKernelError(e);
  }
}

export interface Kernel {
  transition(from: T.LaneState, to: T.LaneState): T.LaneState;
  planOpen(req: T.OpenRequest, openLanes: T.LaneSummary[]): T.OpenPlan;
  applyPush(lane: T.Lane, push: T.PushFacts, project: T.ProjectPolicy): T.Lane;
  evaluate(lane: T.Lane, checks: T.CheckResult[], project: T.ProjectPolicy): T.Readiness;
  settle(lane: T.Lane, readiness: T.Readiness, now: number): T.Lane;
  sign(lane: T.Lane, by: string, now: number): T.Lane;
  archive(lane: T.Lane, now: number): T.Lane;
  canEnqueue(lane: T.Lane): true;
  planLand(lane: T.Lane, project: T.ProjectPolicy, now: number): T.LandPlan;
  applyLandResult(lane: T.Lane, result: T.WireResult, proof: T.Proof | undefined, now: number): T.Lane;
  pickWinner(task: T.Task, lanes: T.Lane[], winner: T.LaneId): T.PickPlan;
  queueOrder(queue: T.QueueEntry[]): T.LaneId[];
  nextInQueue(queue: T.QueueEntry[]): T.LaneId | null;
  queuePosition(queue: T.QueueEntry[], laneId: T.LaneId): number | null;
  claimsOverlap(a: string[], b: string[]): boolean;
  drift(touched: string[], claims: string[]): string[];
  matches(path: string, glob: string): boolean;
  parseLedger(files: { intent?: string; handoff?: string; evidence?: string }): T.LedgerStatus;
  compare(lanes: T.Lane[], checks: T.CheckResult[]): T.CandidateRow[];
}

/** A compiled kernel: a `WebAssembly.Module` (Workers) or raw bytes (Node, tests). */
export type KernelSource = WebAssembly.Module | BufferSource;

/**
 * Instantiate the kernel. Synchronous and idempotent: the wasm is initialised once per isolate.
 * In a Worker: `import wasm from "@hamonn/core/wasm"; const kernel = createKernel(wasm);`
 */
export function createKernel(source: KernelSource): Kernel {
  initSync({ module: source });
  return {
    transition: (from, to) => invoke("transition", { from, to }),
    planOpen: (req, openLanes) => invoke("planOpen", { req, openLanes }),
    applyPush: (lane, push, project) => invoke("applyPush", { lane, push, project }),
    evaluate: (lane, checks, project) => invoke("evaluate", { lane, checks, project }),
    settle: (lane, readiness, now) => invoke("settle", { lane, readiness, now }),
    sign: (lane, by, now) => invoke("sign", { lane, by, now }),
    archive: (lane, now) => invoke("archive", { lane, now }),
    canEnqueue: (lane) => invoke("canEnqueue", { lane }),
    planLand: (lane, project, now) => invoke("planLand", { lane, project, now }),
    applyLandResult: (lane, result, proof, now) => invoke("applyLandResult", { lane, result, proof, now }),
    pickWinner: (task, lanes, winner) => invoke("pickWinner", { task, lanes, winner }),
    queueOrder: (queue) => invoke("queueOrder", { queue }),
    nextInQueue: (queue) => invoke("nextInQueue", { queue }),
    queuePosition: (queue, laneId) => invoke("queuePosition", { queue, laneId }),
    claimsOverlap: (a, b) => invoke("claimsOverlap", { a, b }),
    drift: (touched, claims) => invoke("drift", { touched, claims }),
    matches: (path, glob) => invoke("matches", { path, glob }),
    parseLedger: (files) => invoke("parseLedger", files),
    compare: (lanes, checks) => invoke("compare", { lanes, checks }),
  };
}
