// Builds the Rust kernel to wasm (wasm-pack) and then shrinks it (scripts/optimize-wasm.mjs).
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
execFileSync(
  "wasm-pack",
  [
    "build",
    "crates/hamonn-core",
    "--release",
    "--target",
    "web",
    "--out-dir",
    "../../packages/core-wasm/pkg",
    "--out-name",
    "hamonn_core",
  ],
  { cwd: root, stdio: "inherit" },
);
execFileSync(process.execPath, [new URL("./optimize-wasm.mjs", import.meta.url).pathname], {
  stdio: "inherit",
});
