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
// - MCP servers come only from the project's .mcp.json (--strict-mcp-config): no user
//   servers, no claude.ai connectors (R5.3b).
// Background mode (D0022): workers and verifiers can instead run as `claude --bg`
// sessions on the person's own config dir, visible in `claude agents`. Isolation then
// comes from flags (--setting-sources project,local, --strict-mcp-config, auto memory
// off), foreman's environment goes in through --settings env, and foreman enforces
// turns, budget and time itself from the transcript (see launchBg).
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { resolvePolicy } from "./roles";
import { repoRoot } from "./store";

export type Role = "worker" | "verifier" | "intake";

/** "print": `claude -p` under a foreman-owned config dir (D0011). "bg": `claude --bg` on the person's (D0022). */
export type LaunchMode = "print" | "bg";

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
  /** Default "print". A jsonSchema forces "print": --json-schema works only there. */
  mode?: LaunchMode;
  /** Background mode: the name in `claude agents`. Default: "<repo> <task> <role>". */
  sessionName?: string;
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
export const STRIPPED_ENV = [
  "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  // Set inside a background session; a launch from one would be taken for part of it.
  "CLAUDE_JOB_DIR", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ATTENDED",
];

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

const CLI = join(import.meta.dir, "cli.ts");

/**
 * The MCP servers a session gets: those in the project's .mcp.json (read from `root`,
 * the main checkout), or foreman's own server when the project has none. Passed with
 * --strict-mcp-config, so user servers and claude.ai connectors stay out (R5.3b).
 */
export function projectMcpConfig(root: string): { mcpServers: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
    if (parsed.mcpServers && typeof parsed.mcpServers === "object" && Object.keys(parsed.mcpServers).length) {
      return { mcpServers: parsed.mcpServers };
    }
  } catch {
    // no .mcp.json, or not JSON: foreman's own server
  }
  return { mcpServers: { foreman: { type: "stdio", command: "bun", args: [CLI, "mcp"] } } };
}

/** "<repo> <task> <role>", the name a background session shows in `claude agents`. */
export function sessionNameFor(repo: string, role: Role, taskId?: string): string {
  return [basename(repo), taskId, role].filter(Boolean).join(" ");
}

/** The mode a launch runs in: print when asked, or when it needs structured output. */
export function modeOf(opts: Pick<LaunchOptions, "mode" | "jsonSchema">): LaunchMode {
  return opts.mode === "bg" && !opts.jsonSchema ? "bg" : "print";
}

/** The command and environment for a session. Spawns nothing; reads only the filesystem. */
export function buildLaunch(opts: LaunchOptions): LaunchSpec {
  const limits = ROLE_LIMITS[opts.role];
  const tools = ROLE_TOOLS[opts.role];
  const root = opts.repoRoot ?? gitToplevel(opts.cwd);
  const actor = actorFor(opts.role, opts.taskId);
  const policyRoot = opts.policyRoot ?? mainCheckout(opts.cwd) ?? root;
  // A malformed roles block throws here: no session starts without its limits.
  const roleRules = resolvePolicy(policyRoot, actor).rules.map((r) => r.rule);
  const disallowed = [...new Set([...tools.disallowed, ...roleRules])];
  const allowed = (opts.allowedTools ?? tools.allowed).filter((t) => !disallowed.includes(t));
  const mcp = opts.mcpConfig ?? projectMcpConfig(policyRoot);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  }
  env.FOREMAN_ACTOR = actor;

  const tail: string[] = ["--allowedTools", allowed.join(",")];
  if (disallowed.length) tail.push("--disallowedTools", disallowed.join(","));
  if (opts.model) tail.push("--model", opts.model);

  if (modeOf(opts) === "bg") {
    // A --bg session runs under Claude Code's background service and doesn't inherit
    // this environment: foreman's variables go in through settings, which reach the
    // session, its Bash and its hooks (R5.3b). Auto memory is the person's: keep it out.
    const foremanEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("FOREMAN_")));
    const settings = { claudeMdExcludes: ancestorClaudeMds(root), autoMemoryEnabled: false, env: foremanEnv };
    const cmd = [
      "claude", "--bg",
      "--name", opts.sessionName ?? sessionNameFor(policyRoot, opts.role, opts.taskId),
      "--setting-sources", "project,local",
      "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
      "--settings", JSON.stringify(settings),
      "--permission-mode", "dontAsk",
      ...tail,
      "--", opts.prompt,
    ];
    // The person's own config dir (D0022): that is where `claude agents` looks.
    return { cmd, env };
  }

  const settings = { claudeMdExcludes: ancestorClaudeMds(root) };
  const cmd = [
    "claude", "-p",
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(opts.maxTurns ?? limits.maxTurns),
    "--max-budget-usd", String(opts.maxBudgetUsd ?? limits.maxBudgetUsd),
    "--settings", JSON.stringify(settings),
    ...tail,
  ];
  if (opts.jsonSchema) cmd.push("--json-schema", JSON.stringify(opts.jsonSchema));
  cmd.push("--mcp-config", JSON.stringify(mcp), "--strict-mcp-config");
  // After "--", so a prompt starting with "-" is never read as a flag.
  cmd.push("--", opts.prompt);
  env.CLAUDE_CONFIG_DIR = opts.configDir ?? defaultConfigDir(opts.cwd);
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
  /** null when the process was killed by a signal, or a background session was stopped over a limit. */
  exitCode: number | null;
  pid: number;
  timedOut: boolean;
  /** Things the caller should know, e.g. the credentials link was replaced by a file. */
  warnings: string[];
  /** Background mode: the session, still listed in `claude agents --all` after it was stopped. */
  session?: BgSession;
}

/** A background session as `claude agents` and the dispatcher name it. */
export interface BgSession {
  /** The short id `claude attach`, `logs` and `stop` take. */
  id: string;
  name: string;
  sessionId?: string;
}

export interface LaunchExtras {
  spawner?: Spawner;
  killGraceMs?: number;
  credentials?: string;
  /** Called once the session has a PID (and, in background mode, its id and name). */
  onSpawn?: (pid: number, session?: BgSession) => void;
  /** Background mode: how foreman talks to `claude`. Tests pass a fake. */
  cli?: BgCli;
  /** Background mode: how often to look at the session. Default 2 s. */
  pollMs?: number;
  /** Background mode: how long a session may wait at a permission prompt before it is stopped. Default 10 min. */
  waitingLimitMs?: number;
  /** Background mode: if `claude --bg` refuses (e.g. an untrusted workspace), run in print mode instead. Default true. */
  fallbackToPrint?: boolean;
}

/** Start a session, wait for it, and return what it said. */
export async function launch(opts: LaunchOptions & LaunchExtras): Promise<LaunchResult> {
  if (modeOf(opts) === "bg") {
    const r = await launchBg(opts);
    if (!("refused" in r)) return r;
    if (opts.fallbackToPrint === false) throw new Error(`claude --bg refused: ${r.refused}`);
    // `claude --bg` refused (e.g. an untrusted workspace): print mode, with the reason as a warning.
    const printed = await launch({ ...opts, mode: "print" });
    return { ...printed, warnings: [`ran in print mode because claude --bg refused: ${r.refused}`, ...printed.warnings] };
  }
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
  if (child.pid > 0) opts.onSpawn?.(child.pid);
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

// ---------------------------------------------------------------------------------
// Background mode (D0022, R5.3b)

/** One entry of `claude agents --json --all`. */
export interface AgentEntry {
  id?: string;
  sessionId?: string;
  name?: string;
  pid?: number | null;
  cwd?: string;
  kind?: string;
  /** busy, idle (turn over), waiting (at a permission prompt), null (stopped). */
  status?: string | null;
  /** The session's own label: working, done, blocked. */
  state?: string;
}

/** How foreman talks to `claude` about background sessions. Tests pass a fake. */
export interface BgCli {
  /** Run `claude --bg ...`; it returns at once with the session's short id on stdout. */
  start(cmd: string[], o: { cwd: string; env: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** `claude agents --json --all`. */
  agents(): Promise<AgentEntry[]>;
  /** `claude stop <id>`. */
  stop(id: string): Promise<void>;
  /** The same, for an exiting process that can't wait. */
  stopSync(id: string): void;
  /** Claude Code's config dir, which holds jobs/ and projects/. */
  configDir: string;
}

async function runCmd(cmd: string[], o: { cwd?: string; env?: Record<string, string> } = {}) {
  const p = Bun.spawn(cmd, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** The caller's env minus a parent session's variables, so `claude` doesn't think it is nested. */
function callerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  return env;
}

/**
 * The real `claude`. A config dir given here is passed on as CLAUDE_CONFIG_DIR (the live
 * test's stand-in); without one, nothing is set, because setting even the default
 * ~/.claude would move Claude Code's global config and its background service.
 */
export function defaultBgCli(configDir?: string): BgCli {
  const cleanEnv = () => (configDir ? { ...callerEnv(), CLAUDE_CONFIG_DIR: configDir } : callerEnv());
  return {
    configDir: configDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    start: (cmd, o) => runCmd(cmd, o),
    async agents() {
      const r = await runCmd(["claude", "agents", "--json", "--all"], { env: cleanEnv() });
      if (r.code !== 0) throw new Error(`claude agents --json failed: ${r.stderr.trim() || r.stdout.trim()}`);
      const list = JSON.parse(r.stdout) as unknown;
      return Array.isArray(list) ? (list as AgentEntry[]) : [];
    },
    async stop(id) {
      await runCmd(["claude", "stop", id], { env: cleanEnv() });
    },
    stopSync(id) {
      Bun.spawnSync(["claude", "stop", id], { env: cleanEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    },
  };
}

/** Dollars per million tokens. `--bg` reports no cost, so foreman estimates it (R5.3b). */
export const PRICES: { match: RegExp; input: number; output: number; cacheRead: number }[] = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /sonnet/, input: 2, output: 10, cacheRead: 0.2 },
  { match: /haiku/, input: 0.1, output: 0.5, cacheRead: 0.01 },
];
// An unknown model is priced like the dearest, so a budget errs on the safe side.
const UNKNOWN_PRICE = PRICES[0]!;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Estimated cost of one API response. A cache write costs 1.25x input for 5 minutes, 2x for an hour. */
export function costOf(model: string, u: Usage): number {
  const p = PRICES.find((x) => x.match.test(model)) ?? UNKNOWN_PRICE;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens;
  // Without the split, every write counts at the 1-hour rate, the one Claude Code uses.
  const writes = w5 !== undefined || w1h !== undefined ? (w5 ?? 0) * 1.25 + (w1h ?? 0) * 2 : (u.cache_creation_input_tokens ?? 0) * 2;
  const dollars =
    (u.input_tokens ?? 0) * p.input + (u.output_tokens ?? 0) * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + writes * p.input;
  return dollars / 1_000_000;
}

/** What a background session's transcript adds up to. */
export interface TranscriptSummary {
  /** API responses (assistant messages), each counted once. */
  turns: number;
  costUsd: number;
  /** The last assistant text. */
  lastText: string;
}

/**
 * Sum a transcript (`projects/<cwd>/<session>.jsonl`). Claude Code writes one line per
 * content block, each carrying its message's usage, so messages are counted by id.
 */
export function summarizeTranscript(text: string): TranscriptSummary {
  const usage = new Map<string, { model: string; usage: Usage }>();
  let lastText = "";
  let anon = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let ev: { type?: string; message?: { id?: string; model?: string; usage?: Usage; content?: unknown } };
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type !== "assistant" || !ev.message) continue;
    const m = ev.message;
    if (m.usage) usage.set(m.id ?? `anon-${anon++}`, { model: m.model ?? "", usage: m.usage });
    if (Array.isArray(m.content)) {
      for (const b of m.content as { type?: string; text?: string }[]) if (b.type === "text" && b.text) lastText = b.text;
    }
  }
  let costUsd = 0;
  for (const { model, usage: u } of usage.values()) costUsd += costOf(model, u);
  return { turns: usage.size, costUsd, lastText };
}

/** Where Claude Code keeps the transcript of a session started in `cwd`. */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** The last reply in a job's timeline (`jobs/<id>/timeline.jsonl`), if any. */
export function timelineText(configDir: string, id: string): string {
  let text = "";
  for (const raw of readText(join(configDir, "jobs", id, "timeline.jsonl")).split("\n")) {
    try {
      const ev = JSON.parse(raw) as { text?: string };
      if (ev.text) text = ev.text;
    } catch {
      // not a line
    }
  }
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a `claude --bg` session and watch it through `claude agents --json --all` and its
 * transcript until its turn ends, a limit is hit, or someone stops it. Then stop it: it
 * stays in `claude agents --all`, where it can be attached to or resumed.
 * Returns { refused } when `claude --bg` won't start a session.
 */
export async function launchBg(opts: LaunchOptions & LaunchExtras): Promise<LaunchResult | { refused: string }> {
  const cli = opts.cli ?? defaultBgCli();
  const limits = ROLE_LIMITS[opts.role];
  const maxTurns = opts.maxTurns ?? limits.maxTurns;
  const budget = opts.maxBudgetUsd ?? limits.maxBudgetUsd;
  const timeoutMs = opts.timeoutMs ?? limits.timeoutMs;
  const pollMs = opts.pollMs ?? 2_000;
  const waitingLimitMs = opts.waitingLimitMs ?? 10 * 60_000;
  const { cmd, env } = buildLaunch({ ...opts, mode: "bg" });
  const name = cmd[cmd.indexOf("--name") + 1]!;

  const started = await cli.start(cmd, { cwd: opts.cwd, env });
  const id = /backgrounded\s*·\s*([0-9a-f]{6,})/.exec(started.stdout)?.[1];
  if (started.code !== 0 || !id) {
    return { refused: (started.stderr.trim() || started.stdout.trim() || `exit ${started.code}`).split("\n")[0]! };
  }

  const session: BgSession = { id, name };
  let stopped = false;
  // In the set foreman stops on exit: a background session would otherwise outlive it.
  const handle: Child = {
    pid: -1,
    stdout: (async function* () {})(),
    exited: Promise.resolve(0),
    killGroup() {
      if (!stopped) cli.stopSync(id);
      stopped = true;
    },
  };
  installCleanup();
  live.add(handle);

  const t0 = Date.now();
  let pid = -1;
  let idleSeen = 0;
  let waitingSince: number | null = null;
  let sum: TranscriptSummary = { turns: 0, costUsd: 0, lastText: "" };
  let error: string | undefined;
  let subtype: string | undefined;
  let timedOut = false;
  let endedOutside = false;
  const warnings: string[] = [];
  const reread = () => {
    if (session.sessionId) sum = summarizeTranscript(readText(transcriptPath(cli.configDir, opts.cwd, session.sessionId)));
  };
  try {
    for (;;) {
      let entry: AgentEntry | undefined;
      let listed = true;
      try {
        entry = (await cli.agents()).find((e) => e.id === id || e.sessionId?.startsWith(id));
      } catch (e) {
        listed = false; // try again next time
        if (!warnings.includes((e as Error).message)) warnings.push((e as Error).message);
      }
      if (entry?.sessionId) session.sessionId = entry.sessionId;
      if (entry && typeof entry.pid === "number" && entry.pid > 0 && pid < 0) {
        pid = entry.pid;
        handle.pid = pid;
        opts.onSpawn?.(pid, { ...session });
      }
      reread();

      if (Date.now() - t0 > timeoutMs) {
        timedOut = true;
        error = "timed out";
        break;
      }
      if (sum.turns > maxTurns) {
        error = `over ${maxTurns} turns`;
        subtype = "error_max_turns";
        break;
      }
      if (sum.costUsd > budget) {
        error = `over the $${budget} budget (estimated $${sum.costUsd.toFixed(2)})`;
        subtype = "error_max_budget_usd";
        break;
      }
      // Stopped (status null) or removed by someone else, once it had started.
      if (listed && pid > 0 && (!entry || entry.status === null || entry.pid === null)) {
        endedOutside = true;
        break;
      }
      if (entry?.status === "waiting") {
        waitingSince ??= Date.now();
        if (Date.now() - waitingSince > waitingLimitMs) {
          error = "waited at a permission prompt with nobody to answer";
          break;
        }
      } else waitingSince = null;
      // Idle on two looks in a row, after at least one response: the turn is over.
      if (entry?.status === "idle" && sum.turns > 0) {
        if (++idleSeen >= 2) break;
      } else idleSeen = 0;
      await sleep(pollMs);
    }
  } finally {
    live.delete(handle);
    if (!stopped && !endedOutside) {
      stopped = true;
      await cli.stop(id).catch(() => {});
    }
  }
  reread();
  if (endedOutside) error = "the session was stopped outside foreman";
  // The transcript has the reply in full; the timeline's copy can be cut short or redacted.
  const result = sum.lastText || timelineText(cli.configDir, id);
  return {
    result: error && !result ? error : result,
    costUsd: sum.costUsd,
    turns: sum.turns,
    sessionId: session.sessionId ?? "",
    isError: error !== undefined,
    subtype: subtype ?? (error ? "error" : "success"),
    exitCode: error ? null : 0,
    pid,
    timedOut,
    warnings,
    session,
  };
}
