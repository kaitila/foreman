#!/usr/bin/env bun
// foreman CLI. Agents and people use the same verbs; --json on every command.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  actorFromEnv,
  type CheckResult,
  Foreman,
  ForemanError,
  type Status,
  type Task,
} from "./core";
import { toMarkdown } from "./export";
import { janitor } from "./janitor";
import { mergeQueue, type QueueEntry } from "./queue";

function num(v: string | undefined, fallback: number, flag: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ForemanError("invalid", `${flag} must be a number of at least 0, got "${v}"`);
  return n;
}

const HELP = `foreman: a task layer for AI coding agents in parallel git worktrees

Usage: foreman <command> [args] [--json]

Tasks
  add <title> [--spec md] [--check "cmd: bun test"]... [--path glob]... [--risk auto|review|human]
              [--parent T-1] [--blocked-by T-2]... [--from T-3] [--ready]
  ready-up <id>                 draft -> ready (needs at least one check)
  list [--status s]... [--mine]
  next                          ready tasks whose blockers are done
  show <id>                     task, checks and history
  edit <id> [--title t] [--spec md] [--check "cmd: ..."]... [--remove-check c2]... [--path g]... [--add-path g]... [--risk r]
                                before work: anything; while claimed: the holder may only --add-path
  rework <id> --reason text     send a submitted, verified or approved task back to work (verify again after)
  cancel <id> --reason text
  intake <request> [--ready] [--model m] [--budget usd]
                                a read-only session files the request as tasks (spec, checks, paths),
                                skipping what the board already has; drafts unless --ready; prints the ids

Working (worker)
  claim [id] [--lease min]      claim a task, or the next ready one
  heartbeat <id>                keep the claim alive
  progress <id> [--note text] [--branch b] [--worktree path]
  submit <id> --pr url [--summary text]

Verifying (anyone who didn't work on it)
  verify <id>                   take the task for verification
  verdict <id> --result 'c1:pass:evidence' ...   or  --results-json file|-

Signing off
  approve [id...] [--note text] people only; no id = everything waiting, after one yes
  merged <id> [--pr url]

Running agents
  dispatch [--max 3] [--once] [--model m] [--budget usd]
                                claim ready tasks into worktrees, run a worker for each and a fresh
                                verifier once it is submitted; at most --max sessions at once, never two
                                tasks with overlapping paths; --once: see only what fits now through
                                verification, then stop; --budget: each session's limit in USD
Running the loop
  merge-queue [--once] [--dry-run] [--settle-seconds 30] [--interval 60]
                                merge approved PRs one at a time: settled green checks at the
                                verified commit; a PR that conflicts with main goes back to ready
  janitor [--stuck-hours 24] [--dry-run]
                                reclaim expired leases, remove finished tasks' worktrees, list stuck tasks

Housekeeping
  reclaim                       release claims whose lease ran out, or whose pinned process is gone
  reserve <kind> [--task id]    next free number (also reads what is on disk: foreman.json "numbers")
  export <id> [--out dir]       write the task as markdown (default docs/tasks/<id>.md)
  mcp                           run the MCP server on stdio
  serve [--port 4499]           local web board on 127.0.0.1; approving there needs the token it prints

Who you are: FOREMAN_ACTOR names you; CLAUDE_CODE_CHILD_SESSION=1 (a command Claude Code runs) or
FOREMAN_AGENT=1 marks you as an agent.
Risk: --risk is optional; by default a task is auto unless its paths touch foreman.json's protectedPaths.
State: <main checkout>/.foreman/foreman.db, or FOREMAN_DB.`;

async function readLine(): Promise<string> {
  for await (const chunk of console) return String(chunk);
  return "";
}

function line(t: Task): string {
  const who = t.assignee ? ` @${t.assignee}` : "";
  return `${t.id}  ${t.status.padEnd(14)} ${t.risk.padEnd(6)} ${t.title}${who}`;
}

function parseResult(s: string): CheckResult {
  const m = /^([^:]+):(pass|fail):(.*)$/s.exec(s);
  if (!m) throw new ForemanError("invalid", `--result must be check:pass|fail:evidence, got "${s}"`);
  return { check: m[1]!.trim(), pass: m[2] === "pass", evidence: m[3]!.trim() };
}

/** Returns the exit code, or null when the process must keep running (the MCP server). */
export async function main(argv: string[]): Promise<number | null> {
  const { values: o, positionals } = parseArgs({
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
      max: { type: "string" },
      once: { type: "boolean" },
      model: { type: "string" },
      budget: { type: "string" },
      "dry-run": { type: "boolean" },
      "settle-seconds": { type: "string" },
      interval: { type: "string" },
      "stuck-hours": { type: "string" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || o.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "mcp") {
    const { serve } = await import("./mcp");
    await serve();
    return null;
  }

  const f = Foreman.open();
  const me = actorFromEnv();
  if (cmd === "serve") {
    const port = o.port === undefined ? 4499 : Number(o.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ForemanError("invalid", `bad port ${o.port}`);
    const { startBoard } = await import("./board/server");
    // An agent that starts the board would read the token from its own output: no approving
    // then. Like `approve`, a person means an interactive terminal too (not a pipe or a log).
    const person = me.kind === "human" && process.stdin.isTTY === true && process.stdout.isTTY === true;
    const board = startBoard({ foreman: f, port, approver: person ? me : null });
    console.log(`foreman board: ${board.url}`);
    if (board.token) console.log(`approve token (paste it on the page; it is shown only here): ${board.token}`);
    else console.log("read-only: not a person at an interactive terminal, so approving from the page is off");
    return null;
  }
  const lease = o.lease ? Number(o.lease) : undefined;
  const need = (i: number, what: string) => {
    const v = args[i];
    if (!v) throw new ForemanError("invalid", `missing ${what}`);
    return v;
  };
  const out = (value: unknown, text: string) => console.log(o.json ? JSON.stringify(value, null, 2) : text);
  const one = (t: Task) => out(t, line(t));

  switch (cmd) {
    case "add": {
      // No --risk: core picks it from the paths (D0008). Don't default to "review" here.
      const risk = o.risk as Task["risk"] | undefined;
      if (risk !== undefined && !["auto", "review", "human"].includes(risk)) throw new ForemanError("invalid", `bad risk ${risk}`);
      const t = f.create(
        {
          title: args.join(" "),
          spec: o.spec,
          acceptance: o.check,
          paths: o.path,
          risk,
          parent: o.parent,
          blockedBy: o["blocked-by"],
          discoveredFrom: o.from,
          ready: o.ready,
        },
        me,
      );
      return one(t), 0;
    }
    case "ready-up":
      return one(f.markReady(need(0, "task id"), me)), 0;
    case "list": {
      const ts = f.list({ status: o.status as Status[] | undefined, assignee: o.mine ? me.name : undefined });
      return out(ts, ts.map(line).join("\n") || "no tasks"), 0;
    }
    case "next": {
      const ts = f.ready(me.kind);
      return out(ts, ts.map(line).join("\n") || "nothing ready"), 0;
    }
    case "show": {
      const t = f.get(need(0, "task id"));
      const ev = f.events(t.id);
      return out({ ...t, events: ev }, toMarkdown(t, ev)), 0;
    }
    case "edit": {
      const risk = o.risk as Task["risk"] | undefined;
      if (risk && !["auto", "review", "human"].includes(risk)) throw new ForemanError("invalid", `bad risk ${risk}`);
      return (
        one(
          f.edit(need(0, "task id"), me, {
            title: o.title,
            spec: o.spec,
            addChecks: o.check,
            removeChecks: o["remove-check"],
            paths: o.path,
            addPaths: o["add-path"],
            risk,
          }),
        ),
        0
      );
    }
    case "rework":
      return one(f.rework(need(0, "task id"), me, o.reason ?? "")), 0;
    case "cancel":
      return one(f.cancel(need(0, "task id"), me, o.reason ?? "")), 0;
    case "intake": {
      const { intakeCommand } = await import("./intake");
      const r = await intakeCommand(f, me, args.join(" "), { ready: o.ready, model: o.model, budget: o.budget });
      return out(r.result, r.text), r.code;
    }
    case "claim":
      return one(f.claim(args[0] ?? null, me, lease)), 0;
    case "heartbeat":
      return one(f.heartbeat(need(0, "task id"), me, lease)), 0;
    case "progress":
      return one(f.progress(need(0, "task id"), me, { note: o.note, branch: o.branch, worktree: o.worktree })), 0;
    case "submit":
      return one(f.submit(need(0, "task id"), me, { pr: o.pr ?? "", summary: o.summary })), 0;
    case "verify":
      return one(f.startVerify(need(0, "task id"), me, lease)), 0;
    case "verdict": {
      let results: CheckResult[] = (o.result ?? []).map(parseResult);
      const rj = o["results-json"];
      if (rj) {
        const text = rj === "-" ? await Bun.stdin.text() : await Bun.file(rj).text();
        results = JSON.parse(text);
      }
      return one(f.recordVerify(need(0, "task id"), me, results)), 0;
    }
    case "approve": {
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
    }
    case "merged":
      return one(f.merged(need(0, "task id"), me, o.pr)), 0;
    case "dispatch": {
      const num = (v: string | undefined, what: string) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new ForemanError("invalid", `--${what} must be a positive number, got "${v}"`);
        return n;
      };
      const { dispatch } = await import("./dispatch");
      const sessions = await dispatch(f, {
        max: num(o.max, "max"),
        once: o.once,
        model: o.model,
        budgetUsd: num(o.budget, "budget"),
        actor: me,
        log: o.json ? () => {} : undefined,
      });
      const cost = sessions.reduce((a, s) => a + s.costUsd, 0);
      const text = sessions.length
        ? `${sessions.map((s) => `${s.task} ${s.role}: ${s.status}${s.error ? ` (${s.error})` : ""}`).join("\n")}\n${sessions.length} sessions, $${cost.toFixed(2)}`
        : "nothing to dispatch";
      return out(sessions, text), 0;
    }
    case "merge-queue": {
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
    }
    case "janitor": {
      const actor = process.env.FOREMAN_ACTOR ? me : { name: "janitor", kind: me.kind };
      const r = await janitor(f, actor, { dryRun: o["dry-run"], stuckHours: num(o["stuck-hours"], 24, "--stuck-hours") });
      const would = o["dry-run"] ? "would " : "";
      const lines = [
        r.reclaimed.length ? `${would}reclaim ${r.reclaimed.join(", ")}` : "no expired claims",
        ...r.removed.map((x) => `${x.id}  ${would}remove ${x.worktree}${x.branchDeleted ? " (and its merged branch)" : ""}${x.portsReleased ? " (ports released)" : ""}`),
        ...r.kept.map((x) => `${x.id}  kept ${x.worktree}: ${x.reason}`),
        ...r.stuck.map((x) => `${x.id}  stuck ${x.status} for ${x.hours}h${x.assignee ? ` @${x.assignee}` : ""}`),
      ];
      return out(r, lines.join("\n")), 0;
    }
    case "reclaim": {
      const ids = f.reclaim(me);
      return out(ids, ids.length ? `released ${ids.join(", ")}` : "no expired claims"), 0;
    }
    case "reserve": {
      const n = f.reserve(need(0, "kind"), me, o.task);
      const label = args[0] === "decision" ? `D${String(n).padStart(4, "0")}` : String(n);
      return out({ kind: args[0], value: n, label }, label), 0;
    }
    case "export": {
      const t = f.get(need(0, "task id"));
      const dir = o.out ?? join(f.root ?? ".", "docs", "tasks");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${t.id}.md`);
      writeFileSync(file, toMarkdown(t, f.events(t.id)));
      return out({ file }, file), 0;
    }
    default:
      throw new ForemanError("invalid", `unknown command "${cmd}" (foreman help)`);
  }
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
