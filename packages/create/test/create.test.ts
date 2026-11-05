import { TEMPLATES } from "@meta-repo/agent-kit";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, init, sync } from "../src/index";
import { FOREMAN_SERVER, kitFiles, ownTemplate, pointDep, RECORD, readInstalled, sha256, workspaceDeps } from "../src/kit";

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

const base = mkdtempSync(join(tmpdir(), "meta-repo-create-"));
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
      const spec: string = pkg.devDependencies[`@meta-repo/${dep}`];
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
    const tarball = FOREMAN_TGZ.exec(pkg.devDependencies["@meta-repo/foreman"])?.[1];
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
    expect(existsSync(join(dir, "node_modules/.bin/foreman"))).toBe(true);
    const next = Bun.spawnSync(["bun", "node_modules/.bin/foreman", "next", "--json"], { cwd: dir, env: plainEnv(), stdout: "pipe", stderr: "pipe", timeout: 30_000 });
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
    const tarball = FOREMAN_TGZ.exec(pkg.devDependencies["@meta-repo/foreman"])?.[1];
    expect(tarball).toBeDefined();
    expect(existsSync(join(dir, tarball!))).toBe(true);
    expect(pkg.dependencies).toEqual({ zod: "4.6.7" });
    expect(pkg.devDependencies.typescript).toBe("5.9.3");
    expect(out).toStartWith('{\n    "name"'); // its indent kept
    expect(out).toEndWith("}\n");
    expect(readInstalled(dir)!.files[tarball!]).toBe(sha256(readFileSync(join(dir, tarball!))));

    expect(JSON.parse(read(dir, ".mcp.json")).mcpServers).toEqual({ other: { type: "stdio", command: "other-server" }, foreman: FOREMAN_SERVER });
    expect(read(dir, ".gitignore")).toBe("node_modules\n.foreman/\n");
    expect(read(dir, "AGENTS.md")).toBe(`# Ours\n\n## Rules\n- Be kind.\n\n${TASKS}`);

    const by = Object.fromEntries(changes.filter((c) => ["package.json", ".mcp.json", ".gitignore", "AGENTS.md", tarball].includes(c.path)).map((c) => [c.path, c.action]));
    expect(by).toEqual({ [tarball!]: "created", "package.json": "merged", ".mcp.json": "merged", ".gitignore": "merged", "AGENTS.md": "merged" });
  });

  test("creates .mcp.json and .gitignore when the repo has neither", () => {
    const dir = repo({ "package.json": '{ "name": "ours" }' });
    const changes = init(dir);
    expect(JSON.parse(read(dir, ".mcp.json"))).toEqual({ mcpServers: { foreman: FOREMAN_SERVER } });
    expect(read(dir, ".gitignore")).toBe(".foreman/\n");
    expect(read(dir, "package.json")).toStartWith('{\n  "name"'); // no nested line to copy: two spaces
    for (const path of [".mcp.json", ".gitignore"]) expect(changes).toContainEqual(expect.objectContaining({ action: "created", path }));
  });

  test.each([".foreman", ".foreman/", "/.foreman/"])("keeps what's already there: a foreman dependency, a foreman server, %s ignored, a Tasks section", (entry) => {
    const mine = {
      "package.json": JSON.stringify({ dependencies: { "@meta-repo/foreman": "1.2.3" } }),
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
      const text = JSON.stringify({ [key]: { "@meta-repo/foreman": "file:../foreman" } });
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
  ])("a malformed %s (%s) stops init before anything is written", (file, text, message) => {
    const dir = repo({ "package.json": "{}", [file]: text });
    const before = listing(dir);
    expect(() => init(dir)).toThrow(`${file} ${message}`);
    expect(listing(dir)).toEqual(before);
    expect(read(dir, file)).toBe(text);
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
    put(kit, ".claude/agents/reviewer.md", "reviewer v2\n"); // project left it alone
    put(kit, ".claude/agents/test-writer.md", "test-writer v2\n"); // project changed it
    put(dir, ".claude/agents/test-writer.md", "our test-writer\n");
    put(kit, ".claude/agents/docs-writer.md", "docs-writer v2\n"); // project deleted it
    unlinkSync(join(dir, ".claude/agents/docs-writer.md"));
    put(kit, ".claude/agents/new-agent.md", "new\n");
    unlinkSync(join(kit, ".claude/skills/verify/SKILL.md")); // dropped from the kit

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

  test("merges new baseline rules into settings.json, honouring the omit list", () => {
    const { dir, kit } = setup();
    const baseline = JSON.parse(read(kit, ".claude/settings.json"));
    baseline.permissions.deny.push("Bash(new-danger *)", "Bash(unwanted *)");
    put(kit, ".claude/settings.json", JSON.stringify(baseline));
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
    put(kit, ".claude/agents/reviewer.md", "reviewer v2\n");
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
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@meta-repo/docs-check"]).toBe(`file:${current}`);
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
    expect(JSON.parse(read(dir, "package.json")).devDependencies["@meta-repo/foreman"]).toBe(`file:${current}`);
    expect(readInstalled(dir)!.files[current]).toBe(sha256(readFileSync(join(dir, current))));
    expect(readInstalled(dir)!.files[old]).toBeUndefined();
  });

  test("needs a record to work from", () => {
    expect(() => sync(repo({}))).toThrow("init");
  });
});

describe("helpers", () => {
  test("workspace deps are found and only our dep values are rewritten", () => {
    const text = '{\n  "devDependencies": {\n    "@meta-repo/docs-check": "workspace:*",\n    "@meta-repo/other": "1.0.0",\n    "zod": "workspace:*"\n  }\n}\n';
    expect(workspaceDeps(text)).toEqual(["docs-check"]);
    const out = pointDep(text, "docs-check", ".meta-repo/packages/docs-check-abc123abc123.tgz");
    expect(out).toBe(text.replace('"workspace:*",', '"file:.meta-repo/packages/docs-check-abc123abc123.tgz",'));
    expect(pointDep(out, "docs-check", ".meta-repo/packages/docs-check-ffffffffffff.tgz")).toContain("docs-check-ffffffffffff.tgz");
    expect(pointDep(text, "other", "x.tgz")).toBe(text); // a version we didn't vendor is left alone
  });
});
