import { describe, expect, test } from "bun:test";
import { globsOverlap, mayTouchProtected, pathsOverlap } from "../src/policy";

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
