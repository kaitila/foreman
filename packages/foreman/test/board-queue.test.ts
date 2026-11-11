// `fm serve --queue` (T-0079): the board runs a merge-queue pass per project every interval,
// through a fake gh. An approved, settled-green task merges with no click; a tick and a click
// never run two passes on one project at once; without autoQueue there is no loop.
import { afterEach, describe, expect, test } from "bun:test";
import { type Board, type BoardOptions, startBoard } from "../src/board/server";
import { type Actor, Foreman } from "../src/core";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import type { QueueEntry } from "../src/queue";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const queueActor: Actor = { name: "merge-queue", kind: "agent" };
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
const ok = (name: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });

/** A fake GitHub shared by every project: per PR, its head commit, mergeability and checks. */
function fakeGitHub() {
  const prs = new Map<string, { head: string; sha: string; mergeable: string; checks: object[]; merged: boolean }>();
  const calls: { cmd: string[]; cwd: string }[] = [];
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: (pr) => {
      const p = prs.get(pr);
      return p ? { head: p.head, headSha: p.sha, mergeable: p.mergeable } : null;
    },
    originRepo: () => "acme/app",
  };
  const run = (cmd: string[], cwd: string) => {
    calls.push({ cmd, cwd });
    const p = prs.get(cmd[3]!);
    if (cmd[1] === "pr" && cmd[2] === "view" && p) {
      if (cmd.includes("state")) return p.merged ? "MERGED" : "OPEN";
      return JSON.stringify({ headRefOid: p.sha, mergeable: p.mergeable, statusCheckRollup: p.checks });
    }
    if (cmd[1] === "pr" && cmd[2] === "merge" && p) {
      if (cmd[cmd.indexOf("--match-head-commit") + 1] !== p.sha) return null;
      p.merged = true;
      return "";
    }
    return null;
  };
  const merges = () => calls.filter((c) => c.cmd[2] === "merge");
  return { prs, calls, policy, run, merges };
}
type GH = ReturnType<typeof fakeGitHub>;

const foreman = (gh: GH) => {
  let clock = 1;
  return new Foreman(openDb(":memory:"), null, () => ++clock, gh.policy);
};

/** A verified, auto-risk task: it lands in approved with green checks, ready to merge. */
function approvedTask(f: Foreman, gh: GH, n: number) {
  const branch = `t-${n}`;
  gh.prs.set(PR(n), { head: branch, sha: `sha${n}aaaaaaaa`, mergeable: "MERGEABLE", checks: [ok("check")], merged: false });
  const t = f.create({ title: `task ${n}`, acceptance: ["cmd: true"], paths: ["src/**"], ready: true, risk: "auto" }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { branch });
  f.submit(t.id, worker, { pr: PR(n) });
  f.startVerify(t.id, verifier);
  f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
  expect(f.get(t.id).status).toBe("approved");
  return t.id;
}

/** Waits until `cond` holds (or ~2 s pass). */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(10);
  return cond();
}

const boards: Board[] = [];
const start = (opts: BoardOptions) => {
  const b = startBoard(opts);
  boards.push(b);
  return b;
};
afterEach(async () => {
  for (const b of boards.splice(0)) await b.stop();
});

describe("fm serve --queue merges without a click", () => {
  test("an approved task with settled green checks merges on the first tick, as the queue actor, with no HTTP call", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const id = approvedTask(f, gh, 1);
    const passes: { project: string; entries: QueueEntry[] }[] = [];
    const settles: number[] = [];
    const board = start({
      foreman: f,
      port: 0,
      // A read-only board (an agent started it): the loop runs all the same.
      approver: null,
      queue: { run: gh.run, cwd: "/repo", settleSeconds: 0, sleep: async (ms) => void settles.push(ms) },
      autoQueue: { actor: queueActor, intervalMs: 10_000, onPass: (project, entries) => passes.push({ project, entries }) },
    });
    expect(board.queueRunning).toBe(true);
    expect(board.token).toBeNull();
    expect(await until(() => passes.length > 0)).toBe(true);
    expect(passes[0]!.entries).toEqual([expect.objectContaining({ id, action: "merged", pr: PR(1) })]);
    expect(f.get(id).status).toBe("done");
    // Settled: the checks were read, the pass waited, read them again, then merged pinned to the verified commit.
    expect(settles).toEqual([0]);
    expect(gh.merges().map((c) => c.cmd)).toEqual([["gh", "pr", "merge", PR(1), "--merge", "--delete-branch", "--match-head-commit", "sha1aaaaaaaa"]]);
    expect(gh.calls.every((c) => c.cwd === "/repo")).toBe(true);
    // The merge is recorded as the queue's actor, not a person.
    const merged = f.events(id).find((e) => e.type === "merged");
    expect(merged).toMatchObject({ actor: "merge-queue", actorKind: "agent" });
  });

  test("a pass runs every intervalMs: a task approved after the first tick merges on a later one", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const passes: QueueEntry[][] = [];
    start({
      foreman: f,
      port: 0,
      approver: human,
      queue: { run: gh.run, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: { actor: queueActor, intervalMs: 20, onPass: (_p, e) => passes.push(e) },
    });
    expect(await until(() => passes.length >= 1)).toBe(true);
    expect(passes[0]).toEqual([]); // nothing approved yet
    const id = approvedTask(f, gh, 2);
    expect(await until(() => f.get(id).status === "done")).toBe(true);
    expect(passes.length).toBeGreaterThanOrEqual(2);
    expect(passes.flat().filter((e) => e.action === "merged").map((e) => e.id)).toEqual([id]);
  });

  test("with two projects each gets its own pass, in its own directory, named in onPass", async () => {
    const gh = fakeGitHub();
    const fa = foreman(gh), fb = foreman(gh);
    const a = approvedTask(fa, gh, 11);
    const b = approvedTask(fb, gh, 12);
    const names: string[] = [];
    start({
      projects: [
        { name: "alpha", foreman: fa, dir: "/repo/alpha" },
        { name: "beta", foreman: fb, dir: "/repo/beta" },
      ],
      port: 0,
      approver: null,
      queue: { run: gh.run, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: { actor: queueActor, intervalMs: 10_000, onPass: (project) => names.push(project) },
    });
    expect(await until(() => names.length >= 2)).toBe(true);
    expect(names.slice(0, 2)).toEqual(["alpha", "beta"]);
    expect(fa.get(a).status).toBe("done");
    expect(fb.get(b).status).toBe("done");
    const cwdOf = (n: number) => new Set(gh.calls.filter((c) => c.cmd[3] === PR(n)).map((c) => c.cwd));
    expect(cwdOf(11)).toEqual(new Set(["/repo/alpha"]));
    expect(cwdOf(12)).toEqual(new Set(["/repo/beta"]));
  });

  test("a pass that throws goes to onError, and the next project and the next tick still run", async () => {
    const gh = fakeGitHub();
    const fa = foreman(gh), fb = foreman(gh);
    const b = approvedTask(fb, gh, 21);
    approvedTask(fa, gh, 22);
    const errors: string[] = [];
    const passes: string[] = [];
    let alphaRuns = 0;
    const run = (cmd: string[], cwd: string) => {
      if (cwd === "/a") {
        alphaRuns++;
        throw new Error("gh exploded");
      }
      return gh.run(cmd, cwd);
    };
    start({
      projects: [
        { name: "alpha", foreman: fa, dir: "/a" },
        { name: "beta", foreman: fb, dir: "/b" },
      ],
      port: 0,
      approver: null,
      queue: { run, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: { actor: queueActor, intervalMs: 20, onPass: (p) => passes.push(p), onError: (p) => errors.push(p) },
    });
    expect(await until(() => errors.length >= 2)).toBe(true);
    expect(errors.every((p) => p === "alpha")).toBe(true);
    expect(passes).toContain("beta");
    expect(fb.get(b).status).toBe("done");
    expect(alphaRuns).toBeGreaterThanOrEqual(2);
  });
});

describe("the --queue loop cleans finished tasks' sessions (T-0099)", () => {
  test("cleanSessions runs after each project's pass, with that project's foreman, and sees the merge the pass made", async () => {
    const gh = fakeGitHub();
    const fa = foreman(gh), fb = foreman(gh);
    const a = approvedTask(fa, gh, 21);
    const order: string[] = [];
    const cleaned: { project: string; status: string }[] = [];
    start({
      projects: [
        { name: "alpha", foreman: fa, dir: "/a" },
        { name: "beta", foreman: fb, dir: "/b" },
      ],
      port: 0,
      approver: null,
      queue: { run: gh.run, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: {
        actor: queueActor,
        intervalMs: 20,
        onPass: (p) => order.push(`pass ${p}`),
        cleanSessions: (f) => {
          const project = f === fa ? "alpha" : f === fb ? "beta" : "?";
          order.push(`clean ${project}`);
          cleaned.push({ project, status: project === "alpha" ? f.get(a).status : "-" });
        },
      },
    });
    expect(await until(() => cleaned.length >= 4)).toBe(true);
    expect(order.slice(0, 4)).toEqual(["pass alpha", "clean alpha", "pass beta", "clean beta"]);
    // The pass merged alpha's task, then the clean saw it done: its sessions can go in the same tick.
    expect(cleaned[0]).toEqual({ project: "alpha", status: "done" });
  });

  test("a cleanSessions that throws doesn't stop the loop: later passes still run and merge", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const passes: QueueEntry[][] = [];
    let cleans = 0;
    start({
      foreman: f,
      port: 0,
      approver: null,
      queue: { run: gh.run, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: {
        actor: queueActor,
        intervalMs: 20,
        onPass: (_p, e) => passes.push(e),
        onError: () => {
          throw new Error("onError should not see a cleanSessions failure");
        },
        cleanSessions: () => {
          cleans++;
          throw new Error("claude rm exploded");
        },
      },
    });
    expect(await until(() => cleans >= 1)).toBe(true);
    const id = approvedTask(f, gh, 22);
    expect(await until(() => f.get(id).status === "done")).toBe(true);
    expect(await until(() => cleans >= 3)).toBe(true);
    expect(passes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("a tick and a click never run two passes on one project at once", () => {
  /** A board whose settle wait blocks while `hold` is on, until the test calls `release`. */
  function heldBoard(approver: Actor | null, intervalMs: number) {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const state = { hold: true, release: null as (() => void) | null, inFlight: 0, maxInFlight: 0 };
    const passes: QueueEntry[][] = [];
    const board = start({
      foreman: f,
      port: 0,
      approver,
      prCacheMs: 0,
      queue: {
        run: gh.run,
        settleSeconds: 0,
        sleep: async () => {
          state.inFlight++;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          if (state.hold) await new Promise<void>((r) => (state.release = r));
          state.inFlight--;
        },
      },
      autoQueue: { actor: queueActor, intervalMs, onPass: (_p, e) => passes.push(e) },
    });
    const auth = () => ({ "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port}` });
    const post = (path: string) => fetch(board.url + path, { method: "POST", headers: auth() });
    return { gh, f, state, passes, board, post };
  }

  test("while the loop's pass is settling, Run queue and Merge are 409 busy and gh merges nothing extra", async () => {
    // The task exists before the board starts, so the first tick finds it and holds in the settle wait.
    const { gh, f, state, passes, post } = heldBoard(human, 10_000);
    const id = approvedTask(f, gh, 31);
    expect(await until(() => state.release !== null)).toBe(true);
    const run = await post("/api/queue/run");
    expect(run.status).toBe(409);
    expect((await run.json()).error).toBe("busy");
    const merge = await post(`/api/tasks/${id}/merge`);
    expect(merge.status).toBe(409);
    expect((await merge.json()).error).toBe("busy");
    expect(gh.merges()).toEqual([]);
    state.hold = false;
    state.release!();
    expect(await until(() => passes.length === 1)).toBe(true);
    expect(passes[0]!.map((e) => e.action)).toEqual(["merged"]);
    expect(gh.merges()).toHaveLength(1);
    expect(state.maxInFlight).toBe(1);
    expect(f.get(id).status).toBe("done");
    // The pass is over: the buttons work again.
    expect((await post("/api/queue/run")).status).toBe(200);
  });

  test("while a click's pass is settling, the loop's ticks skip that project (and still run the others)", async () => {
    const gh = fakeGitHub();
    const fa = foreman(gh), fb = foreman(gh);
    const state = { hold: true, release: null as (() => void) | null, inFlight: 0, maxInFlight: 0 };
    const passes: string[] = [];
    const board = start({
      projects: [
        { name: "alpha", foreman: fa, dir: "/a" },
        { name: "beta", foreman: fb, dir: "/b" }, // nothing approved: its pass shows each tick ran
      ],
      port: 0,
      approver: human,
      prCacheMs: 0,
      queue: {
        run: gh.run,
        settleSeconds: 0,
        sleep: async () => {
          state.inFlight++;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          if (state.hold) await new Promise<void>((r) => (state.release = r));
          state.inFlight--;
        },
      },
      // Long enough that the click below lands well before the second tick.
      autoQueue: { actor: queueActor, intervalMs: 150, onPass: (p) => passes.push(p) },
    });
    const auth = { "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port}` };
    expect(await until(() => passes.length >= 2)).toBe(true); // the first tick: both empty
    const id = approvedTask(fa, gh, 32);
    const click = fetch(`${board.url}/api/p/alpha/tasks/${id}/merge`, { method: "POST", headers: auth });
    expect(await until(() => state.release !== null)).toBe(true);
    const before = passes.length;
    expect(await until(() => passes.filter((p) => p === "beta").length >= 4)).toBe(true); // 3 more ticks
    // Every tick skipped alpha: no pass for it, no second settle wait, no merge yet.
    expect(passes.slice(before).every((p) => p === "beta")).toBe(true);
    expect(state.maxInFlight).toBe(1);
    expect(gh.merges()).toEqual([]);
    state.hold = false;
    state.release!();
    const res = await click;
    expect(res.status).toBe(200);
    expect((await res.json()).entry.action).toBe("merged");
    expect(fa.get(id).status).toBe("done");
    expect(gh.merges()).toHaveLength(1);
  });
});

describe("without --queue there is no loop", () => {
  test("queueRunning is false and gh is never called, however long the board runs", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const id = approvedTask(f, gh, 41);
    const board = start({ foreman: f, port: 0, approver: human, prCacheMs: 0, queue: { run: gh.run, settleSeconds: 0, sleep: () => Promise.resolve() } });
    expect(board.queueRunning).toBe(false);
    await Bun.sleep(100);
    expect(gh.calls).toEqual([]);
    expect(f.get(id).status).toBe("approved");
  });
});

describe("stop()", () => {
  test("waits for the pass in progress, then no further ticks run", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const id = approvedTask(f, gh, 51);
    let release: (() => void) | null = null;
    let passes = 0;
    const board = startBoard({
      foreman: f,
      port: 0,
      approver: null,
      queue: { run: gh.run, settleSeconds: 0, sleep: () => new Promise<void>((r) => (release = r)) },
      autoQueue: { actor: queueActor, intervalMs: 10, onPass: () => passes++ },
    });
    expect(await until(() => release !== null)).toBe(true);
    let stopped = false;
    const stopping = board.stop().then(() => (stopped = true));
    await Bun.sleep(30);
    expect(stopped).toBe(false); // still waiting for the held pass
    release!();
    await stopping;
    expect(passes).toBe(1);
    expect(f.get(id).status).toBe("done");
    const calls = gh.calls.length;
    await Bun.sleep(80);
    expect(gh.calls.length).toBe(calls);
    expect(passes).toBe(1);
  });
});

describe("a pass doesn't block the board (T-0081)", () => {
  test("while a pass waits on a slow gh call, GET /api/tasks answers without waiting for it", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const id = approvedTask(f, gh, 61);
    // An async gh that hangs on every call until released: a slow or hung GitHub.
    const waiting: (() => void)[] = [];
    const slowRun = (cmd: string[], cwd: string) =>
      new Promise<string | null>((resolve) => waiting.push(() => resolve(gh.run(cmd, cwd))));
    const passes: QueueEntry[][] = [];
    const board = start({
      foreman: f,
      port: 0,
      approver: null,
      queue: { run: slowRun, settleSeconds: 0, sleep: () => Promise.resolve() },
      autoQueue: { actor: queueActor, intervalMs: 10_000, onPass: (_p, e) => passes.push(e) },
    });
    expect(await until(() => waiting.length === 1)).toBe(true); // the pass is stuck on gh pr view
    const t0 = Date.now();
    const res = await fetch(`${board.url}/api/tasks`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: { id: string; status: string }[] };
    expect(body.tasks.find((t) => t.id === id)?.status).toBe("approved");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(passes).toEqual([]); // the pass is still waiting
    // Let GitHub answer every call: the pass goes on and merges.
    while (passes.length === 0) {
      waiting.splice(0).forEach((r) => r());
      await Bun.sleep(5);
    }
    expect(passes[0]).toEqual([expect.objectContaining({ id, action: "merged" })]);
    expect(f.get(id).status).toBe("done");
  });

  test("the Run queue button: the board answers while its pass waits on gh", async () => {
    const gh = fakeGitHub();
    const f = foreman(gh);
    const id = approvedTask(f, gh, 62);
    const waiting: (() => void)[] = [];
    const slowRun = (cmd: string[], cwd: string) =>
      new Promise<string | null>((resolve) => waiting.push(() => resolve(gh.run(cmd, cwd))));
    const board = start({ foreman: f, port: 0, approver: human, queue: { run: slowRun, settleSeconds: 0, sleep: () => Promise.resolve() } });
    const click = fetch(`${board.url}/api/queue/run`, { method: "POST", headers: { "x-foreman-token": board.token! } });
    expect(await until(() => waiting.length === 1)).toBe(true);
    const res = await fetch(`${board.url}/api/tasks`, { signal: AbortSignal.timeout(2000) });
    expect(res.status).toBe(200);
    let done = false;
    void click.then(() => (done = true));
    while (!done) {
      waiting.splice(0).forEach((r) => r());
      await Bun.sleep(5);
    }
    expect((await click).status).toBe(200);
    expect(f.get(id).status).toBe("done");
  });
});
