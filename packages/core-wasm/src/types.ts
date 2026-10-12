// Hand-written mirror of the serde types in crates/hamonn-core/src/domain.rs (+ lifecycle.rs,
// evaluate.rs). The round-trip test replays the Rust vectors through the wasm build, so a
// drift between the two sides fails CI.

export type LaneId = number;

export type LaneState = "OPEN" | "PUSHED" | "READY" | "LANDING" | "LANDED" | "BEHIND" | "ARCHIVED" | "FAILED";
export type LaneMode = "fork" | "branch";
export type MergePreview = "clean" | "conflict" | "unknown";
export type CheckStatus = "pass" | "fail" | "pending";

export interface RepoRef {
  name: string;
  remote: string;
}

export interface LedgerStatus {
  intent: boolean;
  handoff: boolean;
  evidence: boolean;
  handoffLines?: number;
  handoffTooLong: boolean;
}

export interface ProjectPolicy {
  name: string;
  integrationBranch: string;
  laneMode: LaneMode;
  gatedPaths: string[];
  requiredChecks: string[];
}

export interface Task {
  id: string;
  projectName: string;
  title: string;
  winnerLane?: LaneId;
}

export interface Lane {
  id: LaneId;
  taskId: string;
  agent: string;
  intent: string;
  repo: RepoRef;
  branch: string;
  state: LaneState;
  head?: string;
  base: string;
  claims: string[];
  touched: string[];
  drift: string[];
  overlaps: LaneId[];
  gateRequired: boolean;
  gateSignedBy?: string;
  landedSha?: string;
  conflictFiles?: string[];
  mergePreview?: MergePreview;
  ledger: LedgerStatus;
  allowDrift: boolean;
  failure?: string;
  tokenId?: string;
  tokenExpires?: number;
  openedAt: number;
  updatedAt: number;
}

export interface CheckResult {
  laneId: LaneId;
  name: string;
  status: CheckStatus;
  url?: string;
  head?: string;
  at: number;
}

export interface QueueEntry {
  laneId: LaneId;
  enqueuedAt: number;
}

export type Reason =
  | { code: "WRONG_STATE"; state: LaneState }
  | { code: "NO_PUSH" }
  | { code: "CHECK_MISSING"; name: string }
  | { code: "CHECK_FAILING"; name: string }
  | { code: "CHECK_PENDING"; name: string }
  | { code: "INTENT_MISSING" }
  | { code: "HANDOFF_MISSING" }
  | { code: "DRIFT"; paths: string[] }
  | { code: "GATE_UNSIGNED" };

export interface Readiness {
  ready: boolean;
  reasons: Reason[];
}

export interface OpenRequest {
  project: ProjectPolicy;
  laneId: LaneId;
  taskId: string;
  agent: string;
  intent: string;
  claims: string[];
  base: string;
  now: number;
}

export interface LaneSummary {
  id: LaneId;
  taskId: string;
  state: LaneState;
  claims: string[];
}

export interface OpenPlan {
  lane: Lane;
  forkName?: string;
  branch: string;
  overlaps: LaneId[];
  hint?: string;
  tokenTtlSec: number;
}

export interface PushFacts {
  head: string;
  touched: string[];
  ledger: LedgerStatus;
  now: number;
}

export interface LandPlan {
  lane: Lane;
  integrationBranch: string;
  laneBranch: string;
  head: string;
  message: string;
  tokenTtlSec: number;
}

export type WireResult =
  | { kind: "clean"; sha: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "error"; message: string };

export interface Proof {
  integrationHead: string;
  isAncestor: boolean;
}

export interface PickPlan {
  task: Task;
  winner: LaneId;
  archive: LaneId[];
}

export interface CandidateRow {
  laneId: LaneId;
  agent: string;
  state: LaneState;
  touchedCount: number;
  driftCount: number;
  claimsKept: boolean;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  mergePreview?: MergePreview;
  ledgerOk: boolean;
  score: number;
}
