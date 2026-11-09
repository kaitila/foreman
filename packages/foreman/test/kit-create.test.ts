import { SCOPE, TEMPLATES } from "../src/kit/install";
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addDevDependency } from "../src/kit/create";
import { add, create, init, sync } from "../src/kit/index";
import { initPieces, runKitCommand } from "../src/kit/commands";
import { FOREMAN_SERVER, kitFiles, LEGACY_RECORD, ownTemplate, pointDep, RECORD, readInstalled, sha256, workspaceDeps } from "../src/kit/kit";
import { VERSION } from "../src/kit/paths";
import { parseAnswer, PIECES } from "../src/kit/pieces";

const TASKS = ownTemplate("tasks-section.md");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const tarballOf = (pkg: string) => new RegExp(`^file:(\\.meta-repo\\/packages\\/${pkg}-[0-9a-f]{12}\\.tgz)$`);
const TEST_KIT_TGZ = tarballOf("test-kit");
const count = (text: string, part: string) => text.split(part).length - 1;
/** The env with no FOREMAN_* settings, so foreman finds its board in the project itself. */
const plainEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FOREMAN_") && process.env[k] !== undefined)) as Record<string, string>;
/** The project's file listing, to show a refused init wrote nothing. */
const listing = (dir: string) => [...new Bun.Glob("**").scanSync({ cwd: dir, dot: true })].filter((f) => !f.startsWith(".git/")).sort();

// The first commit needs an identity; CI runners have none configured.
for (const k of ["GIT_AUTHOR", "GIT_COMMITTER"]) {
  process.env[`${k}_NAME`] = "Test";
  process.env[`${k}_EMAIL`] = "test@example.invalid";
}

const base = mkdtempSync(join(tmpdir(), "foreman-create-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = (name = `app-${++n}`) => join(mkdtempSync(join(base, "d-")), name);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const put = (dir: string, f: string, text: string) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};
const git = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};
/** An existing repository, with the given files committed. */
function repo(files: Record<string, string>) {
  const dir = fresh("existing");
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) put(dir, f, text);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

/** A folder with an `fm` that runs this checkout's CLI: what the person's installed fm does. */
const fmBin = (() => {
  let dir: string | undefined;
  return () => {
    if (dir) return dir;
    dir = join(base, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fm"), `#!/bin/sh\nexec bun ${JSON.stringify(CLI)} "$@"\n`);
    chmodSync(join(dir, "fm"), 0o755);
    return dir;
  };
})();
/** plainEnv with that fm first on PATH. */
const fmEnv = () => ({ ...plainEnv(), PATH: `${fmBin()}:${process.env.PATH ?? ""}` });

/** Start the foreman server exactly as the project's .mcp.json says, and call one tool. */
async function callConfigured(dir: string, tool: string, args: Record<string, unknown> = {}) {
  const server = JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman as { command: string; args: string[] };
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: dir, env: fmEnv() }));
  try {
    const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]!.text };
  } finally {
    await client.close();
  }
}

/** The files `fm init` writes with no pieces, in a repo that has none of them. */
const FOREMAN_ALONE = [RECORD, ".gitignore", ".mcp.json", "AGENTS.md", "CLAUDE.md", "foreman.json"].sort();

describe("create", () => {
  test("a project from the preset: kit, vendored packages, foreman.json, CI, record and one commit", () => {
    const dir = fresh("my-app");
    create(dir, { install: false });
    const pkg = JSON.parse(read(dir, "package.json"));
    expect(pkg.name).toBe("my-app");
    for (const dep of ["docs-check", "test-kit"]) {
      const spec: string = pkg.devDependencies[`@foreman-kit/${dep}`];
      expect(spec).toMatch(new RegExp(`^file:\\.meta-repo/packages/${dep}-[0-9a-f]{12}\\.tgz$`));
      expect(existsSync(join(dir, spec.slice(5)))).toBe(true);
    }
    // foreman itself is the person's own fm, not a dependency (D0026).
    expect({ ...pkg.dependencies, ...pkg.devDependencies }["@foreman-kit/foreman"]).toBeUndefined();
    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    const fj = JSON.parse(read(dir, "foreman.json"));
    expect(fj.protectedPaths).toContain(".claude/**");
    expect(fj.foreman).toBe(`>=${VERSION}`);
    expect(read(dir, ".github/workflows/ci.yml")).toContain("/my_app_test");
    expect(read(dir, ".github/workflows/ci.yml")).not.toMatch(/\{\{\w+\}\}/);

    const rec = readInstalled(dir)!;
    expect(existsSync(join(dir, RECORD))).toBe(true);
    expect(rec.preset).toBe("bun-ts-postgres");
    expect(rec.pieces).toEqual([...PIECES]);
    expect(Object.keys(rec.files)).toEqual(expect.arrayContaining([...kitFiles().keys()]));
    expect(Object.keys(rec.files)).not.toContain(".claude/settings.json"); // merged, never hashed
    for (const [f, hash] of Object.entries(rec.files)) expect(sha256(readFileSync(join(dir, f))), f).toBe(hash);

    expect(git(dir, "log", "--format=%s").trim().split("\n")).toHaveLength(1);
    expect(git(dir, "status", "--porcelain")).toBe("");
    // Right after create, the project is up to date with the kit.
    expect(sync(dir).changes).toEqual([]);
  });

  test("the new project has foreman: its MCP server runs fm, .foreman/ is ignored, a Tasks section, and it answers", async () => {
    const dir = fresh("tasks-app");
    create(dir, { install: false });
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman).toEqual(FOREMAN_SERVER);
    expect(read(dir, ".gitignore").split("\n")).toContain(".foreman/");
    const agents = read(dir, "AGENTS.md");
    expect(count(agents, "## Tasks")).toBe(1);
    expect(agents).toContain(TASKS);
    expect(agents.indexOf("## Tasks")).toBeLessThan(agents.indexOf("## Rules"));

    // The CLI the Tasks section names, and the MCP server as .mcp.json starts it, answer.
    const next = Bun.spawnSync(["fm", "next", "--json"], { cwd: dir, env: fmEnv(), stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect({ code: next.exitCode, err: next.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(next.stdout.toString())).toEqual([]);
    const listed = await callConfigured(dir, "list_tasks");
    expect(listed.error).toBe(false);
    expect(JSON.parse(listed.text)).toEqual([]);

    // foreman's board landed in .foreman/, which git ignores.
    expect(existsSync(join(dir, ".foreman"))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
  }, 60_000);

  test("refuses a non-empty folder, a bad name and an unknown preset, before writing anything", () => {
    const dir = fresh();
    put(dir, "keep.txt", "mine");
    expect(() => create(dir, { install: false })).toThrow("not empty");
    expect(() => create(fresh("My App"), { install: false })).toThrow("name must be");
    expect(() => create(fresh(), { preset: "nope", install: false })).toThrow('unknown preset "nope"');
    const named = fresh("Bad_Name");
    expect(() => create(named, { install: false, git: false })).toThrow("name must be");
    expect(existsSync(named)).toBe(false);
    create(named, { name: "good-name", install: false, git: false });
    expect(JSON.parse(read(named, "package.json")).name).toBe("good-name");
    expect(existsSync(join(named, ".git"))).toBe(false);
  });
});

describe("init: foreman alone", () => {
  test("in a git repo with no package.json and no pieces, writes only foreman's own files", () => {
    const dir = repo({});
    const changes = init(dir);
    expect(listing(dir)).toEqual(FOREMAN_ALONE);
    expect(read(dir, "AGENTS.md")).toBe(TASKS);
    expect(read(dir, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(dir, ".gitignore")).toBe(".foreman/\n");
    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { foreman: FOREMAN_SERVER } });
    expect(FOREMAN_SERVER).toEqual({ type: "stdio", command: "fm", args: ["mcp"] });
    const fj = JSON.parse(read(dir, "foreman.json"));
    expect(fj.foreman).toBe(`>=${VERSION}`);
    expect(fj.protectedPaths).toEqual(expect.arrayContaining([".mcp.json", "foreman.json", ".foreman-kit/**"]));
    const rec = readInstalled(dir)!;
    expect(rec.pieces).toEqual([]);
    expect(rec.files).toEqual({});
    expect(changes).toContainEqual(expect.objectContaining({ action: "skipped", path: "pieces" }));
  });

  test("the foreman MCP server it configures answers list_tasks", async () => {
    const dir = repo({});
    init(dir);
    const r = await callConfigured(dir, "list_tasks");
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text)).toEqual([]);
    expect(existsSync(join(dir, ".foreman"))).toBe(true);
  }, 30_000);

  test("with no terminal and no flags, fm init sets up foreman alone, and a second plain init is refused", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "ours", scripts: { check: "bun test" } }) });
    const env = { ...fmEnv(), FOREMAN_PROJECTS_FILE: join(base, "cli-projects.json") };
    const run = (...args: string[]) => Bun.spawnSync(["fm", ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    const first = run("init");
    expect({ code: first.exitCode, err: first.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(listing(dir)).toEqual([...FOREMAN_ALONE, "package.json"].sort());
    expect(readInstalled(dir)!.pieces).toEqual([]);
    const again = run("init");
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr.toString()).toContain("already set up");
    // --with adds a piece to it later.
    const more = run("init", "--with", "skills");
    expect({ code: more.exitCode, err: more.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(existsSync(join(dir, ".claude/skills/ship/SKILL.md"))).toBe(true);
    expect(readInstalled(dir)!.pieces).toEqual(["skills"]);
  }, 60_000);

  test("appends @AGENTS.md to CLAUDE.md once, and only when it's missing", () => {
    const noNewline = repo({ "CLAUDE.md": "Notes" });
    init(noNewline);
    expect(read(noNewline, "CLAUDE.md")).toBe("Notes\n@AGENTS.md\n");

    const importing = repo({ "CLAUDE.md": "Intro\n@AGENTS.md\nMore" });
    const changes = init(importing);
    expect(read(importing, "CLAUDE.md")).toBe("Intro\n@AGENTS.md\nMore");
    expect(changes.some((c) => c.path === "CLAUDE.md" && c.action === "merged")).toBe(false);
  });

  test("on a Bun repo: merges its MCP server, ignores .foreman/, appends the Tasks section, and leaves package.json alone", () => {
    const pkgText = JSON.stringify({ name: "ours", dependencies: { zod: "4.6.7" }, devDependencies: { typescript: "5.9.3" } }, null, 4) + "\n";
    const dir = repo({
      "package.json": pkgText,
      ".mcp.json": JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other-server" } } }),
      ".gitignore": "node_modules",
      "AGENTS.md": "# Ours\n\n## Rules\n- Be kind.\n",
    });
    const changes = init(dir);

    expect(read(dir, "package.json")).toBe(pkgText); // foreman is the person's fm, not a dependency
    expect(existsSync(join(dir, ".meta-repo"))).toBe(false);
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers).toEqual({ other: { type: "stdio", command: "other-server" }, foreman: FOREMAN_SERVER });
    expect(read(dir, ".gitignore")).toBe("node_modules\n.foreman/\n");
    expect(read(dir, "AGENTS.md")).toBe(`# Ours\n\n## Rules\n- Be kind.\n\n${TASKS}`);

    const by = Object.fromEntries(changes.filter((c) => ["package.json", ".mcp.json", ".gitignore", "AGENTS.md"].includes(c.path)).map((c) => [c.path, c.action]));
    expect(by).toEqual({ ".mcp.json": "merged", ".gitignore": "merged", "AGENTS.md": "merged" });
  });

  test("keeps CRLF line endings in the files it adds to", () => {
    const pkgText = '{\r\n  "name": "ours",\r\n  "devDependencies": {}\r\n}\r\n';
    const dir = repo({ "package.json": pkgText, ".mcp.json": '{\r\n  "mcpServers": {}\r\n}\r\n', ".gitignore": "dist/\r\nnode_modules/\r\n" });
    init(dir, { pieces: ["test-kit"] });
    for (const f of ["package.json", ".mcp.json", ".gitignore"]) expect(read(dir, f).replaceAll("\r\n", ""), f).not.toContain("\n");
    expect(read(dir, ".gitignore")).toBe("dist/\r\nnode_modules/\r\n.foreman/\r\n");
    const tarball = TEST_KIT_TGZ.exec(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/test-kit"])![1];
    expect(read(dir, "package.json")).toBe(`{\r\n  "name": "ours",\r\n  "devDependencies": {\r\n    "@foreman-kit/test-kit": "file:${tarball}"\r\n  }\r\n}\r\n`);
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman).toEqual(FOREMAN_SERVER);
    // A CRLF .gitignore that already ignores it is kept.
    const ignored = repo({ ".gitignore": ".foreman/\r\n" });
    init(ignored);
    expect(read(ignored, ".gitignore")).toBe(".foreman/\r\n");
  });

  test("creates .mcp.json and .gitignore when the repo has neither", () => {
    const dir = repo({ "package.json": '{ "name": "ours" }' });
    const changes = init(dir);
    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { foreman: FOREMAN_SERVER } });
    expect(read(dir, ".gitignore")).toBe(".foreman/\n");
    expect(read(dir, "package.json")).toBe('{ "name": "ours" }');
    for (const path of [".mcp.json", ".gitignore"]) expect(changes).toContainEqual(expect.objectContaining({ action: "created", path }));
  });

  test.each([".foreman", ".foreman/", "/.foreman/"])("keeps what's already there: a foreman server, %s ignored, a Tasks section", (entry) => {
    const mine = {
      ".mcp.json": JSON.stringify({ mcpServers: { foreman: { command: "our-foreman" } } }),
      ".gitignore": `dist/\n${entry}\n`,
      "AGENTS.md": "# Ours\n\n## Tasks\nWe track work on paper.\n",
      "foreman.json": '{ "protectedPaths": [] }\n',
    };
    const dir = repo(mine);
    const changes = init(dir);
    for (const [f, text] of Object.entries(mine)) expect(read(dir, f), f).toBe(text);
    for (const path of Object.keys(mine)) expect(changes, path).toContainEqual(expect.objectContaining({ action: "kept", path }));
  });

  test.each([
    [".mcp.json", "{ not json", "is not valid JSON"],
    [".mcp.json", "[]", "is not a JSON object"],
    ["package.json", "{,}", "is not valid JSON"],
    ["package.json", "null", "is not a JSON object"],
    [".mcp.json", '{ "mcpServers": [] }', ': "mcpServers" is not a JSON object'],
    [".mcp.json", '{ "mcpServers": "foreman" }', ': "mcpServers" is not a JSON object'],
  ])("a malformed %s (%s) stops init before anything is written", (file, text, message) => {
    const dir = repo({ "package.json": "{}", [file]: text });
    const before = listing(dir);
    expect(() => init(dir)).toThrow(`${file}${message.startsWith(":") ? "" : " "}${message}`);
    expect(listing(dir)).toEqual(before);
    expect(read(dir, file)).toBe(text);
  });

  test("needs a git repository, and refuses one that already has foreman", () => {
    expect(() => init(fresh())).toThrow("not a git repository");
    const dir = repo({});
    init(dir);
    expect(() => init(dir)).toThrow("already there");
  });
});

describe("init: pieces", () => {
  test("docs, guardrails and skills in an existing repo, without overwriting any file it has", () => {
    const mine = {
      "AGENTS.md": "# Ours\n",
      "CLAUDE.md": "Our own notes.\n",
      ".claude/agents/reviewer.md": "our reviewer\n",
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(make *)"] }, model: "x" }),
      ".github/workflows/build.yml": "name: build\n",
      "foreman.json": '{ "protectedPaths": [] }\n',
    };
    const dir = repo(mine);
    const changes = init(dir, { pieces: ["docs", "guardrails", "skills"] });
    for (const [f, text] of Object.entries(mine)) if (![".claude/settings.json", "CLAUDE.md", "AGENTS.md"].includes(f)) expect(read(dir, f), f).toBe(text);
    expect(read(dir, "AGENTS.md")).toBe(`# Ours\n\n${TASKS}`); // only the Tasks section added

    const settings = JSON.parse(read(dir, ".claude/settings.json"));
    expect(settings.model).toBe("x");
    expect(settings.permissions.allow[0]).toBe("Bash(make *)");
    expect(settings.permissions.deny.length).toBeGreaterThan(0); // the baseline was merged in

    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/ship/SKILL.md"))).toBe(true);
    expect(read(dir, "docs/decisions/D0001-agent-kit.md")).toMatch(/^# D0001\. .+ \(\d{4}-\d{2}-\d{2}\)\n\n\*\*Status:\*\* Active/);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(false);
    expect(read(dir, "CLAUDE.md")).toBe("Our own notes.\n@AGENTS.md\n");
    expect(changes).toContainEqual(expect.objectContaining({ action: "merged", path: "CLAUDE.md" }));

    const rec = readInstalled(dir)!;
    expect(rec.pieces).toEqual(["docs", "guardrails", "skills"]);
    expect(rec.files[".claude/hooks/guard.ts"]).toBeDefined();
    expect(rec.files[".claude/agents/reviewer.md"]).toBeUndefined(); // the project's own, not the kit's
    expect(Object.keys(rec.hooks ?? {}).length).toBeGreaterThan(0);
  });

  test("guardrails alone brings settings and hooks but no skills or agents, and skills alone the reverse", () => {
    const g = repo({});
    init(g, { pieces: ["guardrails"] });
    const gFiles = listing(g).filter((f) => f.startsWith(".claude/"));
    expect(gFiles).toContain(".claude/settings.json");
    expect(gFiles).toContain(".claude/hooks/guard.ts");
    expect(gFiles.some((f) => f.startsWith(".claude/skills/") || f.startsWith(".claude/agents/"))).toBe(false);
    expect(Object.keys(readInstalled(g)!.files).every((f) => !f.startsWith(".claude/skills/") && !f.startsWith(".claude/agents/"))).toBe(true);

    const s = repo({});
    init(s, { pieces: ["skills"] });
    const sFiles = listing(s).filter((f) => f.startsWith(".claude/"));
    expect(sFiles).toContain(".claude/skills/ship/SKILL.md");
    expect(sFiles.every((f) => f.startsWith(".claude/skills/") || f.startsWith(".claude/agents/"))).toBe(true);
    expect(readInstalled(s)!.hooks ?? {}).toEqual({});
  });

  test("docs writes the skeletons, and ci a workflow only when there's a check script to run", () => {
    const withCheck = repo({ "package.json": JSON.stringify({ scripts: { check: "bun test" } }) });
    init(withCheck, { name: "thing", pieces: ["docs", "ci"] });
    expect(read(withCheck, "AGENTS.md")).toStartWith("# thing\n");
    expect(read(withCheck, "AGENTS.md")).toContain("## Commands");
    expect(read(withCheck, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(withCheck, ".github/workflows/ci.yml")).toContain("bun run check");
    expect(count(read(withCheck, "AGENTS.md"), "## Tasks")).toBe(1); // the skeleton gets the Tasks section too
    // docs with a package.json: docs-check vendored and a docs:check script.
    const pkg = JSON.parse(read(withCheck, "package.json"));
    expect(pkg.devDependencies["@foreman-kit/docs-check"]).toMatch(tarballOf("docs-check"));
    expect(pkg.scripts).toEqual({ check: "bun test", "docs:check": "docs-check" });

    const without = repo({ "package.json": JSON.stringify({ name: "x" }), "docs/decisions/D0007-ours.md": "# D0007. Ours (2026-01-01)\n" });
    const changes = init(without, { pieces: ["docs", "ci"] });
    expect(existsSync(join(without, ".github/workflows/ci.yml"))).toBe(false);
    expect(changes).toContainEqual(expect.objectContaining({ action: "skipped", path: ".github/workflows/ci.yml" }));
    expect(existsSync(join(without, "docs/decisions/D0001-agent-kit.md"))).toBe(false); // it already has decisions
  });

  test("docs without a package.json writes the skeletons and nothing package-shaped", () => {
    const dir = repo({});
    init(dir, { name: "plain", pieces: ["docs"] });
    expect(read(dir, "AGENTS.md")).toStartWith("# plain\n");
    expect(count(read(dir, "AGENTS.md"), "## Tasks")).toBe(1);
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(existsSync(join(dir, ".meta-repo"))).toBe(false);
  });

  test("a kit package is added as one line, in the file's own indent", () => {
    const pkgText = JSON.stringify({ name: "ours", dependencies: { zod: "4.6.7" }, devDependencies: { typescript: "5.9.3" } }, null, 4) + "\n";
    const dir = repo({ "package.json": pkgText });
    const changes = init(dir, { pieces: ["test-kit"] });
    const out = read(dir, "package.json");
    const tarball = TEST_KIT_TGZ.exec(JSON.parse(out).devDependencies["@foreman-kit/test-kit"])?.[1];
    expect(tarball).toBeDefined();
    expect(existsSync(join(dir, tarball!))).toBe(true);
    expect(out).toBe(pkgText.replace('"devDependencies": {', `"devDependencies": {\n        "@foreman-kit/test-kit": "file:${tarball}",`));
    expect(readInstalled(dir)!.files[tarball!]).toBe(sha256(readFileSync(join(dir, tarball!))));
    expect(changes).toContainEqual(expect.objectContaining({ action: "created", path: tarball }));
    expect(changes).toContainEqual(expect.objectContaining({ action: "merged", path: "package.json" }));
  });

  test("reads a package.json with a BOM and keeps the BOM", () => {
    const dir = repo({ "package.json": '﻿{\n  "name": "ours",\n  "scripts": { "check": "bun test" }\n}\n' });
    init(dir, { pieces: ["ci", "test-kit"] });
    const out = read(dir, "package.json");
    expect(out).toStartWith('﻿{\n  "name": "ours"');
    expect(JSON.parse(out.slice(1)).devDependencies["@foreman-kit/test-kit"]).toMatch(TEST_KIT_TGZ);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(true); // its scripts were read too
  });

  test("a package.json with no devDependencies gets a block in two spaces", () => {
    const dir = repo({ "package.json": '{ "name": "ours" }' });
    init(dir, { pieces: ["test-kit"] });
    const tarball = TEST_KIT_TGZ.exec(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/test-kit"])![1];
    expect(read(dir, "package.json")).toBe(`{ "name": "ours",\n  "devDependencies": {\n    "@foreman-kit/test-kit": "file:${tarball}"\n  }\n}`);
  });

  test("a kit package the repo already depends on is kept, in any dependency list", () => {
    for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const text = JSON.stringify({ [key]: { "@foreman-kit/test-kit": "file:../test-kit" } });
      const dir = repo({ "package.json": text });
      const changes = init(dir, { pieces: ["test-kit"] });
      expect(read(dir, "package.json"), key).toBe(text);
      expect(existsSync(join(dir, ".meta-repo/packages")), key).toBe(false);
      expect(changes, key).toContainEqual(expect.objectContaining({ action: "kept", path: "package.json" }));
    }
  });

  test.each(["ci", "test-kit", "design"] as const)("the %s piece is refused without a package.json, before anything is written", (piece) => {
    const dir = repo({ "AGENTS.md": "# Ours\n" });
    const before = listing(dir);
    expect(() => init(dir, { pieces: ["docs", piece] })).toThrow(`the ${piece} piece needs a package.json`);
    expect(listing(dir)).toEqual(before);
    expect(read(dir, "AGENTS.md")).toBe("# Ours\n");
  });

  test("--all without a package.json skips the pieces that need one, with a note, and adds the rest", () => {
    const dir = repo({});
    const changes = init(dir, { all: true });
    expect(readInstalled(dir)!.pieces).toEqual(["docs", "guardrails", "skills"]);
    for (const p of ["ci", "test-kit", "design"]) expect(changes, p).toContainEqual({ action: "skipped", path: p, note: "needs a package.json" });
    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/ship/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(true);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
  });

  test("--all with a package.json adds every piece", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "ours", scripts: { check: "bun test" } }, null, 2) });
    init(dir, { all: true });
    expect(readInstalled(dir)!.pieces).toEqual([...PIECES]);
    const dev = JSON.parse(read(dir, "package.json")).devDependencies;
    for (const pkg of ["docs-check", "test-kit", "design-kit"]) expect(dev[`@foreman-kit/${pkg}`], pkg).toMatch(tarballOf(pkg));
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(true);
    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
  });
});

describe("adding pieces later", () => {
  test("add brings new pieces, keeps the ones it has, and updates the record", () => {
    const dir = repo({});
    init(dir);
    expect(existsSync(join(dir, ".claude"))).toBe(false);

    add(dir, ["guardrails"]);
    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills"))).toBe(false);
    const rec = readInstalled(dir)!;
    expect(rec.pieces).toEqual(["guardrails"]);
    expect(rec.files[".claude/hooks/guard.ts"]).toBeDefined();
    expect(Object.keys(rec.hooks ?? {}).length).toBeGreaterThan(0);

    const changes = add(dir, ["skills", "guardrails"]);
    expect(changes).toContainEqual({ action: "kept", path: "guardrails", note: "already added" });
    expect(existsSync(join(dir, ".claude/skills/ship/SKILL.md"))).toBe(true);
    const after = readInstalled(dir)!;
    expect(after.pieces).toEqual(["guardrails", "skills"]);
    expect(after.files[".claude/hooks/guard.ts"]).toBe(rec.files[".claude/hooks/guard.ts"]);
    expect(after.files[".claude/skills/ship/SKILL.md"]).toBeDefined();
    // The record covers what's there: sync finds it up to date.
    expect(sync(dir).changes).toEqual([]);
  });

  test("add refuses a piece that needs package.json without one, writing nothing; needs a record and a piece", () => {
    const dir = repo({});
    init(dir);
    const before = listing(dir);
    const rec = read(dir, RECORD);
    expect(() => add(dir, ["skills", "design"])).toThrow("the design piece needs a package.json");
    expect(listing(dir)).toEqual(before);
    expect(read(dir, RECORD)).toBe(rec);
    expect(() => add(dir, [])).toThrow("name a piece");
    expect(() => add(repo({}), ["docs"])).toThrow("set up foreman with init first");
  });

  test("add to a project from before pieces counts guardrails and skills as added", () => {
    const dir = repo({});
    init(dir, { pieces: ["guardrails", "skills"] });
    const rec = JSON.parse(read(dir, RECORD));
    delete rec.pieces;
    put(dir, RECORD, JSON.stringify(rec));
    const changes = add(dir, ["skills", "docs"]);
    expect(changes).toContainEqual({ action: "kept", path: "skills", note: "already added" });
    expect(readInstalled(dir)!.pieces).toEqual(["docs", "guardrails", "skills"]);
  });
});

describe("fm init's pieces", () => {
  const quiet = () => {};
  test("--with, --all, or none: the no-terminal default is foreman alone", () => {
    expect(initPieces({}, quiet)).toEqual({ pieces: [], all: false });
    expect(initPieces({ all: true }, quiet)).toEqual({ pieces: [...PIECES], all: true });
    expect(initPieces({ with: "skills,docs" }, quiet)).toEqual({ pieces: ["docs", "skills"], all: false });
    expect(initPieces({ with: "guardrails ci" }, quiet)).toEqual({ pieces: ["guardrails", "ci"], all: false });
    expect(() => initPieces({ with: "docs,nope" }, quiet)).toThrow("unknown piece: nope");
    expect(() => initPieces({ with: "docs", all: true }, quiet)).toThrow("not both");
  });

  test("in a terminal it shows the checklist and takes numbers, names or all", () => {
    const lines: string[] = [];
    const asked: string[] = [];
    const ask = (answer: string | null) => (q: string) => {
      asked.push(q);
      return answer;
    };
    expect(initPieces({ ask: ask("1,3") }, (s) => lines.push(s))).toEqual({ pieces: ["docs", "skills"], all: false });
    expect(lines.join("\n")).toContain("1. docs");
    expect(lines.join("\n")).toContain("6. design");
    expect(asked).toHaveLength(1);
    expect(initPieces({ ask: ask("all") }, quiet).pieces).toEqual([...PIECES]);
    expect(initPieces({ ask: ask(" ") }, quiet).pieces).toEqual([]);
    expect(initPieces({ ask: ask(null) }, quiet).pieces).toEqual([]);
    expect(initPieces({ ask: ask("2 test-kit") }, quiet).pieces).toEqual(["guardrails", "test-kit"]);
    // --with wins over asking.
    expect(initPieces({ with: "design", ask: ask("1") }, quiet).pieces).toEqual(["design"]);
    expect(() => parseAnswer("9")).toThrow("unknown piece");
  });

  test("init on a repo that has foreman adds the chosen pieces; plain init there is refused", () => {
    const dir = repo({});
    const log: string[] = [];
    runKitCommand("init", dir, {}, (s) => log.push(s));
    expect(listing(dir)).toEqual(FOREMAN_ALONE);
    expect(() => runKitCommand("init", dir, {}, quiet)).toThrow("already set up");

    runKitCommand("init", dir, { with: "skills" }, quiet);
    expect(readInstalled(dir)!.pieces).toEqual(["skills"]);
    runKitCommand("init", dir, { ask: () => "2" }, quiet);
    expect(readInstalled(dir)!.pieces).toEqual(["guardrails", "skills"]);
    const nothing: string[] = [];
    runKitCommand("init", dir, { ask: () => "" }, (s) => nothing.push(s));
    expect(nothing).toContain("nothing to add");
    // --all there skips what needs package.json, as init does.
    runKitCommand("init", dir, { all: true }, quiet);
    expect(readInstalled(dir)!.pieces).toEqual(["docs", "guardrails", "skills"]);
  });

  test("a terminal answer picks the pieces for a fresh init", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "ours" }) });
    runKitCommand("init", dir, { ask: () => "2,5" }, quiet);
    expect(readInstalled(dir)!.pieces).toEqual(["guardrails", "test-kit"]);
  });
});

describe("refusing before anything is written", () => {
  test("init, add and sync refuse a repo whose foreman.json needs a newer fm, naming the upgrade command", () => {
    const dir = repo({ "foreman.json": JSON.stringify({ foreman: ">=999.0.0" }) });
    const before = listing(dir);
    expect(() => init(dir, { pieces: ["docs", "guardrails"] })).toThrow("bun add -g @foreman-kit/foreman@latest");
    expect(listing(dir)).toEqual(before);

    // A project set up by this fm, whose foreman.json later asks for a newer one.
    const later = repo({});
    init(later, { pieces: ["skills"] });
    put(later, "foreman.json", JSON.stringify({ ...JSON.parse(read(later, "foreman.json")), foreman: ">=999.0.0" }));
    const set = listing(later);
    const rec = read(later, RECORD);
    expect(() => add(later, ["guardrails"])).toThrow("needs foreman >=999.0.0");
    expect(() => sync(later)).toThrow("needs foreman >=999.0.0");
    expect(() => sync(later, { dryRun: true })).toThrow("needs foreman >=999.0.0");
    expect(listing(later)).toEqual(set);
    expect(read(later, RECORD)).toBe(rec);
  });

  test.each([
    [".claude/settings.json", "{ not json"],
    [".claude/agent-kit.json", '{ "omit": "Bash(x)" }'],
  ])("with guardrails, a malformed %s stops init and add before anything is written", (file, text) => {
    const dir = repo({ [file]: text });
    const before = listing(dir);
    expect(() => init(dir, { pieces: ["docs", "guardrails"] })).toThrow(file);
    expect(listing(dir)).toEqual(before);

    const later = repo({});
    init(later);
    put(later, file, text);
    const set = listing(later);
    const rec = read(later, RECORD);
    expect(() => add(later, ["docs", "guardrails"])).toThrow(file);
    expect(listing(later)).toEqual(set);
    expect(read(later, RECORD)).toBe(rec);
  });
});

describe("docs added after foreman alone", () => {
  test("puts the skeleton above the Tasks section foreman wrote, once", () => {
    const dir = repo({});
    init(dir);
    expect(read(dir, "AGENTS.md")).toBe(TASKS);
    const changes = add(dir, ["docs"], { name: "later" });
    const agents = read(dir, "AGENTS.md");
    expect(agents).toStartWith("# later\n");
    expect(agents).toEndWith(TASKS);
    expect(count(agents, "## Tasks")).toBe(1);
    expect(agents.indexOf("## Rules")).toBeLessThan(agents.indexOf("## Tasks"));
    expect(changes).toContainEqual(expect.objectContaining({ action: "merged", path: "AGENTS.md" }));
    expect(read(dir, "CLAUDE.md")).toBe("@AGENTS.md\n");
  });

  test("an AGENTS.md the project wrote itself is kept as it is", () => {
    const dir = repo({ "AGENTS.md": "# Ours\n" });
    init(dir);
    const ours = read(dir, "AGENTS.md");
    expect(ours).toBe(`# Ours\n\n${TASKS}`);
    add(dir, ["docs"]);
    expect(read(dir, "AGENTS.md")).toBe(ours);
  });
});

describe("init with a single decision log", () => {
  test("adds no D0001 when decisions live in one file", () => {
    const dir = repo({ "docs/decisions/decisions.md": "# Decisions\n\n## D12. Pick bun (2026-01-01)\n" });
    init(dir, { pieces: ["docs"] });
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(false);
  });

  test("follows foreman.json's numbers source", () => {
    const dir = repo({
      "foreman.json": JSON.stringify({ numbers: { decision: { file: "log/adr.md", pattern: "^ADR-(\\d+)" } } }),
      "log/adr.md": "ADR-3 something\n",
    });
    init(dir, { pieces: ["docs"] });
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(false);
  });
});

describe("sync", () => {
  /** A project made by init with the file pieces, and a copy of agent-kit's templates to play the kit's next version. */
  function setup(pieces: ("guardrails" | "skills")[] = ["guardrails", "skills"]) {
    const dir = repo({});
    init(dir, { pieces });
    const kit = join(fresh("kit"), "templates");
    cpSync(TEMPLATES, kit, { recursive: true });
    return { dir, kit };
  }
  /** The kit's next version: one skill, one agent, one hook and one baseline rule changed. */
  function bump(kit: string) {
    put(kit, "claude/agents/reviewer.md", "reviewer v2\n");
    put(kit, "claude/skills/ship/SKILL.md", "ship v2\n");
    put(kit, "claude/hooks/guard.ts", "// guard v2\n");
    const baseline = JSON.parse(read(kit, "claude/settings.json"));
    baseline.permissions.deny.push("Bash(new-danger *)");
    put(kit, "claude/settings.json", JSON.stringify(baseline));
  }

  test("updates what the project left alone, keeps what it changed or deleted, adds what's new", () => {
    const { dir, kit } = setup();
    put(kit, "claude/agents/reviewer.md", "reviewer v2\n"); // project left it alone
    put(kit, "claude/agents/test-writer.md", "test-writer v2\n"); // project changed it
    put(dir, ".claude/agents/test-writer.md", "our test-writer\n");
    put(kit, "claude/agents/docs-writer.md", "docs-writer v2\n"); // project deleted it
    unlinkSync(join(dir, ".claude/agents/docs-writer.md"));
    put(kit, "claude/agents/new-agent.md", "new\n");
    unlinkSync(join(kit, "claude/skills/verify/SKILL.md")); // dropped from the kit

    const r = sync(dir, { templates: kit });
    const by = Object.fromEntries(r.changes.map((c) => [c.path, c.action]));
    expect(by).toEqual({
      ".claude/agents/reviewer.md": "updated",
      ".claude/agents/test-writer.md": "kept",
      ".claude/agents/docs-writer.md": "deleted",
      ".claude/agents/new-agent.md": "created",
      ".claude/skills/verify/SKILL.md": "removed",
    });
    expect(read(dir, ".claude/agents/reviewer.md")).toBe("reviewer v2\n");
    expect(read(dir, ".claude/agents/test-writer.md")).toBe("our test-writer\n");
    expect(existsSync(join(dir, ".claude/agents/docs-writer.md"))).toBe(false);
    expect(read(dir, ".claude/agents/new-agent.md")).toBe("new\n");
    expect(existsSync(join(dir, ".claude/skills/verify/SKILL.md"))).toBe(true); // never deleted

    const rec = readInstalled(dir)!;
    expect(rec.files[".claude/agents/reviewer.md"]).toBe(sha256("reviewer v2\n"));
    expect(rec.files[".claude/skills/verify/SKILL.md"]).toBeUndefined();
    expect(rec.files[".claude/agents/docs-writer.md"]).toBeDefined(); // so the deletion stays respected

    // A second run changes nothing it didn't already report.
    const again = sync(dir, { templates: kit }).changes.map((c) => c.action);
    expect(again.sort()).toEqual(["deleted", "kept"]);
    // Once the project's file matches the kit again, it's tracked again.
    put(dir, ".claude/agents/test-writer.md", "test-writer v2\n");
    expect(sync(dir, { templates: kit }).changes.map((c) => c.path)).toEqual([".claude/agents/docs-writer.md"]);
  });

  test("a foreman-only project gets no kit files on sync", () => {
    const dir = repo({});
    init(dir);
    const kit = join(fresh("kit"), "templates");
    cpSync(TEMPLATES, kit, { recursive: true });
    bump(kit);
    const before = listing(dir);
    expect(sync(dir).changes).toEqual([]);
    expect(sync(dir, { templates: kit }).changes).toEqual([]);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(listing(dir)).toEqual(before);
  });

  test("touches only the recorded pieces' files: guardrails alone gets the hook and the rules, not the skills", () => {
    const { dir, kit } = setup(["guardrails"]);
    bump(kit);
    const r = sync(dir, { templates: kit });
    const by = Object.fromEntries(r.changes.map((c) => [c.path, c.action]));
    expect(by).toEqual({ ".claude/settings.json": "merged", ".claude/hooks/guard.ts": "updated" });
    expect(existsSync(join(dir, ".claude/skills"))).toBe(false);
    expect(existsSync(join(dir, ".claude/agents"))).toBe(false);

    const s = setup(["skills"]);
    bump(s.kit);
    const sr = sync(s.dir, { templates: s.kit });
    expect(Object.fromEntries(sr.changes.map((c) => [c.path, c.action]))).toEqual({ ".claude/agents/reviewer.md": "updated", ".claude/skills/ship/SKILL.md": "updated" });
    expect(existsSync(join(s.dir, ".claude/settings.json"))).toBe(false);
    expect(existsSync(join(s.dir, ".claude/hooks"))).toBe(false);
  });

  test("a legacy record (.meta-repo/installed.json, no pieces) still syncs every kit file, and stays where it is", () => {
    const { dir, kit } = setup();
    const rec = JSON.parse(read(dir, RECORD));
    delete rec.pieces;
    mkdirSync(join(dir, ".meta-repo"), { recursive: true });
    put(dir, LEGACY_RECORD, JSON.stringify(rec));
    unlinkSync(join(dir, RECORD));
    bump(kit);
    const r = sync(dir, { templates: kit });
    const by = Object.fromEntries(r.changes.map((c) => [c.path, c.action]));
    expect(by).toEqual({
      ".claude/settings.json": "merged",
      ".claude/hooks/guard.ts": "updated",
      ".claude/agents/reviewer.md": "updated",
      ".claude/skills/ship/SKILL.md": "updated",
    });
    expect(existsSync(join(dir, RECORD))).toBe(false);
    const after = JSON.parse(read(dir, LEGACY_RECORD));
    expect(after.files[".claude/skills/ship/SKILL.md"]).toBe(sha256("ship v2\n"));
    expect(after.pieces).toBeUndefined();
  });

  test("updates an installed hook group's matcher to the kit's, unless the project changed it", () => {
    const { dir, kit } = setup();
    // The kit keeps its settings at claude/ (D0023); a project has them at .claude/.
    const at = (d: string) => (d === kit ? "claude/settings.json" : ".claude/settings.json");
    const matcher = (d: string) => JSON.parse(read(d, at(d))).hooks.PreToolUse[0].matcher;
    const setMatcher = (d: string, m: string) => {
      const st = JSON.parse(read(d, at(d)));
      st.hooks.PreToolUse[0].matcher = m;
      put(d, at(d), JSON.stringify(st, null, 2) + "\n");
    };
    const kitMatcher = matcher(kit);
    const old = "Bash|Edit|Write";
    setMatcher(kit, "Bash|Edit|Write|Glob"); // the kit's next version
    const next = matcher(kit);

    // Installed with the kit's matcher at the time: it follows the kit.
    const r = sync(dir, { templates: kit });
    expect(matcher(dir)).toBe(next);
    expect(r.changes).toContainEqual(expect.objectContaining({ action: "updated", path: ".claude/settings.json PreToolUse matcher" }));
    expect(sync(dir, { templates: kit }).changes).toEqual([]);

    // An install from before matchers were recorded (older record): updated, and said so.
    const legacy = repo({});
    init(legacy, { pieces: ["guardrails"] });
    setMatcher(legacy, old);
    const rec = JSON.parse(read(legacy, RECORD));
    delete rec.hooks;
    put(legacy, RECORD, JSON.stringify(rec));
    const lr = sync(legacy, { templates: kit });
    expect(matcher(legacy)).toBe(next);
    expect(lr.changes.find((c) => c.path.endsWith("matcher"))?.note).toContain("not recorded");

    // The project edited it: left alone, with a note.
    const edited = repo({});
    init(edited, { pieces: ["guardrails"] });
    setMatcher(edited, "Bash|Read");
    const er = sync(edited, { templates: kit });
    expect(matcher(edited)).toBe("Bash|Read");
    expect(er.changes).toContainEqual(expect.objectContaining({ action: "kept", path: ".claude/settings.json PreToolUse matcher" }));
    expect(kitMatcher).not.toBe(next);
  });

  test("merges new baseline rules into settings.json, honouring the omit list", () => {
    const { dir, kit } = setup();
    const baseline = JSON.parse(read(kit, "claude/settings.json"));
    baseline.permissions.deny.push("Bash(new-danger *)", "Bash(unwanted *)");
    put(kit, "claude/settings.json", JSON.stringify(baseline));
    put(dir, ".claude/agent-kit.json", JSON.stringify({ omit: ["Bash(unwanted *)"] }));
    const r = sync(dir, { templates: kit });
    expect(r.changes).toContainEqual(expect.objectContaining({ action: "merged", path: ".claude/settings.json" }));
    expect(r.changes).toContainEqual(expect.objectContaining({ action: "skipped", path: "Bash(unwanted *)" }));
    const deny: string[] = JSON.parse(read(dir, ".claude/settings.json")).permissions.deny;
    expect(deny).toContain("Bash(new-danger *)");
    expect(deny).not.toContain("Bash(unwanted *)");
  });

  test("a dry run reports the same changes and writes nothing", () => {
    const { dir, kit } = setup();
    put(kit, "claude/agents/reviewer.md", "reviewer v2\n");
    const before = read(dir, RECORD);
    const r = sync(dir, { templates: kit, dryRun: true });
    expect(r.changes).toEqual([{ action: "updated", path: ".claude/agents/reviewer.md" }]);
    expect(read(dir, ".claude/agents/reviewer.md")).not.toBe("reviewer v2\n");
    expect(read(dir, RECORD)).toBe(before);
  });

  test("replaces an outdated vendored package and points package.json at the new one", () => {
    const dir = fresh();
    create(dir, { install: false, git: false });
    const rec = readInstalled(dir)!;
    const current = Object.keys(rec.files).find((f) => f.includes("/docs-check-"))!;
    const old = ".meta-repo/packages/docs-check-000000000000.tgz";
    put(dir, old, "an older build");
    unlinkSync(join(dir, current));
    delete rec.files[current];
    rec.files[old] = sha256("an older build");
    put(dir, RECORD, JSON.stringify(rec));
    put(dir, "package.json", read(dir, "package.json").replace(current, old));

    const r = sync(dir);
    expect(r.reinstall).toBe(true);
    expect(r.changes.map((c) => c.path).sort()).toEqual([current, "package.json"].sort());
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, current))).toBe(true);
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/docs-check"]).toBe(`file:${current}`);
    expect(Object.keys(readInstalled(dir)!.files)).toContain(current);
  });

  test("replaces the tarball a piece vendored at init, like the preset's packages", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "ours" }, null, 2) });
    init(dir, { pieces: ["test-kit"] });
    expect(sync(dir).changes).toEqual([]); // up to date right after init
    const rec = readInstalled(dir)!;
    const current = Object.keys(rec.files).find((f) => f.includes("/test-kit-"))!;
    expect(current).toBeDefined();
    const old = ".meta-repo/packages/test-kit-000000000000.tgz";
    put(dir, old, "an older build");
    unlinkSync(join(dir, current));
    delete rec.files[current];
    rec.files[old] = sha256("an older build");
    put(dir, RECORD, JSON.stringify(rec));
    put(dir, "package.json", read(dir, "package.json").replace(current, old));

    const r = sync(dir);
    expect(r.reinstall).toBe(true);
    expect(r.changes.map((c) => c.path).sort()).toEqual([current, "package.json"].sort());
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, current))).toBe(true);
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/test-kit"]).toBe(`file:${current}`);
    expect(readInstalled(dir)!.files[current]).toBe(sha256(readFileSync(join(dir, current))));
    expect(readInstalled(dir)!.files[old]).toBeUndefined();
  });

  test("needs a record to work from", () => {
    expect(() => sync(repo({}))).toThrow("init");
  });
});

describe("helpers", () => {
  test("addDevDependency adds one line as text, keeping order, indent and inline arrays", () => {
    const dep = '"@foreman-kit/foreman": "file:x.tgz"';
    const add = (text: string) => addDevDependency(text, "@foreman-kit/foreman", "file:x.tgz");
    // Into an existing block, first, in the file's indent.
    expect(add('{\n\t"files": ["a", "b"],\n\t"devDependencies": {\n\t\t"zod": "1"\n\t}\n}\n')).toBe(`{\n\t"files": ["a", "b"],\n\t"devDependencies": {\n\t\t${dep},\n\t\t"zod": "1"\n\t}\n}\n`);
    // Into an empty block.
    expect(add('{\n  "devDependencies": {}\n}\n')).toBe(`{\n  "devDependencies": {\n    ${dep}\n  }\n}\n`);
    expect(add('{\n  "devDependencies": { }\n}\n')).toBe(`{\n  "devDependencies": {\n    ${dep}\n  }\n}\n`);
    // A new block at the end, after the last key.
    expect(add('{\n  "name": "a",\n  "scripts": { "t": "x" }\n}\n')).toBe(`{\n  "name": "a",\n  "scripts": { "t": "x" },\n  "devDependencies": {\n    ${dep}\n  }\n}\n`);
    // An empty object.
    expect(add("{}\n")).toBe(`{\n  "devDependencies": {\n    ${dep}\n  }\n}\n`);
    // CRLF with tabs: the new line uses both.
    expect(add('{\r\n\t"name": "a",\r\n\t"devDependencies": {\r\n\t\t"zod": "1"\r\n\t}\r\n}\r\n')).toBe(`{\r\n\t"name": "a",\r\n\t"devDependencies": {\r\n\t\t${dep},\r\n\t\t"zod": "1"\r\n\t}\r\n}\r\n`);
    // A BOM stays at the start.
    expect(add('﻿{\n  "devDependencies": {\n    "zod": "1"\n  }\n}\n')).toBe(`﻿{\n  "devDependencies": {\n    ${dep},\n    "zod": "1"\n  }\n}\n`);
    // Every result parses and has the dependency.
    for (const t of ['{"devDependencies":{"a":"1"}}', '{ "a": 1 }', '﻿{\n  "a": 1\n}\n']) {
      expect(JSON.parse(add(t).replace(/^﻿/, "")).devDependencies["@foreman-kit/foreman"], t).toBe("file:x.tgz");
    }
  });

  test("addDevDependency falls back to a JSON rewrite when the text edit wouldn't parse", () => {
    // A "devDependencies" key inside a string value fools the text edit.
    const text = '{\n  "description": "see \\"devDependencies\\": {} below",\n  "name": "a"\n}\n';
    const out = addDevDependency(text, "@foreman-kit/foreman", "file:x.tgz");
    const pkg = JSON.parse(out);
    expect(pkg.devDependencies).toEqual({ "@foreman-kit/foreman": "file:x.tgz" });
    expect(pkg.description).toBe('see "devDependencies": {} below');
    expect(pkg.name).toBe("a");
  });

  test("workspace deps are found and only our dep values are rewritten", () => {
    const text = '{\n  "devDependencies": {\n    "@foreman-kit/docs-check": "workspace:*",\n    "@foreman-kit/other": "1.0.0",\n    "zod": "workspace:*"\n  }\n}\n';
    expect(workspaceDeps(text)).toEqual(["docs-check"]);
    const out = pointDep(text, "docs-check", ".meta-repo/packages/docs-check-abc123abc123.tgz");
    expect(out).toBe(text.replace('"workspace:*",', '"file:.meta-repo/packages/docs-check-abc123abc123.tgz",'));
    expect(pointDep(out, "docs-check", ".meta-repo/packages/docs-check-ffffffffffff.tgz")).toContain("docs-check-ffffffffffff.tgz");
    expect(pointDep(text, "other", "x.tgz")).toBe(text); // a version we didn't vendor is left alone
  });

  test("the scope comes from foreman's package name and matches the hooks' copy, and a project made under the old scope still syncs", async () => {
    expect(SCOPE).toBe("@foreman-kit");
    expect(SCOPE).toBe((await import(join(TEMPLATES, "claude", "hooks", "scope.ts"))).SCOPE);
    // The MCP server is the person's own fm, whatever the scope (D0026).
    expect(FOREMAN_SERVER).toEqual({ type: "stdio", command: "fm", args: ["mcp"] });
    // Before D0026 the packages were @meta-repo/*: sync repoints that project's tarball and keeps its name.
    const text = '{\n  "devDependencies": {\n    "@meta-repo/foreman": "file:.meta-repo/packages/foreman-000000000000.tgz",\n    "@meta-repo/docs-check": "workspace:*"\n  }\n}\n';
    const out = pointDep(text, "foreman", ".meta-repo/packages/foreman-abc123abc123.tgz");
    expect(out).toBe(text.replace("foreman-000000000000", "foreman-abc123abc123"));
    expect(workspaceDeps(text)).toEqual([]); // a preset only takes packages from the workspace by the current scope
  });
});

describe("the person's registry (T-0077)", () => {
  test("init leaves a sentinel registry untouched", async () => {
    const home = join(base, "sentinel-home");
    const sentinel = join(home, ".config", "foreman", "projects.json");
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, '{"projects":["/sentinel"]}\n');
    const saved = { HOME: process.env.HOME, X: process.env.XDG_CONFIG_HOME, F: process.env.FOREMAN_PROJECTS_FILE };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.FOREMAN_PROJECTS_FILE;
    try {
      const dir = join(base, "registry-init");
      mkdirSync(dir, { recursive: true });
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "package.json"), '{"name":"x","private":true}\n');
      init(dir);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.X !== undefined) process.env.XDG_CONFIG_HOME = saved.X;
      if (saved.F !== undefined) process.env.FOREMAN_PROJECTS_FILE = saved.F;
    }
    expect(await Bun.file(sentinel).text()).toBe('{"projects":["/sentinel"]}\n');
  });
});
