// fm add <title> and fm ready-up: file a task, make a draft ready.
import { ForemanError } from "../core";
import { Plans } from "../plans";
import { type Module, num, riskFlag } from "./context";

export const help = {
  add: `  add <title> [--spec md] [--check "cmd: bun test"]... [--path glob]... [--risk auto|review|human]
              [--parent T-1] [--blocked-by T-2]... [--from T-3] [--plan P-1 --step n] [--ready]`,
  "ready-up": `  ready-up <id>                 draft -> ready (needs at least one check)`,
};

export const commands: Module["commands"] = {
  add({ f, me, args, o, one }) {
    // No --risk: core picks it from the paths (D0008). Don't default to "review" here.
    const risk = riskFlag(o);
    if ((o.plan === undefined) !== (o.step === undefined)) throw new ForemanError("invalid", "--plan and --step go together");
    if (o.step && o.step.length > 1) throw new ForemanError("invalid", "a task goes in one step");
    const placement = o.plan ? { plan: o.plan, step: num(o.step![0], 0, "--step") } : null;
    const t = new Plans(f).createTask(
      {
        title: args.join(" "),
        spec: o.spec,
        acceptance: o.check,
        paths: o.path,
        risk,
        parent: o.parent,
        blockedBy: o["blocked-by"],
        discoveredFrom: o.from,
        ready: o.ready,
      },
      placement,
      me,
    );
    return one(t), 0;
  },
  "ready-up": ({ f, me, need, one }) => (one(f.markReady(need(0, "task id"), me)), 0),
};
