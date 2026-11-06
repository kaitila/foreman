// T-0074: submit expands a bare PR number against the GitHub origin, refuses non-URLs and draft PRs.
import { describe, expect, test } from "bun:test";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };

function setup(origin: string | null, isDraft = false) {
  let clock = 1;
  const policy: Policy = {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: () => ({ head: "t-branch", headSha: "aaaa1111", mergeable: "MERGEABLE", isDraft }),
    originRepo: () => origin,
  };
  const f = new Foreman(openDb(":memory:"), null, () => ++clock, policy);
  const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { branch: "t-branch" });
  return { f, id: t.id };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "none";
};

describe("submit's PR argument", () => {
  for (const given of ["60", "#60", " #60 "]) {
    test(`'${given}' becomes the full URL for a GitHub origin`, () => {
      const { f, id } = setup("acme/app");
      expect(f.submit(id, worker, { pr: given }).pr).toBe("https://github.com/acme/app/pull/60");
    });
  }

  test("a bare number is refused with no GitHub origin", () => {
    for (const given of ["60", "#60"]) {
      const { f, id } = setup(null);
      expect(code(() => f.submit(id, worker, { pr: given }))).toBe("invalid");
      expect(f.get(id).status).not.toBe("in_review");
    }
  });

  test("something that isn't a URL is refused", () => {
    const { f, id } = setup("acme/app");
    expect(code(() => f.submit(id, worker, { pr: "my-pr" }))).toBe("invalid");
  });

  test("a draft PR is refused, naming gh pr ready", () => {
    const { f, id } = setup("acme/app", true);
    let msg = "";
    try {
      f.submit(id, worker, { pr: "https://github.com/acme/app/pull/7" });
    } catch (e) {
      msg = (e as ForemanError).message;
      expect((e as ForemanError).code).toBe("pr_draft");
    }
    expect(msg).toContain("gh pr ready");
  });
});
