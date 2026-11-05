import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

test("finds the project's node_modules/.bin/foreman when FOREMAN_BIN is unset and the PATH has none", () => {
  const dir = mkdtempSync(join(tmpdir(), "ss-"));
  try {
    expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0);
    const db = { FOREMAN_DB: join(dir, "f.db"), FOREMAN_AGENT: "1" };
    const added = fm({ ...db, FOREMAN_ACTOR: "boss" }, "add", "Installed foreman", "--spec", "Found it", "--check", "cmd: bun test", "--ready");
    const id = /T-\d+/.exec(added.stdout.toString())![0];
    expect(fm({ ...db, FOREMAN_ACTOR: "w1" }, "claim", id).exitCode).toBe(0);

    // bun alone on the PATH: this machine's PATH may have a linked foreman next to it.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    const env = { ...db, FOREMAN_ACTOR: "w1", PATH: `${bin}:/usr/bin:/bin` };
    expect(run(env, dir)).toEqual({ code: 0, out: "" }); // nothing installed: silent

    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    symlinkSync(FM, join(dir, "node_modules/.bin/foreman"));
    const r = run(env, dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toContain(id);
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
