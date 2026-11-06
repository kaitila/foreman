import { describe, expect, test } from "bun:test";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { toMarkdown } from "../src/export";
import type { Policy } from "../src/policy";
import { DEFAULT_PROTECTED } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };

function setup(changed: string[] | null = ["src/feature.ts"]) {
  let clock = 1_000_000;
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => changed };
  const f = new Foreman(openDb(":memory:"), null, () => clock, policy);
  return { f, tick: (ms: number) => (clock += ms) };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "no error";
}

const task = (f: Foreman, extra: Partial<Parameters<Foreman["create"]>[0]> = {}) =>
  f.create(
    { title: "Add a stage filter", acceptance: ["cmd: bun test", "statement: the filter is in the UI"], ready: false, ...extra },
    human,
  );

describe("lifecycle", () => {
  test("auto: claim → progress → submit → verify → approved → merged", () => {
    const { f } = setup();
    const t = task(f, { risk: "auto" });
    expect(t.id).toBe("T-0001");
    expect(t.acceptance.map((c) => c.kind)).toEqual(["cmd", "statement"]);
    f.markReady(t.id, human);
    expect(f.claim(null, worker).assignee).toBe("worker-1");
    f.progress(t.id, worker, { branch: "t-0001", note: "started" });
    expect(f.submit(t.id, worker, { pr: "https://example.com/pull/12" }).status).toBe("in_review");
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: true, evidence: "bun test: 40 pass" },
      { check: "c2", pass: true, evidence: "saw it on /investors" },
    ]);
    expect(v.status).toBe("approved");
    expect(f.merged(t.id, worker).status).toBe("done");
    expect(f.events(t.id).map((e) => e.type)).toEqual([
      "created", "ready", "claimed", "progress", "submitted", "verify_started", "verified", "merged",
    ]);
  });

  test("review: a verified task waits for a person", () => {
    const { f } = setup();
    const t = task(f, { risk: "review", ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: true, evidence: "ok" },
      { check: "c2", pass: true, evidence: "ok" },
    ]);
    expect(v.status).toBe("needs_approval");
    expect(code(() => f.approve(t.id, verifier))).toBe("human_only");
    expect(code(() => f.merged(t.id, worker))).toBe("bad_status");
    expect(f.approve(t.id, human).status).toBe("approved");
  });

  test("a failed check sends the task back to ready, with the results kept", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: false, evidence: "2 tests fail" },
      { check: "c2", pass: true, evidence: "ok" },
    ]);
    expect(v.status).toBe("ready");
    expect(v.assignee).toBeNull();
    expect(toMarkdown(v, f.events(t.id))).toContain("FAIL: 2 tests fail");
  });
});

describe("guards", () => {
  test("ready needs an acceptance check, also when created ready", () => {
    const { f } = setup();
    const t = f.create({ title: "vague" }, human);
    expect(code(() => f.markReady(t.id, human))).toBe("invalid");
    expect(code(() => f.create({ title: "vague", ready: true }, human))).toBe("invalid");
    expect(f.list().length).toBe(1); // the refused create left nothing behind
  });

  test("a worker can't verify its own task", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    expect(code(() => f.startVerify(t.id, worker))).toBe("own_work");
  });

  test("a verdict must cover every check, and only real ones", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, verifier);
    expect(code(() => f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "" }]))).toBe("incomplete");
    expect(
      code(() =>
        f.recordVerify(t.id, verifier, [
          { check: "c1", pass: true, evidence: "" },
          { check: "c2", pass: true, evidence: "" },
          { check: "c9", pass: true, evidence: "" },
        ]),
      ),
    ).toBe("invalid");
  });

  test("only the holder can act on a claim", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    expect(code(() => f.claim(t.id, verifier))).toBe("bad_status");
    expect(code(() => f.progress(t.id, verifier))).toBe("not_holder");
    expect(code(() => f.submit(t.id, verifier, { pr: "https://example.com/pull/1" }))).toBe("not_holder");
  });

  test("risk human: agents can't claim it, a person can and signs it off", () => {
    const { f } = setup();
    const t = f.create({ title: "Rotate prod keys", risk: "human", ready: true }, human);
    expect(f.ready("agent")).toEqual([]);
    expect(code(() => f.claim(t.id, worker))).toBe("human_only");
    f.claim(t.id, human);
    expect(f.approve(t.id, human).status).toBe("approved");
  });

  test("blockers: not claimable until they are done; unknown blockers are refused at create", () => {
    const { f } = setup();
    const a = task(f, { ready: true, risk: "auto" });
    const b = task(f, { ready: true, blockedBy: [a.id] });
    expect(f.ready().map((t) => t.id)).toEqual([a.id]);
    expect(code(() => f.claim(b.id, worker))).toBe("blocked");
    expect(code(() => task(f, { blockedBy: ["T-9999"] }))).toBe("not_found");
  });

  test("events can't be edited or deleted", () => {
    const { f } = setup();
    task(f);
    expect(() => f.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => f.db.exec("DELETE FROM events")).toThrow(/append-only/);
  });
});

describe("leases", () => {
  test("an expired claim goes back to ready and someone else can take it", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker, 10);
    tick(11 * 60_000);
    const other: Actor = { name: "worker-2", kind: "agent" };
    expect(f.claim(null, other).assignee).toBe("worker-2");
    expect(f.events(t.id).some((e) => e.type === "lease_expired")).toBe(true);
  });

  test("heartbeat keeps a claim alive", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker, 10);
    tick(8 * 60_000);
    f.heartbeat(t.id, worker, 10);
    tick(8 * 60_000);
    expect(f.reclaim(human)).toEqual([]);
    expect(f.get(t.id).assignee).toBe("worker-1");
  });

  test("an expired verification goes back to in_review", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, verifier, 5);
    tick(6 * 60_000);
    expect(f.reclaim(human)).toEqual([t.id]);
    expect(f.get(t.id).status).toBe("in_review");
  });
});

test("reserve hands out each number once", () => {
  const { f } = setup();
  expect([f.reserve("migration", worker), f.reserve("migration", verifier), f.reserve("decision", worker)]).toEqual([1, 2, 1]);
});

describe("risk from paths (D0008)", () => {
  const passVerify = (f: Foreman, id: string) => {
    f.claim(id, worker);
    f.progress(id, worker, { branch: "b" });
    f.submit(id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(id, verifier);
    return f.recordVerify(id, verifier, f.get(id).acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" })));
  };

  test("default risk: auto, unless the declared paths may touch protected ones", () => {
    const { f } = setup();
    expect(f.create({ title: "a", paths: ["src/**"] }, human).risk).toBe("auto");
    expect(f.create({ title: "b" }, human).risk).toBe("auto");
    expect(f.create({ title: "c", paths: [".github/workflows/ci.yml"] }, human).risk).toBe("review");
    expect(f.create({ title: "d", paths: ["packages/x/.claude/**"] }, human).risk).toBe("review");
    expect(f.create({ title: "e", paths: ["**"] }, human).risk).toBe("review");
    expect(f.create({ title: "f", paths: ["src/**"], risk: "review" }, human).risk).toBe("review"); // given wins
  });

  test("auto + only unprotected files changed: approved", () => {
    const { f } = setup(["src/a.ts", "docs/x.md"]);
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    expect(passVerify(f, t.id).status).toBe("approved");
  });

  test("auto, but the branch really changed a protected file: escalated to a person", () => {
    const { f } = setup(["src/a.ts", ".claude/settings.json"]);
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    expect(passVerify(f, t.id).status).toBe("needs_approval");
    const ev = f.events(t.id).find((e) => e.type === "escalated");
    expect(ev?.data.files).toEqual([".claude/settings.json"]);
  });

  test("auto, but the diff can't be seen: escalated (fail closed)", () => {
    const { f } = setup(null);
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    expect(passVerify(f, t.id).status).toBe("needs_approval");
    expect(f.events(t.id).find((e) => e.type === "escalated")?.data.reason).toContain("couldn't see");
  });
});

describe("the PR decides, not the reported branch (T-0016)", () => {
  const { gitPolicy, GITHUB_PR } = require("../src/policy") as typeof import("../src/policy");
  const PR = "https://github.com/acme/app/pull/7";

  // A fake gh and git: the PR's files (one renamed), its head, and this repo's origin.
  const fakeRun = (files: string) => (cmd: string[]) => {
    if (cmd[0] === "gh" && cmd[1] === "api") return files;
    if (cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "view") return JSON.stringify({ headRefName: "clean", headRefOid: "abc123" });
    if (cmd[0] === "git" && cmd[1] === "remote") return "git@github.com:acme/app.git";
    return "";
  };

  test("a GitHub PR's own files are used, from the API; the recorded branch is ignored", () => {
    const calls: string[][] = [];
    const policy = gitPolicy("/repo", (cmd) => {
      calls.push(cmd);
      return fakeRun("src/a.ts\n.github/workflows/ci.yml")(cmd);
    });
    expect(policy.changedFiles({ branch: "an-empty-branch", pr: PR })).toEqual(["src/a.ts", ".github/workflows/ci.yml"]);
    expect(calls[0]!.slice(0, 4)).toEqual(["gh", "api", "--paginate", "repos/acme/app/pulls/7/files"]);
  });

  test("a protected file renamed away still counts: its old path is listed too", () => {
    // The API's jq prints filename, then previous_filename for renames.
    const policy = gitPolicy("/repo", fakeRun("docs/moved-settings.json\n.claude/settings.json"));
    const files = policy.changedFiles({ branch: "b", pr: PR })!;
    expect(files).toContain(".claude/settings.json");
  });

  test("gh failing means unknown, not clean", () => {
    expect(gitPolicy("/repo", () => null).changedFiles({ branch: "b", pr: PR })).toBeNull();
  });

  test("an auto task with a clean branch but a protected change in its PR is escalated", () => {
    let clock = 1;
    const policy = gitPolicy("/repo", fakeRun("AGENTS.md"));
    const f = new Foreman(openDb(":memory:"), null, () => ++clock, policy);
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch: "clean" });
    f.submit(t.id, worker, { pr: PR });
    f.startVerify(t.id, verifier);
    expect(f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status).toBe("needs_approval");
  });

  test("an empty diff escalates", () => {
    const { f } = setup([]);
    const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    f.startVerify(t.id, verifier);
    expect(f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "ok" }]).status).toBe("needs_approval");
  });

  test("GitHub PR URL shape", () => {
    expect(GITHUB_PR.test(PR)).toBe(true);
    expect(GITHUB_PR.test("https://example.com/pull/7")).toBe(false);
    expect(GITHUB_PR.test("https://github.com/acme/app/pull/7; rm x")).toBe(false);
  });
});
