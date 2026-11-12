// fm dispatch and dispatchers: run workers and verifiers, for the whole board or for
// plans, stop a running one, and see the dispatchers running (D0011, D0041, D0045).
import { ForemanError } from "../core";
import { dispatcherLine, runningDispatchers, stopDispatcher, stoppedText } from "../dispatchers";
import type { Module } from "./context";

export const help = {
  dispatch: `  dispatch [--plan P-0001]... [--max 3] [--once] [--verify-only] [--model m] [--budget usd] [--print]
  dispatch --stop <pid|plan>
                                claim ready tasks into worktrees, run a worker for each and a fresh
                                verifier once it is submitted; at most --max sessions at once, never two
                                tasks with overlapping paths; --once: start workers only for what fits
                                now, see it through verification, then stop (every submitted task still
                                gets a verifier); --verify-only: verifiers for submitted tasks, no new
                                work; --budget: each session's limit in USD. Stopping the dispatcher
                                stops every session it started.
                                Sessions run as Claude Code background sessions: watch them with
                                "claude agents", "claude attach <name>"; --print (or
                                FOREMAN_LAUNCH=print) runs headless "claude -p" instead.
                                --plan (repeatable): only that plan's tasks, in step order, and it
                                stays up until nothing of the plan is left that could start without a
                                person; without it, the whole board. One dispatcher per scope: a second
                                is refused with the first one's pid.
                                --stop: stop a running dispatcher as Ctrl-C would, by pid or by a plan
                                it covers ("everything" for the whole-board one): its sessions stop
                                and their tasks go back to ready or in review`,
  dispatchers: `  dispatchers                   the dispatchers running now: pid, scope, slots in use out of --max,
                                who started it, how long ago, the tasks its sessions are on`,
};

function positive(v: string | undefined, what: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ForemanError("invalid", `--${what} must be a positive number, got "${v}"`);
  return n;
}

export const commands: Module["commands"] = {
  async dispatch({ f, me, o, out }) {
    if (o.stop !== undefined) {
      const stopped = await stopDispatcher(f, o.stop, me);
      return out(stopped, stoppedText(stopped, (id) => f.get(id).status)), 0;
    }
    const { dispatch } = await import("../dispatch");
    const sessions = await dispatch(f, {
      max: positive(o.max, "max"),
      once: o.once,
      verifyOnly: o["verify-only"],
      plans: o.plans,
      model: o.model,
      budgetUsd: positive(o.budget, "budget"),
      mode: o.print ? "print" : undefined,
      actor: me,
      log: o.json ? () => {} : undefined,
    });
    const cost = sessions.reduce((a, s) => a + s.costUsd, 0);
    const text = sessions.length
      ? `${sessions.map((s) => `${s.task} ${s.role}: ${s.status}${s.error ? ` (${s.error})` : ""}`).join("\n")}\n${sessions.length} sessions, $${cost.toFixed(2)}`
      : "nothing to dispatch";
    return out(sessions, text), 0;
  },
  dispatchers({ f, out }) {
    const ds = runningDispatchers(f);
    return out(ds, ds.map((d) => dispatcherLine(d)).join("\n") || "no dispatcher is running"), 0;
  },
};
