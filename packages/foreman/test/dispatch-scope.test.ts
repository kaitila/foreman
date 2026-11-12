// A dispatcher for one plan (D0045): what its scope takes and leaves, when it ends, one
// dispatcher per scope, and `fm dispatch --stop`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError, type Task } from "../src/core";
import { branchFor, type DispatchOptions, Dispatcher, type Launcher, type SessionResult } from "../src/dispatch";
import { dispatcherLine, findDispatcher, registerDispatcher, runningDispatchers, scopeCovers, scopeOf, startDispatcher, stopDispatcher } from "../src/dispatchers";
import { type LaunchOptions } from "../src/launch";
import { Plans } from "../src/plans";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "foreman-scope-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ada: Actor = { name: "ada", kind: "human" };
const OK: SessionResult = { exitCode: 0, costUsd: 0, isError: false, timedOut: false, result: "done" };
const PASS = [{ check: "c1", pass: true, evidence: "ok" }];
const SRC = join(import.meta.dir, "..", "src");
const CLI = join(SRC, "cli.ts");

interface Session {
  opts: LaunchOptions;
  pid: number;
  actor: Actor;
  end(): void;
}

/** A foreman with fake PIDs (this process counts as alive), a fake launcher, and a plan of two steps. */
function setup() {
  const clock = 1_000_000;
  const alive = new Set<number>([process.pid]);
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
  const f = new Foreman(openDb(":memory:"), dir, () => clock, policy, (pid) => alive.has(pid));
  const plans = new Plans(f, () => clock);
  const sessions: Session[] = [];
  let nextPid = 5000;
  const launcher: Launcher = (opts, onSpawn) =>
    new Promise((resolve) => {
      const pid = nextPid++;
      alive.add(pid);
      sessions.push({
        opts,
        pid,
        actor: { name: `${opts.role}-${opts.taskId}`, kind: "agent" },
        end() {
          alive.delete(pid);
          resolve(OK);
        },
      });
      onSpawn(pid);
    });
  const worktrees = (t: Task) => {
    const path = join(dir, `${t.id}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path);
    return { branch: branchFor(t), path };
  };
  let n = 0;
  const add = (title: string, more: { plan?: string; step?: number; ready?: boolean; risk?: Task["risk"] } = {}) => {
    const t = f.create({ title, acceptance: ["cmd: true"], paths: [`src/${++n}/**`], risk: more.risk ?? "auto", ready: more.ready ?? true }, ada);
    if (more.plan) plans.add(t.id, more.plan, more.step ?? 1, ada);
    return t.id;
  };
  const plan = (title = "Plan") => plans.create({ title, steps: [{ title: "First", check: "one" }, { title: "Second", check: "two" }] }, ada).id;
  const log: string[] = [];
  const dispatcher = (o: DispatchOptions = {}) =>
    new Dispatcher(f, { launcher, worktrees, pollMs: 5, log: (l) => log.push(l), now: () => clock, actor: ada, cleanSessions: () => {}, ...o });
  /** The session a task's worker or verifier runs in. */
  const session = (id: string, role: "worker" | "verifier") => sessions.find((s) => s.opts.taskId === id && s.opts.role === role)!;
  const started = () => sessions.map((s) => `${s.opts.taskId} ${s.opts.role}`);
  /** The worker hands in and its session ends. */
  const submit = (id: string) => {
    const s = session(id, "worker");
    f.submit(id, s.actor, { pr: `https://example.com/pull/${id}` });
    s.end();
  };
  /** The verifier passes it and its session ends. */
  const pass = (id: string) => {
    const s = session(id, "verifier");
    f.recordVerify(id, s.actor, PASS);
    s.end();
  };
  return { f, plans, sessions, alive, add, plan, dispatcher, session, started, submit, pass, log };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};
const settle = () => new Promise((r) => setTimeout(r, 40)); // several polls of 5 ms

describe("fm dispatch --plan", () => {
  test("starts workers only for the plan's tasks, step 2 only after step 1 is done, and leaves another ready task alone", async () => {
    const env = setup();
    const p = env.plan();
    const a = env.add("one a", { plan: p, step: 1 });
    const b = env.add("one b", { plan: p, step: 1 });
    const two = env.add("two", { plan: p, step: 2 });
    const other = env.add("in no plan");
    const elsewhere = env.add("in another plan", { plan: env.plan("Other"), step: 1 });

    const d = env.dispatcher({ plans: [p], max: 5 });
    expect(d.scope).toBe(p);
    let ended = false;
    const run = d.run().then((r) => ((ended = true), r));
    await until(() => env.sessions.length === 2);
    // Step 1's tasks side by side; nothing for step 2 or for tasks outside the plan, with slots free.
    expect(env.started()).toEqual([`${a} worker`, `${b} worker`]);
    expect(runningDispatchers(env.f).map((x) => x.scope)).toEqual([p]);

    // Someone else submits the task outside the plan: no verifier from this dispatcher.
    const hand: Actor = { name: "worker-by-hand", kind: "agent" };
    env.f.claim(other, hand);
    env.f.progress(other, hand, { branch: "b", worktree: dir });
    env.f.submit(other, hand, { pr: "https://example.com/pull/9" });

    env.submit(a);
    await until(() => !!env.session(a, "verifier"));
    env.pass(a);
    env.f.merged(a, ada);
    // One of step 1's two tasks is done: step 2 still waits.
    await settle();
    expect(env.started()).toEqual([`${a} worker`, `${b} worker`, `${a} verifier`]);

    env.submit(b);
    await until(() => !!env.session(b, "verifier"));
    env.pass(b);
    // Approved isn't done: nothing runs, and the dispatcher stays up for step 2.
    await settle();
    expect(env.f.get(b).status).toBe("approved");
    expect(ended).toBe(false);
    expect(env.sessions).toHaveLength(4);
    expect(d.moreToCome()).toBe(true);

    env.f.merged(b, ada);
    await until(() => !!env.session(two, "worker"));
    env.submit(two);
    await until(() => !!env.session(two, "verifier"));
    env.pass(two);

    // Everything of the plan is approved or done: it ends by itself.
    const records = await run;
    expect(records.map((r) => `${r.task} ${r.role}`).sort()).toEqual([a, b, two].flatMap((id) => [`${id} verifier`, `${id} worker`]).sort());
    expect(env.f.get(other).status).toBe("in_review");
    expect(env.f.get(elsewhere).status).toBe("ready");
    expect(env.sessions.some((s) => s.opts.taskId === other || s.opts.taskId === elsewhere)).toBe(false);
    expect(runningDispatchers(env.f)).toEqual([]);
  });

  test("--plan twice covers both plans; the scope lists them in order", async () => {
    const env = setup();
    const p1 = env.plan();
    const p2 = env.plan("Second plan");
    const a = env.add("a", { plan: p1 });
    const b = env.add("b", { plan: p2 });
    const other = env.add("in no plan");
    const d = env.dispatcher({ plans: [p2, p1, p2], once: true });
    expect(d.scope).toBe(`${p1},${p2}`);
    d.tick();
    expect(env.started()).toEqual([`${a} worker`, `${b} worker`]);
    expect(env.f.get(other).status).toBe("ready");
  });

  test("it ends when all that is left waits for a person or has had its one try", async () => {
    const env = setup();
    const p = env.plan();
    const tried = env.add("its worker dies", { plan: p });
    env.add("a draft", { plan: p, ready: false });
    env.add("by hand", { plan: p, risk: "human" });
    const two = env.add("two", { plan: p, step: 2 });

    const run = env.dispatcher({ plans: [p] }).run();
    await until(() => env.sessions.length === 1);
    env.session(tried, "worker").end(); // without submitting: the task is ready again
    const records = await run;
    expect(records.map((r) => `${r.task} ${r.role}: ${r.status}`)).toEqual([`${tried} worker: ready`]);
    expect(env.f.get(two).status).toBe("ready"); // step 1 never finished
    expect(env.sessions).toHaveLength(1);
  });

  test("it waits for a plan task another session holds, and verifies it when it is submitted", async () => {
    const env = setup();
    const p = env.plan();
    const a = env.add("held by hand", { plan: p });
    const hand: Actor = { name: "worker-by-hand", kind: "agent" };
    env.f.claim(a, hand);
    const wt = join(dir, "by-hand");
    mkdirSync(wt);
    env.f.progress(a, hand, { branch: "b", worktree: wt });

    const d = env.dispatcher({ plans: [p] });
    let ended = false;
    const run = d.run().then(() => (ended = true));
    await settle();
    expect(ended).toBe(false);
    expect(env.sessions).toHaveLength(0);

    env.f.submit(a, hand, { pr: "https://example.com/pull/1" });
    await until(() => !!env.session(a, "verifier"));
    env.pass(a);
    await run;
    expect(env.f.get(a).status).toBe("approved");
  });

  test("the whole-board dispatcher ends when nothing runs, as before; --once with a plan too", async () => {
    const env = setup();
    const p = env.plan();
    env.add("a draft in the plan", { plan: p, ready: false });
    const held = env.add("held by hand", { plan: p });
    env.f.claim(held, { name: "worker-by-hand", kind: "agent" });
    expect(await env.dispatcher().run()).toEqual([]);
    expect(await env.dispatcher({ plans: [p], once: true }).run()).toEqual([]);
  });

  test("a plan that doesn't exist or is cancelled is refused", () => {
    const env = setup();
    expect(() => env.dispatcher({ plans: ["P-0099"] })).toThrow("no plan P-0099");
    const p = env.plan();
    env.plans.cancel(p, ada, "dropped");
    expect(() => env.dispatcher({ plans: [p] })).toThrow(`plan ${p} is cancelled`);
  });
});

const record = (pid: number, scope?: string) => ({
  pid,
  max: 3,
  flags: { once: false, verifyOnly: false, print: false },
  starter: { name: "ada", kind: "human" as const },
  cwd: "/repo",
  startedAt: 1_000_000,
  ...(scope ? { scope } : {}),
});

describe("scopes and the registry", () => {
  test("scopeOf and scopeCovers", () => {
    expect(scopeOf()).toBe("everything");
    expect(scopeOf([])).toBe("everything");
    expect(scopeOf(["P-0007", " P-0004 ", "P-0007"])).toBe("P-0004,P-0007");
    expect(scopeCovers("everything", undefined)).toBe(true);
    expect(scopeCovers("everything", "P-0001")).toBe(true);
    expect(scopeCovers("P-0004,P-0007", "P-0007")).toBe(true);
    expect(scopeCovers("P-0004,P-0007", "P-0001")).toBe(false);
    expect(scopeCovers("P-0004", undefined)).toBe(false);
  });

  test("a second dispatcher with the same scope is refused with the first one's pid; another scope isn't", async () => {
    const env = setup();
    const p = env.plan();
    env.alive.add(7001).add(7002);
    startDispatcher(env.f, record(7001, p));
    let refusal: unknown;
    try {
      startDispatcher(env.f, record(7002, p));
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ForemanError);
    expect((refusal as ForemanError).code).toBe("already_running");
    expect((refusal as ForemanError).message).toBe(`a dispatcher for ${p} is already running: pid 7001, started by ada (fm dispatch --stop 7001 stops it)`);
    expect(runningDispatchers(env.f).map((d) => d.pid)).toEqual([7001]);

    // The whole board is another scope, and so is another plan: both may run beside it.
    startDispatcher(env.f, record(7002));
    expect(() => startDispatcher(env.f, record(7003))).toThrow("a dispatcher for everything is already running: pid 7002");
    expect(runningDispatchers(env.f).map((d) => [d.pid, d.scope])).toEqual([[7001, p], [7002, "everything"]]);
    expect(dispatcherLine(runningDispatchers(env.f)[0]!, 1_000_000)).toBe(`pid 7001  ${p}  0/3 slots  by ada  up 0 min  nothing in flight`);

    // Dispatcher.run() is refused the same way, before it starts anything.
    env.add("a", { plan: p });
    await expect(env.dispatcher({ plans: [p] }).run()).rejects.toThrow("already running: pid 7001");
    expect(env.sessions).toHaveLength(0);

    // The first one is killed: its record doesn't hold the scope.
    env.alive.delete(7001);
    startDispatcher(env.f, record(7004, p));
    expect(runningDispatchers(env.f).map((d) => d.pid)).toEqual([7002]); // 7004 was never alive here
  });

  test("two dispatchers on one board never start the same task, and keep overlapping paths apart", () => {
    const env = setup();
    const p = env.plan();
    const a = env.add("in the plan", { plan: p });
    const b = env.f.create({ title: "overlaps it", acceptance: ["cmd: true"], paths: ["src/1/x.ts"], risk: "auto", ready: true }, ada).id;
    const c = env.add("free");
    const forPlan = env.dispatcher({ plans: [p] });
    const forAll = env.dispatcher();
    forPlan.tick();
    forAll.tick();
    forPlan.tick();
    // The plan's task once, by the plan's dispatcher; the board's one holds back what overlaps it.
    expect(env.started()).toEqual([`${a} worker`, `${c} worker`]);
    expect(env.f.get(b).status).toBe("ready");
    expect(env.log).toContain(`${b} waits: its paths overlap ${a}'s (in progress)`);
  });

  test("findDispatcher: by pid, by a plan, by \"everything\"; nothing else is ever signalled", async () => {
    const env = setup();
    env.alive.add(7001).add(7002).add(7003);
    registerDispatcher(env.f, record(7001, "P-0001,P-0002"));
    registerDispatcher(env.f, record(7002, "P-0002,P-0003"));
    registerDispatcher(env.f, record(7003));
    expect(findDispatcher(env.f, "7002").pid).toBe(7002);
    expect(findDispatcher(env.f, "P-0001").pid).toBe(7001);
    expect(findDispatcher(env.f, "P-0003").pid).toBe(7002);
    expect(findDispatcher(env.f, "everything").pid).toBe(7003);
    expect(() => findDispatcher(env.f, "P-0002")).toThrow(`"P-0002" matches 2 dispatchers: give the pid`);
    expect(() => findDispatcher(env.f, "P-0009")).toThrow(`no running dispatcher for "P-0009"`);
    // A pid that isn't a dispatcher's (this process is alive) is not found, so never signalled.
    const signalled: number[] = [];
    await expect(stopDispatcher(env.f, String(process.pid), ada, { signal: (pid) => void signalled.push(pid) })).rejects.toThrow("no running dispatcher");
    expect(signalled).toEqual([]);
  });

  test("stopDispatcher signals it, waits for it and its sessions, and releases their tasks", async () => {
    const env = setup();
    const worked = env.add("worked on");
    const checked = env.add("being verified");
    const w: Actor = { name: "worker-x", kind: "agent" };
    const v: Actor = { name: "verifier-x", kind: "agent" };
    env.alive.add(7001).add(8001).add(8002);
    env.f.claim(worked, w);
    env.f.pinLease(worked, w, 8001);
    env.f.claim(checked, w);
    env.f.submit(checked, w, { pr: "https://example.com/pull/2" });
    env.f.startVerify(checked, v);
    env.f.pinLease(checked, v, 8002);
    registerDispatcher(env.f, {
      ...record(7001),
      sessions: [
        { task: worked, role: "worker", pid: 8001 },
        { task: checked, role: "verifier", pid: 8002 },
      ],
    });

    const signals: string[] = [];
    const stopped = await stopDispatcher(env.f, "7001", ada, {
      pollMs: 1,
      signal: (pid, sig) => {
        signals.push(`${sig} ${pid}`);
        // What the dispatcher does on SIGTERM: it exits, and its sessions with it.
        setTimeout(() => [7001, 8001, 8002].forEach((x) => env.alive.delete(x)), 5);
      },
    });
    expect(signals).toEqual(["SIGTERM 7001"]);
    expect(stopped).toMatchObject({ pid: 7001, scope: "everything", released: [worked, checked], stillRunning: [] });
    expect(env.f.get(worked).status).toBe("ready");
    expect(env.f.get(checked).status).toBe("in_review");
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });

    // One that ignores the signal is reported, and its record stays.
    registerDispatcher(env.f, record(process.pid));
    env.alive.add(7005);
    registerDispatcher(env.f, record(7005, "P-0001"));
    await expect(stopDispatcher(env.f, "P-0001", ada, { signal: () => {}, waitMs: 20, pollMs: 1 })).rejects.toThrow("pid 7005 got SIGTERM and is still running");
    expect(runningDispatchers(env.f).map((d) => d.pid)).toContain(7005);
    await expect(stopDispatcher(env.f, String(process.pid), ada, { signal: () => {} })).rejects.toThrow("can't stop itself");
  });
});

describe("the CLI: a running --plan dispatcher, a second one, and --stop", () => {
  const db = join(dir, "cli.db");
  const ENV = { ...process.env, FOREMAN_DB: db, FOREMAN_ACTOR: "ada", FOREMAN_AGENT: "", CLAUDE_CODE_CHILD_SESSION: "" };
  const fm = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], {
      cwd: import.meta.dir,
      env: ENV,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("fm dispatchers --json has the plan as scope, the same scope is refused with the pid, and --stop frees the tasks", async () => {
    const wt = join(dir, "cli-wt");
    mkdirSync(wt);
    // A real dispatcher process for plan P-0001. Its launcher starts a real process per
    // session (a sleep) and, like the launch adapter, kills them when the dispatcher exits.
    const script = `
      import { Foreman } from ${JSON.stringify(join(SRC, "core.ts"))};
      import { Dispatcher } from ${JSON.stringify(join(SRC, "dispatch.ts"))};
      import { Plans } from ${JSON.stringify(join(SRC, "plans.ts"))};
      import { openDb } from ${JSON.stringify(join(SRC, "store.ts"))};
      const ada = { name: "ada", kind: "human" };
      const f = new Foreman(openDb(${JSON.stringify(db)}), ${JSON.stringify(dir)}, Date.now, { protectedPaths: [], changedFiles: () => ["src/x.ts"] });
      const plans = new Plans(f);
      const p = plans.create({ title: "Plan", steps: [{ title: "First", check: "one" }] }, ada).id;
      const add = (title, paths) => f.create({ title, acceptance: ["cmd: true"], paths, risk: "auto", ready: true }, ada).id;
      const worked = add("worked on", ["src/a/**"]);
      const submitted = add("submitted", ["src/b/**"]);
      add("in no plan", ["src/c/**"]);
      plans.add(worked, p, 1, ada);
      plans.add(submitted, p, 1, ada);
      const hand = { name: "worker-by-hand", kind: "agent" };
      f.claim(submitted, hand);
      f.progress(submitted, hand, { branch: "b", worktree: ${JSON.stringify(wt)} });
      f.submit(submitted, hand, { pr: "https://example.com/pull/1" });
      const kids = [];
      process.on("exit", () => kids.forEach((k) => k.kill("SIGKILL")));
      const launcher = (opts, onSpawn) => new Promise(() => {
        const k = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        kids.push(k);
        onSpawn(k.pid);
        if (kids.length === 2) console.log("up");
      });
      new Dispatcher(f, { plans: [p], launcher, worktrees: () => ({ branch: "b", path: ${JSON.stringify(wt)} }), pollMs: 20, log: () => {}, actor: ada, cleanSessions: () => {} }).run();
    `;
    const child = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    try {
      await child.stdout.getReader().read(); // "up": a worker and a verifier run

      // c3: the registry has the plan as its scope.
      const ds = JSON.parse(fm("dispatchers", "--json").out) as { pid: number; scope: string; sessions: { task: string; role: string; pid: number }[] }[];
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ pid: child.pid, scope: "P-0001" });
      expect(ds[0]!.sessions.map((s) => `${s.task} ${s.role}`).sort()).toEqual(["T-0001 worker", "T-0002 verifier"]);
      expect(fm("dispatchers").out).toStartWith(`pid ${child.pid}  P-0001  2/3 slots`);
      const sessionPids = ds[0]!.sessions.map((s) => s.pid);
      expect(sessionPids.every(alive)).toBe(true);
      const status = (id: string) => (JSON.parse(fm("show", id, "--json").out) as { status: string }).status;
      expect([status("T-0001"), status("T-0002"), status("T-0003")]).toEqual(["in_progress", "verifying", "ready"]);

      // The plan's dispatcher runs: the task in no plan is the one nothing covers.
      expect(fm("list").out).toContain("in no plan  (waits: no dispatcher)");

      // A second dispatcher for the same plan is refused, naming the first one's pid.
      const second = fm("dispatch", "--plan", "P-0001", "--print");
      expect(second.code).toBe(1);
      expect(second.err).toContain(`a dispatcher for P-0001 is already running: pid ${child.pid}`);
      expect(fm("dispatch", "--stop", "P-0042").err).toContain(`no running dispatcher for "P-0042"`);
      expect(alive(child.pid)).toBe(true);

      // c4: --stop by plan stops it and its sessions, and the tasks go back.
      // Not spawnSync: this process is the dispatcher's parent, and has to be free to reap it.
      const stopping = Bun.spawn(["bun", CLI, "dispatch", "--stop", "P-0001"], { cwd: import.meta.dir, env: ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const stop = { code: await stopping.exited, out: (await new Response(stopping.stdout).text()).trim(), err: (await new Response(stopping.stderr).text()).trim() };
      expect(stop.err).toBe("");
      expect(stop.code).toBe(0);
      expect(stop.out.split("\n").sort()).toEqual(
        [`stopped dispatcher pid ${child.pid} (P-0001)`, "T-0001 worker stopped: task is ready", "T-0002 verifier stopped: task is in review"].sort(),
      );
      expect(await child.exited).toBe(143);
      expect(sessionPids.some(alive)).toBe(false);
      expect([status("T-0001"), status("T-0002")]).toEqual(["ready", "in_review"]);
      expect(fm("dispatchers").out).toBe("no dispatcher is running");
      expect(JSON.parse(fm("dispatchers", "--json").out)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
