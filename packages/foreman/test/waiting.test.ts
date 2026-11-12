// Why a task waits, followed to the end (D0042): direct reasons, the path tree, the reverse,
// and that next_tasks, claim and the dispatcher all read the same rule.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError, type CreateInput } from "../src/core";
import { branchFor, Dispatcher, type Launcher } from "../src/dispatch";
import { buildServer } from "../src/mcp";
import { registerDispatcher, unregisterDispatcher } from "../src/dispatchers";
import { Plans } from "../src/plans";
import { DEFAULT_PROTECTED } from "../src/policy";
import { openDb } from "../src/store";
import { holdsUp, pathOf, type PathNode, pathText, waitShort, waitsOn } from "../src/waiting";

const dir = mkdtempSync(join(tmpdir(), "foreman-waiting-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
Bun.spawnSync(["git", "init", "-q", dir]); // the CLI wants a repository

const ada: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const PASS = [{ check: "c1", pass: true, evidence: "ok" }];
const FAIL = [{ check: "c1", pass: false, evidence: "red" }];

/** A dispatcher's record, as `fm dispatch` writes it: for the whole board unless `scope` names plans. */
const running = (pid: number, scope?: string, flags: { once?: boolean; verifyOnly?: boolean } = {}) => ({
  pid,
  max: 3,
  flags: { once: false, verifyOnly: false, print: false, ...flags },
  starter: { name: "ada", kind: "human" as const },
  cwd: "/repo",
  startedAt: 1_000_000,
  ...(scope ? { scope } : {}),
});

/**
 * A board with a whole-board dispatcher running (this process stands in for it), so a
 * free task "can start". `covered: false` leaves it out: then nothing covers a ready task (D0045).
 */
function setup(db = openDb(":memory:"), { covered = true } = {}) {
  const alive = new Set<number>(covered ? [process.pid] : []);
  const f = new Foreman(db, null, () => 1_000_000, { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] }, (pid) => alive.has(pid));
  if (covered) registerDispatcher(f, running(process.pid));
  const plans = new Plans(f, () => 1_000_000);
  let n = 0;
  /** A ready task with its own paths, so nothing overlaps unless the test says so. */
  const add = (title: string, more: Partial<CreateInput> = {}) =>
    f.create({ title, acceptance: ["cmd: true"], risk: "auto", paths: [`src/${++n}/**`], ready: true, ...more }, ada).id;
  const finish = (id: string) => {
    f.claim(id, worker);
    f.submit(id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(id, verifier);
    f.recordVerify(id, verifier, PASS);
    f.merged(id, ada);
  };
  const twoSteps = () => plans.create({ title: "Plan", steps: [{ title: "First", check: "one" }, { title: "Second", check: "two" }] }, ada).id;
  return { f, plans, add, finish, twoSteps, alive };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "no error";
}

/** The tasks of a tree in the order it prints them. */
function flat(n: PathNode): string[] {
  return [n.task, ...n.children.flatMap(flat)];
}

describe("plan steps gate (D0042)", () => {
  test("a ready task in step 2 isn't offered or claimable until step 1 is done", () => {
    const { f, plans, add, finish, twoSteps } = setup();
    const p = twoSteps();
    const one = add("one");
    const other = add("one, side by side");
    const two = add("two");
    plans.add(one, p, 1, ada);
    plans.add(other, p, 1, ada);
    plans.add(two, p, 2, ada);

    // Tasks in the same step run side by side; the later step waits.
    expect(f.ready("agent").map((t) => t.id)).toEqual([one, other]);
    expect(waitsOn(f, two)).toEqual([{ kind: "step", plan: p, step: 1, title: "First", tasks: [one, other] }]);
    expect(code(() => f.claim(two, worker))).toBe("blocked");
    expect(code(() => f.claim(two, ada))).toBe("blocked"); // a person too: the order is the plan's
    expect(f.get(two).status).toBe("ready");

    finish(one);
    expect(f.ready("agent").map((t) => t.id)).toEqual([other]);
    expect(code(() => f.claim(two, worker))).toBe("blocked");

    // A cancelled task doesn't hold the step open.
    f.cancel(other, ada, "not needed");
    expect(waitsOn(f, two)).toEqual([]);
    expect(f.ready("agent").map((t) => t.id)).toEqual([two]);
    expect(f.claim(two, worker).status).toBe("claimed");
  });

  test("the refusal names the step and its unfinished tasks", () => {
    const { f, plans, add, twoSteps } = setup();
    const p = twoSteps();
    const one = add("one");
    const two = add("two");
    plans.add(one, p, 1, ada);
    plans.add(two, p, 2, ada);
    expect(() => f.claim(two, worker)).toThrow(`${two} can't be claimed yet: step 1 of ${p} ("First") isn't done: ${one}`);
  });

  test("the next_tasks tool leaves it out too, and claim_task refuses it", async () => {
    const { f, plans, add, finish, twoSteps } = setup();
    const p = twoSteps();
    const one = add("one");
    const two = add("two");
    plans.add(one, p, 1, ada);
    plans.add(two, p, 2, ada);
    const server = buildServer(f, worker) as unknown as { _registeredTools: Record<string, { handler: (a: object) => Promise<{ isError?: boolean; content: { text: string }[] }> }> };
    const call = async (name: string, args: object = {}) => {
      const r = await server._registeredTools[name]!.handler(args);
      return { error: r.isError === true, text: r.content[0]!.text };
    };
    const next = async () => (JSON.parse((await call("next_tasks")).text) as { id: string }[]).map((t) => t.id);
    expect(await next()).toEqual([one]);
    const refused = await call("claim_task", { id: two });
    expect(refused.error).toBe(true);
    expect(refused.text).toStartWith("blocked:");
    // list_tasks says what the waiting one waits on.
    const listed = JSON.parse((await call("list_tasks")).text) as { id: string; waits?: string }[];
    expect(listed.find((t) => t.id === two)!.waits).toBe(`waits: step 1 of ${p} <- ${one} (ready)`);
    expect(listed.find((t) => t.id === one)!.waits).toBeUndefined();
    finish(one);
    expect(await next()).toEqual([two]);
  });

  test("a cancelled plan holds nothing back", () => {
    const { f, plans, add, twoSteps } = setup();
    const p = twoSteps();
    const one = add("one");
    const two = add("two");
    plans.add(one, p, 1, ada);
    plans.add(two, p, 2, ada);
    plans.cancel(p, ada, "dropped");
    expect(f.ready("agent").map((t) => t.id)).toEqual([one, two]);
  });

  test("a task can't go in a step earlier than a task it is blocked by", () => {
    const { plans, add, twoSteps } = setup();
    const p = twoSteps();
    const late = add("late");
    const early = add("early", { blockedBy: [late] });
    plans.add(late, p, 2, ada);
    expect(code(() => plans.add(early, p, 1, ada))).toBe("cycle");
    expect(plans.placement(early)).toBeNull();
  });
});

describe("the whole path", () => {
  test("a chain three deep: a blocker, an earlier plan step, overlapping paths, down to a running worker", () => {
    const { f, plans, add, twoSteps, alive } = setup();
    const p = twoSteps();
    const d = add("D", { paths: ["src/shared/**"] });
    const c = add("C", { paths: ["src/shared/util.ts"] });
    const b = add("B");
    const a = add("A", { blockedBy: [b] });
    plans.add(c, p, 1, ada);
    plans.add(b, p, 2, ada);
    f.claim(d, { name: "worker-D", kind: "agent" });
    f.progress(d, { name: "worker-D", kind: "agent" });
    f.pinLease(d, { name: "worker-D", kind: "agent" }, 4242);
    alive.add(4242);

    const path = pathOf(f, a);
    expect(flat(path.root)).toEqual([a, b, c, d]);
    expect(path.depth).toBe(3);
    const [nb] = path.root.children;
    const [nc] = nb!.children;
    const [nd] = nc!.children;
    expect(nb!.via).toEqual({ kind: "blocked", task: b, status: "ready" });
    expect(nc!.via).toMatchObject({ kind: "step", plan: p, step: 1, tasks: [c] });
    expect(nd!.via).toEqual({ kind: "paths", task: d, status: "in_progress" });
    expect(nd!.children).toEqual([]);
    expect(nd!.end).toMatchObject({ kind: "running", actor: "worker-D", live: true });
    // The flat summary: only D has to move.
    expect(path.leaves.map((l) => l.task)).toEqual([d]);
    expect(path.summary).toBe(`moves when: ${d} is finished by worker-D (in progress, session live)`);
    expect(waitShort(f, a)).toBe(`waits: ${b} <- ${d} (in progress)`);

    // As printed: one line per task, indented by depth.
    expect(pathText(path).split("\n")).toEqual([
      `${a}  ready  A`,
      `  ${b}  ready  B  [blocker]`,
      `    ${c}  ready  C  [step 1 of ${p} "First"]`,
      `      ${d}  in progress  D  [paths overlap]  => running: ${d} is finished by worker-D (in progress, session live)`,
    ]);

    // The session dies: still held, but the leaf says so.
    alive.delete(4242);
    expect(pathOf(f, a).leaves[0]).toMatchObject({ kind: "running", actor: "worker-D", live: false });
  });

  test("each kind of leaf", () => {
    const { f, add, finish } = setup();
    const leafOf = (id: string) => {
      const waiter = add(`waits on ${id}`, { blockedBy: [id] });
      const path = pathOf(f, waiter);
      expect(path.leaves).toHaveLength(1);
      return path.leaves[0]!;
    };

    // running: a worker holds it, or a verifier.
    const claimed = add("claimed");
    f.claim(claimed, worker);
    expect(leafOf(claimed)).toMatchObject({ task: claimed, kind: "running", actor: "worker-1", live: null });
    const verifying = add("verifying");
    f.claim(verifying, worker);
    f.submit(verifying, worker, { pr: "https://example.com/pull/2" });
    f.startVerify(verifying, verifier);
    expect(leafOf(verifying)).toMatchObject({ kind: "running", actor: "verifier-1", text: `${verifying} finishes verifying (verifier-1, no session recorded)` });

    // needs a person: verified and waiting for approval, risk human, a draft.
    const review = add("review", { risk: "review" });
    f.claim(review, worker);
    f.submit(review, worker, { pr: "https://example.com/pull/3" });
    f.startVerify(review, verifier);
    f.recordVerify(review, verifier, PASS);
    expect(leafOf(review)).toMatchObject({ kind: "needs a person", text: `${review} is approved by a person` });
    const human = add("by hand", { risk: "human" });
    expect(leafOf(human)).toMatchObject({ kind: "needs a person", text: `${human} is done by a person (risk "human")` });
    const draft = add("draft", { ready: false });
    expect(leafOf(draft)).toMatchObject({ kind: "needs a person", text: `${draft} is marked ready (a draft)` });

    // can start: ready with nothing to wait on.
    const free = add("free");
    expect(leafOf(free)).toMatchObject({ kind: "can start", text: `${free} is picked up (ready, nothing to wait on)` });
    expect(pathOf(f, free).leaves.map((l) => l.kind)).toEqual(["can start"]);

    // stuck: failed verification, sent back, or the blocker was cancelled.
    const failed = add("failed");
    f.claim(failed, worker);
    f.submit(failed, worker, { pr: "https://example.com/pull/4" });
    f.startVerify(failed, verifier);
    f.recordVerify(failed, verifier, FAIL);
    expect(leafOf(failed)).toMatchObject({ kind: "stuck", text: `${failed} gets a new run (failed verification)` });
    const back = add("sent back");
    f.claim(back, worker);
    f.submit(back, worker, { pr: "https://example.com/pull/5" });
    f.rework(back, ada, "missed a case");
    expect(leafOf(back)).toMatchObject({ kind: "stuck", text: `${back} gets a new run (sent back: missed a case)` });
    const cancelled = add("cancelled");
    f.cancel(cancelled, ada, "no");
    expect(leafOf(cancelled)).toMatchObject({ kind: "stuck", status: "cancelled" });

    // A done blocker isn't on the path at all.
    const done = add("done");
    finish(done);
    const after = add("after done", { blockedBy: [done] });
    expect(waitsOn(f, after)).toEqual([]);
    expect(pathOf(f, after).root.children).toEqual([]);
  });

  test("a blockedBy cycle is reported as a cycle, not followed", () => {
    const { f, add } = setup();
    const a = add("A");
    const b = add("B", { blockedBy: [a] });
    // edit refuses to make one, so write the loop the way old data could hold it.
    f.db.query(`UPDATE tasks SET blocked_by = ? WHERE id = ?`).run(JSON.stringify([b]), a);

    const path = pathOf(f, a);
    expect(flat(path.root)).toEqual([a, b, a]);
    const loop = path.root.children[0]!.children[0]!;
    expect(loop.cycle).toEqual([a, b, a]);
    expect(loop.children).toEqual([]);
    expect(path.leaves).toEqual([{ task: a, status: "ready", kind: "stuck", text: `cycle: ${a} waits on ${b} waits on ${a}` }]);
    expect(pathText(path)).toContain("=> stuck: cycle:");
    expect(waitShort(f, a)).toBe(`waits: ${b} <- ${a} (cycle)`);
    // Neither side is offered, and the reverse ends too.
    expect(f.ready("agent")).toEqual([]);
    expect(holdsUp(f, a).tasks.map((t) => t.id)).toEqual([b]);
  });

  test("a task reached twice is shown once in full, then as a reference", () => {
    const { f, add } = setup();
    const root = add("root cause", { ready: false });
    const left = add("left", { blockedBy: [root] });
    const right = add("right", { blockedBy: [root] });
    const top = add("top", { blockedBy: [left, right] });
    const path = pathOf(f, top);
    expect(flat(path.root)).toEqual([top, left, root, right, root]);
    expect(path.root.children[0]!.children[0]!.ref).toBeUndefined();
    expect(path.root.children[1]!.children[0]).toMatchObject({ task: root, ref: true, children: [] });
    expect(path.leaves.map((l) => l.task)).toEqual([root]); // once
    expect(path.depth).toBe(2);
    expect(pathText(path)).toContain("(shown above)");
  });

  test("a blocker that doesn't exist stops the path as stuck", () => {
    const { f, add } = setup();
    const a = add("A");
    f.db.query(`UPDATE tasks SET blocked_by = ? WHERE id = ?`).run(JSON.stringify(["T-9999"]), a);
    expect(f.ready("agent")).toEqual([]);
    expect(pathOf(f, a).leaves).toMatchObject([{ task: "T-9999", status: "missing", kind: "stuck" }]);
  });
});

describe("the reverse: what a task holds up", () => {
  test("everything downstream, direct and through others, and fm show prints it", () => {
    const db = join(dir, "show.db");
    const { f, plans, add, twoSteps } = setup(openDb(db));
    const p = twoSteps();
    const end = add("the blocker at the end");
    const mid = add("middle", { blockedBy: [end] });
    const top = add("top", { blockedBy: [mid] });
    const later = add("a later step");
    const aside = add("unrelated");
    plans.add(mid, p, 1, ada);
    plans.add(later, p, 2, ada);

    const held = holdsUp(f, end);
    expect(held.count).toBe(3);
    expect(held.tasks.map((t) => [t.id, t.direct])).toEqual([[mid, true], [top, false], [later, false]]);
    expect(holdsUp(f, aside).count).toBe(0);
    f.db.close();

    const fm = (...args: string[]) => {
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
        cwd: dir,
        stdin: "ignore",
        env: { ...process.env, FOREMAN_DB: db, FOREMAN_ACTOR: "ada", FOREMAN_AGENT: "", CLAUDE_CODE_CHILD_SESSION: "" },
      });
      expect(r.stderr.toString()).toBe("");
      return r.stdout.toString();
    };
    const shown = fm("show", end);
    expect(shown).toContain("## Holds up (3)");
    expect(shown).toContain(`- ${mid}  ready  middle\n- ${top}  ready  top  (through others)\n- ${later}  ready  a later step  (through others)`);
    expect(shown).toContain(`moves when: ${end} is picked up (ready, nothing to wait on)`);

    // The waiting side: the tree, then the leaves, then what it holds up in turn.
    const waiting = fm("show", top);
    expect(waiting).toContain(`## Waits on\n${top}  ready  top\n  ${mid}  ready  middle  [blocker]\n    ${end}  ready  the blocker at the end  [blocker]  => can start:`);
    expect(waiting).toContain("depth: 2");
    expect(waiting).not.toContain("## Holds up");

    // --path: only the tree. --json: the tree as data.
    expect(fm("show", top, "--path").trim().split("\n")).toHaveLength(3);
    const json = JSON.parse(fm("show", top, "--json")) as { waits: { depth: number; root: PathNode; leaves: { task: string }[] }; holdsUp: { count: number } };
    expect(flat(json.waits.root)).toEqual([top, mid, end]);
    expect(json.waits.leaves.map((l) => l.task)).toEqual([end]);
    expect(json.holdsUp.count).toBe(0);
    expect((JSON.parse(fm("show", top, "--path", "--json")) as { depth: number }).depth).toBe(2);

    // fm list and fm next carry the short form.
    expect(fm("list")).toContain(`top  (waits: ${mid} <- ${end} (ready))`);
    expect(fm("next").trim().split("\n").map((l) => l.split(" ")[0])).toEqual([end, aside]);
  });
});

describe("one rule for next_tasks, claim and the dispatcher", () => {
  test("the dispatcher starts nothing that waitsOn names, and says why", async () => {
    const { f, plans, add, twoSteps, alive } = setup();
    const p = twoSteps();
    const running = add("running", { paths: ["src/a/**"] });
    const overlap = add("overlaps the running one", { paths: ["src/a/x.ts"] });
    const one = add("step one", { paths: ["src/b/**"] });
    const two = add("step two", { paths: ["src/c/**"] });
    const blocked = add("blocked", { paths: ["src/d/**"], blockedBy: [one] });
    plans.add(one, p, 1, ada);
    plans.add(two, p, 2, ada);
    f.claim(running, worker);

    const log: string[] = [];
    const started: string[] = [];
    const launcher: Launcher = (opts, onSpawn) =>
      new Promise(() => {
        started.push(opts.taskId!);
        alive.add(77);
        onSpawn(77);
      });
    const worktrees = (t: Parameters<typeof branchFor>[0]) => {
      const path = join(dir, `${t.id}-wt`);
      mkdirSync(path, { recursive: true });
      return { branch: branchFor(t), path };
    };
    Object.assign(f, { root: dir });
    const d = new Dispatcher(f, { max: 5, launcher, worktrees, log: (l) => log.push(l), cleanSessions: () => {} });
    d.tick();

    // Only what has nothing to wait on: every other ready task is named by waitsOn.
    expect(started).toEqual([one]);
    for (const id of [overlap, two, blocked]) expect(waitsOn(f, id).length).toBeGreaterThan(0);
    expect(f.ready("agent").map((t) => t.id)).toEqual([overlap]); // claimable by hand; the dispatcher keeps it apart
    expect(log).toContain(`${overlap} waits: its paths overlap ${running}'s (claimed)`);
    expect(code(() => f.claim(two, worker))).toBe("blocked");
    expect(code(() => f.claim(blocked, worker))).toBe("blocked");
  });
});

describe("editing what a task is blocked by", () => {
  test("add and remove on a draft or ready task; a cycle is refused", () => {
    const { f, add } = setup();
    const a = add("A");
    const b = add("B");
    const c = add("C", { ready: false });
    expect(f.edit(b, worker, { addBlockedBy: [a] }).blockedBy).toEqual([a]);
    expect(f.edit(c, worker, { addBlockedBy: [b, a] }).blockedBy).toEqual([b, a]);
    expect(f.ready("agent").map((t) => t.id)).toEqual([a]);

    // A -> C -> B -> A would loop; so would a task blocking itself. Nothing is written.
    expect(code(() => f.edit(a, worker, { addBlockedBy: [c] }))).toBe("cycle");
    expect(code(() => f.edit(a, worker, { addBlockedBy: [a] }))).toBe("cycle");
    expect(f.get(a).blockedBy).toEqual([]);
    expect(f.events(a).filter((e) => e.type === "edited")).toEqual([]);

    expect(code(() => f.edit(b, worker, { addBlockedBy: ["T-9999"] }))).toBe("not_found");
    expect(code(() => f.edit(b, worker, { removeBlockedBy: [c] }))).toBe("invalid");
    expect(f.edit(b, worker, { removeBlockedBy: [a] }).blockedBy).toEqual([]);
    expect(f.ready("agent").map((t) => t.id)).toEqual([a, b]);

    // Not once work has started, by the holder or by a person.
    f.claim(a, worker);
    expect(code(() => f.edit(a, worker, { addBlockedBy: [b] }))).toBe("in_progress");
    expect(code(() => f.edit(a, ada, { addBlockedBy: [b] }))).toBe("bad_status");
  });

  test("a blocker in a later plan step is a cycle too", () => {
    const { f, plans, add, twoSteps } = setup();
    const p = twoSteps();
    const early = add("early");
    const late = add("late");
    plans.add(early, p, 1, ada);
    plans.add(late, p, 2, ada);
    expect(code(() => f.edit(early, ada, { addBlockedBy: [late] }))).toBe("cycle");
    expect(f.get(early).blockedBy).toEqual([]);
  });
});

describe("no dispatcher (D0045)", () => {
  test("a ready task nothing covers says so, until a covering dispatcher runs", () => {
    const { f, plans, add, twoSteps, alive } = setup(undefined, { covered: false });
    const p = twoSteps();
    const inPlan = add("in the plan");
    const later = add("step two");
    const free = add("in no plan");
    plans.add(inPlan, p, 1, ada);
    plans.add(later, p, 2, ada);

    // Nothing runs: both free tasks wait for a dispatcher, and only for that.
    for (const id of [inPlan, free]) {
      expect(waitsOn(f, id)).toEqual([{ kind: "no dispatcher" }]);
      expect(waitShort(f, id)).toBe("waits: no dispatcher");
      expect(pathOf(f, id).leaves).toEqual([{ task: id, status: "ready", kind: "no dispatcher", text: `${id} is picked up (can start, but no dispatcher covers it)` }]);
    }
    expect(pathText(pathOf(f, free))).toContain("=> no dispatcher:");
    // It is not a reason to refuse a claim: a session may still take the task by hand.
    expect(f.ready("agent").map((t) => t.id)).toEqual([inPlan, free]);

    // A task that waits on something else doesn't wait for a dispatcher yet; its chain ends in one.
    expect(waitsOn(f, later)).toEqual([{ kind: "step", plan: p, step: 1, title: "First", tasks: [inPlan] }]);
    expect(pathOf(f, later).leaves.map((l) => [l.task, l.kind])).toEqual([[inPlan, "no dispatcher"]]);
    expect(waitShort(f, later)).toBe(`waits: step 1 of ${p} <- ${inPlan} (ready, no dispatcher)`);

    // A dispatcher for the plan: its task can start, the one in no plan still has nobody.
    alive.add(7001);
    registerDispatcher(f, running(7001, p));
    expect(waitsOn(f, inPlan)).toEqual([]);
    expect(waitShort(f, inPlan)).toBeNull();
    expect(pathOf(f, inPlan).leaves[0]).toMatchObject({ kind: "can start" });
    expect(pathOf(f, later).leaves.map((l) => [l.task, l.kind])).toEqual([[inPlan, "can start"]]);
    expect(waitsOn(f, free)).toEqual([{ kind: "no dispatcher" }]);

    // A whole-board one covers the rest.
    alive.add(7002);
    registerDispatcher(f, running(7002));
    expect(waitsOn(f, free)).toEqual([]);

    // Stopped (the record gone) or killed (the pid dead): back to no dispatcher.
    unregisterDispatcher(f, 7002);
    expect(waitsOn(f, free)).toEqual([{ kind: "no dispatcher" }]);
    alive.delete(7001);
    expect(waitsOn(f, inPlan)).toEqual([{ kind: "no dispatcher" }]);
  });

  test("a dispatcher that starts no new workers doesn't cover a ready task", () => {
    const { f, add, alive } = setup(undefined, { covered: false });
    const free = add("free");
    alive.add(7001).add(7002);
    registerDispatcher(f, running(7001, undefined, { verifyOnly: true }));
    registerDispatcher(f, running(7002, undefined, { once: true }));
    expect(waitsOn(f, free)).toEqual([{ kind: "no dispatcher" }]);
  });

  test("only a ready task with nothing else to wait on: not a draft, a person's task, or one in flight", () => {
    const { f, add } = setup(undefined, { covered: false });
    const draft = add("draft", { ready: false });
    const human = add("by hand", { risk: "human" });
    const held = add("held");
    f.claim(held, worker);
    expect(waitsOn(f, draft)).toEqual([{ kind: "draft" }]);
    expect(waitsOn(f, human)).toEqual([{ kind: "human" }]);
    expect(waitsOn(f, held)).toEqual([]);
  });
});
