// Install agent-kit's templates into a repository (D0003, D0005).
// Never overwrites a file the project already has. The one exception is
// .claude/settings.json: its permission lists are merged (union), so a project
// keeps its own rules and gains the baseline's. Baseline rules the project
// listed in .claude/agent-kit.json's "omit" are never added back (D0014).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const TEMPLATES = join(import.meta.dir, "..", "templates");
/** The npm scope of foreman's packages. It lives with the hooks, which a project gets as standalone files. */
export { SCOPE } from "../templates/claude/hooks/scope";

/**
 * The kit keeps its .claude files under templates/claude/ (no dot): Claude Code treats any path
 * with a .claude/ segment as sensitive and won't let an unattended agent edit it (D0023).
 * A project gets them at .claude/. A templates dir laid out with .claude/ still works.
 */
export function installedPath(rel: string): string {
  return rel === "claude" || rel.startsWith("claude/") ? `.${rel}` : rel;
}

/** Where the kit's settings.json lives in a templates dir (either layout). */
export function templateSettings(templates = TEMPLATES): string {
  const plain = join(templates, "claude", "settings.json");
  return existsSync(plain) ? plain : join(templates, ".claude", "settings.json");
}

/** The kit's files: where each is in the templates dir, and where it goes in a project. */
export function templateFiles(templates = TEMPLATES): { src: string; rel: string }[] {
  return walk(templates).map((t) => ({ src: join(templates, t), rel: installedPath(t) }));
}
/** The project's record of baseline rules it removed on purpose. Not a template: init never writes it. */
export const OMIT_FILE = join(".claude", "agent-kit.json");

type Settings = { permissions?: Record<string, string[] | unknown> } & Record<string, unknown>;
type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

export interface InstallResult {
  created: string[];
  merged: string[]; // settings files whose permission lists gained rules
  kept: string[]; // files left alone because the project already has them
  omitted: string[]; // baseline rules not added because the project lists them in OMIT_FILE
  unmatchedOmit: string[]; // OMIT_FILE entries that match no baseline rule or hook command (usually typos)
}

/** The omit entries that name nothing in the baseline: not any permission rule (deny/ask/allow) nor any hook command. */
export function unmatchedOmit(baseline: Settings, omit: string[]): string[] {
  const known = new Set<string>();
  for (const key of ["deny", "ask", "allow"]) {
    for (const r of (baseline.permissions?.[key] as string[] | undefined) ?? []) known.add(r);
  }
  for (const groups of Object.values((baseline.hooks as Record<string, HookGroup[]>) ?? {})) {
    for (const g of groups) for (const h of g.hooks) known.add(h.command);
  }
  return [...new Set(omit)].filter((e) => !known.has(e));
}

/** Read OMIT_FILE's "omit" list: permission rules and hook commands. A file that's there but malformed throws. */
export function readOmit(target: string): string[] {
  const file = join(target, OMIT_FILE);
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${OMIT_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  const omit = (data as { omit?: unknown } | null)?.omit ?? [];
  if (!Array.isArray(omit) || !omit.every((r) => typeof r === "string")) {
    throw new Error(`${OMIT_FILE}: "omit" must be a list of strings (permission rules or hook commands)`);
  }
  return omit;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })) {
    out.push(entry);
  }
  return out.sort();
}

/**
 * Union of each permission list; the project's own order first, new rules after.
 * A baseline rule or hook command in `omit` is not added (the project keeps it if it has it itself).
 */
export function mergeSettings(
  project: Settings,
  baseline: Settings,
  omit: string[] = [],
): { settings: Settings; added: number; omitted: string[] } {
  const skip = new Set(omit);
  const omitted: string[] = [];
  const merged: Settings = { ...baseline, ...project };
  const perms: Record<string, unknown> = { ...(baseline.permissions ?? {}), ...(project.permissions ?? {}) };
  let added = 0;
  for (const key of ["deny", "ask", "allow"]) {
    const mine = (project.permissions?.[key] as string[] | undefined) ?? [];
    const theirs = (baseline.permissions?.[key] as string[] | undefined) ?? [];
    const missing = theirs.filter((r) => !mine.includes(r));
    const extra = missing.filter((r) => !skip.has(r));
    omitted.push(...missing.filter((r) => skip.has(r)));
    added += extra.length;
    if (mine.length || extra.length) perms[key] = [...mine, ...extra];
    else if (project.permissions?.[key] === undefined) delete perms[key]; // not the baseline's list via the spread
  }
  merged.permissions = perms;
  // Hooks: add each baseline hook group whose command the project doesn't run yet.
  const hooks: Record<string, HookGroup[]> = { ...((project.hooks as Record<string, HookGroup[]>) ?? {}) };
  for (const [event, groups] of Object.entries((baseline.hooks as Record<string, HookGroup[]>) ?? {})) {
    const mineGroups = hooks[event] ?? [];
    const have = new Set(mineGroups.flatMap((g) => g.hooks.map((h) => h.command)));
    const missing = groups.filter((g) => !g.hooks.every((h) => have.has(h.command)));
    const isOmitted = (g: HookGroup) => g.hooks.some((h) => skip.has(h.command));
    const extra = missing.filter((g) => !isOmitted(g));
    for (const g of missing.filter(isOmitted)) omitted.push(...g.hooks.map((h) => h.command).filter((c) => skip.has(c)));
    added += extra.length;
    if (mineGroups.length || extra.length) hooks[event] = [...mineGroups, ...extra];
  }
  if (Object.keys(hooks).length) merged.hooks = hooks;
  else if (project.hooks === undefined) delete merged.hooks;
  return { settings: merged, added, omitted };
}

export function install(target: string, templates = TEMPLATES): InstallResult {
  const result: InstallResult = { created: [], merged: [], kept: [], omitted: [], unmatchedOmit: [] };
  const omit = readOmit(target);
  for (const { src, rel } of templateFiles(templates)) {
    const dst = join(target, rel);
    const shown = relative(target, dst);
    if (rel === join(".claude", "settings.json") && (existsSync(dst) || omit.length)) {
      const fresh = !existsSync(dst);
      const base = JSON.parse(readFileSync(src, "utf8"));
      const { settings, added, omitted } = mergeSettings(fresh ? {} : JSON.parse(readFileSync(dst, "utf8")), base, omit);
      result.unmatchedOmit.push(...unmatchedOmit(base, omit));
      result.omitted.push(...omitted);
      if (fresh) {
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, JSON.stringify(settings, null, 2) + "\n");
        result.created.push(shown);
      } else if (added) {
        writeFileSync(dst, JSON.stringify(settings, null, 2) + "\n");
        result.merged.push(shown);
      } else result.kept.push(shown);
      continue;
    }
    if (existsSync(dst)) {
      result.kept.push(shown);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
    result.created.push(shown);
  }
  return result;
}
