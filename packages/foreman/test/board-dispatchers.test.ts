// The board shows the running dispatchers (T-0116): its state carries them from the registry
// (D0041), the page draws a strip with slots, starter and linked tasks, or one quiet line with
// the command to start one, and nothing on the board starts or stops a dispatcher.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Board, dispatcherCard, startBoard } from "../src/board/server";
import { pageHtml, starterText } from "../src/board/page";
import { type Actor, Foreman } from "../src/core";
import { registerDispatcher, runningDispatchers, touchDispatcher, unregisterDispatcher } from "../src/dispatchers";
import { Plans } from "../src/plans";
import { DEFAULT_PROTECTED } from "../src/policy";
import { openDb } from "../src/store";

const ada: Actor = { name: "ada", kind: "human" };
const EVIL = "</script><script>alert(1)</script>";

// Fake PIDs: a dispatcher "runs" while its pid is in here.
const alive = new Set<number>();
const NOW = Date.now();
const foreman = () => new Foreman(openDb(":memory:"), null, () => NOW, { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => [] }, (pid) => alive.has(pid));

let busy: Foreman;
let idle: Foreman;
let board: Board;
const ids = {} as Record<"a" | "b" | "c" | "s1" | "s2" | "o1", string>;
// Two active plans in `busy` (T-0120): `ship` with a ready task in step 1 and one in step 2, `other` with one ready task; `dropped` is cancelled.
const planIds = {} as Record<"ship" | "other" | "dropped", string>;

const api = (path: string) => fetch(board.url + path).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const record = (pid: number, over: Partial<Parameters<typeof registerDispatcher>[1]> = {}) => ({
  pid,
  max: 3,
  flags: { once: false, verifyOnly: false, print: false },
  starter: { name: "ada", kind: "human" as const },
  cwd: "/repo",
  startedAt: NOW - 5 * 60_000,
  ...over,
});
/** The dispatcher the page tests look at: 2 of 3 slots, --once, on tasks a and b. */
function start(pid = 7001) {
  alive.add(pid);
  registerDispatcher(busy, record(pid, { flags: { once: true, verifyOnly: false, print: true } }));
  touchDispatcher(busy, pid, [
    { task: ids.a, role: "worker", pid: 9001, session: "bg9001", sessionId: "sid-9001" },
    { task: ids.b, role: "verifier", pid: 9002 },
  ], NOW - 1000);
}
function stopAll() {
  for (const d of runningDispatchers(busy)) unregisterDispatcher(busy, d.pid);
  alive.clear();
}

beforeAll(() => {
  busy = foreman();
  idle = foreman();
  const add = (f: Foreman, title: string) => f.create({ title, acceptance: ["cmd: true"], risk: "auto", ready: true }, ada).id;
  ids.a = add(busy, "First task");
  ids.b = add(busy, "Second task");
  ids.c = add(idle, "Nobody works on this");
  const plans = new Plans(busy);
  const planned = (title: string, plan: string, step: number) =>
    plans.createTask({ title, acceptance: ["cmd: true"], risk: "auto", ready: true, paths: [`src/${title.replace(/ /g, "-")}/**`] }, { plan, step }, ada).id;
  planIds.ship = plans.create({ title: "Ship the importer", steps: [{ title: "Build", check: "it imports a file" }, { title: "Release", check: "a tag publishes" }] }, ada).id;
  ids.s1 = planned("Write the importer", planIds.ship, 1);
  ids.s2 = planned("Tag the release", planIds.ship, 2);
  planIds.other = plans.create({ title: "Tidy the docs", steps: [{ title: "Only", check: "the docs build" }] }, ada).id;
  ids.o1 = planned("Fix the links", planIds.other, 1);
  planIds.dropped = plans.create({ title: "Dropped idea", steps: [{ title: "Try", check: "it works" }] }, ada).id;
  planned("Abandoned", planIds.dropped, 1);
  plans.cancel(planIds.dropped, ada, "not needed");
  board = startBoard({
    projects: [{ name: "busy", foreman: busy }, { name: "idle", foreman: idle }],
    port: 0,
    approver: ada,
    labels: { get: () => null, set: () => {} },
  });
});

afterAll(async () => {
  await board.stop();
});

describe("the board's state carries the running dispatchers", () => {
  test("none running: an empty list", async () => {
    stopAll();
    expect((await api("/api/tasks")).body.dispatchers).toEqual([]);
    expect((await api("/api/p/idle/tasks")).body.dispatchers).toEqual([]);
  });

  test("a running dispatcher with its scope, max, flags, starter and the tasks in flight, and none after it is gone", async () => {
    stopAll();
    start();
    const { status, body } = await api("/api/tasks");
    expect(status).toBe(200);
    expect(body.dispatchers).toEqual([
      {
        pid: 7001,
        scope: "everything",
        max: 3,
        flags: { once: true, verifyOnly: false },
        starter: { name: "ada", kind: "human" },
        startedAt: NOW - 5 * 60_000,
        lastSeen: NOW - 1000,
        sessions: [{ task: ids.a, role: "worker" }, { task: ids.b, role: "verifier" }],
      },
    ]);
    // Per project: the other project's state has none.
    expect((await api("/api/p/busy/tasks")).body.dispatchers).toHaveLength(1);
    expect((await api("/api/p/idle/tasks")).body.dispatchers).toEqual([]);

    // It exits cleanly (its record removed): gone from the next read.
    unregisterDispatcher(busy, 7001);
    expect((await api("/api/tasks")).body.dispatchers).toEqual([]);

    // Or it is killed (the record stays, the process doesn't): gone too, and the record with it.
    start(7002);
    expect((await api("/api/tasks")).body.dispatchers.map((d: any) => d.pid)).toEqual([7002]);
    alive.delete(7002);
    expect((await api("/api/tasks")).body.dispatchers).toEqual([]);
    expect(busy.db.query(`SELECT count(*) AS n FROM dispatchers`).get()).toEqual({ n: 0 });
  });

  test("the poll carries them too, since starting or exiting writes no event", async () => {
    stopAll();
    const last = (await api("/api/tasks")).body.lastEvent;
    start();
    const poll = (await api(`/api/events?since=${last}`)).body;
    expect(poll.events).toEqual([]);
    expect(poll.dispatchers.map((d: any) => [d.pid, d.sessions.length, d.max])).toEqual([[7001, 2, 3]]);
    alive.delete(7001);
    expect((await api(`/api/p/busy/events?since=${last}`)).body.dispatchers).toEqual([]);
  });

  test("an agent's dispatcher names its session; verify-only shows; several come oldest first", async () => {
    stopAll();
    alive.add(7003).add(7004);
    registerDispatcher(busy, record(7004, { startedAt: NOW - 60_000, max: 1, flags: { once: false, verifyOnly: true, print: false } }));
    registerDispatcher(busy, record(7003, { startedAt: NOW - 120_000, starter: { name: "worker-T-0009", kind: "agent", session: "0934d487-aaaa-bbbb-cccc-000000000000" } }));
    const ds = (await api("/api/tasks")).body.dispatchers;
    expect(ds.map((d: any) => d.pid)).toEqual([7003, 7004]);
    expect(ds[0].starter).toEqual({ name: "worker-T-0009", kind: "agent", session: "0934d487-aaaa-bbbb-cccc-000000000000" });
    expect(ds[0].sessions).toEqual([]);
    expect(ds[1].flags).toEqual({ once: false, verifyOnly: true });
  });

  test("the card leaves out the working directory and the sessions' pids and ids", () => {
    stopAll();
    start();
    const card = dispatcherCard(runningDispatchers(busy)[0]!);
    expect(Object.keys(card).sort()).toEqual(["flags", "lastSeen", "max", "pid", "scope", "sessions", "startedAt", "starter"]);
    expect(card.sessions.map((s) => Object.keys(s).sort())).toEqual([["role", "task"], ["role", "task"]]);
    expect(JSON.stringify(card)).not.toContain("/repo");
  });

  test("read-only: nothing on the board starts or stops a dispatcher", async () => {
    stopAll();
    start();
    for (const path of ["/api/dispatchers", "/api/dispatch", "/api/dispatchers/7001", "/api/p/busy/dispatchers"]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const r = await fetch(board.url + path, { method, headers: { "x-foreman-token": board.token! } });
        expect([404, 405]).toContain(r.status);
      }
    }
    expect(runningDispatchers(busy).map((d) => d.pid)).toEqual([7001]);
  });
});

// T-0120: which plans a dispatcher covers, and the ready tasks none would start (D0045).
describe("the API says which dispatcher covers a plan, and which ready tasks nothing covers", () => {
  const planOf = async (id: string) => (await api(`/api/plans/${id}`)).body.plan;
  const waits = async () => new Map<string, any>((await api("/api/tasks")).body.tasks.map((t: any) => [t.id, t.wait]));
  /** A dispatcher for these plans, with one session, on the first plan's first task. */
  const forPlans = (pid: number, plans: string[], over: Partial<Parameters<typeof registerDispatcher>[1]> = {}) => {
    alive.add(pid);
    registerDispatcher(busy, record(pid, { scope: plans.join(","), ...over }));
    touchDispatcher(busy, pid, [{ task: ids.s1, role: "worker", pid: 9003 }], NOW - 1000);
  };

  test("none running: every plan's ready tasks are uncovered, and each carries the no-dispatcher reason", async () => {
    stopAll();
    expect((await planOf(planIds.ship)).dispatch).toEqual({ dispatchers: [], uncovered: [ids.s1] });
    expect((await planOf(planIds.other)).dispatch).toEqual({ dispatchers: [], uncovered: [ids.o1] });
    const w = await waits();
    // The task itself can start: the reason is the whole answer, and the path ends at the task.
    for (const id of [ids.s1, ids.o1, ids.a]) {
      expect(w.get(id)).toMatchObject({ reason: { kind: "no dispatcher" }, end: null, depth: 0, on: [] });
      expect(w.get(id).leaves).toEqual([{ task: id, status: "ready", kind: "no dispatcher", text: `${id} is picked up (can start, but no dispatcher covers it)` }]);
    }
    // A task that waits on it isn't uncovered itself: its path ends in the no-dispatcher leaf.
    expect(w.get(ids.s2)).toMatchObject({ reason: { kind: "step", step: 1 }, end: { task: ids.s1, kind: "no dispatcher" } });
    // The panel's tree ends the same way.
    const { waiting } = (await api(`/api/tasks/${ids.s2}`)).body;
    expect(waiting.path.root.children.map((c: any) => [c.task, c.end.kind])).toEqual([[ids.s1, "no dispatcher"]]);
  });

  test("a plan's dispatcher covers that plan only: which one, its slots, and that it starts new work", async () => {
    stopAll();
    forPlans(7010, [planIds.ship]);
    expect((await planOf(planIds.ship)).dispatch).toEqual({
      dispatchers: [{ pid: 7010, scope: planIds.ship, max: 3, inUse: 1, flags: { once: false, verifyOnly: false }, starter: { name: "ada", kind: "human" }, starts: true }],
      uncovered: [],
    });
    expect((await planOf(planIds.other)).dispatch).toEqual({ dispatchers: [], uncovered: [ids.o1] });
    // The list carries the same, and a plan that isn't active has none.
    const list = (await api("/api/plans")).body.plans;
    expect(list.map((p: any) => [p.id, p.dispatch && p.dispatch.dispatchers.map((d: any) => d.pid), p.dispatch && p.dispatch.uncovered])).toEqual([
      [planIds.ship, [7010], []],
      [planIds.other, [], [ids.o1]],
      [planIds.dropped, null, null],
    ]);
    const w = await waits();
    expect(w.get(ids.s1)).toBeNull();
    expect(w.get(ids.s2)).toMatchObject({ reason: { kind: "step" }, end: { task: ids.s1, kind: "can start" } });
    // Outside its scope: the other plan's task, and a task in no plan.
    expect(w.get(ids.o1).reason).toEqual({ kind: "no dispatcher" });
    expect(w.get(ids.a).reason).toEqual({ kind: "no dispatcher" });
  });

  test("the whole-board dispatcher covers every plan and every task", async () => {
    stopAll();
    start(7011);
    // --once: it covers the plans, but starts nothing after its first pass.
    for (const [plan, task] of [[planIds.ship, ids.s1], [planIds.other, ids.o1]] as const) {
      const d = (await planOf(plan)).dispatch;
      expect(d.dispatchers.map((x: any) => [x.pid, x.scope, x.inUse, x.max, x.starts])).toEqual([[7011, "everything", 2, 3, false]]);
      expect(d.uncovered).toEqual([task]);
    }
    stopAll();
    alive.add(7012);
    registerDispatcher(busy, record(7012));
    expect((await planOf(planIds.other)).dispatch).toMatchObject({ dispatchers: [{ pid: 7012, scope: "everything", starts: true }], uncovered: [] });
    const w = await waits();
    for (const id of [ids.s1, ids.o1, ids.a]) expect(w.get(id)).toBeNull();
  });

  test("a verify-only dispatcher covers the plan but starts no new work: its ready task is still uncovered", async () => {
    stopAll();
    forPlans(7013, [planIds.ship, planIds.other], { flags: { once: false, verifyOnly: true, print: false } });
    const d = (await planOf(planIds.ship)).dispatch;
    expect(d.dispatchers).toMatchObject([{ pid: 7013, scope: `${planIds.ship},${planIds.other}`, flags: { verifyOnly: true }, starts: false }]);
    expect(d.uncovered).toEqual([ids.s1]);
    expect((await waits()).get(ids.s1).reason).toEqual({ kind: "no dispatcher" });
  });
});

describe("who started it", () => {
  test("the person by name; an agent by its session id, shortened; an agent with no session by name", () => {
    expect(starterText({ name: "ada", kind: "human" })).toBe("ada");
    expect(starterText({ name: "ada", kind: "human", session: "0934d487-aaaa" })).toBe("ada");
    expect(starterText({ name: "worker-T-0009", kind: "agent", session: "0934d487-aaaa-bbbb" })).toBe("session 0934d487");
    expect(starterText({ name: "worker-T-0009", kind: "agent" })).toBe("worker-T-0009");
  });
});

describe("the page", () => {
  test("embeds each project's dispatchers, escaped", async () => {
    stopAll();
    alive.add(7005);
    registerDispatcher(busy, record(7005, { starter: { name: EVIL, kind: "human" }, scope: EVIL }));
    const html = await (await fetch(`${board.url}/`)).text();
    const initial = JSON.parse(/<script type="application\/json" id="initial">([^]*?)<\/script>/.exec(html)![1]!);
    expect(initial.projects.map((p: any) => [p.name, p.dispatchers.length])).toEqual([["busy", 1], ["idle", 0]]);
    expect(initial.projects[0].dispatchers[0].starter.name).toBe(EVIL);
    expect(html).not.toContain(EVIL);
  });

  test("has the strip between the notice and the content, and no control that starts or stops one", () => {
    const html = pageHtml("n0nce", { lanes: [], projects: [], canApprove: false });
    expect(html).toMatch(/<p class="notice" id="notice" hidden><\/p>\s*<section class="dstrip" id="dispatchers" aria-label="Dispatchers"><\/section>\s*<main class="content"/);
    expect(html).toContain('el("code", "", "fm dispatch")');
    expect(html).toContain("renderDispatchers(now);");
    // The poll picks up a dispatcher that started or exited without an event, and reads everything
    // again: which tasks and plans it covers moved with it.
    expect(html).toContain("if (changed || moved) await refresh();");
    // The strip and the sidebar marker are text and links only.
    const strip = /function dispatcherLine[^]*?\n\/\/ The sidebar:/.exec(html)![0];
    expect(strip).not.toMatch(/el\("button"|post\(/);
    // Nor does a plan: its header and its marker in the Plans list are text too.
    const cover = /const startCmd[^]*?\nfunction renderPlans/.exec(html)![0];
    expect(cover).toContain('"fm dispatch --plan " + p.id');
    expect(cover).not.toMatch(/el\("button"|post\(/);
  });
});

// The strip as a browser draws it, when a headless Chromium is at hand (skipped otherwise).
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
const FLAGS = ["--headless", "--no-sandbox", "--disable-gpu", "--virtual-time-budget=3000", "--dump-dom"];
// Only a browser that runs a page's script and prints its DOM in time counts (CI's may not).
function works(path: string | null): string | null {
  if (!path) return null;
  const r = Bun.spawnSync([path, ...FLAGS, 'data:text/html,<body><script>document.body.textContent="probe-ok"</script>'], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
  return r.stdout.toString().includes("probe-ok") ? path : null;
}
const browser = works(chromium());

// Phone and desktop width, light and dark (Blink's preferredColorScheme: 0 is dark, 1 light).
const SCREENS = [
  ["phone, light", 390, 1],
  ["phone, dark", 390, 0],
  ["desktop, light", 1280, 1],
  ["desktop, dark", 1280, 0],
] as const;

describe.skipIf(!browser)("rendered in a headless browser", () => {
  const dom = async (hash: string, width: number, scheme: number) => {
    const p = Bun.spawn([browser!, ...FLAGS, `--window-size=${width},844`, `--blink-settings=preferredColorScheme=${scheme}`, `${board.url}/${hash}`], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const content = /<main class="content" id="content">([^]*?)<\/main>/.exec(out)?.[1] ?? "";
    return {
      strip: /<section class="dstrip[^>]*>([^]*?)<\/section>/.exec(out)?.[0] ?? "",
      nav: /<nav class="nav" id="projects"[^>]*>([^]*?)<\/nav>/.exec(out)?.[1] ?? "",
      content,
      panel: /<aside id="detail"[^>]*>([^]*?)<\/aside>/.exec(out)?.[1] ?? "",
      /** The plan view's header lines about dispatchers, as markup. */
      planDisp: /<div class="plan-disp">[^]*?<\/div>/.exec(content)?.[0] ?? "",
      /** One task's or plan's row, as markup. */
      row: (id: string) => new RegExp(`<div class="row[^"]*" data-id="[^"]*/${id}"[^]*?(?=<div class="row|</section>)`).exec(content)?.[0] ?? "",
    };
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

  test.each(SCREENS)("%s: a running dispatcher shows its slots, flags, starter, age and linked tasks", async (_name, width, scheme) => {
    stopAll();
    start();
    const { strip, nav } = await dom("#p=busy", width, scheme);
    const t = text(strip);
    expect(t).toBe(`Dispatcher everything 2 of 3 slots once by ada started 5 min ago ${ids.a} worker ${ids.b} verifier`);
    expect(strip).not.toContain('class="dstrip none"');
    // Each task its sessions are on is a link to that task.
    for (const id of [ids.a, ids.b]) expect(strip).toMatch(new RegExp(`<a class="disp-task" href="#p=busy&amp;${id}"`));
    // The sidebar marks the project that has one, with its slots, and not the other.
    expect(nav).toMatch(/data-project="busy"[^]*?class="disp-mark" title="A dispatcher is running: 2 of 3 slots in use"[^]*?data-project="idle"/);
    expect(nav.slice(nav.indexOf('data-project="idle"'))).not.toContain("disp-mark");
  }, 20_000);

  test.each(SCREENS)("%s: none running is one quiet line with the command to start one", async (_name, width, scheme) => {
    stopAll();
    start();
    const idleView = await dom("#p=idle", width, scheme);
    expect(idleView.strip).toContain('class="dstrip none"');
    expect(text(idleView.strip)).toBe("No dispatcher is running in idle, so no new session will start. Start one from the terminal: fm dispatch");
    expect(idleView.strip).toContain("<code>fm dispatch</code>");
    expect(idleView.strip).not.toMatch(/<button|<a /);

    stopAll();
    const all = await dom("", width, scheme);
    expect(text(all.strip)).toBe("No dispatcher is running, so no new session will start. Start one from the terminal: fm dispatch");
    expect(all.nav).not.toContain("disp-mark");
  }, 20_000);

  test("every project's dispatchers in the All view, each with its project", async () => {
    stopAll();
    start();
    alive.add(7006);
    registerDispatcher(idle, record(7006, { max: 1, flags: { once: false, verifyOnly: true, print: false }, starter: { name: "worker-T-0009", kind: "agent", session: "0934d487-aaaa-bbbb" }, startedAt: NOW - 2 * 3_600_000 }));
    const t = text((await dom("", 1280, 1)).strip);
    expect(t).toBe(
      `Dispatcher busy everything 2 of 3 slots once by ada started 5 min ago ${ids.a} worker ${ids.b} verifier ` +
        "Dispatcher idle everything 0 of 1 slots verify only by session 0934d487 started 2 h ago nothing in flight",
    );
    unregisterDispatcher(idle, 7006);
  }, 20_000);

  /** A dispatcher for these plans with one session, on the first step's task (T-0120). */
  const planDispatcher = (pid: number, plans: string[]) => {
    alive.add(pid);
    registerDispatcher(busy, record(pid, { scope: plans.join(",") }));
    touchDispatcher(busy, pid, [{ task: ids.s1, role: "worker", pid: 9003 }], NOW - 1000);
  };

  test.each(SCREENS)("%s: the strip links a plan dispatcher to each of its plans", async (_name, width, scheme) => {
    stopAll();
    planDispatcher(7020, [planIds.ship, planIds.other]);
    const { strip } = await dom("#p=busy", width, scheme);
    expect(text(strip)).toBe(`Dispatcher ${planIds.ship} , ${planIds.other} 1 of 3 slots by ada started 5 min ago ${ids.s1} worker`);
    for (const id of [planIds.ship, planIds.other]) expect(strip).toMatch(new RegExp(`<a class="disp-plan id" href="#p=busy&amp;plan=${id}" title="Plan ${id} `));
    expect(strip).not.toContain("everything");
  }, 20_000);

  test.each(SCREENS)("%s: a plan's header names the dispatcher that covers it, with its slots", async (_name, width, scheme) => {
    stopAll();
    planDispatcher(7021, [planIds.ship]);
    const d = await dom(`#p=busy&plan=${planIds.ship}`, width, scheme);
    expect(text(d.planDisp)).toBe("Dispatcher for this plan 1 of 3 slots by ada");
    expect(d.planDisp).toContain('data-pid="7021"');
    expect(d.planDisp).not.toMatch(/<button|fm dispatch/);
    // Its ready task is one the dispatcher will start: plain "can start".
    expect(d.row(ids.s1)).toContain('<span class="waits free"');
    expect(text(d.row(ids.s2))).toContain(`waits on step 1 ← ${ids.s1} can start`);
    expect(text(d.content)).not.toContain("no dispatcher");
    // The other plan isn't covered by it: its header says so, with the command.
    const other = await dom(`#p=busy&plan=${planIds.other}`, width, scheme);
    expect(text(other.planDisp)).toBe(`No dispatcher running for this plan. 1 ready task can start, and nothing will pick it up. Start one from the terminal: fm dispatch --plan ${planIds.other}`);
  }, 30_000);

  test.each(SCREENS)("%s: with none running the header gives the start command, and the tasks say they can start", async (_name, width, scheme) => {
    stopAll();
    const d = await dom(`#p=busy&plan=${planIds.ship}`, width, scheme);
    expect(text(d.planDisp)).toBe(`No dispatcher running for this plan. 1 ready task can start, and nothing will pick it up. Start one from the terminal: fm dispatch --plan ${planIds.ship}`);
    expect(d.planDisp).toContain(`<code>fm dispatch --plan ${planIds.ship}</code>`);
    expect(d.planDisp).not.toMatch(/<button|<a |class="dot"/);
    // The task row: worded from the task's side, in the faint "can start" style, not as a blocker.
    const row = d.row(ids.s1);
    expect(row).toContain('<span class="waits free nodisp"');
    expect(text(row)).toContain("can start: no dispatcher covers it");
    expect(text(row)).not.toContain("waits on");
    expect(row).toContain(`aria-label="${ids.s1} Write the importer, Ready, can start: no dispatcher covers it, holds up 1"`);
    // A task that waits on it names where its path ends, and how.
    expect(text(d.row(ids.s2))).toContain(`waits on step 1 ← ${ids.s1} can start, no dispatcher`);
    expect(d.row(ids.s2)).not.toMatch(/waits-end (you|stuck)/);
  }, 20_000);

  test("the Plans list marks each plan: the slots of the dispatcher that covers it, or that none does", async () => {
    stopAll();
    planDispatcher(7022, [planIds.ship]);
    const d = await dom("#p=busy&plans", 1280, 1);
    const ship = d.row(planIds.ship), other = d.row(planIds.other);
    expect(ship).toMatch(/<span class="plan-cover" title="A dispatcher covers this plan: 1 of 3 slots in use"><span class="disp-mark">/);
    expect(ship).not.toContain("plan-nodisp");
    expect(other).toContain(`title="1 ready task can start, but no running dispatcher would start it: fm dispatch --plan ${planIds.other}"`);
    expect(other).toContain('<span class="plan-nodisp">no dispatcher</span>');
    expect(other).not.toContain("disp-mark");
    expect(ship).toContain(`aria-label="${planIds.ship} Ship the importer, Active, 0 of 2 steps · 0 of 2 tasks, A dispatcher covers this plan: 1 of 3 slots in use"`);
  }, 20_000);

  test("the path tree ends in a no-dispatcher leaf that says the task can start", async () => {
    stopAll();
    const { panel } = await dom(`#p=busy&${ids.s2}`, 1280, 1);
    const ws = /<section class="section waits-on">[^]*?<\/section>/.exec(panel)?.[0] ?? "";
    expect(text(ws)).toContain(`Can start, no dispatcher moves when ${ids.s1} is picked up (can start, but no dispatcher covers it)`);
    expect(ws).toContain('<div class="wt-end free">');
  }, 20_000);

  // BOARD_SHOTS=<dir> also saves a screenshot of each state at each width and scheme, to look at.
  test.skipIf(!process.env.BOARD_SHOTS)("screenshots: plans and their dispatchers", async () => {
    const states = [
      ["plan-covered", `#p=busy&plan=${planIds.ship}`, () => { planDispatcher(7023, [planIds.ship, planIds.other]); }],
      ["plan-none", `#p=busy&plan=${planIds.ship}`, () => {}],
      ["plans-list", "#p=busy&plans", () => { planDispatcher(7024, [planIds.ship]); }],
      ["tree", `#p=busy&${ids.s2}`, () => {}],
    ] as const;
    for (const [state, hash, setup] of states) {
      stopAll();
      setup();
      for (const [name, width, scheme] of SCREENS) {
        const png = join(process.env.BOARD_SHOTS!, `coverage-${state}-${name.replace(", ", "-")}.png`);
        await Bun.spawn([browser!, ...FLAGS.filter((x) => x !== "--dump-dom"), `--window-size=${width},800`, `--blink-settings=preferredColorScheme=${scheme}`, `--screenshot=${png}`, `${board.url}/${hash}`], { stdout: "ignore", stderr: "ignore", timeout: 15_000 }).exited;
        expect(existsSync(png)).toBe(true);
      }
    }
  }, 120_000);

  test.skipIf(!process.env.BOARD_SHOTS)("screenshots", async () => {
    stopAll();
    start();
    alive.add(7007);
    registerDispatcher(busy, record(7007, { max: 1, flags: { once: false, verifyOnly: true, print: false }, starter: { name: "worker-T-0009", kind: "agent", session: "0934d487-aaaa-bbbb" }, startedAt: NOW - 2 * 3_600_000 }));
    for (const [state, hash] of [["running", "#p=busy"], ["none", "#p=idle"], ["all", ""]] as const) {
      for (const [name, width, scheme] of SCREENS) {
        const png = join(process.env.BOARD_SHOTS!, `dispatchers-${state}-${name.replace(", ", "-")}.png`);
        // Not spawnSync: the board answers from this process.
        await Bun.spawn([browser!, ...FLAGS.filter((x) => x !== "--dump-dom"), `--window-size=${width},700`, `--blink-settings=preferredColorScheme=${scheme}`, `--screenshot=${png}`, `${board.url}/${hash}`], { stdout: "ignore", stderr: "ignore", timeout: 15_000 }).exited;
        expect(existsSync(png)).toBe(true);
      }
    }
  }, 120_000);
});
