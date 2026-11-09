// Foreman's core: tasks, claims with leases, verification and sign-off (D0002).
// The CLI and the MCP server are thin layers over this; nothing here knows
// which agent tool is calling (D0005).
import type { Database } from "bun:sqlite";
import { gitPolicy, highestOnDisk, isProtected, mayTouchProtected, type Policy, prRepo } from "./policy";
import { dbPath, openDb, repoRoot } from "./store";

export type Risk = "auto" | "review" | "human";
export type Status =
  | "draft" // written, not yet ready to work on
  | "ready" // can be claimed once its blockers are done
  | "claimed" // a worker holds it, not started
  | "in_progress"
  | "in_review" // PR submitted, waiting for a verifier
  | "verifying" // a verifier holds it
  | "needs_approval" // verified; risk "review" waits for a human
  | "approved" // cleared to merge
  | "done" // merged
  | "cancelled";

export interface Check {
  id: string; // c1, c2, ...
  kind: "cmd" | "statement"; // a command that must exit 0, or a claim the verifier judges
  text: string;
}

export interface Task {
  id: string;
  title: string;
  spec: string;
  acceptance: Check[];
  paths: string[];
  risk: Risk;
  status: Status;
  parent: string | null;
  blockedBy: string[];
  discoveredFrom: string | null;
  assignee: string | null;
  leaseUntil: number | null;
  branch: string | null;
  worktree: string | null;
  pr: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Event {
  id: number;
  taskId: string | null;
  at: number;
  actor: string;
  actorKind: Actor["kind"];
  type: string;
  data: Record<string, unknown>;
}

export interface Actor {
  name: string;
  kind: "human" | "agent";
}

export interface CheckResult {
  check: string; // Check.id
  pass: boolean;
  evidence: string; // what the verifier ran or read, and what it saw
}

export class ForemanError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_LEASE_MINUTES = 30;

/** Is this process still running? EPERM means it is, just not ours to signal. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** The rework reason given to an approved PR that conflicts with main. */
export const CONFLICT_REASON = "conflicts with main: merge main and verify again";

/**
 * Who is calling. FOREMAN_ACTOR names them. A command Claude Code runs for the model
 * (CLAUDE_CODE_CHILD_SESSION=1), or anything with FOREMAN_AGENT=1, is an agent.
 * Not CLAUDECODE=1: Claude Code also sets that in IDE terminals, where a person types.
 * This is a guardrail, not a boundary: the hard limits live outside the agent (D0003).
 */
export function actorFromEnv(env = process.env): Actor {
  const agent = env.CLAUDE_CODE_CHILD_SESSION === "1" || env.FOREMAN_AGENT === "1";
  const name = env.FOREMAN_ACTOR || (agent ? `agent-${process.pid}` : env.USER || "human");
  return { name, kind: agent ? "agent" : "human" };
}

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    spec: r.spec as string,
    acceptance: JSON.parse(r.acceptance as string),
    paths: JSON.parse(r.paths as string),
    risk: r.risk as Risk,
    status: r.status as Status,
    parent: (r.parent as string) ?? null,
    blockedBy: JSON.parse(r.blocked_by as string),
    discoveredFrom: (r.discovered_from as string) ?? null,
    assignee: (r.assignee as string) ?? null,
    leaseUntil: (r.lease_until as number) ?? null,
    branch: (r.branch as string) ?? null,
    worktree: (r.worktree as string) ?? null,
    pr: (r.pr as string) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toEvent(r: Row): Event {
  return {
    id: r.id as number,
    taskId: (r.task_id as string) ?? null,
    at: r.at as number,
    actor: r.actor as string,
    actorKind: r.actor_kind as Actor["kind"],
    type: r.type as string,
    data: JSON.parse(r.data as string),
  };
}

export interface EditInput {
  title?: string;
  spec?: string;
  /** New checks, same forms as at create ("cmd: ...", "statement: ..."). */
  addChecks?: string[];
  /** Check ids to drop (c2, ...). */
  removeChecks?: string[];
  /** Replace the paths. */
  paths?: string[];
  /** Add paths (the one change a holder may make while working). */
  addPaths?: string[];
  risk?: Risk;
}

export interface CreateInput {
  title: string;
  spec?: string;
  acceptance?: (string | Omit<Check, "id">)[]; // "cmd: bun test" / "statement: ..." / plain text = statement
  paths?: string[];
  risk?: Risk;
  parent?: string;
  blockedBy?: string[];
  discoveredFrom?: string;
  ready?: boolean;
}

export function parseCheck(c: string | Omit<Check, "id">, i: number): Check {
  if (typeof c !== "string") return { id: `c${i + 1}`, kind: c.kind, text: c.text.trim() };
  const m = /^(cmd|statement)\s*:\s*(.+)$/s.exec(c.trim());
  if (m) return { id: `c${i + 1}`, kind: m[1] as Check["kind"], text: m[2]!.trim() };
  return { id: `c${i + 1}`, kind: "statement", text: c.trim() };
}

export class Foreman {
  constructor(
    public db: Database,
    public root: string | null = null, // repo root, for reserving numbers from files
    private now: () => number = Date.now,
    public policy: Policy = gitPolicy(root),
    /** Checks a pinned lease's process (D0011). Tests replace it. */
    public isAlive: (pid: number) => boolean = pidAlive,
  ) {}

  static open(cwd = process.cwd()): Foreman {
    const root = repoRoot(cwd);
    return new Foreman(openDb(dbPath(cwd)), root, Date.now, gitPolicy(root));
  }

  /** Default risk for a new task: "review" if its declared paths may touch protected ones (D0008). */
  defaultRisk(paths: string[]): Risk {
    return mayTouchProtected(paths, this.policy.protectedPaths) ? "review" : "auto";
  }

  // ---- reading ----

  get(id: string): Task {
    const r = this.db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | null;
    if (!r) throw new ForemanError("not_found", `no task ${id}`);
    return toTask(r);
  }

  list(filter: { status?: Status[]; assignee?: string } = {}): Task[] {
    let sql = `SELECT * FROM tasks`;
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      params.push(...filter.status);
    }
    if (filter.assignee) {
      where.push(`assignee = ?`);
      params.push(filter.assignee);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY num`;
    return (this.db.query(sql).all(...params) as Row[]).map(toTask);
  }

  events(taskId?: string): Event[] {
    const rows = taskId
      ? this.db.query(`SELECT * FROM events WHERE task_id = ? ORDER BY id`).all(taskId)
      : this.db.query(`SELECT * FROM events ORDER BY id`).all();
    return (rows as Row[]).map(toEvent);
  }

  /** Ready tasks whose blockers are all done. Unknown blockers count as not done (fail closed). */
  ready(forKind: Actor["kind"] = "agent"): Task[] {
    const done = new Set(this.list({ status: ["done"] }).map((t) => t.id));
    return this.list({ status: ["ready"] }).filter(
      (t) => t.blockedBy.every((b) => done.has(b)) && (forKind === "human" || t.risk !== "human"),
    );
  }

  // ---- writing (every write is one IMMEDIATE transaction plus an event) ----

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private event(taskId: string | null, actor: Actor, type: string, data: object = {}) {
    this.db
      .query(
        `INSERT INTO events (task_id, at, actor, actor_kind, type, data) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, this.now(), actor.name, actor.kind, type, JSON.stringify(data));
  }

  private set(id: string, fields: Record<string, string | number | null>) {
    // A new holder, or none, ends any lease pinned to the old holder's process.
    if ("assignee" in fields) this.db.query(`DELETE FROM lease_pids WHERE task_id = ?`).run(id);
    const keys = Object.keys(fields);
    this.db
      .query(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]!), this.now(), id);
  }

  private expect(t: Task, allowed: Status[], verb: string) {
    if (!allowed.includes(t.status)) {
      throw new ForemanError(
        "bad_status",
        `can't ${verb} ${t.id}: it is ${t.status} (needs ${allowed.join(" or ")})`,
      );
    }
  }

  private holder(t: Task, actor: Actor, verb: string) {
    if (t.assignee !== actor.name) {
      throw new ForemanError(
        "not_holder",
        `can't ${verb} ${t.id}: it is held by ${t.assignee ?? "nobody"}, not ${actor.name}. To continue as the holder, set FOREMAN_ACTOR=${t.assignee ?? "<holder>"} (CLI) or ask the person who started that session`,
      );
    }
  }

  create(input: CreateInput, actor: Actor): Task {
    if (!input.title.trim()) throw new ForemanError("invalid", "a task needs a title");
    const risk = input.risk ?? this.defaultRisk(input.paths ?? []);
    return this.tx(() => {
      for (const ref of [input.parent, input.discoveredFrom, ...(input.blockedBy ?? [])]) {
        if (ref) this.get(ref);
      }
      const { n } = this.db.query(`SELECT COALESCE(MAX(num), 0) + 1 AS n FROM tasks`).get() as {
        n: number;
      };
      const id = `T-${String(n).padStart(4, "0")}`;
      const at = this.now();
      const acceptance = (input.acceptance ?? []).map(parseCheck);
      this.db
        .query(
          `INSERT INTO tasks (id, num, title, spec, acceptance, paths, risk, status, parent,
             blocked_by, discovered_from, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          n,
          input.title.trim(),
          input.spec ?? "",
          JSON.stringify(acceptance),
          JSON.stringify(input.paths ?? []),
          risk,
          "draft",
          input.parent ?? null,
          JSON.stringify(input.blockedBy ?? []),
          input.discoveredFrom ?? null,
          actor.name,
          at,
          at,
        );
      this.event(id, actor, "created", { title: input.title, risk, riskFrom: input.risk ? "given" : "paths" });
      // "ready" goes through the same rules as markReady (it needs a check).
      return input.ready ? this.markReady(id, actor) : this.get(id);
    });
  }

  /** draft → ready. A task an agent may work on needs at least one acceptance check. */
  markReady(id: string, actor: Actor): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["draft"], "mark ready");
      if (t.risk !== "human" && t.acceptance.length === 0) {
        throw new ForemanError("invalid", `${id} has no acceptance checks; add one before it is ready`);
      }
      this.set(id, { status: "ready" });
      this.event(id, actor, "ready");
      return this.get(id);
    });
  }

  /**
   * Claim a task (or the next ready one). Atomic: two callers can never both win.
   * Expired leases are released first, so a dead worker's task comes back.
   */
  claim(id: string | null, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      this.releaseExpired(actor);
      const t = id ? this.get(id) : this.ready(actor.kind)[0];
      if (!t) throw new ForemanError("none_ready", "no ready task to claim");
      this.expect(t, ["ready"], "claim");
      if (t.risk === "human" && actor.kind !== "human") {
        throw new ForemanError("human_only", `${t.id} is risk "human": a person does it, not an agent`);
      }
      if (!this.ready("human").some((r) => r.id === t.id)) {
        throw new ForemanError("blocked", `${t.id} is waiting on ${t.blockedBy.join(", ")}`);
      }
      this.set(t.id, {
        status: "claimed",
        assignee: actor.name,
        lease_until: this.now() + leaseMinutes * 60_000,
      });
      this.event(t.id, actor, "claimed", { leaseMinutes });
      return this.get(t.id);
    });
  }

  /** Keep a claim alive. Workers call this (or progress) more often than the lease length. */
  heartbeat(id: string, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress", "verifying"], "heartbeat");
      this.holder(t, actor, "heartbeat");
      this.set(id, { lease_until: this.now() + leaseMinutes * 60_000 });
      return this.get(id);
    });
  }

  /**
   * Pin the holder's lease to its process (D0011): while that PID lives, the lease
   * doesn't time out; once it's gone, the claim is released at the next reclaim.
   * The dispatcher calls this right after it starts a worker or verifier.
   */
  pinLease(id: string, actor: Actor, pid: number, session?: { session: string; name: string; sessionId?: string }): Task {
    if (!Number.isInteger(pid) || pid <= 0) throw new ForemanError("invalid", `bad pid ${pid}`);
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress", "verifying"], "pin the lease of");
      this.holder(t, actor, "pin the lease of");
      this.db
        .query(`INSERT OR REPLACE INTO lease_pids (task_id, assignee, pid) VALUES (?, ?, ?)`)
        .run(id, actor.name, pid);
      // A background session (D0022) is named, so `fm show` and the board can say how to watch it.
      this.event(id, actor, "lease_pinned", session ? { pid, ...session, attach: `claude attach ${session.session}` } : { pid });
      return this.get(id);
    });
  }

  /** The process a task's lease is pinned to, if its holder is still the one who pinned it. */
  leasePid(id: string): number | null {
    const r = this.db
      .query(`SELECT p.pid FROM lease_pids p JOIN tasks t ON t.id = p.task_id WHERE p.task_id = ? AND t.assignee = p.assignee`)
      .get(id) as { pid: number } | null;
    return r?.pid ?? null;
  }

  /**
   * The holder lets go without finishing: a claimed task goes back to ready, a task
   * being verified back to in_review. The dispatcher uses it when it can't start a session.
   */
  release(id: string, actor: Actor, reason: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress", "verifying"], "release");
      this.holder(t, actor, "release");
      const back: Status = t.status === "verifying" ? "in_review" : "ready";
      this.set(id, { status: back, assignee: null, lease_until: null });
      this.event(id, actor, "released", { reason, status: t.status });
      return this.get(id);
    });
  }

  progress(
    id: string,
    actor: Actor,
    p: { note?: string; branch?: string; worktree?: string } = {},
  ): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress"], "report progress on");
      this.holder(t, actor, "report progress on");
      const fields: Record<string, string | number | null> = {
        status: "in_progress",
        lease_until: this.now() + DEFAULT_LEASE_MINUTES * 60_000,
      };
      if (p.branch) fields.branch = p.branch;
      if (p.worktree) fields.worktree = p.worktree;
      this.set(id, fields);
      this.event(id, actor, "progress", p);
      return this.get(id);
    });
  }

  /** The worker hands in its PR. It lets go of the task: verification is someone else's job. */
  submit(id: string, actor: Actor, s: { pr: string; summary?: string }): Task {
    let pr = s.pr.trim();
    if (!pr) throw new ForemanError("invalid", "submit needs the PR (url or number)");
    // A bare number or #number becomes this repository's PR URL: the merge queue only takes URLs (T-0074).
    const bare = /^#?(\d+)$/.exec(pr);
    if (bare) {
      const origin = this.policy.originRepo?.() ?? null;
      if (!origin) throw new ForemanError("invalid", `${pr} is a bare PR number and there is no GitHub origin remote to expand it with: submit the PR's full URL`);
      pr = `https://github.com/${origin}/pull/${bare[1]}`;
    } else if (!/^https?:\/\/\S+$/.test(pr)) {
      throw new ForemanError("invalid", `${pr} isn't a PR URL: submit the PR's full URL (or its number)`);
    }
    // A GitHub PR must be this repository's, and its branch the task's (T-0017): otherwise
    // a worker could point foreman at some other, harmless PR. Looked up outside the
    // transaction because it calls GitHub.
    const before = this.get(id);
    let info: { head: string; headSha: string; mergeable?: string; isDraft?: boolean } | null = null;
    const urlRepo = prRepo(pr);
    if (urlRepo) {
      // A GitHub PR is checked or refused, never waved through: if gh can't confirm it,
      // a worker could submit any PR it likes (verifier-13 on T-0017).
      const origin = this.policy.originRepo?.() ?? null;
      if (!origin) {
        throw new ForemanError("pr_unverifiable", `can't tell which GitHub repository this is (no GitHub origin remote), so ${pr} can't be checked`);
      }
      if (origin.toLowerCase() !== urlRepo.toLowerCase()) {
        throw new ForemanError("pr_mismatch", `${pr} is a PR on ${urlRepo}, not on this repository (${origin})`);
      }
      info = this.policy.prInfo?.(pr) ?? null;
      if (!info) {
        throw new ForemanError("pr_unverifiable", `couldn't look up ${pr} (is gh installed and logged in?)`);
      }
      if (before.branch && info.head !== before.branch) {
        throw new ForemanError("pr_mismatch", `${pr} is from branch ${info.head}, but ${id}'s branch is ${before.branch}`);
      }
      if (info.isDraft) {
        throw new ForemanError("pr_draft", `${pr} is a draft: mark it ready with \`gh pr ready ${pr}\`, then submit again`);
      }
      if (info.mergeable === "CONFLICTING") {
        throw new ForemanError("pr_conflicting", `${pr} conflicts with main: merge origin/main, resolve the conflicts, run the gate, push, and submit again`);
      }
    }
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress"], "submit");
      this.holder(t, actor, "submit");
      const fields: Record<string, string | number | null> = { status: "in_review", pr, assignee: null, lease_until: null };
      if (info && !t.branch) fields.branch = info.head;
      this.set(id, fields);
      this.event(id, actor, "submitted", { ...s, pr, ...(info ? { head: info.head, headSha: info.headSha } : {}) });
      return this.get(id);
    });
  }

  /** Whether a person approved the task's current submission (an approval since its last submit). */
  personApproved(id: string): boolean {
    const evs = this.events(id);
    let i = evs.length - 1;
    while (i >= 0 && evs[i]!.type !== "submitted") i--;
    return evs.slice(i + 1).some((e) => e.type === "approved" && e.actorKind === "human");
  }

  /**
   * Send a submitted, verified or approved task back to work (T-0025): the PR is changing
   * again, or a gap was found after the verdict. It must be claimed and verified anew.
   * Its workers or a person may do this; once a person approved it, only a person (T-0094).
   */
  rework(id: string, actor: Actor, reason: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["in_review", "needs_approval", "approved"], "send back for rework");
      if (actor.kind !== "human" && !this.workers(id).has(actor.name)) {
        throw new ForemanError("not_worker", `only someone who worked on ${id}, or a person, can send it back`);
      }
      // A person's sign-off isn't undone behind their back (T-0094): new work after it is a new task.
      if (actor.kind !== "human" && t.status === "approved" && this.personApproved(id)) {
        throw new ForemanError(
          "approved_by_person",
          `${id} was approved by a person, so an agent can't send it back: file the new work as its own task (create_task with discoveredFrom ${id}), or ask the person to rework it`,
        );
      }
      if (!reason.trim()) throw new ForemanError("invalid", "rework needs a reason");
      this.set(id, { status: "ready", assignee: null, lease_until: null });
      this.event(id, actor, "rework", { reason, was: t.status });
      return this.get(id);
    });
  }

  /**
   * Change a task (T-0009). Before work starts anything can change; a person may also
   * edit a claimed task. Once claimed, the holder may only add paths (work turned out to
   * touch more files: the diff still decides who signs off). Nobody edits a task under
   * review: send it back with rework first. Only a person lowers risk, and a ready task
   * keeps at least one check.
   */
  edit(id: string, actor: Actor, c: EditInput): Task {
    return this.tx(() => {
      const t = this.get(id);
      const human = actor.kind === "human";
      const open = t.status === "draft" || t.status === "ready";
      const working = t.status === "claimed" || t.status === "in_progress";
      if (!open && !working) {
        throw new ForemanError("bad_status", `can't edit ${id}: it is ${t.status}${["in_review", "verifying", "needs_approval", "approved"].includes(t.status) ? " (send it back with rework first)" : ""}`);
      }
      const onlyAddsPaths = Object.entries(c).every(([k, v]) => v === undefined || k === "addPaths");
      if (working && !human) {
        this.holder(t, actor, "edit");
        if (!onlyAddsPaths) throw new ForemanError("in_progress", `${id} is being worked on: its holder may only add paths`);
      }
      const order: Risk[] = ["auto", "review", "human"];
      if (c.risk && order.indexOf(c.risk) < order.indexOf(t.risk) && !human) {
        throw new ForemanError("human_only", `only a person can lower ${id}'s risk (${t.risk} → ${c.risk})`);
      }
      let acceptance = t.acceptance;
      if (c.removeChecks?.length) {
        const unknown = c.removeChecks.filter((r) => !acceptance.some((x) => x.id === r));
        if (unknown.length) throw new ForemanError("invalid", `${id} has no check ${unknown.join(", ")}`);
        acceptance = acceptance.filter((x) => !c.removeChecks!.includes(x.id));
      }
      if (c.addChecks?.length) {
        // New checks get new ids; ids are never reused, so old verdicts stay readable.
        let next = Math.max(0, ...t.acceptance.map((x) => Number(x.id.slice(1)) || 0));
        acceptance = [...acceptance, ...c.addChecks.map((x) => ({ ...parseCheck(x, 0), id: `c${++next}` }))];
      }
      if (t.status !== "draft" && t.risk !== "human" && (c.risk ?? t.risk) !== "human" && acceptance.length === 0) {
        throw new ForemanError("invalid", `${id} would have no acceptance checks; a ready task needs one`);
      }
      let paths = c.paths ?? t.paths;
      if (c.addPaths?.length) paths = [...new Set([...paths, ...c.addPaths])];
      const fields: Record<string, string | number | null> = {};
      if (c.title !== undefined) {
        if (!c.title.trim()) throw new ForemanError("invalid", "a task needs a title");
        fields.title = c.title.trim();
      }
      if (c.spec !== undefined) fields.spec = c.spec;
      if (c.risk) fields.risk = c.risk;
      if (JSON.stringify(acceptance) !== JSON.stringify(t.acceptance)) fields.acceptance = JSON.stringify(acceptance);
      if (JSON.stringify(paths) !== JSON.stringify(t.paths)) fields.paths = JSON.stringify(paths);
      if (!Object.keys(fields).length) return t;
      this.set(id, fields);
      this.event(id, actor, "edited", c);
      return this.get(id);
    });
  }

  /** Everyone who has worked on the task. None of them may verify it. */
  workers(id: string): Set<string> {
    const rows = this.db
      .query(`SELECT DISTINCT actor FROM events WHERE task_id = ? AND type IN ('claimed','progress','submitted')`)
      .all(id) as { actor: string }[];
    return new Set(rows.map((r) => r.actor));
  }

  startVerify(id: string, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      this.releaseExpired(actor);
      const t = this.get(id);
      this.expect(t, ["in_review"], "verify");
      if (this.workers(id).has(actor.name)) {
        throw new ForemanError("own_work", `${actor.name} worked on ${id} and can't verify it`);
      }
      this.set(id, {
        status: "verifying",
        assignee: actor.name,
        lease_until: this.now() + leaseMinutes * 60_000,
      });
      this.event(id, actor, "verify_started");
      return this.get(id);
    });
  }

  /**
   * The verifier's verdict, one result per acceptance check. All pass: "auto" tasks
   * are approved to merge, "review" tasks wait for a person. Any fail: back to ready
   * with the results, so the next worker sees what's missing.
   */
  recordVerify(id: string, actor: Actor, results: CheckResult[]): Task {
    // Outside the transaction: it runs git. The branch can't change under us in a way
    // that matters, because escalation only ever adds a person.
    const before = this.get(id);
    const branch = before.branch;
    const changed = before.risk === "auto" ? this.policy.changedFiles({ branch, pr: before.pr }) : [];
    // The commit the verdict is about: merging is refused if the PR moves past it (T-0017).
    const headSha = before.pr && results.every((r) => r.pass) ? (this.policy.prInfo?.(before.pr)?.headSha ?? null) : null;
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["verifying"], "record a verdict on");
      this.holder(t, actor, "record a verdict on");
      const byCheck = new Map(results.map((r) => [r.check, r]));
      const missing = t.acceptance.filter((c) => !byCheck.has(c.id)).map((c) => c.id);
      if (missing.length) {
        throw new ForemanError("incomplete", `no result for ${missing.join(", ")}: every check needs one`);
      }
      const unknown = results.filter((r) => !t.acceptance.some((c) => c.id === r.check));
      if (unknown.length) {
        throw new ForemanError("invalid", `unknown checks: ${unknown.map((r) => r.check).join(", ")}`);
      }
      const pass = results.every((r) => r.pass);
      let next: Status = !pass ? "ready" : t.risk === "auto" ? "approved" : "needs_approval";
      this.set(id, { status: next, assignee: null, lease_until: null });
      this.event(id, actor, pass ? "verified" : "verify_failed", { results, ...(headSha ? { headSha } : {}) });
      if (next === "approved") {
        // The real diff decides (D0008): a protected file, or a diff we can't see, needs a person.
        // An empty diff is as good as none: nothing to approve automatically.
        const seen = changed && changed.length ? changed : null;
        const hit = seen === null ? null : seen.filter((f) => isProtected(f, this.policy.protectedPaths));
        if (hit === null || hit.length) {
          next = "needs_approval";
          this.set(id, { status: next });
          this.event(id, actor, "escalated", hit === null ? { reason: "couldn't see the PR's changes (none found)", branch, pr: before.pr } : { reason: "changes protected paths", files: hit });
        }
      }
      return this.get(id);
    });
  }

  /** A person signs off a verified "review" task (or any "human" task they finished). */
  approve(id: string, actor: Actor, note?: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      if (actor.kind !== "human") {
        throw new ForemanError("human_only", `only a person can approve ${id}`);
      }
      this.expect(t, t.risk === "human" ? ["claimed", "in_progress", "in_review", "needs_approval"] : ["needs_approval"], "approve");
      this.set(id, { status: "approved", assignee: null, lease_until: null });
      this.event(id, actor, "approved", { note });
      return this.get(id);
    });
  }

  /** The PR commit the latest passing verdict was about, or null if it recorded none (D0009). */
  verifiedHead(id: string): string | null {
    const verified = [...this.events(id)].reverse().find((e) => e.type === "verified");
    return (verified?.data.headSha as string | undefined) ?? null;
  }

  /**
   * Send an approved task back because its PR conflicts with main (D0012). Any caller
   * may do it, the merge queue included, because foreman checks the fact itself: GitHub
   * must say the PR is CONFLICTING right now. The branch must merge main and be
   * verified again, which is what rework means.
   */
  sendBackConflict(id: string, actor: Actor): Task {
    const before = this.get(id);
    this.expect(before, ["approved"], "send back for a conflict");
    const info = before.pr ? (this.policy.prInfo?.(before.pr) ?? null) : null;
    if (!info) {
      throw new ForemanError("pr_unverifiable", `couldn't look up ${id}'s PR to confirm it conflicts with main`);
    }
    if (info.mergeable !== "CONFLICTING") {
      throw new ForemanError(
        "not_conflicting",
        `${before.pr} is ${info.mergeable ?? "of unknown mergeability"}, not CONFLICTING: nothing to send back`,
      );
    }
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["approved"], "send back for a conflict");
      this.set(id, { status: "ready", assignee: null, lease_until: null });
      this.event(id, actor, "rework", { reason: CONFLICT_REASON, was: t.status, conflict: true, headSha: info.headSha });
      return this.get(id);
    });
  }

  /** A recorded bare number or #number as this repository's PR URL (GitHub origin); anything else as recorded. */
  fullPr(pr: string): string;
  fullPr(pr: string | null): string | null;
  fullPr(pr: string | null): string | null {
    const bare = pr ? /^#?(\d+)$/.exec(pr.trim()) : null;
    if (!pr || !bare) return pr;
    const origin = this.policy.originRepo?.() ?? null;
    return origin ? `https://github.com/${origin}/pull/${bare[1]}` : pr;
  }

  /** The approved PR was merged. */
  merged(id: string, actor: Actor, pr?: string): Task {
    // What was verified must be what merges: a PR that moved after its verdict goes back.
    const before = this.get(id);
    const verified = [...this.events(id)].reverse().find((e) => e.type === "verified");
    const verifiedSha = (verified?.data.headSha as string | undefined) ?? undefined;
    // The PR that was verified is the one that merges: another PR argument can't stand in
    // for it and skip the checks below (T-0037).
    if (pr && before.pr && this.fullPr(pr.trim()) !== this.fullPr(before.pr)) {
      throw new ForemanError("pr_mismatch", `${id}'s PR is ${before.pr}, not ${pr}: the verified PR is the one that merges`);
    }
    const target = this.fullPr(before.pr ?? pr ?? null) ?? undefined;
    // A GitHub PR's verdict always records its commit; none means gh couldn't say then, so we can't tell now.
    if (verified && !verifiedSha && target && prRepo(target)) {
      throw new ForemanError("pr_unverifiable", `${id} was verified without a recorded commit for ${target}: rework and verify again`);
    }
    if (verifiedSha && target) {
      const now = this.policy.prInfo?.(target)?.headSha;
      if (!now) {
        throw new ForemanError("pr_unverifiable", `couldn't look up ${target} to confirm it is still at ${verifiedSha.slice(0, 8)} (is gh installed and logged in?)`);
      }
      if (now !== verifiedSha) {
        throw new ForemanError(
          "changed_after_verify",
          `${target} is at ${now.slice(0, 8)}, but ${id} was verified at ${verifiedSha.slice(0, 8)}: send it back with rework and verify again`,
        );
      }
    }
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["approved"], "mark merged");
      this.set(id, { status: "done", ...(pr ? { pr } : {}) });
      this.event(id, actor, "merged", { pr: pr ?? t.pr });
      return this.get(id);
    });
  }

  cancel(id: string, actor: Actor, reason: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      if (t.status === "done") throw new ForemanError("bad_status", `${id} is already done`);
      this.set(id, { status: "cancelled", assignee: null, lease_until: null });
      this.event(id, actor, "cancelled", { reason });
      return this.get(id);
    });
  }

  /**
   * Release claims whose holder is gone. Returns the ids. A lease pinned to a process
   * (pinLease) follows the process, not the clock: kept while it lives, released once
   * it is gone. Any other lease is released when its time runs out.
   */
  releaseExpired(actor: Actor): string[] {
    const rows = this.db
      .query(
        `SELECT t.*, p.pid AS pinned_pid FROM tasks t
           LEFT JOIN lease_pids p ON p.task_id = t.id AND p.assignee = t.assignee
         WHERE t.status IN ('claimed','in_progress','verifying')
           AND ((t.lease_until IS NOT NULL AND t.lease_until < ?) OR p.pid IS NOT NULL)`,
      )
      .all(this.now()) as Row[];
    const released: string[] = [];
    for (const row of rows) {
      const r = toTask(row);
      const pid = (row.pinned_pid as number | null) ?? null;
      if (pid !== null && this.isAlive(pid)) continue;
      const back: Status = r.status === "verifying" ? "in_review" : "ready";
      this.set(r.id, { status: back, assignee: null, lease_until: null });
      this.event(r.id, actor, "lease_expired", { was: r.assignee, status: r.status, ...(pid !== null ? { pid, reason: "process gone" } : {}) });
      released.push(r.id);
    }
    return released;
  }

  reclaim(actor: Actor): string[] {
    return this.tx(() => this.releaseExpired(actor));
  }

  /**
   * Hand out the next number for something parallel PRs would otherwise clash on.
   * The numbers already on disk count as well as earlier reservations: for "decision",
   * docs/decisions/Dnnnn-*.md, unless foreman.json's `numbers` names another source.
   */
  reserve(kind: string, actor: Actor, taskId?: string): number {
    return this.tx(() => {
      if (taskId) this.get(taskId);
      let onDisk: number;
      try {
        onDisk = highestOnDisk(this.root, kind);
      } catch (e) {
        throw new ForemanError("invalid", (e as Error).message);
      }
      const { r } = this.db
        .query(`SELECT COALESCE(MAX(value), 0) AS r FROM reservations WHERE kind = ?`)
        .get(kind) as { r: number };
      const value = Math.max(onDisk, r) + 1;
      this.db
        .query(`INSERT INTO reservations (kind, value, task_id, actor, at) VALUES (?, ?, ?, ?, ?)`)
        .run(kind, value, taskId ?? null, actor.name, this.now());
      this.event(taskId ?? null, actor, "reserved", { kind, value });
      return value;
    });
  }
}
