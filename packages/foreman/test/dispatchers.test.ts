// The registry of running dispatchers (D0041): a dispatcher records itself while it
// runs, a dead one's record is dropped on read, and the CLI shows what runs.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, type Task } from "../src/core";
import { branchFor, type DispatchOptions, Dispatcher, type Launcher, type SessionResult } from "../src/dispatch";
import { dispatcherLine, registerDispatcher, runningDispatchers, touchDispatcher } from "../src/dispatchers";
import { type LaunchOptions } from "../src/launch";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "foreman-dispatchers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ada: Actor = { name: "ada", kind: "human" };
const OK: SessionResult = { exitCode: 0, costUsd: 0, isError: false, timedOut: false, result: "done" };
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

interface Session {
  opts: LaunchOptions;
  pid: number;
  end(): void;
}

/** A foreman with a fake clock and fake PIDs (this process counts as alive), and a fake launcher. */
function setup() {
  let clock = 1_000_000;
  const alive = new Set<number>([process.pid]);
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
  const f = new Foreman(openDb(":memory:"), dir, () => clock, policy, (pid) => alive.has(pid));
  const sessions: Session[] = [];
  let nextPid = 5000;
  const launcher: Launcher = (opts, onSpawn) =>
    new Promise((resolve) => {
      const pid = nextPid++;
      alive.add(pid);
      sessions.push({
        opts,
        pid,
        end() {
          alive.delete(pid);
          resolve(OK);
        },
      });
      onSpawn(pid, { id: `bg${pid}`, name: `repo ${opts.taskId} ${opts.role}`, sessionId: `sid-${pid}` });
    });
  const worktrees = (t: Task) => {
    const path = join(dir, `${t.id}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path);
    return { branch: branchFor(t), path };
  };
  const add = (title: string, paths: string[]) => f.create({ title, acceptance: ["cmd: true"], paths, risk: "auto", ready: true }, ada);
  const dispatcher = (o: DispatchOptions = {}) =>
    new Dispatcher(f, { launcher, worktrees, pollMs: 5, log: () => {}, now: () => clock, actor: ada, ...o });
  return { f, sessions, alive, add, dispatcher, tick: (ms: number) => (clock += ms), now: () => clock };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

const record = (pid: number, over: Partial<Parameters<typeof registerDispatcher>[1]> = {}) => ({
  pid,
  max: 3,
  flags: { once: false, verifyOnly: false, print: false },
  starter: { name: "ada", kind: "human" as const },
  cwd: "/repo",
  startedAt: 1_000_000,
  ...over,
});

describe("dispatcher registry", () => {
  test("a running dispatcher is in the registry with its pid, max, flags, starter and tasks, and gone after run()", async () => {
    const env = setup();
    const a = env.add("a", ["src/a/**"]);
    const b = env.add("b", ["src/b/**"]);
    env.add("c", ["src/c/**"]); // no slot for it: max is 2
    expect(runningDispatchers(env.f)).toEqual([]);

    const d = env.dispatcher({ max: 2, once: true, mode: "print", starterSession: "sess-123" });
    const started = env.now();
    const run = d.run();
    await until(() => env.sessions.length === 2);

    const [rec, ...rest] = runningDispatchers(env.f);
    expect(rest).toEqual([]);
    expect(rec).toEqual({
      pid: process.pid,
      scope: "everything",
      max: 2,
      flags: { once: true, verifyOnly: false, print: true },
      starter: { name: "ada", kind: "human", session: "sess-123" },
      cwd: process.cwd(),
      startedAt: started,
      lastSeen: started,
      sessions: [
        { task: a.id, role: "worker", pid: 5000, session: "bg5000", sessionId: "sid-5000" },
        { task: b.id, role: "worker", pid: 5001, session: "bg5001", sessionId: "sid-5001" },
      ],
    });
    expect(dispatcherLine(rec!, started + 5 * 60_000)).toBe(
      `pid ${process.pid}  everything  2/2 slots  --once --print  by ada  up 5 min  ${a.id} worker, ${b.id} worker`,
    );

    // A session ends: the record follows, and the next tick moves last-seen on.
    env.tick(30_000);
    env.sessions[0]!.end();
    await until(() => runningDispatchers(env.f)[0]!.sessions.length === 1);
    const later = runningDispatchers(env.f)[0]!;
    expect(later.sessions.map((s) => s.task)).toEqual([b.id]);
    expect(later.lastSeen).toBe(started + 30_000);
    expect(later.startedAt).toBe(started);

    env.sessions[1]!.end();
    await run;
    expect(runningDispatchers(env.f)).toEqual([]);
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });
  });

  test("the record goes when run() fails, too", async () => {
    const env = setup();
    env.add("a", ["src/a/**"]);
    const d = env.dispatcher({
      worktrees: () => {
        throw new TypeError("boom");
      },
    });
    // A worktree error releases the task and run() ends with nothing running.
    await d.run();
    expect(runningDispatchers(env.f)).toEqual([]);

    const broken = env.dispatcher();
    broken.tick = () => {
      throw new Error("tick failed");
    };
    await expect(broken.run()).rejects.toThrow("tick failed");
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });
  });

  test("the starter defaults to the actor and CLAUDE_CODE_SESSION_ID, the flags to off", async () => {
    const env = setup();
    env.add("a", ["src/a/**"]);
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "from-env";
    try {
      const run = env.dispatcher({ actor: { name: "worker-T-0001", kind: "agent" }, mode: "bg" }).run();
      await until(() => env.sessions.length === 1);
      const [rec] = runningDispatchers(env.f);
      expect(rec!.starter).toEqual({ name: "worker-T-0001", kind: "agent", session: "from-env" });
      expect(rec!.flags).toEqual({ once: false, verifyOnly: false, print: false });
      expect(rec!.max).toBe(3);
      env.sessions[0]!.end();
      await run;
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
  });

  test("a record whose pid is not alive is dropped on read and not reported", () => {
    const env = setup();
    env.alive.add(7001);
    registerDispatcher(env.f, record(7001));
    registerDispatcher(env.f, record(7002, { startedAt: 1_000_500 })); // never alive: a killed dispatcher
    touchDispatcher(env.f, 7002, [{ task: "T-0001", role: "worker", pid: 9 }], 1_000_600);
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 2 });

    expect(runningDispatchers(env.f).map((d) => d.pid)).toEqual([7001]);
    expect(env.f.db.query(`SELECT pid FROM dispatchers`).all()).toEqual([{ pid: 7001 }]);

    // The live one is killed: the next read drops it as well.
    env.alive.delete(7001);
    expect(runningDispatchers(env.f)).toEqual([]);
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });
  });

  test("a tick of a dispatcher that isn't registered records nothing", () => {
    const env = setup();
    env.add("a", ["src/a/**"]);
    env.dispatcher().tick();
    expect(env.sessions).toHaveLength(1);
    expect(env.f.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });
  });

  test("a line with nothing in flight and no flags", () => {
    expect(dispatcherLine({ ...record(42), scope: "everything", lastSeen: 1_000_000, sessions: [] }, 1_000_000 + 3 * 3_600_000)).toBe(
      "pid 42  everything  0/3 slots  by ada  up 3h 0m  nothing in flight",
    );
  });
});

describe("an interrupted dispatcher", () => {
  test.each(["SIGINT", "SIGTERM"] as const)("%s removes its record", async (sig) => {
    const db = join(dir, `${sig}.db`);
    // A real process running a dispatcher whose one session never ends.
    const script = `
      import { Foreman } from ${JSON.stringify(join(import.meta.dir, "..", "src", "core.ts"))};
      import { Dispatcher } from ${JSON.stringify(join(import.meta.dir, "..", "src", "dispatch.ts"))};
      import { openDb } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};
      const f = new Foreman(openDb(${JSON.stringify(db)}), ${JSON.stringify(dir)}, Date.now, { protectedPaths: [], changedFiles: () => [] });
      f.create({ title: "a", acceptance: ["cmd: true"], paths: ["src/a/**"], risk: "auto", ready: true }, { name: "ada", kind: "human" });
      const launcher = (opts, onSpawn) => new Promise(() => onSpawn(process.pid));
      const d = new Dispatcher(f, { launcher, worktrees: () => ({ branch: "b", path: ${JSON.stringify(dir)} }), pollMs: 20, log: () => {}, actor: { name: "ada", kind: "human" } });
      d.run();
      console.log("up");
    `;
    const child = Bun.spawn(["bun", "-e", script], { cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    await reader.read(); // "up": the dispatcher has registered and ticked
    const rows = () => {
      const d = openDb(db);
      try {
        return d.query(`SELECT pid, sessions FROM dispatchers`).all() as { pid: number; sessions: string }[];
      } finally {
        d.close();
      }
    };
    expect(rows().map((r) => r.pid)).toEqual([child.pid]);
    expect(JSON.parse(rows()[0]!.sessions)).toHaveLength(1);

    child.kill(sig);
    expect(await child.exited).toBe(sig === "SIGINT" ? 130 : 143);
    // Removed by the dispatcher itself, not by a read that found the pid dead.
    expect(rows()).toEqual([]);
  });
});

describe("fm dispatchers and fm list", () => {
  const db = join(dir, "cli.db");
  const fm = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, FOREMAN_DB: db, FOREMAN_ACTOR: "ada", FOREMAN_AGENT: "", CLAUDE_CODE_CHILD_SESSION: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };

  test("no dispatcher: fm dispatchers says so and fm list adds nothing", () => {
    const f = new Foreman(openDb(db), null);
    f.create({ title: "first", acceptance: ["cmd: true"], paths: ["src/a/**"], risk: "auto", ready: true }, ada);
    f.db.close();

    expect(fm("dispatchers").out).toBe("no dispatcher is running");
    expect(JSON.parse(fm("dispatchers", "--json").out)).toEqual([]);
    const list = fm("list");
    expect(list.code).toBe(0);
    expect(list.out.split("\n")).toHaveLength(1);
    expect(list.out).toContain("T-0001");
  });

  test("fm dispatchers --json prints the running ones, and fm list ends with a line for each", () => {
    // Two "dispatchers" whose processes live (this test and its parent), and one that was killed.
    const dead = Bun.spawnSync(["true"]).pid;
    const f = new Foreman(openDb(db), null);
    registerDispatcher(f, record(process.pid, { max: 2, flags: { once: true, verifyOnly: false, print: false }, startedAt: Date.now() - 5 * 60_000 }));
    touchDispatcher(f, process.pid, [{ task: "T-0001", role: "worker", pid: 1, session: "abc123" }], Date.now());
    registerDispatcher(f, record(process.ppid, { starter: { name: "worker-T-0009", kind: "agent", session: "s-1" }, startedAt: Date.now() - 60_000 }));
    registerDispatcher(f, record(dead, { startedAt: Date.now() - 30_000 }));
    f.db.close();

    const json = fm("dispatchers", "--json");
    expect(json.code).toBe(0);
    const ds = JSON.parse(json.out) as { pid: number; max: number; scope: string; starter: { name: string }; sessions: { task: string }[] }[];
    expect(ds.map((d) => d.pid)).toEqual([process.pid, process.ppid]);
    expect(ds[0]).toMatchObject({
      max: 2,
      scope: "everything",
      flags: { once: true, verifyOnly: false, print: false },
      starter: { name: "ada", kind: "human" },
      cwd: "/repo",
      sessions: [{ task: "T-0001", role: "worker", pid: 1, session: "abc123" }],
    });
    expect(ds[1]!.starter).toEqual({ name: "worker-T-0009", kind: "agent", session: "s-1" } as never);

    const text = fm("dispatchers").out.split("\n");
    expect(text).toEqual([
      `pid ${process.pid}  everything  1/2 slots  --once  by ada  up 5 min  T-0001 worker`,
      `pid ${process.ppid}  everything  0/3 slots  by worker-T-0009  up 1 min  nothing in flight`,
    ]);

    const list = fm("list").out.split("\n");
    expect(list).toHaveLength(3);
    expect(list[0]).toContain("T-0001");
    expect(list.slice(1)).toEqual(text.map((l) => `dispatcher ${l}`));
    // --json stays the array of tasks.
    expect((JSON.parse(fm("list", "--json").out) as { id: string }[]).map((t) => t.id)).toEqual(["T-0001"]);
    // With no tasks shown, the dispatcher lines still end the list.
    expect(fm("list", "--status", "done").out.split("\n")).toEqual(["no tasks", ...text.map((l) => `dispatcher ${l}`)]);
  });
});
