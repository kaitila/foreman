// A session runs a plan and watches it (D0048): run_plan starts a detached dispatcher,
// watch_plan returns when something happened, stop_plan stops it, and none of the
// starting or stopping is open to a dispatched session.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError, type Task } from "../src/core";
import { registerDispatcher, unregisterDispatcher } from "../src/dispatchers";
import { ROLE_TOOLS } from "../src/launch";
import { Plans } from "../src/plans";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { planLogPath, refuseDispatched, runPlan, stopPlan, watchPlan, watchText } from "../src/run-plan";
import { openDb } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "foreman-run-plan-"));
Bun.spawnSync(["git", "init", "-q", dir]); // the in-memory foreman's root: transcripts are looked up from a repository
const started: number[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterAll(() => {
  for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const ada: Actor = { name: "ada", kind: "human" };
const session: Actor = { name: "mcp-1234", kind: "agent" };
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const DISPATCHED = ["worker-T-0001", "verifier-T-0001", "intake"];

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

/** An in-memory foreman with fake PIDs and a plan of two steps. */
function setup() {
  const pids = new Set<number>();
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
  const f = new Foreman(openDb(":memory:"), dir, Date.now, policy, (pid) => pids.has(pid));
  const plans = new Plans(f);
  const p = plans.create({ title: "Plan", steps: [{ title: "First", check: "one" }, { title: "Second", check: "two" }] }, ada).id;
  let n = 0;
  const add = (title: string, more: { step?: number; risk?: Task["risk"]; ready?: boolean } = {}) => {
    const t = f.create({ title, acceptance: ["cmd: true"], paths: [`src/${++n}/**`], risk: more.risk ?? "auto", ready: more.ready ?? true }, ada);
    plans.add(t.id, p, more.step ?? 1, ada);
    return t.id;
  };
  /** A dispatcher for the plan in the registry, as if one ran. */
  const dispatcher = (pid = 7001) => {
    pids.add(pid);
    registerDispatcher(f, { pid, scope: p, max: 3, flags: { once: false, verifyOnly: false, print: false }, starter: { name: "ada", kind: "human" }, cwd: dir, startedAt: Date.now() });
    return pid;
  };
  return { f, plans, p, add, dispatcher, pids };
}

describe("who may start or stop a dispatcher", () => {
  test("a dispatched worker, verifier or intake session is refused in the core; a person and a person's session are not", async () => {
    const env = setup();
    for (const name of DISPATCHED) {
      const actor: Actor = { name, kind: "agent" };
      expect(() => refuseDispatched(actor, "start")).toThrow("can't start a dispatcher");
      const run = await runPlan(env.f, env.p, actor).catch((e) => e);
      expect(run).toBeInstanceOf(ForemanError);
      expect((run as ForemanError).code).toBe("not_allowed");
      const stop = await stopPlan(env.f, env.p, actor).catch((e) => e);
      expect((stop as ForemanError).code).toBe("not_allowed");
      expect((stop as ForemanError).message).toContain(`a dispatched ${name.split("-")[0]} session can't stop a dispatcher`);
    }
    expect(() => refuseDispatched(ada, "start")).not.toThrow();
    expect(() => refuseDispatched(session, "stop")).not.toThrow();
    // A person who happens to be called worker-… is still a person.
    expect(() => refuseDispatched({ name: "worker-bee", kind: "human" }, "start")).not.toThrow();
  });

  test("run_plan and stop_plan are in every dispatched role's --disallowedTools, and in no role's allowed list", () => {
    for (const role of ["worker", "verifier", "intake"] as const) {
      for (const tool of ["mcp__foreman__run_plan", "mcp__foreman__stop_plan"]) {
        expect(ROLE_TOOLS[role].disallowed).toContain(tool);
        expect(ROLE_TOOLS[role].allowed).not.toContain(tool);
      }
    }
  });
});

describe("run_plan", () => {
  test("returns the dispatcher that already covers the plan and starts nothing; a --verify-only one doesn't count as covering", async () => {
    const env = setup();
    env.add("a task");
    const pid = env.dispatcher();
    // If it did start something, it would be this command, and the test would see the file.
    const marker = join(dir, "spawned-marker");
    const run = await runPlan(env.f, env.p, session, { command: ["sh", "-c", `touch ${marker}`] });
    expect(existsSync(marker)).toBe(false);
    expect(run).toMatchObject({ started: false, pid, scope: env.p, max: 3, startedBy: "ada", log: null });
    expect(run.note).toContain(`a dispatcher already covers ${env.p}: pid ${pid}`);
  });

  test("a plan that doesn't exist, is cancelled or is done is refused, and so are bad limits", async () => {
    const env = setup();
    const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ForemanError).code;
    expect(await code(runPlan(env.f, "P-0042", ada))).toBe("not_found");
    expect(await code(runPlan(env.f, env.p, ada, { max: 0 }))).toBe("invalid");
    expect(await code(runPlan(env.f, env.p, ada, { budgetUsd: -1 }))).toBe("invalid");
    env.plans.cancel(env.p, ada, "dropped");
    const refused = await runPlan(env.f, env.p, ada).catch((e) => e);
    expect((refused as ForemanError).message).toBe(`plan ${env.p} is cancelled: nothing to run`);
    expect(await code(stopPlan(env.f, "P-0042", ada))).toBe("not_found");
  });

  test("a command that ends without registering is reported with the end of its log", async () => {
    const env = setup();
    env.add("a task");
    const failed = await runPlan(env.f, env.p, ada, { command: ["sh", "-c", "echo boom; exit 3"], pollMs: 5 }).catch((e) => e);
    expect((failed as ForemanError).code).toBe("not_started");
    expect((failed as ForemanError).message).toContain("(exit 3)");
    expect((failed as ForemanError).message).toContain("boom");
    const nothing = await runPlan(env.f, env.p, ada, { command: ["sh", "-c", "echo nothing to dispatch"], pollMs: 5 }).catch((e) => e);
    expect((nothing as ForemanError).code).toBe("nothing_to_run");
    expect(planLogPath(env.f, env.p)).toBe(join(dir, ".foreman", `dispatch-${env.p}.log`));
    expect(readFileSync(planLogPath(env.f, env.p), "utf8")).toBe("boom\nnothing to dispatch\n");
  });
});

describe("the CLI: fm plan run, watch and stop with a real dispatcher", () => {
  const repo = join(dir, "repo");
  const db = join(dir, "cli", "foreman.db");
  const base = { ...process.env, FOREMAN_DB: db, FOREMAN_AGENT: "", CLAUDE_CODE_CHILD_SESSION: "", CLAUDE_CODE_SESSION_ID: "", NODE_ENV: "test" };
  /** Runs fm to its end, as its own process: the caller of `plan run` is gone when this returns. */
  const fm = async (actor: string, agent: boolean, ...args: string[]) => {
    const p = Bun.spawn(["bun", CLI, ...args], { cwd: repo, env: { ...base, FOREMAN_ACTOR: actor, FOREMAN_AGENT: agent ? "1" : "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out: out.trim(), err: err.trim() };
  };

  test("plan run starts a dispatcher that is still registered after the caller exits; a second run returns it; dispatched actors are refused; plan stop ends it", async () => {
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", repo]);
    // A plan with one task a person holds by hand: its dispatcher stays up to verify it, and starts no session.
    const f = new Foreman(openDb(db), repo, Date.now, { protectedPaths: [], changedFiles: () => ["src/x.ts"] });
    const plans = new Plans(f);
    const p = plans.create({ title: "Plan", steps: [{ title: "First", check: "one" }] }, ada).id;
    const t = f.create({ title: "held by hand", acceptance: ["cmd: true"], paths: ["src/a/**"], risk: "auto", ready: true }, ada).id;
    plans.add(t, p, 1, ada);
    const hand: Actor = { name: "by-hand", kind: "agent" };
    f.claim(t, hand);
    const wt = join(dir, "wt");
    mkdirSync(wt);
    f.progress(t, hand, { branch: "b", worktree: wt });

    // c3, from the CLI: no dispatched actor starts or stops one, through `plan` or `dispatch`.
    for (const name of DISPATCHED) {
      for (const args of [["plan", "run", p], ["plan", "stop", p], ["dispatch", "--plan", p, "--print"], ["dispatch", "--stop", p]]) {
        const r = await fm(name, true, ...args);
        expect(r.code).toBe(1);
        expect(r.err).toMatch(/a dispatched (worker|verifier|intake) session can't (start|stop) a dispatcher/);
      }
    }
    expect(await fm("ada", false, "dispatchers")).toMatchObject({ code: 0, out: "no dispatcher is running" });

    // c2: the caller (a session's fm process, acting as an agent) starts it and exits.
    const first = await fm("mcp-1234", true, "plan", "run", p, "--max", "2", "--json");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const run = JSON.parse(first.out) as { started: boolean; pid: number; scope: string; max: number; startedBy: string; log: string };
    started.push(run.pid);
    expect(run).toMatchObject({ started: true, scope: p, max: 2, startedBy: "mcp-1234", log: join(dir, "cli", `dispatch-${p}.log`) });
    expect(existsSync(run.log)).toBe(true);
    // The calling process is gone; the dispatcher is alive and in the registry, and stays there.
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(run.pid)).toBe(true);
    const ds = JSON.parse((await fm("ada", false, "dispatchers", "--json")).out) as { pid: number; scope: string; starter: { name: string } }[];
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ pid: run.pid, scope: p, starter: { name: "mcp-1234" } });

    // A second run, from the CLI and from the core, returns the first and starts nothing.
    const second = JSON.parse((await fm("ada", false, "plan", "run", p, "--json")).out) as { started: boolean; pid: number };
    expect(second).toMatchObject({ started: false, pid: run.pid });
    expect(await runPlan(f, p, ada)).toMatchObject({ started: false, pid: run.pid, scope: p });
    expect(JSON.parse((await fm("ada", false, "dispatchers", "--json")).out)).toHaveLength(1);

    // fm plan watch: the state at once, then on --since a submission wakes it.
    const look = await fm("ada", false, "plan", "watch", p);
    expect(look.out).toContain(`dispatcher: pid ${run.pid}  ${p}  0/2 slots`);
    expect(look.out).toContain(`1  ${t}  in_progress`);
    const next = Number(/--since (\d+)$/.exec(look.out)![1]);
    const quiet = JSON.parse((await fm("ada", false, "plan", "watch", p, "--since", String(next), "--timeout", "0.2", "--json")).out) as { timedOut: boolean; happened: unknown[] };
    expect(quiet).toMatchObject({ timedOut: true, happened: [] });

    // plan stop ends it, by the plan's id.
    const stop = await fm("ada", false, "plan", "stop", p);
    expect(stop.err).toBe("");
    expect(stop.out).toStartWith(`stopped dispatcher pid ${run.pid} (${p})`);
    await until(() => !alive(run.pid));
    expect((await fm("ada", false, "dispatchers")).out).toBe("no dispatcher is running");
    const after = JSON.parse((await fm("ada", false, "plan", "watch", p, "--since", String(next), "--json")).out) as { happened: { kind: string }[]; timedOut: boolean };
    expect(after.happened.map((h) => h.kind)).toEqual(["no_dispatcher"]);
    f.db.close();
  }, 60_000);
});

describe("watch_plan", () => {
  test("without since it returns the state at once: tasks with what they wait on, and the next event id", async () => {
    const env = setup();
    const a = env.add("one");
    const b = env.add("two", { step: 2 });
    const w = await watchPlan(env.f, env.p);
    expect(w).toMatchObject({ plan: { id: env.p, state: "active" }, happened: [], timedOut: false, dispatchers: [], sessions: [], needsPerson: [] });
    expect(w.tasks).toEqual([
      { id: a, step: 1, title: "one", status: "ready", waits: "waits: no dispatcher" },
      { id: b, step: 2, title: "two", status: "ready", waits: `waits: step 1 of ${env.p} <- ${a} (ready, no dispatcher)` },
    ]);
    expect(w.next).toBe(env.f.events().at(-1)!.id);
    expect(watchText(w)).toContain(`dispatcher: none covers it (fm plan run ${env.p})`);
    expect(watchText(w)).toEndWith(`next: fm plan watch ${env.p} --since ${w.next}`);
    const none = await watchPlan(env.f, "P-0042").catch((e) => e);
    expect((none as ForemanError).code).toBe("not_found");
  });

  test("returns on the timeout when nothing happened, and after a task is submitted with its new status and a later event id", async () => {
    const env = setup();
    const a = env.add("one");
    env.dispatcher();
    const worker: Actor = { name: `worker-${a}`, kind: "agent" };
    env.f.claim(a, worker);
    const since = (await watchPlan(env.f, env.p)).next;

    const t0 = Date.now();
    const quiet = await watchPlan(env.f, env.p, { since, timeoutMs: 60, pollMs: 5 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(quiet).toMatchObject({ timedOut: true, happened: [], next: since });
    expect(quiet.tasks[0]).toMatchObject({ id: a, status: "claimed" });
    expect(quiet.dispatchers).toHaveLength(1);

    let done = false;
    const watching = watchPlan(env.f, env.p, { since, timeoutMs: 20_000, pollMs: 5 }).then((w) => ((done = true), w));
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toBe(false); // still waiting: nothing has happened
    env.f.submit(a, worker, { pr: "https://example.com/pull/1" });
    const w = await watching;
    expect(w.timedOut).toBe(false);
    expect(w.happened).toEqual([{ event: expect.any(Number), task: a, kind: "submitted", text: `${a} submitted: https://example.com/pull/1` }]);
    expect(w.tasks[0]).toMatchObject({ id: a, status: "in_review", pr: "https://example.com/pull/1" });
    expect(w.next).toBeGreaterThan(since);
    expect(w.next).toBe(w.happened[0]!.event!);
    // The next call starts after it: the submission isn't reported twice.
    expect((await watchPlan(env.f, env.p, { since: w.next, timeoutMs: 20, pollMs: 5 })).happened).toEqual([]);
  });

  test("reports a failed verdict with its evidence, a pass that waits for a person, a session that ended early, and the dispatcher going", async () => {
    const env = setup();
    const a = env.add("fails");
    const b = env.add("needs a person", { risk: "review" });
    const c = env.add("abandoned");
    const pid = env.dispatcher();
    const worker = (id: string): Actor => ({ name: `worker-${id}`, kind: "agent" });
    const verifier = (id: string): Actor => ({ name: `verifier-${id}`, kind: "agent" });
    let since = (await watchPlan(env.f, env.p)).next;
    const watch = async () => {
      const w = await watchPlan(env.f, env.p, { since, timeoutMs: 20, pollMs: 5 });
      since = w.next;
      return w;
    };

    for (const id of [a, b]) {
      env.f.claim(id, worker(id));
      env.f.submit(id, worker(id), { pr: `https://example.com/pull/${id}` });
      env.f.startVerify(id, verifier(id));
    }
    env.f.recordVerify(a, verifier(a), [{ check: "c1", pass: false, evidence: "exit 1: 2 tests fail" }]);
    env.f.recordVerify(b, verifier(b), [{ check: "c1", pass: true, evidence: "ok" }]);
    let w = await watch();
    expect(w.happened.map((h) => `${h.task} ${h.kind}`)).toEqual([`${a} submitted`, `${b} submitted`, `${a} failed`, `${b} passed`, `${b} needs_approval`]);
    const failed = w.happened.find((h) => h.kind === "failed")!;
    expect(failed.failed).toEqual([{ check: "c1", evidence: "exit 1: 2 tests fail" }]);
    expect(failed.text).toBe(`${a} failed verification (c1: exit 1: 2 tests fail): it is ready again, with the evidence for its next worker`);
    expect(w.needsPerson).toEqual([b]);
    expect(watchText(w)).toContain(`waiting for a person's approval on the board: ${b}`);

    // A worker whose process is gone: the lease is released, and the watcher hears of it.
    env.f.claim(c, worker(c));
    env.pids.add(8001);
    env.f.pinLease(c, worker(c), 8001);
    since = (await watchPlan(env.f, env.p)).next;
    env.pids.delete(8001);
    env.f.reclaim(ada);
    w = await watch();
    expect(w.happened).toEqual([{ event: expect.any(Number), task: c, kind: "ended_early", text: `${c}: worker-${c} ended without submitting` }]);
    expect(w.tasks.find((t) => t.id === c)!.status).toBe("ready");

    // A person approves: reported. Then the dispatcher goes: reported at once, every call, until one runs again.
    env.f.approve(b, ada);
    expect((await watch()).happened.map((h) => h.text)).toEqual([`${b} approved by ada`]);
    env.pids.delete(pid);
    unregisterDispatcher(env.f, pid);
    w = await watchPlan(env.f, env.p, { since, timeoutMs: 20_000, pollMs: 5 });
    expect(w.happened.map((h) => h.kind)).toEqual(["no_dispatcher"]);
    expect(w.timedOut).toBe(false);
  });

  test("a live session comes with its attach id", async () => {
    const env = setup();
    const a = env.add("one");
    const worker: Actor = { name: `worker-${a}`, kind: "agent" };
    env.f.claim(a, worker);
    env.pids.add(8002);
    env.f.pinLease(a, worker, 8002, { session: "abc123", name: "repo T worker", sessionId: "abc123-full" });
    const w = await watchPlan(env.f, env.p, { configDirs: [join(dir, "no-config")] });
    expect(w.sessions).toEqual([{ task: a, role: "worker", name: "repo T worker", attach: "abc123", lines: [] }]);
    expect(watchText(w)).toContain(`${a} worker "repo T worker": claude attach abc123`);
  });
});
