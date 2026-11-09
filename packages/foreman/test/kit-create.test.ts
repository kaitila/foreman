import { SCOPE, TEMPLATES } from "../src/kit/install";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addDevDependency } from "../src/kit/create";
import { create, init, sync } from "../src/kit/index";
import { FOREMAN_SERVER, kitFiles, ownTemplate, pointDep, RECORD, readInstalled, sha256, workspaceDeps } from "../src/kit/kit";

const TASKS = ownTemplate("tasks-section.md");
const FOREMAN_TGZ = /^file:(\.meta-repo\/packages\/foreman-[0-9a-f]{12}\.tgz)$/;
const count = (text: string, part: string) => text.split(part).length - 1;
/** The env with no FOREMAN_* settings, so foreman finds its board in the project itself. */
const plainEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FOREMAN_"))) as Record<string, string>;
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
    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    expect(JSON.parse(read(dir, "foreman.json")).protectedPaths).toContain(".claude/**");
    expect(read(dir, ".github/workflows/ci.yml")).toContain("/my_app_test");
    expect(read(dir, ".github/workflows/ci.yml")).not.toMatch(/\{\{\w+\}\}/);

    const rec = readInstalled(dir)!;
    expect(rec.preset).toBe("bun-ts-postgres");
    expect(Object.keys(rec.files)).toEqual(expect.arrayContaining([...kitFiles().keys()]));
    expect(Object.keys(rec.files)).not.toContain(".claude/settings.json"); // merged, never hashed
    for (const [f, hash] of Object.entries(rec.files)) expect(sha256(readFileSync(join(dir, f))), f).toBe(hash);

    expect(git(dir, "log", "--format=%s").trim().split("\n")).toHaveLength(1);
    expect(git(dir, "status", "--porcelain")).toBe("");
    // Right after create, the project is up to date with the kit.
    expect(sync(dir).changes).toEqual([]);
  });

  test("the new project has foreman: vendored, its MCP server, .foreman/ ignored, a Tasks section, and it runs", () => {
    const dir = fresh("tasks-app");
    create(dir); // with bun install and the first commit, so the installed foreman is the one that runs
    const pkg = JSON.parse(read(dir, "package.json"));
    const tarball = FOREMAN_TGZ.exec(pkg.devDependencies["@foreman-kit/foreman"])?.[1];
    expect(tarball).toBeDefined();
    expect(existsSync(join(dir, tarball!))).toBe(true);
    expect(readInstalled(dir)!.files[tarball!]).toBe(sha256(readFileSync(join(dir, tarball!))));

    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman).toEqual(FOREMAN_SERVER);
    expect(read(dir, ".gitignore").split("\n")).toContain(".foreman/");
    const agents = read(dir, "AGENTS.md");
    expect(count(agents, "## Tasks")).toBe(1);
    expect(agents).toContain(TASKS);
    expect(agents.indexOf("## Tasks")).toBeLessThan(agents.indexOf("## Rules"));

    // The installed package answers, from its CLI and as the MCP server .mcp.json starts.
    const cli = FOREMAN_SERVER.args[0]!;
    expect(existsSync(join(dir, cli))).toBe(true);
    const next = Bun.spawnSync(["bun", cli, "next", "--json"], { cwd: dir, env: plainEnv(), stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect({ code: next.exitCode, err: next.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(next.stdout.toString())).toEqual([]);

    const hello = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    const mcp = Bun.spawnSync([FOREMAN_SERVER.command, ...FOREMAN_SERVER.args], {
      cwd: dir,
      env: plainEnv(),
      stdin: new TextEncoder().encode(JSON.stringify(hello) + "\n"),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const reply = JSON.parse(mcp.stdout.toString().trim().split("\n")[0]!);
    expect(reply.id).toBe(1);
    expect(reply.result.serverInfo.name).toBe("foreman");

    // foreman's board landed in .foreman/, which git ignores.
    expect(existsSync(join(dir, ".foreman"))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
  }, 180_000);

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

describe("init", () => {
  test("adds the kit to an existing repo without overwriting any file it has", () => {
    const mine = {
      "AGENTS.md": "# Ours\n",
      "CLAUDE.md": "Our own notes.\n",
      ".claude/agents/reviewer.md": "our reviewer\n",
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(make *)"] }, model: "x" }),
      ".github/workflows/build.yml": "name: build\n",
      "foreman.json": '{ "protectedPaths": [] }\n',
    };
    const dir = repo(mine);
    const changes = init(dir);
    for (const [f, text] of Object.entries(mine)) if (f !== ".claude/settings.json" && f !== "CLAUDE.md") expect(read(dir, f), f).toBe(text);

    const settings = JSON.parse(read(dir, ".claude/settings.json"));
    expect(settings.model).toBe("x");
    expect(settings.permissions.allow[0]).toBe("Bash(make *)");
    expect(settings.permissions.deny.length).toBeGreaterThan(0); // the baseline was merged in

    expect(existsSync(join(dir, ".claude/hooks/guard.ts"))).toBe(true);
    expect(read(dir, "docs/decisions/D0001-agent-kit.md")).toMatch(/^# D0001\. .+ \(\d{4}-\d{2}-\d{2}\)\n\n\*\*Status:\*\* Active/);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(false);
    expect(read(dir, "CLAUDE.md")).toBe("Our own notes.\n@AGENTS.md\n");
    expect(changes).toContainEqual(expect.objectContaining({ action: "merged", path: "CLAUDE.md" }));

    const rec = readInstalled(dir)!;
    expect(rec.files[".claude/hooks/guard.ts"]).toBeDefined();
    expect(rec.files[".claude/agents/reviewer.md"]).toBeUndefined(); // the project's own, not the kit's

    expect(() => init(dir)).toThrow("already there");
    expect(() => init(fresh())).toThrow("not a git repository");
  });

  test("appends @AGENTS.md to CLAUDE.md once, and only when it's missing", () => {
    const noNewline = repo({ "CLAUDE.md": "Notes" });
    init(noNewline);
    expect(read(noNewline, "CLAUDE.md")).toBe("Notes\n@AGENTS.md\n");

    const importing = repo({ "CLAUDE.md": "Intro\n@AGENTS.md\nMore" });
    const changes = init(importing);
    expect(read(importing, "CLAUDE.md")).toBe("Intro\n@AGENTS.md\nMore");
    expect(changes.some((c) => c.path === "CLAUDE.md" && c.action === "merged")).toBe(false);
  });

  test("writes the skeletons, and a CI workflow only when there's a check script to run", () => {
    const withCheck = repo({ "package.json": JSON.stringify({ scripts: { check: "bun test" } }) });
    init(withCheck, { name: "thing" });
    expect(read(withCheck, "AGENTS.md")).toStartWith("# thing\n");
    expect(read(withCheck, "AGENTS.md")).toContain("## Commands");
    expect(read(withCheck, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(read(withCheck, ".github/workflows/ci.yml")).toContain("bun run check");
    expect(count(read(withCheck, "AGENTS.md"), "## Tasks")).toBe(1); // the skeleton gets the Tasks section too

    const without = repo({ "docs/decisions/D0007-ours.md": "# D0007. Ours (2026-01-01)\n" });
    const changes = init(without);
    expect(existsSync(join(without, ".github/workflows/ci.yml"))).toBe(false);
    expect(changes).toContainEqual(expect.objectContaining({ action: "skipped", path: ".github/workflows/ci.yml" }));
    expect(existsSync(join(without, "docs/decisions/D0001-agent-kit.md"))).toBe(false); // it already has decisions
  });

  test("on a Bun repo: vendors foreman, merges its MCP server, ignores .foreman/, appends the Tasks section", () => {
    const pkgText = JSON.stringify({ name: "ours", dependencies: { zod: "4.6.7" }, devDependencies: { typescript: "5.9.3" } }, null, 4) + "\n";
    const dir = repo({
      "package.json": pkgText,
      ".mcp.json": JSON.stringify({ mcpServers: { other: { type: "stdio", command: "other-server" } } }),
      ".gitignore": "node_modules",
      "AGENTS.md": "# Ours\n\n## Rules\n- Be kind.\n",
    });
    const changes = init(dir);

    const out = read(dir, "package.json");
    const pkg = JSON.parse(out);
    const tarball = FOREMAN_TGZ.exec(pkg.devDependencies["@foreman-kit/foreman"])?.[1];
    expect(tarball).toBeDefined();
    expect(existsSync(join(dir, tarball!))).toBe(true);
    // One line added, in the file's own indent; the rest of the text untouched.
    expect(out).toBe(pkgText.replace('"devDependencies": {', `"devDependencies": {\n        "@foreman-kit/foreman": "file:${tarball}",`));
    expect(readInstalled(dir)!.files[tarball!]).toBe(sha256(readFileSync(join(dir, tarball!))));

    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers).toEqual({ other: { type: "stdio", command: "other-server" }, foreman: FOREMAN_SERVER });
    expect(read(dir, ".gitignore")).toBe("node_modules\n.foreman/\n");
    expect(read(dir, "AGENTS.md")).toBe(`# Ours\n\n## Rules\n- Be kind.\n\n${TASKS}`);

    const by = Object.fromEntries(changes.filter((c) => ["package.json", ".mcp.json", ".gitignore", "AGENTS.md", tarball].includes(c.path)).map((c) => [c.path, c.action]));
    expect(by).toEqual({ [tarball!]: "created", "package.json": "merged", ".mcp.json": "merged", ".gitignore": "merged", "AGENTS.md": "merged" });
  });

  test("keeps CRLF line endings in the files it adds to", () => {
    const pkgText = '{\r\n  "name": "ours",\r\n  "devDependencies": {}\r\n}\r\n';
    const dir = repo({ "package.json": pkgText, ".mcp.json": '{\r\n  "mcpServers": {}\r\n}\r\n', ".gitignore": "dist/\r\nnode_modules/\r\n" });
    init(dir);
    for (const f of ["package.json", ".mcp.json", ".gitignore"]) expect(read(dir, f).replaceAll("\r\n", ""), f).not.toContain("\n");
    expect(read(dir, ".gitignore")).toBe("dist/\r\nnode_modules/\r\n.foreman/\r\n");
    const tarball = FOREMAN_TGZ.exec(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/foreman"])![1];
    expect(read(dir, "package.json")).toBe(`{\r\n  "name": "ours",\r\n  "devDependencies": {\r\n    "@foreman-kit/foreman": "file:${tarball}"\r\n  }\r\n}\r\n`);
    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers.foreman).toEqual(FOREMAN_SERVER);
    // A CRLF .gitignore that already ignores it is kept.
    const ignored = repo({ "package.json": '{ "dependencies": { "@foreman-kit/foreman": "1.0.0" } }', ".gitignore": ".foreman/\r\n" });
    init(ignored);
    expect(read(ignored, ".gitignore")).toBe(".foreman/\r\n");
  });

  test("reads a package.json with a BOM and keeps the BOM", () => {
    const dir = repo({ "package.json": '﻿{\n  "name": "ours",\n  "scripts": { "check": "bun test" }\n}\n' });
    init(dir);
    const out = read(dir, "package.json");
    expect(out).toStartWith('﻿{\n  "name": "ours"');
    expect(JSON.parse(out.slice(1)).devDependencies["@foreman-kit/foreman"]).toMatch(FOREMAN_TGZ);
    expect(existsSync(join(dir, ".github/workflows/ci.yml"))).toBe(true); // its scripts were read too
  });

  test("the foreman.json it writes protects .mcp.json", () => {
    const dir = fresh();
    create(dir, { install: false, git: false });
    expect(JSON.parse(read(dir, "foreman.json")).protectedPaths).toContain(".mcp.json");
  });

  test("creates .mcp.json and .gitignore when the repo has neither", () => {
    const dir = repo({ "package.json": '{ "name": "ours" }' });
    const changes = init(dir);
    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { foreman: FOREMAN_SERVER } });
    expect(read(dir, ".gitignore")).toBe(".foreman/\n");
    const tarball = FOREMAN_TGZ.exec(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/foreman"])![1];
    // No devDependencies and no nested line to copy the indent from: a block in two spaces.
    expect(read(dir, "package.json")).toBe(`{ "name": "ours",\n  "devDependencies": {\n    "@foreman-kit/foreman": "file:${tarball}"\n  }\n}`);
    for (const path of [".mcp.json", ".gitignore"]) expect(changes).toContainEqual(expect.objectContaining({ action: "created", path }));
  });

  test.each([".foreman", ".foreman/", "/.foreman/"])("keeps what's already there: a foreman dependency, a foreman server, %s ignored, a Tasks section", (entry) => {
    const mine = {
      "package.json": JSON.stringify({ dependencies: { "@foreman-kit/foreman": "1.2.3" } }),
      ".mcp.json": JSON.stringify({ mcpServers: { foreman: { command: "our-foreman" } } }),
      ".gitignore": `dist/\n${entry}\n`,
      "AGENTS.md": "# Ours\n\n## Tasks\nWe track work on paper.\n",
    };
    const dir = repo(mine);
    const changes = init(dir);
    for (const [f, text] of Object.entries(mine)) expect(read(dir, f), f).toBe(text);
    expect(existsSync(join(dir, ".meta-repo/packages"))).toBe(false);
    expect(Object.keys(readInstalled(dir)!.files).some((f) => f.includes("foreman-"))).toBe(false);
    for (const path of Object.keys(mine)) expect(changes, path).toContainEqual(expect.objectContaining({ action: "kept", path }));
  });

  test("a foreman dependency in devDependencies or optionalDependencies is kept too", () => {
    for (const key of ["devDependencies", "optionalDependencies"]) {
      const text = JSON.stringify({ [key]: { "@foreman-kit/foreman": "file:../foreman" } });
      const dir = repo({ "package.json": text });
      init(dir);
      expect(read(dir, "package.json"), key).toBe(text);
    }
  });

  test("without a package.json, foreman is skipped with a note and its files aren't touched", () => {
    const dir = repo({ "AGENTS.md": "# Ours\n" });
    const changes = init(dir);
    const skip = changes.find((c) => c.path === "foreman");
    expect(skip?.action).toBe("skipped");
    expect(skip?.note).toContain("package.json");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(read(dir, "AGENTS.md")).toBe("# Ours\n");
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
});

describe("init with a single decision log", () => {
  test("adds no D0001 when decisions live in one file", () => {
    const dir = repo({ "docs/decisions/decisions.md": "# Decisions\n\n## D12. Pick bun (2026-01-01)\n" });
    init(dir);
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(false);
  });

  test("follows foreman.json's numbers source", () => {
    const dir = repo({
      "foreman.json": JSON.stringify({ numbers: { decision: { file: "log/adr.md", pattern: "^ADR-(\\d+)" } } }),
      "log/adr.md": "ADR-3 something\n",
    });
    init(dir);
    expect(existsSync(join(dir, "docs/decisions/D0001-agent-kit.md"))).toBe(false);
  });
});

describe("sync", () => {
  /** A project made by init, and a copy of agent-kit's templates to play the kit's next version. */
  function setup() {
    const dir = repo({});
    init(dir);
    const kit = join(fresh("kit"), "templates");
    cpSync(TEMPLATES, kit, { recursive: true });
    return { dir, kit };
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
    init(legacy);
    setMatcher(legacy, old);
    const rec = JSON.parse(read(legacy, ".meta-repo/installed.json"));
    delete rec.hooks;
    put(legacy, ".meta-repo/installed.json", JSON.stringify(rec));
    const lr = sync(legacy, { templates: kit });
    expect(matcher(legacy)).toBe(next);
    expect(lr.changes.find((c) => c.path.endsWith("matcher"))?.note).toContain("not recorded");

    // The project edited it: left alone, with a note.
    const edited = repo({});
    init(edited);
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

  test("replaces the foreman tarball init vendored, like the preset's packages", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "ours" }, null, 2) });
    init(dir);
    expect(sync(dir).changes).toEqual([]); // up to date right after init
    const rec = readInstalled(dir)!;
    const current = Object.keys(rec.files).find((f) => f.includes("/foreman-"))!;
    expect(current).toBeDefined();
    const old = ".meta-repo/packages/foreman-000000000000.tgz";
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
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@foreman-kit/foreman"]).toBe(`file:${current}`);
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
    expect(FOREMAN_SERVER.args[0]).toBe(`node_modules/${SCOPE}/foreman/src/cli.ts`);
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
