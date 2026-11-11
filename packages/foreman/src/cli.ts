#!/usr/bin/env bun
// foreman CLI. Agents and people use the same verbs; --json on every command.
// The commands live in src/cli/, one file per command or small group of them, each with
// its own `fm help` lines, so two tasks changing different commands touch different files.
import { actorFromEnv, Foreman, ForemanError, type Task } from "./core";
import { noteProject } from "./projects";
import * as add from "./cli/add";
import * as approve from "./cli/approve";
import { type Ctx, type Exit, line, type Module, parse } from "./cli/context";
import * as dispatch from "./cli/dispatch";
import * as edit from "./cli/edit";
import { renderHelp } from "./cli/help";
import * as intake from "./cli/intake";
import * as janitor from "./cli/janitor";
import * as kit from "./cli/kit";
import * as list from "./cli/list";
import * as logs from "./cli/logs";
import * as mergeQueue from "./cli/merge-queue";
import * as plan from "./cli/plan";
import * as policy from "./cli/policy";
import * as projects from "./cli/projects";
import * as reserve from "./cli/reserve";
import * as serve from "./cli/serve";
import * as verify from "./cli/verify";
import * as work from "./cli/work";

const MODULES: Module[] = [add, approve, dispatch, edit, intake, janitor, kit, list, logs, mergeQueue, plan, policy, projects, reserve, serve, verify, work];

/** One table per kind of command, from every file; a name used twice is a mistake. */
function gather<K extends "help" | "early" | "local" | "commands">(kind: K): Map<string, NonNullable<Module[K]>[string]> {
  const all = new Map<string, NonNullable<Module[K]>[string]>();
  for (const m of MODULES) {
    for (const [name, value] of Object.entries(m[kind] ?? {})) {
      if (all.has(name)) throw new Error(`fm: two files define ${kind} "${name}"`);
      all.set(name, value as NonNullable<Module[K]>[string]);
    }
  }
  return all;
}

const HELP = renderHelp(Object.fromEntries(gather("help")));
const EARLY = gather("early");
const LOCAL = gather("local");
const COMMANDS = gather("commands");

/** Returns the exit code, or null when the process must keep running (the MCP server). */
export async function main(argv: string[]): Promise<Exit> {
  const { values: o, positionals } = parse(argv);
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  // Before anything is opened: the MCP server, the guard hook's policy, the machine and the kit.
  const code = await EARLY.get(cmd)?.({ cmd, args, o });
  if (code !== undefined) return code;

  const me = actorFromEnv();
  const local = LOCAL.get(cmd);
  if (local) return local({ cmd, args, o, me });

  const f = Foreman.open();
  if (!process.env.FOREMAN_DB) noteProject(process.cwd());
  const run = COMMANDS.get(cmd);
  if (!run) throw new ForemanError("invalid", `unknown command "${cmd}" (foreman help)`);
  const out: Ctx["out"] = (value, text) => console.log(o.json ? JSON.stringify(value, null, 2) : text);
  return run({
    cmd,
    args,
    o,
    me,
    f,
    lease: o.lease ? Number(o.lease) : undefined,
    need(i, what) {
      const v = args[i];
      if (!v) throw new ForemanError("invalid", `missing ${what}`);
      return v;
    },
    out,
    one: (t: Task) => out(t, line(t)),
  });
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== null) process.exit(code);
    })
    .catch((e) => {
      if (process.env.FOREMAN_DEBUG) throw e;
      const code = e instanceof ForemanError ? e.code : "error";
      const message = e instanceof Error ? e.message : String(e);
      if (process.argv.includes("--json")) console.error(JSON.stringify({ error: code, message }));
      else console.error(`foreman: ${message}`);
      process.exit(1);
    });
}
