// fm claim, heartbeat, progress and submit: what a worker does with its task.
import type { Module } from "./context";

export const help = {
  claim: `  claim [id] [--lease min]      claim a task, or the next ready one`,
  heartbeat: `  heartbeat <id>                keep the claim alive`,
  progress: `  progress <id> [--note text] [--branch b] [--worktree path]`,
  submit: `  submit <id> --pr url [--summary text]`,
};

export const commands: Module["commands"] = {
  claim: ({ f, me, args, lease, one }) => (one(f.claim(args[0] ?? null, me, lease)), 0),
  heartbeat: ({ f, me, lease, need, one }) => (one(f.heartbeat(need(0, "task id"), me, lease)), 0),
  progress: ({ f, me, o, need, one }) => (one(f.progress(need(0, "task id"), me, { note: o.note, branch: o.branch, worktree: o.worktree })), 0),
  submit: ({ f, me, o, need, one }) => (one(f.submit(need(0, "task id"), me, { pr: o.pr ?? "", summary: o.summary })), 0),
};
