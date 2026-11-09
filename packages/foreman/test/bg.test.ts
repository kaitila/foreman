// Background mode (D0022): `claude --bg` sessions watched through a fake
// `claude agents --json --all` and a transcript the fake writes. No Claude Code runs.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, type Event, Foreman, type Task } from "../src/core";
import { branchFor, Dispatcher, launchModeFrom } from "../src/dispatch";
import { toMarkdown } from "../src/export";
import { janitor, removeFinishedSessions, SESSIONS_BACKOFF_MS, SESSIONS_PER_RUN, sessionsToRemove } from "../src/janitor";
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
import { DEFAULT_PROTECTED, type Policy, type Run } from "../src/policy";
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
    expect(settings.env).toEqual({ FOREMAN_AGENT: "1", FOREMAN_ACTOR: "worker-T-7", FOREMAN_BIN: env.FOREMAN_BIN });
    // The person's own config dir, so the session shows in their `claude agents`.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  test("FOREMAN_BIN is the main checkout's foreman, for worker and verifier, in bg and print mode", () => {
    const main = fresh("main");
    mkdirSync(join(main, "packages/foreman/src"), { recursive: true });
    writeFileSync(join(main, "packages/foreman/src/cli.ts"), "");
    const want = `bun ${join(main, "packages/foreman/src/cli.ts")}`;
    for (const role of ["worker", "verifier"] as const) {
      const bg = buildLaunch({ ...base, role, policyRoot: main, baseEnv: { FOREMAN_BIN: "stale" } });
      expect(bg.env.FOREMAN_BIN).toBe(want);
      expect(JSON.parse(flag(bg.cmd, "--settings")!).env.FOREMAN_BIN).toBe(want);
      const pr = buildLaunch({ ...base, role, policyRoot: main, mode: "print", configDir: repo });
      expect(pr.env.FOREMAN_BIN).toBe(want);
    }
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

describe("finished tasks' sessions leave the sessions list (T-0099)", () => {
  const ada: Actor = { name: "ada", kind: "human" };
  const janitorActor: Actor = { name: "janitor", kind: "agent" };
  const ev = (type: string, data: Record<string, unknown>) => ({ id: 0, taskId: "T-1", at: 1, actor: "a", actorKind: "agent", type, data }) as Event;

  test("sessionsToRemove: lease_pinned hex ids of 6+ chars, once each, minus the ones already removed", () => {
    expect(
      sessionsToRemove([
        ev("lease_pinned", { pid: 1, session: "abc00000" }),
        ev("lease_pinned", { pid: 2 }), // a print-mode session: no id
        ev("lease_pinned", { pid: 3, session: "abc00000" }), // the same one again
        ev("lease_pinned", { pid: 4, session: "abc1" }), // too short
        ev("lease_pinned", { pid: 5, session: "not-hex-zz" }),
        ev("lease_pinned", { pid: 6, session: "ABC00000" }), // not lower-case hex
        ev("lease_pinned", { pid: 7, session: 1234567 }),
        ev("lease_pinned", { pid: 8, session: "def00001" }),
        ev("lease_pinned", { pid: 9, session: "fed00002" }),
        ev("sessions_removed", { sessions: ["def00001"] }),
        ev("claimed", { session: "aaa00003" }), // only lease_pinned names a session
      ]),
    ).toEqual(["abc00000", "fed00002"]);
    expect(sessionsToRemove([])).toEqual([]);
    expect(sessionsToRemove([ev("lease_pinned", { session: "abc00000" }), ev("sessions_removed", { sessions: ["abc00000"] })])).toEqual([]);
  });

  /** A foreman with tasks in each state, each with background sessions pinned. */
  function setup() {
    const root = fresh("sroot");
    const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
    const f = new Foreman(openDb(":memory:"), root, () => Date.now(), policy, () => false);
    const add = (title: string, path: string) => f.create({ title, acceptance: ["cmd: true"], paths: [path], risk: "auto", ready: true }, ada);
    const actor = (role: string, id: string): Actor => ({ name: `${role}-${id}`, kind: "agent" });
    /** Done, through a worker and a verifier session; its worktree is `worktree` (missing by default). */
    const done = (worktree = join(root, "gone", "wt")) => {
      const t = add("done", `src/d${n++}/**`);
      const w = actor("worker", t.id), v = actor("verifier", t.id);
      f.claim(t.id, w);
      f.progress(t.id, w, { branch: `b-${t.id}`, worktree });
      f.pinLease(t.id, w, 100, { session: `a0${t.id.slice(2)}00`, name: `${t.id} worker` });
      f.submit(t.id, w, { pr: "https://example.com/pull/1" });
      f.startVerify(t.id, v);
      f.pinLease(t.id, v, 101, { session: `a0${t.id.slice(2)}01`, name: `${t.id} verifier` });
      f.recordVerify(t.id, v, f.get(t.id).acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" })));
      f.merged(t.id, ada, "https://example.com/pull/1");
      expect(f.get(t.id).status).toBe("done");
      return t;
    };
    const cancelled = () => {
      const t = add("cancelled", `src/c${n++}/**`);
      const w = actor("worker", t.id);
      f.claim(t.id, w);
      f.pinLease(t.id, w, 102, { session: `b0${t.id.slice(2)}00`, name: `${t.id} worker` });
      f.cancel(t.id, ada, "not needed");
      return t;
    };
    const working = () => {
      const t = add("working", `src/w${n++}/**`);
      const w = actor("worker", t.id);
      f.claim(t.id, w);
      f.progress(t.id, w, { note: "on it" });
      f.pinLease(t.id, w, 103, { session: `c0${t.id.slice(2)}00`, name: `${t.id} worker` });
      return t;
    };
    /** A fake `claude rm`: what each id answers ("ok", or the stderr of a failure). Anything else succeeds. */
    const answers = new Map<string, string>();
    const ran: string[][] = [];
    const run: Run = (cmd) => {
      ran.push(cmd);
      if (cmd[0] === "claude" && cmd[1] === "rm") {
        const a = answers.get(cmd[2]!) ?? "ok";
        run.lastError = a === "ok" ? undefined : a;
        return a === "ok" ? "" : null;
      }
      if (cmd.join(" ") === "git worktree list --porcelain") return `worktree ${root}`;
      return "";
    };
    const rms = () => ran.filter((c) => c[0] === "claude").map((c) => c[2]);
    const removedEvents = (id: string) => f.events(id).filter((e) => e.type === "sessions_removed");
    return { root, f, done, cancelled, working, answers, run, ran, rms, removedEvents };
  }

  test("removes a done task's (worktree gone) and a cancelled task's sessions once, records them, and leaves an in_progress task alone", () => {
    const env = setup();
    const d = env.done();
    const c = env.cancelled();
    const w = env.working();
    const dIds = sessionsToRemove(env.f.events(d.id));
    const cIds = sessionsToRemove(env.f.events(c.id));
    expect(dIds).toHaveLength(2);
    expect(cIds).toHaveLength(1);

    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([
      { id: d.id, sessions: dIds },
      { id: c.id, sessions: cIds },
    ]);
    expect(env.ran).toEqual([...dIds, ...cIds].map((id) => ["claude", "rm", id]));
    expect(env.removedEvents(d.id)).toEqual([expect.objectContaining({ actor: "janitor", data: { sessions: dIds } })]);
    expect(env.removedEvents(c.id)).toEqual([expect.objectContaining({ data: { sessions: cIds } })]);
    // The task still running keeps its session and gets no event.
    expect(env.removedEvents(w.id)).toEqual([]);
    expect(env.f.get(w.id).status).toBe("in_progress");

    // A second pass has nothing left to do: no claude rm, no new events.
    env.ran.length = 0;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([]);
    expect(env.ran).toEqual([]);
    expect(env.removedEvents(d.id)).toHaveLength(1);
  });

  test("a session already gone (No job matching) counts as removed; another failure ends the run and pauses removals for 10 minutes", () => {
    const env = setup();
    const d = env.done();
    const later = env.done();
    const laterIds = sessionsToRemove(env.f.events(later.id));
    const [first, second] = sessionsToRemove(env.f.events(d.id)) as [string, string];
    env.answers.set(first, `Error: No job matching "${first}"`);
    env.answers.set(second, "Error: session is running");
    const t0 = 1_000_000_000;

    // first counts as removed; second fails, so the run stops there: the later task isn't tried.
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t0)).toEqual([{ id: d.id, sessions: [first] }]);
    expect(env.rms()).toEqual([first, second]);
    expect(env.removedEvents(d.id).map((e) => e.data.sessions)).toEqual([[first]]);
    expect(env.removedEvents(later.id)).toEqual([]);
    expect(sessionsToRemove(env.f.events(d.id))).toEqual([second]);

    // Paused: nothing runs until SESSIONS_BACKOFF_MS has passed.
    env.ran.length = 0;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t0 + SESSIONS_BACKOFF_MS - 1)).toEqual([]);
    expect(env.ran).toEqual([]);
    expect(SESSIONS_BACKOFF_MS).toBe(10 * 60_000);

    // After the pause it's tried again; still failing, nothing recorded, paused again.
    const t1 = t0 + SESSIONS_BACKOFF_MS;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t1)).toEqual([]);
    expect(env.rms()).toEqual([second]);
    expect(env.removedEvents(d.id)).toHaveLength(1);
    env.ran.length = 0;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t1 + 60_000)).toEqual([]);
    expect(env.ran).toEqual([]);

    // Stopped now: removed and recorded, the later task's go too, and none is tried again.
    env.answers.delete(second);
    const t2 = t1 + SESSIONS_BACKOFF_MS;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t2)).toEqual([
      { id: d.id, sessions: [second] },
      { id: later.id, sessions: laterIds },
    ]);
    expect(env.removedEvents(d.id).map((e) => e.data.sessions)).toEqual([[first], [second]]);
    env.ran.length = 0;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root, t2 + 1)).toEqual([]);
    expect(env.ran).toEqual([]);
  });

  test("at most SESSIONS_PER_RUN (5) claude rm calls a run; the rest go on the next run", () => {
    const env = setup();
    const tasks = [env.done(), env.done(), env.done()]; // 6 sessions
    expect(SESSIONS_PER_RUN).toBe(5);
    const lastIds = sessionsToRemove(env.f.events(tasks[2]!.id)) as [string, string];
    const first = removeFinishedSessions(env.f, janitorActor, env.run, env.root);
    expect(env.rms()).toHaveLength(5);
    expect(first.map((r) => [r.id, r.sessions.length])).toEqual([
      [tasks[0]!.id, 2],
      [tasks[1]!.id, 2],
      [tasks[2]!.id, 1],
    ]);
    env.ran.length = 0;
    const second = removeFinishedSessions(env.f, janitorActor, env.run, env.root);
    expect(second).toEqual([{ id: tasks[2]!.id, sessions: [lastIds[1]] }]);
    expect(env.rms()).toEqual([lastIds[1]]);
    expect(tasks.every((t) => sessionsToRemove(env.f.events(t.id)).length === 0)).toBe(true);
    env.ran.length = 0;
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([]);
    expect(env.ran).toEqual([]);
  });

  test("the default runner runs claude rm without the parent session's variables", () => {
    const env = setup();
    const d = env.done();
    const ids = sessionsToRemove(env.f.events(d.id));
    const saved = { NODE_ENV: process.env.NODE_ENV, CLAUDECODE: process.env.CLAUDECODE, CLAUDE_JOB_DIR: process.env.CLAUDE_JOB_DIR };
    const calls: { cmd: string[]; env: Record<string, string> }[] = [];
    // No real process: the spy answers every spawn as a success.
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[], o: { env: Record<string, string> }) => {
      calls.push({ cmd, env: o.env });
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as never);
    try {
      delete process.env.NODE_ENV;
      process.env.CLAUDECODE = "1";
      process.env.CLAUDE_JOB_DIR = "/tmp/job.example";
      expect(removeFinishedSessions(env.f, janitorActor)).toHaveLength(1);
    } finally {
      spawn.mockRestore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(String(process.env.NODE_ENV)).toBe("test"); // restored
    expect(calls.map((c) => c.cmd)).toEqual(ids.map((id) => ["claude", "rm", id]));
    expect(sessionsToRemove(env.f.events(d.id))).toEqual([]);
    for (const c of calls) {
      expect(c.env.CLAUDECODE).toBeUndefined();
      expect(c.env.CLAUDE_JOB_DIR).toBeUndefined();
      expect(c.env.PATH).toBe(process.env.PATH);
    }
  });

  test("FOREMAN_KEEP_SESSIONS=1 keeps every session: no claude rm, no events", () => {
    const env = setup();
    const d = env.done();
    const before = process.env.FOREMAN_KEEP_SESSIONS;
    process.env.FOREMAN_KEEP_SESSIONS = "1";
    try {
      expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.FOREMAN_KEEP_SESSIONS;
      else process.env.FOREMAN_KEEP_SESSIONS = before;
    }
    expect(env.ran).toEqual([]);
    expect(env.removedEvents(d.id)).toEqual([]);
    // Turned back on, the sessions go.
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toHaveLength(1);
  });

  test("under bun test with no runner given it runs nothing, so a test never removes a real session", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const env = setup();
    const d = env.done();
    // If the guard failed, the default runner would spawn: catch that instead of running claude.
    const spawn = spyOn(Bun, "spawnSync").mockImplementation((() => {
      throw new Error("spawned a process");
    }) as never);
    try {
      expect(removeFinishedSessions(env.f, janitorActor)).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
    expect(env.removedEvents(d.id)).toEqual([]);
  });

  test("janitor: a done task whose worktree is outside the repository is kept, but its sessions still go", async () => {
    const env = setup();
    const outside = fresh("outside-wt");
    const d = env.done(outside);
    const ids = sessionsToRemove(env.f.events(d.id));
    const report = await janitor(env.f, janitorActor, { run: env.run, root: env.root, releasePorts: async () => false });
    expect(report.kept).toEqual([expect.objectContaining({ id: d.id, reason: "not inside the repository: left alone" })]);
    expect(report.removed).toEqual([]);
    expect(report.sessions).toEqual([{ id: d.id, sessions: ids }]);
    expect(env.rms()).toEqual(ids);
    expect(env.removedEvents(d.id)).toHaveLength(1);
    // A second run: nothing more to remove.
    env.ran.length = 0;
    expect((await janitor(env.f, janitorActor, { run: env.run, root: env.root, releasePorts: async () => false })).sessions).toEqual([]);
    expect(env.rms()).toEqual([]);
  });

  test("a session whose pinned process is still alive is skipped until it's gone", () => {
    const env = setup();
    const d = env.done();
    const c = env.cancelled();
    // A finished task has no lease any more, so the check reads the pid each session's
    // lease_pinned event recorded: mark d's as alive.
    const alive = new Set(env.f.events(d.id).filter((e) => e.type === "lease_pinned").map((e) => e.data.pid as number));
    expect(alive.size).toBeGreaterThan(0);
    env.f.isAlive = (pid: number) => alive.has(pid);
    const cIds = sessionsToRemove(env.f.events(c.id));
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([{ id: c.id, sessions: cIds }]);
    expect(env.rms()).toEqual(cIds);
    expect(env.removedEvents(d.id)).toEqual([]);
    alive.clear();
    env.ran.length = 0;
    const ids = sessionsToRemove(env.f.events(d.id));
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([{ id: d.id, sessions: ids }]);
    expect(env.rms()).toEqual(ids);
  });

  test("a finished task with nothing left to remove isn't read again on later calls (per foreman)", () => {
    const env = setup();
    const d = env.done();
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toHaveLength(1);
    const reads: string[] = [];
    const events = env.f.events.bind(env.f);
    env.f.events = (id: string) => (reads.push(id), events(id));
    // The call that finds it empty marks it; after that it's skipped without reading its events.
    removeFinishedSessions(env.f, janitorActor, env.run, env.root);
    reads.length = 0;
    removeFinishedSessions(env.f, janitorActor, env.run, env.root);
    removeFinishedSessions(env.f, janitorActor, env.run, env.root);
    expect(reads).not.toContain(d.id);
    expect(env.rms()).toHaveLength(2);
    // A task finished later is still picked up.
    const later = env.cancelled();
    expect(removeFinishedSessions(env.f, janitorActor, env.run, env.root)).toEqual([{ id: later.id, sessions: [expect.stringMatching(/^b0/)] }]);
    expect(reads).not.toContain(d.id);
  });

  test("janitor --dry-run attaches the sessions to the worktree it would remove, like a real run", async () => {
    const env = setup();
    const wt = join(env.root, ".claude", "worktrees", "T-dry");
    mkdirSync(wt, { recursive: true });
    const d = env.done(wt);
    const ids = sessionsToRemove(env.f.events(d.id));
    const run: Run = (cmd, cwd) => (cmd.join(" ") === "git worktree list --porcelain" ? `worktree ${env.root}\nworktree ${wt}` : env.run(cmd, cwd));
    const dry = await janitor(env.f, janitorActor, { run, root: env.root, dryRun: true, releasePorts: async () => false });
    expect(dry.removed).toEqual([{ id: d.id, worktree: wt, branchDeleted: false, portsReleased: false, sessions: ids }]);
    expect(dry.sessions).toEqual([{ id: d.id, sessions: ids }]);
    expect(env.rms()).toEqual([]);
    expect(env.removedEvents(d.id)).toEqual([]);
    const real = await janitor(env.f, janitorActor, { run, root: env.root, releasePorts: async () => false });
    expect(real.removed).toEqual([expect.objectContaining({ id: d.id, worktree: wt, sessions: ids })]);
    expect(real.sessions).toEqual(dry.sessions);
  });

  test("janitor --dry-run lists the sessions it would remove without running claude rm or recording anything", async () => {
    const env = setup();
    const d = env.done();
    const c = env.cancelled();
    env.working();
    const report = await janitor(env.f, janitorActor, { run: env.run, root: env.root, dryRun: true, releasePorts: async () => false });
    expect(report.sessions).toEqual([
      { id: d.id, sessions: sessionsToRemove(env.f.events(d.id)) },
      { id: c.id, sessions: sessionsToRemove(env.f.events(c.id)) },
    ]);
    expect(report.sessions.flatMap((s) => s.sessions)).toHaveLength(3);
    expect(env.rms()).toEqual([]);
    expect(env.removedEvents(d.id)).toEqual([]);
    expect(env.removedEvents(c.id)).toEqual([]);
  });

  test("janitor --dry-run with FOREMAN_KEEP_SESSIONS=1 lists no sessions", async () => {
    const env = setup();
    env.done();
    const before = process.env.FOREMAN_KEEP_SESSIONS;
    process.env.FOREMAN_KEEP_SESSIONS = "1";
    try {
      const report = await janitor(env.f, janitorActor, { run: env.run, root: env.root, dryRun: true, releasePorts: async () => false });
      expect(report.sessions).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.FOREMAN_KEEP_SESSIONS;
      else process.env.FOREMAN_KEEP_SESSIONS = before;
    }
    expect(env.rms()).toEqual([]);
  });

  test("janitor with no runner under bun test removes no sessions: no claude rm, no events", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const env = setup();
    const d = env.done(); // its worktree is missing, so the janitor's only real command is `git worktree list`, in a temp dir
    const real = Bun.spawnSync;
    const claude: string[][] = [];
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[], o: object) => {
      if (cmd[0] === "claude") {
        claude.push(cmd);
        throw new Error("spawned claude");
      }
      return real(cmd, o as never);
    }) as never);
    try {
      const report = await janitor(env.f, janitorActor, { root: env.root, releasePorts: async () => false });
      expect(report.sessions).toEqual([]);
    } finally {
      spawn.mockRestore();
    }
    expect(claude).toEqual([]);
    expect(env.removedEvents(d.id)).toEqual([]);
    expect(sessionsToRemove(env.f.events(d.id))).toHaveLength(2);
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
