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
import { hasLiveSession, printLogs } from "./activity";
import { toMarkdown } from "./export";
import { janitor } from "./janitor";
import { listProjects, recordProject } from "./projects";
import { mergeQueue, type QueueEntry } from "./queue";
import { checkMachine, formatItems, realEnv } from "./setup";
import { repoRoot } from "./store";

function num(v: string | undefined, fallback: number, flag: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ForemanError("invalid", `${flag} must be a number of at least 0, got "${v}"`);
  return n;
}

const HELP = `foreman: a task layer for AI coding agents in parallel git worktrees

Usage: fm <command> [args] [--json]

Projects
  setup [--no-link]             check this machine (bun, git, gh, claude, fm on the PATH, repo trusted
                                in Claude Code), link fm unless --no-link, print what is missing and
                                the command that fixes it; --json for scripts
  create <dir> [--preset p] [--name n] [--no-install] [--no-git]
                                a new project from a preset, with the kit, foreman.json, CI, first commit
  init [dir] [--name n]         add the kit to an existing repository; never overwrites a file
  sync [dir] [--dry-run]        update the kit's files to this version; keeps what the project changed
  sync --all [--dry-run]        every project fm has seen (create, init, sync, setup record them), one
                                result per project

Tasks
  add <title> [--spec md] [--check "cmd: bun test"]... [--path glob]... [--risk auto|review|human]
              [--parent T-1] [--blocked-by T-2]... [--from T-3] [--ready]
  ready-up <id>                 draft -> ready (needs at least one check)
  list [--status s]... [--mine]  (* marks a task with a live session)
  next                          ready tasks whose blockers are done
  show <id>                     task, checks and history
  logs <id> [--role worker|verifier] [-f]
                                what the task's dispatched sessions did: tool calls, text, results, cost;
                                -f keeps printing new lines while a session runs
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

Agents
  dispatch [--max 3] [--once] [--model m] [--budget usd] [--print]
                                claim ready tasks into worktrees, run a worker for each and a fresh
                                verifier once it is submitted; at most --max sessions at once, never two
                                tasks with overlapping paths; --once: see only what fits now through
                                verification, then stop; --budget: each session's limit in USD.
                                Sessions run as Claude Code background sessions: watch them with
                                "claude agents", "claude attach <name>"; --print (or
                                FOREMAN_LAUNCH=print) runs headless "claude -p" instead
Board
  serve [--port 4499] [--queue] local web board on 127.0.0.1; approve and merge from the link it prints;
                                --queue runs the merge queue in the same process (see below)
  merge-queue [--once] [--dry-run] [--settle-seconds 30] [--interval 60]
                                merge approved PRs one at a time: settled green checks at the
                                verified commit; a PR that conflicts with main goes back to ready
  janitor [--stuck-hours 24] [--dry-run]
                                reclaim expired leases, remove finished tasks' worktrees, list stuck tasks

Housekeeping
  reclaim                       release claims whose lease ran out, or whose pinned process is gone
  reserve <kind> [--task id]    next free number (also reads what is on disk: foreman.json "numbers")
  policy [--actor name | --role r]
                                deny rules that apply to an agent (foreman.json "roles"): "agent" plus
                                the role from the actor's prefix (worker-, verifier-, intake-); default
                                actor $FOREMAN_ACTOR; none for a person
  export <id> [--out dir]       write the task as markdown (default docs/tasks/<id>.md)
  mcp                           run the MCP server on stdio
  serve [--port 4499] [--project name|dir] [--queue [--interval 60] [--settle-seconds 30]]
                                local web board on 127.0.0.1 for every project on this machine (or one);
                                approve and merge from the link it prints; --queue also runs the
                                merge queue for each project shown, a pass every --interval seconds
  projects [list|add <dir>|rm <name|dir>|prune|color <name|dir> <colour|none>]
                                the repos the board shows, and their colour labels
                                (~/.config/foreman/projects.json)

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
      queue: { type: "boolean" },
      project: { type: "string" },
      max: { type: "string" },
      once: { type: "boolean" },
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
      name: { type: "string" },
      "no-install": { type: "boolean" },
      "no-git": { type: "boolean" },
      all: { type: "boolean" },
      "no-link": { type: "boolean" },
      follow: { type: "boolean", short: "f" },
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
  if (cmd === "policy") {
    // Needs no database: the guard hook asks this on every tool call of an agent session.
    const { resolvePolicy, loadRoles, rulesForRole, ruleWarning, ROLES } = await import("./roles");
    const root = repoRoot();
    let policy;
    if (o.role !== undefined) {
      if (o.role !== "agent" && !(ROLES as readonly string[]).includes(o.role)) {
        throw new ForemanError("invalid", `--role must be agent, ${ROLES.join(", ")}; got "${o.role}"`);
      }
      const role = o.role === "agent" ? null : (o.role as (typeof ROLES)[number]);
      policy = { actor: null, role, rules: rulesForRole(loadRoles(root), role) };
    } else {
      policy = resolvePolicy(root, o.actor ?? process.env.FOREMAN_ACTOR ?? null);
    }
    const text = policy.rules.length ? policy.rules.map((r) => `${r.role.padEnd(9)} ${r.rule}`).join("\n") : "no role rules";
    for (const r of policy.rules) {
      const w = ruleWarning(r.rule);
      if (w) console.error(`warning: ${w}`); // stderr: --json on stdout stays parseable
    }
    console.log(o.json ? JSON.stringify(policy, null, 2) : text);
    return 0;
  }

  if (cmd === "setup") {
    const root = (() => {
      try {
        return repoRoot();
      } catch {
        return null;
      }
    })();
    const items = checkMachine(realEnv(root), { link: !o["no-link"] });
    if (root) recordProject(root);
    console.log(o.json ? JSON.stringify({ ok: items.every((i) => i.ok), items }, null, 2) : formatItems(items));
    return items.every((i) => i.ok) ? 0 : 1;
  }
  if (cmd === "create" || cmd === "init" || cmd === "sync") {
    const { runKitCommand } = await import("./kit/index");
    const kit = { preset: o.preset, name: o.name, noInstall: o["no-install"], noGit: o["no-git"], dryRun: o["dry-run"] };
    if (args.length > 1) throw new ForemanError("invalid", `unexpected argument: ${args[1]}`);
    if (cmd === "sync" && o.all) {
      if (args.length) throw new ForemanError("invalid", "sync --all takes no directory");
      const projects = listProjects();
      if (!projects.length) return console.log("no projects yet: create, init, sync or setup in one first"), 0;
      let failed = 0;
      for (const { dir } of projects) {
        console.log(`== ${dir}`);
        try {
          runKitCommand("sync", dir, kit);
        } catch (e) {
          failed++;
          console.log(`failed: ${(e as Error).message}`);
        }
      }
      console.log(`\n${projects.length} projects, ${failed} failed`);
      return failed ? 1 : 0;
    }
    try {
      runKitCommand(cmd, args[0], kit);
    } catch (e) {
      throw new ForemanError("invalid", (e as Error).message);
    }
    const dir = args[0] ?? ".";
    recordProject(dir);
    return 0;
  }

  const me = actorFromEnv();
  if (cmd === "projects") {
    const reg = await import("./projects");
    const [sub, target] = args;
    if (sub === "add") {
      const root = reg.addProject(target ?? process.cwd());
      console.log(`registered ${root}`);
    } else if (sub === "rm") {
      if (!target) throw new ForemanError("invalid", "missing project name or directory");
      console.log(`removed ${reg.removeProject(target)}`);
    } else if (sub === "prune") {
      const gone = reg.pruneProjects();
      console.log(gone.length ? `removed ${gone.length} missing:\n${gone.join("\n")}` : "nothing to prune");
    } else if (sub === "color" || sub === "colour") {
      const color = args[2];
      if (!target || !color) throw new ForemanError("invalid", `fm projects color <name|dir> <${reg.LABEL_COLORS.join("|")}|none>`);
      if (color !== "none" && !reg.isLabelColor(color)) throw new ForemanError("invalid", `unknown colour "${color}": use ${reg.LABEL_COLORS.join(", ")} or none`);
      const p = reg.findProject(target);
      reg.setColor(p.dir, color === "none" ? null : color);
      console.log(color === "none" ? `${p.name}: no colour label` : `${p.name}: ${color}`);
    } else if (sub === undefined || sub === "list") {
      const colors = reg.readColors();
      const ps = reg.listProjects().map((p) => ({ ...p, color: colors[p.dir] ?? null }));
      const text = ps.length ? ps.map((p) => `${p.name.padEnd(20)} ${(p.color ?? "-").padEnd(7)} ${p.dir}${"error" in reg.projectRoot(p.dir) ? "  (missing: no repo or database)" : ""}`).join("\n") : "no projects yet: run fm in a repo, or fm projects add <dir>";
      console.log(o.json ? JSON.stringify(ps, null, 2) : text);
    } else throw new ForemanError("invalid", `fm projects [list | add <dir> | rm <name|dir> | prune | color <name|dir> <colour|none>], got "${sub}"`);
    return 0;
  }
  if (cmd === "serve") {
    const port = o.port === undefined ? 4499 : Number(o.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ForemanError("invalid", `bad port ${o.port}`);
    const reg = await import("./projects");
    // The current repo first (if we are in one), then the registry; a stale entry is skipped, said once.
    const here = reg.projectRoot(process.cwd());
    if ("root" in here) reg.noteProject(here.root);
    const dirs = [...("root" in here ? [here.root] : []), ...reg.readRegistry()].filter((d, i, all) => all.indexOf(d) === i);
    const valid = dirs.filter((d) => {
      const r = reg.projectRoot(d);
      if ("error" in r) console.error(`skipping ${d}: ${r.error}`);
      return "root" in r;
    });
    let named = reg.nameProjects(valid);
    if (o.project !== undefined) {
      const want = o.project;
      const dir = "root" in reg.projectRoot(want) ? (reg.projectRoot(want) as { root: string }).root : null;
      named = named.filter((p) => p.name === want || p.dir === dir);
      if (!named.length) throw new ForemanError("not_found", `no project "${want}" (fm projects lists them)`);
    }
    if (!named.length) throw new ForemanError("invalid", "no projects to show: run this in a repo with a .foreman database, or fm projects add <dir>");
    const { startBoard } = await import("./board/server");
    // An agent that starts the board would read the token from its own output: no approving
    // then. Like `approve`, a person means an interactive terminal too (not a pipe or a log).
    const person = me.kind === "human" && process.stdin.isTTY === true && process.stdout.isTTY === true;
    const projects = named.map((p) => ({ name: p.name, dir: p.dir, foreman: Foreman.open(p.dir) }));
    let board;
    try {
      // --queue: the merge queue runs in this process too, as `fm merge-queue` would.
      const queueActor = process.env.FOREMAN_ACTOR ? me : { name: "merge-queue", kind: me.kind };
      const prefix = projects.length > 1;
      const autoQueue = o.queue
        ? {
            actor: queueActor,
            intervalMs: num(o.interval, 60, "--interval") * 1000,
            onPass: (name: string, r: QueueEntry[]) => {
              const lines = r.map((e) => `${e.id}  ${e.action.padEnd(15)} ${e.reason}`);
              const text = lines.join("\n") || "nothing approved";
              console.log(prefix ? text.split("\n").map((l) => `${name}: ${l}`).join("\n") : text);
            },
            onError: (name: string, e: unknown) => console.error(`${name}: merge queue pass failed: ${e instanceof Error ? e.message : String(e)}`),
          }
        : undefined;
      board = startBoard({
        projects,
        port,
        approver: person ? me : null,
        queue: o.queue ? { settleSeconds: num(o["settle-seconds"], 30, "--settle-seconds") } : undefined,
        autoQueue,
      });
    } catch (e) {
      // Another fm serve on this port: say so and point at it, instead of failing.
      const url = `http://127.0.0.1:${port}`;
      if (port !== 0 && (e as { code?: string }).code === "EADDRINUSE") {
        const other = await fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ board?: string }>, () => null);
        if (other?.board === "foreman") {
          if (o.queue) {
            // The person asked for the queue: don't let the other board's link hide that it isn't running.
            throw new ForemanError(
              "invalid",
              `a foreman board is already running on port ${port} (${url}), so the merge queue did not start: stop that board and run this again, pass --port for another board, or run fm merge-queue`,
            );
          }
          console.log(`a foreman board is already running on port ${port}: ${url}`);
          console.log("use its link (the token was shown in the terminal that started it), or pass --port for another board");
          return 0;
        }
        throw new ForemanError("invalid", `port ${port} is taken by something that isn't a foreman board; try --port`);
      }
      throw e;
    }
    console.log(`projects: ${projects.map((p) => p.name).join(", ")}`);
    if (board.queueRunning) console.log(`merge queue: on, a pass every ${num(o.interval, 60, "--interval")} s (Ctrl-C stops it and the board)`);
    if (board.token) {
      // The token rides in the fragment, which the browser keeps to itself (D0021).
      console.log(`foreman board: ${board.openUrl}`);
      console.log("open this link to approve and merge from the page; it is shown only here");
    } else {
      console.log(`foreman board: ${board.url}`);
      console.log("read-only: not a person at an interactive terminal, so approving and merging from the page are off");
    }
    return null;
  }
  const f = Foreman.open();
  if (!process.env.FOREMAN_DB) (await import("./projects")).noteProject(process.cwd());
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
      const live = new Set(ts.filter((t) => hasLiveSession(f, t.id)).map((t) => t.id));
      return out(ts.map((t) => ({ ...t, live: live.has(t.id) })), ts.map((t) => `${live.has(t.id) ? "*" : " "} ${line(t)}`).join("\n") || "no tasks"), 0;
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
    case "logs": {
      const role = o.role as string | undefined;
      if (role && !["worker", "verifier"].includes(role)) throw new ForemanError("invalid", `bad role ${role}`);
      const lines: string[] = [];
      const code = await printLogs(f, need(0, "task id"), { role, follow: o.follow as boolean | undefined, write: (l) => (o.json ? lines.push(l) : console.log(l)) });
      if (o.json) console.log(JSON.stringify({ lines }));
      return code;
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
        mode: o.print ? "print" : undefined,
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
