// The registry of running dispatchers (D0041): each `fm dispatch` keeps one row here
// while it runs, so `fm dispatchers`, `fm list` and the board can say what is running
// without looking for the process. A row whose process is gone is dropped on read.
// The scope (D0045) says which tasks it takes: everything, or the tasks of named plans.
import { type Actor, type Foreman, ForemanError } from "./core";
import type { Role } from "./launch";
import { duration } from "./setup";

/**
 * What a dispatcher takes work from (D0045): "everything", or the plans it was started
 * for, sorted and joined with commas ("P-0004", "P-0004,P-0007").
 */
export type DispatcherScope = string;

export const EVERYTHING: DispatcherScope = "everything";

/** The scope for `--plan` given these times: none means everything. */
export function scopeOf(plans: string[] = []): DispatcherScope {
  const ids = [...new Set(plans.map((p) => p.trim()).filter(Boolean))].sort();
  return ids.length ? ids.join(",") : EVERYTHING;
}

/** The plans a scope names, or null for everything. */
export function scopePlans(scope: DispatcherScope): string[] | null {
  return scope === EVERYTHING ? null : scope.split(",");
}

/** Does the scope take a task that sits in this plan (undefined: in no plan)? */
export function scopeCovers(scope: DispatcherScope, plan: string | undefined): boolean {
  const plans = scopePlans(scope);
  return plans === null || (plan !== undefined && plans.includes(plan));
}

/**
 * Would this dispatcher start a worker for a ready task in that plan? Not with
 * --verify-only, and not with --once: that one starts what fits on its first pass and
 * nothing after.
 */
export function startsWorkers(d: Pick<DispatcherInfo, "scope" | "flags">, plan: string | undefined): boolean {
  return !d.flags.once && !d.flags.verifyOnly && scopeCovers(d.scope, plan);
}

export interface DispatcherFlags {
  once: boolean;
  verifyOnly: boolean;
  print: boolean;
}

/** One session a dispatcher has running. */
export interface DispatcherSession {
  task: string;
  role: Role;
  /** null until the session has a process. */
  pid: number | null;
  /** Background mode: the short id `claude attach` takes, and the transcript's session id. */
  session?: string;
  sessionId?: string;
}

export interface DispatcherStarter {
  /** FOREMAN_ACTOR, or the person. */
  name: string;
  kind: Actor["kind"];
  /** CLAUDE_CODE_SESSION_ID of the session that started it, when there is one. */
  session?: string;
}

export interface DispatcherInfo {
  pid: number;
  scope: DispatcherScope;
  max: number;
  flags: DispatcherFlags;
  starter: DispatcherStarter;
  cwd: string;
  /** ms epoch */
  startedAt: number;
  /** ms epoch of its last tick */
  lastSeen: number;
  sessions: DispatcherSession[];
}

interface Row {
  pid: number;
  max: number;
  flags: string;
  starter: string;
  starter_kind: string;
  starter_session: string | null;
  cwd: string;
  scope: string;
  started_at: number;
  last_seen: number;
  sessions: string;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function toInfo(r: Row): DispatcherInfo {
  const flags = parse<Partial<DispatcherFlags>>(r.flags, {});
  return {
    pid: r.pid,
    scope: r.scope,
    max: r.max,
    flags: { once: flags.once === true, verifyOnly: flags.verifyOnly === true, print: flags.print === true },
    starter: { name: r.starter, kind: r.starter_kind === "human" ? "human" : "agent", ...(r.starter_session ? { session: r.starter_session } : {}) },
    cwd: r.cwd,
    startedAt: r.started_at,
    lastSeen: r.last_seen,
    sessions: parse<DispatcherSession[]>(r.sessions, []),
  };
}

/** Record a dispatcher that has just started. A leftover row with the same pid is replaced. */
export function registerDispatcher(
  f: Foreman,
  d: Omit<DispatcherInfo, "scope" | "lastSeen" | "sessions"> & { scope?: DispatcherScope; sessions?: DispatcherSession[] },
): void {
  f.db
    .query(
      `INSERT OR REPLACE INTO dispatchers (pid, max, flags, starter, starter_kind, starter_session, cwd, scope, started_at, last_seen, sessions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.pid,
      d.max,
      JSON.stringify(d.flags),
      d.starter.name,
      d.starter.kind,
      d.starter.session ?? null,
      d.cwd,
      d.scope ?? EVERYTHING,
      d.startedAt,
      d.startedAt,
      JSON.stringify(d.sessions ?? []),
    );
}

/**
 * Record a dispatcher that is starting, unless one with the same scope already runs
 * (D0045): that one is named by pid in the refusal. Checked and written in one
 * transaction, so two that start together can't both pass.
 */
export function startDispatcher(f: Foreman, d: Parameters<typeof registerDispatcher>[1]): void {
  const scope = d.scope ?? EVERYTHING;
  f.db
    .transaction(() => {
      const other = runningDispatchers(f).find((o) => o.pid !== d.pid && o.scope === scope);
      if (other) {
        throw new ForemanError(
          "already_running",
          `a dispatcher for ${scope} is already running: pid ${other.pid}, started by ${other.starter.name} (fm dispatch --stop ${other.pid} stops it)`,
        );
      }
      registerDispatcher(f, d);
    })
    .immediate();
}

/** A tick: what the dispatcher has running now, and that it was seen. Nothing if it isn't registered. */
export function touchDispatcher(f: Foreman, pid: number, sessions: DispatcherSession[], at: number): void {
  f.db.query(`UPDATE dispatchers SET sessions = ?, last_seen = ? WHERE pid = ?`).run(JSON.stringify(sessions), at, pid);
}

/** The dispatcher has ended (or is being interrupted). */
export function unregisterDispatcher(f: Foreman, pid: number): void {
  f.db.query(`DELETE FROM dispatchers WHERE pid = ?`).run(pid);
}

/**
 * The dispatchers running now, oldest first. A record whose process is gone (the same
 * check as a pinned lease, `f.isAlive`) is deleted here and not returned, so a killed
 * dispatcher never shows as running.
 */
export function runningDispatchers(f: Foreman, o: { drop?: boolean } = {}): DispatcherInfo[] {
  const rows = f.db.query(`SELECT * FROM dispatchers ORDER BY started_at, pid`).all() as Row[];
  const running: DispatcherInfo[] = [];
  for (const r of rows) {
    if (f.isAlive(r.pid)) running.push(toInfo(r));
    else if (o.drop !== false) unregisterDispatcher(f, r.pid);
  }
  return running;
}

/**
 * The running dispatcher `fm dispatch --stop` means: by pid, by a plan its scope names,
 * or "everything". Only a dispatcher in the registry is ever found, so --stop can't
 * signal some other process.
 */
export function findDispatcher(f: Foreman, target: string): DispatcherInfo {
  const all = runningDispatchers(f);
  const want = target.trim();
  const hits = /^\d+$/.test(want)
    ? all.filter((d) => d.pid === Number(want))
    : all.filter((d) => d.scope === want || (scopePlans(d.scope) ?? []).includes(want));
  const running = all.length ? `running: ${all.map((d) => `pid ${d.pid} (${d.scope})`).join(", ")}` : "no dispatcher is running";
  if (!hits.length) throw new ForemanError("not_found", `no running dispatcher for "${want}": give a pid or a plan id (${running})`);
  if (hits.length > 1) throw new ForemanError("invalid", `"${want}" matches ${hits.length} dispatchers: give the pid (${running})`);
  return hits[0]!;
}

export interface StopOptions {
  /** Sends the signal. Default: process.kill. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** How long to wait for the dispatcher and its sessions to go. Default 15 s. */
  waitMs?: number;
  pollMs?: number;
}

export interface Stopped {
  pid: number;
  scope: DispatcherScope;
  /** What it had running when it was told to stop. */
  sessions: DispatcherSession[];
  /** Tasks of those sessions whose leases were released: back to ready, or in_review for a verifier. */
  released: string[];
  /** Session pids still alive when the wait ran out. */
  stillRunning: number[];
}

/**
 * Stop a running dispatcher the way Ctrl-C does (D0045): SIGTERM, which makes it stop its
 * sessions and remove its record as it exits. Then wait for it and its sessions to be
 * gone and release their leases here, so the tasks are free when this returns and don't
 * wait for the next reclaim.
 */
export async function stopDispatcher(f: Foreman, target: string, actor: Actor, o: StopOptions = {}): Promise<Stopped> {
  const d = findDispatcher(f, target);
  if (d.pid === process.pid) throw new ForemanError("invalid", "a dispatcher can't stop itself this way: end its run");
  const signal = o.signal ?? ((pid, sig) => process.kill(pid, sig));
  try {
    signal(d.pid, "SIGTERM");
  } catch (e) {
    // Gone between the read and the signal: what is left to do is the cleanup below.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new ForemanError("not_allowed", `can't signal pid ${d.pid}: ${(e as Error).message}`);
  }
  const pids = d.sessions.map((s) => s.pid).filter((p): p is number => p !== null && p !== d.pid);
  const left = () => pids.filter((p) => f.isAlive(p));
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  while ((f.isAlive(d.pid) || left().length) && Date.now() < deadline) await new Promise((r) => setTimeout(r, o.pollMs ?? 50));
  if (f.isAlive(d.pid)) throw new ForemanError("timeout", `pid ${d.pid} got SIGTERM and is still running: look at it, or kill it by hand`);
  unregisterDispatcher(f, d.pid);
  const mine = new Set(d.sessions.map((s) => s.task));
  const released = f.reclaim(actor).filter((id) => mine.has(id));
  return { pid: d.pid, scope: d.scope, sessions: d.sessions, released, stillRunning: left() };
}

/** What `fm dispatch --stop` prints. */
export function stoppedText(s: Stopped, statusOf: (task: string) => string): string {
  const lines = [`stopped dispatcher pid ${s.pid} (${s.scope})`];
  for (const x of s.sessions) lines.push(`${x.task} ${x.role} stopped: task is ${statusOf(x.task).replace(/_/g, " ")}`);
  if (!s.sessions.length) lines.push("it had nothing in flight");
  if (s.stillRunning.length) lines.push(`still running after the wait: pid ${s.stillRunning.join(", ")} (their tasks are released once they are gone)`);
  return lines.join("\n");
}

/** `pid 4242  everything  2/3 slots (a plan dispatcher: `P-0004` in place of `everything`)  by ada  up 5 min  T-0001 worker, T-0002 verifier` */
export function dispatcherLine(d: DispatcherInfo, now: number = Date.now()): string {
  const flags = [d.flags.once && "--once", d.flags.verifyOnly && "--verify-only", d.flags.print && "--print"].filter(Boolean).join(" ");
  const tasks = d.sessions.map((s) => `${s.task} ${s.role}`).join(", ") || "nothing in flight";
  const parts = [
    `pid ${d.pid}`,
    d.scope,
    `${d.sessions.length}/${d.max} slots`,
    ...(flags ? [flags] : []),
    `by ${d.starter.name}`,
    `up ${duration(Math.max(0, now - d.startedAt))}`,
    tasks,
  ];
  return parts.join("  ");
}
