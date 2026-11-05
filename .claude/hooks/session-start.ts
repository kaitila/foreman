// SessionStart hook: hands the session the task its FOREMAN_ACTOR holds.
// Prints hookSpecificOutput.additionalContext. Prints nothing and exits 0 when there is no actor,
// no task, no foreman, or anything goes wrong: a missing task must never stop a session.
import { dirname, resolve } from "node:path";

type Check = { id: string; kind: string; text: string };
type Task = {
  id: string;
  title: string;
  spec?: string;
  acceptance?: Check[];
  paths?: string[];
  branch?: string | null;
  worktree?: string | null;
};

export function render(tasks: Task[]): string {
  return tasks
    .map((t) =>
      [
        `# Your foreman task: ${t.id}. ${t.title}`,
        t.spec ? `\n## Spec\n${t.spec}` : "",
        `\n## Acceptance checks`,
        ...(t.acceptance ?? []).map((c) => `- ${c.id} (${c.kind}): ${c.text}`),
        `\n## Paths you may edit\n${(t.paths ?? []).length ? t.paths!.map((p) => `- ${p}`).join("\n") : "- (any)"}`,
        t.branch ? `\nBranch: ${t.branch}` : "",
        t.worktree ? `Worktree: ${t.worktree}` : "",
      ]
        .filter((x) => x !== "")
        .join("\n"),
    )
    .join("\n\n---\n\n");
}

/**
 * foreman from $FOREMAN_BIN, the PATH, this repo's own copy, or the project's installed
 * package (node_modules/.bin isn't on a session's PATH). The package's own file, not its
 * .bin link: any dependency can ship a bin named foreman. Each is looked for in this checkout,
 * then in the main checkout, since a fresh worktree has no node_modules yet.
 */
function foremanCmd(root: string): string[] | null {
  if (process.env.FOREMAN_BIN) return process.env.FOREMAN_BIN.split(" ");
  if (Bun.which("foreman")) return ["foreman"];
  const roots = [root];
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdout: "pipe", stderr: "ignore", timeout: 5000 });
  if (common.exitCode === 0) {
    const main = dirname(common.stdout.toString().trim());
    if (main !== root) roots.push(main);
  }
  for (const dir of roots) {
    for (const rel of ["packages/foreman/src/cli.ts", "node_modules/@meta-repo/foreman/src/cli.ts"]) {
      const local = resolve(dir, rel);
      if (Bun.file(local).size) return ["bun", local];
    }
  }
  return null;
}

/** The additionalContext to inject, or null for "say nothing". */
export function context(root: string): string | null {
  if (!process.env.FOREMAN_ACTOR) return null;
  const fm = foremanCmd(root);
  if (!fm) return null;
  const p = Bun.spawnSync([...fm, "list", "--mine", "--status", "claimed", "--status", "in_progress", "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: 8000,
  });
  if (p.exitCode !== 0) return null;
  const tasks = JSON.parse(p.stdout.toString()) as Task[];
  return Array.isArray(tasks) && tasks.length ? render(tasks) : null;
}

if (import.meta.main) {
  try {
    let cwd = process.cwd();
    try {
      cwd = JSON.parse(await Bun.stdin.text()).cwd || cwd;
    } catch {}
    const root = process.env.CLAUDE_PROJECT_DIR || cwd;
    const text = context(root);
    if (text) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
    }
  } catch {}
  process.exit(0);
}
