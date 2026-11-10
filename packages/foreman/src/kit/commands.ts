// The create | init | sync commands as fm runs them.
import { add, create, DEFAULT_PRESET, init } from "./create";
import { type Change, readInstalled } from "./kit";
import { checklist, parseAnswer, parsePieces, type Piece, PIECES } from "./pieces";
import { sync } from "./sync";

export const USAGE = `  create <dir> [--preset ${DEFAULT_PRESET}] [--name n] [--no-install] [--no-git]
                     a new project from a preset, with every piece of the kit, foreman.json, CI and a first commit
  init [dir] [--with p,q | --all] [--name n]
                     set up foreman in a git repository (any language), plus the kit pieces you choose:
                     ${PIECES.join(", ")}. In a terminal it asks; without one and without flags, foreman only.
                     In a repo that has foreman, adds the pieces chosen. Never overwrites a file.
  add <piece>... [--name n]
                     add kit pieces to a repo that has foreman, like init --with. Any other words file a task
  sync [dir] [--dry-run]
                     update the kit to this foreman version: its files (keeping every one the project changed),
                     the @foreman-kit/* versions and foreman.json; moves a project made before D0026 off its tarballs`;

export interface KitCommandOptions {
  preset?: string;
  name?: string;
  noInstall?: boolean;
  noGit?: boolean;
  dryRun?: boolean;
  /** init: --with, the pieces by name. */
  with?: string;
  /** init: --all. */
  all?: boolean;
  /** add: the pieces named. */
  pieces?: Piece[];
  /** init: asks which pieces to add, when there's a terminal and no --with or --all. Returns the answer. */
  ask?: (question: string) => string | null;
}

export const KIT_COMMANDS = ["create", "init", "add", "sync"] as const;

const show = (changes: Change[], log: (s: string) => void) => {
  for (const c of changes) log(`${c.action.padEnd(8)} ${c.path}${c.note ? ` (${c.note})` : ""}`);
};

/** The pieces init adds: from --with or --all, else the person's answer in a terminal, else none. */
export function initPieces(o: KitCommandOptions, log: (s: string) => void): { pieces: Piece[]; all: boolean } {
  if (o.all && o.with) throw new Error("pass --with or --all, not both");
  if (o.all) return { pieces: [...PIECES], all: true };
  if (o.with !== undefined) return { pieces: parsePieces(o.with), all: false };
  if (!o.ask) return { pieces: [], all: false };
  log(`foreman is always set up. Which kit pieces should init add too?\n${checklist()}`);
  const answer = o.ask("Numbers or names, comma-separated (all: every piece, empty: foreman only):") ?? "";
  return { pieces: parseAnswer(answer), all: false };
}

/** Run one of create, init, sync. Prints through `log`; throws Error on a bad request. */
export function runKitCommand(cmd: string, dir: string | undefined, o: KitCommandOptions = {}, log: (s: string) => void = console.log): void {
  if (cmd === "create") {
    if (!dir) throw new Error("create needs a directory");
    show(create(dir, { preset: o.preset, name: o.name, install: !o.noInstall, git: !o.noGit }), log);
    log(`\nNext: cd ${dir} && bun run check`);
  } else if (cmd === "init") {
    const target = dir ?? ".";
    const installed = readInstalled(target) !== null;
    // A repo that has foreman: init adds the pieces chosen, as fm add <piece> does.
    if (installed && !o.with && !o.all && !o.ask) throw new Error("foreman is already set up here: fm add <piece> (or init --with <piece>) adds a piece, sync updates the kit");
    const { pieces, all } = initPieces(o, log);
    if (installed) {
      if (!pieces.length) return log("nothing to add");
      show(add(target, all ? [...PIECES] : pieces, { name: o.name, all }), log);
    } else show(init(target, { name: o.name, pieces, all }), log);
    log("\nNext: review the changes and commit them. The foreman MCP server runs fm, so fm must be on your PATH (fm setup checks).");
  } else if (cmd === "add") {
    if (!o.pieces?.length) throw new Error(`name a piece to add (${PIECES.join(", ")})`);
    show(add(dir ?? ".", o.pieces, { name: o.name }), log);
    log("\nNext: review the changes and commit them.");
  } else if (cmd === "sync") {
    const r = sync(dir ?? ".", { dryRun: o.dryRun });
    log(`kit ${r.from} -> ${r.to}${o.dryRun ? " (dry run: nothing written)" : ""}`);
    if (r.changes.length) show(r.changes, log);
    else log("up to date");
    if (r.reinstall) log("\npackage.json changed: run bun install.");
    if (!o.dryRun && r.changes.some((c) => c.action === "updated" || c.action === "created" || c.action === "merged")) {
      log("Nothing was committed: review with git diff.");
    }
  } else throw new Error(`unknown command "${cmd}"\n${USAGE}`);
}
