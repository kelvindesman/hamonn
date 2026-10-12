import { KernelError } from "@hamonn/core";

export type HamonnErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFLICT_CLAIM"
  | "UNKNOWN_HOST"
  | "INTERNAL";

const STATUS: Record<HamonnErrorCode, 400 | 401 | 404 | 409 | 500> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFLICT_CLAIM: 409,
  UNKNOWN_HOST: 404,
  INTERNAL: 500,
};

export class HamonnError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 500;
  constructor(
    readonly code: HamonnErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HamonnError";
    this.status = STATUS[code];
  }
}

/** Translate any thrown value into the error the API reports. */
export function normalizeError(e: unknown): HamonnError {
  if (e instanceof HamonnError) return e;
  if (e instanceof KernelError) {
    const code =
      e.code === "INVALID_INPUT" ? "BAD_REQUEST" : e.code === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT";
    return new HamonnError(code, e.message, { kernel: e.code });
  }
  return new HamonnError("INTERNAL", e instanceof Error ? e.message : String(e));
}
