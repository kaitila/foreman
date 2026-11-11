// fm list, next and show: reading the tasks.
import { hasLiveSession } from "../activity";
import type { Status } from "../core";
import { dispatcherLine, runningDispatchers } from "../dispatchers";
import { toMarkdown } from "../export";
import { Plans } from "../plans";
import { line, type Module } from "./context";

export const help = {
  list: `  list [--status s]... [--mine]  (* marks a task with a live session; ends with a line per running dispatcher)`,
  next: `  next                          ready tasks whose blockers are done`,
  show: `  show <id>                     task, checks and history`,
};

export const commands: Module["commands"] = {
  list({ f, me, o, out }) {
    const ts = f.list({ status: o.status as Status[] | undefined, assignee: o.mine ? me.name : undefined });
    const live = new Set(ts.filter((t) => hasLiveSession(f, t.id)).map((t) => t.id));
    // One line per running dispatcher at the end (D0041). --json stays the task array: fm dispatchers --json has them.
    const running = o.json ? [] : runningDispatchers(f).map((d) => `dispatcher ${dispatcherLine(d)}`);
    const text = [ts.map((t) => `${live.has(t.id) ? "*" : " "} ${line(t)}`).join("\n") || "no tasks", ...running].join("\n");
    return out(ts.map((t) => ({ ...t, live: live.has(t.id) })), text), 0;
  },
  next({ f, me, out }) {
    const ts = f.ready(me.kind);
    return out(ts, ts.map(line).join("\n") || "nothing ready"), 0;
  },
  show({ f, need, out }) {
    const t = f.get(need(0, "task id"));
    const ev = f.events(t.id);
    const placed = new Plans(f).placement(t.id);
    return out({ ...t, plan: placed, events: ev }, toMarkdown(t, ev, placed)), 0;
  },
};
