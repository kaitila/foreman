// The board shows why a task waits and what it holds up (T-0118): the short form on every
// row, the whole path as a tree and the downstream list in the panel, and the plan view's
// step line and highlight. All of it is read from waiting.ts (D0042), never worked out in the page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Board, startBoard } from "../src/board/server";
import { pageHtml } from "../src/board/page";
import { type Actor, Foreman } from "../src/core";
import { registerDispatcher } from "../src/dispatchers";
import { DEFAULT_PROTECTED } from "../src/policy";
import { Plans } from "../src/plans";
import { openDb } from "../src/store";

const ada: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };

let f: Foreman;
let board: Board;
let plan: string;
const ids = {} as Record<"a" | "b" | "c" | "deep" | "sign" | "after" | "free" | "overlap" | "byHand" | "plain" | "s1" | "s2", string>;

const api = (path: string) => fetch(board.url + path).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

/** Verified and waiting for a person. */
function toApproval(id: string) {
  f.claim(id, worker);
  f.submit(id, worker, { pr: "https://example.com/pull/1" });
  f.startVerify(id, verifier);
  f.recordVerify(id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
  expect(f.get(id).status).toBe("needs_approval");
}

beforeAll(() => {
  let clock = 1_000_000;
  f = new Foreman(openDb(":memory:"), null, () => (clock += 1000), { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => [] }, (pid) => pid === 7100);
  // A whole-board dispatcher runs, so a free task is one it will start: what a task shows when
  // none covers it is in board-dispatchers.test.ts (T-0120).
  registerDispatcher(f, { pid: 7100, max: 3, flags: { once: false, verifyOnly: false, print: false }, starter: { name: "ada", kind: "human" }, cwd: "/repo", startedAt: clock });
  // Every task names its own files: tasks with no paths overlap everything in flight.
  const task = (title: string, dir: string, more: Partial<Parameters<Foreman["create"]>[0]> = {}) =>
    f.create({ title, acceptance: ["cmd: true"], risk: "auto", ready: true, paths: [`src/${dir}/**`], ...more }, ada).id;

  // A chain three deep: c waits on b, b on a, and a is being worked on.
  ids.a = task("Parse the config", "a");
  ids.b = task("Load the plugins", "b", { blockedBy: [ids.a] });
  ids.c = task("Run the plugins", "c", { blockedBy: [ids.b] });
  // One more level, and a draft: it needs a person itself as well as its path.
  ids.deep = task("Document the plugins", "deep", { blockedBy: [ids.c], ready: false });
  // A path that ends at the person: its blocker needs approval.
  ids.sign = task("Change the schema", "sign", { risk: "review" });
  ids.after = task("Backfill the column", "after", { blockedBy: [ids.sign] });
  ids.free = task("Fix a typo", "free");
  // Its files are inside a's, which is in flight.
  ids.overlap = task("Tidy the parser", "a", { paths: ["src/a/parser.ts", "docs/parser.md"] });
  ids.byHand = task("Rotate the key", "hand", { risk: "human" });
  ids.plain = task("Someday", "plain", { ready: false });

  const plans = new Plans(f, () => clock);
  plan = plans.create({ title: "Ship the importer", steps: [{ title: "Build", check: "it imports a file" }, { title: "Release", check: "a tag publishes" }] }, ada).id;
  const planned = (title: string, dir: string, step: number, risk: "auto" | "review") =>
    plans.createTask({ title, acceptance: ["cmd: true"], risk, ready: true, paths: [`src/${dir}/**`] }, { plan, step }, ada).id;
  ids.s1 = planned("Write the importer", "s1", 1, "review");
  ids.s2 = planned("Tag the release", "s2", 2, "auto");

  f.claim(ids.a, worker);
  toApproval(ids.sign);
  toApproval(ids.s1);
  board = startBoard({ foreman: f, port: 0, approver: ada });
});

afterAll(async () => {
  await board.stop();
});

describe("/api/tasks/<id>: the whole path and everything downstream", () => {
  test("the last task of a chain three deep has every task on its path, and a leaf with its kind", async () => {
    const { body } = await api(`/api/tasks/${ids.c}`);
    const { path } = body.waiting;
    expect(path.root.task).toBe(ids.c);
    expect(path.root.via).toBeNull();
    const b = path.root.children[0];
    expect(path.root.children).toHaveLength(1);
    expect([b.task, b.title, b.status, b.via]).toEqual([ids.b, "Load the plugins", "ready", { kind: "blocked", task: ids.b, status: "ready" }]);
    // b isn't where the path stops: it waits too.
    expect(b.end).toBeUndefined();
    const a = b.children[0];
    expect([a.task, a.status, a.via.kind, a.children]).toEqual([ids.a, "claimed", "blocked", []]);
    expect(a.end).toMatchObject({ task: ids.a, kind: "running", actor: "worker-1" });
    expect(path.leaves.map((l: any) => [l.task, l.kind])).toEqual([[ids.a, "running"]]);
    expect(path.depth).toBe(2);
    expect(path.summary).toStartWith(`moves when: ${ids.a} is finished by worker-1`);
  });

  test("the first task has the full downstream list, the direct ones first", async () => {
    const { body } = await api(`/api/tasks/${ids.a}`);
    const held = body.waiting.holdsUp;
    expect(held.count).toBe(4);
    // b is blocked by it and overlap's paths cross it; c and deep are reached through b.
    expect(held.tasks.map((t: any) => [t.id, t.direct])).toEqual([[ids.b, true], [ids.overlap, true], [ids.c, false], [ids.deep, false]]);
    expect(held.tasks[2]).toMatchObject({ title: "Run the plugins", status: "ready" });
    // It is in flight itself: nothing to wait on but its own worker.
    expect(body.waiting.path.root.children).toEqual([]);
  });

  test("a draft four tasks from the end: the path goes all the way, and the draft is a leaf of its own", async () => {
    const { path } = (await api(`/api/tasks/${ids.deep}`)).body.waiting;
    expect(path.depth).toBe(3);
    const chain: string[] = [];
    for (let n = path.root; n; n = n.children[0]) chain.push(n.task);
    expect(chain).toEqual([ids.deep, ids.c, ids.b, ids.a]);
    expect(path.root.end).toMatchObject({ kind: "needs a person" });
    expect(path.leaves.map((l: any) => [l.task, l.kind])).toEqual([[ids.a, "running"], [ids.deep, "needs a person"]]);
  });

  test("an overlap names the globs that cross", async () => {
    const { path } = (await api(`/api/tasks/${ids.overlap}`)).body.waiting;
    const n = path.root.children[0];
    expect(n.task).toBe(ids.a);
    expect(n.via).toEqual({ kind: "paths", task: ids.a, status: "claimed", globs: ["src/a/parser.ts"] });
  });

  test("a task with nothing to wait on has a one-node path and holds nothing up", async () => {
    const { waiting } = (await api(`/api/tasks/${ids.free}`)).body;
    expect(waiting.path.root.children).toEqual([]);
    expect(waiting.path.leaves.map((l: any) => l.kind)).toEqual(["can start"]);
    expect(waiting.holdsUp).toEqual({ count: 0, tasks: [] });
  });
});

describe("/api/tasks: the short form on every task", () => {
  let byId: Map<string, any>;
  beforeAll(async () => {
    byId = new Map((await api("/api/tasks")).body.tasks.map((t: any) => [t.id, t]));
  });

  test("a waiting task has its first direct reason, where the path ends, the leaves and the depth", () => {
    const c = byId.get(ids.c);
    expect(c.wait.reason).toEqual({ kind: "blocked", task: ids.b, status: "ready" });
    expect(c.wait.end).toMatchObject({ task: ids.a, status: "claimed", kind: "running" });
    expect(c.wait.leaves).toHaveLength(1);
    expect(c.wait.depth).toBe(2);
    expect(c.wait.on).toEqual([ids.b, ids.a]);
    expect(c.wait.summary).toStartWith("moves when: ");
    // The whole chain as text, for the marker's title.
    expect(c.wait.chain.split("\n").map((l: string) => l.trim().split(" ")[0])).toEqual([ids.c, ids.b, ids.a]);
  });

  test("a path that ends at the person says so", () => {
    expect(byId.get(ids.after).wait.end).toMatchObject({ task: ids.sign, status: "needs_approval", kind: "needs a person" });
    const s2 = byId.get(ids.s2).wait;
    expect(s2.reason).toMatchObject({ kind: "step", plan, step: 1, tasks: [ids.s1] });
    expect(s2.end).toMatchObject({ task: ids.s1, kind: "needs a person" });
    // Risk human: the reason is the person, and the path ends at the task itself.
    expect(byId.get(ids.byHand).wait).toMatchObject({ reason: { kind: "human" }, end: null, depth: 0 });
  });

  test("a task that can start, a plain draft and a task in flight have none", () => {
    for (const id of [ids.free, ids.plain, ids.a, ids.sign]) expect(byId.get(id).wait).toBeNull();
  });

  test("the count of tasks each one holds up, with the indirect ones", () => {
    expect(byId.get(ids.a).holds).toEqual({ count: 4, tasks: [ids.b, ids.c, ids.deep, ids.overlap] });
    expect(byId.get(ids.b).holds.count).toBe(2);
    expect(byId.get(ids.sign).holds).toEqual({ count: 1, tasks: [ids.after] });
    expect(byId.get(ids.s1).holds).toEqual({ count: 1, tasks: [ids.s2] });
    expect(byId.get(ids.free).holds).toEqual({ count: 0, tasks: [] });
  });
});

describe("/api/plans: a step says which earlier step it waits on", () => {
  test("with that step's unfinished tasks; a step that waits on none has an empty list", async () => {
    const p = (await api(`/api/plans/${plan}`)).body.plan;
    expect(p.steps.map((s: any) => s.waits)).toEqual([[], [{ step: 1, title: "Build", tasks: [ids.s1] }]]);
    const listed = (await api("/api/plans")).body.plans.find((x: any) => x.id === plan);
    expect(listed.steps[1].waits).toEqual(p.steps[1].waits);
  });
});

describe("the page", () => {
  const html = pageHtml("n0nce", { lanes: [], projects: [], canApprove: false });

  test("every inline script still parses", () => {
    const scripts = [...html.matchAll(/<script nonce="n0nce">([^]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  test("words what the server sent and works nothing out: no blockedBy, no step rule", () => {
    const js = /<script nonce="n0nce">([^]*?)<\/script>/.exec(html)![1]!;
    expect(js).not.toContain("blockedBy");
    expect(js).toContain("function waitsTag(t)");
    expect(js).toContain("function pathTree(project, nodes)");
    expect(js).toContain("function markPath()");
    // The tree and the lists are text and links: nothing here writes.
    const part = /function leafLine[^]*?\/\/ On the board the panel floats/.exec(js)![0];
    expect(part).not.toMatch(/el\("button"|post\(|innerHTML/);
  });

  test("the tree stops indenting past eight levels, and wraps at phone width", () => {
    const css = /<style nonce="n0nce">([^]*?)<\/style>/.exec(html)![1]!;
    expect(css).toContain(".wt .wt .wt .wt .wt .wt .wt .wt .wt { margin-left: 0; padding-left: 0; border-left: 0; }");
    const phone = css.slice(css.indexOf("@media (max-width: 48em)"));
    // On a phone the marker moves from the action slot to its own line under the title, and wraps.
    expect(phone).toContain(".row .side .waits { display: none; }");
    expect(phone).toContain(".row .sub .waits { flex: 1 0 100%; white-space: normal; overflow-wrap: anywhere; }");
    for (const sel of [".wt-title", ".wt-via", ".wt-end", ".moves"]) expect(css).toMatch(new RegExp(`\\${sel}[^{]*\\{[^}]*overflow-wrap: anywhere`));
  });
});

// The page as a browser draws it, when a headless Chromium is at hand (skipped otherwise).
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
  const dom = async (hash: string, width = 1280, scheme = 1) => {
    const p = Bun.spawn([browser!, ...FLAGS, `--window-size=${width},844`, `--blink-settings=preferredColorScheme=${scheme}`, `${board.url}/${hash}`], { stdout: "pipe", stderr: "ignore", timeout: 15_000 });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const content = /<main class="content" id="content">([^]*?)<\/main>/.exec(out)?.[1] ?? "";
    return {
      content,
      panel: /<aside id="detail"[^>]*>([^]*?)<\/aside>/.exec(out)?.[1] ?? "",
      /** One task's row, as markup. */
      row: (id: string) => new RegExp(`<div class="row[^"]*" data-id="[^"]*/${id}"[^]*?(?=<div class="row|</section>)`).exec(content)?.[0] ?? "",
    };
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
  const section = (panel: string, cls: string) => new RegExp(`<section class="section ${cls}">[^]*?</section>`).exec(panel)?.[0] ?? "";

  test.each(SCREENS)("%s: a blocked task's row names the direct blocker and the end of its path; its panel has the tree", async (_name, width, scheme) => {
    const d = await dom(`#${ids.c}`, width, scheme);
    const row = d.row(ids.c);
    expect(text(row)).toContain(`waits on ${ids.b} ← ${ids.a} claimed`);
    // The whole chain is in the marker's title.
    const title = /<span class="waits" title="([^"]*)"/.exec(row)![1]!;
    for (const id of [ids.c, ids.b, ids.a]) expect(title).toContain(id);
    expect(title).toContain("moves when:");

    const ws = section(d.panel, "waits-on");
    expect(text(ws)).toStartWith(`Waits on 2 deep Moves when: ${ids.a} is finished by worker-1`);
    // One row per task on the path, nested, each id a link to that task.
    expect(ws).toMatch(new RegExp(`<li class="wt-node" data-task="${ids.b}">[^]*<ul class="wt"><li class="wt-node" data-task="${ids.a}">`));
    for (const id of [ids.b, ids.a]) expect(ws).toMatch(new RegExp(`<a class="id tlink" href="#${id}"`));
    const t = text(ws);
    expect(t).toContain(`blocked by ${ids.b} Load the plugins Ready`);
    expect(t).toContain(`blocked by ${ids.a} Parse the config Claimed`);
    // The leaf says who has to act, and links to the running session's task.
    expect(t).toMatch(new RegExp(`Running moves when ${ids.a} is finished by worker-1 \\(claimed, [a-z ]+\\) its activity`));
    expect(ws).toMatch(new RegExp(`<a class="wt-act" href="#${ids.a}"`));
  }, 20_000);

  test.each(SCREENS)("%s: a task that blocks others shows how many, and its panel lists the indirect ones too", async (_name, width, scheme) => {
    const d = await dom(`#${ids.a}`, width, scheme);
    expect(text(d.row(ids.a))).toContain("holds up 4");
    expect(text(d.row(ids.b))).toContain("holds up 2");
    expect(d.row(ids.free)).not.toContain('class="holds"');
    const hs = section(d.panel, "holds-up");
    expect(text(hs)).toBe(`Holds up 4 ${ids.b} Load the plugins ${ids.overlap} Tidy the parser ${ids.c} Run the plugins through others ${ids.deep} Document the plugins through others`);
    for (const id of [ids.b, ids.overlap, ids.c, ids.deep]) expect(hs).toMatch(new RegExp(`<a class="id tlink" href="#${id}"`));
    // It is in flight: no Waits on section of its own.
    expect(section(d.panel, "waits-on")).toBe("");
  }, 20_000);

  test("what needs the person is marked amber with the dot; a free task reads as startable", async () => {
    const d = await dom("");
    const after = d.row(ids.after);
    expect(text(after)).toContain(`waits on ${ids.sign} needs your approval`);
    expect(after).toMatch(/<span class="waits-end you"><span class="attn-dot"><\/span>/);
    const s2 = d.row(ids.s2);
    expect(text(s2)).toContain(`waits on step 1 ← ${ids.s1} needs your approval`);
    expect(s2).toContain('class="waits-end you"');
    expect(text(d.row(ids.byHand))).toContain("waits on you: a person does it");
    expect(text(d.row(ids.overlap))).toContain(`waits on paths of ${ids.a} claimed`);
    // A running end isn't amber.
    expect(d.row(ids.c)).not.toContain("waits-end you");
    expect(d.row(ids.free)).toContain('<span class="waits free"');
    expect(text(d.row(ids.free))).toContain("can start");
    // A plain draft and a task in flight have no marker.
    for (const id of [ids.plain, ids.a]) expect(d.row(id)).not.toContain('class="waits');
  }, 20_000);

  test("a draft with a path: the panel says what the task itself needs, then the tree down to the end", async () => {
    const d = await dom(`#${ids.deep}`);
    const ws = section(d.panel, "waits-on");
    const t = text(ws);
    expect(t).toStartWith(`Waits on 3 deep Moves when: ${ids.a} is finished by worker-1`);
    expect(t).toContain(`this task Needs you moves when ${ids.deep} is marked ready (a draft)`);
    expect(ws).toMatch(/<div class="wt-end you"><span class="attn-dot"><\/span><strong>Needs you<\/strong>/);
    const order = [ids.c, ids.b, ids.a].map((id) => ws.indexOf(`data-task="${id}"`));
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  }, 20_000);

  test("an overlap's row in the tree names the glob", async () => {
    const ws = section((await dom(`#${ids.overlap}`)).panel, "waits-on");
    expect(ws).toContain('<span class="wt-via">overlapping paths: <code>src/a/parser.ts</code></span>');
  }, 20_000);

  test("the plan view: a step names the step it waits on, and the focused task lights up its path", async () => {
    const d = await dom(`#plan=${plan}&${ids.s2}`);
    expect(text(d.content)).toContain(`Waits on step 1, Build: ${ids.s1}`);
    expect(d.content).toMatch(new RegExp(`<p class="step-check step-waits">[^]*?<a class="id tlink" href="#${ids.s1}"`));
    // s2 has the focus: s1 is on its path.
    expect(d.row(ids.s1)).toMatch(/^<div class="row[^"]* hl-on"/);
    expect(text(d.row(ids.s1))).toContain(`${ids.s2} waits on this`);
    expect(d.row(ids.s2)).not.toMatch(/hl-on|hl-held/);
    // And the other way round: s1 holds s2 up.
    const back = await dom(`#plan=${plan}&${ids.s1}`);
    expect(back.row(ids.s2)).toMatch(/^<div class="row[^"]* hl-held"/);
    expect(text(back.row(ids.s2))).toContain(`waits on ${ids.s1}`);
  }, 30_000);

  // BOARD_SHOTS=<dir> also saves a screenshot of each state at each width and scheme, to look at.
  test.skipIf(!process.env.BOARD_SHOTS)("screenshots", async () => {
    for (const [state, hash] of [["list", ""], ["panel-waits", `#${ids.deep}`], ["panel-holds", `#${ids.a}`], ["plan", `#plan=${plan}&${ids.s2}`]] as const) {
      for (const [name, width, scheme] of SCREENS) {
        const png = join(process.env.BOARD_SHOTS!, `waiting-${state}-${name.replace(", ", "-")}.png`);
        // Not spawnSync: the board answers from this process.
        await Bun.spawn([browser!, ...FLAGS.filter((x) => x !== "--dump-dom"), `--window-size=${width},1100`, `--blink-settings=preferredColorScheme=${scheme}`, `--screenshot=${png}`, `${board.url}/${hash}`], { stdout: "ignore", stderr: "ignore", timeout: 15_000 }).exited;
        expect(existsSync(png)).toBe(true);
      }
    }
  }, 240_000);
});
