// T-0029: option values that look like paths, attached -ofile, find -exec arguments,
// and `cd DIR && ...` judged from DIR.
import { describe, expect, test } from "bun:test";
import { type Context, checkCommand } from "../templates/claude/hooks/guard";

const ctx = (over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  ...over,
});
const working = ctx({ taskPaths: () => ["src/**"] });

describe("an option's value that looks like a path is not the script", () => {
  test.each([
    "bash --rcfile ./rc <<'EOF'\ngit push origin main\nEOF",
    "node --require ./hook.js <<'EOF'\nrequire('fs').readFileSync('.env')\nEOF",
    "bun --preload ./setup.ts <<'EOF'\nawait Bun.file('.env').text()\nEOF",
  ])("checked: %s", (cmd) => expect(checkCommand(cmd, ctx())).not.toBeNull());
  test("a real script file still gets the heredoc as data", () => {
    expect(checkCommand("node --require ./hook.js ./tool.js <<'EOF'\nload('.env')\nEOF", ctx())).toBeNull();
  });
  test("--env-file=.env is a .env read", () => {
    expect(checkCommand("node --env-file=.env server.js", ctx())).toContain(".env");
    expect(checkCommand("bun --env-file=.env.example x.ts", ctx())).toBeNull();
  });
});

describe("attached option values", () => {
  test.each(["curl -oother/page.html https://example.com", "wget -Oother/page.html https://example.com"])("blocks: %s", (cmd) =>
    expect(checkCommand(cmd, working)).toContain("outside your task's paths"),
  );
  test("inside the paths is fine", () => {
    expect(checkCommand("curl -osrc/page.html https://example.com", working)).toBeNull();
  });
});

describe("find -exec runs a command of its own", () => {
  test.each([
    "find src -name '*.ts' -exec rm other/x.ts ';'",
    "find src -type f -exec cp {} other/ +",
    "find src -execdir rm -rf build ';'",
  ])("checked: %s", (cmd) => expect(checkCommand(cmd, working)).not.toBeNull());
  test("an exec that writes inside the paths is fine", () => {
    expect(checkCommand("find src -name '*.bak' -exec rm {} ';'", working)).toBeNull();
  });
});

describe("cd DIR && ... is judged from DIR", () => {
  const branches: Record<string, string> = { "/repo": "main", "/repo/.claude/worktrees/x": "feature-x" };
  const c = ctx({ branchAt: (dir) => branches[dir] ?? null, taskPaths: () => ["src/**"] });
  test("a bare push from a feature worktree is allowed, even if the session sits on main", () => {
    expect(checkCommand("cd /repo/.claude/worktrees/x && git push", c)).toBeNull();
    expect(checkCommand("git push", c)).not.toBeNull(); // the session's own cwd is on main
  });
  test("a bare push after cd into a main checkout is refused", () => {
    const fromWorktree = { ...c, cwd: "/repo/.claude/worktrees/x" };
    expect(checkCommand("cd /repo && git push", fromWorktree)).not.toBeNull();
  });
  test("relative writes follow the cd", () => {
    expect(checkCommand("cd src && echo x > ok.txt", c)).toBeNull();
    expect(checkCommand("cd other && echo x > bad.txt", c)).toContain("outside your task's paths");
    expect(checkCommand("cd src && cd ../other && touch y", c)).toContain("outside your task's paths");
  });
});
