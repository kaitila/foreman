import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { envRegistry, loadConfig, run, type Config } from "../src/index";
import { validDate } from "../src/decisions";
import { anchors, links, proseLines, slug } from "../src/markdown";

const base = mkdtempSync(join(tmpdir(), "docs-check-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const TODAY = new Date("2026-10-30T12:00:00Z");

const decision = (n: number, extra: { status?: string; date?: string; body?: string } = {}) =>
  [
    `# D${String(n).padStart(4, "0")}. Decision number ${n} (${extra.date ?? "2026-10-01"})`,
    "",
    `**Status:** ${extra.status ?? "Active"}`,
    "",
    extra.body ?? "**Chosen:** x\n\n**Why:** y\n\n**Revisit if:** z",
    "",
  ].join("\n");

/** A throwaway repo (not a git repo: the plain file walk is used). */
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(base, "r-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}
const kinds = (root: string, config: Config = {}) => run(root, config, { today: TODAY }).failures.map((f) => `${f.kind} ${f.target}`);
const withIndex = (files: Record<string, string>) => {
  // Write the index the checker expects, so tests about other things start clean.
  const root = repo(files);
  const r = run(root, {}, { today: TODAY });
  if (r.index) writeFileSync(join(root, r.index.path), r.index.text);
  return root;
};

describe("links and paths", () => {
  test("dead links, dead anchors and missing backticked paths fail; good ones pass", () => {
    const root = repo({
      "README.md": [
        "# Top",
        "## Getting started",
        "[ok](docs/guide.md) [ok anchor](#getting-started) [ok other](docs/guide.md#setup)",
        "[dead](docs/missing.md) [dead anchor](docs/guide.md#nope) [ext](https://example.com/x)",
        "See `src/app.ts` and `src/gone.ts:12`, not `some words` or `src/*.ts`.",
      ].join("\n"),
      "docs/guide.md": "# Guide\n## Setup\nBack [up](../README.md).\n",
      "src/app.ts": "export {};\n",
    });
    expect(kinds(root, { decisions: false })).toEqual(["link docs/missing.md", "link-anchor docs/guide.md#nope", "path src/gone.ts"]);
  });

  test("code blocks and marked lines are skipped", () => {
    const root = repo({
      "README.md": [
        "```md",
        "[dead](nowhere.md) `src/nowhere.ts`",
        "```",
        "`src/planned.ts` will hold it <!-- docs-check: planned -->",
        "",
      ].join("\n"),
      "src/x.ts": "",
    });
    expect(kinds(root, { decisions: false })).toEqual([]);
  });

  test("a malformed %-escape is a failure, not a crash", () => {
    const root = repo({ "README.md": "[bad](docs/%E0%A4%A.md)\n" });
    expect(kinds(root, { decisions: false })).toEqual(["link docs/%E0%A4%A.md"]);
  });
});

describe("decisions", () => {
  test("a clean log with its index passes", () => {
    const root = withIndex({
      "docs/decisions/D0001-first.md": decision(1, { status: "Superseded by D0002" }),
      "docs/decisions/D0002-second.md": decision(2),
    });
    expect(kinds(root)).toEqual([]);
  });

  test("a duplicate number fails (what branches that count files themselves produce)", () => {
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1),
      "docs/decisions/D0003-c.md": decision(3),
      "docs/decisions/D0003-other.md": decision(3),
    });
    const k = kinds(root).filter((x) => x.startsWith("decision-number"));
    expect(k).toEqual(["decision-number D0003 is used by 2 files", "decision-number D0003 is used by 2 files"]);
  });

  test("a gap passes: lower numbers on open PRs, or reserved and abandoned", () => {
    // D0002 and D0004 are on other branches or were never used; D0005 is this branch's.
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1, { status: "Amended by D0005" }),
      "docs/decisions/D0003-c.md": decision(3),
      "docs/decisions/D0005-e.md": decision(5),
    });
    expect(kinds(root)).toEqual([]);
    const index = run(root, {}, { today: TODAY }).index!.text;
    expect(index).toContain("3 decisions");
    expect(index.indexOf("[D0001]")).toBeLessThan(index.indexOf("[D0003]"));
    expect(index.indexOf("[D0003]")).toBeLessThan(index.indexOf("[D0005]"));
    expect(index).not.toContain("D0002");
  });

  test("a status naming a number in the gap fails: that decision isn't here", () => {
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1, { status: "Superseded by D0002" }),
      "docs/decisions/D0003-c.md": decision(3),
    });
    const k = kinds(root);
    expect(k).toContain("decision-status D0002 doesn't exist");
    expect(k.every((x) => x.endsWith("D0002") || x.includes("D0002 "))).toBe(true); // nothing else fails
  });

  test("D0000 fails: numbers start at 1", () => {
    const root = withIndex({ "docs/decisions/D0000-zero.md": decision(0) });
    expect(kinds(root)).toEqual(["decision-number numbers start at 1"]);
  });

  test("status grammar, targets that don't exist or aren't later, and sections", () => {
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1, { status: "Replaced by D0002" }),
      "docs/decisions/D0002-b.md": decision(2, { status: "Amended by D0001" }),
      "docs/decisions/D0003-c.md": decision(3, { status: "Superseded by D0009" }),
      "docs/decisions/D0004-d.md": decision(4, { body: "**Why:** y\n\n**Chosen:** x" }),
    });
    const k = kinds(root);
    expect(k).toContain("decision-status Replaced by D0002");
    expect(k).toContain("decision-status D0001 isn't later than D0002");
    expect(k).toContain("decision-status D0009 doesn't exist");
    expect(k).toContain("decision-section **Why:** is out of order");
    expect(k).toContain("decision-section no **Revisit if:** section");
  });

  test("headings, file names and dates", () => {
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1, { date: "2026-02-30" }),
      "docs/decisions/D0002-b.md": decision(3),
      "docs/decisions/D0003-c.md": decision(3, { date: "2027-01-01" }),
      "docs/decisions/D4-bad-name.md": decision(4),
    });
    const k = kinds(root);
    expect(k).toContain("decision-date 2026-02-30");
    expect(k).toContain("decision-heading heading says D0003, file name says D0002");
    expect(k).toContain("decision-date 2027-01-01");
    expect(k.some((x) => x.startsWith("decision-file"))).toBe(true);
  });

  test("the index must be generated and current", () => {
    const root = repo({ "docs/decisions/D0001-a.md": decision(1) });
    expect(kinds(root)).toEqual(["decision-index missing; run docs-check --write-index"]);
    writeFileSync(join(root, "docs/decisions/README.md"), "# old\n");
    expect(kinds(root)).toEqual(["decision-index out of date; run docs-check --write-index"]);
  });

  test("an unknown decision reference fails; known ones and unpadded words pass", () => {
    const root = withIndex({
      "docs/decisions/D0001-a.md": decision(1),
      "README.md": "Per D0001, not D0042. A D3 chart is not a reference.\n",
    });
    expect(kinds(root)).toEqual(["decision-ref D0042"]);
  });
});

describe("last reviewed", () => {
  const files = (line: string) => ({ "docs/decisions/D0001-a.md": decision(1), "docs/area.md": `# Area\n\n${line}\n` });
  test("well-formed and fresh passes; stale warns; strict fails; unknown decision fails", () => {
    expect(kinds(withIndex(files("Last reviewed: 2026-10-01 (through D0001)")))).toEqual([]);
    const stale = withIndex(files("Last reviewed: 2026-01-01 (through D0001)"));
    const r = run(stale, {}, { today: TODAY });
    expect(r.failures.map((f) => f.severity)).toEqual(["warning"]);
    expect(run(stale, {}, { today: TODAY, strictFreshness: true }).failures.map((f) => f.severity)).toEqual(["error"]);
    expect(kinds(withIndex(files("Last reviewed: 2026-10-01 (through D0009)")))).toContain("decision-ref D0009");
    expect(kinds(withIndex(files("Last reviewed: yesterday")))).toContain("reviewed write it as 'Last reviewed: YYYY-MM-DD (through Dnnnn)'");
  });
});

describe("registries", () => {
  test("env: undocumented reads, unknown doc rows and stale example keys fail", () => {
    const root = repo({
      "src/config.ts": 'const a = process.env.API_URL;\nconst b = Bun.env["PORT"];\n',
      "test/x.test.ts": "process.env.TEST_ONLY;\n",
      ".env.example": "API_URL=\n# PORT=4300\nOLD_KEY=\n",
      "docs/configuration.md": "| Name | What |\n|---|---|\n| `API_URL` | where |\n| `REMOVED` | gone |\n",
    });
    const k = kinds(root, { decisions: false, registries: [envRegistry({ doc: "docs/configuration.md" })] });
    expect(k).toContain("env-undocumented PORT (add it to docs/configuration.md)");
    expect(k).toContain("env-unknown REMOVED");
    expect(k.some((x) => x.includes("OLD_KEY (in .env.example, never read)"))).toBe(true);
    expect(k.some((x) => x.includes("TEST_ONLY"))).toBe(false); // read only in tests: needn't be documented
  });
  test("env: agent tooling under .claude/ isn't the app's config", () => {
    const root = repo({
      ".claude/hooks/guard.ts": "process.env.FOREMAN_ACTOR;\n",
      "src/config.ts": "process.env.PORT;\n",
      "docs/configuration.md": "| Name | What |\n|---|---|\n| `PORT` | port |\n",
    });
    expect(kinds(root, { decisions: false, registries: [envRegistry({ doc: "docs/configuration.md" })] })).toEqual([]);
  });
});

describe("helpers", () => {
  test("fences close only on the same character and at least the same length", () => {
    expect(proseLines("````\n```\nstill code\n````\nprose")).toEqual(["", "", "", "", "prose"]);
  });
  test("GitHub-style anchors, with duplicates numbered", () => {
    expect(slug("What's `new` in v2.0?")).toBe("whats-new-in-v20");
    expect([...anchors("# A\n## A\n## B c")]).toEqual(["a", "a-1", "b-c"]);
  });
  test("links with parentheses and angle brackets", () => {
    expect(links("[a](docs/x_(1).md) [b](<docs/my file.md>) ![c](img.png \"t\")")).toEqual(["docs/x_(1).md", "docs/my file.md", "img.png"]);
  });
  test("dates round-trip", () => {
    expect(validDate("2026-02-28", TODAY)).toBe(true);
    expect(validDate("2026-02-30", TODAY)).toBe(false);
    expect(validDate("2026-13-01", TODAY)).toBe(false);
  });
});

test("this repository passes, with its own docs-check.config.ts", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const errors = run(root, await loadConfig(root), {}).failures.filter((f) => f.severity === "error");
  expect(errors).toEqual([]);
});
