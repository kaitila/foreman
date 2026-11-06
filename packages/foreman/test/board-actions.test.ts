// The board's writes (T-0067, D0021): approve, merge and run-queue behind the same token,
// Origin and Host checks; merge and run-queue are one merge-queue pass through a fake gh;
// and the page's controls, shortcuts and styles.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ago, nextAction, pageHtml, prNumber, SHORTCUTS } from "../src/board/page";
import { type Board, startBoard } from "../src/board/server";
import { type Actor, Foreman } from "../src/core";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
const ok = (name: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });
const failing = (name: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE" });

/** A fake GitHub: per PR, its branch, head commit, mergeability and checks. */
function fakeGitHub() {
  const prs = new Map<string, { head: string; sha: string; mergeable: string; checks: object[]; merged: boolean }>();
  const calls: string[][] = [];
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: (pr) => {
      const p = prs.get(pr);
      return p ? { head: p.head, headSha: p.sha, mergeable: p.mergeable } : null;
    },
    originRepo: () => "acme/app",
  };
  const run = (cmd: string[]) => {
    calls.push(cmd);
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
  return { prs, calls, policy, run };
}
type GH = ReturnType<typeof fakeGitHub>;

/** A verified task: `auto` lands in approved, `review` waits for a person. */
function verifiedTask(f: Foreman, gh: GH, n: number, checks: object[], risk: "auto" | "review" = "auto") {
  const branch = `t-${n}`;
  gh.prs.set(PR(n), { head: branch, sha: `sha${n}aaaaaaaa`, mergeable: "MERGEABLE", checks, merged: false });
  const t = f.create({ title: `task ${n}`, acceptance: ["cmd: true"], paths: ["src/**"], ready: true, risk }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { branch });
  f.submit(t.id, worker, { pr: PR(n) });
  f.startVerify(t.id, verifier);
  f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
  return t.id;
}

let gh: GH;
let f: Foreman;
let board: Board;
let green: string;
let red: string;
let waiting: string;
let release: (() => void) | null = null;
let hold = false;

const post = (path: string, headers: Record<string, string> = {}) => fetch(board.url + path, { method: "POST", headers });
const auth = () => ({ "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port}` });

beforeAll(() => {
  gh = fakeGitHub();
  let clock = 1;
  f = new Foreman(openDb(":memory:"), null, () => ++clock, gh.policy);
  green = verifiedTask(f, gh, 1, [ok("check"), ok("docs")]);
  red = verifiedTask(f, gh, 2, [ok("check"), failing("e2e")]);
  waiting = verifiedTask(f, gh, 3, [ok("check")], "review");
  expect(f.get(green).status).toBe("approved");
  expect(f.get(waiting).status).toBe("needs_approval");
  board = startBoard({
    foreman: f,
    port: 0,
    approver: human,
    prCacheMs: 0,
    queue: {
      run: gh.run,
      cwd: "/repo",
      settleSeconds: 0,
      // A test can hold the pass in its settle wait, to send a second request meanwhile.
      sleep: () => (hold ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
    },
  });
});

afterAll(async () => {
  await board.stop();
});

describe("the token comes in the fragment, never from the server", () => {
  test("the link carries it after #t=; the page and the API never do", async () => {
    expect(board.openUrl).toBe(`${board.url}/#t=${board.token}`);
    for (const path of ["/", "/api/tasks", `/api/tasks/${green}`, `/api/tasks/${green}/pr`, "/api/events"]) {
      expect(await (await fetch(board.url + path)).text()).not.toContain(board.token!);
    }
    for (const r of [await post(`/api/tasks/${waiting}/approve`, {}), await post("/api/queue/run", { "x-foreman-token": "0".repeat(64) })]) {
      expect(await r.text()).not.toContain(board.token!);
    }
  });

  test("the page takes it from location.hash into sessionStorage, clears the address bar and sends the header", async () => {
    const html = await (await fetch(`${board.url}/`)).text();
    expect(html).toContain("location.hash");
    expect(html).toContain("sessionStorage.setItem");
    expect(html).toContain("history.replaceState");
    expect(html).toContain('"x-foreman-token": token');
  });

  test("a read-only board has no token in its link", async () => {
    const g = startBoard({ foreman: f, port: 0, approver: null });
    try {
      expect(g.token).toBeNull();
      expect(g.openUrl).toBe(`${g.url}/`);
    } finally {
      await g.stop();
    }
  });
});

describe("every write is refused without the token, with a wrong one, cross-origin and with a wrong Host", () => {
  const writes = () => [`/api/tasks/${waiting}/approve`, `/api/tasks/${green}/merge`, "/api/queue/run"];

  test("no token, a wrong token, a short token: 403", async () => {
    for (const path of writes()) {
      expect((await post(path)).status).toBe(403);
      expect((await post(path, { "x-foreman-token": "0".repeat(64) })).status).toBe(403);
      expect((await post(path, { "x-foreman-token": "short" })).status).toBe(403);
    }
  });

  test("the right token from another origin: 403", async () => {
    for (const path of writes()) {
      const r = await post(path, { "x-foreman-token": board.token!, origin: "http://evil.example" });
      expect(r.status).toBe(403);
      expect((await r.json()).message).toContain("cross-origin");
      expect((await post(path, { "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port + 1}` })).status).toBe(403);
    }
  });

  test("the right token with another Host (DNS rebinding): 421", async () => {
    for (const path of writes()) {
      expect((await post(path, { "x-foreman-token": board.token!, host: "evil.example" })).status).toBe(421);
    }
  });

  test("nothing changed and gh was never asked to merge", () => {
    expect(f.get(waiting).status).toBe("needs_approval");
    expect(f.get(green).status).toBe("approved");
    expect(gh.calls.filter((c) => c[2] === "merge")).toEqual([]);
  });

  test("a board without an approver refuses merge and run-queue too", async () => {
    const g = startBoard({ foreman: f, port: 0, approver: null, queue: { run: gh.run, settleSeconds: 0 } });
    try {
      for (const path of [`/api/tasks/${green}/merge`, "/api/queue/run"]) {
        const r = await fetch(g.url + path, { method: "POST", headers: { "x-foreman-token": board.token! } });
        expect(r.status).toBe(403);
      }
    } finally {
      await g.stop();
    }
  });
});

describe("approve, merge and run queue with the token", () => {
  test("the PR state for a card: checks, mergeable, and whether it is still the verified commit", async () => {
    const g = await (await fetch(`${board.url}/api/tasks/${green}/pr`)).json();
    expect(g).toMatchObject({ readable: true, mergeable: "MERGEABLE", atVerified: true, checks: { kind: "green" } });
    const r = await (await fetch(`${board.url}/api/tasks/${red}/pr`)).json();
    expect(r.checks.kind).toBe("red");
    expect(r.checks.reason).toContain("e2e");
  });

  test("approve succeeds", async () => {
    const r = await post(`/api/tasks/${waiting}/approve`, auth());
    expect(r.status).toBe(200);
    expect(f.get(waiting).status).toBe("approved");
  });

  test("merge: a red PR is skipped with its reason, and stays approved", async () => {
    const r = await post(`/api/tasks/${red}/merge`, auth());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.entry).toMatchObject({ id: red, action: "skipped" });
    expect(body.entry.reason).toContain("failing: e2e (FAILURE)");
    expect(body.entries).toHaveLength(1);
    expect(f.get(red).status).toBe("approved");
  });

  test("merge: an approved, green, verified PR merges, pinned to the verified commit; only that task", async () => {
    const before = gh.calls.length;
    const r = await post(`/api/tasks/${green}/merge`, auth());
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.entry).toMatchObject({ id: green, action: "merged", pr: PR(1) });
    expect(body.task.status).toBe("done");
    expect(f.get(green).status).toBe("done");
    const merges = gh.calls.slice(before).filter((c) => c[2] === "merge");
    expect(merges).toEqual([["gh", "pr", "merge", PR(1), "--merge", "--delete-branch", "--match-head-commit", "sha1aaaaaaaa"]]);
    // Only the asked-for task's PR was read: red (#2) and waiting (#3) were left alone.
    expect(gh.calls.slice(before).every((c) => c[3] === PR(1))).toBe(true);
    expect(gh.prs.get(PR(2))!.merged).toBe(false);
  });

  test("merge: a task that isn't approved is 409, and unknown is 404", async () => {
    expect((await post(`/api/tasks/${green}/merge`, auth())).status).toBe(409);
    expect((await post("/api/tasks/T-9999/merge", auth())).status).toBe(404);
  });

  test("merge: a PR that conflicts with main is sent back to ready", async () => {
    const id = verifiedTask(f, gh, 4, [ok("check")]);
    gh.prs.get(PR(4))!.mergeable = "CONFLICTING";
    const body = await (await post(`/api/tasks/${id}/merge`, auth())).json();
    expect(body.entry.action).toBe("sent_back");
    expect(f.get(id).status).toBe("ready");
  });

  test("run queue: one pass over every approved task, at most one merge", async () => {
    // Approved now: red (#2, failing) and waiting (#3, green). Fix #2 so both could merge.
    gh.prs.get(PR(2))!.checks = [ok("check")];
    const body = await (await post("/api/queue/run", auth())).json();
    const merged = body.entries.filter((e: { action: string }) => e.action === "merged");
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(red); // oldest first
    expect(f.get(waiting).status).toBe("approved");
    const again = await (await post("/api/queue/run", auth())).json();
    expect(again.entries.map((e: { id: string; action: string }) => [e.id, e.action])).toEqual([[waiting, "merged"]]);
    expect((await (await post("/api/queue/run", auth())).json()).entries).toEqual([]);
  });

  test("one pass at a time: a merge while a pass is running is 409 busy", async () => {
    const id = verifiedTask(f, gh, 5, [ok("check")]);
    hold = true;
    const first = post(`/api/tasks/${id}/merge`, auth());
    for (let i = 0; i < 50 && !release; i++) await Bun.sleep(10);
    expect(release).not.toBeNull();
    const second = await post("/api/queue/run", auth());
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("busy");
    hold = false;
    release!();
    expect((await (await first).json()).entry.action).toBe("merged");
  });
});

describe("the page", () => {
  test("each state's next action: Approve, Merge #n, or what it waits for", () => {
    const t = (status: string, pr: string | null = null, assignee: string | null = null) => ({ id: "T-1", status, pr, assignee });
    expect(nextAction(t("needs_approval"), true, false)).toEqual({ kind: "approve", label: "Approve" });
    expect(nextAction(t("approved", PR(344)), true, false)).toEqual({ kind: "merge", label: "Merge #344" });
    expect(nextAction(t("approved", "https://example.com/pull/12"), true, false).kind).toBe("wait");
    expect(nextAction(t("in_review"), true, false)).toEqual({ kind: "wait", label: "waiting for verifier" });
    expect(nextAction(t("in_progress", null, "worker-1"), true, false).label).toBe("with worker-1");
    expect(nextAction(t("done"), true, false).kind).toBe("none");
    // Without the token the buttons show, disabled, with a hint; read-only says so.
    expect(nextAction(t("needs_approval"), false, false)).toEqual({ kind: "approve", label: "Approve", disabled: "open the link fm serve printed" });
    expect(nextAction(t("approved", PR(7)), false, true).disabled).toBe("read-only board");
  });

  test("PR numbers and relative times", () => {
    expect(prNumber(PR(48))).toBe("#48");
    expect(prNumber("#48")).toBe("");
    expect(prNumber(null)).toBe("");
    const now = 10_000_000_000;
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 d ago");
  });

  test("the served page has the Approve, Merge, Approve all and Run queue controls, with the shortcuts", async () => {
    const html = await (await fetch(`${board.url}/`)).text();
    for (const s of ['"Approve"', '"Merge " + n', '"Approve all "', '"Run queue"', '"btn " + (strong ? a.kind : "quiet")']) expect(html).toContain(s);
    // The same functions the tests above call run in the page.
    expect(html).toContain("function nextAction(t, canAct, readOnly)");
    for (const [k] of SHORTCUTS) expect(html).toContain(JSON.stringify(k));
    for (const k of ['e.key === "a"', 'e.key === "m"', 'e.key === "j"', 'e.key === "k"', 'e.key === "/"', 'e.key === "?"']) expect(html).toContain(k);
    expect(html).toContain('id="filter"');
  });

  test("styled scroll bars, light and dark colours, lanes that snap, no external assets", () => {
    const html = pageHtml("n0nce", { lanes: [], tasks: [], lastEvent: 0, canApprove: false });
    expect(html).toContain("scrollbar-width:thin");
    expect(html).toContain("scrollbar-color:var(--thumb) transparent");
    expect(html).toContain("::-webkit-scrollbar{");
    expect(html).toContain("::-webkit-scrollbar-thumb{");
    expect(html).toContain("main:hover::-webkit-scrollbar-thumb");
    expect(html).toContain("scroll-snap-type:x");
    expect(html).toMatch(/:root\{--paper:#[0-9a-f]{6}/);
    expect(html).toMatch(/@media \(prefers-color-scheme:dark\)\{:root\{--paper:#[0-9a-f]{6}/);
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toContain("@import");
    expect(html).not.toContain("url(http");
  });
});
