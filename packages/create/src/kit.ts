// What create, init and sync share: the kit's files, the record of what was installed
// (.meta-repo/installed.json, D0018), and the meta-repo packages a preset app vendors.
import { TEMPLATES } from "@meta-repo/agent-kit";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The meta-repo checkout this package runs from. */
export const META_ROOT = join(import.meta.dir, "..", "..", "..");
export const PRESETS = join(META_ROOT, "presets");
export const OWN_TEMPLATES = join(import.meta.dir, "..", "templates");
export const RECORD = join(".meta-repo", "installed.json");
/** Vendored meta-repo packages, as tarballs named by content hash (D0018). */
export const VENDOR = ".meta-repo/packages";
export const SETTINGS = ".claude/settings.json";

export interface Installed {
  /** The meta-repo version the files were last installed or synced from. */
  source: string;
  /** The preset the project was made from (create only). */
  preset?: string;
  /** sha256 of each kit file as it was written, by path. */
  files: Record<string, string>;
  /** sha256 of each kit hook group's matcher as installed, by `<event>: <command>`. Absent in older records. */
  hooks?: Record<string, string>;
}

export interface Change {
  action: "created" | "updated" | "merged" | "kept" | "deleted" | "removed" | "skipped";
  path: string;
  note?: string;
}

export const sha256 = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** e.g. "0.1.0+8f3610f": this package's version and, in a git checkout, its commit. */
export function source(): string {
  const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: META_ROOT, stdout: "pipe", stderr: "ignore" });
  return git.exitCode === 0 ? `${version}+${git.stdout.toString().trim()}` : version;
}

export function readInstalled(dir: string): Installed | null {
  const file = join(dir, RECORD);
  if (!existsSync(file)) return null;
  let data: Installed;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${RECORD} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof data?.files !== "object" || data.files === null) throw new Error(`${RECORD} has no "files" map`);
  return data;
}

export function writeInstalled(dir: string, rec: Installed) {
  const files = Object.fromEntries(Object.entries(rec.files).sort(([a], [b]) => a.localeCompare(b)));
  const out = {
    $comment: "Written by meta-repo create, init and sync: the hash of each kit file as installed, so sync can tell the project's changes from the kit's. Delete an entry to let sync restore a file you deleted.",
    source: rec.source,
    ...(rec.preset ? { preset: rec.preset } : {}),
    files,
    ...(rec.hooks && Object.keys(rec.hooks).length ? { hooks: Object.fromEntries(Object.entries(rec.hooks).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
  write(dir, RECORD, JSON.stringify(out, null, 2) + "\n");
}

export function write(dir: string, path: string, data: Uint8Array | string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), data);
}

/** Write a file only if the project has none there. */
export function writeOnce(dir: string, path: string, data: string, changes: Change[]): boolean {
  if (existsSync(join(dir, path))) {
    changes.push({ action: "kept", path, note: "already there" });
    return false;
  }
  write(dir, path, data);
  changes.push({ action: "created", path });
  return true;
}

export const ownTemplate = (name: string) => readFileSync(join(OWN_TEMPLATES, name), "utf8");

/** agent-kit's template files by path, except settings.json, which is merged, never copied (D0014). */
export function kitFiles(templates = TEMPLATES): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const rel of [...new Bun.Glob("**/*").scanSync({ cwd: templates, dot: true, onlyFiles: true })].sort()) {
    if (rel !== SETTINGS) out.set(rel, readFileSync(join(templates, rel)));
  }
  return out;
}

/** Hashes of the kit files the project now has exactly as the kit ships them. */
export function matchingKitFiles(dir: string, templates = TEMPLATES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, data] of kitFiles(templates)) {
    const file = join(dir, path);
    if (existsSync(file) && sha256(readFileSync(file)) === sha256(data)) out[path] = sha256(data);
  }
  return out;
}

/** `bun pm pack` a meta-repo package: its tarball, named `<pkg>-<hash>.tgz` so a new version gets a new path. */
export function pack(pkg: string): { path: string; data: Uint8Array } {
  const cwd = join(META_ROOT, "packages", pkg);
  if (!existsSync(join(cwd, "package.json"))) throw new Error(`no meta-repo package "${pkg}" to vendor`);
  const out = mkdtempSync(join(tmpdir(), "meta-repo-pack-"));
  try {
    const p = Bun.spawnSync(["bun", "pm", "pack", "--destination", out, "--quiet"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`bun pm pack failed in packages/${pkg}: ${p.stderr.toString()}`);
    const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`bun pm pack wrote no tarball for packages/${pkg}`);
    const data = readFileSync(join(out, tgz));
    return { path: `${VENDOR}/${pkg}-${sha256(data).slice(0, 12)}.tgz`, data };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The meta-repo packages a package.json takes from the workspace (`"@meta-repo/x": "workspace:*"`). */
export function workspaceDeps(packageJson: string): string[] {
  const pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[key] ?? {})) {
      const m = /^@meta-repo\/([a-z0-9-]+)$/.exec(dep);
      if (m && spec.startsWith("workspace:")) names.add(m[1]!);
    }
  }
  return [...names].sort();
}

/**
 * Point `@meta-repo/<pkg>` at a vendored tarball, editing only that value so the file's
 * formatting stays. Rewrites a `workspace:` spec or an earlier tarball of ours; leaves anything else.
 */
export function pointDep(packageJson: string, pkg: string, tarball: string): string {
  const re = new RegExp(`("@meta-repo/${pkg}"\\s*:\\s*)"(workspace:[^"]*|file:\\.meta-repo/packages/${pkg}-[0-9a-f]+\\.tgz)"`, "g");
  return packageJson.replace(re, `$1"file:${tarball}"`);
}

/** Vendored package name from a tarball path under VENDOR. */
export const vendoredName = (path: string) => /^\.meta-repo\/packages\/([a-z0-9-]+)-[0-9a-f]+\.tgz$/.exec(path)?.[1];

export type HookGroup = { matcher?: string; hooks: { command: string }[] };
const hookGroups = (settings: { hooks?: unknown }) => Object.entries((settings.hooks ?? {}) as Record<string, HookGroup[]>);
/** Key of a hook group in the record: its event and first command. */
export const hookKey = (event: string, g: HookGroup) => `${event}: ${g.hooks[0]?.command ?? ""}`;
export const matcherHash = (g: HookGroup) => sha256(g.matcher ?? "");

/** Matcher hashes of the kit's hook groups the project has with the matcher the kit ships. */
export function matchingKitHooks(dir: string, templates = TEMPLATES): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(dir, SETTINGS);
  if (!existsSync(file)) return out;
  const mine = JSON.parse(readFileSync(file, "utf8"));
  const kit = JSON.parse(readFileSync(join(templates, SETTINGS), "utf8"));
  for (const [event, groups] of hookGroups(kit)) {
    for (const g of groups) {
      const same = hookGroups(mine).find(([e]) => e === event)?.[1].find((m) => m.hooks.some((h) => h.command === g.hooks[0]?.command));
      if (same && matcherHash(same) === matcherHash(g)) out[hookKey(event, g)] = matcherHash(g);
    }
  }
  return out;
}
