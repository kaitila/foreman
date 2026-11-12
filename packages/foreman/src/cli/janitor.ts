// fm janitor and reclaim: release dead claims, clean up after finished tasks, list stuck ones.
import { janitor } from "../janitor";
import { type Module, num } from "./context";

export const help = {
  janitor: `  janitor [--stuck-hours 24] [--dry-run]
                                reclaim expired leases, remove finished tasks' worktrees, list stuck tasks`,
  reclaim: `  reclaim                       release claims whose lease ran out, or whose pinned process is gone`,
};

export const commands: Module["commands"] = {
  async janitor({ f, me, o, out }) {
    const actor = process.env.FOREMAN_ACTOR ? me : { name: "janitor", kind: me.kind };
    const r = await janitor(f, actor, { dryRun: o["dry-run"], stuckHours: num(o["stuck-hours"], 24, "--stuck-hours") });
    const would = o["dry-run"] ? "would " : "";
    const lines = [
      r.reclaimed.length ? `${would}reclaim ${r.reclaimed.join(", ")}` : "no expired claims",
      ...r.removed.map((x) => `${x.id}  ${would}remove ${x.worktree}${x.branchDeleted ? " (and its merged branch)" : ""}${x.portsReleased ? " (ports released)" : ""}`),
      ...r.kept.map((x) => `${x.id}  kept ${x.worktree}: ${x.reason}`),
      ...r.sessions.map((x) => `${x.id}  ${would}remove ${x.sessions.length} finished session${x.sessions.length === 1 ? "" : "s"} (${x.sessions.join(", ")})`),
      ...r.stuck.map((x) => `${x.id}  stuck ${x.status} for ${x.hours}h${x.assignee ? ` @${x.assignee}` : ""}`),
    ];
    return out(r, lines.join("\n")), 0;
  },
  reclaim({ f, me, out }) {
    const ids = f.reclaim(me);
    return out(ids, ids.length ? `released ${ids.join(", ")}` : "no expired claims"), 0;
  },
};
