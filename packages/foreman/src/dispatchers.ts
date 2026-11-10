// The registry of running dispatchers (D0041): each `fm dispatch` keeps one row here
// while it runs, so `fm dispatchers`, `fm list` and the board can say what is running
// without looking for the process. A row whose process is gone is dropped on read.
import type { Actor, Foreman } from "./core";
import type { Role } from "./launch";
import { duration } from "./setup";

/** What a dispatcher takes work from. Only "everything" for now; plans come later. */
export type DispatcherScope = string;

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
      d.scope ?? "everything",
      d.startedAt,
      d.startedAt,
      JSON.stringify(d.sessions ?? []),
    );
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
export function runningDispatchers(f: Foreman): DispatcherInfo[] {
  const rows = f.db.query(`SELECT * FROM dispatchers ORDER BY started_at, pid`).all() as Row[];
  const running: DispatcherInfo[] = [];
  for (const r of rows) {
    if (f.isAlive(r.pid)) running.push(toInfo(r));
    else unregisterDispatcher(f, r.pid);
  }
  return running;
}

/** `pid 4242  everything  2/3 slots  by ada  up 5 min  T-0001 worker, T-0002 verifier` */
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
