// The local board (T-0035, T-0067): one Bun.serve on 127.0.0.1, a read-only JSON API over
// the same Foreman core, and one page with inline CSS/JS (no external assets, works offline).
// Plans (D0033) are read here too, from the plans core; the board never writes them.
// Running dispatchers (D0041) are read too: the board shows them, the plans each covers and the
// ready tasks none covers (D0045), and never starts or stops one.
// The writes are approve, merge and run-queue. Each needs the token `fm serve` prints to its
// own terminal, in the fragment of the URL it prints (never in a page or an API response),
// and, when the browser sends one, our own Origin (D0021).
import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { type Actor, type Event, type Foreman, ForemanError, type Status, type Task } from "../core";
import { asyncRunner, GITHUB_PR, pathsOverlap } from "../policy";
import { judgeChecks, mergeQueuePass, parsePr, PR_VIEW, type QueueEntry, type QueueOptions } from "../queue";
import { pageHtml } from "./page";
import { hasLiveSession, recentActivity, taskSessions } from "../activity";
import { removeFinishedSessions } from "../janitor";
import { isLabelColor, type LabelColor, readColors, setColor } from "../projects";
import { type Plan, Plans } from "../plans";
import { holdsUp, type PathNode, pathOf, pathText, type Reason, snapshot, type Snapshot, waitsOn } from "../waiting";
import { type DispatcherInfo, runningDispatchers, scopeCovers, startsWorkers } from "../dispatchers";
import { Dispatcher, type DispatchOptions } from "../dispatch";

export const LANES: Status[] = [
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "in_review",
  "verifying",
  "needs_approval",
  "approved",
  "done",
  "cancelled",
];

/** One repo on the board. */
export interface BoardProject {
  name: string;
  foreman: Foreman;
  /** Where gh runs for this project (default: the foreman's root). */
  dir?: string;
}

export interface BoardOptions {
  /** One project (named after its folder), or `projects` for several; the first is the current one. */
  foreman?: Foreman;
  projects?: BoardProject[];
  /** 0 picks a free port. */
  port?: number;
  /** Who approves and merges from the page. null: both are off (an agent started the board). */
  approver: Actor | null;
  /** The merge queue's gh runner, settle time and sleep (tests fake them). */
  queue?: Omit<QueueOptions, "dryRun" | "only">;
  /** How long a PR's state is cached for the cards, in ms (default 15000). */
  prCacheMs?: number;
  /** Reads a PR without blocking the server (tests fake it). Default: gh, run asynchronously. */
  readRun?: (cmd: string[], cwd: string) => Promise<string | null>;
  /** How long a PR read may take before the card says GitHub can't be reached (default 15000). */
  prTimeoutMs?: number;
  /** Where Claude Code keeps session transcripts (default: the person's config dir and foreman's own). */
  configDirs?: string[];
  /**
   * Run the merge queue too (`fm serve --queue`): a pass for each project now, then every
   * `intervalMs`. A project whose pass is still running (a click, or the last tick) is skipped.
   */
  /** Where each project's colour label is kept (default: the person's project registry). Tests fake it. */
  labels?: { get(dir: string): LabelColor | null; set(dir: string, color: LabelColor | null): void };
  autoQueue?: {
    actor: Actor;
    intervalMs: number;
    onPass?: (project: string, entries: QueueEntry[]) => void;
    onError?: (project: string, error: unknown) => void;
    /** Removes finished tasks' sessions after each pass (T-0099). Default: the janitor's removeFinishedSessions. */
    cleanSessions?: (f: Foreman) => void;
    /**
     * After each project's merge-queue pass, start a verifier for each of its `in_review`
     * tasks whose worktree exists, as `fm dispatch --verify-only` would, once per submission
     * (D0046). It never claims a ready task. On unless false (`fm serve --queue --no-verify`).
     */
    verify?: false | VerifyPassOptions;
  };
}

/** The --queue loop's verify pass: the dispatcher's own options, for each project. */
export interface VerifyPassOptions extends Pick<DispatchOptions, "max" | "model" | "budgetUsd" | "mode" | "launcher"> {
  /** A line the pass would print: a verifier started or ended, or why one didn't start. */
  log?: (project: string, line: string) => void;
  /** The pass threw. The merge queue and the loop go on. */
  onError?: (project: string, error: unknown) => void;
}

export interface Board {
  url: string;
  /** The URL to open: `url` with the token in the fragment, which the browser never sends. */
  openUrl: string;
  port: number;
  /** Shown once, in the terminal that started the board. null when approving is off. */
  token: string | null;
  /** Whether the --queue loop runs on this board. */
  queueRunning: boolean;
  /** Stops the server and the queue loop (waiting for a pass in progress to finish). */
  stop(): Promise<void>;
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(b).toString("hex");
}

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A task as the board lists it. */
export function card(t: Task) {
  return { id: t.id, title: t.title, status: t.status, risk: t.risk, assignee: t.assignee, pr: t.pr, updatedAt: t.updatedAt };
}

/**
 * A running dispatcher as the board shows it (T-0116): what `runningDispatchers` records, less
 * the working directory and the sessions' pids and ids, which the page has no use for.
 */
export function dispatcherCard(d: DispatcherInfo) {
  return {
    pid: d.pid,
    scope: d.scope,
    max: d.max,
    flags: { once: d.flags.once, verifyOnly: d.flags.verifyOnly },
    starter: d.starter,
    startedAt: d.startedAt,
    lastSeen: d.lastSeen,
    sessions: d.sessions.map((s) => ({ task: s.task, role: s.role })),
  };
}

/**
 * A person's approval that was undone and not given again (T-0094): the last send-back of a
 * task a person approved (an agent's or person's rework, or the merge queue's conflict send-back),
 * unless a newer approval, merge or cancel came after it. null when there's nothing to flag.
 */
export function approvalUndone(events: Event[]) {
  let undone: { by: string; byKind: string; at: number; reason: string; conflict: boolean } | null = null;
  // Only a person's approval counts: an approval foreman gave by itself (risk auto) undone is no news to them.
  let personApproved = false;
  for (const e of events) {
    if (e.type === "submitted") personApproved = false;
    else if (e.type === "approved") {
      undone = null;
      personApproved = e.actorKind === "human";
    } else if (e.type === "rework" && e.data.was === "approved") {
      if (personApproved) undone = { by: e.actor, byKind: e.actorKind, at: e.at, reason: String(e.data.reason ?? ""), conflict: e.data.conflict === true };
      personApproved = false;
    } else if (e.type === "merged" || e.type === "cancelled") undone = null;
  }
  return undone;
}

/** Each acceptance check with the latest verdict recorded for it, if any. */
export function checksWithVerdicts(t: Task, events: Event[]) {
  const latest = new Map<string, { pass: boolean; evidence: string; by: string; at: number }>();
  for (const e of events) {
    if (e.type !== "verified" && e.type !== "verify_failed") continue;
    const results = (e.data.results ?? []) as { check: string; pass: boolean; evidence: string }[];
    for (const r of results) latest.set(r.check, { pass: r.pass, evidence: r.evidence, by: e.actor, at: e.at });
  }
  return t.acceptance.map((c) => ({ ...c, verdict: latest.get(c.id) ?? null }));
}

/** The plan and step a task is in, with their titles, for its panel; null when it is in none. */
export function placement(f: Foreman, taskId: string) {
  const plans = new Plans(f);
  const at = plans.placement(taskId);
  if (!at) return null;
  const p = plans.get(at.plan);
  const step = p.steps.find((s) => s.n === at.step);
  return { plan: p.id, planTitle: p.title, planState: p.state, step: at.step, stepTitle: step?.title ?? "", stepState: step?.state ?? "empty" };
}

/**
 * The rule as the board reads it (T-0120): with the running dispatchers, so a ready task
 * that none would start carries the `no dispatcher` reason (D0045), as `fm list` says it.
 */
const boardSnapshot = (f: Foreman): Snapshot => snapshot(f);

/**
 * What a waiting task's row shows (T-0118), all of it from waiting.ts (D0042): the first direct
 * reason, where its path ends (`end`: the first place that isn't the task itself), every leaf,
 * the depth, the "moves when" line, the whole chain as text for the title, and the tasks on the
 * path (`on`, for the plan view's highlight). null: nothing to wait on, or a plain draft, whose
 * status already says so.
 */
export function waitCard(s: Snapshot, id: string) {
  const reason = waitsOn(s, id).find((r) => r.kind !== "draft");
  if (!reason) return null;
  const p = pathOf(s, id);
  const on = new Set<string>();
  const walk = (n: PathNode) => {
    for (const c of n.children) {
      on.add(c.task);
      walk(c);
    }
  };
  walk(p.root);
  on.delete(id);
  const end = p.leaves.find((l) => l.task !== id || l.text.startsWith("cycle:")) ?? null;
  return { reason, end, leaves: p.leaves, depth: p.depth, summary: p.summary, chain: pathText(p), on: [...on] };
}

/** How many tasks wait on this one, directly or through others, and which. */
export function heldCard(s: Snapshot, id: string) {
  // Nothing waits on a done task, so the common case costs nothing.
  if (s.tasks.get(id)?.status === "done") return { count: 0, tasks: [] as string[] };
  const h = holdsUp(s, id);
  return { count: h.count, tasks: h.tasks.map((t) => t.id) };
}

/** A node of the path as the panel draws it: a `paths` reason also names the globs that overlap. */
export type BoardPathNode = Omit<PathNode, "via" | "children"> & { via: (Reason & { globs?: string[] }) | null; children: BoardPathNode[] };

/**
 * A task's panel (T-0118): the whole path it waits on as a tree, and everything downstream
 * that waits on it, the direct ones first.
 */
export function waitDetail(s: Snapshot, id: string) {
  const path = pathOf(s, id);
  const node = (n: PathNode, parent: string | null): BoardPathNode => {
    let via: BoardPathNode["via"] = n.via;
    if (n.via?.kind === "paths" && parent) {
      const mine = s.tasks.get(parent)?.paths ?? [];
      const theirs = s.tasks.get(n.task)?.paths ?? [];
      // No paths at all means everything: there is no glob to name.
      via = { ...n.via, globs: mine.filter((g) => pathsOverlap([g], theirs)) };
    }
    return { ...n, via, children: n.children.map((c) => node(c, n.task)) };
  };
  const held = holdsUp(s, id);
  return {
    path: { ...path, root: node(path.root, null) },
    holdsUp: { count: held.count, tasks: [...held.tasks.filter((t) => t.direct), ...held.tasks.filter((t) => !t.direct)] },
  };
}

/**
 * Which running dispatchers cover a plan (T-0120, D0045): the ones whose scope takes its
 * tasks, each with its slots in use and whether it starts new workers (`starts`: not with
 * --once or --verify-only), and `uncovered`, the plan's ready tasks that can start but that
 * none of them would start. null for a plan that isn't active: nothing of it would start.
 */
export function planDispatch(s: Snapshot, running: DispatcherInfo[], p: Plan) {
  if (p.state !== "active") return null;
  return {
    dispatchers: running
      .filter((d) => scopeCovers(d.scope, p.id))
      .map((d) => ({
        pid: d.pid,
        scope: d.scope,
        max: d.max,
        inUse: d.sessions.length,
        flags: { once: d.flags.once, verifyOnly: d.flags.verifyOnly },
        starter: d.starter,
        starts: startsWorkers(d, p.id),
      })),
    uncovered: p.steps.flatMap((step) => step.tasks.filter((t) => waitsOn(s, t.id).some((r) => r.kind === "no dispatcher")).map((t) => t.id)),
  };
}

/**
 * Plans for the board: each step also says which earlier steps it waits on and their
 * unfinished tasks, read from what one of its own waiting tasks waits on (D0042). A step with
 * no task that waits (empty, or already started) names none. Each plan also carries
 * `dispatch`: the running dispatchers that cover it and its ready tasks nothing covers.
 */
export function plansWithWaits(f: Foreman, plans: Plan[]) {
  const s = boardSnapshot(f);
  // Read without dropping dead records, like the snapshot: the two must agree.
  const running = runningDispatchers(f, { drop: false });
  return plans.map((p) => ({
    ...p,
    dispatch: planDispatch(s, running, p),
    steps: p.steps.map((step) => {
      let waits: { step: number; title: string; tasks: string[] }[] = [];
      if (p.state === "active") {
        for (const t of step.tasks) {
          const rs = waitsOn(s, t.id).flatMap((r) => (r.kind === "step" ? [{ step: r.step, title: r.title, tasks: r.tasks }] : []));
          if (rs.length) {
            waits = rs;
            break;
          }
        }
      }
      return { ...step, waits };
    }),
  }));
}

/** What one project needs: its database, where gh runs, its PR cache and its one-pass-at-a-time flag. */
interface Ctx {
  name: string;
  f: Foreman;
  cwd: string;
  /** The directory its colour label is keyed by. */
  dir: string;
  prCache: Map<string, { at: number; body: unknown }>;
  passing: boolean;
}

export function startBoard(opts: BoardOptions): Board {
  const list: BoardProject[] =
    opts.projects ?? (opts.foreman ? [{ name: basename(opts.foreman.root ?? "") || "project", foreman: opts.foreman }] : []);
  if (!list.length) throw new ForemanError("invalid", "the board needs at least one project");
  const ctxs: Ctx[] = list.map((p) => ({
    name: p.name,
    f: p.foreman,
    cwd: p.dir ?? opts.queue?.cwd ?? p.foreman.root ?? process.cwd(),
    dir: p.dir ?? p.foreman.root ?? process.cwd(),
    prCache: new Map(),
    passing: false,
  }));
  const token = opts.approver ? newToken() : null;
  let origins: Set<string> = new Set();
  let hosts: Set<string> = new Set();
  const security = (nonce?: string): Record<string, string> => ({
    "content-security-policy": [
      "default-src 'self'",
      nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
      nonce ? `style-src 'nonce-${nonce}'` : "style-src 'none'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...security(), "content-type": "application/json; charset=utf-8" },
    });
  const fail = (status: number, error: string, message: string) => json({ error, message }, status);

  const labels = opts.labels ?? { get: (dir: string) => readColors()[dir] ?? null, set: (dir: string, c: LabelColor | null) => setColor(dir, c) };
  // Read on every state and every poll: a dispatcher that starts or exits writes no event,
  // so the page learns of it from here. A read drops the record of one whose process is gone.
  const dispatchers = (c: Ctx) => runningDispatchers(c.f).map(dispatcherCard);
  const state = (c: Ctx) => {
    // The history is read once per request: grouped by task for the flags, and for the last id.
    const evs = c.f.events();
    const byTask = new Map<string, Event[]>();
    for (const e of evs) if (e.taskId) (byTask.get(e.taskId) ?? byTask.set(e.taskId, []).get(e.taskId)!).push(e);
    // Why each task waits and what it holds up (T-0118), from one snapshot of the tasks.
    const s = boardSnapshot(c.f);
    return {
      color: labels.get(c.dir),
      lanes: LANES,
      tasks: s.order.map((t) => ({
        ...card(t),
        live: hasLiveSession(c.f, t.id),
        // An approved task is approved again, whatever happened before: nothing to flag.
        undone: t.status === "approved" ? null : approvalUndone(byTask.get(t.id) ?? []),
        wait: waitCard(s, t.id),
        holds: heldCard(s, t.id),
      })),
      lastEvent: evs.at(-1)?.id ?? 0,
      canApprove: token !== null,
      dispatchers: dispatchers(c),
    };
  };
  const summary = (c: Ctx) => {
    const ts = c.f.list();
    return {
      name: c.name,
      color: labels.get(c.dir),
      waiting: ts.filter((t) => t.status === "needs_approval").length,
      toMerge: ts.filter((t) => t.status === "approved").length,
      total: ts.length,
    };
  };

  const prCacheMs = opts.prCacheMs ?? 15_000;
  /** A PR's state for its card: what the merge queue would read first, without merging. */
  const prTimeoutMs = opts.prTimeoutMs ?? 15_000;
  const queueRun = opts.queue?.run;
  const readRun = opts.readRun ?? (queueRun ? async (c: string[], d: string) => queueRun(c, d) : asyncRunner());
  const inflight = new Map<string, Promise<unknown>>();
  const prState = async (c: Ctx, t: Task): Promise<unknown> => {
    if (!t.pr || !GITHUB_PR.test(t.pr)) return { pr: t.pr, readable: false, reason: "no GitHub PR" };
    const hit = c.prCache.get(t.id);
    if (hit && Date.now() - hit.at < prCacheMs) return hit.body;
    const pr = t.pr;
    const key = `${c.name} ${t.id} ${pr}`;
    const going = inflight.get(key);
    if (going) return going;
    const p = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), prTimeoutMs);
      });
      try {
        const out = await Promise.race([readRun(PR_VIEW(pr), c.cwd).catch(() => null), timeout]);
        if (out === "timeout") {
          return { pr, readable: false, timedOut: true, reason: `couldn't reach GitHub (no answer in ${Math.round(prTimeoutMs / 1000)} s)` };
        }
        const s = parsePr(out);
        const verified = c.f.verifiedHead(t.id);
        const body = s
          ? { pr, readable: true, mergeable: s.mergeable, checks: judgeChecks(s.checks), atVerified: verified !== null && s.headSha === verified }
          : { pr, readable: false, reason: `couldn't read ${pr} (is gh installed and logged in?)` };
        c.prCache.set(t.id, { at: Date.now(), body });
        return body;
      } finally {
        clearTimeout(timer);
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };

  // One merge-queue pass at a time per project, whoever asks (a click or the --queue loop):
  // two passes must not merge in parallel. Callers check `passing` first; it is set before the
  // first await, so nothing can slip in between.
  const pass = async (c: Ctx, actor: Actor, only?: string): Promise<QueueEntry[]> => {
    c.passing = true;
    try {
      return await mergeQueuePass(c.f, actor, { ...opts.queue, cwd: c.cwd, only });
    } finally {
      c.passing = false;
      c.prCache.clear();
    }
  };

  /** Every write: our own Origin if the browser sends one, then the token. null means go ahead. */
  const refuse = (req: Request): Response | null => {
    const origin = req.headers.get("origin");
    if (origin !== null && !origins.has(origin)) return fail(403, "forbidden", "cross-origin request refused");
    if (!token || !opts.approver) return fail(403, "forbidden", "approving and merging are off on this board");
    if (!sameToken(req.headers.get("x-foreman-token"), token)) {
      return fail(403, "forbidden", "this needs the token in the link fm serve printed");
    }
    return null;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 4499,
    // A merge waits for checks to settle (30 seconds by default) before it answers.
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      // DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own Host.
      if (!hosts.has(req.headers.get("host") ?? "")) return fail(421, "bad_host", "unknown host");
      let path = url.pathname;
      try {
        if (path === "/") {
          if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method_not_allowed", "the board is read-only, except approve, merge, run queue and colour labels");
          const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
          const initial = {
            lanes: LANES,
            canApprove: token !== null,
            // Who signs off here, so the page doesn't alarm the person about their own rework.
            me: opts.approver?.name ?? null,
            projects: ctxs.map((c) => ({ name: c.name, ...state(c), plans: plansWithWaits(c.f, new Plans(c.f).list()) })),
          };
          return new Response(pageHtml(nonce, initial), {
            headers: { ...security(nonce), "content-type": "text/html; charset=utf-8" },
          });
        }
        if (path === "/api/projects" && (req.method === "GET" || req.method === "HEAD")) {
          return json({ board: "foreman", canApprove: token !== null, projects: ctxs.map(summary) });
        }
        // /api/p/<project>/tasks is /api/tasks for that project; the unscoped routes are the first project's.
        let ctx = ctxs[0]!;
        const scoped = /^\/api\/p\/([^/]+)(\/.*)$/.exec(path);
        if (scoped) {
          let name: string;
          try {
            name = decodeURIComponent(scoped[1]!);
          } catch {
            name = "";
          }
          const hit = ctxs.find((c) => c.name === name);
          if (!hit) return fail(404, "not_found", `no project "${name}" on this board`);
          ctx = hit;
          path = "/api" + scoped[2]!;
        }
        const f = ctx.f;
        if (req.method === "GET" || req.method === "HEAD") {
          if (path === "/api/tasks") return json(state(ctx));
          // Plans, active first, each with its steps, their tasks and the progress made from them.
          if (path === "/api/plans") return json({ plans: plansWithWaits(f, new Plans(f).list()) });
          const pl = /^\/api\/plans\/([A-Za-z0-9_-]+)$/.exec(path);
          if (pl) return json({ plan: plansWithWaits(f, [new Plans(f).get(pl[1]!)])[0] });
          if (path === "/api/events") {
            const since = Number(url.searchParams.get("since") ?? 0) || 0;
            const events = f.events().filter((e) => e.id > since);
            return json({ events, lastEvent: events.at(-1)?.id ?? since, dispatchers: dispatchers(ctx) });
          }
          const pr = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/pr$/.exec(path);
          if (pr) return json(await prState(ctx, f.get(pr[1]!)));
          const m = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
          if (m) {
            const t = f.get(m[1]!);
            const events = f.events(t.id);
            // Each dispatched session with its last lines and cost, read from its transcript (T-0065).
            const sessions = taskSessions(f, t.id, opts.configDirs, events).map((s) => ({
              role: s.role, actor: s.actor, name: s.name ?? null, id: s.id ?? null, live: s.live,
              ...(s.path ? recentActivity(s.path, 10) : { lines: [], turns: 0, costUsd: 0 }),
            }));
            return json({ task: t, checks: checksWithVerdicts(t, events), events, sessions, placement: placement(f, t.id), waiting: waitDetail(boardSnapshot(f), t.id) });
          }
          return fail(404, "not_found", "no such page");
        }
        const w = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/(approve|merge)$/.exec(path);
        const runQueue = path === "/api/queue/run";
        // A colour label for this project (T-0089): a write like the others, behind the same gate.
        const label = /^\/api\/color\/([a-z]+)$/.exec(path);
        if (req.method === "POST" && label) {
          const no = refuse(req);
          if (no) return no;
          const c = label[1]!;
          if (c !== "none" && !isLabelColor(c)) return fail(400, "invalid", `unknown colour "${c}"`);
          labels.set(ctx.dir, c === "none" ? null : c);
          return json({ name: ctx.name, color: labels.get(ctx.dir) });
        }
        if (req.method === "POST" && (w || runQueue)) {
          const no = refuse(req);
          if (no) return no;
          if (w?.[2] === "approve") return json({ task: f.approve(w[1]!, opts.approver!) });
          if (ctx.passing) return fail(409, "busy", "merge in progress: a merge-queue pass is already running, try again when it finishes");
          if (w) {
            const t = f.get(w[1]!);
            if (t.status !== "approved") return fail(409, "not_approved", `${t.id} is ${t.status}, not approved: nothing to merge`);
            const entries = await pass(ctx, opts.approver!, t.id);
            return json({ entry: entries[0] ?? null, entries, task: f.get(t.id) });
          }
          return json({ entries: await pass(ctx, opts.approver!) });
        }
        return fail(405, "method_not_allowed", "the board is read-only, except approve, merge, run queue and colour labels");
      } catch (e) {
        if (e instanceof ForemanError) return fail(e.code === "not_found" ? 404 : 409, e.code, e.message);
        return fail(500, "error", "internal error");
      }
    },
  });

  // The --queue loop: one tick runs a pass per project in turn, then waits intervalMs.
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking: Promise<void> = Promise.resolve();
  const auto = opts.autoQueue;
  if (auto) {
    // One verify-only dispatcher per project, kept for the life of the loop: it holds the
    // session limit and which submission each task's verifier was started for (D0046). It is
    // not in the dispatcher registry: it starts no workers, so it covers no ready task.
    const verify = auto.verify === false ? null : (auto.verify ?? {});
    const verifiers = new Map<Ctx, Dispatcher>();
    if (verify) {
      const { log, onError: _onError, ...dispatch } = verify;
      for (const c of ctxs) {
        verifiers.set(
          c,
          new Dispatcher(c.f, {
            ...dispatch,
            verifyOnly: true,
            reverify: true,
            actor: auto.actor,
            // The loop removes finished sessions itself, below.
            cleanSessions: () => {},
            log: (l) => (log ? log(c.name, l) : console.log(ctxs.length > 1 ? `${c.name}: ${l}` : l)),
          }),
        );
      }
    }
    const tick = async () => {
      for (const c of ctxs) {
        if (stopped) return;
        // A pass already running here (a click) is left alone; the verify pass doesn't merge, so it still runs.
        if (!c.passing) {
          try {
            // Not inline in the call: without an onPass, `?.()` would skip the pass too.
            const entries = await pass(c, auto.actor);
            auto.onPass?.(c.name, entries);
          } catch (e) {
            auto.onError?.(c.name, e);
          }
        }
        if (stopped) return;
        // Submitted tasks get their verifier (D0046). Never breaks the merge queue or the loop.
        try {
          verifiers.get(c)?.tick();
        } catch (e) {
          try {
            (verify?.onError ?? ((p: string, err: unknown) => console.error(`${p}: verify pass failed: ${err instanceof Error ? err.message : String(err)}`)))(c.name, e);
          } catch {
            /* the report failed too: the loop still goes on */
          }
        }
        // Finished tasks' sessions leave the person's sessions list (T-0099). Never breaks the loop.
        try {
          (auto.cleanSessions ?? ((f: Foreman) => removeFinishedSessions(f, auto.actor)))(c.f);
        } catch {
          /* tried again next pass */
        }
      }
    };
    const loop = () => {
      ticking = tick().finally(() => {
        if (!stopped) timer = setTimeout(loop, auto.intervalMs);
      });
    };
    timer = setTimeout(loop, 0);
  }

  const port = server.port!;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  origins = new Set([...hosts].map((h) => `http://${h}`));
  return {
    url: `http://127.0.0.1:${port}`,
    openUrl: token ? `http://127.0.0.1:${port}/#t=${token}` : `http://127.0.0.1:${port}/`,
    port,
    token,
    queueRunning: auto !== undefined,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await server.stop(true);
      await ticking;
    },
  };
}
