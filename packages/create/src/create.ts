// create: a new project from a preset. init: the kit added to a repository that exists.
// Both never overwrite a file the project has (settings.json is merged, D0014), and both
// record what they installed in .meta-repo/installed.json so sync can update it later (D0018).
import { install, type InstallResult } from "@meta-repo/agent-kit";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { generate, NAME } from "../../../presets/generate";
import {
  type Change,
  FOREMAN_SERVER,
  matchingKitFiles,
  MCP,
  ownTemplate,
  pack,
  pointDep,
  PRESETS,
  RECORD,
  readInstalled,
  sha256,
  source,
  write,
  writeInstalled,
  writeOnce,
  workspaceDeps,
} from "./kit";

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
  ];
}

function run(cmd: string[], cwd: string) {
  // The env is passed explicitly: Bun's default is the env at startup, not process.env now.
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${(p.stderr.toString() || p.stdout.toString()).trim()}`);
  return p.stdout.toString();
}

export function presets(): string[] {
  return readdirSync(PRESETS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PRESETS, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

export function create(dir: string, opts: CreateOptions = {}): Change[] {
  const target = resolve(dir);
  const preset = opts.preset ?? DEFAULT_PRESET;
  const name = opts.name ?? basename(target);
  if (!presets().includes(preset)) throw new Error(`unknown preset "${preset}" (have: ${presets().join(", ")})`);
  if (!NAME.test(name)) throw new Error(`name must be lower-case letters, digits and dashes, starting with a letter: "${name}" (pass --name)`);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${dir} is not empty (use init to add the kit to a repository)`);
  // Checked before anything is written, so a missing identity doesn't leave a half-made project.
  if (opts.git !== false && Bun.spawnSync(["git", "var", "GIT_AUTHOR_IDENT"], { cwd: PRESETS, env: { ...process.env }, stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    throw new Error("git has no user.name/user.email for the first commit (set them, or pass --no-git)");
  }

  const changes: Change[] = [];
  const files = generate(join(PRESETS, preset), name);
  // The preset takes meta-repo packages from the workspace; outside it they're vendored (D0018).
  const vendored: Record<string, string> = {};
  let pkgJson = files.get("package.json")!;
  for (const pkg of workspaceDeps(pkgJson)) {
    const { path, data } = pack(pkg);
    write(target, path, data);
    vendored[path] = sha256(data);
    pkgJson = pointDep(pkgJson, pkg, path);
    changes.push({ action: "created", path, note: `@meta-repo/${pkg}, vendored` });
  }
  files.set("package.json", pkgJson);
  for (const [path, text] of files) write(target, path, text);
  changes.push({ action: "created", path: `${files.size} files`, note: `from preset ${preset}` });

  changes.push(...fromInstall(install(target)));
  writeOnce(target, "foreman.json", ownTemplate("foreman.json"), changes);
  const db = name.replace(/\W/g, "_");
  writeOnce(target, CI_PATH, ownTemplate(PRESET_CI[preset] ?? "ci-bun.yml").replaceAll("{{db}}", db), changes);
  writeInstalled(target, { source: source(), preset, files: { ...matchingKitFiles(target), ...vendored } });
  changes.push({ action: "created", path: RECORD });

  if (opts.install !== false) {
    run(["bun", "install"], target);
    changes.push({ action: "created", path: "bun.lock", note: "bun install" });
  }
  if (opts.git !== false) {
    run(["git", "init", "-q", "-b", "main"], target);
    run(["git", "add", "-A"], target);
    run(["git", "commit", "-q", "-m", `Start ${name} from the meta-repo ${preset} preset (${source()})`], target);
    changes.push({ action: "created", path: ".git", note: "first commit on main" });
  }
  return changes;
}

export interface InitOptions {
  /** For the AGENTS.md skeleton's heading (default the folder's name). */
  name?: string;
  today?: Date;
}

export function init(dir: string, opts: InitOptions = {}): Change[] {
  const target = resolve(dir);
  if (!existsSync(join(target, ".git"))) throw new Error(`${dir} is not a git repository (use create for a new project)`);
  if (readInstalled(target)) throw new Error(`${RECORD} is already there: the kit is installed (use sync to update it)`);
  // Read up front, so a malformed file stops init before anything is written.
  const pkgText = readIfThere(target, "package.json");
  const pkg = pkgText === null ? null : parseJson<PackageJson>(pkgText, "package.json");
  const mcpText = readIfThere(target, MCP);
  const mcp = mcpText === null ? null : parseJson<McpJson>(mcpText, MCP);
  if (mcp?.mcpServers !== undefined && !isObject(mcp.mcpServers)) throw new Error(`${MCP}: "mcpServers" is not a JSON object`);
  const changes = fromInstall(install(target));

  writeOnce(target, "AGENTS.md", ownTemplate("AGENTS.md").replaceAll("{{name}}", opts.name ?? basename(target)), changes);
  if (!writeOnce(target, "CLAUDE.md", "@AGENTS.md\n", changes)) {
    const claude = join(target, "CLAUDE.md");
    const text = readFileSync(claude, "utf8");
    if (!text.includes("@AGENTS.md")) {
      writeFileSync(claude, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}@AGENTS.md\n`);
      changes.push({ action: "merged", path: "CLAUDE.md", note: "`@AGENTS.md` appended" });
    }
  }

  const decisions = join(target, "docs", "decisions");
  const hasDecision = existsSync(decisions) && readdirSync(decisions).some((f) => /^D\d+-.*\.md$/.test(f));
  if (hasDecision) changes.push({ action: "kept", path: "docs/decisions/", note: "already has decisions" });
  else {
    const date = (opts.today ?? new Date()).toISOString().slice(0, 10);
    writeOnce(target, "docs/decisions/D0001-agent-kit.md", ownTemplate("D0001.md").replaceAll("{{date}}", date), changes);
  }

  writeOnce(target, "foreman.json", ownTemplate("foreman.json"), changes);
  const vendored = pkg && pkgText !== null ? addForeman(target, pkgText, pkg, mcp, mcpText, changes) : {};
  if (!pkg) changes.push({ action: "skipped", path: "foreman", note: `no package.json to install it in: ${MCP}, the AGENTS.md Tasks section and the .gitignore entry not added` });

  // A CI workflow only if the repo has none, and only one that can pass: it runs `bun run check`.
  const workflows = join(target, ".github", "workflows");
  const scripts = pkg?.scripts ?? {};
  if (existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f))) {
    changes.push({ action: "kept", path: ".github/workflows/", note: "already has a workflow" });
  } else if (!scripts.check) {
    changes.push({ action: "skipped", path: CI_PATH, note: "package.json has no check script for CI to run" });
  } else writeOnce(target, CI_PATH, ownTemplate("ci-bun.yml"), changes);

  writeInstalled(target, { source: source(), files: { ...matchingKitFiles(target), ...vendored } });
  changes.push({ action: "created", path: RECORD });
  return changes;
}

const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
type PackageJson = { scripts?: Record<string, string> } & Partial<Record<(typeof DEP_KEYS)[number], Record<string, string>>>;
type McpJson = { mcpServers?: Record<string, unknown> };
const FOREMAN = "@meta-repo/foreman";

function readIfThere(dir: string, path: string): string | null {
  return existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null;
}

function parseJson<T>(text: string, path: string): T {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${path} is not a JSON object`);
  return v as T;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * package.json with one devDependency added as text, so the rest of the file (order, line
 * endings, inline arrays) is untouched. Falls back to a JSON rewrite if the edit doesn't parse.
 */
export function addDevDependency(text: string, name: string, spec: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const ind = indentOf(text);
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(spec)}`;
  const dev = /("devDependencies"\s*:\s*)\{(\s*)(\}?)/.exec(text);
  let out: string;
  if (dev) {
    const at = dev.index + dev[1]!.length + 1;
    out = dev[3]
      ? `${text.slice(0, at)}${eol}${ind}${ind}${entry}${eol}${ind}${text.slice(at + dev[2]!.length)}`
      : `${text.slice(0, at)}${eol}${ind}${ind}${entry},${text.slice(at)}`;
  } else {
    const end = text.lastIndexOf("}");
    const before = text.slice(0, end).replace(/\s*$/, "");
    const block = `${ind}"devDependencies": {${eol}${ind}${ind}${entry}${eol}${ind}}${eol}`;
    out = `${before}${before.endsWith("{") ? "" : ","}${eol}${block}${text.slice(end)}`;
  }
  try {
    const parsed = JSON.parse(out.replace(/^\uFEFF/, "")) as PackageJson;
    if (parsed.devDependencies?.[name] === spec) return out;
  } catch {}
  const pkg = JSON.parse(text.replace(/^\uFEFF/, "")) as PackageJson;
  pkg.devDependencies = { ...pkg.devDependencies, [name]: spec };
  return JSON.stringify(pkg, null, ind) + eol;
}

/** The indent of a JSON file's first nested line, so a rewrite keeps its style (default two spaces). */
const indentOf = (text: string) => /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
const withNewline = (text: string) => (text === "" || text.endsWith("\n") ? text : `${text}\n`);

/**
 * foreman for a repository with a package.json: the package vendored as a devDependency, its
 * MCP server, `.foreman/` ignored, and the Tasks section in AGENTS.md. Returns the vendored
 * tarball's record entry, so sync updates it like a preset's packages.
 */
function addForeman(target: string, pkgText: string, pkg: PackageJson, mcp: McpJson | null, mcpText: string | null, changes: Change[]): Record<string, string> {
  const vendored: Record<string, string> = {};
  if (DEP_KEYS.some((k) => pkg[k]?.[FOREMAN] !== undefined)) changes.push({ action: "kept", path: "package.json", note: `already depends on ${FOREMAN}` });
  else {
    const { path, data } = pack("foreman");
    write(target, path, data);
    vendored[path] = sha256(data);
    write(target, "package.json", addDevDependency(pkgText, FOREMAN, `file:${path}`));
    changes.push({ action: "created", path, note: `${FOREMAN}, vendored` });
    changes.push({ action: "merged", path: "package.json", note: `${FOREMAN} added as a devDependency: run bun install` });
  }

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

  const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
  if (/^## Tasks\b/m.test(agents)) changes.push({ action: "kept", path: "AGENTS.md", note: "already has a Tasks section" });
  else {
    write(target, "AGENTS.md", `${withNewline(agents)}\n${ownTemplate("tasks-section.md")}`);
    changes.push({ action: "merged", path: "AGENTS.md", note: "Tasks section appended (foreman)" });
  }
  return vendored;
}
