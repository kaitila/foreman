// The per-user registry of repos foreman has seen (T-0071): a small JSON file the board reads
// to show every project on this machine. Local only: $FOREMAN_PROJECTS_FILE, else
// $XDG_CONFIG_HOME/foreman/projects.json, else ~/.config/foreman/projects.json.
// A registry entry is a directory and nothing more: the board opens its database and runs gh
// there, and never serves a file from it. Next to the list, `colors` maps a directory to the
// person's colour label for it (T-0089): one of LABEL_COLORS, shown on the board.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ForemanError } from "./core";
import { repoRoot } from "./store";

export function registryPath(env: Record<string, string | undefined> = process.env): string {
  if (env.FOREMAN_PROJECTS_FILE) return env.FOREMAN_PROJECTS_FILE;
  // Under `bun test` (NODE_ENV=test, inherited by the `fm` and `create` processes tests spawn) never
  // touch the person's real registry (T-0077): use a throwaway file unless a test names its own.
  if (env.NODE_ENV === "test") return join(tmpdir(), `foreman-test-registry-${process.getuid?.() ?? 0}`, "projects.json");
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "foreman", "projects.json");
}

/** The colour labels a project can carry; the board draws each from its own token. */
export const LABEL_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
export const isLabelColor = (c: unknown): c is LabelColor => typeof c === "string" && (LABEL_COLORS as readonly string[]).includes(c);

export interface Project {
  /** Unique within a list: the repo's folder name, with -2, -3 on a clash. */
  name: string;
  /** The repo's main checkout. */
  dir: string;
}

function readFile(file: string): { projects?: unknown; colors?: unknown } {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return j && typeof j === "object" ? (j as { projects?: unknown; colors?: unknown }) : {};
  } catch {
    return {};
  }
}

/** The registered directories, in the order they were added. A missing or damaged file is empty. */
export function readRegistry(file = registryPath()): string[] {
  const j = readFile(file);
  return Array.isArray(j.projects) ? j.projects.filter((d): d is string => typeof d === "string") : [];
}

/** Each directory's colour label. Unknown colours and malformed entries are left out. */
export function readColors(file = registryPath()): Record<string, LabelColor> {
  const c = readFile(file).colors;
  const out: Record<string, LabelColor> = {};
  if (c && typeof c === "object" && !Array.isArray(c)) for (const [dir, v] of Object.entries(c)) if (isLabelColor(v)) out[dir] = v;
  return out;
}

/** Writes the list, keeping the colour of every directory still on it. */
function writeRegistry(dirs: string[], file: string, colors = readColors(file)) {
  mkdirSync(dirname(file), { recursive: true });
  const kept: Record<string, LabelColor> = {};
  for (const d of dirs) if (colors[d]) kept[d] = colors[d];
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.keys(kept).length ? { projects: dirs, colors: kept } : { projects: dirs }, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Sets (or with null clears) the colour label of a registered directory. A directory that isn't
 * registered yet is added, so a board showing an unregistered repo can still label it.
 */
export function setColor(dir: string, color: LabelColor | null, file = registryPath()): void {
  const dirs = readRegistry(file);
  const colors = readColors(file);
  if (color) colors[dir] = color;
  else delete colors[dir];
  // Clearing never registers a directory; setting one does, so the label has somewhere to live.
  writeRegistry(color && !dirs.includes(dir) ? [...dirs, dir] : dirs, file, colors);
}

/**
 * Finds a registered project by the name `fm projects` lists, or by any directory inside it
 * (resolved to its repo root, as the registry stores it).
 */
export function findProject(nameOrDir: string, file = registryPath()): Project {
  const root = projectRoot(nameOrDir);
  const dir = "root" in root ? root.root : resolve(nameOrDir);
  const hit = listProjects(file).find((p) => p.dir === dir) ?? listProjects(file).find((p) => p.name === nameOrDir);
  if (!hit) throw new ForemanError("not_found", `no registered project "${nameOrDir}" (fm projects lists them)`);
  return hit;
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

/** Remember a project that may not have a foreman database yet (create, init, sync, setup). Best effort. */
export function recordProject(dir: string, file = registryPath()): void {
  try {
    const root = realpathSync(repoRoot(resolve(dir)));
    const dirs = readRegistry(file);
    if (!dirs.includes(root)) writeRegistry([...dirs, root], file);
  } catch {
    /* the registry is a convenience */
  }
}
