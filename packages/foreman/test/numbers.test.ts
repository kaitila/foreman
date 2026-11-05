// reserve() counts numbers already on disk: by default decision files' names, or the
// source foreman.json's `numbers` names (one log file, or a glob of files).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { DEFAULT_PROTECTED, highestOnDisk, loadProtected } from "../src/policy";
import { openDb } from "../src/store";

const worker: Actor = { name: "worker-1", kind: "agent" };
const base = mkdtempSync(join(tmpdir(), "foreman-numbers-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
/** A fresh repo root with these files (path → contents). */
function repo(files: Record<string, string>): string {
  const root = join(base, `r${n++}`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

const foreman = (root: string) =>
  new Foreman(openDb(":memory:"), root, Date.now, { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => null });

const numbers = (cfg: object) => JSON.stringify({ numbers: cfg });

const LOG = ["# Decisions", "", ...[1, 2, 3, 4, 5, 6, 7].map((i) => `## D${i}. Choice ${i}\n\nWhy.\n`)].join("\n");

test("default: decision numbers come from docs/decisions file names", () => {
  const root = repo({ "docs/decisions/D0003-x.md": "", "docs/decisions/D0012-y.md": "", "docs/decisions/README.md": "D0099" });
  const f = foreman(root);
  expect([f.reserve("decision", worker), f.reserve("decision", worker)]).toEqual([13, 14]);
});

test("default: no decisions folder starts at 1; other kinds don't look at disk", () => {
  const f = foreman(repo({ "docs/decisions/D0005-x.md": "" }));
  expect(f.reserve("migration", worker)).toBe(1);
  expect(foreman(repo({})).reserve("decision", worker)).toBe(1);
});

test("a single-file log of D1..D7: reserve gives D8, then D9", () => {
  const root = repo({
    "docs/decisions.md": LOG,
    "foreman.json": numbers({ decision: { file: "docs/decisions.md", pattern: "^## D(\\d+)\\." } }),
  });
  const f = foreman(root);
  expect([f.reserve("decision", worker), f.reserve("decision", worker)]).toEqual([8, 9]);
});

test("the file pattern is multiline and only lines that match count", () => {
  const root = repo({
    "log.md": "## D3. a\nsee D40 in passing\n## D11. b\n  ## D50. indented\n",
    "foreman.json": numbers({ decision: { file: "log.md", pattern: "^## D(\\d+)\\." } }),
  });
  expect(highestOnDisk(root, "decision")).toBe(11);
});

test("a configured source replaces the default, and works for any kind", () => {
  const root = repo({
    "docs/decisions/D0020-old.md": "",
    "docs/decisions.md": "## D4. x\n",
    "db/0007_users.sql": "",
    "db/0002_init.sql": "",
    "foreman.json": numbers({
      decision: { file: "docs/decisions.md", pattern: "^## D(\\d+)\\." },
      migration: { glob: "db/*.sql", pattern: "^(\\d+)_" },
    }),
  });
  const f = foreman(root);
  expect(f.reserve("decision", worker)).toBe(5); // not 21: the folder isn't the source any more
  expect(f.reserve("migration", worker)).toBe(8);
});

test("glob source: the pattern runs on each matched file's name", () => {
  const root = repo({
    "adr/0009-a.md": "",
    "adr/nested/0030-b.md": "",
    "foreman.json": numbers({ decision: { glob: "adr/*.md", pattern: "^(\\d+)-" } }),
  });
  expect(highestOnDisk(root, "decision")).toBe(9);
});

test("earlier reservations still count when they're ahead of the disk", () => {
  const root = repo({ "log.md": "## D2. x\n", "foreman.json": numbers({ decision: { file: "log.md", pattern: "^## D(\\d+)\\." } }) });
  const f = foreman(root);
  expect(f.reserve("decision", worker)).toBe(3);
  writeFileSync(join(root, "log.md"), "## D1. x\n"); // the log shrank (e.g. another branch)
  expect(f.reserve("decision", worker)).toBe(4);
  writeFileSync(join(root, "log.md"), "## D10. x\n"); // or grew past the reservations
  expect(f.reserve("decision", worker)).toBe(11);
});

test("a missing log file is refused, naming the path, and takes no number", () => {
  const root = repo({ "foreman.json": numbers({ decision: { file: "docs/nope.md", pattern: "^## D(\\d+)" } }) });
  const f = foreman(root);
  let err: unknown;
  try {
    f.reserve("decision", worker);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ForemanError);
  expect((err as ForemanError).code).toBe("invalid");
  expect((err as Error).message).toContain("numbers.decision");
  expect((err as Error).message).toContain("docs/nope.md");
  // Once the file is there, numbering follows it: the refusal reserved nothing.
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "nope.md"), "## D4. x\n");
  expect(f.reserve("decision", worker)).toBe(5);
});

test("a log path that is a folder is refused, naming the path", () => {
  const root = repo({ "logdir/x": "", "foreman.json": numbers({ decision: { file: "logdir", pattern: "^## D(\\d+)" } }) });
  expect(() => foreman(root).reserve("decision", worker)).toThrow(/numbers\.decision.*logdir/);
});

test("a glob that matches nothing still counts as empty", () => {
  const root = repo({ "foreman.json": numbers({ migration: { glob: "db/*.sql", pattern: "^(\\d+)_" } }) });
  expect(foreman(root).reserve("migration", worker)).toBe(1);
});

test("a bad numbers entry is refused with a clear message", () => {
  const bad = [
    { pattern: "^D(\\d+)" }, // no source
    { file: "a.md", glob: "*.md", pattern: "^D(\\d+)" }, // both
    { file: "a.md" }, // no pattern
    { file: "a.md", pattern: "^D\\d+" }, // no capture group
    { file: "a.md", pattern: "^D(\\d+" }, // not a regex
  ];
  for (const entry of bad) {
    const f = foreman(repo({ "a.md": "D1", "foreman.json": numbers({ decision: entry }) }));
    let err: unknown;
    try {
      f.reserve("decision", worker);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForemanError);
    expect((err as ForemanError).code).toBe("invalid");
    expect((err as Error).message).toContain("numbers.decision");
  }
});

test("protectedPaths still load alongside numbers", () => {
  const root = repo({ "foreman.json": JSON.stringify({ protectedPaths: ["src/**"], numbers: {} }) });
  expect(loadProtected(root)).toEqual(["src/**", "foreman.json"]);
  expect(loadProtected(repo({ "foreman.json": numbers({}) }))).toEqual(DEFAULT_PROTECTED);
  expect(loadProtected(null)).toEqual(DEFAULT_PROTECTED);
});

test("foreman.json comes from origin/main, not a stale working tree", () => {
  const root = repo({});
  const sh = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: root });
  sh("init", "-q");
  sh("commit", "-q", "--allow-empty", "-m", "empty");
  writeFileSync(
    join(root, "foreman.json"),
    JSON.stringify({ protectedPaths: ["secret/**"], numbers: { adr: { glob: "adr/*", pattern: "^(\\d+)" } } }),
  );
  mkdirSync(join(root, "adr"));
  writeFileSync(join(root, "adr/0009-x"), "");
  sh("add", ".");
  sh("commit", "-q", "-m", "cfg");
  sh("update-ref", "refs/remotes/origin/main", "HEAD");
  sh("reset", "-q", "--hard", "HEAD~1"); // the checkout is now on a commit without foreman.json
  mkdirSync(join(root, "adr"));
  writeFileSync(join(root, "adr/0009-x"), "");
  expect(loadProtected(root)).toEqual(["secret/**", "foreman.json"]);
  expect(highestOnDisk(root, "adr")).toBe(9);
});
