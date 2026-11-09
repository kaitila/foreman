// The board's design system (T-0080): tokens.css holds every raw value, board.css names
// tokens only (design-kit lint), and every text colour meets WCAG AA in light and dark.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrast, lint, parseTokens } from "../../design-kit/src/index";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const tokensPath = "packages/foreman/src/board/tokens.css";
const tokens = parseTokens(readFileSync(repo + tokensPath, "utf8"));

// Text colours and the surfaces each one sits on.
const TEXT = ["ink", "ink-muted", "ink-faint", "attn", "go", "danger"];
const SURFACES = ["bg", "surface", "hover", "active", "sunk"];
const PAIRS: [string, string][] = [
  ...TEXT.flatMap((t) => SURFACES.map((s): [string, string] => [t, s])),
  ["attn", "attn-soft"],
  ["go", "go-soft"],
  ["danger", "danger-soft"],
  ["on-primary", "primary"],
  ["on-primary", "primary-hover"],
];

describe("board design tokens", () => {
  test("the tokens file parses, with a dark override and a reduced-motion block", () => {
    expect(tokens.names).toContain("color-bg");
    expect(tokens.light["color-bg"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens.dark["color-bg"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(tokens.dark["color-bg"]).not.toBe(tokens.light["color-bg"]);
    expect(tokens.reducedMotion["duration-base"]).toBe("0ms");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`every text colour meets 4.5:1 on its surfaces (${scheme})`, () => {
      const v = tokens[scheme];
      const failing = PAIRS.map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(v[`color-${fg}`]!, v[`color-${bg}`]!) })).filter(
        (p) => !(p.ratio >= 4.5),
      );
      expect(failing).toEqual([]);
    });
  }

  test("board.css and page.ts use tokens only: design-kit lint finds nothing", () => {
    const result = lint(["packages/foreman/src/board"], { tokensFile: tokensPath, cwd: repo });
    expect(result.findings).toEqual([]);
    expect(result.files).toBeGreaterThanOrEqual(2);
  });
});
