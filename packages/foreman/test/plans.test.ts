import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError, type Status } from "../src/core";
import { toMarkdown } from "../src/export";
import { DEFAULT_PROTECTED } from "../src/policy";
import { parseStep, planLine, Plans, planText, stepState } from "../src/plans";
import { openDb, SCHEMA_VERSION } from "../src/store";

const ada: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };

function setup() {
  const f = new Foreman(openDb(":memory:"), null, () => 1_000_000, { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => [] });
  return { f, plans: new Plans(f, () => 1_000_000) };
}

const twoSteps = {
  title: "Publish foreman",
  goal: "Ship it to npm.",
  steps: [
    { title: "Rename", check: "every package is @foreman-kit/*" },
    { title: "Release", check: "a v* tag publishes" },
  ],
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "no error";
}

/** A task in the given status, by the shortest legal route. */
function taskIn(f: Foreman, status: Status, title: string = status): string {
  const t = f.create({ title, acceptance: ["cmd: true"], risk: "auto", ready: status !== "draft" }, ada);
  if (status === "draft" || status === "ready") return t.id;
  if (status === "cancelled") return f.cancel(t.id, ada, "no"), t.id;
  f.claim(t.id, worker);
  if (status === "claimed") return t.id;
  f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
  if (status === "in_review") return t.id;
  f.startVerify(t.id, { name: "verifier-1", kind: "agent" });
  f.recordVerify(t.id, { name: "verifier-1", kind: "agent" }, [{ check: "c1", pass: true, evidence: "ok" }]);
  if (f.get(t.id).status === "needs_approval") f.approve(t.id, ada);
  if (status === "approved") return t.id;
  f.merged(t.id, ada);
  return t.id;
}

describe("step state", () => {
  test("comes from the tasks' statuses", () => {
    expect(stepState([])).toBe("empty");
    expect(stepState(["cancelled"])).toBe("empty");
    expect(stepState(["draft", "ready"])).toBe("waiting");
    expect(stepState(["ready", "claimed"])).toBe("in_progress");
    expect(stepState(["ready", "done"])).toBe("in_progress");
    expect(stepState(["needs_approval"])).toBe("in_progress");
    expect(stepState(["done", "cancelled"])).toBe("done");
    expect(stepState(["done", "done"])).toBe("done");
  });

  test('a step is written "title :: check"', () => {
    expect(parseStep("Rename :: every package is renamed")).toEqual({ title: "Rename", check: "every package is renamed" });
    expect(code(() => parseStep("no separator"))).toBe("invalid");
  });
});

describe("plans", () => {
  test("a plan has ordered steps, each with a check; a step without one is refused", () => {
    const { plans } = setup();
    const p = plans.create(twoSteps, ada);
    expect(p.id).toBe("P-0001");
    expect(p.steps.map((s) => [s.n, s.title, s.check, s.state])).toEqual([
      [1, "Rename", "every package is @foreman-kit/*", "empty"],
      [2, "Release", "a v* tag publishes", "empty"],
    ]);
    expect(p.state).toBe("active");
    expect(code(() => plans.create({ title: "x", steps: [{ title: "a", check: " " }] }, ada))).toBe("invalid");
    expect(code(() => plans.create({ title: "x", steps: [] }, ada))).toBe("invalid");
    expect(code(() => plans.create({ title: " ", steps: twoSteps.steps }, ada))).toBe("invalid");
    expect(plans.create(twoSteps, ada).id).toBe("P-0002");
  });

  test("progress follows the tasks, and the plan is done when every step is", () => {
    const { f, plans } = setup();
    const p = plans.create(twoSteps, ada);
    const a = taskIn(f, "done", "renamed");
    const b = taskIn(f, "cancelled", "dropped");
    const c = taskIn(f, "claimed", "release workflow");
    const d = taskIn(f, "ready", "release docs");
    plans.add(a, p.id, 1, ada);
    plans.add(b, p.id, 1, ada);
    plans.add(c, p.id, 2, ada);
    plans.add(d, p.id, 2, ada);
    let got = plans.get(p.id);
    expect(got.steps.map((s) => s.state)).toEqual(["done", "in_progress"]);
    // A cancelled task doesn't count towards the plan's tasks.
    expect(got.progress).toEqual({ steps: 2, stepsDone: 1, tasks: 3, tasksDone: 1 });
    expect(got.state).toBe("active");

    f.cancel(c, ada, "folded into the docs task");
    f.claim(d, worker);
    f.submit(d, worker, { pr: "https://example.com/pull/2" });
    f.startVerify(d, { name: "v", kind: "agent" });
    f.recordVerify(d, { name: "v", kind: "agent" }, [{ check: "c1", pass: true, evidence: "ok" }]);
    if (f.get(d).status === "needs_approval") f.approve(d, ada);
    f.merged(d, ada);
    got = plans.get(p.id);
    expect(got.steps.map((s) => s.state)).toEqual(["done", "done"]);
    expect(got.state).toBe("done");

    // A new step reopens it: progress is worked out, never stored.
    plans.edit(p.id, ada, { addSteps: [{ title: "First release", check: "on npm" }] });
    got = plans.get(p.id);
    expect(got.state).toBe("active");
    expect(got.steps[2]).toMatchObject({ n: 3, state: "empty" });
  });

  test("a task is in at most one plan: adding it elsewhere moves it, and its history says so", () => {
    const { f, plans } = setup();
    const p1 = plans.create(twoSteps, ada);
    const p2 = plans.create({ title: "Other", steps: [{ title: "Only", check: "done" }] }, ada);
    const t = taskIn(f, "ready");
    plans.add(t, p1.id, 2, ada);
    expect(plans.placement(t)).toEqual({ plan: p1.id, step: 2 });
    plans.add(t, p2.id, 1, { name: "mcp-1", kind: "agent" });
    expect(plans.placement(t)).toEqual({ plan: p2.id, step: 1 });
    expect(plans.get(p1.id).steps.flatMap((s) => s.tasks)).toEqual([]);
    expect(plans.remove(t, ada)).toEqual({ plan: p2.id, step: 1 });
    expect(plans.placement(t)).toBeNull();
    expect(code(() => plans.remove(t, ada))).toBe("invalid");
    const types = f.events(t).map((e) => e.type);
    expect(types.filter((x) => x === "planned" || x === "unplanned")).toEqual(["planned", "planned", "unplanned"]);
    expect(f.events(t).find((e) => e.type === "planned" && e.actor === "mcp-1")?.data).toMatchObject({
      plan: p2.id,
      step: 1,
      from: { plan: p1.id, step: 2 },
    });
  });

  test("a bad plan or step is refused, and a task filed with one isn't filed at all", () => {
    const { f, plans } = setup();
    const p = plans.create(twoSteps, ada);
    const t = taskIn(f, "ready");
    expect(code(() => plans.add(t, p.id, 3, ada))).toBe("invalid");
    expect(code(() => plans.add(t, p.id, 0, ada))).toBe("invalid");
    expect(code(() => plans.add(t, "P-0099", 1, ada))).toBe("not_found");
    expect(code(() => plans.add("T-0099", p.id, 1, ada))).toBe("not_found");
    const before = f.list().length;
    expect(code(() => plans.createTask({ title: "x", acceptance: ["cmd: true"] }, { plan: p.id, step: 5 }, ada))).toBe("invalid");
    expect(f.list().length).toBe(before);
    const filed = plans.createTask({ title: "x", acceptance: ["cmd: true"] }, { plan: p.id, step: 2 }, ada);
    expect(plans.placement(filed.id)).toEqual({ plan: p.id, step: 2 });
    expect(plans.createTask({ title: "y" }, null, ada).title).toBe("y");
  });

  test("editing and cancelling leave history; a cancelled plan takes no more changes", () => {
    const { f, plans } = setup();
    const p = plans.create(twoSteps, ada);
    plans.edit(p.id, ada, { title: "Publish", goal: "Now." });
    expect(plans.get(p.id)).toMatchObject({ title: "Publish", goal: "Now." });
    expect(code(() => plans.cancel(p.id, ada, " "))).toBe("invalid");
    const c = plans.cancel(p.id, ada, "not now");
    expect(c).toMatchObject({ state: "cancelled", cancelReason: "not now" });
    expect(code(() => plans.edit(p.id, ada, { title: "x" }))).toBe("bad_status");
    expect(code(() => plans.add(taskIn(f, "ready"), p.id, 1, ada))).toBe("bad_status");
    expect(code(() => plans.cancel(p.id, ada, "again"))).toBe("bad_status");
    const planEvents = f.events().filter((e) => e.type.startsWith("plan_")).map((e) => [e.type, e.data.plan]);
    expect(planEvents).toEqual([
      ["plan_created", p.id],
      ["plan_edited", p.id],
      ["plan_cancelled", p.id],
    ]);
  });

  test("dispatched sessions can't shape plans from any door, but a worker can file a task into one", () => {
    const { f, plans } = setup();
    const p = plans.create(twoSteps, ada);
    const t = taskIn(f, "ready");
    for (const name of ["worker-T-0001", "verifier-T-0001", "intake-abc"]) {
      const agent: Actor = { name, kind: "agent" };
      expect(code(() => plans.create(twoSteps, agent))).toBe("not_allowed");
      expect(code(() => plans.edit(p.id, agent, { title: "x" }))).toBe("not_allowed");
      expect(code(() => plans.add(t, p.id, 1, agent))).toBe("not_allowed");
      expect(code(() => plans.cancel(p.id, agent, "why"))).toBe("not_allowed");
    }
    plans.add(t, p.id, 1, ada);
    expect(code(() => plans.remove(t, { name: "worker-T-0001", kind: "agent" }))).toBe("not_allowed");
    // A person's own session (mcp-…) and a person may.
    const own: Actor = { name: "mcp-abc", kind: "agent" };
    expect(plans.edit(p.id, own, { goal: "g" }).goal).toBe("g");
    expect(plans.remove(t, own)).toEqual({ plan: p.id, step: 1 });
    // A person named like a role is still a person.
    expect(plans.edit(p.id, { name: "worker-bee", kind: "human" }, { title: "Mine" }).title).toBe("Mine");
    const filed = plans.createTask({ title: "found on the way", acceptance: ["cmd: true"] }, { plan: p.id, step: 2 }, worker);
    expect(plans.placement(filed.id)).toEqual({ plan: p.id, step: 2 });
    expect(f.events(filed.id).find((e) => e.type === "planned")?.actor).toBe("worker-1");
  });

  test("list puts active plans first; text forms show steps, checks, states and tasks", () => {
    const { f, plans } = setup();
    const done = plans.create({ title: "Done one", steps: [{ title: "s", check: "c" }] }, ada);
    plans.add(taskIn(f, "done"), done.id, 1, ada);
    const cancelled = plans.create({ title: "Dropped", steps: [{ title: "s", check: "c" }] }, ada);
    plans.cancel(cancelled.id, ada, "no");
    const active = plans.create(twoSteps, ada);
    const t = taskIn(f, "claimed", "release workflow");
    plans.add(t, active.id, 2, ada);
    expect(plans.list().map((p) => [p.id, p.state])).toEqual([
      [active.id, "active"],
      [done.id, "done"],
      [cancelled.id, "cancelled"],
    ]);
    const text = planText(plans.get(active.id));
    expect(text).toContain("P-0003  active");
    expect(text).toContain("0/2 steps, 0/1 tasks done");
    expect(text).toContain("- 1. Rename  [empty]");
    expect(text).toContain("check: every package is @foreman-kit/*");
    expect(text).toContain("● 2. Release  [in progress]");
    expect(text).toContain(`${t}  claimed`);
    expect(planLine(plans.get(done.id))).toContain("1/1 steps");
    expect(toMarkdown(f.get(t), f.events(t), plans.placement(t))).toContain(`plan: ${active.id}\nplan_step: 2`);
  });

  test("the tables are additive: the schema version stays, so an older foreman still opens the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "foreman-plans-"));
    try {
      const path = join(dir, "foreman.db");
      const db = openDb(path);
      const plans = new Plans(new Foreman(db, null));
      plans.create(twoSteps, ada);
      db.close();
      const raw = new Database(path);
      const v = raw.query(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
      raw.close();
      expect(Number(v.value)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(1); // what every foreman before plans knows
      const again = openDb(path);
      expect(new Plans(new Foreman(again, null)).list().map((p) => p.id)).toEqual(["P-0001"]);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
