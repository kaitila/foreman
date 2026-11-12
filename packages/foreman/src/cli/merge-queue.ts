// fm merge-queue: merge approved PRs one at a time (D0011, D0012). The rules are in src/queue.ts.
import { Foreman } from "../core";
import { mergeQueue, type QueueEntry } from "../queue";
import { type Module, num } from "./context";

export const help = {
  "merge-queue": `  merge-queue [--once] [--dry-run] [--settle-seconds 30] [--interval 60]
                                merge approved PRs one at a time: settled green checks at the
                                verified commit; a PR that conflicts with main goes back to ready`,
};

export const commands: Module["commands"] = {
  async "merge-queue"({ f, me, o, out }) {
    const actor = process.env.FOREMAN_ACTOR ? me : { name: "merge-queue", kind: me.kind };
    const show = (r: QueueEntry[]) =>
      out(r, r.map((e) => `${e.id}  ${e.action.padEnd(15)} ${e.reason}`).join("\n") || "nothing approved");
    await mergeQueue(f, actor, {
      once: o.once,
      dryRun: o["dry-run"],
      settleSeconds: num(o["settle-seconds"], 30, "--settle-seconds"),
      intervalSeconds: num(o.interval, 60, "--interval"),
      onPass: show,
      reopen: () => Foreman.open(),
    });
    return 0;
  },
};
