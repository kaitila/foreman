// The board's Plans view (T-0097): plans and their progress from the plans core, read-only,
// a plan's steps in order with their check, state and tasks, and a task's plan and step.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Board, placement, startBoard } from "../src/board/server";
import { pageHtml, SHORTCUTS } from "../src/board/page";
import { type Actor, Foreman } from "../src/core";
import { DEFAULT_PROTECTED } from "../src/policy";
import { Plans } from "../src/plans";
import { openDb } from "../src/store";

const ada: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const EVIL = "</script><script>alert(1)</script>";

let f: Foreman;
let board: Board;
const ids = {} as Record<"rename" | "docs" | "release" | "loose" | "done" | "gone", string>;
const planIds = {} as Record<"publish" | "finished" | "dropped" | "evil", string>;

const api = (path: string) => fetch(board.url + path).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

/** Merged, by the shortest legal route. */
function finish(id: string) {
  f.claim(id, worker);
  f.submit(id, worker, { pr: "https://example.com/pull/1" });
  f.startVerify(id, verifier);
  f.recordVerify(id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
  if (f.get(id).status === "needs_approval") f.approve(id, ada);
  f.merged(id, ada);
}

beforeAll(() => {
  let clock = 1_000_000;
  f = new Foreman(openDb(":memory:"), null, () => (clock += 1000), { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => [] });
  const plans = new Plans(f, () => clock);
  const task = (title: string, plan: string | null, step = 1) =>
    plans.createTask({ title, acceptance: ["cmd: true"], risk: "auto", ready: true }, plan ? { plan, step } : null, ada).id;

  // An active plan: step 1 in progress (one done, one claimed), step 2 waiting, step 3 empty.
  planIds.publish = plans.create({
    title: "Publish foreman",
    goal: "Ship it to **npm**, with `fm create`.",
    steps: [
      { title: "Rename", check: "every package is @foreman-kit/*" },
      { title: "Release", check: "a v* tag publishes" },
      { title: "Announce", check: "the README says how to install it" },
    ],
  }, ada).id;
  ids.rename = task("Rename the packages", planIds.publish, 1);
  ids.docs = task("Update the docs", planIds.publish, 1);
  ids.release = task("Release workflow", planIds.publish, 2);
  finish(ids.rename);
  f.claim(ids.docs, worker);

  // A done plan and a cancelled one, which the list puts after the active one.
  planIds.finished = plans.create({ title: "Old work", steps: [{ title: "Only", check: "it is done" }] }, ada).id;
  ids.done = task("Done task", planIds.finished, 1);
  finish(ids.done);
  planIds.dropped = plans.create({ title: "Dropped idea", steps: [{ title: "Try", check: "it works" }] }, ada).id;
  ids.gone = task("Abandoned", planIds.dropped, 1);
  plans.cancel(planIds.dropped, ada, "not needed");
  planIds.evil = plans.create({ title: EVIL, goal: EVIL, steps: [{ title: EVIL, check: EVIL }] }, ada).id;
  ids.loose = task("Not in a plan", null);

  board = startBoard({ foreman: f, port: 0, approver: ada });
});

afterAll(async () => {
  await board.stop();
});

describe("GET /api/plans", () => {
  test("every plan with its progress, active first, then done, then cancelled", async () => {
    const { status, body } = await api("/api/plans");
    expect(status).toBe(200);
    expect(body.plans.map((p: any) => [p.id, p.state])).toEqual([
      [planIds.publish, "active"],
      [planIds.evil, "active"],
      [planIds.finished, "done"],
      [planIds.dropped, "cancelled"],
    ]);
    const p = body.plans[0];
    expect(p.progress).toEqual({ steps: 3, stepsDone: 0, tasks: 3, tasksDone: 1 });
    expect(body.plans[2].progress).toEqual({ steps: 1, stepsDone: 1, tasks: 1, tasksDone: 1 });
    expect(body.plans[3].cancelReason).toBe("not needed");
  });

  test("the same plans on the project-scoped route", async () => {
    const name = (await api("/api/projects")).body.projects[0].name;
    const { body } = await api(`/api/p/${encodeURIComponent(name)}/plans`);
    expect(body.plans.map((p: any) => p.id)).toEqual((await api("/api/plans")).body.plans.map((p: any) => p.id));
  });
});

describe("GET /api/plans/<id>", () => {
  test("the goal, then each step in order with its check, its state and its tasks", async () => {
    const { status, body } = await api(`/api/plans/${planIds.publish}`);
    expect(status).toBe(200);
    const p = body.plan;
    expect(p.goal).toBe("Ship it to **npm**, with `fm create`.");
    expect(p.steps.map((s: any) => [s.n, s.title, s.check, s.state])).toEqual([
      [1, "Rename", "every package is @foreman-kit/*", "in_progress"],
      [2, "Release", "a v* tag publishes", "waiting"],
      [3, "Announce", "the README says how to install it", "empty"],
    ]);
    expect(p.steps[0].tasks.map((t: any) => [t.id, t.status])).toEqual([[ids.rename, "done"], [ids.docs, "claimed"]]);
    expect(p.steps[1].tasks.map((t: any) => t.id)).toEqual([ids.release]);
    expect(p.steps[2].tasks).toEqual([]);
  });

  test("an unknown plan is 404", async () => {
    const r = await api("/api/plans/P-9999");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not_found");
  });

  test("read-only: no write route for plans", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await fetch(`${board.url}/api/plans/${planIds.publish}`, { method });
      expect([403, 405]).toContain(r.status);
    }
    expect(new Plans(f).get(planIds.publish).steps).toHaveLength(3);
  });
});

describe("a task's detail names its plan and step", () => {
  test("placement in /api/tasks/<id>, with the titles and the step's state", async () => {
    const { body } = await api(`/api/tasks/${ids.release}`);
    expect(body.placement).toEqual({
      plan: planIds.publish, planTitle: "Publish foreman", planState: "active", step: 2, stepTitle: "Release", stepState: "waiting",
    });
    expect((await api(`/api/tasks/${ids.loose}`)).body.placement).toBeNull();
    expect(placement(f, ids.docs)).toMatchObject({ plan: planIds.publish, step: 1, stepTitle: "Rename" });
  });

  test("the panel draws a Plan link to the plan and the Step", () => {
    const html = pageHtml("n0nce", { lanes: [], projects: [], canApprove: false });
    expect(html).toContain('prop(dl, "Plan", a)');
    expect(html).toContain('prop(dl, "Step"');
    expect(html).toContain("goToPlan(k.project, pl.plan)");
  });
});

describe("the page", () => {
  test("embeds each project's plans, escaped, for the Plans view", async () => {
    const html = await (await fetch(`${board.url}/`)).text();
    const json = /<script type="application\/json" id="initial">([^]*?)<\/script>/.exec(html)![1]!;
    const initial = JSON.parse(json);
    expect(initial.projects[0].plans.map((p: any) => p.id)).toEqual([planIds.publish, planIds.evil, planIds.finished, planIds.dropped]);
    expect(html).not.toContain(EVIL);
  });

  test("a Plans view in the sidebar, the palette and the keys", () => {
    const html = pageHtml("n0nce", { lanes: [], projects: [], canApprove: false });
    expect(html).toContain('mkView(plansView, "Plans", "plans"');
    expect(html).toContain('{ group: "Go to", label: "Plans", keys: "g p"');
    expect(html).toContain('group: "Plans", label: x.id');
    expect(SHORTCUTS).toContainEqual(["g p", "go to Plans", "Go to"]);
    expect(html).toContain('else if (e.key === "p") setPlans();');
    // Done and cancelled plans start folded; the steps' states have names.
    expect(html).toContain('let planFolded = new Set(["done", "cancelled"]);');
    expect(html).toContain('const STEP_NAMES = { empty: "Empty", waiting: "Waiting", in_progress: "In progress", done: "Done" };');
  });
});

// The view as a browser draws it, when a headless Chromium is at hand (skipped otherwise).
function chromium(): string | null {
  for (const n of ["chromium", "chromium-browser", "google-chrome"]) { const w = Bun.which(n); if (w) return w; }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return null;
  for (const d of readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    for (const sub of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"]) {
      const p = join(cache, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return null;
}
const browser = chromium();

describe.skipIf(!browser)("rendered in a headless browser", () => {
  const dom = async (hash: string) => {
    const p = Bun.spawn([browser!, "--headless", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=3000", "--dump-dom", `${board.url}/${hash}`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    // Only what the view drew, not the embedded state or the palette.
    return /<main class="content" id="content">([^]*?)<\/main>/.exec(out)?.[1] ?? "";
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

  test("#plans lists the plans with their progress, done and cancelled folded", async () => {
    const t = text(await dom("#plans"));
    expect(t).toContain("Publish foreman");
    expect(t).toContain("0 of 3 steps · 1 of 3 tasks");
    expect(t).toContain("Done 1");
    expect(t).toContain("Cancelled 1");
    expect(t).not.toContain("Old work"); // folded
  }, 20_000);

  test("#plan=<id> shows the goal, the steps in order with check and state, and their tasks as rows", async () => {
    const html = await dom(`#plan=${planIds.publish}`);
    const t = text(html);
    expect(t).toContain("Ship it to **npm**, with fm create .");
    const at = (s: string) => t.indexOf(s);
    expect(at("1. Rename")).toBeGreaterThan(-1);
    expect(at("1. Rename")).toBeLessThan(at("2. Release"));
    expect(at("2. Release")).toBeLessThan(at("3. Announce"));
    expect(t).toContain("Check every package is @foreman-kit/*");
    expect(t).toMatch(/1\. Rename In progress 2/);
    expect(t).toMatch(/2\. Release Waiting 1/);
    expect(t).toMatch(/3\. Announce Empty 0/);
    // Each task is a normal task row (keyed project/id), which opens the task panel.
    for (const id of [ids.rename, ids.docs, ids.release]) expect(html).toMatch(new RegExp(`class="row[^"]*" data-id="[^"]*/${id}"`));
    expect(at("Rename the packages")).toBeLessThan(at("2. Release"));
    expect(at("Release workflow")).toBeGreaterThan(at("2. Release"));
    expect(t).not.toContain("Not in a plan");
  }, 20_000);
});
