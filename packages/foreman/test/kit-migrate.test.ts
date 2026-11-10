// fm sync on projects the M7 kit made (fixtures/m7-projects.json): the record moves to .foreman-kit/,
// tarball dependencies become versions, the vendored foreman goes, .mcp.json runs fm, and the
// tarballs and .meta-repo/ are deleted. A dry run writes nothing, and nothing is committed (D0026).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runKitCommand } from "../src/kit/commands";
import { FOREMAN_SERVER, kitFiles, LEGACY_RECORD, RECORD, readInstalled } from "../src/kit/kit";
import { VERSION as V } from "../src/kit/paths";
import { PIECES } from "../src/kit/pieces";
import { sync } from "../src/kit/sync";
import fixtures from "./fixtures/m7-projects.json";

type Kind = "create" | "init";
const base = mkdtempSync(join(tmpdir(), "foreman-migrate-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const put = (dir: string, f: string, text: string | Uint8Array) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};
const git = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};
/** Every file and its text, outside .git: to show a dry run wrote nothing. */
const snapshot = (dir: string) =>
  Object.fromEntries([...new Bun.Glob("**").scanSync({ cwd: dir, dot: true })].filter((f) => !f.startsWith(".git/")).sort().map((f) => [f, read(dir, f)]));

/** The M7 project of this kind, committed in a fresh repo. The kit's .claude files it recorded are today's (the fixture leaves them out). */
function m7(kind: Kind, extra: Record<string, string> = {}) {
  const dir = join(base, `${kind}-${++n}`);
  const files = { ...(fixtures[kind] as Record<string, string>), ...extra };
  for (const [f, text] of Object.entries(files)) put(dir, f, text);
  const kit = kitFiles(undefined, ["guardrails", "skills"]);
  for (const f of Object.keys(JSON.parse(files[LEGACY_RECORD]!).files)) if (!(f in files) && kit.has(f)) put(dir, f, kit.get(f)!);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "made by the M7 kit");
  return dir;
}

const fixture = (kind: Kind, f: string) => (fixtures[kind] as Record<string, string>)[f]!;
const tarballs = (kind: Kind) => Object.keys(fixtures[kind]).filter((f) => f.startsWith(".meta-repo/packages/"));

describe("sync on an M7-era project", () => {
  test.each(["create", "init"] as const)("made by %s: a dry run prints every step and writes nothing", (kind) => {
    const dir = m7(kind);
    const before = snapshot(dir);
    const dry = sync(dir, { dryRun: true });
    expect(snapshot(dir)).toEqual(before);
    expect(git(dir, "status", "--porcelain")).toBe("");
    // The same steps a real run takes.
    const real = sync(dir);
    expect(dry.changes).toEqual(real.changes);
    expect(dry.reinstall).toBe(real.reinstall);
  });

  test("made by create: every step of the migration, each printed", () => {
    const dir = m7("create");
    const head = git(dir, "rev-parse", "HEAD");
    const r = sync(dir);
    const steps = r.changes.filter((c) => !c.path.startsWith(".claude/")); // the kit files sync as usual (kit-create.test.ts)
    expect(steps).toEqual([
      { action: "moved", path: RECORD, note: `from ${LEGACY_RECORD}, pieces: ${PIECES.join(", ")}` },
      ...tarballs("create").map((path) => ({ action: "deleted" as const, path, note: "vendored tarball, no longer used" })),
      {
        action: "updated",
        path: "package.json",
        note: [`@meta-repo/design-kit tarball -> @foreman-kit/design-kit ${V}`, `@meta-repo/docs-check tarball -> @foreman-kit/docs-check ${V}`, "@meta-repo/foreman removed (the foreman MCP server is your own fm)", `@meta-repo/test-kit tarball -> @foreman-kit/test-kit ${V}`].join("; "),
      },
      { action: "updated", path: ".mcp.json", note: "foreman server: bun node_modules/.../foreman/src/cli.ts mcp -> fm mcp" },
      { action: "updated", path: "foreman.json", note: `foreman (no range) -> >=${V}` },
      { action: "deleted", path: ".meta-repo/packages/", note: "empty" },
      { action: "deleted", path: ".meta-repo/", note: "empty" },
    ]);
    expect(r.reinstall).toBe(true);

    // The record, at its new path, with every piece (create gave them all) and no tarballs.
    expect(existsSync(join(dir, ".meta-repo"))).toBe(false);
    const rec = readInstalled(dir)!;
    expect(rec.source).toBe(V);
    expect(rec.preset).toBe("bun-ts-postgres");
    expect(rec.pieces).toEqual([...PIECES]);
    expect(Object.keys(rec.files).filter((f) => f.includes(".meta-repo"))).toEqual([]);
    expect(Object.keys(rec.files).length).toBeGreaterThan(0);
    expect(existsSync(join(dir, RECORD))).toBe(true);

    // package.json: the same file, with only the four kit lines changed.
    let want = fixture("create", "package.json");
    for (const pkg of ["design-kit", "docs-check", "test-kit"]) want = want.replace(new RegExp(`"@meta-repo/${pkg}": "file:[^"]+"`), `"@foreman-kit/${pkg}": "${V}"`);
    want = want.replace(/\n\s*"@meta-repo\/foreman": "file:[^"]+",/, "");
    expect(read(dir, "package.json")).toBe(want);
    expect(read(dir, "package.json")).not.toContain("meta-repo");

    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { foreman: FOREMAN_SERVER } });
    const fj = JSON.parse(read(dir, "foreman.json"));
    expect(fj.foreman).toBe(`>=${V}`);
    expect(fj.protectedPaths).toEqual(JSON.parse(fixture("create", "foreman.json")).protectedPaths);
    expect(Object.keys(fj)).toEqual(["$comment", "foreman", "protectedPaths"]);

    // Nothing committed; the next sync has nothing left to do.
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).not.toBe("");
    expect(sync(dir).changes).toEqual([]);
  });

  test("made by init: pieces from the files it recorded, and the vendored foreman removed", () => {
    const dir = m7("init");
    const r = sync(dir);
    expect(r.changes.find((c) => c.action === "moved")?.note).toBe(`from ${LEGACY_RECORD}, pieces: guardrails, skills`);
    expect(readInstalled(dir)!.pieces).toEqual(["guardrails", "skills"]);
    expect(read(dir, "package.json")).toBe('{\n  "name": "old-repo",\n  "private": true,\n  "devDependencies": {\n    "typescript": "5.9.3"\n  }\n}\n');
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman).toEqual(FOREMAN_SERVER);
    expect(existsSync(join(dir, ".meta-repo"))).toBe(false);
    expect(existsSync(join(dir, LEGACY_RECORD))).toBe(false);
    expect(sync(dir).changes).toEqual([]);
  });

  test("a foreman server the project changed is kept, and so is .meta-repo/ with files of its own", () => {
    const mcp = JSON.stringify({ mcpServers: { foreman: { command: "bun", args: ["node_modules/@meta-repo/foreman/src/cli.ts", "mcp", "--verbose"] } } }, null, 2) + "\n";
    const dir = m7("init", { ".mcp.json": mcp, ".meta-repo/notes.md": "ours\n" });
    const r = sync(dir);
    expect(read(dir, ".mcp.json")).toBe(mcp);
    expect(r.changes.some((c) => c.path === ".mcp.json")).toBe(false);
    expect(read(dir, ".meta-repo/notes.md")).toBe("ours\n");
    for (const t of tarballs("init")) expect(existsSync(join(dir, t)), t).toBe(false);
    expect(existsSync(join(dir, ".meta-repo/packages"))).toBe(false);
    expect(r.changes).toContainEqual({ action: "kept", path: ".meta-repo/", note: "not empty: notes.md" });
  });

  test("fm sync prints each step and asks for bun install; --dry-run says it wrote nothing", () => {
    const dir = m7("create");
    const dry: string[] = [];
    runKitCommand("sync", dir, { dryRun: true }, (l) => dry.push(l));
    expect(dry[0]).toBe(`kit 0.1.0 -> ${V} (dry run: nothing written)`);
    expect(existsSync(join(dir, LEGACY_RECORD))).toBe(true);
    const lines: string[] = [];
    runKitCommand("sync", dir, {}, (l) => lines.push(l));
    const out = lines.join("\n");
    expect(out).toContain(`moved    ${RECORD} (from ${LEGACY_RECORD}`);
    expect(out).toContain("deleted  .meta-repo/packages/foreman-07e4f7c3286a.tgz");
    expect(out).toContain("updated  .mcp.json");
    expect(out).toContain("package.json changed: run bun install.");
    expect(out).toContain("Nothing was committed: review with git diff.");
  });
});
