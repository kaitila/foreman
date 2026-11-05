import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type Context, checkCommand, decide, parseShell } from "../templates/claude/hooks/guard";

const ctx = (over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  ...over,
});
const bash = (command: string, c = ctx()) => checkCommand(command, c);

describe("shell parsing", () => {
  test("quotes, separators, substitutions, redirections", () => {
    expect(parseShell(`git commit -m "a; b" && echo 'x|y'`)).toEqual([
      ["git", "commit", "-m", "a; b"],
      ["echo", "x|y"],
    ]);
    expect(parseShell("cat < .env")).toEqual([["cat", ".env"]]);
    expect(parseShell("echo $(git push origin main)")).toEqual([
      ["git", "push", "origin", "main"],
      ["echo", "$(...)"],
    ]);
  });
});

describe("git", () => {
  test.each([
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin feature:refs/heads/main",
    "git -C . push origin main",
    "git -c push.default=current push origin master",
    "git 'push' origin main",
    "timeout 30 git push origin main",
    "FOO=1 git push origin main",
    "bash -c 'git push origin main'",
    "sh -c \"cd /repo && git push origin main\"",
    "git push --force origin feature-x",
    "git push -fu origin feature-x",
    "git push --force-with-lease origin feature-x",
    "git push origin +feature-x",
    "git push origin :old-branch",
    "git push --no-verify origin feature-x",
    "git commit --no-verify -m wip",
    "git commit -nm wip",
    "git commit -an -m wip",
    "git reset --hard HEAD~1",
    "git clean -fdx",
  ])("blocks: %s", (cmd) => {
    expect(bash(cmd)).not.toBeNull();
  });

  test("a bare push (or HEAD) from main is blocked, from a branch it isn't", () => {
    const onMain = ctx({ branchAt: () => "main" });
    expect(bash("git push", onMain)).not.toBeNull();
    expect(bash("git push origin HEAD", onMain)).not.toBeNull();
    expect(bash("git push")).toBeNull();
    expect(bash("git push -u origin HEAD")).toBeNull();
  });

  test.each([
    "git push -u origin feature-x",
    "git push origin feature-x:feature-x",
    "git commit -m 'mention --no-verify in text is fine'",
    "git commit -m 'note: n is just a letter here' -a",
    "git commit -am 'msg with n'",
    "git status",
    "git log --oneline -5",
    "git reset --soft HEAD~1",
  ])("allows: %s", (cmd) => {
    expect(bash(cmd)).toBeNull();
  });
});

describe("rm", () => {
  test.each(["rm -rf node_modules", "rm -Rf dist", "rm -r -f x", "rm --recursive --force x", "/bin/rm -fr x", "sudo rm -rf /"])(
    "blocks: %s",
    (cmd) => expect(bash(cmd)).not.toBeNull(),
  );
  test.each(["rm file.txt", "rm -f file.txt", "rm -r emptydir"])("allows: %s", (cmd) => expect(bash(cmd)).toBeNull());
});

describe(".env", () => {
  test.each([
    "cat .env",
    "head -1 ./.env",
    "cat < .env",
    "cp .env /tmp/x",
    "grep TOKEN apps/web/.env.local",
    "bash -c 'cat .env'",
    `bun -e 'console.log(await Bun.file(".env").text())'`,
    `python3 -c "print(open('.env').read())"`,
    `node -e "require('fs').readFileSync('.env.production','utf8')"`,
  ])("blocks: %s", (cmd) => expect(bash(cmd)).not.toBeNull());

  test.each([
    "cat .env.example",
    `git commit -m "ignore .env files"`,
    `bun packages/foreman/src/cli.ts verdict T-1 --result 'c2:pass:cat .env was denied'`,
    "echo .env >> .gitignore",
    "ls -la",
  ])("allows (the false positive the rules had): %s", (cmd) => expect(bash(cmd)).toBeNull());

  test("Read and Write tools on .env", () => {
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/repo/.env" } }, ctx())).not.toBeNull();
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/repo/.env.example" } }, ctx())).toBeNull();
    expect(decide({ tool_name: "Write", tool_input: { file_path: "/repo/.env.local" } }, ctx())).not.toBeNull();
  });
});

describe("task paths", () => {
  const working = ctx({ taskPaths: () => ["packages/agent-kit/**", "docs/research/R4*.md"] });
  const edit = (file_path: string, c = working) => decide({ tool_name: "Edit", tool_input: { file_path } }, c);

  test("inside the claimed task's paths: allowed", () => {
    expect(edit("/repo/packages/agent-kit/src/install.ts")).toBeNull();
    expect(edit("/repo/docs/research/R4-guardrails-tested.md")).toBeNull();
    expect(edit("/repo/docs/tasks/T-0002.md")).toBeNull(); // always editable: the task's own export
  });
  test("outside them: blocked, with the reason", () => {
    expect(edit("/repo/packages/foreman/src/core.ts")?.deny).toContain("outside your task's paths");
    expect(decide({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/repo/x.ipynb" } }, working)).not.toBeNull();
  });
  test("no claimed task (or one without paths), or a file outside the repo: not restricted", () => {
    expect(edit("/repo/anything.ts", ctx())).toBeNull();
    expect(edit("/tmp/scratch.txt")).toBeNull();
  });
});

test("this repo runs the templates in place: no .claude/ copies to keep equal (D0023)", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const templates = join(import.meta.dir, "..", "templates");
  // No kit source sits under a .claude/ segment, which unattended agents may not edit.
  expect([...new Bun.Glob("**/.claude/**").scanSync({ cwd: templates, dot: true })]).toEqual([]);
  // Skills and agents are links into the templates; the hooks run from the templates (settings.json).
  for (const dir of ["skills", "agents"]) {
    const entries = readdirSync(join(templates, "claude", dir));
    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) {
      const link = join(root, ".claude", dir, e);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(templates, "claude", dir, e)));
    }
  }
  expect(existsSync(join(root, ".claude", "hooks"))).toBe(false);
});

describe("shell writes and task paths (T-0013)", () => {
  const working = ctx({ taskPaths: () => ["src/**"] });
  test.each([
    "echo x > other/file.txt",
    "echo x >> other/file.txt",
    "printf x 2> other/err.log",
    "cat a | tee other/copy.txt",
    "cp src/a.ts other/a.ts",
    "mv src/a.ts other/",
    "cp -t other src/a.ts",
    "install -m 644 src/a other/a",
    "touch other/new.txt",
    "sed -i 's/a/b/' other/x.ts",
    "sed -i.bak -e 's/a/b/' other/x.ts",
    "bash -c 'echo x > other/f'",
    "echo SECRET=1 > .env",
  ])("blocks: %s", (cmd) => {
    expect(checkCommand(cmd, working)).not.toBeNull();
  });
  test.each([
    "echo x > src/file.txt",
    "cp other/a.ts src/a.ts",
    "sed -i 's/a/b/' src/x.ts",
    "bun test 2>&1 | tail -5",
    "echo x > /dev/null",
    "echo x > /tmp/scratch.txt",
    "cat other/readme.md", // reading outside the paths is fine
    "touch docs/tasks/T-0013.md",
  ])("allows: %s", (cmd) => {
    expect(checkCommand(cmd, working)).toBeNull();
  });
  test("no claimed task: shell writes aren't restricted", () => {
    expect(checkCommand("echo x > other/file.txt", ctx())).toBeNull();
  });
});

describe("fail closed when task paths can't be known (T-0012)", () => {
  const broken = ctx({
    taskPaths: () => {
      throw new Error("FOREMAN_ACTOR is set but foreman isn't installed");
    },
  });
  test("edits and shell writes in the repo are blocked with a reason naming foreman", () => {
    const d = decide({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } }, broken);
    expect(d?.deny).toContain("foreman");
    expect(checkCommand("echo x > src/a.ts", broken)).toContain("foreman");
  });
  test("reads, commands without writes and files outside the repo still work", () => {
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/repo/src/a.ts" } }, broken)).toBeNull();
    expect(checkCommand("git status", broken)).toBeNull();
    expect(decide({ tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, broken)).toBeNull();
  });
  test("realContext: actor set + foreman failing throws; no actor means no restriction", async () => {
    const { realContext } = await import("../templates/claude/hooks/guard");
    const saved = { a: process.env.FOREMAN_ACTOR, b: process.env.FOREMAN_BIN };
    try {
      process.env.FOREMAN_ACTOR = "w1";
      process.env.FOREMAN_BIN = "false"; // a command that always fails
      expect(() => realContext(process.cwd()).taskPaths()).toThrow(/failed/);
      delete process.env.FOREMAN_ACTOR;
      expect(realContext(process.cwd()).taskPaths()).toBeNull();
    } finally {
      if (saved.a === undefined) delete process.env.FOREMAN_ACTOR;
      else process.env.FOREMAN_ACTOR = saved.a;
      if (saved.b === undefined) delete process.env.FOREMAN_BIN;
      else process.env.FOREMAN_BIN = saved.b;
    }
  });
});
