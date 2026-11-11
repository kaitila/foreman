// fm logs: what a task's dispatched sessions did.
import { printLogs } from "../activity";
import { ForemanError } from "../core";
import type { Module } from "./context";

export const help = {
  logs: `  logs <id> [--role worker|verifier] [-f]
                                what the task's dispatched sessions did: tool calls, text, results, cost;
                                -f keeps printing new lines while a session runs`,
};

export const commands: Module["commands"] = {
  async logs({ f, o, need }) {
    const role = o.role;
    if (role && !["worker", "verifier"].includes(role)) throw new ForemanError("invalid", `bad role ${role}`);
    const lines: string[] = [];
    const code = await printLogs(f, need(0, "task id"), { role, follow: o.follow, write: (l) => (o.json ? lines.push(l) : console.log(l)) });
    if (o.json) console.log(JSON.stringify({ lines }));
    return code;
  },
};
