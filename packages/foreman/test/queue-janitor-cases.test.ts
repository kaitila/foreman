// T-0033, case by case: the merge queue (one merge per pass, only settled green checks
// at the verified commit) and the janitor (worktrees of finished tasks, merged branches,
// stuck tasks). gh is faked; the janitor runs real git in a temporary repository.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, CONFLICT_REASON, Foreman, ForemanError } from "../src/core";
import { janitor } from "../src/janitor";
import { DEFAULT_PROTECTED, defaultRun, type Policy, type Run } from "../src/policy";
import { judgeChecks, mergeQueue, mergeQueuePass, type PrState } from "../src/queue";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const queueActor: Actor = { name: "merge-queue", kind: "agent" };

type Check = PrState["checks"][number];
const ok = (name: string, conclusion = "SUCCESS"): Check => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
const running = (name: string): Check => ({ __typename: "CheckRun", name, status: "IN_PROGRESS" });
const ctx = (context: string, state: string): Check => ({ __typename: "StatusContext", context, state });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "no error";
}

// ---------------------------------------------------------------- fake GitHub

interface FakePr {
  head: string; // branch
  /** What each `gh pr view` of checks returns, in order; the last one repeats. prInfo sees the current one. */
  views: PrState[];
  mergeFails?: boolean;
  /** What gh says on stderr when the merge fails. */
  mergeError?: string;
  /** What `gh pr view --json state` says after a failed merge. */
  stateAfterFail?: string;
  merged?: boolean;
}

const prUrl = (n: number) => `https://github.com/acme/app/pull/${n}`;

function setupQueue() {
  const clk = { t: 1000 };
  const prs = new Map<string, FakePr>();
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let prInfoDown = false;
  let submitting = false; // submit refuses a CONFLICTING PR, so the PR reads MERGEABLE while it is handed in
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: (pr) => {
      const p = prs.get(pr);
      if (prInfoDown || !p) return null;
      const v = p.views[0]!;
      return { head: p.head, headSha: v.headSha, mergeable: submitting ? "MERGEABLE" : v.mergeable, isDraft: submitting ? false : (v.isDraft ?? false) };
    },
    originRepo: () => "acme/app",
  };
  const f = new Foreman(openDb(":memory:"), null, () => ++clk.t, policy);
  const run: Run = (cmd) => {
    calls.push(cmd);
    if (cmd[0] !== "gh" || cmd[1] !== "pr") return null;
    const p = prs.get(cmd[3]!);
    if (!p) return null;
    if (cmd[2] === "view" && cmd[5] === "headRefOid,mergeable,isDraft,statusCheckRollup") {
      const v = p.views[0]!;
      if (p.views.length > 1) p.views.shift();
      return JSON.stringify({ headRefOid: v.headSha, mergeable: v.mergeable, isDraft: v.isDraft ?? false, statusCheckRollup: v.checks });
    }
    if (cmd[2] === "view" && cmd[5] === "state") return p.merged ? "MERGED" : (p.stateAfterFail ?? "OPEN");
    if (cmd[2] === "merge") {
      if (p.mergeFails) {
        run.lastError = p.mergeError;
        return null;
      }
      p.merged = true;
      return "";
    }
    return null;
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  let n = 0;
  /** A task walked to approved, its PR's reads set to `views` (the first is what was verified). */
  const approved = (views: PrState[] = [green()]) => {
    n += 1;
    const pr = prUrl(n);
    const branch = `t-${n}`;
    const t = f.create({ title: `task ${n}`, acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    prs.set(pr, { head: branch, views: [...views] });
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch });
    submitting = true;
    f.submit(t.id, worker, { pr });
    submitting = false;
    f.startVerify(t.id, verifier);
    const r = f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
    expect(r.status).toBe("approved");
    return { id: t.id, pr, fake: prs.get(pr)! };
  };
  const pass = (o: { dryRun?: boolean } = {}) => mergeQueuePass(f, queueActor, { run, cwd: "/repo", settleSeconds: 7, sleep, ...o });
  const merges = () => calls.filter((c) => c[1] === "pr" && c[2] === "merge");
  return { f, prs, calls, sleeps, run, sleep, approved, pass, merges, setPrInfoDown: (v: boolean) => (prInfoDown = v) };
}

const SHA = "aaaa1111bbbb2222";
function green(sha = SHA, names = ["test", "lint"]): PrState {
  return { headSha: sha, mergeable: "MERGEABLE", checks: names.map((x) => ok(x)) };
}

// ---------------------------------------------------------------- judgeChecks

describe("judgeChecks", () => {
  test("no checks yet is pending, not green", () => {
    expect(judgeChecks([]).kind).toBe("pending");
  });

  test("all passed is green, names sorted and deduplicated", () => {
    expect(judgeChecks([ok("test"), ok("lint"), ok("test")])).toEqual({ kind: "green", names: ["lint", "test"] });
  });

  test("NEUTRAL and SKIPPED pass", () => {
    expect(judgeChecks([ok("a"), ok("b", "NEUTRAL"), ok("c", "SKIPPED")]).kind).toBe("green");
  });

  test("any failing conclusion is red, optional ones too; unknown or missing conclusions fail closed", () => {
    for (const c of ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE", "SOMETHING_NEW"]) {
      const v = judgeChecks([ok("a"), ok("opt", "NEUTRAL"), ok("b", c)]);
      expect(v.kind).toBe("red");
      if (v.kind === "red") expect(v.reason).toContain(`b (${c})`);
    }
    expect(judgeChecks([{ __typename: "CheckRun", name: "x", status: "COMPLETED" }]).kind).toBe("red");
  });

  test("a check not completed is pending; red wins over pending", () => {
    expect(judgeChecks([ok("a"), running("b")]).kind).toBe("pending");
    expect(judgeChecks([ok("a"), { __typename: "CheckRun", name: "q", status: "QUEUED" }]).kind).toBe("pending");
    expect(judgeChecks([running("b"), ok("c", "FAILURE")]).kind).toBe("red");
  });

  test("status contexts: SUCCESS green, PENDING/EXPECTED pending, ERROR/FAILURE red", () => {
    expect(judgeChecks([ctx("ci/legacy", "SUCCESS"), ok("test")])).toEqual({ kind: "green", names: ["ci/legacy", "test"] });
    expect(judgeChecks([ctx("ci/legacy", "PENDING")]).kind).toBe("pending");
    expect(judgeChecks([ctx("ci/legacy", "EXPECTED")]).kind).toBe("pending");
    expect(judgeChecks([ctx("ci/legacy", "ERROR")]).kind).toBe("red");
    expect(judgeChecks([ctx("ci/legacy", "FAILURE")]).kind).toBe("red");
    // without __typename, a bare state still reads as a status context
    expect(judgeChecks([{ context: "ci/x", state: "FAILURE" }]).kind).toBe("red");
  });
});

// ---------------------------------------------------------------- the queue

describe("merge queue (T-0033)", () => {
  test("one merge per pass, oldest approval first; the next merges on the next pass", async () => {
    const q = setupQueue();
    const first = q.approved();
    const second = q.approved();
    const r1 = await q.pass();
    expect(r1).toEqual([{ id: first.id, pr: first.pr, action: "merged", reason: expect.stringContaining("2 checks green") }]);
    expect(q.f.get(first.id).status).toBe("done");
    expect(q.f.get(second.id).status).toBe("approved");
    expect(q.merges()).toEqual([["gh", "pr", "merge", first.pr, "--merge", "--delete-branch", "--match-head-commit", SHA]]);
    expect(q.sleeps).toEqual([7000]); // settled between two reads

    const r2 = await q.pass();
    expect(r2.map((e) => [e.id, e.action])).toEqual([[second.id, "merged"]]);
    expect(q.f.get(second.id).status).toBe("done");
    expect(q.merges().length).toBe(2);
    expect(await q.pass()).toEqual([]);
  });

  test("oldest means approved longest ago, not created first", async () => {
    const q = setupQueue();
    const a = q.approved();
    const b = q.approved();
    // a goes back and is approved again: now b has waited longer
    q.f.rework(a.id, human, "one more thing");
    q.f.claim(a.id, worker);
    q.f.submit(a.id, worker, { pr: a.pr });
    q.f.startVerify(a.id, verifier);
    q.f.recordVerify(a.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
    const r = await q.pass();
    expect(r.at(-1)).toMatchObject({ id: b.id, action: "merged" });
    expect(q.f.get(a.id).status).toBe("approved");
  });

  test("a skipped task doesn't block the next one", async () => {
    const q = setupQueue();
    const red = q.approved([{ ...green(), checks: [ok("test", "FAILURE")] }]);
    const fine = q.approved();
    const r = await q.pass();
    expect(r.map((e) => [e.id, e.action])).toEqual([
      [red.id, "skipped"],
      [fine.id, "merged"],
    ]);
  });

  const refuses: [string, PrState[], string][] = [
    ["a failing check among passing and neutral ones", [{ ...green(), checks: [ok("test"), ok("opt", "NEUTRAL"), ok("e2e", "FAILURE")] }], "e2e (FAILURE)"],
    ["a cancelled check", [{ ...green(), checks: [ok("test"), ok("lint", "CANCELLED")] }], "CANCELLED"],
    ["a timed-out check", [{ ...green(), checks: [ok("test", "TIMED_OUT")] }], "TIMED_OUT"],
    ["a check still running", [{ ...green(), checks: [ok("test"), running("lint")] }], "still running: lint"],
    ["no checks at all", [{ ...green(), checks: [] }], "no checks"],
    ["mergeability UNKNOWN", [{ ...green(), mergeable: "UNKNOWN" }], "UNKNOWN"],
    ["a new check appearing on the second read", [green(SHA, ["test"]), green(SHA, ["test", "late"])], "checks not settled"],
    ["a check going pending on the second read", [green(), { ...green(), checks: [ok("test"), running("lint")] }], "still running"],
    ["a check going red on the second read", [green(), { ...green(), checks: [ok("test"), ok("lint", "FAILURE")] }], "failing"],
    ["the head moving while checks settle", [green(), green("cccc3333dddd")], "moved while its checks settled"],
    ["mergeability turning UNKNOWN on the second read", [green(), { ...green(), mergeable: "UNKNOWN" }], "no longer says it merges cleanly"],
  ];
  for (const [what, views, reason] of refuses) {
    test(`refuses ${what}`, async () => {
      const q = setupQueue();
      const t = q.approved(views);
      const r = await q.pass();
      expect(r).toEqual([{ id: t.id, pr: t.pr, action: "skipped", reason: expect.stringContaining(reason) }]);
      expect(q.merges()).toEqual([]);
      expect(q.f.get(t.id).status).toBe("approved");
    });
  }

  test("refuses a PR whose head moved after the verdict (before the first read)", async () => {
    const q = setupQueue();
    const t = q.approved();
    t.fake.views = [green("eeee5555ffff")];
    const r = await q.pass();
    expect(r[0]).toMatchObject({ action: "skipped", reason: expect.stringContaining("moved after its verdict") });
    expect(q.sleeps).toEqual([]); // didn't wait to settle
    expect(q.merges()).toEqual([]);
  });

  test("skips a non-GitHub PR, a verdict with no commit, and a PR gh can't read", async () => {
    const q = setupQueue();
    // a local PR string: no GitHub lookups
    const local = q.f.create({ title: "local", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    q.f.claim(local.id, worker);
    q.f.progress(local.id, worker, { branch: "t-local" });
    q.f.submit(local.id, worker, { pr: "https://example.com/pull/3" });
    q.f.startVerify(local.id, verifier);
    // changedFiles is faked, so it's approved without a person
    expect(q.f.recordVerify(local.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status).toBe("approved");

    // gh was down when the verdict was recorded: no headSha
    const n = q.f.create({ title: "no sha", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    q.prs.set(prUrl(50), { head: "t-nosha", views: [green()] });
    q.f.claim(n.id, worker);
    q.f.progress(n.id, worker, { branch: "t-nosha" });
    q.f.submit(n.id, worker, { pr: prUrl(50) });
    q.f.startVerify(n.id, verifier);
    q.setPrInfoDown(true);
    q.f.recordVerify(n.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]);
    q.setPrInfoDown(false);
    expect(q.f.verifiedHead(n.id)).toBeNull();

    const unreadable = q.approved();
    q.prs.delete(unreadable.pr); // the runner can't answer for it now

    const r = await q.pass();
    expect(r.map((e) => [e.id, e.action, e.reason])).toEqual([
      [local.id, "skipped", expect.stringContaining("no GitHub PR")],
      [n.id, "skipped", expect.stringContaining("recorded no commit")],
      [unreadable.id, "skipped", expect.stringContaining("couldn't read")],
    ]);
    expect(q.merges()).toEqual([]);
  });

  test("a conflicting PR goes back to ready with the reason and a rework event", async () => {
    const q = setupQueue();
    const t = q.approved([{ ...green(), mergeable: "CONFLICTING" }]);
    const r = await q.pass();
    expect(r).toEqual([{ id: t.id, pr: t.pr, action: "sent_back", reason: expect.stringContaining("conflicts with main") }]);
    expect(q.f.get(t.id).status).toBe("ready");
    const ev = q.f.events(t.id).at(-1)!;
    expect(ev.type).toBe("rework");
    expect(ev.actor).toBe(queueActor.name);
    expect(ev.data).toEqual({ reason: CONFLICT_REASON, was: "approved", conflict: true, headSha: SHA });
    expect(q.merges()).toEqual([]);
  });

  test("a conflict send-back doesn't end the pass", async () => {
    const q = setupQueue();
    const c = q.approved([{ ...green(), mergeable: "CONFLICTING" }]);
    const fine = q.approved();
    const r = await q.pass();
    expect(r.map((e) => [e.id, e.action])).toEqual([
      [c.id, "sent_back"],
      [fine.id, "merged"],
    ]);
  });

  test("sendBackConflict is refused unless GitHub says CONFLICTING right now", () => {
    const q = setupQueue();
    const t = q.approved();
    expect(code(() => q.f.sendBackConflict(t.id, worker))).toBe("not_conflicting");
    t.fake.views = [{ ...green(), mergeable: "UNKNOWN" }];
    expect(code(() => q.f.sendBackConflict(t.id, worker))).toBe("not_conflicting");
    q.setPrInfoDown(true);
    expect(code(() => q.f.sendBackConflict(t.id, worker))).toBe("pr_unverifiable");
    q.setPrInfoDown(false);
    expect(q.f.get(t.id).status).toBe("approved");
    t.fake.views = [{ ...green(), mergeable: "CONFLICTING" }];
    expect(q.f.sendBackConflict(t.id, worker).status).toBe("ready");
    // only an approved task
    expect(code(() => q.f.sendBackConflict(t.id, worker))).toBe("bad_status");
  });

  test("the queue reports an error when foreman refuses the send-back", async () => {
    const q = setupQueue();
    // the queue's read says CONFLICTING, but GitHub has moved on by the time foreman checks
    const t = q.approved([{ ...green(), mergeable: "CONFLICTING" }, green()]);
    const r = await q.pass();
    expect(r[0]).toMatchObject({ id: t.id, action: "error", reason: expect.stringContaining("not CONFLICTING") });
    expect(q.f.get(t.id).status).toBe("approved");
  });

  test("dry run changes nothing", async () => {
    const q = setupQueue();
    const c = q.approved([{ ...green(), mergeable: "CONFLICTING" }]);
    const t = q.approved();
    const later = q.approved();
    const before = [c, t, later].map((x) => q.f.events(x.id).length);
    const r = await q.pass({ dryRun: true });
    expect(r.map((e) => [e.id, e.action])).toEqual([
      [c.id, "would_send_back"],
      [t.id, "would_merge"],
    ]);
    expect(q.merges()).toEqual([]);
    expect([c, t, later].map((x) => q.f.get(x.id).status)).toEqual(["approved", "approved", "approved"]);
    expect([c, t, later].map((x) => q.f.events(x.id).length)).toEqual(before);
  });

  test("gh merge failing after the merge happened (state MERGED) still marks it merged", async () => {
    const q = setupQueue();
    const t = q.approved();
    t.fake.mergeFails = true;
    t.fake.stateAfterFail = "MERGED";
    const r = await q.pass();
    expect(r[0]).toMatchObject({ id: t.id, action: "merged" });
    expect(q.f.get(t.id).status).toBe("done");
    expect(q.calls.some((c) => c[2] === "view" && c.includes("state"))).toBe(true);
  });

  test("gh merge failing with the PR still open is an error, and the pass stops", async () => {
    const q = setupQueue();
    const t = q.approved();
    const next = q.approved();
    t.fake.mergeFails = true;
    const r = await q.pass();
    expect(r).toEqual([{ id: t.id, pr: t.pr, action: "error", reason: expect.stringContaining("gh pr merge failed") }]);
    expect(q.f.get(t.id).status).toBe("approved");
    expect(q.f.get(next.id).status).toBe("approved");
  });

  test("a failed merge names gh's own error line", async () => {
    const q = setupQueue();
    const t = q.approved();
    t.fake.mergeFails = true;
    t.fake.mergeError = "warning: x\nPull request is in draft state\n";
    const r = await q.pass();
    expect(r[0]!.action).toBe("error");
    expect(r[0]!.reason).toContain("Pull request is in draft state");
  });

  test("a draft PR is skipped with 'draft' in the reason, not merged", async () => {
    const q = setupQueue();
    const t = q.approved();
    t.fake.views = [{ ...green(), isDraft: true }];
    const r = await q.pass();
    expect(r).toEqual([{ id: t.id, pr: t.pr, action: "skipped", reason: expect.stringContaining("draft") }]);
    expect(q.calls.some((c) => c[2] === "merge")).toBe(false);
  });

  test("mergeQueue with once runs a single pass and reports it", async () => {
    const q = setupQueue();
    q.approved();
    q.approved();
    const seen: number[] = [];
    const r = await mergeQueue(q.f, queueActor, { run: q.run, cwd: "/repo", settleSeconds: 0, sleep: q.sleep, once: true, onPass: (x) => seen.push(x.length) });
    expect(r.map((e) => e.action)).toEqual(["merged"]);
    expect(seen).toEqual([1]);
    expect(q.merges().length).toBe(1);
  });
});

// ---------------------------------------------------------------- the janitor

// Real git, with an identity and no signing, whatever the machine's config says.
const git: Run = (cmd, cwd) =>
  cmd[0] === "git"
    ? defaultRun(["git", "-c", "user.name=Test Person", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...cmd.slice(1)], cwd)
    : defaultRun(cmd, cwd);

function must(cmd: string[], cwd: string): string {
  const out = git(cmd, cwd);
  if (out === null) throw new Error(`failed: ${cmd.join(" ")} in ${cwd}`);
  return out;
}

describe("janitor (T-0033)", () => {
  let tmp: string;
  let n = 0;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-janitor-")));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh repo with one commit on main, and a foreman whose clock the test moves. */
  function setupRepo() {
    n += 1;
    const repo = join(tmp, `repo${n}`);
    mkdirSync(repo);
    must(["git", "init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    must(["git", "add", "README.md"], repo);
    must(["git", "commit", "-q", "-m", "initial"], repo);
    const clk = { t: 1_000_000 };
    const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/a.ts"] };
    const f = new Foreman(openDb(":memory:"), null, () => ++clk.t, policy);
    const released: { wt: string; existed: boolean }[] = [];
    const releasePorts = async (wt: string) => {
      released.push({ wt, existed: existsSync(wt) });
      return true;
    };
    /** A worktree on a new branch, with one commit, recorded on a new claimed task. */
    const task = (name: string, where = join(repo, ".wt", name)) => {
      const branch = `t-${name}`;
      must(["git", "worktree", "add", "-q", where, "-b", branch], repo);
      writeFileSync(join(where, `${name}.txt`), `${name}\n`);
      must(["git", "add", "."], where);
      must(["git", "commit", "-q", "-m", `work on ${name}`], where);
      const t = f.create({ title: name, acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
      f.claim(t.id, worker);
      f.progress(t.id, worker, { branch, worktree: where });
      return { id: t.id, wt: where, branch };
    };
    const branchExists = (b: string) => git(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], repo) !== null;
    const sweep = (o: { dryRun?: boolean; now?: number; stuckHours?: number } = {}) =>
      janitor(f, queueActor, { run: git, root: repo, releasePorts, now: () => o.now ?? clk.t, dryRun: o.dryRun, stuckHours: o.stuckHours });
    return { repo, f, clk, released, task, branchExists, sweep };
  }

  test("a done task's worktree is removed, its ports released first, and its merged branch deleted", async () => {
    const r = setupRepo();
    const a = r.task("a");
    r.f.submit(a.id, worker, { pr: "https://example.com/pull/1" });
    r.f.startVerify(a.id, verifier);
    expect(r.f.recordVerify(a.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status).toBe("approved");
    must(["git", "merge", "-q", "--no-ff", "-m", "merge t-a", a.branch], r.repo);
    expect(r.f.merged(a.id, human).status).toBe("done");

    const rep = await r.sweep();
    expect(rep.removed).toEqual([{ id: a.id, worktree: a.wt, branchDeleted: true, portsReleased: true }]);
    expect(rep.kept).toEqual([]);
    expect(existsSync(a.wt)).toBe(false);
    expect(r.branchExists(a.branch)).toBe(false);
    expect(r.released).toEqual([{ wt: a.wt, existed: true }]);
    expect(must(["git", "worktree", "list", "--porcelain"], r.repo)).not.toContain(".wt/a");

    // nothing left to do the second time
    const again = await r.sweep();
    expect(again.removed).toEqual([]);
    expect(again.kept).toEqual([]);
  });

  test("a cancelled task's unmerged branch survives; its clean worktree goes", async () => {
    const r = setupRepo();
    const b = r.task("b");
    r.f.cancel(b.id, human, "not needed");
    const rep = await r.sweep();
    expect(rep.removed).toEqual([{ id: b.id, worktree: b.wt, branchDeleted: false, portsReleased: true }]);
    expect(existsSync(b.wt)).toBe(false);
    expect(r.branchExists(b.branch)).toBe(true);
  });

  test("a cancelled task whose branch is already in main loses the branch too", async () => {
    const r = setupRepo();
    const c = r.task("c");
    must(["git", "merge", "-q", "--ff-only", c.branch], r.repo);
    r.f.cancel(c.id, human, "landed by hand");
    const rep = await r.sweep();
    expect(rep.removed[0]).toMatchObject({ id: c.id, branchDeleted: true });
    expect(r.branchExists(c.branch)).toBe(false);
  });

  test("a dirty worktree is kept, untracked files included, and its ports not released", async () => {
    const r = setupRepo();
    const d = r.task("d");
    const e = r.task("e");
    writeFileSync(join(d.wt, "scratch.txt"), "untracked\n");
    writeFileSync(join(e.wt, "e.txt"), "changed\n");
    r.f.cancel(d.id, human, "x");
    r.f.cancel(e.id, human, "x");
    const rep = await r.sweep();
    expect(rep.removed).toEqual([]);
    expect(rep.kept).toEqual([
      { id: d.id, worktree: d.wt, reason: expect.stringContaining("uncommitted changes") },
      { id: e.id, worktree: e.wt, reason: expect.stringContaining("uncommitted changes") },
    ]);
    expect(existsSync(d.wt) && existsSync(e.wt)).toBe(true);
    expect(r.branchExists(d.branch)).toBe(true);
    expect(r.released).toEqual([]);
  });

  test("a worktree outside the root, or one git doesn't know, is left alone", async () => {
    const r = setupRepo();
    const outside = r.task("out", join(tmp, `outside${n}`));
    const plain = join(r.repo, ".wt", "plain");
    mkdirSync(plain, { recursive: true });
    const p = r.f.create({ title: "plain", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    r.f.claim(p.id, worker);
    r.f.progress(p.id, worker, { worktree: plain });
    r.f.cancel(outside.id, human, "x");
    r.f.cancel(p.id, human, "x");
    const rep = await r.sweep();
    expect(rep.removed).toEqual([]);
    expect(rep.kept).toEqual([
      { id: outside.id, worktree: outside.wt, reason: expect.stringContaining("not inside the repository") },
      { id: p.id, worktree: plain, reason: expect.stringContaining("not a git worktree") },
    ]);
    expect(existsSync(outside.wt) && existsSync(plain)).toBe(true);
  });

  test("tasks that aren't finished keep their worktrees; a vanished worktree is skipped quietly", async () => {
    const r = setupRepo();
    const live = r.task("live");
    const gone = r.task("gone");
    must(["git", "worktree", "remove", gone.wt], r.repo);
    r.f.cancel(gone.id, human, "x");
    const rep = await r.sweep();
    expect(rep.removed).toEqual([]);
    expect(rep.kept).toEqual([]);
    expect(existsSync(live.wt)).toBe(true);
  });

  test("dry run removes, deletes and reclaims nothing", async () => {
    const r = setupRepo();
    const a = r.task("a");
    must(["git", "merge", "-q", "--ff-only", a.branch], r.repo);
    r.f.cancel(a.id, human, "x");
    const claimed = r.f.create({ title: "lease", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    r.f.claim(claimed.id, worker);
    const far = r.clk.t + 48 * 3_600_000; // past the lease
    const rep = await r.sweep({ dryRun: true, now: far });
    expect(rep.removed).toEqual([{ id: a.id, worktree: a.wt, branchDeleted: false, portsReleased: false }]);
    expect(rep.reclaimed).toEqual([claimed.id]);
    expect(existsSync(a.wt)).toBe(true);
    expect(r.branchExists(a.branch)).toBe(true);
    expect(r.released).toEqual([]);
    expect(r.f.get(claimed.id).status).toBe("claimed");
  });

  test("expired leases are reclaimed", async () => {
    const r = setupRepo();
    const t = r.f.create({ title: "lease", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    r.f.claim(t.id, worker);
    r.clk.t += 2 * 3_600_000;
    const rep = await r.sweep();
    expect(rep.reclaimed).toEqual([t.id]);
    expect(r.f.get(t.id).status).toBe("ready");
  });

  test("stuck tasks are listed by when they entered their state; heartbeats don't hide them", async () => {
    const r = setupRepo();
    const H = 3_600_000;
    const mk = (title: string) => r.f.create({ title, acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);

    const working = mk("working");
    r.f.claim(working.id, worker);
    r.f.progress(working.id, worker, { note: "started" });
    const startedAt = r.clk.t;
    const reviewed = mk("in review");
    r.f.claim(reviewed.id, worker);
    r.f.submit(reviewed.id, worker, { pr: "https://example.com/pull/9" });
    const verifying = mk("verifying");
    r.f.claim(verifying.id, worker);
    r.f.submit(verifying.id, worker, { pr: "https://example.com/pull/10" });
    r.f.startVerify(verifying.id, verifier);

    // a day later the worker is still sending heartbeats and progress
    r.clk.t += 26 * H;
    r.f.progress(working.id, worker, { note: "still going" });
    r.f.heartbeat(working.id, worker);
    r.f.heartbeat(verifying.id, verifier);
    const fresh = mk("fresh");
    r.f.claim(fresh.id, worker);

    const rep = await r.sweep({ now: r.clk.t + 1 });
    expect(rep.reclaimed).toEqual([]);
    const byId = Object.fromEntries(rep.stuck.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual([working.id, reviewed.id, verifying.id].sort());
    expect(byId[working.id]).toMatchObject({ status: "in_progress", since: startedAt, assignee: worker.name });
    expect(byId[working.id]!.hours).toBeGreaterThanOrEqual(26);
    expect(byId[reviewed.id]).toMatchObject({ status: "in_review", assignee: null });
    expect(byId[verifying.id]).toMatchObject({ status: "verifying", assignee: verifier.name });

    // a higher threshold lists none of them
    expect((await r.sweep({ now: r.clk.t + 1, stuckHours: 100, dryRun: true })).stuck).toEqual([]);
  });

  test("a new claim restarts the clock for in_progress", async () => {
    const r = setupRepo();
    const H = 3_600_000;
    const t = r.f.create({ title: "again", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    r.f.claim(t.id, worker);
    r.f.progress(t.id, worker, {});
    r.clk.t += 30 * H; // the lease ran out
    expect(r.f.reclaim(human)).toEqual([t.id]);
    r.f.claim(t.id, worker);
    r.f.progress(t.id, worker, {});
    const rep = await r.sweep({ now: r.clk.t + 1 });
    expect(rep.stuck).toEqual([]);
  });
});
