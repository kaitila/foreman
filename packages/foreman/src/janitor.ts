// The janitor (D0011): reclaims expired leases, removes the worktrees and merged local
// branches of finished tasks, releases their test-kit ports, and lists tasks stuck in
// one state too long. git goes through an injectable runner.
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type Actor, type Event, Foreman, type Status, type Task } from "./core";
import { defaultRun, type Run } from "./policy";

export interface JanitorOptions {
  run?: Run;
  /** The repository root (default: foreman's root). Only worktrees under it are removed. */
  root?: string;
  /** A task in claimed, in_progress, in_review or verifying for longer than this is listed (default 24). */
  stuckHours?: number;
  now?: () => number;
  /** Report only: reclaim, remove and delete nothing. */
  dryRun?: boolean;
  /** Frees a worktree's test-kit ports (default: @foreman-kit/test-kit's releasePorts, if installed). */
  releasePorts?: (worktree: string) => Promise<boolean>;
}

/** A finished task's recorded background sessions not yet removed (lease_pinned minus sessions_removed). */
export function sessionsToRemove(events: Event[]): string[] {
  const all = new Set<string>(), removed = new Set<string>();
  for (const e of events) {
    if (e.type === "lease_pinned" && typeof e.data.session === "string") all.add(e.data.session);
    if (e.type === "sessions_removed" && Array.isArray(e.data.sessions)) for (const s of e.data.sessions) removed.add(String(s));
  }
  return [...all].filter((id) => /^[0-9a-f]{6,}$/.test(id) && !removed.has(id));
}

/**
 * Removes the background sessions of every done or cancelled task with `claude rm` (T-0099),
 * whatever happened to its worktree, so they leave the person's sessions list. A session that
 * is already gone counts as removed; one `claude rm` refuses for another reason is tried again
 * next time. Each removal is recorded (sessions_removed), so a session is removed once.
 * FOREMAN_KEEP_SESSIONS=1 turns it off. Under `bun test` it does nothing unless a runner is
 * given, so a test never removes a real session.
 */
export function removeFinishedSessions(f: Foreman, actor: Actor, run?: Run, cwd = f.root ?? process.cwd()): { id: string; sessions: string[] }[] {
  if (process.env.FOREMAN_KEEP_SESSIONS === "1") return [];
  if (!run && process.env.NODE_ENV === "test") return [];
  const exec = run ?? defaultRun;
  const out: { id: string; sessions: string[] }[] = [];
  for (const t of f.list({ status: ["done", "cancelled"] })) {
    const ids = sessionsToRemove(f.events(t.id));
    if (!ids.length) continue;
    const gone = ids.filter((id) => exec(["claude", "rm", id], cwd) !== null || /no job matching/i.test(exec.lastError ?? ""));
    if (!gone.length) continue;
    f.sessionsRemoved(t.id, actor, gone);
    out.push({ id: t.id, sessions: gone });
  }
  return out;
}

export interface JanitorReport {
  reclaimed: string[];
  /** sessions: the task's Claude Code background sessions removed with `claude rm` (D0022). */
  removed: { id: string; worktree: string; branchDeleted: boolean; portsReleased: boolean; sessions?: string[] }[];
  /** Every finished task's sessions removed this run, whatever happened to its worktree (T-0099). */
  sessions: { id: string; sessions: string[] }[];
  kept: { id: string; worktree: string; reason: string }[];
  stuck: { id: string; status: Status; since: number; hours: number; assignee: string | null }[];
}

const STUCK: Status[] = ["claimed", "in_progress", "in_review", "verifying"];

/** When the task entered its current state, from the event log; its last update if the log can't say. */
export function enteredStatusAt(t: Task, events: Event[]): number {
  const enter: Partial<Record<Status, string[]>> = {
    claimed: ["claimed"],
    in_progress: ["progress"],
    in_review: ["submitted", "lease_expired"],
    verifying: ["verify_started"],
  };
  const types = enter[t.status] ?? [];
  let at: number | null = null;
  for (const e of events) {
    // in_progress starts at the first progress after the latest claim, not the latest heartbeat.
    if (t.status === "in_progress" && e.type === "claimed") at = null;
    if (types.includes(e.type) && !(t.status === "in_progress" && at !== null)) at = e.at;
  }
  return at ?? t.updatedAt;
}

async function testKitRelease(worktree: string): Promise<boolean> {
  const spec = "@foreman-kit/test-kit"; // a variable: test-kit is optional, not a dependency
  try {
    const kit = (await import(spec)) as { slot?: (o: { root: string }) => { releasePorts(): Promise<void> } };
    if (!kit.slot) return false;
    await kit.slot({ root: worktree }).releasePorts();
    return true;
  } catch {
    return false;
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Worktree paths git knows for this repository. */
function registeredWorktrees(run: Run, root: string): Set<string> {
  const out = run(["git", "worktree", "list", "--porcelain"], root) ?? "";
  return new Set(
    out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => real(l.slice("worktree ".length))),
  );
}

export async function janitor(f: Foreman, actor: Actor, opts: JanitorOptions = {}): Promise<JanitorReport> {
  const run = opts.run ?? defaultRun;
  const root = real(opts.root ?? f.root ?? process.cwd());
  const now = (opts.now ?? Date.now)();
  const release = opts.releasePorts ?? testKitRelease;
  const report: JanitorReport = { reclaimed: [], removed: [], kept: [], stuck: [], sessions: [] };

  report.reclaimed = opts.dryRun
    ? f
        .list({ status: ["claimed", "in_progress", "verifying"] })
        .filter((t) => t.leaseUntil !== null && t.leaseUntil < now)
        .map((t) => t.id)
    : f.reclaim(actor);

  const known = registeredWorktrees(run, root);
  for (const t of f.list({ status: ["done", "cancelled"] })) {
    if (!t.worktree) continue;
    const wt = real(t.worktree);
    const keep = (reason: string) => report.kept.push({ id: t.id, worktree: wt, reason });
    if (!existsSync(wt)) continue; // already gone
    if (wt === root || !wt.startsWith(root + sep)) {
      keep("not inside the repository: left alone");
      continue;
    }
    if (!known.has(wt)) {
      keep("not a git worktree of this repository: left alone");
      continue;
    }
    const dirty = run(["git", "status", "--porcelain"], wt);
    if (dirty === null) {
      keep("couldn't read its git status");
      continue;
    }
    if (dirty !== "") {
      keep(`has uncommitted changes (${dirty.split("\n").length} files): commit or discard them, then run the janitor again`);
      continue;
    }
    if (opts.dryRun) {
      report.removed.push({ id: t.id, worktree: wt, branchDeleted: false, portsReleased: false });
      continue;
    }
    // Ports first: test-kit finds the slot from the worktree, which must still exist.
    const portsReleased = await release(wt);
    if (run(["git", "worktree", "remove", wt], root) === null) {
      keep("git worktree remove failed");
      continue;
    }
    let branchDeleted = false;
    if (t.branch && run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`], root) !== null) {
      // Only a branch already in main goes; a cancelled task's unmerged work stays.
      const merged = ["origin/main", "main"].some(
        (base) =>
          run(["git", "rev-parse", "--verify", "--quiet", base], root) !== null &&
          run(["git", "merge-base", "--is-ancestor", `refs/heads/${t.branch}`, base], root) !== null,
      );
      if (merged) branchDeleted = run(["git", "branch", "-D", t.branch], root) !== null;
    }
    report.removed.push({ id: t.id, worktree: wt, branchDeleted, portsReleased });
  }

  // Their background sessions (D0022, T-0099) leave the person's `claude agents --all`, worktree or not.
  if (!opts.dryRun) {
    report.sessions = removeFinishedSessions(f, actor, run, root);
    for (const r of report.removed) {
      const s = report.sessions.find((x) => x.id === r.id);
      if (s) r.sessions = s.sessions;
    }
  } else {
    report.sessions = f.list({ status: ["done", "cancelled"] }).map((t) => ({ id: t.id, sessions: sessionsToRemove(f.events(t.id)) })).filter((x) => x.sessions.length);
  }

  const limit = (opts.stuckHours ?? 24) * 3_600_000;
  for (const t of f.list({ status: STUCK })) {
    const since = enteredStatusAt(t, f.events(t.id));
    if (now - since > limit) {
      report.stuck.push({ id: t.id, status: t.status, since, hours: Math.floor((now - since) / 3_600_000), assignee: t.assignee });
    }
  }
  return report;
}
