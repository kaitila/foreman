// The release script (D0026): one version for every package, tags that match it, packs without tests.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentProblems, forbidden, packages, PUBLISHED, repositoryProblem, ROOT, setVersion, sharedVersion, tagProblem } from "../../../.github/scripts/release";

function fakeRepo(versions: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "release-"));
  for (const [dir, version] of Object.entries(versions)) {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), `{\n  "name": "@x/${dir}",\n  "version": "${version}",\n  "type": "module"\n}\n`);
  }
  return root;
}

describe("this repo's packages", () => {
  test("all share one version", () => {
    expect(() => sharedVersion()).not.toThrow();
  });

  test("every published package exists, and only private ones are left out", () => {
    const all = packages();
    for (const dir of PUBLISHED) expect(all.find((p) => p.dir === dir)?.private).toBe(false);
    for (const p of all) if (!PUBLISHED.includes(p.dir as never)) expect(p.private).toBe(true);
  });
});

describe("sharedVersion", () => {
  test("fails, naming each package, when versions differ", () => {
    const root = fakeRepo({ a: "1.0.0", b: "1.0.1" });
    expect(() => sharedVersion(root)).toThrow(/@x\/a: 1\.0\.0[\s\S]*@x\/b: 1\.0\.1/);
  });
});

describe("setVersion", () => {
  test("bumps every package together and keeps the layout", () => {
    const root = fakeRepo({ a: "0.1.0", b: "0.1.0" });
    expect(setVersion("0.2.0", root)).toHaveLength(2);
    expect(sharedVersion(root)).toBe("0.2.0");
    expect(readFileSync(join(root, "packages", "a", "package.json"), "utf8")).toBe(`{\n  "name": "@x/a",\n  "version": "0.2.0",\n  "type": "module"\n}\n`);
  });

  test("refuses something that isn't a version", () => {
    const root = fakeRepo({ a: "0.1.0" });
    expect(() => setVersion("v0.2", root)).toThrow(/not a version/);
  });
});

describe("tagProblem", () => {
  test("accepts v<version> only", () => {
    const root = fakeRepo({ a: "1.2.3", b: "1.2.3" });
    expect(tagProblem("v1.2.3", root)).toBeNull();
    expect(tagProblem("v1.2.4", root)).toMatch(/want v1\.2\.3/);
    expect(tagProblem("1.2.3", root)).not.toBeNull();
  });
});

describe("repository, for npm provenance", () => {
  const withRepository = (repository: unknown) => {
    const root = fakeRepo({ a: "1.0.0" });
    writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "@x/a", version: "1.0.0", repository }));
    return root;
  };
  const good = { type: "git", url: "git+https://github.com/owner/name.git", directory: "packages/a" };

  test("every published package names this repository and its own folder", () => {
    // In Actions this compares with the repository the workflow runs in, as npm will.
    for (const dir of PUBLISHED) expect(`${dir}: ${repositoryProblem(dir)}`).toBe(`${dir}: null`);
    const urls = PUBLISHED.map((dir) => JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")).repository.url);
    expect(new Set(urls).size).toBe(1);
  });

  test("a missing, foreign or mismatched repository is refused", () => {
    expect(repositoryProblem("a", "owner/name", withRepository(good))).toBeNull();
    expect(repositoryProblem("a", "Owner/Name", withRepository(good))).toBeNull();
    expect(repositoryProblem("a", undefined, withRepository(good))).toBeNull();
    expect(repositoryProblem("a", "owner/name", withRepository(undefined))).toContain("no repository.url");
    expect(repositoryProblem("a", "owner/name", withRepository("https://gitlab.com/owner/name"))).toContain("not a GitHub repository");
    expect(repositoryProblem("a", "owner/renamed", withRepository(good))).toContain("names owner/name, but this is owner/renamed");
    expect(repositoryProblem("a", "owner/name", withRepository({ ...good, directory: "packages/b" }))).toContain('want "packages/a"');
    expect(repositoryProblem("a", "owner/name", withRepository({ type: "git", url: good.url }))).toContain("repository.directory is missing");
  });
});

describe("pack contents", () => {
  test("tests, fixtures and .foreman are refused", () => {
    expect(forbidden(["src/a.ts", "test/a.ts", "src/a.test.ts", "src/fixtures/x.json", ".foreman/db.sqlite", "src/x/.foreman"]))
      .toEqual(["test/a.ts", "src/a.test.ts", "src/fixtures/x.json", ".foreman/db.sqlite", "src/x/.foreman"]);
  });

  test("package.json and README.md must be there", () => {
    expect(contentProblems(["package.json", "README.md", "src/index.ts"])).toEqual([]);
    expect(contentProblems(["src/index.ts"])).toEqual(["missing package.json", "missing README.md"]);
  });
});
