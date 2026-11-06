// The create | init | sync commands as the CLIs run them (meta-repo's own and foreman's fm).
import { create, DEFAULT_PRESET, init } from "./create";
import type { Change } from "./kit";
import { sync } from "./sync";

export const USAGE = `  create <dir> [--preset ${DEFAULT_PRESET}] [--name n] [--no-install] [--no-git]
                     a new project from a preset, with the kit, foreman.json, CI and a first commit
  init [dir] [--name n]
                     add the kit to an existing repository; never overwrites a file
  sync [dir] [--dry-run]
                     update the kit's files to this meta-repo version; keeps every file the project changed`;

export interface KitCommandOptions {
  preset?: string;
  name?: string;
  noInstall?: boolean;
  noGit?: boolean;
  dryRun?: boolean;
}

export const KIT_COMMANDS = ["create", "init", "sync"] as const;

const show = (changes: Change[], log: (s: string) => void) => {
  for (const c of changes) log(`${c.action.padEnd(8)} ${c.path}${c.note ? ` (${c.note})` : ""}`);
};

/** Run one of create, init, sync. Prints through `log`; throws Error on a bad request. */
export function runKitCommand(cmd: string, dir: string | undefined, o: KitCommandOptions = {}, log: (s: string) => void = console.log): void {
  if (cmd === "create") {
    if (!dir) throw new Error("create needs a directory");
    show(create(dir, { preset: o.preset, name: o.name, install: !o.noInstall, git: !o.noGit }), log);
    log(`\nNext: cd ${dir} && bun run check`);
  } else if (cmd === "init") {
    show(init(dir ?? ".", { name: o.name }), log);
    log("\nNext: fill in AGENTS.md's Commands, review the changes and commit them.");
  } else if (cmd === "sync") {
    const r = sync(dir ?? ".", { dryRun: o.dryRun });
    log(`kit ${r.from} -> ${r.to}${o.dryRun ? " (dry run: nothing written)" : ""}`);
    if (r.changes.length) show(r.changes, log);
    else log("up to date");
    if (r.reinstall) log("\nVendored packages changed: run bun install.");
    if (!o.dryRun && r.changes.some((c) => c.action === "updated" || c.action === "created" || c.action === "merged")) {
      log("Nothing was committed: review with git diff.");
    }
  } else throw new Error(`unknown command "${cmd}"\n${USAGE}`);
}
