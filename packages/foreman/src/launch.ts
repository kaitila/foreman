// Launch adapter (D0011): start a headless Claude Code session for one role
// (worker, verifier, intake), isolated from the person's own configuration.
// - CLAUDE_CONFIG_DIR is a foreman-owned dir holding only a symlink to the login,
//   so the person's settings, hooks and memory don't load.
// - claudeMdExcludes lists every CLAUDE.md above the repository: a repo under the
//   home dir otherwise picks up ~/.claude/CLAUDE.md and ~/CLAUDE.md as project
//   instructions, even with its own config dir.
// - Tools are explicit per role (an untrusted workspace ignores permissions.allow).
// - foreman.json's role deny rules ("agent" and the role's own, D0019) are added to
//   --disallowedTools, so the session can't drop them.
// - Turns, budget and a wall-clock timeout that kills the whole process group.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolvePolicy } from "./roles";
import { repoRoot } from "./store";

export type Role = "worker" | "verifier" | "intake";

export interface LaunchOptions {
  role: Role;
  taskId?: string;
  /** Where the session runs (a worktree, or the repo for intake). */
  cwd: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Replaces the role's default tool list. */
  allowedTools?: string[];
  /** Structured output: the session must answer with JSON matching this schema. */
  jsonSchema?: object;
  /** MCP servers for the session ({ mcpServers: ... }); with it, the project's .mcp.json is not loaded. */
  mcpConfig?: object;
  /** Isolated CLAUDE_CONFIG_DIR. Default: <main checkout>/.foreman/claude-config. */
  configDir?: string;
  /** The repository whose ancestors are scanned for CLAUDE.md. Default: git toplevel of cwd. */
  repoRoot?: string;
  /**
   * Where foreman.json's role rules are read. Default: the main checkout of cwd (the
   * file foreman itself reads), or repoRoot outside a git repository.
   */
  policyRoot?: string;
  /** Environment to inherit. Default: process.env. */
  baseEnv?: Record<string, string | undefined>;
}

export interface LaunchSpec {
  cmd: string[];
  env: Record<string, string>;
}

const READ = ["Read", "Glob", "Grep"];
const EDIT = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const fm = (...names: string[]) => names.map((n) => `mcp__foreman__${n}`);

/**
 * Tools each role may use unless allowedTools overrides, and tools it must never get.
 * Foreman tools are listed one by one, so a worker can't verify, merge or rework.
 */
export const ROLE_TOOLS: Record<Role, { allowed: string[]; disallowed: string[] }> = {
  worker: {
    allowed: [
      ...READ, ...EDIT, "Bash", "Agent", "Skill", "TodoWrite",
      ...fm("list_tasks", "next_tasks", "show_task", "create_task", "claim_task", "heartbeat", "report_progress", "submit_task", "reserve_number", "edit_task"),
    ],
    disallowed: fm("start_verify", "record_verdict", "mark_merged", "rework_task"),
  },
  verifier: {
    allowed: [...READ, "Bash", "Skill", "TodoWrite", ...fm("show_task", "list_tasks", "start_verify", "record_verdict", "heartbeat")],
    disallowed: [...EDIT],
  },
  intake: {
    allowed: [...READ, ...fm("list_tasks", "show_task", "create_task")],
    disallowed: [
      ...EDIT, "Bash",
      ...fm("next_tasks", "claim_task", "heartbeat", "report_progress", "submit_task", "start_verify",
        "record_verdict", "mark_merged", "reserve_number", "edit_task", "rework_task"),
    ],
  },
};

export const ROLE_LIMITS: Record<Role, { maxTurns: number; maxBudgetUsd: number; timeoutMs: number }> = {
  worker: { maxTurns: 200, maxBudgetUsd: 10, timeoutMs: 2 * 60 * 60_000 },
  verifier: { maxTurns: 100, maxBudgetUsd: 5, timeoutMs: 60 * 60_000 },
  intake: { maxTurns: 30, maxBudgetUsd: 1, timeoutMs: 10 * 60_000 },
};

/** Set by a parent Claude Code session; a child that inherits them thinks it is nested. */
export const STRIPPED_ENV = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"];

const MEMORY_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];

/**
 * Every CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md in a directory strictly
 * above `root`, plus a glob for each such directory's .claude/rules/ (rules load as memory too).
 */
export function ancestorClaudeMds(root: string): string[] {
  const found: string[] = [];
  let dir = resolve(root);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    for (const f of MEMORY_FILES) {
      const p = join(dir, f);
      if (existsSync(p)) found.push(p);
    }
    const rules = join(dir, ".claude", "rules");
    if (existsSync(rules)) found.push(join(rules, "**"));
  }
  return found;
}

function gitToplevel(cwd: string): string {
  const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : resolve(cwd);
}

function mainCheckout(cwd: string): string | null {
  try {
    return repoRoot(cwd);
  } catch {
    return null; // not a git repository
  }
}

/** The default isolated config dir: <main checkout>/.foreman/claude-config. */
export function defaultConfigDir(cwd = process.cwd()): string {
  return join(repoRoot(cwd), ".foreman", "claude-config");
}

export function actorFor(role: Role, taskId?: string): string {
  return taskId ? `${role}-${taskId}` : role;
}

/** The command and environment for a session. Spawns nothing; reads only the filesystem. */
export function buildLaunch(opts: LaunchOptions): LaunchSpec {
  const limits = ROLE_LIMITS[opts.role];
  const tools = ROLE_TOOLS[opts.role];
  const root = opts.repoRoot ?? gitToplevel(opts.cwd);
  const actor = actorFor(opts.role, opts.taskId);
  // A malformed roles block throws here: no session starts without its limits.
  const roleRules = resolvePolicy(opts.policyRoot ?? mainCheckout(opts.cwd) ?? root, actor).rules.map((r) => r.rule);
  const disallowed = [...new Set([...tools.disallowed, ...roleRules])];
  const allowed = (opts.allowedTools ?? tools.allowed).filter((t) => !disallowed.includes(t));
  const settings = { claudeMdExcludes: ancestorClaudeMds(root) };

  const cmd = [
    "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(opts.maxTurns ?? limits.maxTurns),
    "--max-budget-usd", String(opts.maxBudgetUsd ?? limits.maxBudgetUsd),
    "--settings", JSON.stringify(settings),
    "--allowedTools", allowed.join(","),
  ];
  if (disallowed.length) cmd.push("--disallowedTools", disallowed.join(","));
  if (opts.model) cmd.push("--model", opts.model);
  if (opts.jsonSchema) cmd.push("--json-schema", JSON.stringify(opts.jsonSchema));
  if (opts.mcpConfig) cmd.push("--mcp-config", JSON.stringify(opts.mcpConfig), "--strict-mcp-config");
  // After "--", so a prompt starting with "-" is never read as a flag.
  cmd.push("--", opts.prompt);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = opts.configDir ?? defaultConfigDir(opts.cwd);
  env.FOREMAN_ACTOR = actor;
  return { cmd, env };
}

/**
 * Create the isolated config dir with one symlink, .credentials.json -> the
 * person's login. Never copies the credentials. A link that points elsewhere,
 * or a file left in its place, is replaced by the link.
 */
export function ensureConfigDir(
  dir?: string,
  credentials = join(homedir(), ".claude", ".credentials.json"),
): string {
  const target = dir ?? defaultConfigDir();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const link = join(target, ".credentials.json");
  const linked = () => {
    try {
      return lstatSync(link).isSymbolicLink() && readlinkSync(link) === credentials;
    } catch {
      return false;
    }
  };
  if (linked()) return target;
  try {
    unlinkSync(link);
  } catch {
    // no link yet
  }
  try {
    symlinkSync(credentials, link);
  } catch (e) {
    // Another foreman process made it first: fine if it is the right link.
    if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !linked()) throw e;
  }
  return target;
}

/** True when the config dir's .credentials.json is still a symlink (not a file Claude Code wrote in its place). */
export function credentialsLinkIntact(dir: string): boolean {
  try {
    return lstatSync(join(dir, ".credentials.json")).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Env vars that log Claude Code in without the credentials file. */
export const LOGIN_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** What one session's stream-json output adds up to. */
export interface StreamSummary {
  result: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  sessionId: string;
  isError: boolean;
  subtype?: string;
}

/** Parses stream-json output line by line, in chunks of any size. */
export class StreamParser {
  private buf = "";
  // isError stays true until a result event says otherwise: no result means the session crashed.
  readonly summary: StreamSummary = { result: "", costUsd: 0, turns: 0, sessionId: "", isError: true };

  push(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  end(): StreamSummary {
    if (this.buf) this.line(this.buf);
    this.buf = "";
    return this.summary;
  }

  private line(raw: string) {
    const text = raw.trim();
    if (!text) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text);
    } catch {
      return; // not an event (e.g. a stray log line)
    }
    const s = this.summary;
    if (typeof ev.session_id === "string" && !s.sessionId) s.sessionId = ev.session_id;
    if (ev.type === "assistant") s.turns++;
    if (ev.type === "result") {
      s.result = typeof ev.result === "string" ? ev.result : "";
      if (ev.structured_output !== undefined) s.structured = ev.structured_output;
      if (typeof ev.total_cost_usd === "number") s.costUsd = ev.total_cost_usd;
      if (typeof ev.num_turns === "number") s.turns = ev.num_turns;
      if (typeof ev.session_id === "string") s.sessionId = ev.session_id;
      s.isError = ev.is_error === true;
      if (typeof ev.subtype === "string") s.subtype = ev.subtype;
    }
  }
}

export function parseStream(text: string): StreamSummary {
  const p = new StreamParser();
  p.push(text);
  return p.end();
}

/** A started process, as launch() needs it. */
export interface Child {
  pid: number;
  stdout: AsyncIterable<Uint8Array | string>;
  exited: Promise<number | null>;
  /** Signal the child's whole process group. */
  killGroup(signal: NodeJS.Signals): void;
  /** Stop reading stdout (a process that escaped the group may still hold it open). */
  closeStdout?(): void;
}

export type Spawner = (cmd: string[], o: { cwd: string; env: Record<string, string> }) => Child;

/** Spawns in a new process group (detached), so a timeout can kill everything the session started. */
export const defaultSpawner: Spawner = (cmd, { cwd, env }) => {
  const [file, ...args] = cmd;
  if (!file) throw new Error("empty command");
  const child = nodeSpawn(file, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "inherit"] });
  // Listen before anything can throw: an unheard "error" event (e.g. ENOENT) would crash the process.
  const exited = new Promise<number | null>((res, rej) => {
    child.on("error", rej);
    child.on("close", (code, signal) => res(code ?? (signal ? null : 0)));
  });
  exited.catch(() => {});
  const pid = child.pid;
  if (pid === undefined) {
    return {
      pid: -1,
      stdout: (async function* () {})(),
      exited,
      killGroup() {},
    };
  }
  return {
    pid,
    stdout: child.stdout!,
    exited,
    killGroup(signal) {
      try {
        process.kill(-pid, signal);
      } catch {
        // already gone
      }
    },
    closeStdout() {
      child.stdout?.destroy();
    },
  };
};

/** Sessions still running, so they don't outlive foreman when it exits or is interrupted. */
const live = new Set<Child>();
let cleanupInstalled = false;
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const killAll = () => {
    for (const c of live) c.killGroup("SIGKILL");
  };
  process.on("exit", killAll);
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(code);
    });
  }
}

export interface LaunchResult extends StreamSummary {
  /** null when the process was killed by a signal. */
  exitCode: number | null;
  pid: number;
  timedOut: boolean;
  /** Things the caller should know, e.g. the credentials link was replaced by a file. */
  warnings: string[];
}

/** Start a session, wait for it, and return what its stream said. */
export async function launch(
  opts: LaunchOptions & { spawner?: Spawner; killGraceMs?: number; credentials?: string },
): Promise<LaunchResult> {
  const credentials = opts.credentials ?? join(homedir(), ".claude", ".credentials.json");
  const inherited = opts.baseEnv ?? process.env;
  if (!existsSync(credentials) && !LOGIN_ENV.some((k) => inherited[k])) {
    throw new Error(
      `no Claude Code login at ${credentials} (a login kept only in an OS keychain can't be shared): ` +
        `log in with \`claude\`, or set ${LOGIN_ENV.join(" or ")}`,
    );
  }
  const configDir = ensureConfigDir(opts.configDir ?? defaultConfigDir(opts.cwd), credentials);
  const { cmd, env } = buildLaunch({ ...opts, configDir });
  const child = (opts.spawner ?? defaultSpawner)(cmd, { cwd: opts.cwd, env });
  installCleanup();
  live.add(child);
  const timeoutMs = opts.timeoutMs ?? ROLE_LIMITS[opts.role].timeoutMs;
  let timedOut = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.killGroup("SIGTERM");
    hardKill = setTimeout(() => {
      child.killGroup("SIGKILL");
      child.closeStdout?.();
    }, opts.killGraceMs ?? 5_000);
  }, timeoutMs);

  const parser = new StreamParser();
  const decoder = new TextDecoder();
  try {
    try {
      for await (const chunk of child.stdout) parser.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    } catch (e) {
      if (!timedOut) throw e; // a stream destroyed after the timeout ends the read early
    }
    parser.push(decoder.decode());
    const exitCode = await child.exited;
    const warnings: string[] = [];
    if (!credentialsLinkIntact(configDir)) {
      warnings.push(
        `${join(configDir, ".credentials.json")} is no longer a symlink (Claude Code may have saved a refreshed login there); ` +
          "check that the login still works before the next launch",
      );
    }
    return { ...parser.end(), exitCode, pid: child.pid, timedOut, warnings };
  } finally {
    clearTimeout(timer);
    if (hardKill) clearTimeout(hardKill);
    live.delete(child);
    // A session's leftovers (background shells, MCP servers) go with it.
    child.killGroup(timedOut ? "SIGKILL" : "SIGTERM");
  }
}
