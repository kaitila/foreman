// The templates go into other people's projects, so they must be project-neutral
// and well-formed (T-0006).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TEMPLATES } from "../src/install";

const files = [...new Bun.Glob("**/*").scanSync({ cwd: TEMPLATES, dot: true, onlyFiles: true })].sort();
const prose = files.filter((f) => f.endsWith(".md"));

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return {};
  return Object.fromEntries(
    m[1]!.split("\n").map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

test("the expected templates exist", () => {
  for (const f of [
    ".claude/settings.json",
    ".claude/hooks/guard.ts",
    ".claude/hooks/session-start.ts",
    ".claude/skills/ship/SKILL.md",
    ".claude/skills/verify/SKILL.md",
    ".claude/agents/test-writer.md",
    ".claude/agents/docs-writer.md",
    ".claude/agents/reviewer.md",
    ".claude/agents/design-critic.md",
  ]) {
    expect(files).toContain(f);
  }
});

describe("project-neutral", () => {
  // Names from the codebase this grew out of, its owners, and this repo itself.
  const banned = [/\bgamma\b/i, /\bwave\b/i, /\bperly\b/i, /\bkaitila\b/i, /\barttu\b/i, /\bmeta-repo\b/i, /\btheta\b/i];
  test.each(files)("%s names no specific project or person", (f) => {
    const text = readFileSync(join(TEMPLATES, f), "utf8");
    for (const re of banned) expect(text).not.toMatch(re);
  });
  test.each(prose)("%s cites no decision numbers or task ids", (f) => {
    const text = readFileSync(join(TEMPLATES, f), "utf8").replace(/Dnnnn/g, "");
    expect(text).not.toMatch(/\bD\d{2,4}\b/);
    expect(text).not.toMatch(/\bT-\d{4}\b/);
  });
  test.each(prose)("%s assumes no specific stack or repo layout", (f) => {
    const text = readFileSync(join(TEMPLATES, f), "utf8");
    expect(text).not.toMatch(/\bbun (test|run)\b|\bnpm (test|run)\b|\bsrc\/|\bpackages\//);
  });
});

describe("well-formed", () => {
  test.each(files.filter((f) => f.startsWith(".claude/skills/")))("%s has a name matching its folder, and a description", (f) => {
    const fm = frontmatter(readFileSync(join(TEMPLATES, f), "utf8"));
    expect(fm.name).toBe(basename(dirname(f)));
    expect((fm.description ?? "").length).toBeGreaterThan(40);
  });
  test.each(files.filter((f) => f.startsWith(".claude/agents/")))("%s has a name matching its file, and a description", (f) => {
    const fm = frontmatter(readFileSync(join(TEMPLATES, f), "utf8"));
    expect(fm.name).toBe(basename(f, ".md"));
    expect((fm.description ?? "").length).toBeGreaterThan(40);
  });
  test.each(["reviewer", "design-critic"])("the %s can't edit", (name) => {
    const fm = frontmatter(readFileSync(join(TEMPLATES, `.claude/agents/${name}.md`), "utf8"));
    expect(fm.tools).toBeDefined();
    expect(fm.tools).not.toMatch(/Edit|Write/);
  });
  test("the design-critic judges by the project's design rules and screenshots when it can", () => {
    const text = readFileSync(join(TEMPLATES, ".claude/agents/design-critic.md"), "utf8");
    expect(text).toContain("docs/design.md");
    expect(text).toContain("playwright-core");
    expect(text).toMatch(/390 and 1280/);
    expect(text).toContain("no screenshots");
  });
  test("ship never has the worker verify or approve its own task", () => {
    const ship = readFileSync(join(TEMPLATES, ".claude/skills/ship/SKILL.md"), "utf8");
    expect(ship).toContain("never verify or approve your own task");
    expect(ship).not.toMatch(/record_verdict|start_verify|foreman approve/);
  });
});
