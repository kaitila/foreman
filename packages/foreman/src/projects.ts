// The per-user registry of repos foreman has seen (T-0071): a small JSON file the board reads
// to show every project on this machine. Local only: $FOREMAN_PROJECTS_FILE, else
// $XDG_CONFIG_HOME/foreman/projects.json, else ~/.config/foreman/projects.json.
// A registry entry is a directory and nothing more: the board opens its database and runs gh
// there, and never serves a file from it.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ForemanError } from "./core";
import { repoRoot } from "./store";

export function registryPath(env: Record<string, string | undefined> = process.env): string {
  if (env.FOREMAN_PROJECTS_FILE) return env.FOREMAN_PROJECTS_FILE;
  // Under `bun test` (NODE_ENV=test, inherited by the `fm` and `create` processes tests spawn) never
  // touch the person's real registry (T-0077): use a throwaway file unless a test names its own.
  if (env.NODE_ENV === "test" && !env.XDG_CONFIG_HOME) return join(tmpdir(), `foreman-test-registry-${process.getuid?.() ?? 0}`, "projects.json");
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "foreman", "projects.json");
}

export interface Project {
  /** Unique within a list: the repo's folder name, with -2, -3 on a clash. */
  name: string;
  /** The repo's main checkout. */
  dir: string;
}

/** The registered directories, in the order they were added. A missing or damaged file is empty. */
export function readRegistry(file = registryPath()): string[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { projects?: unknown };
    return Array.isArray(j.projects) ? j.projects.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(dirs: string[], file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ projects: dirs }, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The repo root for `dir` if it is a git repo with a .foreman database; otherwise why not. */
export function projectRoot(dir: string): { root: string } | { error: string } {
  let root: string;
  try {
    root = realpathSync(repoRoot(resolve(dir)));
  } catch {
    return { error: `${dir} is not inside a git repository` };
  }
  if (!existsSync(join(root, ".foreman", "foreman.db"))) return { error: `${root} has no .foreman database (run fm there once)` };
  return { root };
}

/** Names for `dirs`: the folder name, made unique with -2, -3 in order. */
export function nameProjects(dirs: string[]): Project[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    const base = basename(dir).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return { name, dir };
  });
}

export function listProjects(file = registryPath()): Project[] {
  return nameProjects(readRegistry(file));
}

/** Adds the repo containing `dir`. Throws if it isn't a git repo with a foreman database. */
export function addProject(dir: string, file = registryPath()): string {
  const p = projectRoot(dir);
  if ("error" in p) throw new ForemanError("invalid", p.error);
  const dirs = readRegistry(file);
  if (!dirs.includes(p.root)) writeRegistry([...dirs, p.root], file);
  return p.root;
}

/** Removes by name or directory; returns the directory removed. */
export function removeProject(nameOrDir: string, file = registryPath()): string {
  const dirs = readRegistry(file);
  const hit = nameProjects(dirs).find((p) => p.name === nameOrDir || p.dir === resolve(nameOrDir));
  if (!hit) throw new ForemanError("not_found", `no registered project "${nameOrDir}"`);
  writeRegistry(dirs.filter((d) => d !== hit.dir), file);
  return hit.dir;
}

/** Drops entries whose repo or database is gone; returns the directories removed. */
export function pruneProjects(file = registryPath()): string[] {
  const dirs = readRegistry(file);
  const gone = dirs.filter((d) => "error" in projectRoot(d));
  if (gone.length) writeRegistry(dirs.filter((d) => !gone.includes(d)), file);
  return gone;
}

/** Best effort, for when a database is opened: never fails the command. */
export function noteProject(cwd: string, file = registryPath()): void {
  try {
    const p = projectRoot(cwd);
    if ("root" in p && !readRegistry(file).includes(p.root)) writeRegistry([...readRegistry(file), p.root], file);
  } catch {
    /* the registry is a convenience */
  }
}
