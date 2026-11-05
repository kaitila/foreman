// fm setup: check a machine for what foreman needs, link fm onto the PATH, and say how to fix the rest.
// Commands and files are read through `Env` so tests run it with fakes. It never edits ~/.claude.json.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
}
export interface Env {
  /** Run a command; null when it isn't installed. */
  run(cmd: string[], cwd?: string): RunResult | null;
  /** Path of an executable on the PATH, or null. */
  which(name: string): string | null;
  /** Text of a file, or null. */
  read(path: string): string | null;
  home: string;
  now: number;
  /** The repo to offer to trust (its root), or null outside one. */
  repo: string | null;
  /** foreman's package dir, where `bun link` runs. */
  foremanDir: string;
}

export interface Item {
  id: string;
  ok: boolean;
  detail: string;
  /** The exact command (or step) that fixes it; empty when ok. */
  fix: string;
}

export function realEnv(repo: string | null): Env {
  return {
    run(cmd, cwd) {
      try {
        const p = Bun.spawnSync(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        return { code: p.exitCode ?? 1, stdout: p.stdout.toString() + p.stderr.toString() };
      } catch {
        return null;
      }
    },
    which: (n) => Bun.which(n),
    read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    home: homedir(),
    now: Date.now(),
    repo,
    foremanDir: join(dirname(import.meta.path), ".."),
  };
}

const version = (env: Env, cmd: string[]) => {
  const r = env.run(cmd);
  return r && r.code === 0 ? (r.stdout.trim().split("\n")[0] ?? "") : null;
};

export function duration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)} days`;
}

export function checkMachine(env: Env, opts: { link?: boolean } = {}): Item[] {
  const items: Item[] = [];
  const add = (id: string, ok: boolean, detail: string, fix = "") => items.push({ id, ok, detail, fix: ok ? "" : fix });

  const bun = version(env, ["bun", "--version"]);
  add("bun", bun !== null, bun ? `bun ${bun}` : "not installed", "curl -fsSL https://bun.sh/install | bash");

  const git = version(env, ["git", "--version"]);
  add("git", git !== null, git ?? "not installed", "install git with your package manager (apt install git, brew install git)");

  const gh = version(env, ["gh", "--version"]);
  add("gh", gh !== null, gh ?? "not installed", "install the GitHub CLI: https://cli.github.com");
  if (gh !== null) {
    const a = env.run(["gh", "auth", "status"]);
    add("gh-login", a?.code === 0, a?.code === 0 ? "logged in" : "not logged in", "gh auth login");
  } else add("gh-login", false, "needs gh first", "gh auth login");

  const claude = version(env, ["claude", "--version"]);
  add("claude", claude !== null, claude ?? "not installed", "npm install -g @anthropic-ai/claude-code");
  const creds = env.read(join(env.home, ".claude", ".credentials.json"));
  let expiresAt: number | null = null;
  try {
    const v = creds ? JSON.parse(creds)?.claudeAiOauth?.expiresAt : null;
    expiresAt = typeof v === "number" ? v : null;
  } catch {}
  if (claude === null) add("claude-login", false, "needs claude first", "claude, then /login");
  else {
    const a = env.run(["claude", "auth", "status"]);
    // Older versions have no `auth status`: then the credentials file is the evidence.
    const loggedIn = a && a.code === 0 ? true : expiresAt !== null;
    let detail = loggedIn ? "signed in" : "not signed in";
    if (loggedIn && expiresAt !== null) {
      detail += expiresAt > env.now ? `, sign-in token has ${duration(expiresAt - env.now)} left (it renews itself while you use claude)` : ", sign-in token expired: run claude once to renew it";
    } else if (loggedIn) detail += ", time left unknown (no credentials file; the keychain is not read)";
    const expired = expiresAt !== null && expiresAt <= env.now;
    add("claude-login", loggedIn && !expired, detail, "claude, then /login");
  }

  let fm = env.which("fm");
  if (!fm && opts.link && bun) {
    env.run(["bun", "link"], env.foremanDir);
    fm = env.which("fm");
  }
  const bunBin = join(env.home, ".bun", "bin");
  add(
    "fm",
    fm !== null,
    fm ? `fm at ${fm}` : "fm is not on the PATH",
    `cd ${env.foremanDir} && bun link   (then make sure ${bunBin} is on your PATH)`,
  );

  if (env.repo) {
    const cfg = env.read(join(env.home, ".claude.json"));
    let trusted = false;
    try {
      trusted = JSON.parse(cfg ?? "{}")?.projects?.[env.repo]?.hasTrustDialogAccepted === true;
    } catch {}
    add("trust", trusted, trusted ? `Claude Code trusts ${env.repo}` : `Claude Code has not been told to trust ${env.repo}`, `cd ${env.repo} && claude   (accept the trust prompt, then exit)`);
  } else add("trust", true, "not inside a git repository: nothing to trust", "");
  return items;
}

export function formatItems(items: Item[]): string {
  const lines = items.map((i) => `${i.ok ? "ok     " : "MISSING"} ${i.id.padEnd(13)} ${i.detail}${i.fix ? `\n        fix: ${i.fix}` : ""}`);
  const bad = items.filter((i) => !i.ok).length;
  lines.push(bad ? `\n${bad} thing${bad === 1 ? "" : "s"} to fix.` : "\nAll set.");
  return lines.join("\n");
}
