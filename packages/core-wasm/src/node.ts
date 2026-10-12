import { readFileSync } from "node:fs";
import { createKernel, type Kernel } from "./index.ts";

/** Load the kernel from the built wasm file (Node servers, CLI, tests). */
export function loadKernel(): Kernel {
  const bytes = readFileSync(new URL("../pkg/hamonn_core_bg.wasm", import.meta.url));
  return createKernel(bytes);
}
