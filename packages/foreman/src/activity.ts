// What a dispatched session is doing (T-0065): find a task's session transcripts and turn
// them into short readable lines, for `fm logs`, `fm list` and the board's task view.
// Reads transcripts only (Claude Code's `projects/<cwd>/<session>.jsonl`, or stream-json,
// which has the same message shape); nothing here talks to a service.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Event, Foreman } from "./core";
import { costOf, defaultConfigDir, transcriptPath } from "./launch";

export interface ActivityLine {
  kind: "tool" | "say" | "result";
  text: string;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The one argument of a tool call worth showing: the command, file, pattern or url. */
export function mainArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof i[k] === "string" && i[k]) return i[k] as string;
  }
  const first = Object.values(i).find((v) => typeof v === "string" && v);
  return typeof first === "string" ? first : "";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
  return "";
}

/** Renders a line as the CLI prints it. */
export function formatLine(l: ActivityLine): string {
  return l.kind === "result" ? `  -> ${l.text}` : l.kind === "tool" ? `> ${l.text}` : `# ${l.text}`;
}

/** Reads a transcript in chunks of any size: readable lines, and turns and cost so far. */
export class TranscriptReader {
  private buf = "";
  private usage = new Map<string, number>();
  private anon = 0;
  costUsd = 0;
  turns = 0;

  /** The lines the new text adds (a partial last line waits for the rest). */
  push(chunk: string): ActivityLine[] {
    this.buf += chunk;
    const out: ActivityLine[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, nl), out);
      this.buf = this.buf.slice(nl + 1);
    }
    return out;
  }

  private line(raw: string, out: ActivityLine[]) {
    if (!raw.trim()) return;
    let ev: { type?: string; message?: { id?: string; model?: string; usage?: object; content?: unknown } };
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const m = ev.message;
    if (!m) return;
    if (ev.type === "assistant") {
      if (m.usage) {
        const id = m.id ?? `anon-${this.anon++}`;
        this.usage.set(id, costOf(m.model ?? "", m.usage));
        this.turns = this.usage.size;
        this.costUsd = [...this.usage.values()].reduce((a, b) => a + b, 0);
      }
      if (!Array.isArray(m.content)) return;
      for (const b of m.content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
        if (b.type === "text" && b.text?.trim()) out.push({ kind: "say", text: clip(b.text, 200) });
        else if (b.type === "tool_use") out.push({ kind: "tool", text: clip(`${b.name ?? "tool"} ${mainArg(b.input)}`, 160) });
      }
    } else if (ev.type === "user" && Array.isArray(m.content)) {
      for (const b of m.content as { type?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type !== "tool_result") continue;
        const first = resultText(b.content).split("\n").find((l) => l.trim()) ?? "";
        out.push({ kind: "result", text: clip(`${b.is_error ? "error: " : ""}${first}`, 140) });
      }
    }
  }
}

/** All of a transcript's lines, with its turns and cost. */
export function readTranscript(text: string): { lines: ActivityLine[]; turns: number; costUsd: number } {
  const r = new TranscriptReader();
  const lines = r.push(text.endsWith("\n") ? text : `${text}\n`);
  return { lines, turns: r.turns, costUsd: r.costUsd };
}

export interface SessionInfo {
  role: "worker" | "verifier" | string;
  /** The actor that held the task, e.g. worker-T-0065. */
  actor: string;
  name?: string;
  /** The short id `claude attach` takes. */
  id?: string;
  sessionId?: string;
  /** The transcript on disk, if one was found. */
  path: string | null;
  /** Its process is alive and still holds the task. */
  live: boolean;
  at: number;
}

/** Where Claude Code may keep transcripts: the person's config dir, and foreman's isolated one. */
export function defaultConfigDirs(root: string | null): string[] {
  const dirs = [process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")];
  if (root) dirs.push(defaultConfigDir(root));
  return dirs;
}

function findTranscript(dirs: string[], cwd: string | null, sessionId?: string, shortId?: string): string | null {
  if (!cwd) return null;
  for (const d of dirs) {
    if (sessionId) {
      const p = transcriptPath(d, cwd, sessionId);
      if (existsSync(p)) return p;
    }
    if (shortId) {
      const dir = join(transcriptPath(d, cwd, "x"), "..");
      try {
        const hit = readdirSync(dir).find((n) => n.startsWith(shortId) && n.endsWith(".jsonl"));
        if (hit) return join(dir, hit);
      } catch {
        // no such directory here
      }
    }
  }
  return null;
}

/** The sessions dispatched for a task, oldest first (one per lease_pinned event). */
export function taskSessions(f: Foreman, taskId: string, dirs = defaultConfigDirs(f.root), events: Event[] = f.events(taskId)): SessionInfo[] {
  const t = f.get(taskId);
  const pid = f.leasePid(taskId);
  const alive = pid !== null && f.isAlive(pid);
  const pins = events.filter((e) => e.type === "lease_pinned");
  return pins.map((e, i) => {
    const d = e.data as { pid?: number; name?: string; session?: string; sessionId?: string };
    const last = i === pins.length - 1;
    return {
      role: e.actor.split("-")[0] ?? "",
      actor: e.actor,
      name: d.name,
      id: d.session,
      sessionId: d.sessionId,
      path: findTranscript(dirs, t.worktree, d.sessionId, d.session),
      live: last && alive && t.assignee === e.actor && d.pid === pid,
      at: e.at,
    };
  });
}

/** Does a task have a session running right now? */
export function hasLiveSession(f: Foreman, taskId: string): boolean {
  const pid = f.leasePid(taskId);
  return pid !== null && f.isAlive(pid);
}

export function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** The last `n` lines of a session's transcript with its cost, for the board. */
export function recentActivity(path: string, n = 10) {
  const r = readTranscript(readFileSafe(path));
  return { lines: r.lines.slice(-n), turns: r.turns, costUsd: r.costUsd };
}

export interface LogsOptions {
  role?: string;
  follow?: boolean;
  write: (line: string) => void;
  /** -f: how often to look for new lines, in ms. */
  pollMs?: number;
  /** -f: tests end the wait here. Default: until no session of the task is alive. */
  stop?: () => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fm logs`: print each matching session's transcript as readable lines; with follow, lines appended later. */
export async function printLogs(f: Foreman, taskId: string, o: LogsOptions, dirs = defaultConfigDirs(f.root)): Promise<number> {
  const all = taskSessions(f, taskId, dirs);
  const sessions = o.role ? all.filter((s) => s.role === o.role) : all;
  if (!sessions.length) {
    o.write(all.length ? `${taskId} has no ${o.role} session` : `${taskId} has no dispatched session yet`);
    return 1;
  }
  const cursors: { s: SessionInfo; r: TranscriptReader; offset: number }[] = [];
  for (const s of sessions) {
    o.write(`== ${s.role} ${s.name ?? s.actor}${s.id ? ` (${s.id})` : ""}${s.live ? " [live]" : ""}`);
    if (!s.path) {
      o.write("   (no transcript found)");
      continue;
    }
    cursors.push({ s, r: new TranscriptReader(), offset: 0 });
  }
  const drain = () => {
    for (const c of cursors) {
      const buf = readFileSync(c.s.path!);
      if (buf.length <= c.offset) continue;
      const before = c.r.costUsd;
      const lines = c.r.push(buf.subarray(c.offset).toString("utf8"));
      c.offset = buf.length;
      for (const l of lines) o.write(formatLine(l));
      if (lines.length || c.r.costUsd !== before) o.write(`   ${c.r.turns} turns, $${c.r.costUsd.toFixed(2)} so far`);
    }
  };
  drain();
  if (o.follow) {
    const stop = o.stop ?? (() => !hasLiveSession(f, taskId));
    while (!stop()) {
      await sleep(o.pollMs ?? 1000);
      drain();
    }
    drain();
  }
  return 0;
}
