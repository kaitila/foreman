#!/usr/bin/env bun
// Live test of foreman's background launch (D0022, R5.3b) against real Claude Code.
// `claude --bg` refuses an untrusted workspace, and a scratch repo must not be trusted
// in the person's own ~/.claude by a test. So this builds a stand-in config dir laid out
// like ~/.claude, with a marker in every user-level place Claude Code reads:
//   CLAUDE.md, rules/, auto memory, a skill, an agent, a command, SessionStart,
//   UserPromptSubmit and PreToolUse hooks, a user and a local-scope MCP server,
// plus the scratch repo's trust and a link to the real login (so claude.ai connectors
// come from the real account). Above the repo: a CLAUDE.md and .claude/rules/. In it:
// a CLAUDE.md marker, a skill, and a PreToolUse hook that records $FOREMAN_ACTOR.
//   1. control: a plain `claude --bg` there must see the user-level markers;
//   2. adapter: a verifier started by launch() in background mode must see only the
//      project's, run only the project's hook (with FOREMAN_ACTOR set), start only the
//      MCP server foreman passes, get no claude.ai connectors, appear in that config
//      dir's `claude agents`, and be stopped at the end.
// LIVE_CONFIG_DIR=~/.claude runs the adapter half against a real config dir instead
// (its owner must have trusted the scratch dir: the repo path is printed first).
// Needs a logged-in `claude`; about $0.05 with Haiku. Not run in CI. Exit 0 = all held.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBgCli, launch, STRIPPED_ENV, summarizeTranscript, transcriptPath } from "../src/launch";

const model = process.env.LIVE_TEST_MODEL ?? "claude-haiku-5-5";
const credentials = join(homedir(), ".claude", ".credentials.json");
const dir = mkdtempSync(join(tmpdir(), "foreman-live-bg-"));
const realConfig = process.env.LIVE_CONFIG_DIR;
const cfg = realConfig ?? join(dir, "config");
const repo = join(dir, "anc", "work", "demo");
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
const M = {
  global: `ZQX-GLOBAL-${tag}`,
  userRules: `ZQX-USERRULES-${tag}`,
  autoMem: `ZQX-AUTOMEM-${tag}`,
  userSkill: `ZQX-USERSKILL-${tag}`,
  userAgent: `ZQX-USERAGENT-${tag}`,
  userCmd: `ZQX-USERCMD-${tag}`,
  hook: `ZQX-HOOK-${tag}`,
  ancestor: `ZQX-ANCESTOR-${tag}`,
  ancestorRules: `ZQX-ANCRULES-${tag}`,
  project: `ZQX-PROJECT-${tag}`,
  projectSkill: `ZQX-PROJSKILL-${tag}`,
};
const ran = (what: string) => join(dir, `${what}-ran`);
const canary = join(import.meta.dir, "mcp-canary.ts");

let failed = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

const prompt = [
  "This is an authorised configuration test in a scratch repository. First read README.md with the Read tool.",
  'Then reply with one JSON object and nothing else, with keys "tokens" (every token of the form ZQX-<WORD>-<CODE>',
  "anywhere in your instructions, memory files, rules, skill or agent descriptions, hook output or other context, not",
  'counting this description of the pattern), "mcpTools" (the name of every tool you have or that is listed as deferred',
  'whose name starts with "mcp__"), "skills" (every skill listed as available) and "agentTypes" (every subagent type).',
].join(" ");

interface Seen {
  tokens: string[];
  mcpTools: string[];
  skills: string[];
  agentTypes: string[];
  /** From the transcript's own attachments, not the model's word. */
  instructionFiles: string[];
  listedSkills: string;
  deferredTools: string[];
}

/** What a session saw: its JSON answer plus the transcript's attachments. */
function seen(sessionId: string, answer: string): Seen {
  let a: Partial<Seen> = {};
  try {
    a = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
  } catch {
    console.log(`(answer was not JSON: ${answer.slice(0, 200)})`);
  }
  const s: Seen = { tokens: a.tokens ?? [], mcpTools: a.mcpTools ?? [], skills: a.skills ?? [], agentTypes: a.agentTypes ?? [], instructionFiles: [], listedSkills: "", deferredTools: [] };
  const p = transcriptPath(cfg, repo, sessionId);
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  for (const raw of text.split("\n")) {
    try {
      const at = (JSON.parse(raw) as { attachment?: { type?: string; files?: { path: string }[]; content?: string; addedNames?: string[] } }).attachment;
      if (at?.type === "instructions") s.instructionFiles.push(...(at.files ?? []).map((f) => f.path));
      if (at?.type === "skill_listing") s.listedSkills += at.content ?? "";
      if (at?.type === "deferred_tools_delta") s.deferredTools.push(...(at.addedNames ?? []));
    } catch {
      // not an attachment
    }
  }
  return s;
}
const has = (s: Seen, marker: string) => s.tokens.some((t) => t.includes(marker)) || s.listedSkills.includes(marker);
const mcpServers = (s: Seen) => [...new Set([...s.mcpTools, ...s.deferredTools].filter((t) => t.startsWith("mcp__")).map((t) => t.split("__")[1] ?? ""))];

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
env.CLAUDE_CONFIG_DIR = cfg;
const cli = defaultBgCli(cfg);
const started: string[] = [];

let cost = 0;
try {
  if (!existsSync(credentials)) throw new Error(`no login at ${credentials}: log in with \`claude\` first`);
  mkdirSync(join(repo, ".claude", "skills", "zqx-proj-skill"), { recursive: true });
  mkdirSync(join(dir, "anc", ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, "anc", "CLAUDE.md"), `# Ancestor\n\nThe ancestor code word is ${M.ancestor}.\n`);
  writeFileSync(join(dir, "anc", ".claude", "rules", "r.md"), `# Rule\n\nThe ancestor rule code word is ${M.ancestorRules}.\n`);
  writeFileSync(join(repo, "CLAUDE.md"), `# Demo project\n\nThe project code word is ${M.project}.\n`);
  writeFileSync(join(repo, "README.md"), "# Demo\n\nNothing to see here.\n");
  writeFileSync(join(repo, ".claude", "skills", "zqx-proj-skill", "SKILL.md"), `---\nname: zqx-proj-skill\ndescription: Project skill canary ${M.projectSkill}.\n---\nHi.\n`);
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `echo "actor=$FOREMAN_ACTOR" > ${ran("project-hook")}` }] }] } }),
  );
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);

  if (!realConfig) {
    const mem = join(cfg, "projects", repo.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    for (const d of ["rules", "skills/zqx-user-skill", "agents", "commands", mem]) mkdirSync(d.startsWith("/") ? d : join(cfg, d), { recursive: true });
    symlinkSync(credentials, join(cfg, ".credentials.json"));
    const server = (name: string) => ({ type: "stdio", command: "bun", args: [canary, name, ran(name)] });
    writeFileSync(
      join(cfg, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        mcpServers: { zqxuser: server("zqx_user_tool") },
        projects: { [repo]: { hasTrustDialogAccepted: true, mcpServers: { zqxlocal: server("zqx_local_tool") } } },
      }),
    );
    writeFileSync(join(cfg, "CLAUDE.md"), `# Global\n\nAlways mention the code word ${M.global}.\n`);
    writeFileSync(join(cfg, "rules", "u.md"), `# User rule\n\nThe user rule code word is ${M.userRules}.\n`);
    writeFileSync(join(mem, "MEMORY.md"), `# Memory\n\n- The auto-memory code word is ${M.autoMem}.\n`);
    writeFileSync(join(cfg, "skills", "zqx-user-skill", "SKILL.md"), `---\nname: zqx-user-skill\ndescription: User skill canary ${M.userSkill}.\n---\nHi.\n`);
    writeFileSync(join(cfg, "agents", "zqx-user-agent.md"), `---\nname: zqx-user-agent\ndescription: User agent canary ${M.userAgent}.\n---\nHi.\n`);
    writeFileSync(join(cfg, "commands", "zqx-user-cmd.md"), `---\ndescription: User command canary ${M.userCmd}\n---\nHi.\n`);
    const touch = (what: string) => [{ hooks: [{ type: "command", command: `touch ${ran(what)}` }] }];
    writeFileSync(
      join(cfg, "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: touch("user-sessionstart"),
          UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${ran("user-prompt-hook")}; echo 'Hook code word: ${M.hook}'` }] }],
          PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `touch ${ran("user-pretool")}` }] }],
        },
      }),
    );

    // 1. Control: a plain --bg session in this repo, on this config dir.
    const r = Bun.spawnSync(["claude", "--bg", "--name", `live control ${tag}`, "--model", model, "--allowedTools", "Read", "--", prompt], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const id = /backgrounded\s*·\s*([0-9a-f]+)/.exec(r.stdout.toString())?.[1];
    if (!id) throw new Error(`control didn't start: ${r.stderr.toString() || r.stdout.toString()}`);
    started.push(id);
    let entry: { sessionId?: string; status?: string | null } | undefined;
    for (let i = 0, idle = 0; i < 90 && idle < 2; i++) {
      await Bun.sleep(2000);
      entry = (await cli.agents()).find((e) => e.id === id);
      idle = entry?.status === "idle" ? idle + 1 : 0;
    }
    await cli.stop(id);
    const sid = entry?.sessionId ?? "";
    const tp = transcriptPath(cfg, repo, sid);
    const c = seen(sid, summarizeTranscript(existsSync(tp) ? readFileSync(tp, "utf8") : "").lastText);
    console.log(`control saw: tokens ${JSON.stringify(c.tokens)}; mcp servers ${JSON.stringify(mcpServers(c))}`);
    expect(has(c, M.global) && has(c, M.autoMem) && has(c, M.userSkill), "control: a plain --bg session sees the user CLAUDE.md, auto memory and skills");
    expect(existsSync(ran("user-prompt-hook")) && existsSync(ran("zqx_user_tool")), "control: the user hook runs and the user MCP server starts");
    expect(mcpServers(c).some((s) => s.startsWith("claude_ai_")), "control: the claude.ai connectors are there");
    for (const f of ["user-sessionstart", "user-prompt-hook", "user-pretool", "project-hook", "zqx_user_tool", "zqx_local_tool", "zqx_foreman_tool"]) rmSync(ran(f), { force: true });
  } else {
    console.log(`against ${cfg}: the scratch repo is ${repo}`);
  }

  // 2. A verifier started by the adapter, in background mode.
  const spawned: { pid: number; name?: string; id?: string }[] = [];
  const r = await launch({
    role: "verifier",
    taskId: "T-LIVE",
    cwd: repo,
    prompt,
    model,
    mode: "bg",
    maxTurns: 8,
    maxBudgetUsd: 0.5,
    timeoutMs: 240_000,
    mcpConfig: { mcpServers: { zqxforeman: { type: "stdio", command: "bun", args: [canary, "zqx_foreman_tool", ran("zqx_foreman_tool")] } } },
    allowedTools: ["Read", "mcp__zqxforeman__zqx_foreman_tool"],
    baseEnv: env,
    cli,
    fallbackToPrint: false,
    onSpawn: (pid, s) => spawned.push({ pid, ...s }),
  });
  if (r.session) started.push(r.session.id);
  cost += r.costUsd;
  const s = seen(r.sessionId, r.result);
  console.log(`adapter saw: tokens ${JSON.stringify(s.tokens)}; files ${JSON.stringify(s.instructionFiles)}; mcp servers ${JSON.stringify(mcpServers(s))}`);
  console.log(`adapter: session "${r.session?.name}" (${r.session?.id}), ${r.turns} turns, ~$${r.costUsd.toFixed(3)}, ${r.isError ? `error: ${r.result}` : "ok"}`);
  expect(!r.isError && !r.timedOut, "adapter: the session's turn ends without a limit being hit");
  expect(spawned.length === 1 && spawned[0]!.pid > 0 && spawned[0]!.name === r.session?.name, "adapter: onSpawn gets the session's PID and name");
  const listed = (await cli.agents()).find((e) => e.id === r.session?.id);
  expect(listed?.name === r.session?.name && listed?.kind === "background", "adapter: the session is in that config dir's `claude agents`");
  expect(listed?.status === null || listed?.status === undefined, "adapter: foreman stopped it when its turn ended");
  expect(has(s, M.project) && s.instructionFiles.includes(join(repo, "CLAUDE.md")), "adapter: the session sees the repo's own CLAUDE.md");
  expect(s.instructionFiles.every((f) => f === join(repo, "CLAUDE.md")), "adapter: it loaded no other memory file (transcript)");
  if (!realConfig) {
    expect(!has(s, M.global) && !has(s, M.userRules), "adapter: no user CLAUDE.md or rules");
    expect(!has(s, M.autoMem), "adapter: no auto memory");
    expect(!has(s, M.userSkill) && !has(s, M.userCmd) && !s.agentTypes.includes("zqx-user-agent"), "adapter: no user skills, commands or agents");
    expect(!has(s, M.hook) && !existsSync(ran("user-prompt-hook")) && !existsSync(ran("user-sessionstart")) && !existsSync(ran("user-pretool")), "adapter: no user hook runs");
    expect(!existsSync(ran("zqx_user_tool")) && !existsSync(ran("zqx_local_tool")), "adapter: no user or local MCP server starts");
  }
  expect(!has(s, M.ancestor) && !has(s, M.ancestorRules), "adapter: no CLAUDE.md or rules from above the repo");
  expect(has(s, M.projectSkill), "adapter: the project's skill is there");
  expect(!mcpServers(s).some((x) => x.startsWith("claude_ai_")), "adapter: no claude.ai connectors");
  expect(existsSync(ran("zqx_foreman_tool")), "adapter: the MCP server foreman passes starts");
  const hook = existsSync(ran("project-hook")) ? readFileSync(ran("project-hook"), "utf8").trim() : "";
  expect(hook === "actor=verifier-T-LIVE", `adapter: the project's hook runs and sees FOREMAN_ACTOR (${hook || "did not run"})`);
  console.log(`(adapter ~$${cost.toFixed(3)}, ${model})`);
} finally {
  for (const id of started) {
    await cli.stop(id).catch(() => {});
    Bun.spawnSync(["claude", "rm", id], { env, stdout: "ignore", stderr: "ignore" });
  }
  if (!realConfig) {
    // The stand-in's background service goes with it.
    try {
      const pid = JSON.parse(readFileSync(join(cfg, "daemon.status.json"), "utf8")).supervisorPid as number;
      if (pid > 0) process.kill(pid);
    } catch {
      // none started
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
