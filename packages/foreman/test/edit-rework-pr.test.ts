// T-0009 (edit), T-0025 (rework), T-0017 (the PR must be this repo's, its branch the
// task's, and what merges what was verified).
import { describe, expect, test } from "bun:test";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { DEFAULT_PROTECTED, type Policy, prRepo, remoteRepo } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const other: Actor = { name: "worker-2", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };
const PR = "https://github.com/acme/app/pull/7";

function setup(gh: { origin?: string | null; head?: string; sha?: string; files?: string[] } = {}) {
  let clock = 1;
  const state = { sha: gh.sha ?? "aaaa1111", head: gh.head ?? "t-branch" };
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => gh.files ?? ["src/a.ts"],
    prInfo: (pr) => (pr.startsWith("https://github.com/") ? { head: state.head, headSha: state.sha } : null),
    originRepo: () => (gh.origin === undefined ? "acme/app" : gh.origin),
  };
  const f = new Foreman(openDb(":memory:"), null, () => ++clock, policy);
  return { f, state };
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

const ready = (f: Foreman, extra = {}) =>
  f.create({ title: "x", acceptance: ["cmd: true", "statement: it works"], paths: ["src/**"], ready: true, ...extra }, human);

function toApproved(f: Foreman, id: string, branch = "t-branch") {
  f.claim(id, worker);
  f.progress(id, worker, { branch });
  f.submit(id, worker, { pr: PR });
  f.startVerify(id, verifier);
  return f.recordVerify(id, verifier, passAll(f, id));
}

function passAll(f: Foreman, id: string) {
  return f.get(id).acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ok" }));
}

describe("edit (T-0009)", () => {
  test("before work starts, anything can change; new checks get new ids", () => {
    const { f } = setup();
    const t = ready(f);
    const e = f.edit(t.id, worker, { title: "y", addChecks: ["cmd: bun test"], removeChecks: ["c1"], paths: ["lib/**"] });
    expect(e.title).toBe("y");
    expect(e.acceptance.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(e.paths).toEqual(["lib/**"]);
    expect(f.events(t.id).at(-1)?.type).toBe("edited");
  });

  test("while working, the holder may only add paths; others may not touch it", () => {
    const { f } = setup();
    const t = ready(f);
    f.claim(t.id, worker);
    expect(f.edit(t.id, worker, { addPaths: ["docs/**"] }).paths).toEqual(["src/**", "docs/**"]);
    expect(code(() => f.edit(t.id, worker, { removeChecks: ["c2"] }))).toBe("in_progress");
    expect(code(() => f.edit(t.id, worker, { spec: "easier" }))).toBe("in_progress");
    expect(code(() => f.edit(t.id, other, { addPaths: ["x/**"] }))).toBe("not_holder");
    expect(f.edit(t.id, human, { spec: "a person may" }).spec).toBe("a person may");
  });

  test("nobody edits a task under review or done", () => {
    const { f } = setup();
    const t = ready(f);
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    expect(code(() => f.edit(t.id, human, { title: "z" }))).toBe("bad_status");
    f.startVerify(t.id, verifier);
    expect(code(() => f.edit(t.id, worker, { addPaths: ["x/**"] }))).toBe("bad_status");
  });

  test("only a person lowers risk; anyone raises it; a ready task keeps a check", () => {
    const { f } = setup();
    const t = ready(f, { risk: "review" });
    expect(code(() => f.edit(t.id, worker, { risk: "auto" }))).toBe("human_only");
    expect(f.edit(t.id, worker, { risk: "human" }).risk).toBe("human");
    expect(f.edit(t.id, human, { risk: "auto" }).risk).toBe("auto");
    expect(code(() => f.edit(t.id, human, { removeChecks: ["c1", "c2"] }))).toBe("invalid");
    expect(code(() => f.edit(t.id, human, { removeChecks: ["c9"] }))).toBe("invalid");
  });
});

describe("rework (T-0025)", () => {
  test("a worker sends a verified task back; it must be claimed and verified again", () => {
    const { f } = setup({ files: [".github/x.yml"] }); // protected: ends in needs_approval
    const t = ready(f);
    expect(toApproved(f, t.id).status).toBe("needs_approval");
    const r = f.rework(t.id, worker, "verifier found a gap");
    expect(r.status).toBe("ready");
    expect(f.events(t.id).at(-1)?.data).toEqual({ reason: "verifier found a gap", was: "needs_approval" });
    expect(code(() => f.approve(t.id, human))).toBe("bad_status"); // the old verdict no longer counts
    f.claim(t.id, worker);
    expect(f.get(t.id).status).toBe("claimed");
  });

  test("a person can send an approved task back; a stranger or an empty reason can't", () => {
    const { f } = setup();
    const t = ready(f);
    expect(toApproved(f, t.id).status).toBe("approved");
    expect(code(() => f.rework(t.id, other, "because"))).toBe("not_worker");
    expect(code(() => f.rework(t.id, worker, " "))).toBe("invalid");
    expect(f.rework(t.id, human, "wrong approach").status).toBe("ready");
  });

  test("not before submit, and not after merge", () => {
    const { f } = setup();
    const t = ready(f);
    f.claim(t.id, worker);
    expect(code(() => f.rework(t.id, worker, "x"))).toBe("bad_status");
    f.submit(t.id, worker, { pr: PR });
    expect(f.rework(t.id, worker, "more to do").status).toBe("ready");
  });
});

describe("the PR (T-0017)", () => {
  test("a PR from another repository is refused", () => {
    const { f } = setup();
    const t = ready(f);
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch: "t-branch" });
    expect(code(() => f.submit(t.id, worker, { pr: "https://github.com/someone/else/pull/1" }))).toBe("pr_mismatch");
    expect(f.submit(t.id, worker, { pr: PR }).status).toBe("in_review");
  });

  test("a PR whose head branch isn't the task's is refused", () => {
    const { f } = setup({ head: "some-clean-branch" });
    const t = ready(f);
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch: "t-branch" });
    expect(code(() => f.submit(t.id, worker, { pr: PR }))).toBe("pr_mismatch");
  });

  test("with no branch recorded, the PR's branch becomes the task's", () => {
    const { f } = setup({ head: "from-pr" });
    const t = ready(f);
    f.claim(t.id, worker);
    expect(f.submit(t.id, worker, { pr: PR }).branch).toBe("from-pr");
  });

  test("merging is refused when the PR moved after it was verified; rework, verify again, then it merges", () => {
    const { f, state } = setup();
    const t = ready(f);
    expect(toApproved(f, t.id).status).toBe("approved");
    state.sha = "bbbb2222"; // someone pushed after the verdict
    expect(code(() => f.merged(t.id, worker))).toBe("changed_after_verify");
    f.rework(t.id, worker, "pushed a fix after the verdict");
    expect(toApproved(f, t.id).status).toBe("approved");
    expect(f.merged(t.id, worker).status).toBe("done");
  });

  test("non-GitHub PR strings still work (local workflows)", () => {
    const { f } = setup({ origin: null });
    const t = ready(f);
    f.claim(t.id, worker);
    expect(f.submit(t.id, worker, { pr: "https://example.com/pull/12" }).status).toBe("in_review");
  });

  test("a GitHub PR that can't be checked is refused, not waved through", () => {
    const noOrigin = setup({ origin: null });
    const t1 = ready(noOrigin.f);
    noOrigin.f.claim(t1.id, worker);
    expect(code(() => noOrigin.f.submit(t1.id, worker, { pr: PR }))).toBe("pr_unverifiable");

    // gh missing or logged out: prInfo can't answer
    const { f } = setup();
    (f.policy as { prInfo?: unknown }).prInfo = () => null;
    const t2 = ready(f);
    f.claim(t2.id, worker);
    expect(code(() => f.submit(t2.id, worker, { pr: PR }))).toBe("pr_unverifiable");
  });

  test("merging is refused when the PR can't be looked up after it was verified", () => {
    const { f } = setup();
    const t = ready(f);
    expect(toApproved(f, t.id).status).toBe("approved");
    (f.policy as { prInfo?: unknown }).prInfo = () => null;
    expect(code(() => f.merged(t.id, worker))).toBe("pr_unverifiable");
  });

  test("a GitHub PR verified while gh was down can't be marked merged; rework and verify again (T-0028)", () => {
    const { f } = setup();
    const p = f.policy as { prInfo?: Policy["prInfo"] };
    const working = p.prInfo;
    const t = ready(f);
    f.claim(t.id, worker);
    f.progress(t.id, worker, { branch: "t-branch" });
    f.submit(t.id, worker, { pr: PR });
    f.startVerify(t.id, verifier);
    p.prInfo = () => null; // gh down at verdict time: no commit recorded
    const v = f.recordVerify(t.id, verifier, passAll(f, t.id));
    expect(v.status).toBe("approved");
    expect(f.events(t.id).find((e) => e.type === "verified")?.data.headSha).toBeUndefined();
    p.prInfo = working; // gh back: the PR looks fine, but the verdict wasn't about a known commit
    expect(code(() => f.merged(t.id, worker))).toBe("pr_unverifiable");
    expect(f.get(t.id).status).toBe("approved");
    f.rework(t.id, worker, "verdict recorded no commit");
    expect(toApproved(f, t.id).status).toBe("approved");
    expect(f.merged(t.id, worker).status).toBe("done");
  });

  test("a non-GitHub PR verified without a commit still merges (local workflows)", () => {
    const { f } = setup({ origin: null });
    const t = ready(f);
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "https://example.com/pull/12" });
    f.startVerify(t.id, verifier);
    expect(f.recordVerify(t.id, verifier, passAll(f, t.id)).status).toBe("approved");
    expect(f.merged(t.id, worker).status).toBe("done");
  });

  test("repo names from PR URLs and remotes", () => {
    expect(prRepo(PR)).toBe("acme/app");
    expect(prRepo("https://example.com/pull/7")).toBeNull();
    expect(remoteRepo("git@github.com:acme/app.git")).toBe("acme/app");
    expect(remoteRepo("https://github.com/acme/app.git")).toBe("acme/app");
    expect(remoteRepo("https://github.com/acme/app")).toBe("acme/app");
    expect(remoteRepo("https://gitlab.com/acme/app.git")).toBeNull();
  });
});

describe("merged() takes the verified PR only (T-0037)", () => {
  test("a different PR argument is refused; the same one, or none, is fine", () => {
    const { f } = setup();
    const t = ready(f);
    expect(toApproved(f, t.id).status).toBe("approved");
    expect(code(() => f.merged(t.id, worker, "https://example.com/pull/12"))).toBe("pr_mismatch");
    expect(code(() => f.merged(t.id, worker, "https://github.com/acme/app/pull/99"))).toBe("pr_mismatch");
    expect(f.get(t.id).status).toBe("approved");
    expect(f.merged(t.id, worker, PR).status).toBe("done");
  });
});
