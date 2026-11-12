// Why a task hasn't started, and what has to move first (D0042, and D0045 for "no dispatcher").
// One rule, read by everything that hands out work: Foreman.ready() and claim() (core.ts),
// the dispatcher (dispatch.ts), and what `fm show`, `fm list` and `fm next` print.
// - waitsOn: the direct reasons a draft or ready task waits.
// - pathOf: those reasons followed through the tasks they name, to the end, as a tree.
// - holdsUp: the reverse, everything downstream that waits on a task.
import type { Actor, Foreman, Status, Task } from "./core";
import { type DispatcherInfo, runningDispatchers, startsWorkers } from "./dispatchers";
import { loadShared, pathsOverlap } from "./policy";

/** Tasks whose paths are taken: someone is working on them or their PR is being checked. */
export const ACTIVE: Status[] = ["claimed", "in_progress", "in_review", "verifying"];

/** Only a task nobody has started can be waiting to start. */
const OPEN: Status[] = ["draft", "ready"];

export type Reason =
  /** Not marked ready. */
  | { kind: "draft" }
  /** A `blockedBy` task that isn't done. "missing": no such task (fail closed). */
  | { kind: "blocked"; task: string; status: Status | "missing" }
  /** An earlier step of its plan isn't done: the step, and its tasks that aren't done. */
  | { kind: "step"; plan: string; step: number; title: string; tasks: string[] }
  /** Its paths overlap a task in flight. */
  | { kind: "paths"; task: string; status: Status }
  /** Risk "human": a person does it. */
  | { kind: "human" }
  /** Ready with nothing else to wait on, and no running dispatcher would start it (D0045). */
  | { kind: "no dispatcher" };

export type LeafKind = "running" | "needs a person" | "can start" | "no dispatcher" | "stuck";

/** Why a path stops at a task, and who has to act. */
export interface Leaf {
  task: string;
  status: Status | "missing";
  kind: LeafKind;
  /** What has to happen, as the rest of "moves when: ...". */
  text: string;
  /** running: who holds it. */
  actor?: string;
  /** running: whether the holder's session is alive; null when it pinned no process. */
  live?: boolean | null;
}

export interface PathNode {
  task: string;
  title: string;
  status: Status | "missing";
  /** Why it is on the path: the reason its parent waits on it. Null for the root. */
  via: Reason | null;
  /** The path stops here (a node with children can still need something itself, e.g. a draft). */
  end?: Leaf;
  /** Already shown in full earlier in the tree. */
  ref?: true;
  /** Following this would loop: the tasks of the loop, from this one back to itself. */
  cycle?: string[];
  children: PathNode[];
}

export interface WaitPath {
  root: PathNode;
  /** Every place the path stops, in tree order, each task once. */
  leaves: Leaf[];
  /** The longest chain of tasks under the root. 0: it waits on no other task. */
  depth: number;
  /** "moves when: T-0115 is approved by a person; T-0093 finishes verifying". */
  summary: string;
}

export interface HeldUp {
  count: number;
  tasks: { id: string; title: string; status: Status; direct: boolean }[];
}

/** The tasks and plan placements at one moment, read once and shared by the functions below. */
export interface Snapshot {
  f: Foreman;
  order: Task[];
  tasks: Map<string, Task>;
  /** Task id to its place in a plan that isn't cancelled. */
  place: Map<string, { plan: string; step: number }>;
  /** Plan id to its steps, in order. */
  steps: Map<string, { n: number; title: string; tasks: string[] }[]>;
  /**
   * The dispatchers running now: their scopes and flags say which ready tasks one would
   * start. null: not asked, so nothing is reported as "no dispatcher".
   */
  dispatchers: Pick<DispatcherInfo, "scope" | "flags">[] | null;
  /** The repo's shared paths (D0043), once something has needed them. */
  shared?: string[];
}

type Row = Record<string, unknown>;

export function snapshot(f: Foreman, o: { dispatchers?: boolean } = {}): Snapshot {
  const order = f.list();
  const place: Snapshot["place"] = new Map();
  const steps: Snapshot["steps"] = new Map();
  // A cancelled plan promises no order any more: its tasks are held by nothing here.
  const stepRows = f.db
    .query(`SELECT s.plan_id, s.n, s.title FROM plan_steps s JOIN plans p ON p.id = s.plan_id WHERE p.status != 'cancelled' ORDER BY s.plan_id, s.n`)
    .all() as Row[];
  for (const r of stepRows) {
    const list = steps.get(r.plan_id as string) ?? [];
    list.push({ n: r.n as number, title: r.title as string, tasks: [] });
    steps.set(r.plan_id as string, list);
  }
  const placed = f.db
    .query(`SELECT pt.task_id, pt.plan_id, pt.step FROM plan_tasks pt JOIN tasks t ON t.id = pt.task_id ORDER BY t.num`)
    .all() as Row[];
  for (const r of placed) {
    const step = steps.get(r.plan_id as string)?.find((s) => s.n === r.step);
    if (!step) continue;
    step.tasks.push(r.task_id as string);
    place.set(r.task_id as string, { plan: r.plan_id as string, step: r.step as number });
  }
  // Read only: a snapshot is taken on every read of the board, and dropping dead records is the registry's job.
  const dispatchers = o.dispatchers === false ? null : runningDispatchers(f, { drop: false });
  return { f, order, tasks: new Map(order.map((t) => [t.id, t])), place, steps, dispatchers };
}

const snap = (from: Foreman | Snapshot): Snapshot => ("order" in from ? from : snapshot(from));

/**
 * Could the two tasks edit the same file? Paths that are both shared don't count (D0037,
 * D0043). foreman.json's list is read once per snapshot, and only when the paths overlap
 * at all: it can only take overlaps away, and reading it runs git.
 */
function overlap(s: Snapshot, t: Task, o: Task): boolean {
  if (!pathsOverlap(t.paths, o.paths)) return false;
  s.shared ??= loadShared(s.f.root);
  return pathsOverlap(t.paths, o.paths, s.shared);
}

function reasonsFor(s: Snapshot, t: Task): Reason[] {
  if (!OPEN.includes(t.status)) return [];
  const out: Reason[] = [];
  if (t.status === "draft") out.push({ kind: "draft" });
  for (const b of t.blockedBy) {
    const status = s.tasks.get(b)?.status ?? "missing";
    if (status !== "done") out.push({ kind: "blocked", task: b, status });
  }
  const at = s.place.get(t.id);
  if (at) {
    for (const step of s.steps.get(at.plan) ?? []) {
      if (step.n >= at.step) break;
      const open = step.tasks.filter((id) => !["done", "cancelled"].includes(s.tasks.get(id)!.status));
      if (open.length) out.push({ kind: "step", plan: at.plan, step: step.n, title: step.title, tasks: open });
    }
  }
  for (const o of s.order) {
    if (o.id !== t.id && ACTIVE.includes(o.status) && overlap(s, t, o)) out.push({ kind: "paths", task: o.id, status: o.status });
  }
  if (t.risk === "human") out.push({ kind: "human" });
  // Only when it is the whole answer: a task that waits on something else isn't waiting for a dispatcher yet.
  if (!out.length && t.status === "ready" && s.dispatchers && !s.dispatchers.some((d) => startsWorkers(d, at?.plan))) out.push({ kind: "no dispatcher" });
  return out;
}

/** The reasons that name something to wait for. "no dispatcher" isn't one: the task itself can start. */
const held = (reasons: Reason[]) => reasons.filter((r) => r.kind !== "no dispatcher");

/**
 * What a task waits on, directly. Empty means it can start now and a running dispatcher
 * will start it. Only a draft or ready task waits: one that is already started, finished
 * or cancelled returns nothing.
 */
export function waitsOn(from: Foreman | Snapshot, id: string): Reason[] {
  const s = snap(from);
  const t = s.tasks.get(id);
  return t ? reasonsFor(s, t) : [];
}

/**
 * What holds a dispatcher that covers the task: every reason but "no dispatcher", which
 * is about whether one runs, not about the task.
 */
export function holdsDispatch(reasons: Reason[]): Reason[] {
  return held(reasons);
}

/**
 * The reasons that refuse a claim by this kind of actor. `paths` isn't one: keeping
 * overlapping tasks apart is the dispatcher's job (D0011), which starts a task only when
 * waitsOn is empty; a person or their own session may claim past an overlap knowingly.
 * `human` holds agents only.
 */
export function holdsClaim(reasons: Reason[], kind: Actor["kind"]): Reason[] {
  return reasons.filter((r) => r.kind === "draft" || r.kind === "blocked" || r.kind === "step" || (r.kind === "human" && kind === "agent"));
}

const words = (s: string) => s.replace(/_/g, " ");

/** One reason as words: "blocked by T-0002 (in progress)". */
export function reasonText(r: Reason): string {
  switch (r.kind) {
    case "draft":
      return "a draft, not marked ready";
    case "blocked":
      return `blocked by ${r.task} (${words(r.status)})`;
    case "step":
      return `step ${r.step} of ${r.plan} ("${r.title}") isn't done: ${r.tasks.join(", ")}`;
    case "paths":
      return `its paths overlap ${r.task}'s (${words(r.status)})`;
    case "human":
      return `risk "human": a person does it`;
    case "no dispatcher":
      return "no running dispatcher covers it";
  }
}

/** Why a node is under its parent, short, for the tree. */
function viaText(r: Reason): string {
  if (r.kind === "blocked") return "blocker";
  if (r.kind === "step") return `step ${r.step} of ${r.plan} "${r.title}"`;
  if (r.kind === "paths") return "paths overlap";
  return r.kind;
}

/** A ready task that came back from review and nothing has picked up again: why, or null. */
function cameBack(s: Snapshot, id: string): string | null {
  const last = [...s.f.events(id)].reverse().find((e) => ["verify_failed", "rework", "submitted", "ready"].includes(e.type));
  if (last?.type === "verify_failed") return "failed verification";
  if (last?.type === "rework") return `sent back: ${String(last.data.reason ?? "")}`.trim();
  return null;
}

function endOf(s: Snapshot, t: Task, reasons: Reason[]): Leaf | undefined {
  const leaf = (kind: LeafKind, text: string, more: Partial<Leaf> = {}): Leaf => ({ task: t.id, status: t.status, kind, text: `${t.id} ${text}`, ...more });
  switch (t.status) {
    case "done":
      return undefined;
    case "cancelled":
      return leaf("stuck", "was cancelled: take it out of what waits on it");
    case "claimed":
    case "in_progress":
    case "verifying": {
      const pid = s.f.leasePid(t.id);
      const live = pid === null ? null : s.f.isAlive(pid);
      const session = live === null ? "no session recorded" : live ? "session live" : "session gone";
      const who = t.assignee ?? "nobody";
      const text = t.status === "verifying" ? `finishes verifying (${who}, ${session})` : `is finished by ${who} (${words(t.status)}, ${session})`;
      return leaf("running", text, { actor: who, live });
    }
    case "in_review":
      return leaf("can start", "gets a verifier (submitted, nothing has picked it up yet)");
    case "needs_approval":
      return leaf("needs a person", "is approved by a person");
    case "approved":
      return leaf("can start", "is merged (approved, nothing has merged it yet)");
    case "draft":
      return leaf("needs a person", "is marked ready (a draft)");
    case "ready": {
      if (t.risk === "human") return leaf("needs a person", `is done by a person (risk "human")`);
      if (held(reasons).length) return undefined; // the tasks it waits on carry the path further
      const back = cameBack(s, t.id);
      if (back) return leaf("stuck", `gets a new run (${back})`);
      if (reasons.length) return leaf("no dispatcher", "is picked up (can start, but no dispatcher covers it)");
      return leaf("can start", "is picked up (ready, nothing to wait on)");
    }
  }
}

/**
 * The whole path: what the task waits on, what those wait on, down to the things that
 * have to move first. A task reached twice is shown once in full and as a reference
 * after that; a loop is reported as a cycle and not followed.
 */
export function pathOf(from: Foreman | Snapshot, id: string): WaitPath {
  const s = snap(from);
  const seen = new Set<string>();
  const height = new Map<string, number>();
  const leaves: Leaf[] = [];
  const build = (task: string, via: Reason | null, stack: string[]): PathNode => {
    const t = s.tasks.get(task);
    if (!t) {
      const end: Leaf = { task, status: "missing", kind: "stuck", text: `${task} doesn't exist: take it out of what waits on it` };
      if (!leaves.some((l) => l.task === task)) leaves.push(end);
      return { task, title: "", status: "missing", via, end, children: [] };
    }
    const node: PathNode = { task, title: t.title, status: t.status, via, children: [] };
    const at = stack.indexOf(task);
    if (at >= 0) {
      node.cycle = [...stack.slice(at), task];
      node.end = { task, status: t.status, kind: "stuck", text: `cycle: ${node.cycle.join(" waits on ")}` };
      leaves.push(node.end);
      return node;
    }
    if (seen.has(task)) return { ...node, ref: true };
    seen.add(task);
    const reasons = reasonsFor(s, t);
    const below = [...stack, task];
    for (const r of reasons) {
      if (r.kind === "blocked" || r.kind === "paths") node.children.push(build(r.task, r, below));
      if (r.kind === "step") for (const x of r.tasks) node.children.push(build(x, r, below));
    }
    height.set(task, node.children.length ? 1 + Math.max(...node.children.map((c) => (c.cycle ? 0 : (height.get(c.task) ?? 0)))) : 0);
    const end = endOf(s, t, reasons.filter((r) => r.kind !== "draft" && r.kind !== "human"));
    if (end) {
      node.end = end;
      leaves.push(end);
    }
    return node;
  };
  const root = build(id, null, []);
  const summary = leaves.length ? `moves when: ${leaves.map((l) => l.text).join("; ")}` : `nothing to wait on (${words(root.status)})`;
  return { root, leaves, depth: height.get(id) ?? 0, summary };
}

/** A loop in what the task waits on that comes back to the task itself, or null. */
export function cycleThrough(from: Foreman | Snapshot, id: string): string[] | null {
  const find = (n: PathNode): string[] | null => {
    if (n.cycle && n.cycle[0] === id) return n.cycle;
    for (const c of n.children) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  return find(pathOf(from, id).root);
}

/** Everything downstream that waits on the task, directly or through others, in task order. */
export function holdsUp(from: Foreman | Snapshot, id: string): HeldUp {
  const s = snap(from);
  const waiters = new Map<string, string[]>(); // task -> the tasks that wait on it directly
  for (const t of s.order) {
    for (const r of reasonsFor(s, t)) {
      const named = r.kind === "blocked" || r.kind === "paths" ? [r.task] : r.kind === "step" ? r.tasks : [];
      for (const n of named) waiters.set(n, [...(waiters.get(n) ?? []), t.id]);
    }
  }
  const direct = new Set(waiters.get(id) ?? []);
  const all = new Set<string>();
  const queue = [...direct];
  while (queue.length) {
    const next = queue.shift()!;
    if (next === id || all.has(next)) continue;
    all.add(next);
    queue.push(...(waiters.get(next) ?? []));
  }
  const tasks = s.order.filter((t) => all.has(t.id)).map((t) => ({ id: t.id, title: t.title, status: t.status, direct: direct.has(t.id) }));
  return { count: tasks.length, tasks };
}

/**
 * The short form for a list: the first direct reason and the first place its path stops,
 * e.g. "waits: T-0112 <- T-0110 (in progress)". Null for a task that waits on nothing,
 * and for a plain draft (its status already says so).
 */
export function waitShort(from: Foreman | Snapshot, id: string): string | null {
  const s = snap(from);
  const first = waitsOn(s, id).find((r) => r.kind !== "draft");
  if (!first) return null;
  if (first.kind === "human") return "waits: a person (risk human)";
  if (first.kind === "no dispatcher") return "waits: no dispatcher";
  const head = first.kind === "blocked" ? first.task : first.kind === "step" ? `step ${first.step} of ${first.plan}` : `paths overlap ${first.task}`;
  const leaf = pathOf(s, id).leaves.find((l) => l.task !== id || l.text.startsWith("cycle:"));
  if (!leaf) return `waits: ${head}`;
  const state = leaf.text.startsWith("cycle:") ? "cycle" : leaf.kind === "no dispatcher" ? `${words(leaf.status)}, no dispatcher` : words(leaf.status);
  const direct = first.kind !== "step" && first.task === leaf.task;
  return `waits: ${head}${direct ? "" : ` <- ${leaf.task}`} (${state})`;
}

/** The path as an indented tree, a line per task. */
export function pathText(p: WaitPath): string {
  const lines: string[] = [];
  const walk = (n: PathNode, depth: number) => {
    const parts = [`${"  ".repeat(depth)}${n.task}`, words(n.status)];
    if (n.title) parts.push(n.title);
    if (n.via) parts.push(`[${viaText(n.via)}]`);
    if (n.ref) parts.push("(shown above)");
    if (n.end) parts.push(`=> ${n.end.kind}: ${n.end.text}`);
    lines.push(parts.join("  "));
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(p.root, 0);
  return lines.join("\n");
}

/** What `fm show` and show_task add under the task: the tree, the leaves, then what it holds up. */
export function waitingText(p: WaitPath, held: HeldUp): string {
  const lines = ["## Waits on", pathText(p), "", p.summary, ...(p.depth ? [`depth: ${p.depth}`] : []), ""];
  if (held.count) {
    lines.push(`## Holds up (${held.count})`);
    for (const t of held.tasks) lines.push(`- ${t.id}  ${words(t.status)}  ${t.title}${t.direct ? "" : "  (through others)"}`);
    lines.push("");
  }
  return lines.join("\n");
}
