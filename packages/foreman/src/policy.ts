// Which tasks need a person (D0008). A task is "auto" (merges once a fresh verifier
// passes it) unless it touches protected paths: the guardrails, CI and foreman itself.
// Agents must not approve changes to their own limits.
//
// The files the PR really changes decide, not what the task declared or which branch
// the worker reports: a passing verdict on an "auto" task is escalated to a person if
// the diff touches a protected path, or if it can't be worked out or is empty (fail
// closed). A GitHub PR's own file list is used when the task's PR is a GitHub URL.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Used when the repo has no foreman.json. */
export const DEFAULT_PROTECTED = [
  ".claude/**",
  "**/.claude/**",
  ".github/**",
  ".mcp.json",
  "foreman.json",
  // What defines the checks and the agents' instructions.
  "package.json",
  "**/package.json",
  "bun.lock",
  "**/tsconfig*.json",
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
];

export interface Policy {
  protectedPaths: string[];
  /** Files the task's PR (or, without a GitHub PR, its branch) changes; null if unknown. */
  changedFiles(task: { branch: string | null; pr: string | null }): string[] | null;
  /** A GitHub PR's head branch and commit, and GitHub's MERGEABLE/CONFLICTING/UNKNOWN; null if it can't be looked up. */
  prInfo?(pr: string): { head: string; headSha: string; mergeable?: string; isDraft?: boolean } | null;
  /** This repository on GitHub, as "owner/name" (from the origin remote); null if unknown. */
  originRepo?(): string | null;
}

/** "owner/name" from a GitHub PR URL. */
export function prRepo(pr: string): string | null {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+\/?$/.exec(pr);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** "owner/name" from a git remote URL (https or ssh). */
export function remoteRepo(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Where the numbers of a kind already in use are written down, so `reserve` hands out
 * the next one. `file`: the pattern runs over that file's text (multiline). `glob`: it
 * runs over the name of each file the glob matches. Paths are relative to the repo root;
 * the pattern's first capture group is the number.
 */
export type NumberSource = { file: string; pattern: string } | { glob: string; pattern: string };

/** Used for a kind foreman.json doesn't list. */
export const DEFAULT_NUMBERS: Record<string, NumberSource> = {
  decision: { glob: "docs/decisions/*", pattern: "^D(\\d+)" },
};

export interface Config {
  protectedPaths?: string[];
  numbers?: Record<string, NumberSource>;
  /** Shell command that prepares a fresh worktree (e.g. "bun install && bun install --cwd web"); the dispatcher runs it once per new worktree. */
  setup?: string;
  /** Deny rules per agent role; validated by roles.ts (D0019). */
  roles?: unknown;
}

/**
 * The repo's foreman.json, or {} without one. Read from the default branch
 * (origin/main, else origin/master) so a main checkout left on an old or detached
 * commit can't hand out wrong numbers or fall back to default protected paths; the
 * working tree's copy is used only when no such branch has the file. Throws if it isn't JSON.
 */
export function loadConfig(root: string | null, run: Run = defaultRun): Config {
  if (!root) return {};
  for (const ref of ["origin/main", "origin/master"]) {
    const text = run(["git", "show", `${ref}:foreman.json`], root);
    if (text) return JSON.parse(text) as Config;
  }
  const file = join(root, "foreman.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Config) : {};
}

export function loadProtected(root: string | null): string[] {
  const { protectedPaths } = loadConfig(root);
  // foreman.json guards itself, whatever it says.
  return protectedPaths ? [...new Set([...protectedPaths, "foreman.json"])] : DEFAULT_PROTECTED;
}

/** The highest number of `kind` already on disk (0 if none, or no source for the kind). Throws on a malformed entry or a missing `file`. */
export function highestOnDisk(root: string | null, kind: string): number {
  if (!root) return 0;
  const src = loadConfig(root).numbers?.[kind] ?? DEFAULT_NUMBERS[kind];
  if (!src) return 0;
  const where = `foreman.json numbers.${kind}`;
  const hasFile = "file" in src && typeof src.file === "string";
  const hasGlob = "glob" in src && typeof src.glob === "string";
  if (hasFile === hasGlob) throw new Error(`${where}: give exactly one of "file" or "glob"`);
  if (typeof src.pattern !== "string") throw new Error(`${where}: "pattern" must be a string`);
  let re: RegExp;
  try {
    re = new RegExp(src.pattern, "gm");
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
  // An empty alternative always matches, so the result's length counts the groups.
  if (new RegExp(`${src.pattern}|`).exec("")!.length < 2) throw new Error(`${where}: "pattern" needs a capture group`);
  let texts: string[];
  if ("file" in src) {
    // A missing file would read as "no numbers taken" and hand out one already in use,
    // so it's refused. (A glob that matches nothing is fine: an empty folder is real.)
    const f = join(root, src.file);
    if (!existsSync(f)) throw new Error(`${where}: file "${src.file}" doesn't exist`);
    try {
      texts = [readFileSync(f, "utf8")];
    } catch (e) {
      throw new Error(`${where}: can't read "${src.file}": ${(e as Error).message}`);
    }
  } else {
    texts = [...new Bun.Glob(src.glob).scanSync({ cwd: root })].map((p) => p.split("/").pop()!);
  }
  let max = 0;
  for (const t of texts) for (const m of t.matchAll(re)) if (m[1]) max = Math.max(max, Number(m[1]));
  return max;
}

export function isProtected(file: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((g) => new Bun.Glob(g).match(file));
}

/** The literal part of a glob before its first wildcard: "src/**" → "src/". */
const prefix = (g: string) => g.split(/[*?[{]/)[0]!;

/** Could some file match both globs? Errs towards yes. */
export function globsOverlap(p: string, q: string): boolean {
  const pp = prefix(p);
  const qp = prefix(q);
  if (new Bun.Glob(q).match(p) || new Bun.Glob(q).match(pp) || new Bun.Glob(p).match(qp)) return true;
  // Literal prefixes overlap ("packages/" vs "packages/foreman/src/"); an empty prefix
  // ("**/.claude/**") says nothing, the glob matches above handle it.
  return pp !== "" && qp !== "" && (pp.startsWith(qp) || qp.startsWith(pp));
}

/** Could a task with these declared paths touch a protected path? Errs towards yes. */
export function mayTouchProtected(paths: string[], protectedPaths: string[]): boolean {
  if (paths.length === 0) return false; // undeclared: the diff check at verdict time decides
  return paths.some((p) => protectedPaths.some((q) => globsOverlap(p, q)));
}

/**
 * Could two tasks edit the same file? A task that declares no paths could touch
 * anything, so it overlaps every task (the dispatcher keeps it apart from the rest).
 */
export function pathsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((p) => b.some((q) => globsOverlap(p, q)));
}

/** Runs a command: its trimmed stdout, or null if it failed. gh and git go through one, so tests need no network. */
export type Run = ((cmd: string[], cwd: string) => string | null) & {
  /** What the last failed call said on stderr, if the runner keeps it. */
  lastError?: string;
};

export const defaultRun: Run = (cmd, cwd) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    defaultRun.lastError = p.exitCode === 0 ? undefined : p.stderr.toString().trim();
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    defaultRun.lastError = undefined;
    return null; // e.g. gh not installed
  }
};

export const GITHUB_PR = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/;

export function gitPolicy(root: string | null, run: Run = defaultRun): Policy {
  const git = (r: string, args: string[]) => run(["git", ...args], r);
  return {
    protectedPaths: loadProtected(root),
    prInfo(pr) {
      if (!root || !GITHUB_PR.test(pr)) return null;
      const out = run(["gh", "pr", "view", pr, "--json", "headRefName,headRefOid,mergeable,isDraft"], root);
      if (out === null) return null;
      try {
        const j = JSON.parse(out) as { headRefName?: string; headRefOid?: string; mergeable?: string; isDraft?: boolean };
        return j.headRefName && j.headRefOid ? { head: j.headRefName, headSha: j.headRefOid, mergeable: j.mergeable, isDraft: j.isDraft } : null;
      } catch {
        return null;
      }
    },
    originRepo() {
      if (!root) return null;
      const url = git(root, ["remote", "get-url", "origin"]);
      return url ? remoteRepo(url) : null;
    },
    changedFiles({ branch, pr }) {
      if (!root) return null;
      // The PR is what gets merged: ask GitHub for its files. A worker can't steer this
      // by recording some other branch.
      if (pr && GITHUB_PR.test(pr)) {
        // The API lists a renamed file's old path too, so moving a protected file away counts.
        const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pr)!;
        const out = run(
          ["gh", "api", "--paginate", `repos/${m[1]}/${m[2]}/pulls/${m[3]}/files`, "--jq", ".[] | .filename, (.previous_filename // empty)"],
          root,
        );
        return out === null ? null : [...new Set(out.split("\n").filter(Boolean))];
      }
      // No GitHub PR (local-only workflows): fall back to the recorded branch. Weaker,
      // because the worker names the branch (D0008).
      if (!branch) return null;
      const ref = [branch, `origin/${branch}`].find((r) => git(root, ["rev-parse", "--verify", "--quiet", r]));
      if (!ref) return null;
      const base = ["origin/main", "main", "origin/master", "master"]
        .map((b) => git(root, ["merge-base", b, ref]))
        .find((x) => x);
      if (!base) return null;
      const out = git(root, ["diff", "--name-only", "--no-renames", base, ref]);
      return out === null ? null : out.split("\n").filter(Boolean);
    },
  };
}
