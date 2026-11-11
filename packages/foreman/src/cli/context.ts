// What every fm command gets: the parsed flags, and for the commands that use the
// database, foreman and who is asking. One file per command (or small group of them)
// sits beside this one; src/cli.ts lists them and src/cli/help.ts lays out `fm help`.
import { parseArgs } from "node:util";
import { type Actor, type Foreman, ForemanError, type Task } from "../core";

/** Every flag of every command: parseArgs wants them in one table. */
export function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      spec: { type: "string" },
      check: { type: "string", multiple: true },
      path: { type: "string", multiple: true },
      risk: { type: "string" },
      parent: { type: "string" },
      "blocked-by": { type: "string", multiple: true },
      from: { type: "string" },
      ready: { type: "boolean" },
      status: { type: "string", multiple: true },
      mine: { type: "boolean" },
      lease: { type: "string" },
      note: { type: "string" },
      branch: { type: "string" },
      worktree: { type: "string" },
      pr: { type: "string" },
      summary: { type: "string" },
      result: { type: "string", multiple: true },
      "results-json": { type: "string" },
      reason: { type: "string" },
      task: { type: "string" },
      out: { type: "string" },
      title: { type: "string" },
      "remove-check": { type: "string", multiple: true },
      "add-path": { type: "string", multiple: true },
      port: { type: "string" },
      queue: { type: "boolean" },
      project: { type: "string" },
      max: { type: "string" },
      once: { type: "boolean" },
      "verify-only": { type: "boolean" },
      print: { type: "boolean" },
      model: { type: "string" },
      budget: { type: "string" },
      "dry-run": { type: "boolean" },
      "settle-seconds": { type: "string" },
      interval: { type: "string" },
      "stuck-hours": { type: "string" },
      actor: { type: "string" },
      role: { type: "string" },
      preset: { type: "string" },
      with: { type: "string" },
      name: { type: "string" },
      "no-install": { type: "boolean" },
      "no-git": { type: "boolean" },
      all: { type: "boolean" },
      "no-link": { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      goal: { type: "string" },
      plan: { type: "string" },
      step: { type: "string", multiple: true },
    },
  });
}

export type Opts = ReturnType<typeof parse>["values"];

/** The exit code, or null when the process must keep running (the MCP server, the board). */
export type Exit = number | null;

/** A command before anything is opened: its name, the words after it, the flags. */
export interface Base {
  cmd: string;
  args: string[];
  o: Opts;
}

/** A command that needs to know who is asking, but no database (projects, serve). */
export interface Local extends Base {
  me: Actor;
}

/** A command on this repo's tasks. */
export interface Ctx extends Local {
  f: Foreman;
  /** --lease, in minutes. */
  lease: number | undefined;
  /** The i-th word after the command, or an error naming what is missing. */
  need(i: number, what: string): string;
  /** Prints the value as JSON with --json, the text without. */
  out(value: unknown, text: string): void;
  /** Prints one task. */
  one(t: Task): void;
}

/**
 * What a command file exports. `help` holds the `fm help` lines by command name, where
 * help.ts looks them up. `early` runs before anything else and may return undefined to
 * pass (fm add <title> isn't a kit piece); `local` knows the actor; `commands` get the
 * database too.
 */
export interface Module {
  help?: Record<string, string>;
  early?: Record<string, (c: Base) => Promise<Exit | undefined> | Exit | undefined>;
  local?: Record<string, (c: Local) => Promise<Exit> | Exit>;
  commands?: Record<string, (c: Ctx) => Promise<Exit> | Exit>;
}

export function num(v: string | undefined, fallback: number, flag: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ForemanError("invalid", `${flag} must be a number of at least 0, got "${v}"`);
  return n;
}

export function line(t: Task): string {
  const who = t.assignee ? ` @${t.assignee}` : "";
  return `${t.id}  ${t.status.padEnd(14)} ${t.risk.padEnd(6)} ${t.title}${who}`;
}

const RISKS = ["auto", "review", "human"];

/** --risk as given, checked; undefined without the flag (core then picks it from the paths, D0008). */
export function riskFlag(o: Opts): Task["risk"] | undefined {
  if (o.risk !== undefined && !RISKS.includes(o.risk)) throw new ForemanError("invalid", `bad risk ${o.risk}`);
  return o.risk as Task["risk"] | undefined;
}
