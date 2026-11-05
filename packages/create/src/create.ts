// create: a new project from a preset. init: the kit added to a repository that exists.
// Both never overwrite a file the project has (settings.json is merged, D0014), and both
// record what they installed in .meta-repo/installed.json so sync can update it later (D0018).
import { install, type InstallResult } from "@meta-repo/agent-kit";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { generate, NAME } from "../../../presets/generate";
import {
  type Change,
  matchingKitFiles,
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

export function init(dir: string, opts: InitOptions = {}): Change[] {
  const target = resolve(dir);
  if (!existsSync(join(target, ".git"))) throw new Error(`${dir} is not a git repository (use create for a new project)`);
  if (readInstalled(target)) throw new Error(`${RECORD} is already there: the kit is installed (use sync to update it)`);
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

  const hasDecision = hasDecisions(target);
  if (hasDecision) changes.push({ action: "kept", path: "docs/decisions/", note: "already has decisions" });
  else {
    const date = (opts.today ?? new Date()).toISOString().slice(0, 10);
    writeOnce(target, "docs/decisions/D0001-agent-kit.md", ownTemplate("D0001.md").replaceAll("{{date}}", date), changes);
  }

  writeOnce(target, "foreman.json", ownTemplate("foreman.json"), changes);

  // A CI workflow only if the repo has none, and only one that can pass: it runs `bun run check`.
  const workflows = join(target, ".github", "workflows");
  const scripts = existsSync(join(target, "package.json"))
    ? ((JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {})
    : {};
  if (existsSync(workflows) && readdirSync(workflows).some((f) => /\.ya?ml$/.test(f))) {
    changes.push({ action: "kept", path: ".github/workflows/", note: "already has a workflow" });
  } else if (!scripts.check) {
    changes.push({ action: "skipped", path: CI_PATH, note: "package.json has no check script for CI to run" });
  } else writeOnce(target, CI_PATH, ownTemplate("ci-bun.yml"), changes);

  writeInstalled(target, { source: source(), files: matchingKitFiles(target) });
  changes.push({ action: "created", path: RECORD });
  return changes;
}
