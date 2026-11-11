// The layout of `fm help`: the sections and the order of the commands in each. The lines
// themselves live with each command (its file's `help`), so changing one command's help
// doesn't touch this file.

const INTRO = `foreman: a task layer for AI coding agents in parallel git worktrees

Usage: fm <command> [args] [--json]`;

/** A section's title, then the help keys in order. */
const SECTIONS: [string, string[]][] = [
  ["Projects", ["setup", "create", "init", "add-piece", "sync"]],
  ["Tasks", ["add", "ready-up", "list", "next", "show", "logs", "edit", "rework", "cancel", "intake"]],
  ["Plans (ordered steps, each with a check; progress comes from the steps' tasks)", ["plan"]],
  ["Working (worker)", ["claim", "heartbeat", "progress", "submit"]],
  ["Verifying (anyone who didn't work on it)", ["verify", "verdict"]],
  ["Signing off", ["approve", "merged"]],
  ["Agents", ["dispatch", "dispatchers"]],
  ["Board", ["serve-short", "merge-queue", "janitor"]],
  ["Housekeeping", ["reclaim", "reserve", "policy", "export", "mcp", "serve", "projects"]],
];

/** Sections that follow the one before without an empty line. */
const NO_GAP = new Set(["Board"]);

const FOOTER = `Who you are: FOREMAN_ACTOR names you; CLAUDE_CODE_CHILD_SESSION=1 (a command Claude Code runs) or
FOREMAN_AGENT=1 marks you as an agent.
Risk: --risk is optional; by default a task is auto unless its paths touch foreman.json's protectedPaths.
State: <main checkout>/.foreman/foreman.db, or FOREMAN_DB.`;

export function renderHelp(lines: Record<string, string>): string {
  const out = [INTRO];
  for (const [title, keys] of SECTIONS) {
    if (!NO_GAP.has(title)) out.push("");
    out.push(title);
    for (const k of keys) {
      const text = lines[k];
      if (text === undefined) throw new Error(`fm help: no help for "${k}"`);
      out.push(text);
    }
  }
  out.push("", FOOTER);
  return out.join("\n");
}
