// fm projects: the repos the board shows, and their colour labels (D0024, D0028).
import { ForemanError } from "../core";
import type { Exit, Local, Module } from "./context";

export const help = {
  projects: `  projects [list|add <dir>|rm <name|dir>|prune|color <name|dir> <colour|none>]
                                the repos the board shows, and their colour labels
                                (~/.config/foreman/projects.json)`,
};

async function projects({ args, o }: Local): Promise<Exit> {
  const reg = await import("../projects");
  const [sub, target] = args;
  if (sub === "add") {
    const root = reg.addProject(target ?? process.cwd());
    console.log(`registered ${root}`);
  } else if (sub === "rm") {
    if (!target) throw new ForemanError("invalid", "missing project name or directory");
    console.log(`removed ${reg.removeProject(target)}`);
  } else if (sub === "prune") {
    const gone = reg.pruneProjects();
    console.log(gone.length ? `removed ${gone.length} missing:\n${gone.join("\n")}` : "nothing to prune");
  } else if (sub === "color" || sub === "colour") {
    const color = args[2];
    if (!target || !color) throw new ForemanError("invalid", `fm projects color <name|dir> <${reg.LABEL_COLORS.join("|")}|none>`);
    if (color !== "none" && !reg.isLabelColor(color)) throw new ForemanError("invalid", `unknown colour "${color}": use ${reg.LABEL_COLORS.join(", ")} or none`);
    const p = reg.findProject(target);
    reg.setColor(p.dir, color === "none" ? null : color);
    console.log(color === "none" ? `${p.name}: no colour label` : `${p.name}: ${color}`);
  } else if (sub === undefined || sub === "list") {
    const colors = reg.readColors();
    const ps = reg.listProjects().map((p) => ({ ...p, color: colors[p.dir] ?? null }));
    const text = ps.length ? ps.map((p) => `${p.name.padEnd(20)} ${(p.color ?? "-").padEnd(7)} ${p.dir}${"error" in reg.projectRoot(p.dir) ? "  (missing: no repo or database)" : ""}`).join("\n") : "no projects yet: run fm in a repo, or fm projects add <dir>";
    console.log(o.json ? JSON.stringify(ps, null, 2) : text);
  } else throw new ForemanError("invalid", `fm projects [list | add <dir> | rm <name|dir> | prune | color <name|dir> <colour|none>], got "${sub}"`);
  return 0;
}

export const local: Module["local"] = { projects };
