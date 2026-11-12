// One repo under two spellings is one project (T-0108): a registry that holds a repo under a
// symlinked path and under its real path lists it once, keeps its colour label, and `fm serve`
// shows it once and runs one merge-queue pass per tick for it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, findProject, listProjects, noteProject, pruneProjects, readColors, readRegistry, recordProject, removeProject, setColor } from "../src/projects";
import { openDb } from "../src/store";

const CLI = join(import.meta.dir, "../src/cli.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "fm-symlink-")));
// `link` is a symlink to `real`, as ~/.projects was to ~/projects.
mkdirSync(join(tmp, "real"));
symlinkSync(join(tmp, "real"), join(tmp, "link"));

/** A git repo with a .foreman database; returns its real path and its path through the symlink. */
function repo(name: string): { real: string; linked: string } {
  const real = join(tmp, "real", name);
  mkdirSync(real, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: real });
  openDb(join(real, ".foreman", "foreman.db")).close();
  return { real, linked: join(tmp, "link", name) };
}

let n = 0;
/** A registry file of its own, holding `j`. */
function registry(j: unknown): string {
  const dir = join(tmp, `registry-${++n}`);
  mkdirSync(dir);
  const file = join(dir, "projects.json");
  writeFileSync(file, JSON.stringify(j));
  return file;
}
const stored = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { projects: string[]; colors?: Record<string, string> };

describe("a registry holding one repo under a symlinked path and its real path", () => {
  test("lists one project, without the file being edited", () => {
    const a = repo("one"), b = repo("other");
    const file = registry({ projects: [a.linked, b.real, a.real] });
    expect(readRegistry(file)).toEqual([a.real, b.real]);
    expect(listProjects(file)).toEqual([{ name: "one", dir: a.real }, { name: "other", dir: b.real }]);
    expect(stored(file).projects).toEqual([a.linked, b.real, a.real]); // reading never writes
  });

  test("an entry stored only under the symlinked path is matched: add, note and record add nothing", () => {
    const a = repo("only-linked");
    const file = registry({ projects: [a.linked] });
    const before = readFileSync(file, "utf8");
    expect(addProject(a.real, file)).toBe(a.real);
    expect(addProject(a.linked, file)).toBe(a.real);
    noteProject(a.real, file);
    recordProject(a.linked, file);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(listProjects(file)).toEqual([{ name: "only-linked", dir: a.real }]);
  });

  test("the next write stores each repo once, under its real path", () => {
    const a = repo("rewrite"), b = repo("rewrite-new");
    const file = registry({ projects: [a.linked, a.real] });
    addProject(b.linked, file);
    expect(stored(file).projects).toEqual([a.real, b.real]);
  });

  test("an entry whose path is gone still lists as written, and prune removes it", () => {
    const a = repo("stays");
    const gone = join(tmp, "link", "gone");
    const file = registry({ projects: [gone, a.linked, gone] });
    expect(readRegistry(file)).toEqual([gone, a.real]);
    expect(findProject(gone, file)).toEqual({ name: "gone", dir: gone });
    expect(pruneProjects(file)).toEqual([gone]);
    expect(stored(file).projects).toEqual([a.real]);
  });
});

describe("colour labels under either spelling", () => {
  test("a label stored under the symlinked spelling still shows, and survives a write", () => {
    const a = repo("col"), b = repo("col-other");
    const file = registry({ projects: [a.linked, a.real], colors: { [a.linked]: "teal" } });
    expect(readColors(file)).toEqual({ [a.real]: "teal" });
    addProject(b.real, file);
    expect(stored(file)).toEqual({ projects: [a.real, b.real], colors: { [a.real]: "teal" } });
  });

  test("with a label under each spelling the real path's wins, whichever comes first", () => {
    const a = repo("col-both");
    expect(readColors(registry({ projects: [a.real], colors: { [a.linked]: "teal", [a.real]: "red" } }))).toEqual({ [a.real]: "red" });
    expect(readColors(registry({ projects: [a.real], colors: { [a.real]: "red", [a.linked]: "teal" } }))).toEqual({ [a.real]: "red" });
  });

  test("setColor through the symlink labels the one project, and clears it", () => {
    const a = repo("col-set");
    const file = registry({ projects: [a.real] });
    setColor(a.linked, "pink", file);
    expect(stored(file)).toEqual({ projects: [a.real], colors: { [a.real]: "pink" } });
    setColor(a.linked, null, file);
    expect(stored(file)).toEqual({ projects: [a.real] });
  });
});

describe("findProject and removeProject accept either spelling", () => {
  test("findProject by the symlinked path, the real path, a subfolder of either, or the name", () => {
    const a = repo("find");
    mkdirSync(join(a.real, "src"));
    const want = { name: "find", dir: a.real };
    for (const projects of [[a.linked], [a.real], [a.linked, a.real]]) {
      const file = registry({ projects });
      for (const how of [a.linked, a.real, join(a.linked, "src"), join(a.real, "src"), "find"]) expect(findProject(how, file)).toEqual(want);
    }
  });

  test("removeProject by either spelling removes the project and its label, whichever spelling is stored", () => {
    const a = repo("rm"), b = repo("rm-keep");
    for (const [storedAs, removeAs] of [[a.linked, a.real], [a.real, a.linked], [a.linked, a.linked]] as const) {
      const file = registry({ projects: [storedAs, b.real], colors: { [storedAs]: "red", [b.real]: "blue" } });
      expect(removeProject(removeAs, file)).toBe(a.real);
      expect(stored(file)).toEqual({ projects: [b.real], colors: { [b.real]: "blue" } });
    }
  });

  test("a stale entry whose own folder is gone is removed by the spelling it was stored under", () => {
    const a = repo("rm-stale");
    const file = registry({ projects: [a.linked] });
    renameSync(a.real, join(tmp, "real", "rm-stale-moved"));
    expect(removeProject(a.linked, file)).toBe(a.linked);
    expect(stored(file).projects).toEqual([]);
  });
});

describe("the CLI", () => {
  const procs: { kill(): void }[] = [];
  afterAll(() => {
    for (const p of procs) p.kill();
  });
  const env = (file: string) => {
    const e: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test", FOREMAN_PROJECTS_FILE: file };
    delete e.FOREMAN_DB;
    return e;
  };
  const fm = (file: string, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI, "projects", ...args], { cwd: tmp, env: env(file), stdin: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("fm projects lists the repo once, with the label set under the symlinked spelling", () => {
    const a = repo("cli-list");
    const file = registry({ projects: [a.linked, a.real], colors: { [a.linked]: "green" } });
    const r = fm(file, "list", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([{ name: "cli-list", dir: a.real, color: "green" }]);
  });

  test("fm projects color and rm accept either spelling", () => {
    const a = repo("cli-color");
    for (const [storedAs, given] of [[a.linked, a.real], [a.real, a.linked]] as const) {
      const file = registry({ projects: [storedAs] });
      const c = fm(file, "color", given, "orange");
      expect(c.err).toBe("");
      expect(c.out).toContain("cli-color: orange");
      expect(readColors(file)).toEqual({ [a.real]: "orange" });
      const rm = fm(file, "rm", given);
      expect(rm.code).toBe(0);
      expect(rm.out).toContain(`removed ${a.real}`);
      expect(stored(file)).toEqual({ projects: [] });
    }
  });

  test("fm serve --queue in that repo shows it once and runs one merge-queue pass per tick", async () => {
    const a = repo("served");
    const file = registry({ projects: [a.linked, a.real] });
    const proc = Bun.spawn(["bun", CLI, "serve", "--port", "0", "--queue", "--interval", "1"], { cwd: a.real, env: env(file), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    procs.push(proc);
    // Read until the second tick's pass has printed, then stop the board.
    let out = "";
    const passes = () => out.split("\n").filter((l) => l.includes("nothing approved"));
    const dec = new TextDecoder();
    const deadline = Date.now() + 20_000;
    const reader = proc.stdout.getReader();
    while (!(passes().length >= 2 && out.includes("foreman board:")) && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    proc.kill();
    await proc.exited;
    const lines = out.split("\n");
    // One project: its name alone, no served-2.
    expect(lines).toContain("projects: served");
    expect(out).not.toContain("served-2");
    // With two projects every pass line carries its project's name; one project's lines are bare.
    // Two ticks were read (the first at once, the next a second later): one pass each.
    expect(passes().length).toBeGreaterThanOrEqual(2);
    for (const l of passes()) expect(l).toBe("nothing approved");
  }, 30_000);
});
