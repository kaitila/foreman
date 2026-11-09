// One board for every project on this machine (T-0071): the registry, two repos served by one
// board (tasks from both, approve and merge scoped to one), and the page's switcher and tags.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHtml } from "../src/board/page";
import { type Board, startBoard } from "../src/board/server";
import { type Actor, Foreman } from "../src/core";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { addProject, listProjects, nameProjects, noteProject, projectRoot, readRegistry, removeProject } from "../src/projects";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fm-projects-")));
const registry = join(tmp, "config", "foreman", "projects.json");

/** A git repo with a .foreman database, as `fm` leaves it. */
function repo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  openDb(join(dir, ".foreman", "foreman.db")).close();
  return dir;
}

describe("the registry", () => {
  test("add, list and rm; only a git repo with a foreman database can be added", () => {
    const a = repo("alpha"), b = repo("beta");
    expect(readRegistry(registry)).toEqual([]);
    expect(addProject(a, registry)).toBe(a);
    expect(addProject(join(a, ".foreman"), registry)).toBe(a); // a subfolder is the same repo
    addProject(b, registry);
    expect(listProjects(registry)).toEqual([{ name: "alpha", dir: a }, { name: "beta", dir: b }]);
    const bare = join(tmp, "plain");
    mkdirSync(bare);
    expect(() => addProject(bare, registry)).toThrow(/not inside a git repository/);
    const nodb = join(tmp, "nodb");
    mkdirSync(nodb);
    Bun.spawnSync(["git", "init", "-q"], { cwd: nodb });
    expect(() => addProject(nodb, registry)).toThrow(/no \.foreman database/);
    expect(projectRoot(nodb)).toHaveProperty("error");
    expect(removeProject("alpha", registry)).toBe(a);
    expect(removeProject(b, registry)).toBe(b);
    expect(() => removeProject("alpha", registry)).toThrow(/no registered project/);
    expect(readRegistry(registry)).toEqual([]);
  });

  test("opening a repo's database notes it; names stay unique; a damaged file reads as empty", () => {
    const g = repo("gamma");
    noteProject(g, registry);
    noteProject(g, registry);
    expect(readRegistry(registry)).toEqual([g]);
    expect(nameProjects(["/x/app", "/y/app", "/z/app"]).map((p) => p.name)).toEqual(["app", "app-2", "app-3"]);
    writeFileSync(registry, "{ nope");
    expect(readRegistry(registry)).toEqual([]);
    noteProject(join(tmp, "plain"), registry); // not a project: ignored, no throw
  });
});

describe("two repos on one board", () => {
  const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
  const calls: { cmd: string[]; cwd: string }[] = [];
  const merged = new Set<string>();
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: (pr) => ({ head: `b-${pr.split("/").pop()}`, headSha: `sha${pr.split("/").pop()}`, mergeable: "MERGEABLE" }),
    originRepo: () => "acme/app",
  };
  const run = (cmd: string[], cwd: string) => {
    calls.push({ cmd, cwd });
    const sha = `sha${cmd[3]!.split("/").pop()}`;
    if (cmd[1] === "pr" && cmd[2] === "view") {
      if (cmd.includes("state")) return merged.has(cmd[3]!) ? "MERGED" : "OPEN";
      const check = { __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" };
      return JSON.stringify({ headRefOid: sha, mergeable: "MERGEABLE", statusCheckRollup: [check] });
    }
    if (cmd[1] === "pr" && cmd[2] === "merge") {
      merged.add(cmd[3]!);
      return "";
    }
    return null;
  };
  let dirA: string, dirB: string, fa: Foreman, fb: Foreman, board: Board;
  const ids = {} as Record<"waitA" | "mergeA" | "waitB" | "mergeB", string>;

  /** A verified task: risk review waits for a person; auto is approved and ready to merge. */
  function task(f: Foreman, n: number, risk: "auto" | "review") {
    const t = f.create({ title: `task ${n}`, acceptance: ["cmd: true"], paths: ["src/**"], ready: true, risk }, human);
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch: `b-${n}` });
    f.submit(t.id, worker, { pr: PR(n) });
    f.startVerify(t.id, verifier);
    f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
    return t.id;
  }
  const open = (dir: string) => new Foreman(openDb(join(dir, ".foreman", "foreman.db")), dir, (() => { let c = 1; return () => ++c; })(), policy);
  const api = (path: string) => fetch(board.url + path).then((r) => r.json() as Promise<any>);
  const auth = () => ({ "x-foreman-token": board.token!, origin: `http://127.0.0.1:${board.port}` });
  const post = (path: string, headers: Record<string, string> = auth()) => fetch(board.url + path, { method: "POST", headers });

  beforeAll(() => {
    dirA = repo("two-a");
    dirB = repo("two-b");
    fa = open(dirA);
    fb = open(dirB);
    // Each database numbers its own tasks: T-0001 is alpha's and beta's too.
    ids.waitA = task(fa, 1, "review");
    ids.mergeA = task(fa, 2, "auto");
    ids.waitB = task(fb, 3, "review");
    ids.mergeB = task(fb, 4, "auto");
    expect(ids.waitA).toBe(ids.waitB);
    board = startBoard({
      projects: [
        { name: "alpha", foreman: fa, dir: dirA },
        { name: "beta", foreman: fb, dir: dirB },
      ],
      port: 0,
      approver: human,
      prCacheMs: 0,
      queue: { run, cwd: "/never-used", settleSeconds: 0, sleep: () => Promise.resolve() },
    });
  });
  afterAll(async () => {
    await board.stop();
  });

  test("/api/projects lists both with what waits for the person", async () => {
    const r = await api("/api/projects");
    expect(r.projects).toEqual([
      { name: "alpha", waiting: 1, toMerge: 1, total: 2 },
      { name: "beta", waiting: 1, toMerge: 1, total: 2 },
    ]);
  });

  test("each project's routes show only its own tasks; unknown projects are 404", async () => {
    const a = await api("/api/p/alpha/tasks");
    const b = await api("/api/p/beta/tasks");
    expect(a.tasks.map((t: { title: string }) => t.title).sort()).toEqual(["task 1", "task 2"]);
    expect(b.tasks.map((t: { title: string }) => t.title).sort()).toEqual(["task 3", "task 4"]);
    expect((await api(`/api/p/beta/tasks/${ids.waitB}`)).task.title).toBe("task 3");
    expect((await api(`/api/p/alpha/tasks/${ids.waitA}`)).task.title).toBe("task 1"); // same id, other project
    expect((await fetch(`${board.url}/api/p/alpha/tasks/T-0099`)).status).toBe(404);
    expect((await fetch(`${board.url}/api/p/nope/tasks`)).status).toBe(404);
    expect((await api("/api/p/beta/events?since=0")).events.length).toBeGreaterThan(0);
  });

  test("the page embeds both projects' tasks, with the switcher and tag code", async () => {
    const html = await (await fetch(board.url + "/")).text();
    expect(html).toContain('id="projects"');
    const initial = JSON.parse(/<script type="application\/json" id="initial">(.*?)<\/script>/s.exec(html)![1]!.replace(/\\u003c/g, "<"));
    expect(initial.projects.map((p: { name: string }) => p.name)).toEqual(["alpha", "beta"]);
    expect(initial.projects.flatMap((p: { tasks: unknown[] }) => p.tasks)).toHaveLength(4);
    // The client: a button per project plus All projects, a project tag on cards in the All view, a filter on project names.
    expect(html).toContain('mk("all", "All projects")');
    expect(html).toContain('el("span", "proj", t.project)');
    expect(html).toContain("t.project + \" \" + t.id");
    expect(html).toContain("#p=");
    expect(html).toContain("Filter by project");
  });

  test("a single-project page has no switcher or tags", () => {
    const html = pageHtml("n", { lanes: [], canApprove: false, projects: [{ name: "solo", tasks: [], lastEvent: 0 }] });
    expect(html).toContain("const multi = PROJECTS.length > 1");
  });

  test("approve in one project changes only that project's database", async () => {
    const before = fb.get(ids.waitB).status;
    const r = await post(`/api/p/alpha/tasks/${ids.waitA}/approve`);
    expect(r.status).toBe(200);
    expect(fa.get(ids.waitA).status).toBe("approved");
    expect(fb.get(ids.waitB).status).toBe(before);
    expect(fb.get(ids.waitB).status).toBe("needs_approval");
    expect(fb.events().some((e) => e.type === "approved")).toBe(false);
    // It needs the token, as before.
    const no = await post(`/api/p/beta/tasks/${ids.waitB}/approve`, { origin: `http://127.0.0.1:${board.port}` });
    expect(no.status).toBe(403);
    expect(fb.get(ids.waitB).status).toBe("needs_approval");
  });

  test("merge runs gh in that project's directory", async () => {
    calls.length = 0;
    const r = await post(`/api/p/beta/tasks/${ids.mergeB}/merge`);
    expect(r.status).toBe(200);
    expect(fb.get(ids.mergeB).status).toBe("done");
    expect(fa.get(ids.mergeA).status).toBe("approved");
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.cwd))).toEqual(new Set([dirB]));
    expect(calls.some((c) => c.cmd[2] === "merge" && c.cmd[3] === PR(4))).toBe(true);
  });

  test("Run queue is per project: alpha's queue runs in alpha's directory", async () => {
    calls.length = 0;
    const r = await post("/api/p/alpha/queue/run");
    expect(r.status).toBe(200);
    expect(new Set(calls.map((c) => c.cwd))).toEqual(new Set([dirA]));
    // One pass merges at most one task: one of alpha's two is done, and beta's is untouched.
    expect([fa.get(ids.mergeA).status, fa.get(ids.waitA).status].sort()).toEqual(["approved", "done"]);
    expect(fb.get(ids.waitB).status).toBe("needs_approval");
  });

  test("the Host check still applies to the scoped routes", async () => {
    const r = await fetch(`${board.url}/api/projects`, { headers: { host: "evil.example" } });
    expect(r.status).toBe(421);
  });
});
