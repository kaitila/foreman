// pathsOverlap: when the dispatcher keeps two tasks apart (D0011, D0037).
import { describe, expect, test } from "bun:test";
import { pathsOverlap } from "../src/policy";

describe("pathsOverlap", () => {
  test("shared or nested paths overlap, separate ones don't", () => {
    expect(pathsOverlap(["src/a/**"], ["src/a/b.ts"])).toBe(true);
    expect(pathsOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
  });

  test("no declared paths overlaps everything", () => {
    expect(pathsOverlap([], ["src/a/**"])).toBe(true);
    expect(pathsOverlap(["docs/decisions/**"], [])).toBe(true);
  });

  test("paths that both stay inside docs/decisions/ don't overlap", () => {
    expect(pathsOverlap(["docs/decisions/**"], ["docs/decisions/**"])).toBe(false);
    expect(pathsOverlap(["docs/decisions/**"], ["docs/decisions/README.md"])).toBe(false);
    expect(pathsOverlap(["docs/decisions/D0011-foreman-dispatch.md"], ["docs/decisions/*"])).toBe(false);
  });

  test("a glob reaching past docs/decisions/ still overlaps it, a sibling folder doesn't", () => {
    expect(pathsOverlap(["docs/**"], ["docs/decisions/**"])).toBe(true);
    expect(pathsOverlap(["docs/decisions-old/**"], ["docs/decisions/**"])).toBe(false);
  });

  test("any other shared path still overlaps", () => {
    expect(pathsOverlap(["src/a/**", "docs/decisions/**"], ["src/a/x.ts", "docs/decisions/**"])).toBe(true);
  });
});
