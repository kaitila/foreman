// The projects fm has seen: a list of absolute paths in <FOREMAN_HOME or ~/.config/foreman>/projects.json.
// `fm sync --all` walks it. A machine-wide file, so it holds paths only, never task data.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function registryPath(): string {
  return join(process.env.FOREMAN_HOME ?? join(homedir(), ".config", "foreman"), "projects.json");
}

export function listProjects(file = registryPath()): string[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a project. Best effort: a read-only home never breaks a command. */
export function recordProject(dir: string, file = registryPath()): void {
  try {
    const path = resolve(dir);
    const all = listProjects(file);
    if (all.includes(path)) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify([...all, path].sort(), null, 2)}\n`);
  } catch {}
}

export const stillThere = (dir: string) => existsSync(dir);
