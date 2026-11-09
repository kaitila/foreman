// More write forms (T-0014), heredocs that are data vs code (T-0027), and the hook
// failing closed when bun is missing (T-0026).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, checkCommand, gitWriteTargets, writeTargets } from "../templates/claude/hooks/guard";

const ctx = (over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  ...over,
});
const working = ctx({ taskPaths: () => ["src/**"] });

describe("more write forms checked against the task's paths (T-0014)", () => {
  test.each([
    "cp -rt other src/a.ts",
    "cp -vt other src/a.ts",
    "mv src/a.ts src/b.ts other/",
    "mv other/x.ts src/x.ts", // the source is taken away: that's writing it
    "dd if=/dev/zero of=other/blob bs=1 count=1",
    "curl -sSLo other/page.html https://example.com",
    "curl --output other/page.html https://example.com",
    "curl --output=other/page.html https://example.com",
    "wget -O other/page.html https://example.com",
    "rm other/old.ts",
    "rm -f other/old.ts",
    "unlink other/old.ts",
    "mkdir other/new",
    "truncate -s 0 other/log.txt",
    "git rm other/old.ts",
    "git mv src/a.ts other/a.ts",
    "git checkout -- other/a.ts",
    "git checkout main -- other/a.ts",
    "git restore other/a.ts",
    "git -C . restore --worktree other/a.ts",
    "echo x >| other/f.txt",
    "git checkout HEAD other/a.ts",
    "git checkout main src/a.ts other/b.ts",
    "find other -name '*.tmp' -delete",
    "find other src -type f -exec rm {} +",
  ])("blocks: %s", (cmd) => {
    expect(checkCommand(cmd, working)).toContain("outside your task's paths");
  });

  test.each([
    "cp -rt src other/a.ts", // copying *from* outside into the task's paths is fine
    "curl -sSLo src/page.html https://example.com",
    "curl -o - https://example.com", // stdout
    "curl -O https://example.com/x", // remote name into the cwd: not traced
    "dd if=other/blob of=src/copy",
    "rm src/old.ts",
    "git rm src/old.ts",
    "git restore --staged other/a.ts", // index only
    "git checkout feature-x", // switching branches isn't a file write
    "truncate -s 0 src/log.txt",
    "git checkout -b new-branch main",
    "find src -name '*.tmp' -delete",
    "find other -name '*.md'", // finding isn't writing
    "rm -r src/build", // a directory inside the paths
  ])("allows: %s", (cmd) => {
    expect(checkCommand(cmd, working)).toBeNull();
  });

  test("helpers", () => {
    expect(writeTargets("cp", ["-rt", "dest", "a", "b"])).toEqual(["dest"]);
    expect(writeTargets("mv", ["a", "b", "dest"])).toEqual(["a", "b", "dest"]);
    expect(gitWriteTargets(["-C", ".", "rm", "--cached", "x"])).toEqual(["x"]);
    expect(gitWriteTargets(["restore", "--source", "HEAD~1", "x"])).toEqual(["x"]);
  });
});

describe("a heredoc is code only where stdin is the script (T-0027)", () => {
  test("a script given by file name gets the heredoc as data", () => {
    expect(checkCommand("python3 tool.py <<'EOF'\nsee .env docs: open('.env')\nEOF", ctx())).toBeNull();
    expect(checkCommand("bash deploy.sh <<'EOF'\ngit push origin main\nEOF", ctx())).toBeNull();
    // the false positive the verifier hit: a heredoc for cat, and an interpreter elsewhere on the line
    expect(checkCommand("cat > src/notes.md <<'EOF'\nload('.env')\nEOF\nbun src/x.ts", working)).toBeNull();
  });
  test("an option's value is not a script name: the heredoc is code (verifier finding)", () => {
    expect(checkCommand("bash -o pipefail <<'EOF'\ngit push origin main\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("python3 -W ignore <<'EOF'\nprint(open('.env').read())\nEOF", ctx())).toContain(".env");
    expect(checkCommand("node --no-warnings <<'EOF'\nrequire('fs').readFileSync('.env')\nEOF", ctx())).toContain(".env");
    expect(checkCommand("bash ./deploy <<'EOF'\ngit push origin main\nEOF", ctx())).toBeNull(); // a path names a script
  });

  test("stdin as the script is still checked", () => {
    expect(checkCommand("cat <<'EOF' | python3\nprint(open('.env').read())\nEOF", ctx())).toContain(".env");
    expect(checkCommand("python3 - <<'EOF'\nprint(open('.env').read())\nEOF", ctx())).toContain(".env");
    expect(checkCommand("bash -s <<'EOF'\ngit push origin main\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("bash <<'EOF'\ngit push origin main\nEOF", ctx())).not.toBeNull();
  });
});

describe("the hook fails closed when bun is missing (T-0026)", () => {
  const settings = JSON.parse(readFileSync(join(import.meta.dir, "..", "templates/claude/settings.json"), "utf8"));
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command;

  test("with bun not on PATH, the hook command exits 2 and names bun", () => {
    const bin = mkdtempSync(join(tmpdir(), "nobun-"));
    try {
      // A PATH with the shell tools but no bun.
      for (const tool of ["sh", "echo", "true", "cat"]) {
        const real = Bun.which(tool);
        if (real) symlinkSync(real, join(bin, tool));
      }
      const p = Bun.spawnSync(["sh", "-c", command], {
        env: { PATH: bin, CLAUDE_PROJECT_DIR: "/nowhere" },
        stdin: new TextEncoder().encode("{}"),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("bun");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("this repository runs the template's hook command, on the template's own guard (D0023)", () => {
    const repo = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", ".claude/settings.json"), "utf8"));
    const inPlace = JSON.parse(
      JSON.stringify(settings.hooks.PreToolUse).replaceAll("/.claude/hooks/", "/packages/agent-kit/templates/claude/hooks/"),
    );
    expect(repo.hooks.PreToolUse).toEqual(inPlace);
  });

  test("with bun present, it runs the guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "withbun-"));
    try {
      mkdirSync(join(dir, ".claude/hooks"), { recursive: true });
      for (const f of ["guard.ts", "scope.ts"]) {
        writeFileSync(join(dir, ".claude/hooks", f), readFileSync(join(import.meta.dir, "..", "templates/claude/hooks", f), "utf8"));
      }
      const p = Bun.spawnSync(["sh", "-c", command], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FOREMAN_ACTOR: "" },
        stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: dir })),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("guard:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
