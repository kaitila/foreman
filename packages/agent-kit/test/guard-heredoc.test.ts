// Here-documents (T-0022): the body is data, not commands, unless a shell runs it.
import { describe, expect, test } from "bun:test";
import { type Context, checkCommand, parseCommands } from "../templates/claude/hooks/guard";

const ctx = (over: Partial<Context> = {}): Context => ({
  projectRoot: "/repo",
  cwd: "/repo",
  branchAt: () => "feature-x",
  taskPaths: () => null,
  ...over,
});
const working = ctx({ taskPaths: () => ["src/**"] });

describe("here-documents", () => {
  test("the body is read as data: apostrophes, quotes and keywords inside it don't matter", () => {
    const cmd = "cat > src/notes.md <<'EOF'\nIt's fine, don't worry: git push origin main, rm -rf /, cat .env\nEOF\necho done";
    const parsed = parseCommands(cmd);
    expect(parsed[0]!.words).toEqual(["cat"]);
    expect(parsed[0]!.writes).toEqual(["src/notes.md"]);
    expect(parsed[0]!.heredocs[0]).toContain("It's fine");
    expect(parsed[1]!.words).toEqual(["echo", "done"]);
    expect(checkCommand(cmd, working)).toBeNull();
  });

  test.each([
    ["unquoted", "cat <<EOF > src/a.txt\nit's here\nEOF"],
    ["double-quoted", 'cat <<"END" > src/a.txt\nit\'s here\nEND'],
    ["tab-stripped", "cat <<-EOF > src/a.txt\n\tit's here\n\tEOF"],
    ["followed by more commands", "python3 - <<'PY'\nprint('hi')\nPY\ngit status"],
    ["two on one line", "cat <<A <<B\nfirst's\nA\nsecond's\nB"],
  ])("%s heredocs parse", (_name, cmd) => {
    expect(checkCommand(cmd, working)).toBeNull();
  });

  test("where the heredoc is written still counts", () => {
    expect(checkCommand("cat > .env <<'EOF'\nTOKEN=x\nEOF", working)).toContain(".env");
    expect(checkCommand("cat > other/a.txt <<'EOF'\nit's x\nEOF", working)).toContain("outside your task's paths");
    expect(checkCommand("tee other/a.txt <<'EOF'\nx\nEOF", working)).toContain("outside your task's paths");
  });

  test("a shell fed a heredoc runs its body, so the body is checked", () => {
    expect(checkCommand("bash <<'EOF'\ngit push origin main\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("sh -s <<'EOF'\nrm -rf build\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("bash <<'EOF'\necho it's ok\nEOF", ctx())).not.toBeNull(); // unbalanced quote in a script: still fails closed
    expect(checkCommand("bash <<'EOF'\necho fine\nEOF", ctx())).toBeNull();
  });

  test("a heredoc piped into a shell, or sourced from stdin, has its body checked (T-0024)", () => {
    expect(checkCommand("cat <<'EOF' | bash\ngit push origin main\nEOF", ctx())).toContain("main");
    expect(checkCommand("cat <<'EOF' | sh -s\nrm -rf build\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("source /dev/stdin <<'EOF'\ngit push --force origin x\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("cat <<'EOF' | bash\necho fine\nEOF", ctx())).toBeNull();
    // bash -c runs its argument, not stdin: the body is data
    expect(checkCommand("bash -c 'cat' <<'EOF'\ngit push origin main\nEOF", ctx())).toBeNull();
  });

  test("a valid script fed to a shell is checked line by line, not just for parse errors", () => {
    expect(checkCommand("bash <<'EOF'\necho step one\ngit push origin HEAD:main\nEOF", ctx())).toContain("main");
  });

  test("an interpreter fed a heredoc that reads .env is blocked (T-0024)", () => {
    expect(checkCommand("python3 <<'PY'\nprint(open('.env').read())\nPY", ctx())).toContain(".env");
    expect(checkCommand("node <<'JS'\nrequire('fs').readFileSync('.env.local')\nJS", ctx())).toContain(".env");
    expect(checkCommand("python3 <<'PY'\nprint(open('.env.example').read())\nPY", ctx())).toBeNull();
  });

  test("an unquoted body expands $(...) and backticks, so those are checked", () => {
    expect(checkCommand("cat <<EOF\nnow: $(git push origin main)\nEOF", ctx())).not.toBeNull();
    expect(checkCommand("cat <<EOF\nnow: `rm -rf x`\nEOF", ctx())).not.toBeNull();
    // a quoted delimiter means no expansion: the same text is just data
    expect(checkCommand("cat <<'EOF'\nnow: $(git push origin main)\nEOF", ctx())).toBeNull();
  });

  test("here-strings are data", () => {
    expect(checkCommand("grep x <<< \"it's a string\"", ctx())).toBeNull();
  });

  test("an unterminated heredoc takes the rest as its body (as bash does)", () => {
    expect(checkCommand("cat <<'EOF'\nit's never closed", ctx())).toBeNull();
  });
});
