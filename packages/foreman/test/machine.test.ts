import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMachine, type Env, formatItems, type RunResult } from "../src/setup";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const base = mkdtempSync(join(tmpdir(), "fm-machine-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
for (const k of ["GIT_AUTHOR", "GIT_COMMITTER"]) {
  process.env[`${k}_NAME`] = "Test";
  process.env[`${k}_EMAIL`] = "test@example.invalid";
}

function fm(args: string[], cwd: string, home: string) {
  const p = Bun.spawnSync(["bun", CLI, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FOREMAN_HOME: home, FOREMAN_DB: join(home, "x.db") },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("fm create, init, sync reach packages/create", () => {
  test("create then sync, init, sync --all, with the registry", () => {
    const home = mkdtempSync(join(base, "home-"));
    const work = mkdtempSync(join(base, "w-"));
    const app = join(work, "app");
    const c = fm(["create", app, "--no-install"], work, home);
    expect(c.err).toBe("");
    expect(c.code).toBe(0);
    expect(c.out).toContain("created");
    expect(existsSync(join(app, "foreman.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "projects.json"), "utf8"))).toContain(app);

    // The package's own CLI gives the same text for a sync.
    const own = Bun.spawnSync(["bun", join(import.meta.dir, "..", "..", "create", "src", "cli.ts"), "sync", app], { stdout: "pipe", stderr: "pipe" });
    const mine = fm(["sync", app], work, home);
    expect(mine.code).toBe(0);
    expect(mine.out).toBe(own.stdout.toString());
    expect(mine.out).toContain("up to date");

    // init on an existing repo.
    const ex = join(work, "existing");
    mkdirSync(ex);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: ex });
    const i = fm(["init", ex], work, home);
    expect(i.code).toBe(0);
    expect(i.out).toContain("Next:");

    const all = fm(["sync", "--all", "--dry-run"], work, home);
    expect(all.code).toBe(0);
    expect(all.out).toContain(`== ${app}`);
    expect(all.out).toContain(`== ${ex}`);
    expect(all.out).toContain("2 projects, 0 failed");
  });

  test("sync --all reports a project that is gone and exits 1; create without a dir fails", () => {
    const home = mkdtempSync(join(base, "home-"));
    Bun.write(join(home, "projects.json"), JSON.stringify(["/nonexistent/zzz"]));
    const r = fm(["sync", "--all"], base, home);
    expect(r.code).toBe(1);
    expect(r.out).toContain("failed:");
    expect(fm(["create"], base, home).code).toBe(1);
  });
});

function env(over: Partial<Env> & { cmds?: Record<string, RunResult | null>; files?: Record<string, string> } = {}): Env {
  const cmds = over.cmds ?? {};
  const files = over.files ?? {};
  return {
    run: (cmd) => cmds[cmd.join(" ")] ?? null,
    which: () => "/home/u/.bun/bin/fm",
    read: (p) => files[p] ?? null,
    home: "/home/u",
    now: 1_000_000,
    repo: null,
    foremanDir: "/src/foreman",
    ...over,
  };
}
const ok = (stdout: string): RunResult => ({ code: 0, stdout });

describe("fm setup", () => {
  test("everything missing: each item says missing with a fix", () => {
    const items = checkMachine(env({ which: () => null }));
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    for (const id of ["bun", "git", "gh", "gh-login", "claude", "claude-login", "fm"]) {
      expect(by[id]!.ok).toBe(false);
      expect(by[id]!.fix.length).toBeGreaterThan(0);
    }
    expect(by.trust!.ok).toBe(true); // not in a repo: nothing to trust
    expect(formatItems(items)).toContain("fix: gh auth login");
  });

  test("all fine, with time left on the sign-in and the repo trusted", () => {
    const items = checkMachine(
      env({
        repo: "/r",
        cmds: {
          "bun --version": ok("1.3.5"),
          "git --version": ok("git version 2"),
          "gh --version": ok("gh version 2"),
          "gh auth status": ok("Logged in"),
          "claude --version": ok("2.0"),
          "claude auth status": ok("{}"),
        },
        files: {
          "/home/u/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { expiresAt: 1_000_000 + 3 * 3600_000 } }),
          "/home/u/.claude.json": JSON.stringify({ projects: { "/r": { hasTrustDialogAccepted: true } } }),
        },
      }),
    );
    expect(items.every((i) => i.ok)).toBe(true);
    expect(items.find((i) => i.id === "claude-login")!.detail).toContain("3h 0m left");
  });

  test("untrusted repo, expired token, gh not logged in", () => {
    const items = checkMachine(
      env({
        repo: "/r",
        cmds: { "bun --version": ok("1"), "gh --version": ok("2"), "gh auth status": { code: 1, stdout: "" }, "claude --version": ok("2"), "claude auth status": ok("") },
        files: { "/home/u/.claude/.credentials.json": JSON.stringify({ claudeAiOauth: { expiresAt: 5 } }), "/home/u/.claude.json": "{}" },
      }),
    );
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by["gh-login"]!.ok).toBe(false);
    expect(by["claude-login"]!.ok).toBe(false);
    expect(by.trust!.ok).toBe(false);
    expect(by.trust!.fix).toContain("claude");
  });

  test("links fm when it is missing and linking is on", () => {
    const ran: string[] = [];
    let linked = false;
    const e = env({
      which: () => (linked ? "/b/fm" : null),
      run: (cmd) => {
        ran.push(cmd.join(" "));
        if (cmd[0] === "bun" && cmd[1] === "link") linked = true;
        return ok("1");
      },
    });
    expect(checkMachine(e, { link: true }).find((i) => i.id === "fm")!.ok).toBe(true);
    expect(ran).toContain("bun link");
  });

  test("fm setup --json prints items", () => {
    const home = mkdtempSync(join(base, "home-"));
    const r = fm(["setup", "--json", "--no-link"], base, home);
    const j = JSON.parse(r.out);
    expect(Array.isArray(j.items)).toBe(true);
    expect(j.items.map((i: { id: string }) => i.id)).toContain("bun");
    expect(j.items.find((i: { id: string }) => i.id === "bun").ok).toBe(true);
  });
});

test("help groups the commands", () => {
  const r = fm(["help"], base, base);
  const at = ["Projects", "Tasks", "Agents", "Board"].map((h) => r.out.indexOf(`\n${h}\n`));
  expect(at.every((n) => n > 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(r.out).toContain("sync --all");
});
