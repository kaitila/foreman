// fm dispatch and dispatchers: run workers and verifiers, and see the dispatchers running (D0011, D0041).
import { ForemanError } from "../core";
import { dispatcherLine, runningDispatchers } from "../dispatchers";
import type { Module } from "./context";

export const help = {
  dispatch: `  dispatch [--max 3] [--once] [--verify-only] [--model m] [--budget usd] [--print]
                                claim ready tasks into worktrees, run a worker for each and a fresh
                                verifier once it is submitted; at most --max sessions at once, never two
                                tasks with overlapping paths; --once: start workers only for what fits
                                now, see it through verification, then stop (every submitted task still
                                gets a verifier); --verify-only: verifiers for submitted tasks, no new
                                work; --budget: each session's limit in USD. Stopping the dispatcher
                                stops every session it started.
                                Sessions run as Claude Code background sessions: watch them with
                                "claude agents", "claude attach <name>"; --print (or
                                FOREMAN_LAUNCH=print) runs headless "claude -p" instead`,
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
    const { dispatch } = await import("../dispatch");
    const sessions = await dispatch(f, {
      max: positive(o.max, "max"),
      once: o.once,
      verifyOnly: o["verify-only"],
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
