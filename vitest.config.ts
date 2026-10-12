import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Workers import the kernel as a compiled WebAssembly.Module; Node tests feed raw bytes instead.
    alias: {
      "@hamonn/core/hamonn_core_bg.wasm": fileURLToPath(
        new URL("./apps/worker/test/wasm-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.{ts,tsx}", "apps/**/test/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/test/workerd/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/shell/src/**"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
