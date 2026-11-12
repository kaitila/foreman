// pathsOverlap and globsOverlap: when the dispatcher keeps two tasks apart (D0011, D0037, D0038, D0043).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globsOverlap, loadShared, mayTouchProtected, pathsOverlap } from "../src/policy";

// Both orders, since overlap is symmetric.
const overlap = (p: string, q: string) => {
  const a = globsOverlap(p, q);
  expect(globsOverlap(q, p)).toBe(a);
  return a;
};

describe("globsOverlap", () => {
  test("a glob that starts with ** reaches into the other's folders (T-0104)", () => {
    expect(overlap("**/*.md", "docs/decisions/**")).toBe(true);
    expect(overlap("**/*.md", "docs/**")).toBe(true);
    expect(overlap("**/.claude/**", "packages/foreman/src/**")).toBe(true);
    expect(overlap("**/package.json", "packages/*/src/**")).toBe(true);
  });

  test("a leading wildcard is checked against the other's folders segment by segment", () => {
    expect(overlap("*/x.md", "docs/**")).toBe(true);
    expect(overlap("*/notes/**", "docs/notes/a/**")).toBe(true);
    expect(overlap("*.md", "docs/**")).toBe(false); // top-level files only
    expect(overlap("*/other/**", "docs/notes/**")).toBe(false);
    expect(overlap("{docs,src}/**", "docs/decisions/**")).toBe(true);
  });

  test("a plain path is matched, not reached into", () => {
    expect(overlap("**/.claude/**", "packages/foreman/src/policy.ts")).toBe(false);
    expect(overlap("**/*.md", "docs/x.md")).toBe(true);
    expect(overlap("**/*.md", "docs/x.ts")).toBe(false);
  });

  test("two globs without a literal prefix", () => {
    expect(overlap("**/package.json", "**/.claude/**")).toBe(true);
    expect(overlap("*.md", "*.ts")).toBe(false);
    expect(overlap("*.md", "*")).toBe(true);
  });

  test("literal prefixes", () => {
    expect(overlap("packages/**", "packages/foreman/src/**")).toBe(true);
    expect(overlap("packages/foreman/**", "packages/agent-kit/**")).toBe(false);
    expect(overlap("foreman.json", "foreman.json")).toBe(true);
    expect(overlap("docs/a.md", "docs/b.md")).toBe(false);
  });
});

describe("mayTouchProtected and pathsOverlap use it", () => {
  test("a task's ** glob can touch a protected folder (T-0104)", () => {
    expect(mayTouchProtected(["**/*.md"], ["docs/decisions/**"])).toBe(true);
    expect(mayTouchProtected(["**/*.md"], ["docs/**"])).toBe(true);
    expect(mayTouchProtected(["**/*.ts"], ["**/AGENTS.md"])).toBe(true); // errs towards yes
    expect(mayTouchProtected(["docs/package.json"], ["**/package.json"])).toBe(true);
  });

  test("a protected ** glob doesn't reach into a task's folder: the verdict's diff check does (D0038)", () => {
    expect(mayTouchProtected(["src/**"], ["**/package.json", "**/.claude/**"])).toBe(false);
    expect(mayTouchProtected(["docs/a.md"], ["**/package.json"])).toBe(false);
  });

  test("two tasks with ** and a folder overlap", () => {
    expect(pathsOverlap(["**/*.md"], ["docs/**"])).toBe(true);
    expect(pathsOverlap(["*.md"], ["docs/**"])).toBe(false);
  });
});

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
    expect(pathsOverlap(["**/*.md"], ["docs/decisions/**"])).toBe(true);
  });

  test("any other shared path still overlaps", () => {
    expect(pathsOverlap(["src/a/**", "docs/decisions/**"], ["src/a/x.ts", "docs/decisions/**"])).toBe(true);
  });
});

describe("sharedPaths (D0043)", () => {
  const shared = ["docs/decisions/**", "README.md", "docs/changelog/**", "notes/*.md"];

  test("two tasks whose only common path is a shared file run side by side", () => {
    expect(pathsOverlap(["src/a/**", "README.md"], ["src/b/**", "README.md"], shared)).toBe(false);
    expect(pathsOverlap(["README.md"], ["README.md"])).toBe(true); // not shared unless the repo says so
  });

  test("a shared folder holds every path and glob under it", () => {
    expect(pathsOverlap(["docs/changelog/**"], ["docs/changelog/2026.md"], shared)).toBe(false);
    expect(pathsOverlap(["docs/changelog/*.md"], ["docs/changelog/**"], shared)).toBe(false);
    expect(pathsOverlap(["docs/decisions/**"], ["docs/decisions/**"], shared)).toBe(false);
  });

  test("a glob reaching past the shared path still overlaps it", () => {
    expect(pathsOverlap(["**/*.md"], ["README.md"], shared)).toBe(true);
    expect(pathsOverlap(["docs/**"], ["docs/changelog/**"], shared)).toBe(true);
    expect(pathsOverlap(["*.md"], ["README.md"], shared)).toBe(true);
  });

  test("a shared glob that isn't a whole folder covers plain paths and itself only", () => {
    expect(pathsOverlap(["notes/a.md"], ["notes/a.md"], shared)).toBe(false);
    expect(pathsOverlap(["notes/*.md"], ["notes/a.md"], shared)).toBe(false);
    expect(pathsOverlap(["notes/a*.md"], ["notes/a.md"], shared)).toBe(true); // could it match a file notes/*.md doesn't? don't guess
  });

  test("other common paths still overlap, and no declared paths overlaps everything", () => {
    expect(pathsOverlap(["src/a/**", "README.md"], ["src/a/x.ts", "README.md"], shared)).toBe(true);
    expect(pathsOverlap([], ["README.md"], shared)).toBe(true);
  });

  test("loadShared: the decision log, then foreman.json's sharedPaths; a bad value is refused", () => {
    const repo = (json: string) => {
      const dir = mkdtempSync(join(tmpdir(), "fm-shared-"));
      writeFileSync(join(dir, "foreman.json"), json);
      return dir;
    };
    expect(loadShared(null)).toEqual(["docs/decisions/**"]);
    expect(loadShared(repo("{}"))).toEqual(["docs/decisions/**"]);
    expect(loadShared(repo('{ "sharedPaths": ["README.md", "docs/decisions/**"] }'))).toEqual(["docs/decisions/**", "README.md"]);
    expect(() => loadShared(repo('{ "sharedPaths": "README.md" }'))).toThrow("sharedPaths");
    expect(() => loadShared(repo('{ "sharedPaths": [""] }'))).toThrow("sharedPaths");
  });

  test("this repo protects the files that enforce sign-off, each of which exists", () => {
    const root = join(import.meta.dir, "../../..");
    const fj = JSON.parse(readFileSync(join(root, "foreman.json"), "utf8")) as { protectedPaths: string[]; sharedPaths: string[] };
    const plain = [...fj.protectedPaths, ...fj.sharedPaths].filter((p) => !/[*?[{]/.test(p) && p.startsWith("packages/"));
    expect(plain).toContain("packages/foreman/src/cli/approve.ts");
    for (const p of plain) expect(`${p}: ${existsSync(join(root, p))}`).toBe(`${p}: true`);
    // The board, plans and the other commands merge on a passing verdict (D0044).
    expect(mayTouchProtected(["packages/foreman/src/board/page.ts", "packages/foreman/src/cli/plan.ts"], fj.protectedPaths)).toBe(false);
    expect(mayTouchProtected(["packages/foreman/src/**"], fj.protectedPaths)).toBe(true);
  });
});
