// T-0077: tests must never write to the person's registry; `fm projects prune` drops dead entries.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, pruneProjects, readRegistry, registryPath } from "../src/projects";
import { openDb } from "../src/store";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fm-regiso-")));
const CLI = join(import.meta.dir, "../src/cli.ts");
const repo = (name: string) => {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  openDb(join(dir, ".foreman", "foreman.db")).close();
  return dir;
};

describe("registry isolation", () => {
  test("under test the default registry is not the person's", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const p = registryPath();
    // even when XDG_CONFIG_HOME points at a real config dir
    expect(registryPath({ NODE_ENV: "test", XDG_CONFIG_HOME: join(homedir(), ".config") }).startsWith(join(homedir(), ".config"))).toBe(false);
    expect(p.startsWith(join(homedir(), ".config"))).toBe(false);
    expect(p).toBe(registryPath({ NODE_ENV: "test" }));
    expect(p.startsWith(join(homedir(), ".config"))).toBe(false);
  });

  test("fm opening a database leaves a sentinel registry untouched", async () => {
    const home = join(tmp, "home");
    const sentinel = join(home, ".config", "foreman", "projects.json");
    mkdirSync(join(home, ".config", "foreman"), { recursive: true });
    writeFileSync(sentinel, '{"projects":["/sentinel"]}\n');
    const dir = repo("opened");
    const env = { ...process.env, HOME: home, FOREMAN_ACTOR: "x", FOREMAN_AGENT: "1" } as Record<string, string>;
    delete env.XDG_CONFIG_HOME;
    delete env.FOREMAN_PROJECTS_FILE;
    delete env.FOREMAN_DB;
    const r = Bun.spawnSync(["bun", CLI, "list"], { cwd: dir, env, stdin: "ignore" });
    expect(r.exitCode).toBe(0);
    expect(readRegistry(sentinel)).toEqual(["/sentinel"]);
    expect(await Bun.file(sentinel).text()).toBe('{"projects":["/sentinel"]}\n');
  });
});

describe("fm projects prune", () => {
  test("removes entries whose repo or database is gone, keeps the rest", () => {
    const file = join(tmp, "prune", "projects.json");
    const keep = repo("keep");
    const nodb = repo("nodb");
    addProject(keep, file);
    addProject(nodb, file);
    writeFileSync(file, JSON.stringify({ projects: [keep, nodb, join(tmp, "vanished")] }));
    Bun.spawnSync(["git", "-C", nodb, "rev-parse"]);
    Bun.spawnSync(["mv", join(nodb, ".foreman"), join(tmp, "moved")]);
    expect(pruneProjects(file).sort()).toEqual([nodb, join(tmp, "vanished")].sort());
    expect(readRegistry(file)).toEqual([keep]);
    expect(pruneProjects(file)).toEqual([]);
  });

  test("the CLI subcommand prunes", () => {
    const file = join(tmp, "cli", "projects.json");
    mkdirSync(join(tmp, "cli"), { recursive: true });
    writeFileSync(file, JSON.stringify({ projects: [join(tmp, "nowhere")] }));
    const r = Bun.spawnSync(["bun", CLI, "projects", "prune"], { cwd: tmp, env: { ...process.env, FOREMAN_PROJECTS_FILE: file }, stdin: "ignore" });
    expect(r.exitCode).toBe(0);
    expect(readRegistry(file)).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
