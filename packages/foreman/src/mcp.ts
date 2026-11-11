// foreman's MCP server (stdio). Same core as the CLI. Everyone calling through
// MCP is an agent, so there is no approve tool here: sign-off is for people (D0002).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Actor, Foreman, ForemanError, type Status, type Task } from "./core";
import { toMarkdown } from "./export";
import { VERSION } from "./kit/paths";
import { planText, Plans } from "./plans";
import { holdsUp, pathOf, snapshot, waitingText, waitShort } from "./waiting";

const STATUSES = [
  "draft", "ready", "claimed", "in_progress", "in_review", "verifying",
  "needs_approval", "approved", "done", "cancelled",
] as const;

export interface ServerOptions {
  /** create_task always files a draft, whatever `ready` says (intake: only the caller marks tasks ready). */
  draftsOnly?: boolean;
}

export function buildServer(f: Foreman, me: Actor, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "foreman", version: VERSION });
  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const wrap =
    <A>(fn: (a: A) => unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        if (e instanceof ForemanError) {
          return { isError: true, content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }] };
        }
        throw e;
      }
    };
  const id = { id: z.string().describe("Task id, e.g. T-0001") };
  const plans = new Plans(f);
  const step = z.object({ title: z.string(), check: z.string().describe("What shows the step is done") });
  /** Tasks with the short form of what each waits on (waiting.ts), where it waits. */
  const withWaits = (ts: Task[]) => {
    const s = snapshot(f);
    return ts.map((t) => {
      const waits = waitShort(s, t.id);
      return waits ? { ...t, waits } : t;
    });
  };

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks, optionally by status. A task that waits carries `waits`: what it waits on and where that path ends, e.g. \"waits: T-0112 <- T-0110 (in progress)\". show_task has the whole path.",
      inputSchema: { status: z.array(z.enum(STATUSES)).optional() },
    },
    wrap(({ status }: { status?: Status[] }) => withWaits(f.list({ status }))),
  );
  server.registerTool(
    "next_tasks",
    {
      description: "Ready tasks an agent can claim now: blockers done and every earlier step of its plan done. `waits` on one means its paths overlap a task in flight: the dispatcher holds it back until that finishes.",
      inputSchema: {},
    },
    wrap(() => withWaits(f.ready("agent"))),
  );
  server.registerTool(
    "show_task",
    {
      description:
        "One task as markdown: spec, acceptance checks, history. Then what it waits on, as a tree followed to the end (blockers, earlier plan steps, overlapping paths, a person), what has to move first, and the tasks it holds up.",
      inputSchema: id,
    },
    wrap(({ id }: { id: string }) => {
      const s = snapshot(f);
      return `${toMarkdown(f.get(id), f.events(id), plans.placement(id))}\n${waitingText(pathOf(s, id), holdsUp(s, id))}`;
    }),
  );
  server.registerTool(
    "create_task",
    {
      description:
        "File a task. Search with list_tasks first so you don't file a duplicate. Work you found while doing another task: set discoveredFrom.",
      inputSchema: {
        title: z.string(),
        spec: z.string().optional().describe("Markdown: what and why"),
        acceptance: z
          .array(z.string())
          .optional()
          .describe('Checks: "cmd: <command that must exit 0>" or "statement: <claim to verify>"'),
        paths: z.array(z.string()).optional().describe("The narrowest globs covering the files the task will touch. Tasks with overlapping paths never run at once, so a broad glob like packages/** makes other tasks wait."),
        risk: z.enum(["auto", "review", "human"]).optional(),
        parent: z.string().optional(),
        blockedBy: z.array(z.string()).optional(),
        discoveredFrom: z.string().optional(),
        ready: z.boolean().optional(),
        plan: z.string().optional().describe("Plan id (P-0001) to file the task into; needs step"),
        step: z.number().int().positive().optional().describe("Step number in that plan, from show_plan"),
      },
    },
    wrap(({ plan, step, ...a }: Parameters<Foreman["create"]>[0] & { plan?: string; step?: number }) => {
      if ((plan === undefined) !== (step === undefined)) throw new ForemanError("invalid", "plan and step go together");
      const input = opts.draftsOnly ? { ...a, ready: false } : a;
      return plans.createTask(input, plan ? { plan, step: step! } : null, me);
    }),
  );
  server.registerTool(
    "list_plans",
    { description: "Every plan with its progress (steps and tasks done), active first.", inputSchema: {} },
    wrap(() => plans.list().map(({ steps: _s, goal: _g, ...p }) => p)),
  );
  server.registerTool(
    "show_plan",
    {
      description: "One plan: its goal, then each step in order with its check, its state (empty, waiting, in_progress, done) and its tasks.",
      inputSchema: { id: z.string().describe("Plan id, e.g. P-0001") },
    },
    wrap(({ id }: { id: string }) => planText(plans.get(id))),
  );
  server.registerTool(
    "create_plan",
    {
      description:
        "File a plan: ordered steps, each with a check that says it is done. Then file its tasks with create_task plan+step (tasks that can run side by side share a step). Search list_plans first.",
      inputSchema: { title: z.string(), goal: z.string().optional().describe("Markdown: what the plan is for"), steps: z.array(step).min(1) },
    },
    wrap((a: { title: string; goal?: string; steps: { title: string; check: string }[] }) => plans.create(a, me)),
  );
  server.registerTool(
    "edit_plan",
    {
      description: "Change a plan: title, goal, add steps at the end, or cancel it with a reason.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        goal: z.string().optional(),
        addSteps: z.array(step).optional(),
        cancel: z.string().optional().describe("Cancel the plan, with this reason"),
      },
    },
    wrap(({ id, cancel, ...c }: { id: string; cancel?: string; title?: string; goal?: string; addSteps?: { title: string; check: string }[] }) => {
      // Refuse a blank reason before any write, so edits never land without the cancel.
      if (cancel !== undefined && !cancel.trim()) throw new ForemanError("invalid", "cancelling a plan needs a reason");
      const p = Object.values(c).some((v) => v !== undefined) ? plans.edit(id, me, c) : plans.get(id);
      return cancel !== undefined ? plans.cancel(id, me, cancel) : p;
    }),
  );
  server.registerTool(
    "plan_task",
    {
      description: "Put a task in a plan's step (moving it from any other plan), or take it out of its plan with remove.",
      inputSchema: {
        task: z.string(),
        plan: z.string().optional(),
        step: z.number().int().positive().optional(),
        remove: z.boolean().optional(),
      },
    },
    wrap(({ task, plan, step, remove }: { task: string; plan?: string; step?: number; remove?: boolean }) => {
      if (remove) {
        if (plan !== undefined || step !== undefined) throw new ForemanError("invalid", "remove takes no plan or step");
        return plans.remove(task, me);
      }
      if (plan === undefined || step === undefined) throw new ForemanError("invalid", "plan_task needs plan and step, or remove");
      return plans.add(task, plan, step, me);
    }),
  );
  server.registerTool(
    "claim_task",
    {
      description: "Claim a task (or the next ready one if id is omitted). Refused while it waits on a blocker or an earlier step of its plan. Keep it alive with heartbeat or progress.",
      inputSchema: { id: z.string().optional(), leaseMinutes: z.number().int().positive().optional() },
    },
    wrap(({ id, leaseMinutes }: { id?: string; leaseMinutes?: number }) => f.claim(id ?? null, me, leaseMinutes)),
  );
  server.registerTool(
    "heartbeat",
    { description: "Keep your claim alive.", inputSchema: id },
    wrap(({ id }: { id: string }) => f.heartbeat(id, me)),
  );
  server.registerTool(
    "report_progress",
    {
      description: "Record progress on a task you hold (also renews the lease).",
      inputSchema: { ...id, note: z.string().optional(), branch: z.string().optional(), worktree: z.string().optional() },
    },
    wrap(({ id, ...p }: { id: string; note?: string; branch?: string; worktree?: string }) => f.progress(id, me, p)),
  );
  server.registerTool(
    "submit_task",
    {
      description: "Hand in your PR. You let go of the task; someone else verifies it.",
      inputSchema: { ...id, pr: z.string(), summary: z.string().optional() },
    },
    wrap(({ id, pr, summary }: { id: string; pr: string; summary?: string }) => f.submit(id, me, { pr, summary })),
  );
  server.registerTool(
    "start_verify",
    { description: "Take a submitted task to verify. Refused if you worked on it.", inputSchema: id },
    wrap(({ id }: { id: string }) => f.startVerify(id, me)),
  );
  server.registerTool(
    "record_verdict",
    {
      description:
        "Your verdict on a task you are verifying: one result per acceptance check. Run cmd checks yourself; never trust the worker's summary.",
      inputSchema: {
        ...id,
        results: z.array(z.object({ check: z.string(), pass: z.boolean(), evidence: z.string() })),
      },
    },
    wrap(({ id, results }: { id: string; results: { check: string; pass: boolean; evidence: string }[] }) =>
      f.recordVerify(id, me, results),
    ),
  );
  server.registerTool(
    "mark_merged",
    { description: "An approved task's PR was merged.", inputSchema: { ...id, pr: z.string().optional() } },
    wrap(({ id, pr }: { id: string; pr?: string }) => f.merged(id, me, pr)),
  );
  server.registerTool(
    "reserve_number",
    {
      description: 'Reserve the next number of a kind ("decision", "migration") so parallel PRs never clash.',
      inputSchema: { kind: z.string(), task: z.string().optional() },
    },
    wrap(({ kind, task }: { kind: string; task?: string }) => ({ kind, value: f.reserve(kind, me, task) })),
  );
  server.registerTool(
    "edit_task",
    {
      description:
        "Change a task. Before work starts, anything (only a person lowers risk), what it is blocked by included (a cycle is refused). While you hold it, you may only add paths, when the work turns out to touch more files. Not while under review: use rework_task first.",
      inputSchema: {
        ...id,
        title: z.string().optional(),
        spec: z.string().optional(),
        addChecks: z.array(z.string()).optional(),
        removeChecks: z.array(z.string()).optional(),
        paths: z.array(z.string()).optional(),
        addPaths: z.array(z.string()).optional(),
        risk: z.enum(["auto", "review", "human"]).optional(),
        addBlockedBy: z.array(z.string()).optional().describe("Tasks it must wait for (draft or ready tasks only)"),
        removeBlockedBy: z.array(z.string()).optional(),
      },
    },
    wrap(({ id, ...c }: { id: string } & Parameters<Foreman["edit"]>[2]) => f.edit(id, me, c)),
  );
  server.registerTool(
    "rework_task",
    {
      description:
        "Send a task you worked on back to work after it was submitted or verified: its PR is changing again, or a gap was found. It must be claimed and verified again. Not once a person has approved it (refused: approved_by_person): file the new work as its own task with discoveredFrom, or ask the person.",
      inputSchema: { ...id, reason: z.string() },
    },
    wrap(({ id, reason }: { id: string; reason: string }) => f.rework(id, me, reason)),
  );
  return server;
}

/**
 * The name this server acts as. FOREMAN_ACTOR wins. Otherwise it must survive the client restarting the
 * server mid-session, so it comes from the parent (the client session), never this process's own pid:
 * an id the client passes (CLAUDE_CODE_SESSION_ID or CLAUDE_SESSION_ID), else the parent pid, else the user.
 */
export function actorName(
  env: Record<string, string | undefined> = process.env,
  ppid: number = process.ppid,
): string {
  if (env.FOREMAN_ACTOR) return env.FOREMAN_ACTOR;
  const session = env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID;
  if (session) return `mcp-${session.replace(/[^\w.-]/g, "").slice(0, 36)}`;
  if (ppid > 1) return `mcp-p${ppid}`;
  return `mcp-${env.USER || env.USERNAME || "user"}`;
}

export async function serve() {
  const me: Actor = { name: actorName(), kind: "agent" };
  const opts = { draftsOnly: process.env.FOREMAN_DRAFTS_ONLY === "1" };
  await buildServer(Foreman.open(), me, opts).connect(new StdioServerTransport());
}
