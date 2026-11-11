// Plans (D0033): ordered steps, each with a check, and the tasks that make each step.
// The order holds: a task can't be claimed until every earlier step is done (D0042, waiting.ts).
// Progress is never stored: it comes from the tasks' statuses every time it's read.
// The tables are additive (store.ts), so an older foreman on the same database ignores them.
import { type Actor, type CreateInput, type Foreman, ForemanError, type Status, type Task } from "./core";
import { roleOf } from "./roles";
import { cycleThrough } from "./waiting";

export type StepState = "empty" | "waiting" | "in_progress" | "done";
export type PlanState = "active" | "done" | "cancelled";

export interface StepInput {
  title: string;
  check: string;
}

export interface PlanStep {
  n: number; // 1, 2, ... in order
  title: string;
  check: string;
  state: StepState;
  tasks: Pick<Task, "id" | "title" | "status" | "assignee" | "pr">[];
}

export interface Plan {
  id: string; // P-0001
  title: string;
  goal: string;
  state: PlanState;
  cancelReason: string | null;
  steps: PlanStep[];
  progress: { steps: number; stepsDone: number; tasks: number; tasksDone: number };
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanCreateInput {
  title: string;
  goal?: string;
  steps: StepInput[];
}

export interface PlanEditInput {
  title?: string;
  goal?: string;
  addSteps?: StepInput[];
}

/** Where a task sits in a plan, if it is in one. */
export interface Placement {
  plan: string;
  step: number;
}

type Row = Record<string, unknown>;

// Past "ready": someone has started on it.
const STARTED: Status[] = ["claimed", "in_progress", "in_review", "verifying", "needs_approval", "approved"];

/** A step's state from its tasks' statuses. */
export function stepState(statuses: Status[]): StepState {
  const live = statuses.filter((s) => s !== "cancelled");
  if (!statuses.length) return "empty";
  if (live.length === 0) return "empty"; // only cancelled tasks: nothing left that would finish it
  if (live.every((s) => s === "done")) return "done";
  if (live.some((s) => STARTED.includes(s) || s === "done")) return "in_progress";
  return "waiting";
}

/** "title :: check", the CLI's form of a step. */
export function parseStep(s: string): StepInput {
  const i = s.indexOf("::");
  if (i < 0) throw new ForemanError("invalid", `a step is "title :: check", got "${s}"`);
  return { title: s.slice(0, i).trim(), check: s.slice(i + 2).trim() };
}

export class Plans {
  constructor(
    private f: Foreman,
    private now: () => number = Date.now,
  ) {}

  private get db() {
    return this.f.db;
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  /** Plan events go in the shared history; a task's own history gets one too when it joins or leaves. */
  private event(taskId: string | null, actor: Actor, type: string, data: object) {
    this.db
      .query(`INSERT INTO events (task_id, at, actor, actor_kind, type, data) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(taskId, this.now(), actor.name, actor.kind, type, JSON.stringify(data));
  }

  private touch(id: string) {
    this.db.query(`UPDATE plans SET updated_at = ? WHERE id = ?`).run(this.now(), id);
  }

  private checkSteps(steps: StepInput[]) {
    for (const s of steps) {
      if (!s.title?.trim()) throw new ForemanError("invalid", "a step needs a title");
      if (!s.check?.trim()) throw new ForemanError("invalid", `step "${s.title.trim()}" needs a check: what shows it is done`);
    }
  }

  private row(id: string): Row {
    const r = this.db.query(`SELECT * FROM plans WHERE id = ?`).get(id) as Row | null;
    if (!r) throw new ForemanError("not_found", `no plan ${id}`);
    return r;
  }

  private open(id: string, verb: string): Row {
    const r = this.row(id);
    if (r.status === "cancelled") throw new ForemanError("bad_status", `can't ${verb} ${id}: it is cancelled`);
    return r;
  }

  private stepCount(id: string): number {
    return (this.db.query(`SELECT COUNT(*) AS n FROM plan_steps WHERE plan_id = ?`).get(id) as { n: number }).n;
  }

  private addStepRows(id: string, steps: StepInput[]) {
    let n = this.stepCount(id);
    for (const s of steps) {
      this.db
        .query(`INSERT INTO plan_steps (plan_id, n, title, check_text) VALUES (?, ?, ?, ?)`)
        .run(id, ++n, s.title.trim(), s.check.trim());
    }
  }

  // ---- reading ----

  get(id: string): Plan {
    const r = this.row(id);
    const steps = this.db.query(`SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY n`).all(id) as Row[];
    const tasks = this.db
      .query(
        `SELECT pt.step, t.id, t.title, t.status, t.assignee, t.pr FROM plan_tasks pt
         JOIN tasks t ON t.id = pt.task_id WHERE pt.plan_id = ? ORDER BY t.num`,
      )
      .all(id) as Row[];
    const out: PlanStep[] = steps.map((s) => {
      const mine = tasks
        .filter((t) => t.step === s.n)
        .map((t) => ({
          id: t.id as string,
          title: t.title as string,
          status: t.status as Status,
          assignee: (t.assignee as string) ?? null,
          pr: (t.pr as string) ?? null,
        }));
      return {
        n: s.n as number,
        title: s.title as string,
        check: s.check_text as string,
        state: stepState(mine.map((t) => t.status)),
        tasks: mine,
      };
    });
    const all = out.flatMap((s) => s.tasks).filter((t) => t.status !== "cancelled");
    const stepsDone = out.filter((s) => s.state === "done").length;
    const cancelled = r.status === "cancelled";
    return {
      id,
      title: r.title as string,
      goal: r.goal as string,
      state: cancelled ? "cancelled" : out.length > 0 && stepsDone === out.length ? "done" : "active",
      cancelReason: (r.cancel_reason as string) ?? null,
      steps: out,
      progress: { steps: out.length, stepsDone, tasks: all.length, tasksDone: all.filter((t) => t.status === "done").length },
      createdBy: r.created_by as string,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    };
  }

  /** Every plan, active first, then done, then cancelled; oldest first within each. */
  list(): Plan[] {
    const order: PlanState[] = ["active", "done", "cancelled"];
    const ids = (this.db.query(`SELECT id FROM plans ORDER BY num`).all() as { id: string }[]).map((r) => r.id);
    return ids.map((id) => this.get(id)).sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  }

  /** The plan and step a task is in, or null. */
  placement(taskId: string): Placement | null {
    const r = this.db.query(`SELECT plan_id, step FROM plan_tasks WHERE task_id = ?`).get(taskId) as Row | null;
    return r ? { plan: r.plan_id as string, step: r.step as number } : null;
  }

  // ---- writing ----

  /**
   * Plans are shaped by people and their own sessions, not by dispatched ones (D0033). The CLI and
   * MCP both come through here, so a worker can't get round its tool list with Bash.
   */
  private mayShape(actor: Actor, verb: string, intakeMay = false) {
    const role = actor.kind === "agent" ? roleOf(actor.name) : null;
    if (role && !(role === "intake" && intakeMay)) {
      throw new ForemanError("not_allowed", `a dispatched ${role} session can't ${verb} a plan; file the work with create_task, or tell the person`);
    }
  }

  /** Intake (T-0098) may file a plan and put its own tasks in it; nothing else. */
  private isIntake(actor: Actor): boolean {
    return actor.kind === "agent" && roleOf(actor.name) === "intake";
  }

  create(input: PlanCreateInput, actor: Actor): Plan {
    this.mayShape(actor, "create", true);
    if (!input.title?.trim()) throw new ForemanError("invalid", "a plan needs a title");
    if (!input.steps?.length) throw new ForemanError("invalid", "a plan needs at least one step");
    this.checkSteps(input.steps);
    const id = this.tx(() => {
      const { n } = this.db.query(`SELECT COALESCE(MAX(num), 0) + 1 AS n FROM plans`).get() as { n: number };
      const id = `P-${String(n).padStart(4, "0")}`;
      const at = this.now();
      this.db
        .query(
          `INSERT INTO plans (id, num, title, goal, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(id, n, input.title.trim(), input.goal ?? "", actor.name, at, at);
      this.addStepRows(id, input.steps);
      this.event(null, actor, "plan_created", { plan: id, title: input.title.trim(), steps: input.steps.length });
      return id;
    });
    return this.get(id);
  }

  edit(id: string, actor: Actor, c: PlanEditInput): Plan {
    this.mayShape(actor, "edit");
    if (c.title !== undefined && !c.title.trim()) throw new ForemanError("invalid", "a plan needs a title");
    if (c.addSteps?.length) this.checkSteps(c.addSteps);
    this.tx(() => {
      this.open(id, "edit");
      const fields: string[] = [];
      const values: string[] = [];
      if (c.title !== undefined) fields.push("title = ?"), values.push(c.title.trim());
      if (c.goal !== undefined) fields.push("goal = ?"), values.push(c.goal);
      if (fields.length) this.db.query(`UPDATE plans SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
      if (c.addSteps?.length) this.addStepRows(id, c.addSteps);
      if (!fields.length && !c.addSteps?.length) return;
      this.touch(id);
      this.event(null, actor, "plan_edited", { plan: id, ...c });
    });
    return this.get(id);
  }

  cancel(id: string, actor: Actor, reason: string): Plan {
    this.mayShape(actor, "cancel");
    if (!reason?.trim()) throw new ForemanError("invalid", "cancelling a plan needs a reason");
    this.tx(() => {
      this.open(id, "cancel");
      this.db.query(`UPDATE plans SET status = 'cancelled', cancel_reason = ? WHERE id = ?`).run(reason.trim(), id);
      this.touch(id);
      this.event(null, actor, "plan_cancelled", { plan: id, reason: reason.trim() });
    });
    return this.get(id);
  }

  /** Put a task in a plan's step, moving it if it was in another. */
  add(taskId: string, planId: string, step: number, actor: Actor): Plan {
    this.mayShape(actor, "move tasks in", true);
    if (this.isIntake(actor)) {
      if (this.row(planId).created_by !== actor.name || this.f.get(taskId).createdBy !== actor.name) {
        throw new ForemanError("not_allowed", "an intake session only puts the tasks it filed into the plan it filed");
      }
    }
    this.place(taskId, planId, step, actor);
    return this.get(planId);
  }

  private place(taskId: string, planId: string, step: number, actor: Actor) {
    this.tx(() => {
      this.f.get(taskId);
      this.open(planId, "add tasks to");
      const steps = this.stepCount(planId);
      if (!Number.isInteger(step) || step < 1 || step > steps) {
        throw new ForemanError("invalid", `${planId} has steps 1 to ${steps}, not ${step}`);
      }
      const was = this.placement(taskId);
      if (was?.plan === planId && was.step === step) return;
      this.db
        .query(`INSERT OR REPLACE INTO plan_tasks (task_id, plan_id, step) VALUES (?, ?, ?)`)
        .run(taskId, planId, step);
      // Steps gate (D0042): a task blocked by one in a later step would wait on itself.
      const loop = cycleThrough(this.f, taskId);
      if (loop) throw new ForemanError("cycle", `${taskId} can't go in step ${step} of ${planId}: that would make a cycle (${loop.join(" waits on ")})`);
      if (was && was.plan !== planId) this.touch(was.plan);
      this.touch(planId);
      this.event(taskId, actor, "planned", { plan: planId, step, ...(was ? { from: was } : {}) });
    });
  }

  /** Take a task out of its plan. */
  remove(taskId: string, actor: Actor): Placement {
    this.mayShape(actor, "take a task out of");
    return this.tx(() => {
      this.f.get(taskId);
      const was = this.placement(taskId);
      if (!was) throw new ForemanError("invalid", `${taskId} is in no plan`);
      this.db.query(`DELETE FROM plan_tasks WHERE task_id = ?`).run(taskId);
      this.touch(was.plan);
      this.event(taskId, actor, "unplanned", { plan: was.plan, step: was.step });
      return was;
    });
  }

  /** File a task straight into a plan's step: one transaction, so a bad step files nothing. */
  createTask(input: CreateInput, placement: Placement | null, actor: Actor): Task {
    if (!placement) return this.f.create(input, actor);
    if (this.isIntake(actor) && this.row(placement.plan).created_by !== actor.name) {
      throw new ForemanError("not_allowed", "an intake session only files tasks into the plan it filed");
    }
    return this.tx(() => {
      const t = this.f.create(input, actor);
      this.place(t.id, placement.plan, placement.step, actor); // any filer, a worker too
      return this.f.get(t.id);
    });
  }
}

/** A plan as readable lines, for `fm plan show` and the MCP show_plan. */
export function planText(p: Plan): string {
  const mark: Record<StepState, string> = { empty: "-", waiting: "○", in_progress: "●", done: "✓" };
  const head = `${p.id}  ${p.state.padEnd(9)} ${p.title}  (${p.progress.stepsDone}/${p.progress.steps} steps, ${p.progress.tasksDone}/${p.progress.tasks} tasks done)`;
  const lines = [head];
  if (p.cancelReason) lines.push(`cancelled: ${p.cancelReason}`);
  if (p.goal.trim()) lines.push("", p.goal.trim());
  lines.push("");
  for (const s of p.steps) {
    lines.push(`${mark[s.state]} ${s.n}. ${s.title}  [${s.state.replace("_", " ")}]`);
    lines.push(`     check: ${s.check}`);
    for (const t of s.tasks) lines.push(`     ${t.id}  ${t.status.padEnd(14)} ${t.title}${t.assignee ? ` @${t.assignee}` : ""}`);
    if (!s.tasks.length) lines.push("     (no tasks yet)");
  }
  return lines.join("\n");
}

/** One line per plan, for `fm plan list`. */
export function planLine(p: Plan): string {
  return `${p.id}  ${p.state.padEnd(9)} ${String(p.progress.stepsDone).padStart(2)}/${p.progress.steps} steps  ${String(p.progress.tasksDone).padStart(2)}/${p.progress.tasks} tasks  ${p.title}`;
}
