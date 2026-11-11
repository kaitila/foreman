// fm list, next and show: reading the tasks, and why one waits (D0042).
import { hasLiveSession } from "../activity";
import type { Status, Task } from "../core";
import { dispatcherLine, runningDispatchers } from "../dispatchers";
import { toMarkdown } from "../export";
import { Plans } from "../plans";
import { holdsUp, pathOf, pathText, snapshot, waitingText, waitShort } from "../waiting";
import { line, type Module } from "./context";

export const help = {
  list: `  list [--status s]... [--mine]  (* marks a task with a live session; a waiting task says what it waits on
                                and where that ends: "waits: T-2 <- T-1 (in progress)"; ends with a line per
                                running dispatcher)`,
  next: `  next                          ready tasks you can claim now: blockers done, earlier plan steps done`,
  show: `  show <id> [--path]            task, checks and history, then what it waits on as a tree followed to the
                                end (blockers, earlier plan steps, overlapping paths, a person), what moves
                                it, and the tasks it holds up; --path: only the tree`,
};

/** The task's line, with what it waits on when it waits. */
function waiting(t: Task, waits: string | null | undefined): string {
  return waits ? `${line(t)}  (${waits})` : line(t);
}

export const commands: Module["commands"] = {
  list({ f, me, o, out }) {
    const ts = f.list({ status: o.status as Status[] | undefined, assignee: o.mine ? me.name : undefined });
    const live = new Set(ts.filter((t) => hasLiveSession(f, t.id)).map((t) => t.id));
    // One line per running dispatcher at the end (D0041). --json stays the task array: fm dispatchers --json has them.
    const running = o.json ? [] : runningDispatchers(f).map((d) => `dispatcher ${dispatcherLine(d)}`);
    const s = snapshot(f);
    const waits = new Map(ts.map((t) => [t.id, waitShort(s, t.id)]));
    const text = [ts.map((t) => `${live.has(t.id) ? "*" : " "} ${waiting(t, waits.get(t.id))}`).join("\n") || "no tasks", ...running].join("\n");
    return out(ts.map((t) => ({ ...t, live: live.has(t.id), waits: waits.get(t.id) ?? null })), text), 0;
  },
  next({ f, me, out }) {
    // Claimable now. One the dispatcher would still hold back (overlapping paths) says so.
    const s = snapshot(f);
    const ts = f.ready(me.kind).map((t) => ({ ...t, waits: waitShort(s, t.id) }));
    return out(ts, ts.map((t) => waiting(t, t.waits)).join("\n") || "nothing ready"), 0;
  },
  show({ f, o, need, out }) {
    const t = f.get(need(0, "task id"));
    const s = snapshot(f);
    const path = pathOf(s, t.id);
    if (o.treeOnly) return out(path, pathText(path)), 0;
    const held = holdsUp(s, t.id);
    const ev = f.events(t.id);
    const placed = new Plans(f).placement(t.id);
    return out({ ...t, plan: placed, events: ev, waits: path, holdsUp: held }, `${toMarkdown(t, ev, placed)}\n${waitingText(path, held)}`), 0;
  },
};
