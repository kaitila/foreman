// fm plan: ordered steps with a check each, and the tasks filed into them (D0033).
import { ForemanError } from "../core";
import { parseStep, planLine, planText, Plans } from "../plans";
import { type Module, num } from "./context";

export const help = {
  plan: `  plan new <title> --step "title :: check"... [--goal md]
  plan list                     every plan with steps and tasks done, active first
  plan show <P>                 the goal, then each step: its check, state and tasks
  plan step <P> "title :: check"   add a step at the end
  plan edit <P> [--title t] [--goal md]
  plan add <T> <P> <step>       put a task in a step (moves it from any other plan)
  plan remove <T>               take a task out of its plan
  plan cancel <P> --reason text`,
};

export const commands: Module["commands"] = {
  plan({ f, me, args, o, out }) {
    const plans = new Plans(f);
    const [sub, ...rest] = args;
    const at = (i: number, what: string) => {
      const v = rest[i];
      if (!v) throw new ForemanError("invalid", `missing ${what}`);
      return v;
    };
    const shown = (id: string) => {
      const p = plans.get(id);
      return out(p, planText(p)), 0;
    };
    switch (sub) {
      case "new": {
        const p = plans.create({ title: rest.join(" "), goal: o.goal, steps: (o.step ?? []).map(parseStep) }, me);
        return out(p, planText(p)), 0;
      }
      case undefined:
      case "list": {
        const ps = plans.list();
        return out(ps, ps.map(planLine).join("\n") || "no plans"), 0;
      }
      case "show":
        return shown(at(0, "plan id"));
      case "step":
        plans.edit(at(0, "plan id"), me, { addSteps: [parseStep(rest.slice(1).join(" ") || at(1, '"title :: check"'))] });
        return shown(rest[0]!);
      case "edit":
        plans.edit(at(0, "plan id"), me, { title: o.title, goal: o.goal });
        return shown(rest[0]!);
      case "add":
        plans.add(at(0, "task id"), at(1, "plan id"), num(at(2, "step number"), 0, "step"), me);
        return shown(rest[1]!);
      case "remove": {
        const was = plans.remove(at(0, "task id"), me);
        return out(was, `${rest[0]} left ${was.plan} (step ${was.step})`), 0;
      }
      case "cancel":
        plans.cancel(at(0, "plan id"), me, o.reason ?? "");
        return shown(rest[0]!);
      default:
        throw new ForemanError("invalid", `fm plan [new | list | show | step | edit | add | remove | cancel], got "${sub}"`);
    }
  },
};
