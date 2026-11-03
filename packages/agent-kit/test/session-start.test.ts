import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "templates/.claude/hooks/session-start.ts");
const FM = join(import.meta.dir, "..", "..", "foreman/src/cli.ts");

function run(env: Record<string, string>, dir: string) {
  const p = Bun.spawnSync(["bun", HOOK], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PROJECT_DIR: dir, ...env },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: dir })),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() };
}

function fm(env: Record<string, string>, ...args: string[]) {
  return Bun.spawnSync(["bun", FM, ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

test("injects the claimed task; silent without an actor, without a task, or without foreman", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0);
    const base = { FOREMAN_DB: join(dir, "f.db"), FOREMAN_BIN: `bun ${FM}`, FOREMAN_AGENT: "1" };
    const added = fm({ ...base, FOREMAN_ACTOR: "boss" }, "add", "Do the thing", "--spec", "Make it so", "--check", "cmd: bun test", "--path", "src/**", "--ready");
    expect(added.exitCode).toBe(0);
    const id = /T-\d+/.exec(added.stdout.toString())![0];

    // holds nothing yet
    expect(run({ ...base, FOREMAN_ACTOR: "w1" }, dir)).toEqual({ code: 0, out: "" });
    expect(fm({ ...base, FOREMAN_ACTOR: "w1" }, "claim", id).exitCode).toBe(0);

    const r = run({ ...base, FOREMAN_ACTOR: "w1" }, dir);
    expect(r.code).toBe(0);
    const ctx = JSON.parse(r.out).hookSpecificOutput;
    expect(ctx.hookEventName).toBe("SessionStart");
    for (const s of [id, "Do the thing", "Make it so", "c1 (cmd): bun test", "src/**"]) expect(ctx.additionalContext).toContain(s);

    // no actor
    expect(run(base, dir)).toEqual({ code: 0, out: "" });
    // foreman unreachable
    expect(run({ ...base, FOREMAN_ACTOR: "w1", FOREMAN_BIN: "/nonexistent/fm" }, dir)).toEqual({ code: 0, out: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered in the template settings and this repo's", () => {
  for (const f of ["templates/.claude/settings.json", "../../../.claude/settings.json".slice(3)]) {
    const s = JSON.parse(readFileSync(join(import.meta.dir, "..", f), "utf8"));
    expect(s.hooks.SessionStart[0].hooks[0].command).toContain("session-start.ts");
  }
});
