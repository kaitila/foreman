// T-0064: a worker on a returning task is told why it came back; submit refuses a CONFLICTING PR.
import { describe, expect, test } from "bun:test";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { workerPrompt } from "../src/dispatch";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const PR = "https://github.com/acme/app/pull/7";
const wt = { path: "/tmp/wt", branch: "t-branch" };

function setup() {
  let clock = 1;
  const state = { mergeable: "MERGEABLE" };
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: () => ({ head: "t-branch", headSha: "aaaa1111", mergeable: state.mergeable }),
    originRepo: () => "acme/app",
  };
  const f = new Foreman(openDb(":memory:"), null, () => ++clock, policy);
  const t = f.create({ title: "x", acceptance: ["cmd: true", "statement: it works"], paths: ["src/**"], ready: true }, human);
  return { f, id: t.id, state };
}

const prompt = (f: Foreman, id: string) => workerPrompt(f.get(id), wt, f.events(id));

function toReview(f: Foreman, id: string) {
  f.claim(id, worker);
  f.progress(id, worker, { branch: "t-branch" });
  f.submit(id, worker, { pr: PR });
}

describe("worker prompt for a returning task", () => {
  test("a first run gets no return notes", () => {
    const { f, id } = setup();
    f.claim(id, worker);
    expect(prompt(f, id)).not.toContain("came back from review");
  });

  test("a rework reason is included", () => {
    const { f, id } = setup();
    toReview(f, id);
    f.rework(id, human, "type error in core.ts line 12");
    f.claim(id, worker);
    const p = prompt(f, id);
    expect(p).toContain("type error in core.ts line 12");
    expect(p).toContain("gh pr checks");
    expect(p).toContain("MERGEABLE");
  });

  test("a failed verdict lists each failed check with its evidence", () => {
    const { f, id } = setup();
    toReview(f, id);
    f.startVerify(id, verifier);
    f.recordVerify(id, verifier, [
      { check: "c1", pass: false, evidence: "bun test exited 1: TS2322 in dispatch.ts" },
      { check: "c2", pass: true, evidence: "fine" },
    ]);
    f.claim(id, worker);
    const p = prompt(f, id);
    expect(p).toContain("Failed check c1");
    expect(p).toContain("TS2322 in dispatch.ts");
    expect(p).not.toContain("Failed check c2");
  });

  test("a conflict send-back gets the merge-main instructions", () => {
    const { f, id, state } = setup();
    toReview(f, id);
    f.startVerify(id, verifier);
    f.recordVerify(id, verifier, f.get(id).acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" })));
    state.mergeable = "CONFLICTING";
    f.sendBackConflict(id, human);
    f.claim(id, worker);
    const p = prompt(f, id);
    expect(p).toContain("git merge origin/main");
    expect(p).toContain("reserve_number");
    expect(p).toContain("bun run check");
    expect(p).toContain("MERGEABLE");
  });
});

describe("submit and a conflicting PR", () => {
  test("refuses a CONFLICTING PR, accepts it once MERGEABLE", () => {
    const { f, id, state } = setup();
    f.claim(id, worker);
    f.progress(id, worker, { branch: "t-branch" });
    state.mergeable = "CONFLICTING";
    let code = "";
    try {
      f.submit(id, worker, { pr: PR });
    } catch (e) {
      code = (e as ForemanError).code;
    }
    expect(code).toBe("pr_conflicting");
    expect(f.get(id).status).not.toBe("in_review");
    state.mergeable = "MERGEABLE";
    expect(f.submit(id, worker, { pr: PR }).status).toBe("in_review");
  });
});
