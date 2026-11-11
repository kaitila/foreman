import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { approvalUndone, LANES, startBoard, type Board } from "../src/board/server";
import { type Actor, type Event, Foreman } from "../src/core";
import type { Policy } from "../src/policy";
import { DEFAULT_PROTECTED } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const EVIL = "</script><script>alert(1)</script>";

function setup() {
  let clock = 1_000_000;
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/feature.ts"] };
  const f = new Foreman(openDb(":memory:"), null, () => (clock += 1000), policy);
  return f;
}

/** A review-risk task that a verifier passed, waiting for a person. Check c1 failed once, then passed. */
function waitingTask(f: Foreman, title = "Add a stage filter") {
  const t = f.create({ title, acceptance: ["cmd: bun test", "statement: the filter shows"], ready: true, risk: "review" }, human);
  f.claim(t.id, worker);
  f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
  f.startVerify(t.id, verifier);
  f.recordVerify(t.id, verifier, [
    { check: "c1", pass: false, evidence: "2 tests fail" },
    { check: "c2", pass: true, evidence: "first look ok" },
  ]);
  f.claim(t.id, worker);
  f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
  f.startVerify(t.id, verifier);
  f.recordVerify(t.id, verifier, [
    { check: "c1", pass: true, evidence: "40 pass" },
    { check: "c2", pass: true, evidence: "seen on the page" },
  ]);
  expect(f.get(t.id).status).toBe("needs_approval");
  return t.id;
}

let f: Foreman;
let board: Board;
let waiting: string;
let draft: string;
let evil: string;

const get = (path: string, headers: Record<string, string> = {}) => fetch(board.url + path, { headers });
const approve = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${board.url}/api/tasks/${id}/approve`, { method: "POST", headers });

beforeAll(() => {
  f = setup();
  draft = f.create({ title: "Write the guide", acceptance: ["statement: it exists"], ready: false }, human).id;
  waiting = waitingTask(f);
  evil = f.create({ title: EVIL, acceptance: ["statement: escaped"], ready: true }, human).id;
  board = startBoard({ foreman: f, port: 0, approver: human });
});

afterAll(async () => {
  await board.stop();
});

describe("listing", () => {
  test("lanes are the ten statuses in order, and tasks carry their status", async () => {
    expect(LANES).toEqual([
      "draft", "ready", "claimed", "in_progress", "in_review", "verifying", "needs_approval", "approved", "done", "cancelled",
    ]);
    const r = await get("/api/tasks");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.lanes).toEqual(LANES);
    expect(body.canApprove).toBe(true);
    const byId = Object.fromEntries(body.tasks.map((t: { id: string; status: string }) => [t.id, t]));
    expect(byId[draft].status).toBe("draft");
    expect(byId[waiting].status).toBe("needs_approval");
    expect(byId[evil].status).toBe("ready");
    expect(Object.keys(byId[waiting]).sort()).toEqual(["assignee", "holds", "id", "live", "pr", "risk", "status", "title", "undone", "updatedAt", "wait"]);
    // Nothing waits on it and it waits on nothing: the short form is empty (T-0118, board-waiting.test.ts).
    expect([byId[waiting].wait, byId[waiting].holds]).toEqual([null, { count: 0, tasks: [] }]);
    expect(body.lastEvent).toBe(f.events().at(-1)!.id);
  });

  test("detail has the task, each check with its latest verdict, and the events", async () => {
    const r = await get(`/api/tasks/${waiting}`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.task.id).toBe(waiting);
    expect(body.checks.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);
    expect(body.checks[0].verdict).toMatchObject({ pass: true, evidence: "40 pass", by: "verifier-1" });
    expect(body.checks[1].verdict).toMatchObject({ pass: true, evidence: "seen on the page" });
    expect(body.events.map((e: { type: string }) => e.type)).toContain("verify_failed");
    expect(body.events.every((e: { taskId: string }) => e.taskId === waiting)).toBe(true);

    const d = await (await get(`/api/tasks/${draft}`)).json();
    expect(d.checks[0].verdict).toBeNull();
  });

  test("events?since returns only newer events", async () => {
    const all = f.events();
    const since = all[all.length - 3]!.id;
    const body = await (await get(`/api/events?since=${since}`)).json();
    expect(body.events.map((e: { id: number }) => e.id)).toEqual(all.slice(-2).map((e) => e.id));
    expect(body.lastEvent).toBe(all.at(-1)!.id);

    const none = await (await get(`/api/events?since=${all.at(-1)!.id}`)).json();
    expect(none.events).toEqual([]);
    expect(none.lastEvent).toBe(all.at(-1)!.id);

    const fromStart = await (await get("/api/events")).json();
    expect(fromStart.events.length).toBe(all.length);
  });

  test("unknown task is 404", async () => {
    const r = await get("/api/tasks/T-9999");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("not_found");
    expect((await approve("T-9999", { "x-foreman-token": board.token! })).status).toBe(404);
  });
});

describe("page", () => {
  test("every inline script on the served page parses (T-0078)", async () => {
    const html = await (await get("/")).text();
    const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const code = blocks.filter((m) => !/type="application\/json"/.test(m[1]!)).map((m) => m[2]!);
    const data = blocks.filter((m) => /type="application\/json"/.test(m[1]!)).map((m) => m[2]!);
    expect(code.length).toBeGreaterThan(0);
    for (const c of code) expect(() => new Function(c)).not.toThrow();
    for (const d of data) expect(() => JSON.parse(d)).not.toThrow();
  });

  test("a string with a raw newline would fail that check", () => {
    expect(() => new Function('const s = ["a", "b"].join("\n");')).toThrow();
  });

  test("escapes a title that tries to close the script", async () => {
    const html = await (await get("/")).text();
    expect(html).not.toContain(EVIL);
    expect(html).not.toContain("alert(1)</script>");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
  });

  test("CSP nonce matches the page's script and style, with the other headers", async () => {
    const r = await get("/");
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    const html = await r.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");

    const again = (await get("/")).headers.get("content-security-policy")!;
    expect(again).not.toBe(csp);
  });

  test("JSON responses carry the security headers too", async () => {
    const r = await get("/api/tasks");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the token never appears in the page or the API", async () => {
    expect(board.token).toMatch(/^[0-9a-f]{64}$/);
    for (const path of ["/", "/api/tasks", `/api/tasks/${waiting}`, "/api/events"]) {
      expect(await (await get(path)).text()).not.toContain(board.token!);
    }
  });
});

describe("requests", () => {
  test("a Host other than ours is 421", async () => {
    const r = await get("/api/tasks", { host: "evil.example:80" });
    expect(r.status).toBe(421);
    expect((await approve(waiting, { host: "evil.example", "x-foreman-token": board.token! })).status).toBe(421);
    expect((await get("/api/tasks", { host: `localhost:${board.port}` })).status).toBe(200);
  });

  test("other methods and paths are 405", async () => {
    expect((await fetch(`${board.url}/api/tasks`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${board.url}/api/tasks/${waiting}`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${board.url}/api/tasks/${waiting}/approve`, { method: "PUT" })).status).toBe(405);
  });
});

describe("approve", () => {
  test("refused without the token, with a wrong one, and cross-origin", async () => {
    const noToken = await approve(waiting);
    expect(noToken.status).toBe(403);
    expect((await approve(waiting, { "x-foreman-token": "0".repeat(64) })).status).toBe(403);
    expect((await approve(waiting, { "x-foreman-token": "short" })).status).toBe(403);
    const cross = await approve(waiting, { "x-foreman-token": board.token!, origin: "http://evil.example" });
    expect(cross.status).toBe(403);
    expect((await cross.json()).message).toContain("cross-origin");
    expect(
      (await approve(waiting, { "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port + 1}` })).status,
    ).toBe(403);
    expect(f.get(waiting).status).toBe("needs_approval");
  });

  test("accepted with the token from our own origin, as a person", async () => {
    const r = await approve(waiting, { "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port}` });
    expect(r.status).toBe(200);
    expect((await r.json()).task.status).toBe("approved");
    expect(f.get(waiting).status).toBe("approved");
    const ev = f.events(waiting).filter((e) => e.type === "approved");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.actor).toBe("ada");
    expect(ev[0]!.actorKind).toBe("human");
  });

  test("approving a task that isn't waiting is 409", async () => {
    const r = await approve(draft, { "x-foreman-token": board.token! });
    expect(r.status).toBe(409);
  });

  test("a board started without an approver has no token and refuses approve", async () => {
    const g = setup();
    const id = waitingTask(g);
    const ro = startBoard({ foreman: g, port: 0, approver: null });
    try {
      expect(ro.token).toBeNull();
      const state = await (await fetch(`${ro.url}/api/tasks`)).json();
      expect(state.canApprove).toBe(false);
      const r = await fetch(`${ro.url}/api/tasks/${id}/approve`, {
        method: "POST",
        headers: { "x-foreman-token": board.token! },
      });
      expect(r.status).toBe(403);
      expect(g.get(id).status).toBe("needs_approval");
    } finally {
      await ro.stop();
    }
  });
});

describe("an undone approval is flagged (T-0094)", () => {
  let n = 0;
  const ev = (type: string, actor: Actor, data: Record<string, unknown> = {}): Event => {
    n += 1;
    return { id: n, taskId: "T-0001", at: 5000 + n, actor: actor.name, actorKind: actor.kind, type, data };
  };
  const queueActor: Actor = { name: "merge-queue", kind: "agent" };

  test("a rework of an approved task is flagged with who, what kind and why", () => {
    const events = [ev("submitted", worker), ev("approved", human), ev("rework", worker, { reason: "one more thing", was: "approved" })];
    expect(approvalUndone(events)).toEqual({ by: "worker-1", byKind: "agent", at: events[2]!.at, reason: "one more thing", conflict: false });
  });

  test("the merge queue's conflict send-back is flagged as a conflict", () => {
    const events = [ev("approved", human), ev("rework", queueActor, { reason: "conflicts with main", was: "approved", conflict: true })];
    expect(approvalUndone(events)).toMatchObject({ by: "merge-queue", conflict: true, reason: "conflicts with main" });
  });

  test("a later approval, merge or cancel clears it", () => {
    for (const after of ["approved", "merged", "cancelled"]) {
      const events = [ev("approved", human), ev("rework", human, { reason: "x", was: "approved" }), ev(after, human)];
      expect(approvalUndone(events)).toBeNull();
    }
  });

  test("a rework of a task that wasn't approved isn't flagged; no events is null", () => {
    expect(approvalUndone([ev("rework", worker, { reason: "gap", was: "needs_approval" })])).toBeNull();
    expect(approvalUndone([ev("rework", worker, { reason: "gap", was: "in_review" })])).toBeNull();
    expect(approvalUndone([])).toBeNull();
  });

  test("only a person's approval counts: undoing an auto approval isn't flagged", () => {
    // risk auto: foreman approves by itself, with no approved event
    expect(approvalUndone([ev("submitted", worker), ev("verified", verifier), ev("rework", worker, { reason: "gap", was: "approved" })])).toBeNull();
    // an approved event by an agent doesn't count either
    expect(approvalUndone([ev("approved", verifier), ev("rework", worker, { reason: "gap", was: "approved" })])).toBeNull();
    // a person's approval of an earlier submission doesn't carry over to the next one
    expect(approvalUndone([ev("approved", human), ev("submitted", worker), ev("rework", worker, { reason: "gap", was: "approved" })])).toBeNull();
    // the same rework after a person's approval is flagged
    expect(approvalUndone([ev("submitted", worker), ev("approved", human), ev("rework", worker, { reason: "gap", was: "approved" })])).toMatchObject({ by: "worker-1", byKind: "agent" });
  });

  test("/api/tasks: a task approved again has undone null, even when the events alone would flag it", async () => {
    // Escalated for a protected file, a person approves, then sends it back; the next diff is
    // ordinary, so foreman approves it by itself (no approved event).
    let changed = ["foreman.json"];
    const g = new Foreman(openDb(":memory:"), null, (() => { let c = 1_000_000; return () => (c += 1000); })(), {
      protectedPaths: DEFAULT_PROTECTED, changedFiles: () => changed,
    });
    const t = g.create({ title: "Auto task", acceptance: ["cmd: bun test"], ready: true, risk: "auto" }, human);
    const round = () => {
      g.claim(t.id, worker);
      g.submit(t.id, worker, { pr: "https://example.com/pull/3" });
      g.startVerify(t.id, verifier);
      return g.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status;
    };
    expect(round()).toBe("needs_approval");
    g.approve(t.id, human);
    g.rework(t.id, human, "one more thing");
    changed = ["src/a.ts"];
    expect(round()).toBe("approved");
    expect(approvalUndone(g.events(t.id))).not.toBeNull();
    const b = startBoard({ foreman: g, port: 0, approver: human });
    try {
      const body = await (await fetch(`${b.url}/api/tasks`)).json();
      expect(body.tasks.find((x: { id: string }) => x.id === t.id).undone).toBeNull();
    } finally {
      await b.stop();
    }
  });

  test("/api/tasks: an auto-approved task its worker reworked has undone null", async () => {
    const g = setup();
    const t = g.create({ title: "Auto task", acceptance: ["cmd: bun test"], ready: true, risk: "auto" }, human);
    g.claim(t.id, worker);
    g.submit(t.id, worker, { pr: "https://example.com/pull/2" });
    g.startVerify(t.id, verifier);
    expect(g.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status).toBe("approved");
    g.rework(t.id, worker, "found a gap");
    const b = startBoard({ foreman: g, port: 0, approver: human });
    try {
      const body = await (await fetch(`${b.url}/api/tasks`)).json();
      expect(body.tasks.find((x: { id: string }) => x.id === t.id).undone).toBeNull();
    } finally {
      await b.stop();
    }
  });

  test("/api/tasks carries undone for the reworked task and null for the others", async () => {
    const g = setup();
    const id = waitingTask(g);
    const other = waitingTask(g, "Another task");
    g.approve(id, human);
    g.rework(id, human, "changed my mind");
    const b = startBoard({ foreman: g, port: 0, approver: human });
    try {
      const body = await (await fetch(`${b.url}/api/tasks`)).json();
      const byId = Object.fromEntries(body.tasks.map((t: { id: string }) => [t.id, t]));
      expect(byId[id].undone).toMatchObject({ by: "ada", byKind: "human", reason: "changed my mind", conflict: false });
      expect(byId[other].undone).toBeNull();
    } finally {
      await b.stop();
    }
  });
});

describe("the page flags surprises (T-0094)", () => {
  let html = "";
  beforeAll(async () => {
    html = await (await get("/")).text();
  });

  test("it has the queue notice, the undone flag and note, the conflict button and the UNKNOWN wording", () => {
    expect(html).toContain("queueSummary(");
    expect(html).toContain('"qnote ');
    expect(html).toContain('"flag"');
    expect(html).toContain("Approval undone");
    expect(html).toContain("Your approval was undone");
    expect(html).toContain('conflict ? "Send back " + prNumber(t.pr)');
    expect(html).toContain("GitHub is checking if it merges");
    // no alarm for a person's own rework: the page knows who signs off here
    expect(html).toContain('"me":"ada"');
    expect(html).toContain("t.undone.by === S.me");
    // a person's send-back toast closes itself; an agent's stays until dismissed
    expect(html).toContain('sticky: !t.undone.conflict && t.undone.byKind !== "human"');
  });

  test("queueSummary: bad on any failure, ok only when something merged, else skip", () => {
    const src = /function queueSummary\(entries, failures\) \{[\s\S]*?\n\}/.exec(html)?.[0];
    expect(src).toBeTruthy();
    const queueSummary = new Function("label", `${src}; return queueSummary;`)((e: { id: string }) => e.id) as (
      entries: { id: string; action: string }[],
      failures: unknown[],
    ) => { cls: string; text: string };
    const e = (id: string, action: string) => ({ id, action });
    expect(queueSummary([e("T-1", "merged"), e("T-2", "sent_back"), e("T-3", "skipped")], [])).toMatchObject({
      cls: "ok", text: "Merged T-1 · 1 sent back · 1 skipped",
    });
    expect(queueSummary([e("T-3", "skipped")], [])).toMatchObject({ cls: "skip", text: "Nothing merged · 1 skipped" });
    expect(queueSummary([e("T-1", "merged"), e("T-4", "error")], [])).toMatchObject({ cls: "bad", text: "Merged T-1 · 1 failed" });
    expect(queueSummary([], ["down"])).toMatchObject({ cls: "bad", text: "The queue didn't run · 1 failed" });
    expect(queueSummary([], [])).toMatchObject({ cls: "skip", text: "Nothing was approved" });
  });
});
