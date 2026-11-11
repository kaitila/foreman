// fm approve and merged: signing off. People only (D0008), so this file is one of
// foreman.json's protectedPaths (D0044): a change here waits for a person.
import { ForemanError } from "../core";
import { line, type Module } from "./context";

export const help = {
  approve: `  approve [id...] [--note text] people only; no id = everything waiting, after one yes`,
  merged: `  merged <id> [--pr url]`,
};

async function readLine(): Promise<string> {
  for await (const chunk of console) return String(chunk);
  return "";
}

export const commands: Module["commands"] = {
  async approve({ f, me, args, o, out }) {
    if (me.kind !== "human") throw new ForemanError("human_only", "only a person can approve (this looks like an agent session)");
    if (!process.stdin.isTTY) {
      throw new ForemanError("human_only", "approve runs only in an interactive terminal");
    }
    // No ids: everything waiting for a person, after one look and one yes.
    const ids = args.length ? args : f.list({ status: ["needs_approval"] }).map((t) => t.id);
    if (!ids.length) return out([], "nothing is waiting for approval"), 0;
    if (!args.length) {
      console.log(`Waiting for you:\n${ids.map((i) => line(f.get(i))).join("\n")}`);
      process.stdout.write(`Approve all ${ids.length}? [y/N] `);
      const answer = (await readLine()).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return out([], "nothing approved"), 0;
    }
    const done = ids.map((i) => f.approve(i, me, o.note));
    return out(done, done.map(line).join("\n")), 0;
  },
  merged: ({ f, me, o, need, one }) => (one(f.merged(need(0, "task id"), me, o.pr)), 0),
};
