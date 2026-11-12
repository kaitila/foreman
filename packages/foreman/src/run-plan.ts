// A session runs a plan and watches it (D0048). `run_plan` / `fm plan run` starts the
// plan's dispatcher (D0045) as a detached process that outlives the caller, `watch_plan` /
// `fm plan watch` returns when something happened to the plan's tasks, and `stop_plan` /
// `fm plan stop` stops it. Only a person, or a session a person runs, starts or stops one.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLine, readFileSafe, recentActivity, taskSessions } from "./activity";
import { type Actor, type Event, type Foreman, ForemanError, type Status } from "./core";
import { type DispatcherInfo, dispatcherLine, runningDispatchers, scopeCovers, startsWorkers, stopDispatcher, type StopOptions, type Stopped } from "./dispatchers";
import { type Plan, Plans } from "./plans";
import { roleOf } from "./roles";
import { snapshot, waitShort } from "./waiting";

const CLI = join(import.meta.dir, "cli.ts");

/**
 * A dispatcher starts sessions that spend money, and stopping one throws their work away:
 * both are for a person or a session a person runs, never for a session a dispatcher
 * started (D0048). The CLI and MCP both come through here, so Bash is closed as well.
 */
export function refuseDispatched(actor: Actor, verb: "start" | "stop"): void {
  const role = actor.kind === "agent" ? roleOf(actor.name) : null;
  if (role) {
    throw new ForemanError("not_allowed", `a dispatched ${role} session can't ${verb} a dispatcher: only a person, or a session a person runs, ${verb}s sessions that spend money`);
  }
}

/** Where the plan's dispatcher writes what it does: beside the database, so normally in .foreman/. */
export function planLogPath(f: Foreman, plan: string): string {
  const db = f.db.filename;
  const dir = db && db !== ":memory:" ? dirname(db) : join(f.root ?? process.cwd(), ".foreman");
  return join(dir, `dispatch-${plan}.log`);
}

export interface RunPlanOptions {
  /** Sessions at once. Default: the dispatcher's own (3). */
  max?: number;
  model?: string;
  /** Each session's limit in USD. */
  budgetUsd?: number;
  /** The command to start, for tests. Default: this foreman's `dispatch --plan <id>`. */
  command?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for the dispatcher to show in the registry. Default 15 s. */
  waitMs?: number;
  pollMs?: number;
}

export interface PlanRun {
  /** False when a dispatcher already covered the plan: that one is returned, and nothing was started. */
  started: boolean;
  pid: number;
  scope: string;
  max: number;
  startedBy: string;
  /** The file it logs to; null for a dispatcher this command didn't start. */
  log: string | null;
  note: string;
}

const tail = (path: string, n: number) => readFileSafe(path).trim().split("\n").slice(-n).join("\n").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function positiveInt(n: number | undefined, what: string): void {
  if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new ForemanError("invalid", `${what} must be a whole number of at least 1, got ${n}`);
}

function already(d: DispatcherInfo, plan: string): PlanRun {
  return {
    started: false,
    pid: d.pid,
    scope: d.scope,
    max: d.max,
    startedBy: d.starter.name,
    log: null,
    note: `a dispatcher already covers ${plan}: pid ${d.pid} (${d.scope}), started by ${d.starter.name}. Nothing was started; watch it with watch_plan.`,
  };
}

/**
 * Start the plan's dispatcher as its own process group, with its output in a log file, so
 * it keeps running when the caller (a session, or its MCP server) ends. Marks nothing
 * ready. When a dispatcher that starts workers already covers the plan, that one is
 * returned and nothing is started.
 */
export async function runPlan(f: Foreman, planId: string, actor: Actor, o: RunPlanOptions = {}): Promise<PlanRun> {
  refuseDispatched(actor, "start");
  const plan = new Plans(f).get(planId);
  if (plan.state !== "active") throw new ForemanError("invalid", `plan ${planId} is ${plan.state}: nothing to run`);
  positiveInt(o.max, "max");
  if (o.budgetUsd !== undefined && !(o.budgetUsd > 0)) throw new ForemanError("invalid", `budget must be a positive number, got ${o.budgetUsd}`);
  const covering = () => runningDispatchers(f).find((d) => startsWorkers(d, planId));
  const running = covering();
  if (running) return already(running, planId);

  const log = planLogPath(f, planId);
  mkdirSync(dirname(log), { recursive: true });
  const cmd = o.command ?? [
    process.execPath,
    CLI,
    "dispatch",
    "--plan",
    planId,
    ...(o.max !== undefined ? ["--max", String(o.max)] : []),
    ...(o.model ? ["--model", o.model] : []),
    ...(o.budgetUsd !== undefined ? ["--budget", String(o.budgetUsd)] : []),
  ];
  // The dispatcher acts as whoever asked for it, so the registry names its starter.
  const env: Record<string, string | undefined> = { ...(o.env ?? process.env), FOREMAN_ACTOR: actor.name };
  if (actor.kind === "agent") env.FOREMAN_AGENT = "1";
  const fd = openSync(log, "a");
  let exit: number | null | undefined;
  let pid: number;
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: o.cwd ?? f.root ?? process.cwd(), env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", fd, fd] });
    if (child.pid === undefined) throw new ForemanError("not_started", `couldn't start the dispatcher for ${planId} (${cmd[0]})`);
    pid = child.pid;
    child.on("exit", (code) => {
      exit = code;
    });
    child.on("error", () => {
      exit ??= null;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }

  const deadline = Date.now() + (o.waitMs ?? 15_000);
  for (;;) {
    const d = runningDispatchers(f, { drop: false }).find((x) => x.pid === pid);
    if (d) {
      return { started: true, pid, scope: d.scope, max: d.max, startedBy: d.starter.name, log, note: `started the dispatcher for ${planId}: pid ${pid}, log ${log}. It runs until nothing of the plan is left that could start without a person; follow it with watch_plan.` };
    }
    if (exit !== undefined) {
      // Two started together: the other one won the scope (D0045).
      const other = covering();
      if (other) return already(other, planId);
      const last = tail(log, 5);
      if (exit === 0) {
        throw new ForemanError("nothing_to_run", `the dispatcher for ${planId} ended at once: nothing of the plan can start without a person (drafts aren't ready; show_plan and show_task say what each task waits on)${last ? `\n${last}` : ""}`);
      }
      throw new ForemanError("not_started", `the dispatcher for ${planId} didn't start (exit ${exit ?? "?"}), log ${log}${last ? `\n${last}` : ""}`);
    }
    if (Date.now() >= deadline) throw new ForemanError("timeout", `the dispatcher for ${planId} (pid ${pid}) hasn't shown in the registry yet: look at ${log}`);
    await sleep(o.pollMs ?? 50);
  }
}

/** Stop the dispatcher started for the plan, as `fm dispatch --stop <plan>` does (D0045). */
export async function stopPlan(f: Foreman, planId: string, actor: Actor, o: StopOptions = {}): Promise<Stopped> {
  refuseDispatched(actor, "stop");
  new Plans(f).get(planId);
  return stopDispatcher(f, planId, actor, o);
}

// ---- watching ----

export type HappenedKind =
  | "submitted"
  | "passed"
  | "failed"
  | "needs_approval"
  | "ended_early"
  | "approved"
  | "merged"
  | "cancelled"
  | "no_dispatcher"
  | "plan_done"
  | "plan_cancelled";

/** One thing the watcher should know about. */
export interface Happened {
  /** The event's id; absent for what is read from the state (no dispatcher, plan done). */
  event?: number;
  task?: string;
  kind: HappenedKind;
  text: string;
  /** A failed verdict: the failed checks with the verifier's evidence. */
  failed?: { check: string; evidence: string }[];
}

export interface WatchedTask {
  id: string;
  step: number;
  title: string;
  status: Status;
  pr?: string;
  /** What it waits on, in short (waiting.ts), where it waits. */
  waits?: string;
}

export interface WatchedSession {
  task: string;
  role: string;
  name?: string;
  /** `claude attach <id>` */
  attach?: string;
  /** Its last lines, oldest first. */
  lines: string[];
}

export interface PlanWatch {
  plan: Pick<Plan, "id" | "title" | "state" | "progress">;
  /** The running dispatchers whose scope covers the plan, a line each (`fm dispatchers`). */
  dispatchers: string[];
  /** What happened since `since`, oldest first. Empty on a timeout, and on a first look without `since`. */
  happened: Happened[];
  /** True when the wait ran out with nothing to report. */
  timedOut: boolean;
  tasks: WatchedTask[];
  sessions: WatchedSession[];
  /** Tasks waiting for a person's approval on the board. */
  needsPerson: string[];
  /** Pass this as `since` on the next call. */
  next: number;
}

export interface WatchOptions {
  /** Report what happened after this event id. Without it: the state now, at once. */
  since?: number;
  /** How long to wait for something to happen. Default 60 s, at most 10 min. */
  timeoutMs?: number;
  pollMs?: number;
  /** Lines per live session. Default 3. */
  lines?: number;
  /** Where to look for transcripts. Default: activity.ts's. */
  configDirs?: string[];
}

const MAX_WAIT_MS = 600_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The event as something to report, or null for one the watcher needn't act on. */
function happenedFrom(e: Event, status: Status): Happened | null {
  const task = e.taskId!;
  const base = { event: e.id, task };
  switch (e.type) {
    case "submitted":
      return { ...base, kind: "submitted", text: `${task} submitted${typeof e.data.pr === "string" ? `: ${e.data.pr}` : ""}` };
    case "verified":
      return { ...base, kind: "passed", text: `${task} passed verification` };
    case "escalated":
      return { ...base, kind: "needs_approval", text: `${task} waits for a person's approval: ${String(e.data.reason ?? "escalated")}` };
    case "verify_failed": {
      const failed = ((e.data.results as { check: string; pass: boolean; evidence: string }[] | undefined) ?? [])
        .filter((r) => !r.pass)
        .map((r) => ({ check: r.check, evidence: r.evidence }));
      return { ...base, kind: "failed", failed, text: `${task} failed verification (${failed.map((r) => `${r.check}: ${clip(r.evidence, 200)}`).join("; ")}): it is ${status.replace(/_/g, " ")} again, with the evidence for its next worker` };
    }
    case "lease_expired":
    case "released": {
      const was = String(e.data.was ?? e.actor);
      const verifier = e.data.status === "verifying";
      const why = e.type === "released" && e.data.reason ? ` (${String(e.data.reason)})` : "";
      return { ...base, kind: "ended_early", text: `${task}: ${was} ended without ${verifier ? "a verdict" : "submitting"}${why}` };
    }
    case "approved":
      return { ...base, kind: "approved", text: `${task} approved by ${e.actor}` };
    case "merged":
      return { ...base, kind: "merged", text: `${task} merged: done` };
    case "cancelled":
      return { ...base, kind: "cancelled", text: `${task} cancelled` };
    default:
      return null;
  }
}

/**
 * The plan now, and what happened to its tasks after event `since`. With `since` it waits
 * until something did, no dispatcher covers the plan any more, the plan is finished, or
 * the timeout; without it, it returns the state at once. A session watches a plan with a
 * loop of these, each passing the last one's `next`.
 */
export async function watchPlan(f: Foreman, planId: string, o: WatchOptions = {}): Promise<PlanWatch> {
  const plans = new Plans(f);
  plans.get(planId);
  if (o.since !== undefined && (!Number.isInteger(o.since) || o.since < 0)) throw new ForemanError("invalid", `since must be an event id (a whole number), got ${o.since}`);
  const wait = o.since === undefined ? 0 : Math.min(Math.max(0, o.timeoutMs ?? 60_000), MAX_WAIT_MS);
  const deadline = Date.now() + wait;
  for (;;) {
    const { next } = f.db.query(`SELECT COALESCE(MAX(id), 0) AS next FROM events`).get() as { next: number };
    const plan = plans.get(planId);
    const tasks = plan.steps.flatMap((s) => s.tasks.map((t) => ({ ...t, step: s.n })));
    const statusOf = new Map(tasks.map((t) => [t.id, t.status]));
    const happened: Happened[] = [];
    if (o.since !== undefined) {
      const rows = f.db
        .query(`SELECT e.id FROM events e JOIN plan_tasks pt ON pt.task_id = e.task_id WHERE pt.plan_id = ? AND e.id > ? AND e.id <= ? ORDER BY e.id`)
        .all(planId, o.since, next) as { id: number }[];
      const ids = new Set(rows.map((r) => r.id));
      const events = ids.size ? [...new Set(tasks.map((t) => t.id))].flatMap((id) => f.events(id)).filter((e) => ids.has(e.id)) : [];
      for (const e of events.sort((a, b) => a.id - b.id)) {
        const h = happenedFrom(e, statusOf.get(e.taskId!)!);
        if (!h) continue;
        happened.push(h);
        // A "review" task that passed waits for a person without an event of its own.
        if (h.kind === "passed" && statusOf.get(h.task!) === "needs_approval" && !events.some((x) => x.taskId === h.task && x.type === "escalated" && x.id > e.id)) {
          happened.push({ event: e.id, task: h.task, kind: "needs_approval", text: `${h.task} waits for a person's approval on the board` });
        }
      }
    }
    const dispatchers = runningDispatchers(f, { drop: false }).filter((d) => scopeCovers(d.scope, planId));
    if (o.since !== undefined) {
      if (plan.state === "done") happened.push({ kind: "plan_done", text: `${planId} is done: every step's tasks are merged` });
      else if (plan.state === "cancelled") happened.push({ kind: "plan_cancelled", text: `${planId} is cancelled${plan.cancelReason ? `: ${plan.cancelReason}` : ""}` });
      else if (!dispatchers.length) happened.push({ kind: "no_dispatcher", text: `no dispatcher covers ${planId}: it ended (nothing left that could start without a person), was stopped, or was never started` });
    }
    if (happened.length || Date.now() >= deadline) {
      const s = snapshot(f);
      const live = tasks.filter((t) => ["claimed", "in_progress", "verifying"].includes(t.status));
      const sessions: WatchedSession[] = live.flatMap((t) =>
        taskSessions(f, t.id, o.configDirs)
          .filter((x) => x.live)
          .map((x) => ({
            task: t.id,
            role: x.role,
            ...(x.name ? { name: x.name } : {}),
            ...(x.id ? { attach: x.id } : {}),
            lines: x.path ? recentActivity(x.path, o.lines ?? 3).lines.map(formatLine) : [],
          })),
      );
      return {
        plan: { id: plan.id, title: plan.title, state: plan.state, progress: plan.progress },
        dispatchers: dispatchers.map((d) => dispatcherLine(d)),
        happened,
        timedOut: o.since !== undefined && !happened.length,
        tasks: tasks.map((t) => {
          const waits = waitShort(s, t.id);
          return { id: t.id, step: t.step, title: t.title, status: t.status, ...(t.pr ? { pr: t.pr } : {}), ...(waits ? { waits } : {}) };
        }),
        sessions,
        needsPerson: tasks.filter((t) => t.status === "needs_approval").map((t) => t.id),
        next,
      };
    }
    await sleep(Math.min(o.pollMs ?? 1000, Math.max(1, deadline - Date.now())));
  }
}

/** What `fm plan watch` prints. */
export function watchText(w: PlanWatch): string {
  const p = w.plan;
  const lines = [`${p.id}  ${p.state}  ${p.title}  (${p.progress.stepsDone}/${p.progress.steps} steps, ${p.progress.tasksDone}/${p.progress.tasks} tasks done)`];
  if (w.dispatchers.length) for (const d of w.dispatchers) lines.push(`dispatcher: ${d}`);
  else lines.push(`dispatcher: none covers it (fm plan run ${p.id})`);
  if (w.happened.length) {
    lines.push("", "happened:");
    for (const h of w.happened) lines.push(`- ${h.text}`);
  } else if (w.timedOut) lines.push("", "nothing happened before the timeout");
  lines.push("", "tasks:");
  for (const t of w.tasks) lines.push(`  ${t.step}  ${t.id}  ${t.status.padEnd(14)} ${t.title}${t.waits ? `  (${t.waits})` : ""}`);
  if (!w.tasks.length) lines.push("  (no tasks yet)");
  if (w.sessions.length) {
    lines.push("", "sessions:");
    for (const s of w.sessions) {
      lines.push(`  ${s.task} ${s.role}${s.name ? ` "${s.name}"` : ""}${s.attach ? `: claude attach ${s.attach}` : ""}`);
      for (const l of s.lines) lines.push(`    ${l}`);
    }
  }
  if (w.needsPerson.length) lines.push("", `waiting for a person's approval on the board: ${w.needsPerson.join(", ")}`);
  lines.push("", `next: fm plan watch ${p.id} --since ${w.next}`);
  return lines.join("\n");
}
