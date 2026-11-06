// Background mode (D0022): `claude --bg` sessions watched through a fake
// `claude agents --json --all` and a transcript the fake writes. No Claude Code runs.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, type Task } from "../src/core";
import { branchFor, Dispatcher, launchModeFrom } from "../src/dispatch";
import { toMarkdown } from "../src/export";
import {
  type AgentEntry,
  type BgCli,
  buildLaunch,
  costOf,
  launch,
  type LaunchOptions,
  projectMcpConfig,
  sessionNameFor,
  summarizeTranscript,
  transcriptPath,
} from "../src/launch";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "foreman-bg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const d = join(dir, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const flag = (cmd: string[], name: string) => cmd[cmd.indexOf(name) + 1];

describe("buildLaunch in background mode", () => {
  const repo = fresh("repo");
  const base: LaunchOptions = { role: "worker", taskId: "T-7", cwd: repo, prompt: "-p do it", repoRoot: repo, policyRoot: repo, mode: "bg" };

  test("starts a named claude --bg session isolated by flags, not by a config dir", () => {
    const { cmd, env } = buildLaunch({ ...base, baseEnv: { HOME: "/home/x", FOREMAN_AGENT: "1", CLAUDECODE: "1" } });
    expect(cmd.slice(0, 4)).toEqual(["claude", "--bg", "--name", sessionNameFor(repo, "worker", "T-7")]);
    expect(flag(cmd, "--name")).toMatch(/^repo-\d+ T-7 worker$/);
    expect(flag(cmd, "--setting-sources")).toBe("project,local");
    expect(cmd).toContain("--strict-mcp-config");
    expect(flag(cmd, "--permission-mode")).toBe("dontAsk");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--max-turns"); // ignored by --bg: foreman enforces it
    expect(cmd.slice(-2)).toEqual(["--", "-p do it"]);
    const settings = JSON.parse(flag(cmd, "--settings")!);
    expect(settings.autoMemoryEnabled).toBe(false);
    // A --bg session doesn't inherit the environment: foreman's variables ride in settings.
    expect(settings.env).toEqual({ FOREMAN_AGENT: "1", FOREMAN_ACTOR: "worker-T-7" });
    // The person's own config dir, so the session shows in their `claude agents`.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  test("keeps the role's tools and deny rules", () => {
    const { cmd } = buildLaunch({ ...base, role: "verifier" });
    expect(flag(cmd, "--disallowedTools")!.split(",")).toContain("Edit");
    expect(flag(cmd, "--allowedTools")!.split(",")).toContain("mcp__foreman__record_verdict");
  });

  test("structured output and the default stay in print mode", () => {
    const p = { ...base, configDir: "/cfg" };
    expect(buildLaunch({ ...p, jsonSchema: { type: "object" } }).cmd.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(buildLaunch({ ...p, mode: undefined }).cmd.slice(0, 2)).toEqual(["claude", "-p"]);
  });

  test("passes the project's .mcp.json servers, or foreman's own", () => {
    const withMcp = fresh("mcp");
    const servers = { foreman: { command: "bun", args: ["/abs/cli.ts", "mcp"] }, db: { command: "db-mcp" } };
    writeFileSync(join(withMcp, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
    expect(projectMcpConfig(withMcp)).toEqual({ mcpServers: servers });
    const { cmd } = buildLaunch({ ...base, cwd: withMcp, repoRoot: withMcp, policyRoot: withMcp });
    expect(JSON.parse(flag(cmd, "--mcp-config")!)).toEqual({ mcpServers: servers });
    // a relative cli.ts runs the main checkout's copy, not the worktree's (T-0076)
    const rel = fresh("rel");
    writeFileSync(join(rel, ".mcp.json"), JSON.stringify({ mcpServers: { ...servers, foreman: { command: "bun", args: ["packages/foreman/src/cli.ts", "mcp"] } } }));
    expect(projectMcpConfig(rel).mcpServers).toEqual({ ...servers, foreman: { command: "bun", args: [join(rel, "packages/foreman/src/cli.ts"), "mcp"] } });
    expect(Object.keys(projectMcpConfig(fresh("none")).mcpServers)).toEqual(["foreman"]);
  });

  test("the dispatcher picks background mode unless asked for print", () => {
    expect(launchModeFrom(undefined, {})).toBe("bg");
    expect(launchModeFrom(undefined, { FOREMAN_LAUNCH: "print" })).toBe("print");
    expect(launchModeFrom("print", {})).toBe("print");
  });
});

describe("transcripts", () => {
  const line = (id: string, usage: object, content: object[] = [], model = "claude-haiku-5-5") =>
    JSON.stringify({ type: "assistant", message: { id, model, usage, content } });

  test("count each message once, though Claude Code writes a line per block", () => {
    const u = { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const text = [
      line("m1", u, [{ type: "thinking" }]),
      line("m1", u, [{ type: "tool_use" }]),
      JSON.stringify({ type: "user", message: {} }),
      "not json",
      line("m2", u, [{ type: "text", text: "all done" }]),
    ].join("\n");
    const s = summarizeTranscript(text);
    expect(s.turns).toBe(2);
    expect(s.lastText).toBe("all done");
    expect(s.costUsd).toBeCloseTo(2 * costOf("claude-haiku-5-5", u), 12);
  });

  test("price output, cache reads and both cache-write lengths", () => {
    // Haiku 5.5: $0.10 in, $0.50 out, $0.01 cache read; writes 1.25x (5 min) or 2x (1 h).
    expect(costOf("claude-haiku-5-5", { output_tokens: 1_000_000 })).toBeCloseTo(0.5);
    expect(costOf("claude-haiku-5-5", { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.01);
    expect(
      costOf("claude-haiku-5-5", {
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ).toBeCloseTo(0.125 + 0.2);
    expect(costOf("claude-opus-5-5", { input_tokens: 1_000_000 })).toBeCloseTo(4);
    // An unknown model is priced like the dearest.
    expect(costOf("mystery", { input_tokens: 1_000_000 })).toBeCloseTo(10);
  });
});

/** One step of a fake session, applied when `claude agents --json` is next asked. */
interface Step {
  status: AgentEntry["status"];
  /** Output tokens of an assistant message appended to the transcript (Haiku). */
  out?: number;
  text?: string;
  /** Called at this step, e.g. to have the worker submit its task. */
  then?: () => void;
}

/** A fake `claude`: each started session plays its steps, one per `agents` call; the last repeats. */
function fakeCli(scripts: Step[][], opts: { refuse?: string } = {}) {
  const configDir = fresh("cfg");
  const calls = { started: [] as string[][], stopped: [] as string[], agents: 0 };
  const sessions: { id: string; sessionId: string; name: string; cwd: string; pid: number; steps: Step[]; at: number; stopped: boolean; msg: number }[] = [];
  const cli: BgCli = {
    configDir,
    async start(cmd, o) {
      calls.started.push(cmd);
      if (opts.refuse) return { code: 1, stdout: "", stderr: opts.refuse };
      const i = sessions.length;
      const id = (0xabc00000 + i).toString(16);
      const name = flag(cmd, "--name")!;
      sessions.push({ id, sessionId: `${id}-0000-4000-8000-000000000000`, name, cwd: o.cwd, pid: 50_000 + i, steps: scripts[i] ?? [{ status: "idle" }], at: 0, stopped: false, msg: 0 });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n  claude agents   list sessions\n`, stderr: "" };
    },
    async agents() {
      calls.agents++;
      return sessions.map((s) => {
        if (s.stopped) return { id: s.id, sessionId: s.sessionId, name: s.name, pid: null, status: null, kind: "background" };
        const step = s.steps[Math.min(s.at, s.steps.length - 1)]!;
        if (s.at < s.steps.length) {
          s.at++;
          if (step.out !== undefined) {
            const p = transcriptPath(configDir, s.cwd, s.sessionId);
            mkdirSync(join(p, ".."), { recursive: true });
            const content = step.text ? [{ type: "text", text: step.text }] : [{ type: "tool_use" }];
            appendFileSync(p, JSON.stringify({ type: "assistant", message: { id: `m${s.msg++}`, model: "claude-haiku-5-5", usage: { output_tokens: step.out }, content } }) + "\n");
          }
          if (step.text) {
            mkdirSync(join(configDir, "jobs", s.id), { recursive: true });
            appendFileSync(join(configDir, "jobs", s.id, "timeline.jsonl"), JSON.stringify({ state: "done", text: step.text }) + "\n");
          }
          step.then?.();
        }
        return { id: s.id, sessionId: s.sessionId, name: s.name, pid: s.pid, status: step.status, kind: "background" };
      });
    },
    async stop(id) {
      calls.stopped.push(id);
      const s = sessions.find((x) => x.id === id);
      if (s) s.stopped = true;
    },
    stopSync(id) {
      calls.stopped.push(id);
    },
  };
  return { cli, calls, sessions, configDir };
}

const M = 1_000_000;
const bgBase = (cwd: string): LaunchOptions => ({ role: "worker", taskId: "T-9", cwd, prompt: "go", repoRoot: cwd, policyRoot: cwd, mode: "bg" });

describe("launch in background mode", () => {
  test("watches a session to the end of its turn, then stops it", async () => {
    const cwd = fresh("wt");
    const { cli, calls } = fakeCli([[{ status: "busy" }, { status: "busy", out: 1000 }, { status: "idle", out: 2000, text: "PR opened" }]]);
    const spawned: unknown[] = [];
    const r = await launch({ ...bgBase(cwd), cli, pollMs: 1, onSpawn: (pid, s) => spawned.push([pid, s]) });
    expect(spawned).toEqual([[50_000, { id: "abc00000", name: sessionNameFor(cwd, "worker", "T-9"), sessionId: "abc00000-0000-4000-8000-000000000000" }]]);
    expect(r.isError).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.result).toBe("PR opened");
    expect(r.turns).toBe(2);
    expect(r.costUsd).toBeCloseTo((3000 * 0.5) / M, 12);
    expect(r.session?.id).toBe("abc00000");
    expect(calls.stopped).toEqual(["abc00000"]);
  });

  test("stops a session over its budget or its turns", async () => {
    const big = { status: "busy" as const, out: 10 * M }; // $5 of Haiku output per message
    const a = fakeCli([[{ status: "busy" }, big, big]]);
    const r = await launch({ ...bgBase(fresh("wt")), cli: a.cli, pollMs: 1, maxBudgetUsd: 7 });
    expect(r.isError).toBe(true);
    expect(r.subtype).toBe("error_max_budget_usd");
    expect(r.costUsd).toBeCloseTo(10);
    expect(a.calls.stopped).toEqual(["abc00000"]);

    const b = fakeCli([[{ status: "busy", out: 1 }, { status: "busy", out: 1 }, { status: "busy", out: 1 }]]);
    const t = await launch({ ...bgBase(fresh("wt")), cli: b.cli, pollMs: 1, maxTurns: 2 });
    expect(t.subtype).toBe("error_max_turns");
    expect(b.calls.stopped).toEqual(["abc00000"]);
  });

  test("stops a session that runs past its timeout", async () => {
    const { cli, calls } = fakeCli([[{ status: "busy" }]]);
    const r = await launch({ ...bgBase(fresh("wt")), cli, pollMs: 2, timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.isError).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(calls.stopped).toEqual(["abc00000"]);
  });

  test("stops a session left waiting at a permission prompt", async () => {
    const { cli, calls } = fakeCli([[{ status: "busy", out: 1 }, { status: "waiting" }]]);
    const r = await launch({ ...bgBase(fresh("wt")), cli, pollMs: 2, waitingLimitMs: 20 });
    expect(r.result).toMatch(/permission prompt/);
    expect(calls.stopped).toEqual(["abc00000"]);
  });

  test("notices a session stopped outside foreman, and doesn't stop it again", async () => {
    const fake = fakeCli([[{ status: "busy", out: 5 }, { status: "busy", then: () => (fake.sessions[0]!.stopped = true) }]]);
    const r = await launch({ ...bgBase(fresh("wt")), cli: fake.cli, pollMs: 1 });
    expect(r.isError).toBe(true);
    expect(r.result).toMatch(/stopped outside foreman/);
    expect(fake.calls.stopped).toEqual([]);
  });

  test("falls back to print mode when claude --bg refuses, or throws if told not to", async () => {
    const cwd = fresh("wt");
    const { cli } = fakeCli([], { refuse: "Workspace not trusted. Run `claude` in /x once" });
    const creds = join(cwd, "creds.json");
    writeFileSync(creds, "{}");
    const seen: string[][] = [];
    const r = await launch({
      ...bgBase(cwd),
      cli,
      credentials: creds,
      configDir: join(cwd, "cfg"),
      spawner: (cmd) => {
        seen.push(cmd);
        return {
          pid: 4242,
          stdout: (async function* () {
            yield `${JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0.01, num_turns: 1, is_error: false, session_id: "s" })}\n`;
          })(),
          exited: Promise.resolve(0),
          killGroup() {},
        };
      },
    });
    expect(seen[0]!.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(r.result).toBe("ok");
    expect(r.warnings[0]).toMatch(/print mode because claude --bg refused: Workspace not trusted/);
    await expect(launch({ ...bgBase(cwd), cli, fallbackToPrint: false })).rejects.toThrow(/refused/);
  });
});

describe("the janitor and background sessions", () => {
  test("removes a finished task's sessions with claude rm, along with its worktree", async () => {
    const root = fresh("jroot");
    const wt = join(root, ".claude", "worktrees", "T-1");
    mkdirSync(wt, { recursive: true });
    const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
    const f = new Foreman(openDb(":memory:"), root, () => Date.now(), policy, () => false);
    const ada: Actor = { name: "ada", kind: "human" };
    const w: Actor = { name: "worker-T-0001", kind: "agent" };
    const v: Actor = { name: "verifier-T-0001", kind: "agent" };
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], risk: "auto", ready: true }, ada);
    f.claim(t.id, w);
    f.progress(t.id, w, { branch: "b", worktree: wt });
    f.pinLease(t.id, w, 123, { session: "abc00000", name: "repo T-0001 worker" });
    f.submit(t.id, w, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, v);
    f.pinLease(t.id, v, 124, { session: "abc00001", name: "repo T-0001 verifier" });
    f.recordVerify(t.id, v, f.get(t.id).acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" })));
    f.merged(t.id, ada, "https://example.com/pull/1");
    const ran: string[][] = [];
    const run = (cmd: string[]) => {
      ran.push(cmd);
      if (cmd.join(" ") === "git worktree list --porcelain") return `worktree ${root}\nworktree ${wt}`;
      if (cmd[1] === "rev-parse") return null;
      return "";
    };
    const { janitor } = await import("../src/janitor");
    const report = await janitor(f, ada, { run, releasePorts: async () => false });
    expect(report.removed).toEqual([{ id: t.id, worktree: wt, branchDeleted: false, portsReleased: false, sessions: ["abc00000", "abc00001"] }]);
    expect(ran.filter((c) => c[0] === "claude")).toEqual([
      ["claude", "rm", "abc00000"],
      ["claude", "rm", "abc00001"],
    ]);
  });
});

describe("dispatch with background sessions", () => {
  const human: Actor = { name: "ada", kind: "human" };
  function setup() {
    const root = fresh("root");
    const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
    // Fake PIDs live while their fake session isn't stopped.
    let fake: ReturnType<typeof fakeCli> | undefined;
    const alive = (pid: number) => !!fake?.sessions.some((s) => s.pid === pid && !s.stopped);
    const f = new Foreman(openDb(":memory:"), root, () => Date.now(), policy, alive);
    const worktrees = (t: Task) => {
      const path = join(root, t.id);
      mkdirSync(path, { recursive: true });
      return { branch: branchFor(t), path };
    };
    const log: string[] = [];
    const run = async (scripts: (task: () => Task) => Step[][], o: { timeoutMs?: number } = {}) => {
      const t = f.create({ title: "bg task", acceptance: ["cmd: true"], paths: ["src/**"], risk: "auto", ready: true }, human);
      fake = fakeCli(scripts(() => f.get(t.id)));
      const d = new Dispatcher(f, {
        once: true,
        pollMs: 2,
        worktrees,
        log: (l) => log.push(l),
        launcher: (opts, onSpawn) => launch({ ...opts, onSpawn, cli: fake!.cli, pollMs: 1, timeoutMs: o.timeoutMs, cwd: opts.cwd }),
      });
      return { t, sessions: await d.run(), fake: fake! };
    };
    return { f, run, log };
  }
  const worker = (f: Foreman, id: string) => ({ name: `worker-${id}`, kind: "agent" as const });
  const verifier = (f: Foreman, id: string) => ({ name: `verifier-${id}`, kind: "agent" as const });

  test("starts a worker and a verifier as named sessions, records how to attach, and adds up their cost", async () => {
    const env = setup();
    const { t, sessions, fake } = await env.run((task) => [
      [
        { status: "busy", out: 1000 },
        { status: "idle", out: 1000, text: "submitted", then: () => env.f.submit(task().id, worker(env.f, task().id), { pr: "https://example.com/pull/1", summary: "s" }) },
      ],
      [
        { status: "busy", out: 500 },
        {
          status: "idle",
          out: 500,
          text: "verified",
          then: () => env.f.recordVerify(task().id, verifier(env.f, task().id), task().acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" }))),
        },
      ],
    ]);
    expect(sessions.map((s) => [s.role, s.status, s.session?.id])).toEqual([
      ["worker", "in_review", "abc00000"],
      ["verifier", "approved", "abc00001"],
    ]);
    expect(sessions[0]!.costUsd).toBeCloseTo((2000 * 0.5) / M, 12);
    expect(sessions[1]!.costUsd).toBeCloseTo((1000 * 0.5) / M, 12);
    // Each session's name says repo, task and role; both were stopped once done.
    expect(fake.calls.started.map((c) => flag(c, "--name")!.split(" ").slice(1))).toEqual([
      [t.id, "worker"],
      [t.id, "verifier"],
    ]);
    expect(fake.calls.stopped).toEqual(["abc00000", "abc00001"]);
    // fm show and the board say how to watch each session.
    const pinned = env.f.events(t.id).filter((e) => e.type === "lease_pinned");
    expect(pinned.map((e) => e.data.attach)).toEqual(["claude attach abc00000", "claude attach abc00001"]);
    expect(toMarkdown(env.f.get(t.id), env.f.events(t.id))).toContain('session "' + fake.sessions[0]!.name + '", `claude attach abc00000`');
    expect(env.log.some((l) => l.includes("claude attach abc00000"))).toBe(true);
  });

  test("a worker that runs out of time is stopped and its task let go", async () => {
    const env = setup();
    const { t, sessions, fake } = await env.run(() => [[{ status: "busy", out: 10 }]], { timeoutMs: 30 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.error).toBe("timed out");
    expect(fake.calls.stopped).toEqual(["abc00000"]);
    // The session's PID is gone once stopped, so the pinned lease let the task go.
    expect(env.f.get(t.id).status).toBe("ready");
  });
});
