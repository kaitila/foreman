// Deny rules per agent role (T-0055, D0019): foreman.json "roles" parsing, role
// resolution from FOREMAN_ACTOR, and `foreman policy`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRoles, resolvePolicy, roleOf, rulesForRole } from "../src/roles";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-roles-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const ROLES = {
  $comment: "agent applies to every role",
  agent: { deny: ["Bash(gh pr merge *)", "Bash(ssh *)"] },
  worker: { deny: ["Bash(gh release *)"] },
  verifier: { deny: ["mcp__deploy", "Bash(ssh *)"] },
  intake: { deny: ["Read(data/**)"] },
};

function repo(config: unknown): string {
  const d = join(tmp, `r${n++}`);
  mkdirSync(d, { recursive: true });
  if (config !== undefined) writeFileSync(join(d, "foreman.json"), JSON.stringify(config));
  Bun.spawnSync(["git", "init", "-q", d]);
  return d;
}

describe("parseRoles", () => {
  test("reads deny lists, skips $comment keys", () => {
    expect(parseRoles(ROLES)).toEqual({
      agent: ["Bash(gh pr merge *)", "Bash(ssh *)"],
      worker: ["Bash(gh release *)"],
      verifier: ["mcp__deploy", "Bash(ssh *)"],
      intake: ["Read(data/**)"],
    });
    expect(parseRoles(undefined)).toEqual({});
    expect(parseRoles({ worker: { $comment: "x" } })).toEqual({ worker: [] });
  });

  test.each([
    [[], "must be an object"],
    [{ workers: { deny: [] } }, 'unknown role "workers"'],
    [{ worker: [] }, "roles.worker must be an object"],
    [{ worker: { allow: [] } }, 'unknown key "allow"'],
    [{ worker: { deny: "Bash(ssh *)" } }, "must be a list"],
    [{ worker: { deny: [42] } }, "deny[0]"],
    [{ worker: { deny: ["Bash(ssh *"] } }, "isn't a permission rule"],
    [{ worker: { deny: ["Bash()"] } }, "isn't a permission rule"],
    [{ worker: { deny: ["Bash(a,b)"] } }, "has a comma"],
  ])("refuses %j", (raw, message) => {
    expect(() => parseRoles(raw)).toThrow(message);
  });
});

describe("roles from FOREMAN_ACTOR", () => {
  test.each([
    ["worker-T-0042", "worker"],
    ["verifier-T-1", "verifier"],
    ["intake", "intake"],
    ["intake-2", "intake"],
    ["worker", "worker"],
    ["workers-1", null],
    ["worker-t0055", "worker"],
    ["alice", null],
    ["", null],
    [undefined, null],
  ])("%s → %s", (actor, role) => {
    expect(roleOf(actor)).toBe(role as ReturnType<typeof roleOf>);
  });

  test('"agent" first, then the role\'s own, without repeats', () => {
    const roles = parseRoles(ROLES);
    expect(rulesForRole(roles, "verifier")).toEqual([
      { rule: "Bash(gh pr merge *)", role: "agent" },
      { rule: "Bash(ssh *)", role: "agent" },
      { rule: "mcp__deploy", role: "verifier" },
    ]);
    expect(rulesForRole(roles, null)).toEqual([
      { rule: "Bash(gh pr merge *)", role: "agent" },
      { rule: "Bash(ssh *)", role: "agent" },
    ]);
  });

  test("resolvePolicy: a person gets nothing, a custom actor gets agent, a role gets both", () => {
    const root = repo({ roles: ROLES });
    expect(resolvePolicy(root, undefined)).toEqual({ actor: null, role: null, rules: [] });
    expect(resolvePolicy(root, "alice").rules.map((r) => r.rule)).toEqual(["Bash(gh pr merge *)", "Bash(ssh *)"]);
    expect(resolvePolicy(root, "worker-T-1")).toEqual({
      actor: "worker-T-1",
      role: "worker",
      rules: [
        { rule: "Bash(gh pr merge *)", role: "agent" },
        { rule: "Bash(ssh *)", role: "agent" },
        { rule: "Bash(gh release *)", role: "worker" },
      ],
    });
    expect(resolvePolicy(repo(undefined), "worker-T-1").rules).toEqual([]);
    expect(resolvePolicy(repo({ protectedPaths: [] }), "worker-T-1").rules).toEqual([]);
  });

  test("a bad roles block throws even for a person, so it is never quietly ignored", () => {
    expect(() => resolvePolicy(repo({ roles: { workers: {} } }), undefined)).toThrow("unknown role");
  });
});

describe("foreman policy", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = (cwd: string, args: string[], actor?: string) => {
    const env: Record<string, string | undefined> = { ...process.env, FOREMAN_ACTOR: actor, FOREMAN_DB: join(tmp, "unused.db") };
    if (!actor) delete env.FOREMAN_ACTOR;
    const p = Bun.spawnSync(["bun", cli, "policy", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("--json for FOREMAN_ACTOR, --actor and --role", () => {
    const root = repo({ roles: ROLES });
    const j = (r: { out: string }) => JSON.parse(r.out);
    expect(j(run(root, ["--json"], "worker-T-1")).rules.map((r: { rule: string }) => r.rule)).toEqual([
      "Bash(gh pr merge *)",
      "Bash(ssh *)",
      "Bash(gh release *)",
    ]);
    expect(j(run(root, ["--json"]))).toEqual({ actor: null, role: null, rules: [] });
    expect(j(run(root, ["--json", "--actor", "intake"])).rules.at(-1)).toEqual({ rule: "Read(data/**)", role: "intake" });
    expect(j(run(root, ["--json", "--role", "agent"])).rules).toHaveLength(2);
    expect(run(root, ["--role", "verifier"]).out).toContain("verifier  mcp__deploy");
  });

  test("from a worktree it reads the main checkout's foreman.json", () => {
    const root = repo({ roles: ROLES });
    Bun.spawnSync(["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const wt = join(tmp, `wt${n++}`);
    expect(Bun.spawnSync(["git", "-C", root, "worktree", "add", "-q", wt]).exitCode).toBe(0);
    writeFileSync(join(wt, "foreman.json"), JSON.stringify({ roles: {} })); // a worker's edit doesn't drop its rules
    expect(JSON.parse(run(wt, ["--json"], "worker-T-1").out).rules).toHaveLength(3);
  });

  test("a bad roles block or --role fails with a reason", () => {
    const bad = run(repo({ roles: { worker: { deny: ["Bash("] } } }), ["--json"], "worker-T-1");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("isn't a permission rule");
    expect(run(repo({}), ["--role", "boss"]).err).toContain("--role must be");
  });
});
