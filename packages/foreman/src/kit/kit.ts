// What create, init and sync share: the kit's files, the record of what was installed
// (.foreman-kit/installed.json, D0018, D0026), and the kit's packages a project takes by version.
import { SCOPE, TEMPLATES, templateFiles, templateSettings } from "./install";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWN_TEMPLATES, VERSION } from "./paths";
import { FILE_PIECES, type Piece, pieceOfFile } from "./pieces";

export { CHECKOUT, OWN_TEMPLATES, PRESETS } from "./paths";
export const RECORD = join(".foreman-kit", "installed.json");
/** Where the record was before D0026. A project made then keeps it there until sync moves it (migrate.ts). */
export const LEGACY_RECORD = join(".meta-repo", "installed.json");
/** Where a project made before D0026 vendored the kit's packages, as tarballs named by content hash (D0018). Only sync's migration reads it. */
export const LEGACY_VENDOR = ".meta-repo/packages";
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
  action: "created" | "updated" | "merged" | "kept" | "moved" | "deleted" | "removed" | "skipped";
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

/** Write the record: where it is now (the pre-D0026 path until sync moves it), or `at`. */
export function writeInstalled(dir: string, rec: Installed, at = recordPath(dir)) {
  const files = Object.fromEntries(Object.entries(rec.files).sort(([a], [b]) => a.localeCompare(b)));
  const out = {
    $comment: "Written by foreman's create, init and sync: the hash of each kit file as installed, so sync can tell the project's changes from the kit's. Delete an entry to let sync restore a file you deleted.",
    source: rec.source,
    ...(rec.preset ? { preset: rec.preset } : {}),
    ...(rec.pieces ? { pieces: rec.pieces } : {}),
    files,
    ...(rec.hooks && Object.keys(rec.hooks).length ? { hooks: Object.fromEntries(Object.entries(rec.hooks).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
  write(dir, at, JSON.stringify(out, null, 2) + "\n");
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

const scopeRe = (scope: string) => scope.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The kit's packages a project can depend on. foreman itself is the person's own fm, never a dependency (D0026). */
export const KIT_PACKAGES = ["docs-check", "test-kit", "design-kit"] as const;

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
 * Point `<scope>/<pkg>` at a version from the registry instead of the workspace, editing only that
 * value so the file's formatting stays (D0020). Only a `workspace:` spec is rewritten.
 */
export function versionDep(packageJson: string, pkg: string, version: string): string {
  const re = new RegExp(`("${scopeRe(SCOPE)}/${pkg}"\\s*:\\s*)"workspace:[^"]*"`, "g");
  return packageJson.replace(re, `$1"${version}"`);
}

/** A dependency spec that is a version (`0.1.0`, `^0.1.0`, `~0.1.0-rc.1`): the only kind sync raises. */
const VERSION_SPEC = /^([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * Each `<scope>/<kit package>` given by a version lower than `version`, set to it as a text edit, so
 * the rest of package.json stays (D0020). A `^` or `~` is kept. Any other spec (`workspace:`, `file:`,
 * `link:`, a tag) is the project's own choice and left alone, and so is a higher version.
 */
export function raiseKitDeps(packageJson: string, version: string): { text: string; raised: string[] } {
  const raised: string[] = [];
  const re = new RegExp(`("(${scopeRe(SCOPE)}/(?:${KIT_PACKAGES.join("|")}))"\\s*:\\s*)"([^"]*)"`, "g");
  const text = packageJson.replace(re, (all, head: string, name: string, spec: string) => {
    const m = VERSION_SPEC.exec(spec);
    if (!m || Bun.semver.order(m[2]!, version) >= 0) return all;
    raised.push(`${name} ${spec} -> ${m[1]}${version}`);
    return `${head}"${m[1]}${version}"`;
  });
  return { text, raised };
}

/** The indent of a JSON file's first nested line, so a rewrite keeps its style (default two spaces). */
export const indentOf = (text: string) => /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";

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
