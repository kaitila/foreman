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
const ids = {} as Record<"a" | "b" | "c", string>;

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
    // The poll picks up a dispatcher that started or exited without an event.
    expect(html).toContain("else if (moved) { nav(); renderDispatchers(Date.now()); }");
    // The strip and the sidebar marker are text and links only.
    const strip = /function dispatcherLine[^]*?\n\/\/ The sidebar:/.exec(html)![0];
    expect(strip).not.toMatch(/el\("button"|post\(/);
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
    return {
      strip: /<section class="dstrip[^>]*>([^]*?)<\/section>/.exec(out)?.[0] ?? "",
      nav: /<nav class="nav" id="projects"[^>]*>([^]*?)<\/nav>/.exec(out)?.[1] ?? "",
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

  // BOARD_SHOTS=<dir> also saves a screenshot of each state at each width and scheme, to look at.
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
