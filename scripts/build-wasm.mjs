// Builds the Rust kernel to wasm and shrinks it with binaryen's wasm-opt (from npm, so no GitHub download is needed).
import { execFileSync } from "node:child_process";
import { renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = join(root, "packages/core-wasm/pkg");
const wasm = join(pkg, "hamonn_core_bg.wasm");

execFileSync(
  "wasm-pack",
  ["build", "crates/hamonn-core", "--release", "--target", "web", "--out-dir", "../../packages/core-wasm/pkg", "--out-name", "hamonn_core"],
  { cwd: root, stdio: "inherit" },
);
const before = statSync(wasm).size;
const wasmOpt = join(createRequire(import.meta.url).resolve("binaryen/package.json"), "../bin/wasm-opt");
execFileSync(
  process.execPath,
  [wasmOpt, "-Oz", "--enable-bulk-memory", "--enable-reference-types", "--enable-sign-ext", "--enable-mutable-globals",
   "--enable-nontrapping-float-to-int", "--strip-debug", "--strip-producers", wasm, "-o", `${wasm}.opt`],
  { stdio: "inherit" },
);
renameSync(`${wasm}.opt`, wasm);
console.log(`hamonn_core_bg.wasm: ${before} -> ${statSync(wasm).size} bytes`);
