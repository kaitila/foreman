// The local board (T-0035, T-0067): one Bun.serve on 127.0.0.1, a read-only JSON API over
// the same Foreman core, and one page with inline CSS/JS (no external assets, works offline).
// The writes are approve, merge and run-queue. Each needs the token `fm serve` prints to its
// own terminal, in the fragment of the URL it prints (never in a page or an API response),
// and, when the browser sends one, our own Origin (D0021).
import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { type Actor, type Event, type Foreman, ForemanError, type Status, type Task } from "../core";
import { defaultRun, GITHUB_PR } from "../policy";
import { judgeChecks, mergeQueuePass, parsePr, PR_VIEW, type QueueEntry, type QueueOptions } from "../queue";
import { pageHtml } from "./page";
import { hasLiveSession, recentActivity, taskSessions } from "../activity";

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
}

/** gh run off the event loop; null on failure or when the process is killed at the timeout. */
async function asyncRun(cmd: string[], cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 30_000 });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

export interface Board {
  url: string;
  /** The URL to open: `url` with the token in the fragment, which the browser never sends. */
  openUrl: string;
  port: number;
  /** Shown once, in the terminal that started the board. null when approving is off. */
  token: string | null;
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

/** What one project needs: its database, where gh runs, its PR cache and its one-pass-at-a-time flag. */
interface Ctx {
  name: string;
  f: Foreman;
  cwd: string;
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

  const state = (c: Ctx) => ({
    lanes: LANES,
    tasks: c.f.list().map((t) => ({ ...card(t), live: hasLiveSession(c.f, t.id) })),
    lastEvent: c.f.events().at(-1)?.id ?? 0,
    canApprove: token !== null,
  });
  const summary = (c: Ctx) => {
    const ts = c.f.list();
    return {
      name: c.name,
      waiting: ts.filter((t) => t.status === "needs_approval").length,
      toMerge: ts.filter((t) => t.status === "approved").length,
      total: ts.length,
    };
  };

  const run = opts.queue?.run ?? defaultRun;
  const prCacheMs = opts.prCacheMs ?? 15_000;
  /** A PR's state for its card: what the merge queue would read first, without merging. */
  const prTimeoutMs = opts.prTimeoutMs ?? 15_000;
  const readRun = opts.readRun ?? (opts.queue?.run ? async (c: string[], d: string) => run(c, d) : asyncRun);
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

  // One merge-queue pass at a time per project, whoever asks: two clicks must not merge in parallel.
  const pass = async (c: Ctx, only?: string): Promise<QueueEntry[]> => {
    c.passing = true;
    try {
      return await mergeQueuePass(c.f, opts.approver!, { ...opts.queue, cwd: c.cwd, only });
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
          if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method_not_allowed", "the board is read-only, except approve, merge and run queue");
          const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
          const initial = {
            lanes: LANES,
            canApprove: token !== null,
            projects: ctxs.map((c) => ({ name: c.name, ...state(c) })),
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
          if (path === "/api/events") {
            const since = Number(url.searchParams.get("since") ?? 0) || 0;
            const events = f.events().filter((e) => e.id > since);
            return json({ events, lastEvent: events.at(-1)?.id ?? since });
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
            return json({ task: t, checks: checksWithVerdicts(t, events), events, sessions });
          }
          return fail(404, "not_found", "no such page");
        }
        const w = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/(approve|merge)$/.exec(path);
        const runQueue = path === "/api/queue/run";
        if (req.method === "POST" && (w || runQueue)) {
          const no = refuse(req);
          if (no) return no;
          if (w?.[2] === "approve") return json({ task: f.approve(w[1]!, opts.approver!) });
          if (ctx.passing) return fail(409, "busy", "merge in progress: a merge-queue pass is already running, try again when it finishes");
          if (w) {
            const t = f.get(w[1]!);
            if (t.status !== "approved") return fail(409, "not_approved", `${t.id} is ${t.status}, not approved: nothing to merge`);
            const entries = await pass(ctx, t.id);
            return json({ entry: entries[0] ?? null, entries, task: f.get(t.id) });
          }
          return json({ entries: await pass(ctx) });
        }
        return fail(405, "method_not_allowed", "the board is read-only, except approve, merge and run queue");
      } catch (e) {
        if (e instanceof ForemanError) return fail(e.code === "not_found" ? 404 : 409, e.code, e.message);
        return fail(500, "error", "internal error");
      }
    },
  });

  const port = server.port!;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  origins = new Set([...hosts].map((h) => `http://${h}`));
  return {
    url: `http://127.0.0.1:${port}`,
    openUrl: token ? `http://127.0.0.1:${port}/#t=${token}` : `http://127.0.0.1:${port}/`,
    port,
    token,
    stop: () => server.stop(true),
  };
}
