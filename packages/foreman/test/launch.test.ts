// Launch adapter (T-0010, D0011): command building, config isolation, stream parsing,
// and the timeout kill. No real `claude` is started; the live check is scripts/live-launch.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ROLE_LIMITS,
  ancestorClaudeMds,
  buildLaunch,
  credentialsLinkIntact,
  defaultSpawner,
  ensureConfigDir,
  launch,
  parseStream,
  StreamParser,
  type Child,
  type LaunchOptions,
  type Spawner,
} from "../src/launch";

// realpath: on some systems tmpdir is a symlink, and git reports the resolved path.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-launch-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const fresh = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

function base(over: Partial<LaunchOptions> = {}): LaunchOptions {
  return { role: "worker", cwd: tmp, repoRoot: tmp, prompt: "do the task", configDir: join(tmp, "cfg"), baseEnv: {}, ...over };
}

function flag(cmd: string[], name: string): string | undefined {
  const i = cmd.indexOf(name);
  return i >= 0 ? cmd[i + 1] : undefined;
}

const list = (cmd: string[], name: string) => flag(cmd, name)?.split(",") ?? [];

describe("buildLaunch", () => {
  test("headless stream-json command with role defaults", () => {
    for (const role of ["worker", "verifier", "intake"] as const) {
      const { cmd } = buildLaunch(base({ role }));
      expect(cmd.slice(0, 2)).toEqual(["claude", "-p"]);
      expect(flag(cmd, "--output-format")).toBe("stream-json");
      expect(cmd).toContain("--verbose");
      expect(flag(cmd, "--max-turns")).toBe(String(ROLE_LIMITS[role].maxTurns));
      expect(flag(cmd, "--max-budget-usd")).toBe(String(ROLE_LIMITS[role].maxBudgetUsd));
      const settings = JSON.parse(flag(cmd, "--settings")!);
      expect(Array.isArray(settings.claudeMdExcludes)).toBe(true);
    }
  });

  test("overrides for turns and budget", () => {
    const { cmd } = buildLaunch(base({ maxTurns: 7, maxBudgetUsd: 0.25 }));
    expect(flag(cmd, "--max-turns")).toBe("7");
    expect(flag(cmd, "--max-budget-usd")).toBe("0.25");
  });

  const PLAN_WRITES = ["create_plan", "edit_plan", "plan_task"].map((n) => `mcp__foreman__${n}`);
  const WORKER_FORBIDDEN = [...["start_verify", "record_verdict", "mark_merged", "rework_task"].map((n) => `mcp__foreman__${n}`), ...PLAN_WRITES];
  const EDITS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

  test("worker gets edit tools and foreman tools one by one, never verify/merge/rework", () => {
    const { cmd } = buildLaunch(base({ role: "worker" }));
    const allowed = list(cmd, "--allowedTools");
    expect(allowed).toEqual(expect.arrayContaining(["Read", ...EDITS, "Bash", "Agent"]));
    const foreman = ["list_tasks", "next_tasks", "show_task", "create_task", "claim_task", "heartbeat", "report_progress", "submit_task", "reserve_number", "edit_task"];
    expect(allowed.filter((t) => t.startsWith("mcp__foreman")).sort()).toEqual(foreman.map((n) => `mcp__foreman__${n}`).sort());
    expect(allowed).not.toContain("mcp__foreman"); // no whole-server grant
    expect(list(cmd, "--disallowedTools")).toEqual(WORKER_FORBIDDEN);
  });

  test("worker override can't grant verify/merge/rework", () => {
    const { cmd } = buildLaunch(base({ role: "worker", allowedTools: ["Read", ...WORKER_FORBIDDEN, "mcp__foreman__claim_task"] }));
    expect(list(cmd, "--allowedTools")).toEqual(["Read", "mcp__foreman__claim_task"]);
    expect(list(cmd, "--disallowedTools")).toEqual(WORKER_FORBIDDEN);
  });

  test("verifier never gets edit tools, even when the override asks", () => {
    const { cmd } = buildLaunch(base({ role: "verifier", allowedTools: ["Read", ...EDITS, "Bash"] }));
    expect(list(cmd, "--allowedTools")).toEqual(["Read", "Bash"]);
    expect(list(cmd, "--disallowedTools")).toEqual([...EDITS, ...PLAN_WRITES]);

    const def = buildLaunch(base({ role: "verifier" })).cmd;
    const allowed = list(def, "--allowedTools");
    for (const t of EDITS) expect(allowed).not.toContain(t);
    expect(allowed).toContain("mcp__foreman__record_verdict");
  });

  test("intake disallows edits and Bash", () => {
    const { cmd } = buildLaunch(base({ role: "intake", allowedTools: ["Read", "Bash", "Write", "MultiEdit"] }));
    expect(list(cmd, "--allowedTools")).toEqual(["Read"]);
    expect(list(cmd, "--disallowedTools").slice(0, EDITS.length + 1)).toEqual([...EDITS, "Bash"]);
    expect(list(cmd, "--disallowedTools")).toContain("mcp__foreman__claim_task");
    const def = list(buildLaunch(base({ role: "intake" })).cmd, "--allowedTools");
    expect(def).toContain("mcp__foreman__create_task");
    expect(def).not.toContain("Bash");
  });

  test("--model and --json-schema only when given", () => {
    const plain = buildLaunch(base()).cmd;
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--json-schema");
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const { cmd } = buildLaunch(base({ model: "some-model", jsonSchema: schema }));
    expect(flag(cmd, "--model")).toBe("some-model");
    expect(JSON.parse(flag(cmd, "--json-schema")!)).toEqual(schema);
  });

  test("prompt is last, after --, even when it starts with -", () => {
    const prompt = "--dangerously-skip-permissions please";
    const { cmd } = buildLaunch(base({ prompt, model: "m" }));
    expect(cmd.slice(-2)).toEqual(["--", prompt]);
    expect(cmd.filter((a) => a === prompt)).toHaveLength(1);
  });

  test("env: parent session vars stripped, others kept, config dir and actor set", () => {
    const { env } = buildLaunch(
      base({
        role: "verifier",
        taskId: "T-0042",
        configDir: "/iso/config",
        baseEnv: {
          PATH: "/usr/bin",
          HOME: "/home/someone",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "abc",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CLAUDE_CONFIG_DIR: "/home/someone/.claude",
          FOREMAN_ACTOR: "someone-else",
          UNSET: undefined,
        },
      }),
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/someone");
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "UNSET"]) expect(k in env).toBe(false);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/iso/config");
    expect(env.FOREMAN_ACTOR).toBe("verifier-T-0042");
  });

  test("actor per role", () => {
    expect(buildLaunch(base({ role: "worker", taskId: "T-0001" })).env.FOREMAN_ACTOR).toBe("worker-T-0001");
    expect(buildLaunch(base({ role: "intake" })).env.FOREMAN_ACTOR).toBe("intake");
  });
});

describe("role deny rules from foreman.json (T-0055, D0019)", () => {
  const withRoles = (roles: unknown) => {
    const d = fresh("roles");
    writeFileSync(join(d, "foreman.json"), JSON.stringify({ roles }));
    return d;
  };
  const roles = {
    agent: { deny: ["Bash(gh pr merge *)", "Bash(ssh *)"] },
    worker: { deny: ["Bash(gh release *)"] },
    verifier: { deny: ["mcp__deploy"] },
    intake: { deny: ["Read(data/**)"] },
  };

  test("a worker's command line carries agent's and the worker's rules in --disallowedTools", () => {
    const d = withRoles(roles);
    const { cmd } = buildLaunch(base({ role: "worker", taskId: "T-1", cwd: d, repoRoot: d }));
    const denied = list(cmd, "--disallowedTools");
    expect(denied).toEqual([
      "mcp__foreman__start_verify", "mcp__foreman__record_verdict", "mcp__foreman__mark_merged", "mcp__foreman__rework_task",
      "mcp__foreman__create_plan", "mcp__foreman__edit_plan", "mcp__foreman__plan_task",
      "Bash(gh pr merge *)", "Bash(ssh *)", "Bash(gh release *)",
    ]);
    // Another role's rules stay out; Bash itself stays allowed (deny beats allow for the rest).
    expect(denied).not.toContain("mcp__deploy");
    expect(list(cmd, "--allowedTools")).toContain("Bash");
  });

  test("each role gets its own, and policyRoot overrides where the file is read", () => {
    const d = withRoles(roles);
    const v = list(buildLaunch(base({ role: "verifier", taskId: "T-1", policyRoot: d })).cmd, "--disallowedTools");
    expect(v).toEqual(expect.arrayContaining(["Bash(gh pr merge *)", "Bash(ssh *)", "mcp__deploy"]));
    expect(v).not.toContain("Bash(gh release *)");
    const i = list(buildLaunch(base({ role: "intake", policyRoot: d })).cmd, "--disallowedTools");
    expect(i).toEqual(expect.arrayContaining(["Bash(ssh *)", "Read(data/**)"]));
  });

  test("no dispatched role may change a plan; a worker still files tasks into one with create_task", () => {
    const d = fresh("plans");
    for (const role of ["worker", "verifier", "intake"] as const) {
      const { cmd } = buildLaunch(base({ role, taskId: role === "intake" ? undefined : "T-1", policyRoot: d }));
      expect(list(cmd, "--disallowedTools")).toEqual(expect.arrayContaining(["mcp__foreman__create_plan", "mcp__foreman__edit_plan", "mcp__foreman__plan_task"]));
    }
    expect(list(buildLaunch(base({ role: "worker", taskId: "T-1", policyRoot: d })).cmd, "--allowedTools")).toContain("mcp__foreman__create_task");
  });

  test("no roles block: the role defaults only; a malformed one refuses to build the launch", () => {
    expect(list(buildLaunch(base({ role: "worker", taskId: "T-1", policyRoot: fresh("none") })).cmd, "--disallowedTools")).toHaveLength(7);
    expect(() => buildLaunch(base({ role: "worker", policyRoot: withRoles({ workers: {} }) }))).toThrow("unknown role");
  });
});

describe("ancestorClaudeMds", () => {
  test("finds the three memory files in every ancestor, not in the root itself", () => {
    const top = fresh("anc");
    const mid = join(top, "a");
    const root = join(mid, "b");
    mkdirSync(join(top, ".claude"), { recursive: true });
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(top, "CLAUDE.md"), "x");
    writeFileSync(join(top, ".claude", "CLAUDE.md"), "x");
    writeFileSync(join(mid, "CLAUDE.local.md"), "x");
    writeFileSync(join(root, "CLAUDE.md"), "own");
    writeFileSync(join(root, ".claude", "CLAUDE.md"), "own");
    writeFileSync(join(top, "README.md"), "not memory");

    const found = ancestorClaudeMds(root).filter((p) => p.startsWith(top));
    expect(found.sort()).toEqual([join(mid, "CLAUDE.local.md"), join(top, ".claude", "CLAUDE.md"), join(top, "CLAUDE.md")].sort());
    // A trailing slash or relative segment resolves to the same root.
    expect(ancestorClaudeMds(`${root}/./`).filter((p) => p.startsWith(top)).sort()).toEqual(found.sort());
  });

  test("filesystem root has no ancestors", () => {
    expect(ancestorClaudeMds("/")).toEqual([]);
  });
});

describe("c1: a verifier ignores the person's CLAUDE.md and hooks", () => {
  test("ancestor memory files excluded, repo's own kept, config dir isolated", () => {
    const t = fresh("c1");
    const home = join(t, "home");
    const work = join(home, "work");
    const repo = join(work, "repo");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(work, ".claude"), { recursive: true });
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "user global instructions");
    writeFileSync(join(home, "CLAUDE.md"), "home instructions");
    writeFileSync(join(home, "CLAUDE.local.md"), "home local instructions");
    writeFileSync(join(work, ".claude", "CLAUDE.md"), "work instructions");
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo user-hook" }] }] } }),
    );
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"token":"fake"}');
    const git = Bun.spawnSync(["git", "init", "-q", repo], { stdout: "pipe", stderr: "pipe" });
    expect(git.exitCode).toBe(0);
    writeFileSync(join(repo, "CLAUDE.md"), "repo instructions");
    // Rules load as memory too: the person's and the work dir's are excluded, the repo's kept.
    mkdirSync(join(home, ".claude", "rules", "lang"), { recursive: true });
    writeFileSync(join(home, ".claude", "rules", "lang", "style.md"), "user rule");
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    writeFileSync(join(repo, ".claude", "rules", "repo.md"), "repo rule");

    // No repoRoot or configDir: both come from the git checkout of cwd.
    const { cmd, env } = buildLaunch({ role: "verifier", taskId: "T-0042", cwd: join(repo, "sub"), prompt: "verify", baseEnv: { HOME: home } });
    const excludes: string[] = JSON.parse(flag(cmd, "--settings")!).claudeMdExcludes;
    expect(excludes.filter((p) => p.startsWith(t)).sort()).toEqual(
      [
        join(home, ".claude", "CLAUDE.md"),
        join(home, "CLAUDE.md"),
        join(home, "CLAUDE.local.md"),
        join(home, ".claude", "rules", "**"),
        join(work, ".claude", "CLAUDE.md"),
      ].sort(),
    );
    expect(excludes).not.toContain(join(repo, "CLAUDE.md"));
    expect(excludes.some((p) => p.startsWith(repo))).toBe(false);
    expect(env.CLAUDE_CONFIG_DIR).not.toBe(join(home, ".claude"));
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(repo, ".foreman", "claude-config"));

    // The config dir holds the login link and nothing else of the person's.
    const creds = join(home, ".claude", ".credentials.json");
    const dir = ensureConfigDir(env.CLAUDE_CONFIG_DIR, creds);
    expect(dir).toBe(env.CLAUDE_CONFIG_DIR!);
    expect(readdirSync(dir)).toEqual([".credentials.json"]);
    expect(lstatSync(join(dir, ".credentials.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, ".credentials.json"))).toBe(creds);
  });
});

describe("ensureConfigDir", () => {
  test("creates the dir with only a link; link may dangle", () => {
    const dir = join(fresh("cfg"), "nested", "config");
    const creds = join(tmp, "no-such-login.json");
    expect(ensureConfigDir(dir, creds)).toBe(dir);
    expect(readdirSync(dir)).toEqual([".credentials.json"]);
    expect(readlinkSync(join(dir, ".credentials.json"))).toBe(creds);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  test("replaces a regular file without copying content", () => {
    const dir = fresh("cfg");
    const creds = join(fresh("login"), ".credentials.json");
    writeFileSync(creds, '{"token":"real"}');
    writeFileSync(join(dir, ".credentials.json"), "stale copy");
    ensureConfigDir(dir, creds);
    const link = join(dir, ".credentials.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(creds);
    expect(readFileSync(link, "utf8")).toBe('{"token":"real"}');
  });

  test("replaces a link that points elsewhere", () => {
    const dir = fresh("cfg");
    symlinkSync(join(tmp, "other.json"), join(dir, ".credentials.json"));
    const creds = join(tmp, "login.json");
    ensureConfigDir(dir, creds);
    expect(readlinkSync(join(dir, ".credentials.json"))).toBe(creds);
  });

  test("idempotent", () => {
    const dir = fresh("cfg");
    const creds = join(tmp, "login.json");
    ensureConfigDir(dir, creds);
    const before = lstatSync(join(dir, ".credentials.json")).ino;
    ensureConfigDir(dir, creds);
    ensureConfigDir(dir, creds);
    expect(readdirSync(dir)).toEqual([".credentials.json"]);
    expect(lstatSync(join(dir, ".credentials.json")).ino).toBe(before);
  });
});

describe("credentialsLinkIntact", () => {
  test("true for the link, false for a file or nothing", () => {
    const dir = fresh("intact");
    expect(credentialsLinkIntact(dir)).toBe(false);
    expect(credentialsLinkIntact(join(dir, "missing"))).toBe(false);
    ensureConfigDir(dir, join(tmp, "login.json"));
    expect(credentialsLinkIntact(dir)).toBe(true);
    rmSync(join(dir, ".credentials.json"));
    writeFileSync(join(dir, ".credentials.json"), "{}");
    expect(credentialsLinkIntact(dir)).toBe(false);
  });
});

// A recorded-shape stream; values invented.
const EVENTS = [
  { type: "system", subtype: "init", session_id: "sess-1", tools: ["Read"] },
  { type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: "Looking — ✓ done" }] } },
  { type: "user", session_id: "sess-1", message: { content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", session_id: "sess-1", message: { content: [{ type: "text", text: "finishing" }] } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All checks pass ✓",
    structured_output: { verdict: "pass", checks: ["c1"] },
    total_cost_usd: 0.1234,
    num_turns: 3,
    session_id: "sess-1",
  },
];
const STREAM = ["", "not json at all", ...EVENTS.map((e) => JSON.stringify(e)), "   ", ""].join("\n");

const EXPECTED = {
  result: "All checks pass ✓",
  structured: { verdict: "pass", checks: ["c1"] },
  costUsd: 0.1234,
  turns: 3,
  sessionId: "sess-1",
  isError: false,
  subtype: "success",
};

describe("StreamParser", () => {
  test("whole stream", () => {
    expect(parseStream(STREAM)).toEqual(EXPECTED);
  });

  test("any chunk split gives the same summary", () => {
    for (const size of [1, 2, 3, 7, 50, 1000]) {
      const p = new StreamParser();
      for (let i = 0; i < STREAM.length; i += size) p.push(STREAM.slice(i, i + size));
      expect(p.end()).toEqual(EXPECTED);
    }
  });

  test("last line without a trailing newline is still read", () => {
    expect(parseStream(EVENTS.map((e) => JSON.stringify(e)).join("\n"))).toEqual(EXPECTED);
  });

  test("no result event: a crash, so isError; counts assistant turns, keeps first session id", () => {
    const s = parseStream(EVENTS.slice(0, 4).map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(s).toEqual({ result: "", costUsd: 0, turns: 2, sessionId: "sess-1", isError: true });
    expect(s.structured).toBeUndefined();
  });

  test("error result", () => {
    const s = parseStream(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9, session_id: "s2" }) + "\n");
    expect(s.isError).toBe(true);
    expect(s.subtype).toBe("error_max_turns");
    expect(s.result).toBe("");
    expect(s.turns).toBe(9);
  });

  test("empty input is an error (no result event)", () => {
    expect(parseStream("")).toEqual({ result: "", costUsd: 0, turns: 0, sessionId: "", isError: true });
  });

  test("only a result event clears isError", () => {
    const p = new StreamParser();
    p.push(JSON.stringify({ type: "system", subtype: "init", session_id: "s", is_error: false }) + "\n");
    p.push(JSON.stringify({ type: "assistant", session_id: "s", is_error: false }) + "\n");
    expect(p.summary.isError).toBe(true);
    p.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\n");
    expect(p.end().isError).toBe(false);
  });
});

// launch() needs a login; CI has none, so every launch gets a temp credentials file.
const CREDS = join(tmp, "fake-login", ".credentials.json");
mkdirSync(dirname(CREDS), { recursive: true });
writeFileSync(CREDS, '{"token":"invented"}');

function fakeChild(over: Partial<Child> = {}): Child {
  return { pid: 7, stdout: (async function* () {})(), exited: Promise.resolve(0), killGroup: () => {}, ...over };
}

const streamOf = (text: string) =>
  (async function* () {
    yield text;
  })();

const dead = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("launch", () => {
  test("runs through the spawner and returns the stream summary", async () => {
    const t = fresh("launch");
    const configDir = join(t, "cfg");
    // Split bytes mid-character so the decoder must stream.
    const bytes = new TextEncoder().encode(STREAM);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.slice(i, i + 5));
    const seen: { cmd?: string[]; cwd?: string; env?: Record<string, string> } = {};
    const kills: string[] = [];
    const spawner: Spawner = (cmd, o) => {
      seen.cmd = cmd;
      seen.cwd = o.cwd;
      seen.env = o.env;
      return fakeChild({
        pid: 4242,
        stdout: (async function* () {
          for (const c of chunks) yield c;
        })(),
        killGroup: (sig) => kills.push(sig),
      });
    };

    const r = await launch({
      role: "verifier",
      taskId: "T-0042",
      cwd: t,
      repoRoot: t,
      prompt: "verify",
      configDir,
      baseEnv: { CLAUDECODE: "1" },
      credentials: CREDS,
      spawner,
    });
    expect(r).toEqual({ ...EXPECTED, exitCode: 0, pid: 4242, timedOut: false, warnings: [] });
    // A normal end still sends the group SIGTERM, for leftovers.
    expect(kills).toEqual(["SIGTERM"]);
    expect(seen.cwd).toBe(t);
    expect(seen.cmd?.slice(-2)).toEqual(["--", "verify"]);
    expect(seen.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(seen.env?.FOREMAN_ACTOR).toBe("verifier-T-0042");
    expect("CLAUDECODE" in (seen.env ?? {})).toBe(false);
    // ensureConfigDir ran on that dir, linking the given credentials.
    expect(readdirSync(configDir)).toEqual([".credentials.json"]);
    expect(readlinkSync(join(configDir, ".credentials.json"))).toBe(CREDS);
  });

  test("string chunks and a non-zero exit pass through", async () => {
    const t = fresh("launch");
    const spawner: Spawner = () =>
      fakeChild({
        stdout: (async function* () {
          yield STREAM.slice(0, 40);
          yield STREAM.slice(40);
        })(),
        exited: Promise.resolve(3),
      });
    const r = await launch({ ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg") }), credentials: CREDS, spawner });
    expect(r.exitCode).toBe(3);
    expect(r.result).toBe(EXPECTED.result);
  });

  test("no login: throws a clear error before spawning", async () => {
    const t = fresh("nologin");
    let spawned = false;
    const spawner: Spawner = () => {
      spawned = true;
      return fakeChild();
    };
    const missing = join(t, "no-login.json");
    const opts = { ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg"), baseEnv: { PATH: "/usr/bin" } }), credentials: missing, spawner };
    await expect(launch(opts)).rejects.toThrow(/no Claude Code login at .*no-login\.json.*ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/);
    expect(spawned).toBe(false);
    expect(existsSync(join(t, "cfg"))).toBe(false);
    // An empty key doesn't count as a login.
    await expect(launch({ ...opts, baseEnv: { ANTHROPIC_API_KEY: "" } })).rejects.toThrow(/no Claude Code login/);
  });

  test("no credentials file but a login env var: launches", async () => {
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      const t = fresh("envlogin");
      const r = await launch({
        ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg"), baseEnv: { [key]: "invented-key" } }),
        credentials: join(t, "no-login.json"),
        spawner: () => fakeChild({ stdout: streamOf(STREAM) }),
      });
      expect(r.result).toBe(EXPECTED.result);
    }
  });

  test("warns when the session replaced the credentials link with a file", async () => {
    const t = fresh("warn");
    const configDir = join(t, "cfg");
    const spawner: Spawner = () => {
      const link = join(configDir, ".credentials.json");
      rmSync(link);
      writeFileSync(link, '{"token":"refreshed"}');
      return fakeChild({ stdout: streamOf(STREAM) });
    };
    const r = await launch({ ...base({ cwd: t, repoRoot: t, configDir }), credentials: CREDS, spawner });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(join(configDir, ".credentials.json"));
    expect(r.warnings[0]).toContain("no longer a symlink");
    // The next launch puts the link back.
    const again = await launch({ ...base({ cwd: t, repoRoot: t, configDir }), credentials: CREDS, spawner: () => fakeChild() });
    expect(again.warnings).toEqual([]);
    expect(readlinkSync(join(configDir, ".credentials.json"))).toBe(CREDS);
  });

  test("a missing binary rejects instead of crashing the process", async () => {
    const t = fresh("enoent");
    const spawner: Spawner = (_cmd, o) => defaultSpawner([join(t, "no-such-claude")], o);
    await expect(launch({ ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg") }), credentials: CREDS, spawner })).rejects.toThrow(/ENOENT/);
    // Still alive and able to launch again.
    const r = await launch({ ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg") }), credentials: CREDS, spawner: () => fakeChild() });
    expect(r.exitCode).toBe(0);
  });

  test("timeout: SIGTERM, then SIGKILL and closeStdout after the grace period", async () => {
    const t = fresh("grace");
    const kills: string[] = [];
    let closed = false;
    let close!: () => void;
    const closedP = new Promise<void>((r) => (close = r));
    let exit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    // Ignores SIGTERM, and an escaped process holds its stdout open.
    const spawner: Spawner = () =>
      fakeChild({
        stdout: (async function* () {
          yield STREAM.slice(0, 30);
          await closedP;
        })(),
        exited,
        killGroup: (sig) => {
          kills.push(sig);
          if (sig === "SIGKILL") exit(null);
        },
        closeStdout: () => {
          closed = true;
          close();
        },
      });
    const start = Date.now();
    const r = await launch({ ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg"), timeoutMs: 50 }), killGraceMs: 50, credentials: CREDS, spawner });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.isError).toBe(true); // no result event arrived
    expect(closed).toBe(true);
    expect(kills).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
  });

  test("timeout kills the whole process group, grandchildren included", async () => {
    const t = fresh("timeout");
    const pidFile = join(t, "grandchild.pid");
    let childPid = 0;
    const spawner: Spawner = (_cmd, o) => {
      const c = defaultSpawner(["sh", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`], o);
      childPid = c.pid;
      return c;
    };
    const start = Date.now();
    const r = await launch({
      ...base({ cwd: t, repoRoot: t, configDir: join(t, "cfg"), baseEnv: { PATH: process.env.PATH }, timeoutMs: 300 }),
      killGraceMs: 200,
      credentials: CREDS,
      spawner,
    });
    const took = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.pid).toBe(childPid);
    expect(took).toBeLessThan(10_000);

    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(grandchild).toBeGreaterThan(0);
    // Give the kernel a moment to reap.
    for (let i = 0; i < 50 && !(dead(grandchild) && dead(childPid)); i++) await Bun.sleep(20);
    expect(dead(grandchild)).toBe(true);
    expect(dead(childPid)).toBe(true);
  }, 15_000);
});
