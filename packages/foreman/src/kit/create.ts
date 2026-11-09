// create: a new project from a preset, with every piece of the kit.
// init: foreman added to a repository that exists, plus the pieces it chooses; add: one more piece later (D0026).
// None of them overwrites a file the project has (settings.json is merged, D0014), and all
// record what they installed in .foreman-kit/installed.json so sync can update it later (D0018).
import { install, type InstallResult, SCOPE } from "./install";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { generate, NAME } from "./generate";
import {
  canPack,
  type Change,
  FOREMAN_SERVER,
  type Installed,
  matchingKitFiles,
  matchingKitHooks,
  MCP,
  OWN_TEMPLATES,
  ownTemplate,
  pack,
  pointDep,
  PRESETS,
  readInstalled,
  recordPath,
  sha256,
  source,
  write,
  writeInstalled,
  versionDep,
  writeOnce,
  workspaceDeps,
} from "./kit";
import { FILE_PIECES, type Piece, PIECE_INFO, PIECES } from "./pieces";

export const DEFAULT_PRESET = "bun-ts-postgres";
/** The CI workflow each preset's apps get; a preset that isn't listed gets the plain Bun one. */
const PRESET_CI: Record<string, string> = { "bun-ts-postgres": "ci-bun-postgres.yml" };
const CI_PATH = ".github/workflows/ci.yml";

export interface CreateOptions {
  preset?: string;
  name?: string;
  /** Run `bun install`, so the first commit has bun.lock (default true). */
  install?: boolean;
  /** git init and make the first commit (default true). */
  git?: boolean;
}

function fromInstall(r: InstallResult): Change[] {
  return [
    ...r.created.map((path): Change => ({ action: "created", path })),
    ...r.merged.map((path): Change => ({ action: "merged", path, note: "permission rules added" })),
    ...r.kept.map((path): Change => ({ action: "kept", path, note: "already there" })),
    ...r.omitted.map((rule): Change => ({ action: "skipped", path: rule, note: "listed in .claude/agent-kit.json" })),
    ...r.unmatchedOmit.map((e): Change => ({ action: "kept", path: ".claude/agent-kit.json", note: `warning: omit entry "${e}" matches no baseline rule or hook command` })),
  ];
}

function run(cmd: string[], cwd: string) {
  // The env is passed explicitly: Bun's default is the env at startup, not process.env now.
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${(p.stderr.toString() || p.stdout.toString()).trim()}`);
  return p.stdout.toString();
}

/** Each preset by name: its folder in the checkout, or its `<name>.json` in a packed foreman. */
function presetSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(PRESETS, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(PRESETS, e.name, "package.json"))) out.set(e.name, join(PRESETS, e.name));
    else if (e.isFile() && e.name.endsWith(".json")) out.set(e.name.slice(0, -5), join(PRESETS, e.name));
  }
  return out;
}

export function presets(): string[] {
  return [...presetSources().keys()].sort();
}

/** foreman.json for a new project: the template, plus the lowest foreman version it needs (D0026). */
function foremanJson(): string {
  const { $comment, ...rest } = JSON.parse(ownTemplate("foreman.json")) as Record<string, unknown>;
  return JSON.stringify({ $comment, foreman: `>=${source()}`, ...rest }, null, 2) + "\n";
}

export function create(dir: string, opts: CreateOptions = {}): Change[] {
  const target = resolve(dir);
  const preset = opts.preset ?? DEFAULT_PRESET;
  const name = opts.name ?? basename(target);
  if (!presets().includes(preset)) throw new Error(`unknown preset "${preset}" (have: ${presets().join(", ")})`);
  if (!NAME.test(name)) throw new Error(`name must be lower-case letters, digits and dashes, starting with a letter: "${name}" (pass --name)`);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${dir} is not empty (use init to add the kit to a repository)`);
  // Checked before anything is written, so a missing identity doesn't leave a half-made project.
  if (opts.git !== false && Bun.spawnSync(["git", "var", "GIT_AUTHOR_IDENT"], { cwd: OWN_TEMPLATES, env: { ...process.env }, stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new Error("git has no user.name/user.email for the first commit (set them, or pass --no-git)");
  }

  const changes: Change[] = [];
  const files = generate(presetSources().get(preset)!, name);
  // The preset takes the kit's packages from the workspace; outside it they're vendored (D0018).
  const vendored: Record<string, string> = {};
  let pkgJson = files.get("package.json")!;
  for (const pkg of workspaceDeps(pkgJson)) {
    if (!canPack(pkg)) {
      // An installed foreman can't pack the other kit packages; they come from the registry (D0032).
      pkgJson = versionDep(pkgJson, pkg, source());
      changes.push({ action: "skipped", path: `${SCOPE}/${pkg}`, note: `not vendored (no foreman checkout): package.json takes ${source()} from the registry` });
      continue;
    }
    const { path, data } = pack(pkg);
    write(target, path, data);
    vendored[path] = sha256(data);
    pkgJson = pointDep(pkgJson, pkg, path);
    changes.push({ action: "created", path, note: `${SCOPE}/${pkg}, vendored` });
  }
  files.set("package.json", pkgJson);
  for (const [path, text] of files) write(target, path, text);
  changes.push({ action: "created", path: `${files.size} files`, note: `from preset ${preset}` });

  changes.push(...fromInstall(install(target)));
  writeOnce(target, "foreman.json", foremanJson(), changes);
  const db = name.replace(/\W/g, "_");
  writeOnce(target, CI_PATH, ownTemplate(PRESET_CI[preset] ?? "ci-bun.yml").replaceAll("{{db}}", db), changes);
  writeInstalled(target, { source: source(), preset, pieces: [...PIECES], files: { ...matchingKitFiles(target), ...vendored }, hooks: matchingKitHooks(target) });
  changes.push({ action: "created", path: recordPath(target) });

  if (opts.install !== false) {
    run(["bun", "install"], target);
    changes.push({ action: "created", path: "bun.lock", note: "bun install" });
  }
  if (opts.git !== false) {
    run(["git", "init", "-q", "-b", "main"], target);
    run(["git", "add", "-A"], target);
    run(["git", "commit", "-q", "-m", `Start ${name} from the foreman ${preset} preset (${source()})`], target);
    changes.push({ action: "created", path: ".git", note: "first commit on main" });
  }
  return changes;
}

export interface InitOptions {
  /** For the AGENTS.md skeleton's heading (default the folder's name). */
  name?: string;
  today?: Date;
  /** The kit pieces to add besides foreman (default none). */
  pieces?: Piece[];
  /** --all: every piece that fits the repo. A piece that needs package.json is skipped without one, not refused. */
  all?: boolean;
}

/** Does the repo already record decisions: per foreman.json's `numbers.decision` source when it has one, else as D*.md files or a log whose headings are `## Dnn.`? */
function hasDecisions(target: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(target, "foreman.json"), "utf8")) as { numbers?: { decision?: { file?: string; glob?: string; pattern?: string } } };
    const src = cfg.numbers?.decision;
    if (src?.pattern) {
      const re = new RegExp(src.pattern, "m");
      if (src.file) {
        const f = join(target, src.file);
        if (existsSync(f) && re.test(readFileSync(f, "utf8"))) return true;
      } else if (src.glob) {
        if ([...new Bun.Glob(src.glob).scanSync({ cwd: target })].some((p) => re.test(p.split("/").pop()!))) return true;
      }
    }
  } catch {
    // no foreman.json, or one we can't read: fall through to looking at the folder
  }
  const decisions = join(target, "docs", "decisions");
  if (!existsSync(decisions)) return false;
  return readdirSync(decisions).some((f) => {
    if (/^D\d+-.*\.md$/.test(f)) return true;
    if (!f.endsWith(".md") || f === "README.md") return false;
    try {
      return /^#{1,6}\s+D\d+\b/m.test(readFileSync(join(decisions, f), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * The pieces to add, checked against the repo before anything is written: a piece that needs
 * package.json is refused without one, unless `all` (then it's skipped and said so).
 */
function choosePieces(target: string, want: Piece[], all: boolean, changes: Change[]): Piece[] {
  const hasPkg = existsSync(join(target, "package.json"));
  const out: Piece[] = [];
  for (const p of all ? PIECES : PIECES.filter((x) => want.includes(x))) {
    if (PIECE_INFO[p].needsPackageJson && !hasPkg) {
      if (!all) throw new Error(`the ${p} piece needs a package.json, and this repo has none (leave it out, or add package.json first)`);
      changes.push({ action: "skipped", path: p, note: "needs a package.json" });
      continue;
    }
    out.push(p);
  }
  return out;
}

export function init(dir: string, opts: InitOptions = {}): Change[] {
  const target = resolve(dir);
  if (!existsSync(join(target, ".git"))) throw new Error(`${dir} is not a git repository (use create for a new project)`);
  if (readInstalled(target)) throw new Error(`${recordPath(target)} is already there: foreman is set up (init --with <piece> adds a piece, sync updates the kit)`);
  // Read up front, so a malformed file stops init before anything is written.
  readPackageJson(target);
  const mcpText = readIfThere(target, MCP);
  const mcp = mcpText === null ? null : parseJson<McpJson>(mcpText, MCP);
  if (mcp?.mcpServers !== undefined && !isObject(mcp.mcpServers)) throw new Error(`${MCP}: "mcpServers" is not a JSON object`);
  const changes: Change[] = [];
  const pieces = choosePieces(target, opts.pieces ?? [], opts.all ?? false, changes);

  const rec: Installed = { source: source(), pieces: [], files: {}, hooks: {} };
  // docs first: its AGENTS.md skeleton is what the Tasks section is appended to.
  if (pieces.includes("docs")) addPiece(target, "docs", rec, opts, changes);
  addForeman(target, mcp, mcpText, changes);
  for (const p of pieces.filter((x) => x !== "docs")) addPiece(target, p, rec, opts, changes);
  if (!pieces.length) changes.push({ action: "skipped", path: "pieces", note: `foreman only; add more with fm add <piece> (${PIECES.join(", ")})` });

  writeInstalled(target, rec);
  changes.push({ action: "created", path: recordPath(target) });
  return changes;
}

/** More pieces for a repo that already has foreman (`init --with` there), with init's never-overwrite rules. */
export function add(dir: string, want: Piece[], opts: { today?: Date; name?: string; all?: boolean } = {}): Change[] {
  const target = resolve(dir);
  const rec = readInstalled(target);
  if (!rec) throw new Error(`no ${recordPath(target)} here: set up foreman with init first`);
  if (!want.length) throw new Error(`name a piece to add (${PIECES.join(", ")})`);
  readPackageJson(target);
  const changes: Change[] = [];
  const had = rec.pieces ?? FILE_PIECES;
  rec.pieces = [...had];
  for (const p of choosePieces(target, want, opts.all ?? false, changes)) {
    if (had.includes(p)) changes.push({ action: "kept", path: p, note: "already added" });
    else addPiece(target, p, rec, opts, changes);
  }
  writeInstalled(target, rec);
  changes.push({ action: "updated", path: recordPath(target) });
  return changes;
}

/** One piece's files and packages, recorded in `rec`. */
function addPiece(target: string, piece: Piece, rec: Installed, opts: { today?: Date; name?: string }, changes: Change[]) {
  rec.pieces = PIECES.filter((p) => p === piece || rec.pieces?.includes(p));
  if (piece === "guardrails" || piece === "skills") {
    changes.push(...fromInstall(install(target, undefined, [piece])));
    Object.assign(rec.files, matchingKitFiles(target, undefined, [piece]));
    if (piece === "guardrails") rec.hooks = { ...rec.hooks, ...matchingKitHooks(target) };
  } else if (piece === "docs") {
    writeOnce(target, "AGENTS.md", ownTemplate("AGENTS.md").replaceAll("{{name}}", opts.name ?? basename(target)), changes);
    importAgents(target, changes);
    if (hasDecisions(target)) changes.push({ action: "kept", path: "docs/decisions/", note: "already has decisions" });
    else {
      const date = (opts.today ?? new Date()).toISOString().slice(0, 10);
      writeOnce(target, "docs/decisions/D0001-agent-kit.md", ownTemplate("D0001.md").replaceAll("{{date}}", date), changes);
    }
    if (existsSync(join(target, "package.json"))) {
      addKitPackage(target, "docs-check", rec, changes);
      addScript(target, "docs:check", "docs-check", changes);
    }
  } else if (piece === "ci") {
    // A CI workflow only if the repo has none, and only one that can pass: it runs `bun run check`.
    const workflows = join(target, ".github", "workflows");
    if (existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f))) changes.push({ action: "kept", path: ".github/workflows/", note: "already has a workflow" });
    else if (!readPackageJson(target)?.pkg.scripts?.check) changes.push({ action: "skipped", path: CI_PATH, note: "package.json has no check script for CI to run" });
    else writeOnce(target, CI_PATH, ownTemplate("ci-bun.yml"), changes);
  } else if (piece === "test-kit") addKitPackage(target, "test-kit", rec, changes);
  else if (piece === "design") addKitPackage(target, "design-kit", rec, changes);
}

const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type PackageJson = { scripts?: Record<string, string> } & Partial<Record<(typeof DEP_KEYS)[number], Record<string, string>>>;
type McpJson = { mcpServers?: Record<string, unknown> };

function readIfThere(dir: string, path: string): string | null {
  return existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;
}

/** The repo's package.json as text and parsed, or null without one. Throws if it isn't a JSON object. */
function readPackageJson(target: string): { text: string; pkg: PackageJson } | null {
  const text = readIfThere(target, "package.json");
  return text === null ? null : { text, pkg: parseJson<PackageJson>(text, "package.json") };
}

function parseJson<T>(text: string, path: string): T {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v as T;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A JSON object's text with one entry added to its `key` object (made if missing), so the rest of
 * the file (order, line endings, inline arrays) is untouched. Falls back to a JSON rewrite if the edit doesn't parse.
 */
function addEntry(text: string, key: string, name: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const ind = indentOf(text);
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  const block = new RegExp(`(${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*)\\{(\\s*)(\\}?)`).exec(text);
  let out: string;
  if (block) {
    const at = block.index + block[1]!.length + 1;
    out = block[3]
      ? `${text.slice(0, at)}${eol}${ind}${ind}${entry}${eol}${ind}${text.slice(at + block[2]!.length)}`
      : `${text.slice(0, at)}${eol}${ind}${ind}${entry},${text.slice(at)}`;
  } else {
    const end = text.lastIndexOf("}");
    const before = text.slice(0, end).replace(/\s*$/, "");
    const obj = `${ind}${JSON.stringify(key)}: {${eol}${ind}${ind}${entry}${eol}${ind}}${eol}`;
    out = `${before}${before.endsWith("{") ? "" : ","}${eol}${obj}${text.slice(end)}`;
  }
  try {
    const parsed = JSON.parse(out.replace(/^﻿/, "")) as Record<string, Record<string, string> | undefined>;
    if (parsed[key]?.[name] === value) return out;
  } catch {}
  const obj = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  obj[key] = { ...(obj[key] as Record<string, string> | undefined), [name]: value };
  return JSON.stringify(obj, null, ind) + eol;
}

/** package.json with one devDependency added as text (see addEntry). */
export const addDevDependency = (text: string, name: string, spec: string) => addEntry(text, "devDependencies", name, spec);

/** The indent of a JSON file's first nested line, so a rewrite keeps its style (default two spaces). */
const indentOf = (text: string) => /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/**
 * A kit package as a devDependency: vendored from the checkout (and recorded, so sync updates it),
 * or by version from the registry when this foreman is installed (D0032). Kept if the repo already depends on it.
 */
function addKitPackage(target: string, pkg: string, rec: Installed, changes: Change[]) {
  const name = `${SCOPE}/${pkg}`;
  const p = readPackageJson(target)!;
  if (DEP_KEYS.some((k) => p.pkg[k]?.[name] !== undefined)) return changes.push({ action: "kept", path: "package.json", note: `already depends on ${name}` });
  if (canPack(pkg)) {
    const { path, data } = pack(pkg);
    write(target, path, data);
    rec.files[path] = sha256(data);
    write(target, "package.json", addDevDependency(p.text, name, `file:${path}`));
    changes.push({ action: "created", path, note: `${name}, vendored` });
  } else write(target, "package.json", addDevDependency(p.text, name, source()));
  changes.push({ action: "merged", path: "package.json", note: `${name} added as a devDependency: run bun install` });
}

function addScript(target: string, script: string, cmd: string, changes: Change[]) {
  const p = readPackageJson(target)!;
  if (p.pkg.scripts?.[script] !== undefined) return changes.push({ action: "kept", path: "package.json", note: `already has a ${script} script` });
  write(target, "package.json", addEntry(p.text, "scripts", script, cmd));
  changes.push({ action: "merged", path: "package.json", note: `${script} script added` });
}

/** CLAUDE.md that imports AGENTS.md: created, or the import appended once. */
function importAgents(target: string, changes: Change[]) {
  if (writeOnce(target, "CLAUDE.md", "@AGENTS.md\n", changes)) return;
  const claude = join(target, "CLAUDE.md");
  const text = readFileSync(claude, "utf8");
  if (text.includes("@AGENTS.md")) return;
  writeFileSync(claude, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}@AGENTS.md\n`);
  changes.push({ action: "merged", path: "CLAUDE.md", note: "`@AGENTS.md` appended" });
}

/**
 * foreman itself, in any git repo (D0026): foreman.json, its MCP server (the person's own `fm`),
 * `.foreman/` ignored, and the Tasks section in AGENTS.md (made with only that section if there's none).
 */
function addForeman(target: string, mcp: McpJson | null, mcpText: string | null, changes: Change[]) {
  writeOnce(target, "foreman.json", foremanJson(), changes);

  if (!mcp || mcpText === null) writeOnce(target, MCP, JSON.stringify({ mcpServers: { foreman: FOREMAN_SERVER } }, null, 2) + "\n", changes);
  else if (mcp.mcpServers?.foreman !== undefined) changes.push({ action: "kept", path: MCP, note: "already has a foreman server" });
  else {
    // A small config file Claude Code reads: rewritten whole, keeping its indent.
    mcp.mcpServers = { ...mcp.mcpServers, foreman: FOREMAN_SERVER };
    const eol = mcpText.includes("\r\n") ? "\r\n" : "\n";
    write(target, MCP, (JSON.stringify(mcp, null, indentOf(mcpText)) + "\n").replaceAll("\n", eol));
    changes.push({ action: "merged", path: MCP, note: "foreman server added" });
  }

  const ignore = readIfThere(target, ".gitignore");
  if (ignore === null) writeOnce(target, ".gitignore", ".foreman/\n", changes);
  else if (/^\/?\.foreman\/?[ \t\r]*$/m.test(ignore)) changes.push({ action: "kept", path: ".gitignore", note: "already ignores .foreman/" });
  else {
    const eol = ignore.includes("\r\n") ? "\r\n" : "\n";
    write(target, ".gitignore", `${ignore}${ignore === "" || ignore.endsWith("\n") ? "" : eol}.foreman/${eol}`);
    changes.push({ action: "merged", path: ".gitignore", note: "`.foreman/` added" });
  }

  const agents = readIfThere(target, "AGENTS.md");
  if (agents === null) writeOnce(target, "AGENTS.md", ownTemplate("tasks-section.md"), changes);
  else if (/^## Tasks\b/m.test(agents)) changes.push({ action: "kept", path: "AGENTS.md", note: "already has a Tasks section" });
  else {
    write(target, "AGENTS.md", `${withNewline(agents)}\n${ownTemplate("tasks-section.md")}`);
    changes.push({ action: "merged", path: "AGENTS.md", note: "Tasks section appended (foreman)" });
  }
  importAgents(target, changes);
}
