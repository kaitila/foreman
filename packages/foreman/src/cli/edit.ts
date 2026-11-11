// fm edit, rework and cancel: changing a task that exists.
import { type Module, riskFlag } from "./context";

export const help = {
  edit: `  edit <id> [--title t] [--spec md] [--check "cmd: ..."]... [--remove-check c2]... [--path g]... [--add-path g]... [--risk r]
                                [--blocked-by T-2]... [--unblock T-2]...
                                before work: anything (a blocker that would make a cycle is refused);
                                while claimed: the holder may only --add-path`,
  rework: `  rework <id> --reason text     send a submitted, verified or approved task back to work (verify again after)`,
  cancel: `  cancel <id> --reason text`,
};

export const commands: Module["commands"] = {
  edit({ f, me, o, need, one }) {
    const t = f.edit(need(0, "task id"), me, {
      title: o.title,
      spec: o.spec,
      addChecks: o.check,
      removeChecks: o["remove-check"],
      paths: o.path,
      addPaths: o["add-path"],
      risk: riskFlag(o),
      addBlockedBy: o["blocked-by"],
      removeBlockedBy: o.unblock,
    });
    return one(t), 0;
  },
  rework: ({ f, me, o, need, one }) => (one(f.rework(need(0, "task id"), me, o.reason ?? "")), 0),
  cancel: ({ f, me, o, need, one }) => (one(f.cancel(need(0, "task id"), me, o.reason ?? "")), 0),
};
