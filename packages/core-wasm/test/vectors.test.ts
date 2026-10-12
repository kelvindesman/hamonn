import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { invoke, KernelError } from "../src/index.ts";
import { loadKernel } from "../src/node.ts";

const dir = new URL("../../../crates/hamonn-core/tests/vectors/", import.meta.url);
const kernel = loadKernel();

interface Vector {
  fn: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

describe("kernel vectors (Rust → wasm → TS)", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  it("has vectors", () => expect(files.length).toBeGreaterThan(10));
  for (const file of files) {
    it(file, () => {
      const v = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Vector;
      if (v.error) {
        expect(() => invoke(v.fn, v.input)).toThrowError(new RegExp(`^${v.error}:`));
      } else {
        expect(invoke(v.fn, v.input)).toEqual(v.output);
      }
    });
  }
});

describe("typed Kernel facade", () => {
  it("maps wasm errors to KernelError with a code", () => {
    try {
      kernel.transition("LANDED", "PUSHED");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(KernelError);
      expect((e as KernelError).code).toBe("INVALID_TRANSITION");
    }
  });
  it("exposes pure helpers", () => {
    expect(kernel.matches("src/a/b.ts", "src/**")).toBe(true);
    expect(kernel.claimsOverlap(["src/**"], ["docs/**"])).toBe(false);
    expect(kernel.drift(["a", ".lane/x"], ["b"])).toEqual(["a"]);
    expect(kernel.nextInQueue([])).toBeNull();
  });
  it("wraps non-kernel failures as KernelError(JSON)", () => {
    expect(() => invoke("transition", "not-an-object")).toThrowError(/^JSON:/);
    expect(() => invoke("nope", {})).toThrowError(/^UNKNOWN_FUNCTION:/);
  });
});
