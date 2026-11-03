// The merge queue (D0011, D0012): merges approved tasks one at a time, and only a PR
// whose checks have settled green at the commit that was verified. gh goes through an
// injectable runner, so tests need no network.
import { type Actor, Foreman, ForemanError, type Task } from "./core";
import { defaultRun, GITHUB_PR, type Run } from "./policy";

/** One check on the PR's head, as `gh pr view --json statusCheckRollup` reports it. */
interface RollupItem {
  __typename?: string; // CheckRun or StatusContext
  name?: string; // CheckRun
  context?: string; // StatusContext
  status?: string; // CheckRun: QUEUED, IN_PROGRESS, COMPLETED, ...
  conclusion?: string; // CheckRun, once completed
  state?: string; // StatusContext: SUCCESS, PENDING, FAILURE, ERROR, EXPECTED
}

export interface PrState {
  headSha: string;
  mergeable: string; // MERGEABLE, CONFLICTING or UNKNOWN
  checks: RollupItem[];
}

export type ChecksVerdict =
  | { kind: "green"; names: string[] }
  | { kind: "pending"; reason: string }
  | { kind: "red"; reason: string };

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Green means: at least one check reported, every one complete, and every one passed
 * (optional ones too; GitHub's rollup doesn't say which are required, so all count).
 * Anything unknown counts as red: fail closed.
 */
export function judgeChecks(checks: RollupItem[]): ChecksVerdict {
  if (!checks.length) return { kind: "pending", reason: "no checks reported on the head yet" };
  const names: string[] = [];
  const pending: string[] = [];
  const red: string[] = [];
  for (const c of checks) {
    const name = c.name ?? c.context ?? "(unnamed)";
    names.push(name);
    if (c.__typename === "StatusContext" || (c.state !== undefined && c.status === undefined)) {
      const s = (c.state ?? "").toUpperCase();
      if (s === "SUCCESS") continue;
      if (s === "PENDING" || s === "EXPECTED") pending.push(name);
      else red.push(`${name} (${s || "no state"})`);
      continue;
    }
    const status = (c.status ?? "").toUpperCase();
    if (status !== "COMPLETED") {
      pending.push(name);
      continue;
    }
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (!PASSING.has(conclusion)) red.push(`${name} (${conclusion || "no conclusion"})`);
  }
  if (red.length) return { kind: "red", reason: `failing: ${red.join(", ")}` };
  if (pending.length) return { kind: "pending", reason: `still running: ${pending.join(", ")}` };
  return { kind: "green", names: [...new Set(names)].sort() };
}

export interface QueueOptions {
  /** Runs gh (default: the real one). */
  run?: Run;
  /** Where gh runs: the repository root (default: foreman's root). */
  cwd?: string;
  /** Minimum time between the two reads of a PR's checks (default 30). */
  settleSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Report what would happen; merge nothing, send nothing back. */
  dryRun?: boolean;
}

export type QueueAction = "merged" | "would_merge" | "sent_back" | "would_send_back" | "skipped" | "error";

export interface QueueEntry {
  id: string;
  pr: string | null;
  action: QueueAction;
  reason: string;
}

/** Approved tasks, the one approved longest ago first. */
export function approvedOldestFirst(f: Foreman): Task[] {
  return f.list({ status: ["approved"] }).sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
}

export function readPr(run: Run, cwd: string, pr: string): PrState | null {
  const out = run(["gh", "pr", "view", pr, "--json", "headRefOid,mergeable,statusCheckRollup"], cwd);
  if (out === null) return null;
  try {
    const j = JSON.parse(out) as { headRefOid?: string; mergeable?: string; statusCheckRollup?: RollupItem[] | null };
    if (!j.headRefOid) return null;
    return { headSha: j.headRefOid, mergeable: j.mergeable ?? "UNKNOWN", checks: j.statusCheckRollup ?? [] };
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One pass over the approved tasks, oldest first. Each is merged, sent back (it
 * conflicts with main) or skipped with the reason. The pass stops after the first
 * merge: main has moved, so every other PR's state is read again on the next pass.
 */
export async function mergeQueuePass(f: Foreman, actor: Actor, opts: QueueOptions = {}): Promise<QueueEntry[]> {
  const run = opts.run ?? defaultRun;
  const cwd = opts.cwd ?? f.root ?? process.cwd();
  const settleMs = (opts.settleSeconds ?? 30) * 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const report: QueueEntry[] = [];
  for (const t of approvedOldestFirst(f)) {
    const entry = (action: QueueAction, reason: string) => {
      report.push({ id: t.id, pr: t.pr, action, reason });
    };
    if (!t.pr || !GITHUB_PR.test(t.pr)) {
      entry("skipped", "no GitHub PR: merge it by hand, then `merged`");
      continue;
    }
    const verified = f.verifiedHead(t.id);
    if (!verified) {
      entry("skipped", "its verdict recorded no commit: rework and verify again");
      continue;
    }
    const first = readPr(run, cwd, t.pr);
    if (!first) {
      entry("skipped", `couldn't read ${t.pr} (is gh installed and logged in?)`);
      continue;
    }
    if (first.mergeable === "CONFLICTING") {
      if (opts.dryRun) {
        entry("would_send_back", "conflicts with main");
        continue;
      }
      try {
        f.sendBackConflict(t.id, actor);
        entry("sent_back", "conflicts with main: back to ready, to merge main and verify again");
      } catch (e) {
        entry("error", e instanceof Error ? e.message : String(e));
      }
      continue;
    }
    if (first.headSha !== verified) {
      entry("skipped", `moved after its verdict (at ${first.headSha.slice(0, 8)}, verified ${verified.slice(0, 8)}): rework and verify again`);
      continue;
    }
    if (first.mergeable !== "MERGEABLE") {
      entry("skipped", `GitHub hasn't worked out whether it merges cleanly yet (${first.mergeable})`);
      continue;
    }
    const v1 = judgeChecks(first.checks);
    if (v1.kind !== "green") {
      entry("skipped", v1.reason);
      continue;
    }
    // Settled: a check that starts late (a slow workflow, a re-run) must show up before we merge.
    await sleep(settleMs);
    const second = readPr(run, cwd, t.pr);
    if (!second) {
      entry("skipped", `couldn't read ${t.pr} again (is gh installed and logged in?)`);
      continue;
    }
    if (second.headSha !== verified) {
      entry("skipped", `moved while its checks settled (now at ${second.headSha.slice(0, 8)})`);
      continue;
    }
    const v2 = judgeChecks(second.checks);
    if (v2.kind !== "green") {
      entry("skipped", v2.reason);
      continue;
    }
    if (v2.names.join("\n") !== v1.names.join("\n")) {
      entry("skipped", `checks not settled: ${v1.names.join(", ")} became ${v2.names.join(", ")}`);
      continue;
    }
    if (second.mergeable !== "MERGEABLE") {
      entry("skipped", `GitHub no longer says it merges cleanly (${second.mergeable})`);
      continue;
    }
    if (opts.dryRun) {
      entry("would_merge", `${v2.names.length} checks green at ${verified.slice(0, 8)}`);
      return report;
    }
    // --match-head-commit: GitHub refuses if the head moved between our read and the merge.
    const out = run(["gh", "pr", "merge", t.pr, "--merge", "--delete-branch", "--match-head-commit", verified], cwd);
    if (out === null) {
      // gh can fail after the merge itself (deleting a local branch a worktree holds):
      // ask GitHub whether it merged before calling it a failure.
      const state = run(["gh", "pr", "view", t.pr, "--json", "state", "--jq", ".state"], cwd);
      if (state !== "MERGED") {
        entry("error", `gh pr merge failed for ${t.pr}`);
        return report;
      }
    }
    try {
      f.merged(t.id, actor);
      entry("merged", `${v2.names.length} checks green at ${verified.slice(0, 8)}`);
    } catch (e) {
      const msg = e instanceof ForemanError ? e.message : String(e);
      entry("error", `merged on GitHub, but foreman refused to mark it: ${msg}`);
    }
    return report;
  }
  return report;
}

/** Passes until stopped, `intervalSeconds` apart; with `once`, a single pass. */
export async function mergeQueue(
  f: Foreman,
  actor: Actor,
  opts: QueueOptions & {
    once?: boolean;
    intervalSeconds?: number;
    onPass?: (r: QueueEntry[]) => void;
    /**
     * Opens foreman again. A long-lived loop calls it before every pass after the first and
     * closes the old one, so a pass never reads through a connection that has held a read
     * snapshot open since the loop started (T-0050).
     */
    reopen?: () => Foreman;
  } = {},
): Promise<QueueEntry[]> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let pass = 0; ; pass++) {
    if (pass > 0 && opts.reopen) {
      const old = f;
      f = opts.reopen();
      try {
        old.db.close();
      } catch {}
    }
    const r = await mergeQueuePass(f, actor, opts);
    opts.onPass?.(r);
    if (opts.once) return r;
    await sleep((opts.intervalSeconds ?? 60) * 1000);
  }
}
