// What create, init and sync share: the kit's files, the record of what was installed
// (.foreman-kit/installed.json, D0018, D0026), and the kit's packages a preset app vendors.
import { SCOPE, TEMPLATES, templateFiles, templateSettings } from "./install";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OWN_TEMPLATES, packageDir, VERSION } from "./paths";
import { FILE_PIECES, type Piece, pieceOfFile } from "./pieces";

export { CHECKOUT, OWN_TEMPLATES, PRESETS } from "./paths";
export const RECORD = join(".foreman-kit", "installed.json");
/** Where the record was before D0026. A project made then keeps it there; moving it is sync's migration (T-0086). */
export const LEGACY_RECORD = join(".meta-repo", "installed.json");
/** Vendored kit packages, as tarballs named by content hash (D0018). */
export const VENDOR = ".meta-repo/packages";
/** The scope the kit's packages had before D0026. A project made then still depends on them by it. */
export const OLD_SCOPE = "@meta-repo";
export const SETTINGS = ".claude/settings.json";
export const MCP = ".mcp.json";
/** The foreman MCP server a project gets: the person's own fm, on their PATH (D0026). */
export const FOREMAN_SERVER = { type: "stdio", command: "fm", args: ["mcp"] };

export interface Installed {
  /** The kit version the files were last installed or synced from. */
  source: string;
  /** The preset the project was made from (create only). */
  preset?: string;
  /** The kit pieces the project has (D0026). Absent in a record from before pieces: it had guardrails and skills. */
  pieces?: Piece[];
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

/** The kit version a project's files come from: this package's version (D0032). */
export const source = (): string => VERSION;

/** The record's path in a project: the current one, or the pre-D0026 one if only that is there. */
export function recordPath(dir: string): string {
  return !existsSync(join(dir, RECORD)) && existsSync(join(dir, LEGACY_RECORD)) ? LEGACY_RECORD : RECORD;
}

/** The pieces whose kit files a record covers. */
export const filePieces = (rec: Installed): Piece[] => (rec.pieces ?? FILE_PIECES).filter((p) => FILE_PIECES.includes(p));

export function readInstalled(dir: string): Installed | null {
  const at = recordPath(dir);
  const file = join(dir, at);
  if (!existsSync(file)) return null;
  let data: Installed;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${at} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof data?.files !== "object" || data.files === null) throw new Error(`${at} has no "files" map`);
  return data;
}

export function writeInstalled(dir: string, rec: Installed) {
  const files = Object.fromEntries(Object.entries(rec.files).sort(([a], [b]) => a.localeCompare(b)));
  const out = {
    $comment: "Written by foreman's create, init and sync: the hash of each kit file as installed, so sync can tell the project's changes from the kit's. Delete an entry to let sync restore a file you deleted.",
    source: rec.source,
    ...(rec.preset ? { preset: rec.preset } : {}),
    ...(rec.pieces ? { pieces: rec.pieces } : {}),
    files,
    ...(rec.hooks && Object.keys(rec.hooks).length ? { hooks: Object.fromEntries(Object.entries(rec.hooks).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
  write(dir, recordPath(dir), JSON.stringify(out, null, 2) + "\n");
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

/**
 * agent-kit's template files by path, except settings.json, which is merged, never copied (D0014).
 * Only the files of `pieces` (default: every piece that has files).
 */
export function kitFiles(templates = TEMPLATES, pieces: Piece[] = FILE_PIECES): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const { src, rel } of templateFiles(templates)) {
    if (rel !== SETTINGS && pieces.includes(pieceOfFile(rel))) out.set(rel, readFileSync(src));
  }
  return out;
}

/** Hashes of the kit files of `pieces` the project now has exactly as the kit ships them. */
export function matchingKitFiles(dir: string, templates = TEMPLATES, pieces: Piece[] = FILE_PIECES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, data] of kitFiles(templates, pieces)) {
    const file = join(dir, path);
    if (existsSync(file) && sha256(readFileSync(file)) === sha256(data)) out[path] = sha256(data);
  }
  return out;
}

/** Can this copy of foreman vendor `<scope>/<pkg>`? foreman itself always; the others only from the checkout. */
export const canPack = (pkg: string) => packageDir(pkg) !== null;

/** `bun pm pack` a kit package: its tarball, named `<pkg>-<hash>.tgz` so a new version gets a new path. */
export function pack(pkg: string): { path: string; data: Uint8Array } {
  const cwd = packageDir(pkg);
  if (!cwd) throw new Error(`can't vendor ${SCOPE}/${pkg}: this foreman isn't run from its checkout, and only the checkout has the other kit packages`);
  const out = mkdtempSync(join(tmpdir(), "foreman-pack-"));
  try {
    const p = Bun.spawnSync(["bun", "pm", "pack", "--destination", out, "--quiet"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`bun pm pack failed in ${cwd}: ${p.stderr.toString()}`);
    const tgz = readdirSync(out).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`bun pm pack wrote no tarball for ${cwd}`);
    const data = readFileSync(join(out, tgz));
    return { path: `${VENDOR}/${pkg}-${sha256(data).slice(0, 12)}.tgz`, data };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const scopeRe = (scope: string) => scope.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The kit packages a package.json takes from the workspace (`"@foreman-kit/x": "workspace:*"`). */
export function workspaceDeps(packageJson: string): string[] {
  const pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
  const names = new Set<string>();
  const re = new RegExp(`^${scopeRe(SCOPE)}\\/([a-z0-9-]+)$`);
  for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[key] ?? {})) {
      const m = re.exec(dep);
      if (m && spec.startsWith("workspace:")) names.add(m[1]!);
    }
  }
  return [...names].sort();
}

/**
 * Point `<scope>/<pkg>` at a vendored tarball, editing only that value so the file's
 * formatting stays. Rewrites a `workspace:` spec or an earlier tarball of ours; leaves anything else.
 * A project made before D0026 names the package by OLD_SCOPE, and keeps that name.
 */
export function pointDep(packageJson: string, pkg: string, tarball: string): string {
  const scopes = `(?:${scopeRe(SCOPE)}|${scopeRe(OLD_SCOPE)})`;
  const re = new RegExp(`("${scopes}/${pkg}"\\s*:\\s*)"(workspace:[^"]*|file:\\.meta-repo/packages/${pkg}-[0-9a-f]+\\.tgz)"`, "g");
  return packageJson.replace(re, `$1"file:${tarball}"`);
}

/**
 * Point `<scope>/<pkg>` at a version from the registry instead of the workspace, for a kit package
 * this copy can't vendor. Only a `workspace:` spec is rewritten.
 */
export function versionDep(packageJson: string, pkg: string, version: string): string {
  const re = new RegExp(`("${scopeRe(SCOPE)}/${pkg}"\\s*:\\s*)"workspace:[^"]*"`, "g");
  return packageJson.replace(re, `$1"${version}"`);
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
  const kit = JSON.parse(readFileSync(templateSettings(templates), "utf8"));
  for (const [event, groups] of hookGroups(kit)) {
    for (const g of groups) {
      const same = hookGroups(mine).find(([e]) => e === event)?.[1].find((m) => m.hooks.some((h) => h.command === g.hooks[0]?.command));
      if (same && matcherHash(same) === matcherHash(g)) out[hookKey(event, g)] = matcherHash(g);
    }
  }
  return out;
}
