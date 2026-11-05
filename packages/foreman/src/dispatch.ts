// Dispatcher (D0011): claim ready tasks, give each its own worktree and a worker
// session, then a fresh verifier once it is submitted. `fm dispatch` runs it.
// - At most `max` sessions at once (workers and verifiers both count).
// - Never two tasks with overlapping declared paths in flight at once.
// - Each session's lease is pinned to its PID: alive keeps the claim, dead releases it.
// - Workers and verifiers run as `claude --bg` sessions the person sees in `claude agents`
//   (D0022), unless --print or FOREMAN_LAUNCH=print asks for D0011's print mode.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Actor, Foreman, ForemanError, type Status, type Task } from "./core";
import { actorFor, type BgSession, launch, type LaunchMode, type LaunchOptions, type Role } from "./launch";
import { pathsOverlap } from "./policy";

/** What the dispatcher needs back from a session. */
export interface SessionResult {
  exitCode: number | null;
  costUsd: number;
  isError: boolean;
  timedOut: boolean;
  result: string;
}

/**
 * Starts a session and calls onSpawn with its PID as soon as it has one, and with the
 * background session's id and name in background mode. Tests pass a fake.
 */
export type Launcher = (opts: LaunchOptions, onSpawn: (pid: number, session?: BgSession) => void) => Promise<SessionResult>;

export const defaultLauncher: Launcher = (opts, onSpawn) => launch({ ...opts, onSpawn });

/** The launch mode: --print or FOREMAN_LAUNCH=print for print mode, else background (D0022). */
export function launchModeFrom(flag: LaunchMode | undefined, env: Record<string, string | undefined> = process.env): LaunchMode {
  if (flag) return flag;
  return env.FOREMAN_LAUNCH === "print" ? "print" : "bg";
}

export interface Worktree {
  branch: string;
  path: string;
}

/** Makes (or finds again) the worktree a task's worker runs in. */
export type WorktreeMaker = (t: Task, root: string) => Worktree;

/** t-0042-add-a-stage-filter: the id, then the title, short enough for a branch. */
export function branchFor(t: Task): string {
  const slug = t.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug ? `${t.id.toLowerCase()}-${slug}` : t.id.toLowerCase();
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

/**
 * <root>/.claude/worktrees/<task id> on a new branch from `base` (origin/main). A task
 * coming back for rework keeps its worktree, or its branch if the worktree is gone.
 */
export function gitWorktree(base = "origin/main"): WorktreeMaker {
  return (t, root) => {
    if (t.worktree && t.branch && existsSync(t.worktree)) return { branch: t.branch, path: t.worktree };
    const path = join(root, ".claude", "worktrees", t.id);
    if (existsSync(path)) {
      const head = git(["rev-parse", "--abbrev-ref", "HEAD"], path);
      if (head.ok && head.out !== "HEAD") return { branch: head.out, path };
      throw new ForemanError("worktree", `${path} exists but isn't a worktree on a branch: remove it or move it aside`);
    }
    const remote = base.includes("/") ? base.split("/")[0]! : null;
    if (remote) {
      const f = git(["fetch", "-q", remote], root);
      if (!f.ok) throw new ForemanError("worktree", `git fetch ${remote} failed: ${f.err}`);
    }
    const branch = t.branch ?? branchFor(t);
    const has = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref], root).ok;
    const args = has(`refs/heads/${branch}`)
      ? ["worktree", "add", "-q", path, branch]
      : remote && has(`refs/remotes/${remote}/${branch}`)
        ? ["worktree", "add", "-q", "-b", branch, path, `${remote}/${branch}`]
        : ["worktree", "add", "-q", "-b", branch, path, base];
    const r = git(args, root);
    if (!r.ok) throw new ForemanError("worktree", `git ${args.join(" ")} failed: ${r.err}`);
    return { branch, path };
  };
}

/** Tasks whose paths are taken: someone is working on them or their PR is being checked. */
export const ACTIVE: Status[] = ["claimed", "in_progress", "in_review", "verifying"];

const CLI = join(import.meta.dir, "cli.ts");

function cliHint(actor: string): string {
  return `FOREMAN_ACTOR=${actor} FOREMAN_AGENT=1 bun ${CLI} <command> < /dev/null`;
}

/** Lessons from running this by hand, said to every session. */
function common(actor: string): string {
  return [
    `- Do the work yourself in this session. Don't spawn helper subagents (the Agent tool): they are cut off when you finish, and their work is lost.`,
    `- Nobody is at a terminal. Give any command that might read input \`< /dev/null\`, and never wait for an answer.`,
    `- Talk to foreman through its MCP tools. If they aren't available, use its CLI: \`${cliHint(actor)}\` (\`help\` lists the commands).`,
  ].join("\n");
}

export function workerPrompt(t: Task, wt: Worktree): string {
  const actor = actorFor("worker", t.id);
  return `You are ${actor}, started by foreman's dispatcher to do ${t.id}: "${t.title}".

Foreman has already claimed ${t.id} for you and recorded its worktree and branch:
- worktree: ${wt.path} (your current directory)
- branch: ${wt.branch}

Follow the ship skill, with these differences:
- Step 1 is done: don't claim the task again and don't make another worktree. Start with show_task ${t.id}.
- This worktree is fresh: install its dependencies first (\`bun install\`, or the install command in AGENTS.md).
- Skip the fan-out in step 3: write the tests and docs yourself, then review your own diff.
${common(actor)}
- Push only your branch (${wt.branch}). Never merge, push to main or force-push.
- Finish with submit_task ${t.id} and the PR. If you can't finish, report_progress with what blocks you, then stop.`;
}

export function verifierPrompt(t: Task): string {
  const actor = actorFor("verifier", t.id);
  return `You are ${actor}, started by foreman's dispatcher to verify ${t.id}: "${t.title}". You did not write it.

Foreman has already started the verification for you: ${t.id} is "verifying", held by ${actor}. Skip the verify skill's step 1 (start_verify), unless show_task says ${t.id} is in_review again; then call start_verify ${t.id} first.
- Your current directory is the worker's worktree, on branch ${t.branch ?? "(unknown)"}${t.pr ? `; the PR is ${t.pr}` : ""}. Don't edit any file in it.
- Your foreman tools are show_task, list_tasks, start_verify, record_verdict and heartbeat.
${common(actor)}

Follow the verify skill, and end with record_verdict ${t.id}: one result per acceptance check.`;
}

export interface DispatchOptions {
  /** Sessions at once, workers and verifiers together. Default 3. */
  max?: number;
  /** Start what fits now, see those tasks through verification, then stop. */
  once?: boolean;
  model?: string;
  /** Each session's --max-budget-usd. Default: the role's own limit. */
  budgetUsd?: number;
  /** How often to look for new work while sessions run. Default 10 s. */
  pollMs?: number;
  launcher?: Launcher;
  worktrees?: WorktreeMaker;
  /** "bg" (default, D0022): `claude --bg`, visible in `claude agents`. "print": `claude -p` (D0011). */
  mode?: LaunchMode;
  /** Who reclaims dead leases. Default: "dispatcher" (agent). */
  actor?: Actor;
  log?: (line: string) => void;
}

export interface SessionRecord {
  task: string;
  role: Role;
  pid: number | null;
  /** Background mode: the session's id and name (`claude attach <id>`). */
  session?: BgSession;
  exitCode: number | null;
  costUsd: number;
  /** The task's status when the session ended. */
  status: Status;
  error?: string;
}

/** Overlap of two tasks' declared paths, or none. */
function clashes(t: Task, others: Task[]): Task | undefined {
  return others.find((o) => o.id !== t.id && pathsOverlap(t.paths, o.paths));
}

export class Dispatcher {
  readonly max: number;
  private running = new Map<string, { role: Role; done: Promise<void> }>();
  /** Roles already started per task in this run: each task gets one worker and one verifier. */
  private tried = new Map<string, Set<Role>>();
  /** Tasks this run started a worker for (--once only sees these through). */
  private mine = new Set<string>();
  private first = true;
  readonly sessions: SessionRecord[] = [];
  /** Most sessions running at the same time, for the summary and the tests. */
  peak = 0;
  private launcher: Launcher;
  private worktrees: WorktreeMaker;
  private actor: Actor;
  private log: (line: string) => void;

  constructor(
    private f: Foreman,
    private opts: DispatchOptions = {},
  ) {
    this.max = opts.max ?? 3;
    if (!Number.isInteger(this.max) || this.max < 1) throw new ForemanError("invalid", `--max must be a whole number of at least 1, got ${opts.max}`);
    this.launcher = opts.launcher ?? defaultLauncher;
    this.worktrees = opts.worktrees ?? gitWorktree();
    this.actor = opts.actor ?? { name: "dispatcher", kind: "agent" };
    this.log = opts.log ?? ((l) => console.log(l));
  }

  private root(): string {
    if (!this.f.root) throw new ForemanError("invalid", "dispatch needs a git repository");
    return this.f.root;
  }

  private triedRole(id: string, role: Role): boolean {
    return this.tried.get(id)?.has(role) ?? false;
  }

  private mark(id: string, role: Role) {
    const s = this.tried.get(id) ?? new Set<Role>();
    s.add(role);
    this.tried.set(id, s);
  }

  /** One pass: release dead leases, start verifiers, then workers, while slots are free. */
  tick(): void {
    this.f.reclaim(this.actor);
    const free = () => this.running.size < this.max;

    // Finish work before starting more: submitted tasks get a verifier first.
    for (const t of this.f.list({ status: ["in_review"] })) {
      if (!free()) break;
      if (this.running.has(t.id) || this.triedRole(t.id, "verifier")) continue;
      if (this.opts.once && !this.mine.has(t.id)) continue;
      if (!t.worktree || !existsSync(t.worktree)) continue; // nowhere to verify it
      this.startVerifier(t);
    }

    if (this.opts.once && !this.first) return;
    this.first = false;
    const active = this.f.list({ status: ACTIVE });
    for (const t of this.f.ready("agent")) {
      if (!free()) break;
      if (this.running.has(t.id) || this.triedRole(t.id, "worker")) continue;
      const clash = clashes(t, active);
      if (clash) {
        this.log(`${t.id} waits: its paths overlap ${clash.id}'s`);
        continue;
      }
      const started = this.startWorker(t);
      if (started) active.push(started);
    }
  }

  private startWorker(t: Task): Task | null {
    const actor: Actor = { name: actorFor("worker", t.id), kind: "agent" };
    try {
      this.f.claim(t.id, actor);
    } catch (e) {
      this.log(`${t.id} not claimed: ${(e as Error).message}`);
      return null;
    }
    this.mark(t.id, "worker");
    let wt: Worktree;
    try {
      wt = this.worktrees(this.f.get(t.id), this.root());
    } catch (e) {
      this.f.release(t.id, actor, `no worktree: ${(e as Error).message}`);
      this.log(`${t.id} released: no worktree: ${(e as Error).message}`);
      return null;
    }
    const task = this.f.progress(t.id, actor, { branch: wt.branch, worktree: wt.path, note: "dispatched" });
    this.mine.add(t.id);
    this.start("worker", task, actor, wt.path, workerPrompt(task, wt));
    return task;
  }

  private startVerifier(t: Task) {
    const actor: Actor = { name: actorFor("verifier", t.id), kind: "agent" };
    this.mark(t.id, "verifier");
    let task: Task;
    try {
      task = this.f.startVerify(t.id, actor);
    } catch (e) {
      this.log(`${t.id} not verified: ${(e as Error).message}`);
      return;
    }
    this.start("verifier", task, actor, t.worktree!, verifierPrompt(task));
  }

  private start(role: Role, t: Task, actor: Actor, cwd: string, prompt: string) {
    const rec: SessionRecord = { task: t.id, role, pid: null, exitCode: null, costUsd: 0, status: t.status };
    const opts: LaunchOptions = {
      role,
      taskId: t.id,
      cwd,
      prompt,
      model: this.opts.model,
      maxBudgetUsd: this.opts.budgetUsd,
      mode: launchModeFrom(this.opts.mode),
      // Commands the session runs count as an agent's, even where Claude Code doesn't say so.
      baseEnv: { ...process.env, FOREMAN_AGENT: "1" },
    };
    const onSpawn = (pid: number, session?: BgSession) => {
      rec.pid = pid;
      if (session) rec.session = session;
      try {
        this.f.pinLease(t.id, actor, pid, session && { session: session.id, name: session.name });
      } catch (e) {
        // Already submitted or verified (a very quick session): nothing left to pin.
        this.log(`${t.id} lease not pinned: ${(e as Error).message}`);
      }
      const watch = session ? `, "${session.name}": claude attach ${session.id}` : "";
      this.log(`${t.id} ${role} started (pid ${pid}${watch}) in ${cwd}`);
    };
    const done = (async () => {
      try {
        const r = await this.launcher(opts, onSpawn);
        rec.exitCode = r.exitCode;
        rec.costUsd = r.costUsd;
        if (r.timedOut) rec.error = "timed out";
        else if (r.isError) rec.error = r.result || "session ended with an error";
      } catch (e) {
        rec.error = (e as Error).message;
      }
      // The process is gone: if it still held the task, its pinned lease releases it now.
      try {
        this.f.reclaim(this.actor);
      } catch {
        // the next tick reclaims
      }
      // A session that never got a PID can't be reclaimed by one: let go here.
      const now = this.f.get(t.id);
      if (rec.pid === null && now.assignee === actor.name && ["claimed", "in_progress", "verifying"].includes(now.status)) {
        this.f.release(t.id, actor, `session didn't start: ${rec.error ?? "no pid"}`);
      }
      rec.status = this.f.get(t.id).status;
      this.sessions.push(rec);
      this.running.delete(t.id);
      const cost = rec.costUsd ? `, $${rec.costUsd.toFixed(2)}` : "";
      this.log(`${t.id} ${role} ended (exit ${rec.exitCode ?? "-"}${cost}${rec.error ? `, ${rec.error}` : ""}): task is ${rec.status}`);
    })();
    this.running.set(t.id, { role, done });
    this.peak = Math.max(this.peak, this.running.size);
  }

  /** Run until nothing is running and nothing more can start. */
  async run(): Promise<SessionRecord[]> {
    const pollMs = this.opts.pollMs ?? 10_000;
    for (;;) {
      this.tick();
      if (this.running.size === 0) return this.sessions;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = new Promise<void>((res) => {
        timer = setTimeout(res, pollMs);
      });
      await Promise.race([...[...this.running.values()].map((s) => s.done), poll]);
      clearTimeout(timer);
    }
  }
}

export async function dispatch(f: Foreman, opts: DispatchOptions = {}): Promise<SessionRecord[]> {
  return new Dispatcher(f, opts).run();
}
