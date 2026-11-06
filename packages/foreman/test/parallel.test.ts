// Real processes, real git worktrees: the case that broke other trackers (R5.1).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPath } from "../src/store";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_CHILD_SESSION: "", FOREMAN_AGENT: "", FOREMAN_DB: "", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function repo() {
  const root = join(dir, `repo-${Math.random().toString(36).slice(2)}`);
  sh(["git", "init", "-q", root], dir);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], root);
  return root;
}

test("every worktree resolves to the main checkout's database", () => {
  const root = repo();
  const wt = join(dir, "wt-a");
  expect(sh(["git", "worktree", "add", "-q", "-b", "a", wt], root).code).toBe(0);
  expect(dbPath(wt)).toBe(dbPath(root));
  expect(dbPath(root).startsWith(root)).toBe(true);
});

test("8 agents in 8 worktrees race for 3 tasks: exactly 3 claims win, all persist", async () => {
  const root = repo();
  for (const n of [1, 2, 3]) {
    const r = sh(["bun", CLI, "add", `task ${n}`, "--check", "cmd: true", "--risk", "auto", "--ready"], root);
    expect(r.code).toBe(0);
  }
  const wts = Array.from({ length: 8 }, (_, i) => {
    const wt = join(dir, `race-${i}-${Math.random().toString(36).slice(2)}`);
    sh(["git", "worktree", "add", "-q", "-b", `race-${i}-${wt.slice(-4)}`, wt], root);
    return wt;
  });
  const runs = await Promise.all(
    wts.map(async (wt, i) => {
      const p = Bun.spawn(["bun", CLI, "claim", "--json"], {
        cwd: wt,
        env: { ...process.env, FOREMAN_DB: "", CLAUDE_CODE_CHILD_SESSION: "1", FOREMAN_ACTOR: `agent-${i}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = [await new Response(p.stdout).text(), await p.exited];
      return { code, out };
    }),
  );
  const winners = runs.filter((r) => r.code === 0).map((r) => JSON.parse(r.out));
  expect(winners.length).toBe(3);
  expect(new Set(winners.map((w) => w.id)).size).toBe(3);
  // and every winner's claim is really in the database
  const listed = JSON.parse(sh(["bun", CLI, "list", "--status", "claimed", "--json"], root).out);
  expect(listed.map((t: { assignee: string }) => t.assignee).sort()).toEqual(winners.map((w) => w.assignee).sort());
}, 30_000);

test("approve is refused inside an agent session and without a terminal", () => {
  const root = repo();
  sh(["bun", CLI, "add", "x", "--check", "cmd: true"], root);
  const agent = sh(["bun", CLI, "approve", "T-0001"], root, { CLAUDE_CODE_CHILD_SESSION: "1" });
  expect(agent.code).toBe(1);
  expect(agent.err).toContain("agent session");
  // An IDE terminal has CLAUDECODE=1 but is a person: refused only for lacking a TTY here.
  const ide = sh(["bun", CLI, "approve", "T-0001"], root, { CLAUDECODE: "1" });
  expect(ide.code).toBe(1);
  expect(ide.err).toContain("interactive terminal");
});

test("reserve decision skips numbers already on disk", () => {
  const root = repo();
  sh(["mkdir", "-p", "docs/decisions"], root);
  sh(["touch", "docs/decisions/D0007-something.md"], root);
  expect(sh(["bun", CLI, "reserve", "decision"], root).out.trim()).toBe("D0008");
  expect(sh(["bun", CLI, "reserve", "decision"], root).out.trim()).toBe("D0009");
});

test("real git: a branch that changes a protected file is escalated; an unprotected one is approved (D0008)", async () => {
  const { Foreman } = await import("../src/core");
  const root = repo();
  const g = (args: string[]) => sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], root);
  const human = { name: "ada", kind: "human" as const };
  const run = (branch: string, file: string) => {
    g(["switch", "-q", "-c", branch, "main"]);
    sh(["mkdir", "-p", file.split("/").slice(0, -1).join("/") || "."], root);
    writeFileSync(join(root, file), "x\n");
    g(["add", "-A"]);
    g(["commit", "-qm", branch]);
    g(["switch", "-q", "main"]);
    const f = Foreman.open(root);
    const t = f.create({ title: branch, acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    const w = { name: `w-${branch}`, kind: "agent" as const };
    f.claim(t.id, w);
    f.progress(t.id, w, { branch });
    f.submit(t.id, w, { pr: "https://example.com/pull/1" });
    const v = { name: `v-${branch}`, kind: "agent" as const };
    f.startVerify(t.id, v);
    return f.recordVerify(t.id, v, [{ check: "c1", pass: true, evidence: "ok" }]).status;
  };
  sh(["git", "branch", "-m", "main"], root);
  expect(run("plain", "src/a.ts")).toBe("approved");
  expect(run("sneaky", ".github/workflows/ci.yml")).toBe("needs_approval");
});

test("outside a git repository: a one-line error, not a stack trace", () => {
  const r = sh(["bun", CLI, "list"], tmpdir());
  expect(r.code).toBe(1);
  expect(r.err.trim()).toMatch(/^foreman: not inside a git repository/);
});

test("fm add without --risk takes the default from the paths (T-0031)", () => {
  const root = repo();
  const plain = JSON.parse(sh(["bun", CLI, "add", "docs", "--check", "cmd: true", "--path", "docs/**", "--json"], root).out);
  expect(plain.risk).toBe("auto");
  const guarded = JSON.parse(sh(["bun", CLI, "add", "ci", "--check", "cmd: true", "--path", ".github/**", "--json"], root).out);
  expect(guarded.risk).toBe("review");
  const given = JSON.parse(sh(["bun", CLI, "add", "x", "--check", "cmd: true", "--path", "docs/**", "--risk", "human", "--json"], root).out);
  expect(given.risk).toBe("human");
  expect(sh(["bun", CLI, "add", "y", "--risk", "maybe"], root).code).toBe(1);
});
