// The web page and its design rules (docs/design.md): its styles come only from
// src/ui/tokens.css, so editing that one file re-skins the page, and the design lint
// fails on a raw value added to a component.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint, parseTokens, resolveStyles, type ResolvedDecl } from "@foreman-kit/design-kit";
import { matchRoute } from "../src/server";
import { assetRoutes, renderPage, UI_DIR } from "../src/server/routes/page";
import { call } from "./helpers";

const SRC = join(import.meta.dir, "..", "src");
const sample = [
  { id: "2", name: "Second <b>bold</b>", createdAt: new Date("2026-10-31T12:00:00Z") },
  { id: "1", name: "First", createdAt: new Date("2026-10-30T09:00:00Z") },
];

/** Fetch a page file the way a browser would, from the routes serving `dir`. */
async function get(path: string, dir: string): Promise<Response> {
  const m = matchRoute("GET", path, assetRoutes(dir));
  if ("status" in m) return new Response(null, { status: m.status });
  return m.route.handler({ req: new Request(`http://localhost${path}`), url: new URL(`http://localhost${path}`), params: m.params });
}

/** Every style the page applies: its stylesheets, with var() resolved from the tokens file the page links. */
async function pageStyles(dir: string, scheme: "light" | "dark" = "light"): Promise<ResolvedDecl[]> {
  const hrefs = [...renderPage(sample).matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]!);
  expect(hrefs).toEqual(["/ui/tokens.css", "/ui/app.css"]);
  const [tokensCss, ...sheets] = await Promise.all(hrefs.map(async (h) => (await get(h, dir)).text()));
  const tokens = parseTokens(tokensCss!);
  return sheets.flatMap((css) => resolveStyles(css, tokens, scheme));
}

const byKey = (decls: ResolvedDecl[]) => new Map(decls.map((d) => [`${d.where} { ${d.prop} }`, d]));

describe("the page", () => {
  test("renders items escaped, with labels and landmarks, and an empty state", () => {
    const html = renderPage(sample);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("Second &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain('<time class="item-date" datetime="2026-10-31T12:00:00.000Z">2026-10-31</time>');
    expect(html).toMatch(/<label class="add-label" for="item-name">/);
    expect(html).toContain('role="status"');
    expect(html).toContain("<main");
    expect(html).toContain(">2 items<");
    const empty = renderPage([]);
    expect(empty).toContain("Nothing here yet");
    expect(empty).not.toContain("<ol");
    expect(empty).toContain(">0 items<");
  });

  test("serves its files from src/ui and nothing else", async () => {
    const css = await call("GET", "/ui/tokens.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(readFileSync(join(UI_DIR, "tokens.css"), "utf8"));
    expect((await call("GET", "/ui/app.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    for (const path of ["/ui/tokens.ts", "/ui/..%2Fserver%2Findex.ts", "/ui/constructor"]) expect((await call("GET", path)).status, path).toBe(404);
  });

  test("every colour, font and spacing value in the stylesheet comes from a token", async () => {
    const styled = /color|background|border|outline|font-family|font-size|margin|padding|gap/;
    for (const d of await pageStyles(UI_DIR)) {
      if (!styled.test(d.prop) || /^(0|auto|inherit|none)( 0| auto)*$/.test(d.raw)) continue;
      expect(d.uses.length, `${d.where} { ${d.prop}: ${d.raw} }`).toBeGreaterThan(0);
    }
  });
});

describe("re-skin and lint", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-reskin-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(UI_DIR, dir, { recursive: true });
  // A different skin: every colour inverted, a monospace display face, half the spacing.
  const invert = (hex: string) => `#${(0xffffff ^ parseInt(hex.slice(1), 16)).toString(16).padStart(6, "0")}`;
  const original = readFileSync(join(UI_DIR, "tokens.css"), "utf8");
  writeFileSync(
    join(dir, "tokens.css"),
    original
      .replace(/#[0-9a-f]{6}\b/g, invert)
      .replace(/--font-display: [^;]+;/, "--font-display: ui-monospace, monospace;")
      .replace(/(--space-\d+: )([\d.]+)rem/g, (_, k: string, v: string) => `${k}${Number(v) / 2}rem`),
  );

  test("changing only tokens.css changes the page's styles, in light and dark", async () => {
    const changed = readdirSync(dir).filter((f) => readFileSync(join(dir, f), "utf8") !== readFileSync(join(UI_DIR, f), "utf8"));
    expect(changed).toEqual(["tokens.css"]);
    for (const scheme of ["light", "dark"] as const) {
      const before = byKey(await pageStyles(UI_DIR, scheme));
      const after = byKey(await pageStyles(dir, scheme));
      expect([...after.keys()]).toEqual([...before.keys()]);
      const tokenColour = (d: ResolvedDecl) => d.uses.some((u) => u.startsWith("color-"));
      const colourDecls = [...before].filter(([, d]) => tokenColour(d));
      expect(colourDecls.length).toBeGreaterThanOrEqual(20);
      for (const [key, d] of colourDecls) expect(after.get(key)!.value, `${scheme}: ${key}`).not.toBe(d.value);
      expect(after.get("body { background-color }")!.value).toBe(invert(before.get("body { background-color }")!.value));
    }
    const after = byKey(await pageStyles(dir));
    expect(after.get(".title { font-family }")!.value).toBe("ui-monospace, monospace");
    expect(after.get(".page { padding }")!.value).toBe("1.5rem 0.5rem 2.25rem");
  });

  test("the app's sources pass the design lint", () => {
    const r = lint(["src"], { cwd: join(SRC, "..") });
    expect(r.findings).toEqual([]);
    expect(r.tokensFile).toBe("src/ui/tokens.css");
  });

  test("a raw hex added to a component fails the lint", () => {
    writeFileSync(join(dir, "app.css"), `${readFileSync(join(UI_DIR, "app.css"), "utf8")}\n.badge {\n  color: #e11d48;\n}\n`);
    writeFileSync(join(dir, "badge.ts"), 'export const badge = `<span style="background: #e11d48">new</span>`;\n');
    const r = lint(["."], { cwd: dir });
    expect(r.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`).sort()).toEqual([
      `app.css:${readFileSync(join(dir, "app.css"), "utf8").split("\n").length - 2} raw-color #e11d48`,
      "badge.ts:1 raw-color #e11d48",
    ]);
  });
});
