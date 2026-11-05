// Deny rules per agent role: the guard matches foreman's resolved rules against every
// command the shell would run and against tool calls; a person's session is unaffected.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, type RoleRule, bashPatternMatches, checkCommand, decide, pathPatternMatches } from "../templates/.claude/hooks/guard";

const rules = (...xs: [string, string][]): RoleRule[] => xs.map(([role, rule]) => ({ role, rule }));
const ctx = (roleRules: RoleRule[] | null, over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  roleRules: () => roleRules,
  ...over,
});

const WORKER = rules(
  ["agent", "Bash(gh pr merge *)"],
  ["agent", "Bash(ssh *)"],
  ["worker", "Bash(npm publish:*)"],
  ["worker", "Read(data/**)"],
  ["worker", "Edit(infra/**)"],
  ["worker", "mcp__deploy"],
  ["worker", "mcp__foreman__mark_merged"],
);
const w = ctx(WORKER);

describe("Bash patterns, as Claude Code matches them", () => {
  test.each([
    ["ssh *", "ssh host true", true],
    ["ssh *", "ssh", true], // a trailing " *" also covers the bare command
    ["ssh *", "sshpass -p x ssh h", false],
    ["ssh*", "sshpass -p x", true],
    ["gh pr merge *", "gh pr merge 1 --merge", true],
    ["gh pr merge *", "gh pr view 1", false],
    ["npm publish:*", "npm publish --tag next", true],
    ["npm publish:*", "npm publish", true],
    ["git push * main", "git push origin main", true],
    ["git push * main", "git push origin main2", false],
    ["npm test", "npm test", true],
    ["npm test", "npm test -- -u", false],
    ["* --prod*", "deploy app --production", true],
    ["a.b (c)", "a.b (c)", true],
    ["a.b", "aXb", false],
  ])("%s vs %s → %s", (pattern, command, hit) => {
    expect(bashPatternMatches(pattern, command)).toBe(hit);
  });
});

describe("path patterns", () => {
  const c = { projectRoot: "/repo", cwd: "/repo" };
  test.each([
    ["data/**", "/repo/data/x.csv", true],
    ["data/**", "data/sub/x.csv", true],
    ["data/**", "/repo/src/data/x.csv", false],
    ["data", "/repo/data/x.csv", true], // a directory covers its contents
    ["*.pem", "/repo/deep/k.pem", true], // no slash: any depth
    ["/infra/**", "/repo/infra/main.tf", true],
    ["//etc/**", "/etc/hosts", true],
    ["//etc/**", "/repo/etc/hosts", false],
  ])("%s vs %s → %s", (pattern, path, hit) => {
    expect(pathPatternMatches(pattern, path, c)).toBe(hit);
  });
});

describe("Bash rules reach every command the shell would run", () => {
  test.each([
    "gh pr merge 1",
    "gh pr merge",
    "ssh host true",
    "bash -c 'ssh host true'",
    'sh -c "cd /tmp && ssh host true"',
    "env -u X gh pr merge 1",
    "FOO=1 gh pr merge 1 --squash",
    "sudo -u root timeout 5 ssh host",
    "nice -n 5 nohup ssh host",
    "/usr/bin/ssh host",
    "command ssh host",
    "echo $(ssh host cat /etc/hosts)",
    "echo `gh pr merge 2`",
    "true && gh pr merge 3 || true",
    "echo 1 | xargs gh pr merge",
    "bash <<'EOF'\nssh host true\nEOF",
    "cat <<EOF\n$(ssh host)\nEOF",
    "eval 'ssh host'",
    "find . -name x -exec ssh {} \\;",
    "npm publish --tag next",
  ])("blocks for a worker: %s", (cmd) => {
    expect(checkCommand(cmd, w)).toMatch(/denied to (agent|worker) sessions by /);
  });

  test.each([
    "gh pr view 1",
    "echo 'ssh host'", // text that mentions it
    "git commit -m 'gh pr merge later'",
    "sshpass -V",
    "cat <<'EOF'\nssh host\nEOF", // a quoted heredoc fed to cat is data
    "ls data",
  ])("allows for a worker: %s", (cmd) => {
    expect(checkCommand(cmd, w)).toBeNull();
  });

  test("the message names the rule and the role", () => {
    expect(checkCommand("ssh host true", w)).toBe("`ssh host true` is denied to agent sessions by Bash(ssh *) (foreman.json roles.agent)");
    expect(checkCommand("npm publish", w)).toContain("denied to worker sessions by Bash(npm publish:*) (foreman.json roles.worker)");
  });

  test("a bare Bash rule denies every command", () => {
    expect(checkCommand("ls", ctx(rules(["intake", "Bash"])))).toContain("by Bash ");
  });

  test("Edit rules also cover shell writes", () => {
    expect(checkCommand("echo x > infra/main.tf", w)).toContain("Edit(infra/**)");
    expect(checkCommand("cp a infra/b", w)).toContain("Edit(infra/**)");
    expect(checkCommand("echo x > src/a.ts 2>/dev/null", w)).toBeNull();
  });
});

describe("tool calls", () => {
  const call = (tool_name: string, tool_input: Record<string, unknown> = {}, c = w) => decide({ tool_name, tool_input }, c)?.deny ?? null;

  test("Read and edit tools by path", () => {
    expect(call("Read", { file_path: "/repo/data/users.csv" })).toContain("Read(data/**)");
    expect(call("Read", { file_path: "/repo/src/a.ts" })).toBeNull();
    for (const tool of ["Edit", "Write", "MultiEdit"]) expect(call(tool, { file_path: "/repo/infra/x.tf" })).toContain("Edit(infra/**)");
    expect(call("NotebookEdit", { notebook_path: "/repo/infra/n.ipynb" })).toContain("Edit(infra/**)");
    expect(call("Write", { file_path: "/repo/src/a.ts" })).toBeNull();
  });

  test("MCP tools: a server rule covers its tools, an exact rule one tool", () => {
    expect(call("mcp__deploy__run")).toContain("mcp__deploy");
    expect(call("mcp__deployer__run")).toBeNull();
    expect(call("mcp__foreman__mark_merged")).toContain("mcp__foreman__mark_merged");
    expect(call("mcp__foreman__claim_task")).toBeNull();
    expect(call("mcp__x__y", {}, ctx(rules(["agent", "mcp__x__*"])))).toContain("mcp__x__*");
  });
});

describe("who the rules apply to", () => {
  test("a person's session (roleRules null) and a guard without roleRules are unaffected", () => {
    for (const c of [ctx(null), { ...ctx(null), roleRules: undefined }]) {
      expect(checkCommand("gh pr merge 1", c)).toBeNull();
      expect(checkCommand("bash -c 'ssh host true'", c)).toBeNull();
      expect(decide({ tool_name: "mcp__deploy__run", tool_input: {} }, c)).toBeNull();
    }
  });

  test("rules that can't be read block every call (fail closed)", () => {
    const broken = ctx(null, {
      roleRules: () => {
        throw new Error("foreman unreachable");
      },
    });
    expect(checkCommand("ls", broken)).toContain("can't read your role's rules: foreman unreachable");
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/repo/a" } }, broken)?.deny).toContain("can't read your role's rules");
    expect(decide({ tool_name: "mcp__x__y", tool_input: {} }, broken)?.deny).toContain("can't read your role's rules");
  });
});

// The acceptance check: one foreman.json roles block, resolved by this tree's foreman,
// enforced by the real hook process.
describe("end to end: hook + foreman policy + foreman.json", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "guard-roles-")));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const hook = join(import.meta.dir, "..", "templates/.claude/hooks/guard.ts");
  const project = join(tmp, "project");
  mkdirSync(project);
  Bun.spawnSync(["git", "init", "-q", project]);
  writeFileSync(
    join(project, "foreman.json"),
    JSON.stringify({
      roles: {
        agent: { deny: ["Bash(gh pr merge *)"] },
        worker: { deny: ["Bash(ssh *)"] },
        verifier: { deny: ["Bash(ssh *)"] },
      },
    }),
  );

  const run = (command: string, actor?: string, over: Record<string, string> = {}) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      FOREMAN_ACTOR: actor,
      FOREMAN_BIN: `bun ${join(repoRoot, "packages/foreman/src/cli.ts")}`,
      FOREMAN_DB: join(tmp, "foreman.db"),
      ...over,
    };
    if (!actor) delete env.FOREMAN_ACTOR;
    const p = Bun.spawnSync(["bun", hook], {
      cwd: project,
      env,
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: project })),
      stderr: "pipe",
    });
    return { code: p.exitCode, stderr: p.stderr.toString() };
  };

  test.each(["gh pr merge 1", "bash -c 'ssh host true'"])("%s: blocked for worker-T-1 and verifier-T-1, allowed with no FOREMAN_ACTOR", (cmd) => {
    for (const actor of ["worker-T-1", "verifier-T-1"]) {
      const r = run(cmd, actor);
      expect({ actor, code: r.code }).toEqual({ actor, code: 2 });
      expect(r.stderr).toMatch(/guard: .* is denied to (agent|worker|verifier) sessions by Bash\((gh pr merge|ssh) \*\)/);
    }
    expect(run(cmd)).toEqual({ code: 0, stderr: "" });
  });

  test("a custom actor name gets only the agent block", () => {
    expect(run("ssh host true", "alice").code).toBe(0);
    expect(run("gh pr merge 1", "alice").code).toBe(2);
  });

  test("FOREMAN_ACTOR set but foreman can't answer: blocked", () => {
    const r = run("ls", "worker-T-1", { FOREMAN_BIN: "false" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("can't read your role's rules");
    expect(run("ls", undefined, { FOREMAN_BIN: "false" }).code).toBe(0);
  });
  // A project made by create or init has foreman only as its installed package, and a
  // session's PATH has no node_modules/.bin: the hook must find it there.
  test("finds the project's node_modules/.bin/foreman when FOREMAN_BIN is unset and the PATH has none", () => {
    const bin = join(tmp, "bin"); // bun alone: this machine's PATH may have a linked foreman next to it
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const env = { FOREMAN_BIN: "", PATH: `${bin}:/usr/bin:/bin` };
    expect(Bun.spawnSync(["sh", "-c", "command -v foreman"], { env }).exitCode).not.toBe(0);

    // Not installed yet: the hook can't find foreman.
    expect(run("ls", "worker-T-1", env).stderr).toContain("foreman isn't installed");

    mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
    symlinkSync(join(repoRoot, "packages/foreman/src/cli.ts"), join(project, "node_modules/.bin/foreman"));
    try {
      expect(run("ls", "worker-T-1", env)).toEqual({ code: 0, stderr: "" });
      const r = run("ssh host true", "worker-T-1", env);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("is denied to worker sessions by Bash(ssh *)");
    } finally {
      rmSync(join(project, "node_modules"), { recursive: true, force: true });
    }
  });
});
