import { readFileSync } from "node:fs";
import { join } from "node:path";

// Stand-in for wrangler's CompiledWasm import: createKernel accepts raw bytes too.
export default readFileSync(join(import.meta.dirname, "../../../packages/core-wasm/pkg/hamonn_core_bg.wasm"));
