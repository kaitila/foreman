// Wrapper options that take a value (T-0044): `env -u NAME cmd` used to read NAME as the
// command, which let the real command through unchecked.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type Context, checkCommand, parseShell } from "../templates/.claude/hooks/guard";

const ctx = (over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  ...over,
});
const working = ctx({ taskPaths: () => ["src/**"] });

const REPORTED = `env -u CLAUDE_CODE_CHILD_SESSION FOREMAN_ACTOR=x bun packages/foreman/src/cli.ts add "two words" --spec "more words"`;

describe("env and other wrappers with option values (T-0044)", () => {
  test("quoted args stay one word", () => {
    expect(parseShell(REPORTED)).toEqual([
      ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "FOREMAN_ACTOR=x", "bun", "packages/foreman/src/cli.ts", "add", "two words", "--spec", "more words"],
    ]);
  });

  test.each([
    REPORTED,
    `env -i bun packages/foreman/src/cli.ts add "two words"`,
    `env -- bun packages/foreman/src/cli.ts add "two words"`,
    `env -i -u HOME -- FOREMAN_ACTOR=x bun packages/foreman/src/cli.ts add "two words"`,
    `env --unset=CLAUDE_CODE_CHILD_SESSION bun packages/foreman/src/cli.ts list`,
    `sudo -u root git push origin feature-x`,
    `timeout -s KILL 10 git status`,
  ])("allows: %s", (cmd) => {
    expect(checkCommand(cmd, ctx())).toBeNull();
    expect(checkCommand(cmd, working)).toBeNull();
  });

  test.each([
    "env -u X git push --force",
    "env -u X FOO=1 git push origin main",
    "env -uX git push -f origin feature-x",
    "env --unset X git push origin main",
    "env -C /repo git push origin main",
    "env -S 'git push --force'",
    "env -i -- git reset --hard",
    "sudo -u root git push origin main",
    "sudo -Eu root git push --force",
    "nice -n 5 git push origin main",
    "timeout -s KILL 10 git push origin main",
    "timeout --kill-after=5 10 git push origin main",
    "xargs -n 1 git push --force",
    "stdbuf -o L git push origin main",
    "env -u X rm -rf build",
    "env -u X cat .env",
  ])("still blocks: %s", (cmd) => {
    expect(checkCommand(cmd, ctx())).not.toBeNull();
  });

  test("writes behind env -u are checked against the task's paths", () => {
    expect(checkCommand("env -u X cp src/a.ts other/a.ts", working)).toContain("outside your task's paths");
    expect(checkCommand("env -u X cp other/a.ts src/a.ts", working)).toBeNull();
  });

  test("the hook itself lets the reported command through, with and without FOREMAN_ACTOR", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    for (const actor of [undefined, "fm-test-nobody"]) {
      // This tree's foreman, not whichever one is on the PATH (it may predate `policy`).
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        FOREMAN_ACTOR: actor,
        FOREMAN_BIN: `bun ${join(root, "packages/foreman/src/cli.ts")}`,
      };
      if (!actor) delete env.FOREMAN_ACTOR;
      const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "templates/.claude/hooks/guard.ts")], {
        cwd: root,
        env,
        stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command: REPORTED }, cwd: root })),
        stderr: "pipe",
      });
      expect({ actor, code: p.exitCode, stderr: p.stderr.toString() }).toEqual({ actor, code: 0, stderr: "" });
    }
  });
});
