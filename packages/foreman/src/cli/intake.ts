// fm intake: a read-only session files a request as tasks.
import type { Module } from "./context";

export const help = {
  intake: `  intake <request> [--ready] [--model m] [--budget usd]
                                a read-only session files the request as tasks (spec, checks, paths),
                                skipping what the board already has; drafts unless --ready; prints the ids`,
};

export const commands: Module["commands"] = {
  async intake({ f, me, args, o, out }) {
    const { intakeCommand } = await import("../intake");
    const r = await intakeCommand(f, me, args.join(" "), { ready: o.ready, model: o.model, budget: o.budget });
    return out(r.result, r.text), r.code;
  },
};
