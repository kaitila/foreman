// fm setup, create, init, sync, and fm add <piece>: the machine and the kit (KIT.md).
import { ForemanError } from "../core";
import { listProjects, recordProject } from "../projects";
import { checkMachine, formatItems, realEnv } from "../setup";
import { repoRoot } from "../store";
import type { Base, Exit, Module } from "./context";

export const help = {
  setup: `  setup [--no-link]             check this machine (bun, git, gh, claude, fm on the PATH, repo trusted
                                in Claude Code), link fm unless --no-link, print what is missing and
                                the command that fixes it; --json for scripts`,
  create: `  create <dir> [--preset p] [--name n] [--no-install] [--no-git]
                                a new project from a preset, with every kit piece, foreman.json, CI, first commit`,
  init: `  init [dir] [--with p,q | --all] [--name n]
                                set up foreman in any git repository, plus the kit pieces chosen: docs,
                                guardrails, skills, ci, test-kit, design. In a terminal it asks; with no
                                terminal and no flags, foreman only. In a repo that has foreman, adds
                                the pieces chosen. Never overwrites a file`,
  "add-piece": `  add <piece>... [--name n]     add kit pieces later, like init --with (a title that isn't only piece
                                names, or any task flag, files a task instead)`,
  sync: `  sync [dir] [--dry-run]        update the kit's files to this version; keeps what the project changed
  sync --all [--dry-run]        every project fm has seen (create, init, sync, setup record them), one
                                result per project`,
};

function setup({ o }: Base): Exit {
  const root = (() => {
    try {
      return repoRoot();
    } catch {
      return null;
    }
  })();
  const items = checkMachine(realEnv(root), { link: !o["no-link"] });
  if (root) recordProject(root);
  console.log(o.json ? JSON.stringify({ ok: items.every((i) => i.ok), items }, null, 2) : formatItems(items));
  return items.every((i) => i.ok) ? 0 : 1;
}

/** fm add <piece> adds kit pieces; any other words (or a task flag) file a task (D0035), so this passes. */
async function addPiece({ args, o }: Base): Promise<Exit | undefined> {
  const { piecesToAdd } = await import("../kit/pieces");
  const taskFlags = ["spec", "check", "path", "risk", "parent", "blocked-by", "from", "plan", "step", "ready"].some((k) => o[k as keyof typeof o] !== undefined);
  const pieces = piecesToAdd(args, taskFlags);
  if (!pieces) return undefined;
  const { runKitCommand } = await import("../kit/index");
  try {
    runKitCommand("add", ".", { pieces, name: o.name });
  } catch (e) {
    throw new ForemanError("invalid", (e as Error).message);
  }
  recordProject(".");
  return 0;
}

async function kit({ cmd, args, o }: Base): Promise<Exit> {
  const { runKitCommand } = await import("../kit/index");
  // init asks which pieces to add only when a person is at a terminal (D0026).
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const opts = {
    preset: o.preset,
    name: o.name,
    noInstall: o["no-install"],
    noGit: o["no-git"],
    dryRun: o["dry-run"],
    with: o.with,
    all: cmd === "init" ? o.all : undefined,
    ask: cmd === "init" && terminal ? (q: string) => prompt(q) : undefined,
  };
  if (args.length > 1) throw new ForemanError("invalid", `unexpected argument: ${args[1]}`);
  if (cmd === "sync" && o.all) {
    if (args.length) throw new ForemanError("invalid", "sync --all takes no directory");
    const projects = listProjects();
    if (!projects.length) return console.log("no projects yet: create, init, sync or setup in one first"), 0;
    let failed = 0;
    for (const { dir } of projects) {
      console.log(`== ${dir}`);
      try {
        runKitCommand("sync", dir, opts);
      } catch (e) {
        failed++;
        console.log(`failed: ${(e as Error).message}`);
      }
    }
    console.log(`\n${projects.length} projects, ${failed} failed`);
    return failed ? 1 : 0;
  }
  try {
    runKitCommand(cmd as "create" | "init" | "sync", args[0], opts);
  } catch (e) {
    throw new ForemanError("invalid", (e as Error).message);
  }
  recordProject(args[0] ?? ".");
  return 0;
}

export const early: Module["early"] = { setup, add: addPiece, create: kit, init: kit, sync: kit };
