// Merge queue and janitor (T-0033, D0011, D0012), with a fake GitHub for the queue and
// real git worktrees for the janitor.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman } from "../src/core";
import { janitor } from "../src/janitor";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { judgeChecks, mergeQueue, mergeQueuePass } from "../src/queue";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const queue: Actor = { name: "merge-queue", kind: "agent" };
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;
const ok = (name: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion: "SUCCESS" });

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
      const pinned = cmd[cmd.indexOf("--match-head-commit") + 1];
      if (pinned !== p.sha) return null;
      p.merged = true;
      return "";
    }
    return null;
  };
  return { prs, calls, policy, run };
}

function approvedTask(f: Foreman, gh: ReturnType<typeof fakeGitHub>, n: number) {
  const branch = `t-${n}`;
  gh.prs.set(PR(n), { head: branch, sha: `sha${n}aaaaaaaa`, mergeable: "MERGEABLE", checks: [ok("check"), ok("docs")], merged: false });
  const t = f.create({ title: `task ${n}`, acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { branch });
  f.submit(t.id, worker, { pr: PR(n) });
  f.startVerify(t.id, verifier);
  const v = f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
  expect(v.status).toBe("approved");
  return t.id;
}

function setup() {
  let clock = 1;
  const gh = fakeGitHub();
  const f = new Foreman(openDb(":memory:"), null, () => ++clock, gh.policy);
  const pass = (extra = {}) => mergeQueuePass(f, queue, { run: gh.run, cwd: "/repo", settleSeconds: 0, sleep: async () => {}, ...extra });
  return { f, gh, pass };
}

describe("checks", () => {
  test("green only when every check is complete and passed; unknown is red; none is pending", () => {
    expect(judgeChecks([]).kind).toBe("pending");
    expect(judgeChecks([ok("a"), { __typename: "CheckRun", name: "b", status: "IN_PROGRESS" }]).kind).toBe("pending");
    expect(judgeChecks([ok("a"), { __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "FAILURE" }]).kind).toBe("red");
    expect(judgeChecks([{ __typename: "CheckRun", name: "b", status: "COMPLETED", conclusion: "WEIRD" }]).kind).toBe("red");
    expect(judgeChecks([{ __typename: "StatusContext", context: "ci", state: "ERROR" }]).kind).toBe("red");
    expect(judgeChecks([ok("a"), { __typename: "CheckRun", name: "s", status: "COMPLETED", conclusion: "SKIPPED" }])).toEqual({ kind: "green", names: ["a", "s"] });
  });
});

describe("merge queue", () => {
  test("merges approved tasks one per pass, oldest first, pinned to the verified commit", async () => {
    const { f, gh, pass } = setup();
    const a = approvedTask(f, gh, 1);
    const b = approvedTask(f, gh, 2);
    const first = await pass();
    expect(first.map((e) => [e.id, e.action])).toEqual([[a, "merged"]]);
    expect(f.get(a).status).toBe("done");
    expect(f.get(b).status).toBe("approved");
    const merge = gh.calls.find((c) => c[2] === "merge")!;
    expect(merge.slice(merge.indexOf("--match-head-commit"))).toEqual(["--match-head-commit", "sha1aaaaaaaa"]);
    expect((await pass()).map((e) => [e.id, e.action])).toEqual([[b, "merged"]]);
  });

  test("red, pending or unsettled checks, and a PR that moved, are skipped with the reason", async () => {
    const { f, gh, pass } = setup();
    const red = approvedTask(f, gh, 1);
    gh.prs.get(PR(1))!.checks = [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "FAILURE" }];
    const pending = approvedTask(f, gh, 2);
    gh.prs.get(PR(2))!.checks = [{ __typename: "CheckRun", name: "check", status: "QUEUED" }];
    const moved = approvedTask(f, gh, 3);
    gh.prs.get(PR(3))!.sha = "sha3bbbbbbbb";
    const r = await pass();
    expect(r.map((e) => [e.id, e.action])).toEqual([
      [red, "skipped"],
      [pending, "skipped"],
      [moved, "skipped"],
    ]);
    expect(r[0]!.reason).toContain("failing");
    expect(r[2]!.reason).toContain("moved after its verdict");
    expect(gh.calls.some((c) => c[2] === "merge")).toBe(false);
  });

  test("a check that appears while settling stops the merge", async () => {
    const { f, gh } = setup();
    const t = approvedTask(f, gh, 1);
    const r = await mergeQueuePass(f, queue, {
      run: gh.run,
      cwd: "/repo",
      settleSeconds: 0,
      sleep: async () => {
        gh.prs.get(PR(1))!.checks.push(ok("late-workflow"));
      },
    });
    expect(r[0]).toMatchObject({ id: t, action: "skipped" });
    expect(r[0]!.reason).toContain("not settled");
  });

  test("a conflicting PR goes back to ready; dry run changes nothing", async () => {
    const { f, gh, pass } = setup();
    const t = approvedTask(f, gh, 1);
    gh.prs.get(PR(1))!.mergeable = "CONFLICTING";
    expect((await pass({ dryRun: true }))[0]!.action).toBe("would_send_back");
    expect(f.get(t).status).toBe("approved");
    expect((await pass())[0]!.action).toBe("sent_back");
    expect(f.get(t).status).toBe("ready");
    expect(f.events(t).at(-1)?.data).toMatchObject({ conflict: true });
  });

  test("sendBackConflict refuses a PR that doesn't conflict, whoever asks", () => {
    const { f, gh } = setup();
    const t = approvedTask(f, gh, 1);
    expect(() => f.sendBackConflict(t, { name: "anyone", kind: "agent" })).toThrow(/not CONFLICTING/);
  });
});

describe("janitor (real git)", () => {
  const dir = mkdtempSync(join(tmpdir(), "foreman-janitor-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args: string[], cwd: string) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0;
  };

  test("removes a done task's clean worktree and merged branch, keeps a dirty one, lists stuck tasks", async () => {
    const root = join(dir, "repo");
    git(["init", "-q", "-b", "main", root], dir);
    git(["commit", "-q", "--allow-empty", "-m", "init"], root);
    const clean = join(root, ".claude/worktrees/clean");
    const dirty = join(root, ".claude/worktrees/dirty");
    git(["worktree", "add", "-q", "-b", "t-clean", clean], root);
    git(["worktree", "add", "-q", "-b", "t-dirty", dirty], root);
    writeFileSync(join(dirty, "wip.txt"), "unsaved\n");

    let clock = 1_000_000;
    const f = new Foreman(openDb(":memory:"), root, () => clock);
    const done = (title: string, branch: string, worktree: string) => {
      const t = f.create({ title, acceptance: ["cmd: true"], ready: true }, human);
      f.claim(t.id, worker);
      f.progress(t.id, worker, { branch, worktree });
      return f.cancel(t.id, human, "finished elsewhere").id;
    };
    const a = done("clean", "t-clean", clean);
    const b = done("dirty", "t-dirty", dirty);
    const stuck = f.create({ title: "stuck", acceptance: ["cmd: true"], ready: true }, human);
    f.claim(stuck.id, worker, 60 * 48);
    clock += 30 * 3_600_000;

    const released: string[] = [];
    const r = await janitor(f, { name: "janitor", kind: "agent" }, {
      now: () => clock,
      stuckHours: 24,
      releasePorts: async (wt) => {
        released.push(wt);
        return true;
      },
    });
    expect(r.removed.map((x) => x.id)).toEqual([a]);
    expect(r.removed[0]!.branchDeleted).toBe(true); // t-clean has no commits beyond main
    expect(r.kept.map((x) => [x.id, x.reason.split(" ")[0]])).toEqual([[b, "has"]]);
    expect(Bun.file(join(clean, ".git")).size).toBe(0);
    expect(Bun.file(join(dirty, "wip.txt")).size).toBeGreaterThan(0);
    expect(released.length).toBe(1);
    expect(r.stuck.map((x) => x.id)).toEqual([stuck.id]);

    const dry = await janitor(f, { name: "janitor", kind: "agent" }, { now: () => clock, dryRun: true, releasePorts: async () => true });
    expect(dry.removed).toEqual([]); // nothing left to remove; the dirty one is still kept
  });
});

describe("merge queue loop, two Foreman instances on one database file (T-0050)", () => {
  /** Runs two loop passes; between them another instance approves a task. `held` leaves a read open on the loop's connection. */
  async function loopSeesLateApproval(held: boolean, reopen: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "foreman-loop-"));
    try {
      const path = join(dir, "foreman.db");
      const gh = fakeGitHub();
      const writer = new Foreman(openDb(path), null, Date.now, gh.policy);
      const looper = new Foreman(openDb(path), null, Date.now, gh.policy);
      writer.create({ title: "seed", acceptance: ["cmd: true"], paths: ["src/**"] }, human);
      const reports: { id: string; action: string }[][] = [];
      let ids: string[] = [];
      let passes = 0;
      const stuck = held ? looper.db.query("SELECT * FROM tasks").iterate() : null;
      stuck?.next();
      await mergeQueue(looper, queue, {
        run: gh.run,
        cwd: "/repo",
        settleSeconds: 0,
        dryRun: true,
        intervalSeconds: 0,
        reopen: reopen ? () => new Foreman(openDb(path), null, Date.now, gh.policy) : undefined,
        sleep: async () => {
          if (passes === 1 && !ids.length) ids = [approvedTask(writer, gh, 1)];
        },
        onPass: (r) => {
          reports.push(r);
          if (++passes === 2) throw new Error("stop");
        },
      }).catch((e) => {
        if (e.message !== "stop") throw e;
      });
      return { first: reports[0]!, second: reports[1]!, ids };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a pass sees a task approved through another instance after the loop started", async () => {
    const r = await loopSeesLateApproval(false, false);
    expect(r.first).toEqual([]);
    expect(r.second.map((e) => [e.id, e.action])).toEqual([[r.ids[0]!, "would_merge"]]);
  });

  test("even when the loop's connection holds a read open, reopening each pass sees it", async () => {
    const stale = await loopSeesLateApproval(true, false);
    expect(stale.second).toEqual([]); // the failure mode: a pinned snapshot hides the approval
    const r = await loopSeesLateApproval(true, true);
    expect(r.second.map((e) => [e.id, e.action])).toEqual([[r.ids[0]!, "would_merge"]]);
  });
});
