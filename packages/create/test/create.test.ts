import { TEMPLATES } from "@meta-repo/agent-kit";
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create, init, sync } from "../src/index";
import { kitFiles, pointDep, RECORD, readInstalled, sha256, workspaceDeps } from "../src/kit";

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

    const without = repo({ "docs/decisions/D0007-ours.md": "# D0007. Ours (2026-01-01)\n" });
    const changes = init(without);
    expect(existsSync(join(without, ".github/workflows/ci.yml"))).toBe(false);
    expect(changes).toContainEqual(expect.objectContaining({ action: "skipped", path: ".github/workflows/ci.yml" }));
    expect(existsSync(join(without, "docs/decisions/D0001-agent-kit.md"))).toBe(false); // it already has decisions
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

  test("updates an installed hook group's matcher to the kit's, unless the project changed it", () => {
    const { dir, kit } = setup();
    const matcher = (d: string) => JSON.parse(read(d, ".claude/settings.json")).hooks.PreToolUse[0].matcher;
    const setMatcher = (d: string, m: string) => {
      const st = JSON.parse(read(d, ".claude/settings.json"));
      st.hooks.PreToolUse[0].matcher = m;
      put(d, ".claude/settings.json", JSON.stringify(st, null, 2) + "\n");
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
