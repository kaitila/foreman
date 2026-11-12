// fm reserve and export: the next free number of a kind, and a task as a markdown file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toMarkdown } from "../export";
import { Plans } from "../plans";
import type { Module } from "./context";

export const help = {
  reserve: `  reserve <kind> [--task id]    next free number (also reads what is on disk: foreman.json "numbers")`,
  export: `  export <id> [--out dir]       write the task as markdown (default docs/tasks/<id>.md)`,
};

export const commands: Module["commands"] = {
  reserve({ f, me, args, o, need, out }) {
    const n = f.reserve(need(0, "kind"), me, o.task);
    const label = args[0] === "decision" ? `D${String(n).padStart(4, "0")}` : String(n);
    return out({ kind: args[0], value: n, label }, label), 0;
  },
  export({ f, o, need, out }) {
    const t = f.get(need(0, "task id"));
    const dir = o.out ?? join(f.root ?? ".", "docs", "tasks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${t.id}.md`);
    writeFileSync(file, toMarkdown(t, f.events(t.id), new Plans(f).placement(t.id)));
    return out({ file }, file), 0;
  },
};
