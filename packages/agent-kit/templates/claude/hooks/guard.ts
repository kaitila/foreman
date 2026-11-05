#!/usr/bin/env bun
// PreToolUse guard (agent-kit, D0007). Claude Code runs it before Bash, file edits
// and reads. Exit 2 blocks the call and shows the reason to the agent.
//
// What it blocks:
//   - git push to main/master, force-push (any spelling), --no-verify; git reset --hard
//   - recursive force rm in any spelling
//   - reading or writing .env files (not .env.example), also through `bash -c` and
//     inline scripts (`bun -e`, `node -e`, `python -c`, ...)
//   - edits outside the paths of the foreman task this agent has claimed, through the
//     edit tools or the shell (redirects, tee, cp, mv, install, touch, sed -i)
//   - what the agent's role may not do: the deny rules foreman resolves from foreman.json
//     "roles" for FOREMAN_ACTOR, matched against every command the shell would run
//
// The rules are a guardrail, not a security boundary: a script can still do what a
// rule names (see the README).
//
// It parses commands, so quoted text that only mentions `.env` is fine.
// It fails closed: a payload it can't read is blocked, and so is an edit whose task
// paths can't be checked because foreman is unreachable, and so is every call of an agent
// session (FOREMAN_ACTOR set) whose role rules foreman can't give.
// Self-contained on purpose: a project gets a copy, with no package to install.
import { relative, resolve, basename, isAbsolute } from "node:path";

export interface Decision {
  deny: string;
}

export interface Context {
  projectRoot: string;
  cwd: string;
  /** Current branch of the repo at `dir`, or null if unknown. */
  branchAt: (dir: string) => string | null;
  /**
   * Globs the agent's claimed tasks allow, or null when no task restricts paths.
   * Throws when it should know but can't (FOREMAN_ACTOR set, foreman unreachable).
   */
  taskPaths: () => string[] | null;
  /**
   * Deny rules for this session's role, from foreman.json "roles" through foreman; null
   * for a person's session (no FOREMAN_ACTOR). Throws when it should know but can't.
   */
  roleRules?: () => RoleRule[] | null;
}

/** A Claude Code permission rule (`Bash(ssh *)`, `Read(data/**)`, `mcp__deploy`) and the role block it came from. */
export interface RoleRule {
  rule: string;
  role: string;
}

const PROTECTED = new Set(["main", "master"]);
const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/;
const ENV_OK = /(^|\/)\.env\.(example|sample|template|dist)$/;
const INTERPRETERS = new Set(["bun", "node", "deno", "python", "python3", "perl", "ruby", "php"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const WRAPPERS = new Set(["sudo", "env", "command", "builtin", "nice", "nohup", "time", "timeout", "stdbuf", "xargs", "exec"]);
// Files a worker may always touch, whatever its task's paths say.
const ALWAYS_EDITABLE = ["docs/tasks/**"];

export const isEnvFile = (p: string) => ENV_FILE.test(p) && !ENV_OK.test(p);

// ---------- shell parsing (enough of it: words, quotes, separators, redirections) ----------

export interface SimpleCommand {
  words: string[]; // quotes removed; input-redirect targets included ("cat < .env" → cat .env)
  writes: string[]; // output-redirect targets ("echo x > out.txt" → out.txt)
  heredocs: string[]; // here-document bodies: data, unless the command is a shell
}

/** Split a command line into simple commands, each a list of words with quotes removed. */
export function parseShell(src: string): string[][] {
  return parseCommands(src).map((c) => c.words);
}

export function parseCommands(src: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word = "";
  let inWord = false;
  let redirectOut = false;
  let heredocs: string[] = [];
  // Here-documents declared on the current line: their bodies start after the newline.
  const pending: { delim: string; strip: boolean; quoted: boolean; into: string[] }[] = [];
  const endWord = () => {
    if (inWord) (redirectOut ? writes : words).push(word);
    if (inWord) redirectOut = false;
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length || writes.length || heredocs.length) commands.push({ words, writes, heredocs });
    words = [];
    writes = [];
    heredocs = [];
  };
  /** Read the bodies of pending here-documents starting at `from`; returns where parsing resumes. */
  const readBodies = (from: number): number => {
    let pos = from;
    for (const { delim, strip, quoted, into } of pending) {
      const lines: string[] = [];
      for (;;) {
        if (pos >= src.length) break; // unterminated: the rest is the body, as bash does
        const nl = src.indexOf("\n", pos);
        const end = nl < 0 ? src.length : nl;
        const raw = src.slice(pos, end);
        pos = end + 1;
        if ((strip ? raw.replace(/^\t+/, "") : raw) === delim) break;
        lines.push(raw);
      }
      const body = lines.join("\n");
      into.push(body);
      // An unquoted delimiter means the shell expands $(...) and backticks in the body.
      if (!quoted) for (const sub of substitutions(body)) for (const cmd of parseCommands(sub)) commands.push(cmd);
    }
    pending.length = 0;
    return pos - 1; // the loop's i++ lands on the first character after the bodies
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      word += src[++i];
      inWord = true;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("unclosed '");
      word += src.slice(i + 1, j);
      inWord = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let str = "";
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) str += src[++j];
        else str += src[j];
      }
      if (j >= src.length) throw new Error('unclosed "');
      word += str;
      inWord = true;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      // Command substitution: analyse its contents as commands of their own.
      let depth = 1;
      let j = i + 2;
      for (; j < src.length && depth; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
      }
      for (const sub of parseCommands(src.slice(i + 2, j - 1))) commands.push(sub);
      word += "$(...)";
      inWord = true;
      i = j - 1;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new Error("unclosed `");
      for (const sub of parseCommands(src.slice(i + 1, j))) commands.push(sub);
      i = j;
    } else if (c === ">") {
      // Output redirection. A file-descriptor number right before it ("2>") isn't a word,
      // and ">&1" duplicates a descriptor rather than naming a file.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      while (src[i + 1] === ">") i++;
      if (src[i + 1] === "|") i++; // ">|": write even with noclobber
      if (src[i + 1] === "&") {
        i++;
        while (/[\d-]/.test(src[i + 1] ?? "")) i++;
      } else redirectOut = true;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] === "<") {
      // Here-string: the next word is data, kept as an ordinary word.
      endWord();
      i += 2;
    } else if (c === "<" && src[i + 1] === "<") {
      // Here-document: <<EOF, <<'EOF', <<"EOF", <<-EOF. The body follows the line.
      endWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (src[i] === " " || src[i] === "\t") i++;
      let delim = "";
      const quoted = src[i] === "'" || src[i] === '"';
      if (quoted) {
        const q = src[i]!;
        const j = src.indexOf(q, i + 1);
        if (j < 0) throw new Error(`unclosed ${q}`);
        delim = src.slice(i + 1, j);
        i = j;
      } else {
        while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) delim += src[i++];
        i--;
      }
      if (!delim) throw new Error("here-document without a delimiter");
      pending.push({ delim, strip, quoted, into: heredocs });
    } else if (c === "<") {
      // Input redirection: its target is an ordinary word ("cat < .env").
      endWord();
    } else if (c === "\n" && pending.length) {
      // The line that declared here-documents ends: read their bodies, then the command ends.
      i = readBodies(i + 1);
      endCommand();
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** The command substitutions inside text the shell expands: `$(...)` and backticks. */
function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      out.push(text.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j < 0) break;
      out.push(text.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

// Wrapper options that take the next word as their value (`env -u NAME`, `sudo -u root`),
// so that word isn't mistaken for the command. Short ones also take it attached (`-uNAME`).
const WRAPPER_VALUE_OPTS: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  sudo: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-U", "--other-user"],
  nice: ["-n", "--adjustment"],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  xargs: ["-a", "--arg-file", "-d", "--delimiter", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"],
  time: ["-f", "--format", "-o", "--output"],
  exec: ["-a"],
};
// Short options whose value may be left out, so `-i`/`-e`/`-l` alone take nothing.
const OPTIONAL_VALUE = new Set(["xargs -i", "xargs -e", "xargs -l"]);

/** Drop `VAR=value` prefixes and wrappers such as `sudo`, `timeout 10`, `env -u NAME`. */
function unwrap(words: string[]): string[] {
  return unwrapLayers(words).at(-1)!;
}

/** The command at each layer of wrapping: `sudo timeout 5 ssh h` → itself, `timeout 5 ssh h`, `ssh h`. */
function unwrapLayers(words: string[]): string[][] {
  const layers: string[][] = [];
  let w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
    layers.push([...w]);
    const head = w[0] ? basename(w[0]) : "";
    if (!WRAPPERS.has(head)) return layers;
    w.shift();
    const valued = WRAPPER_VALUE_OPTS[head] ?? [];
    while (w.length && w[0]!.startsWith("-") && w[0] !== "-") {
      const a = w.shift()!;
      if (a === "--") break;
      let name: string | undefined;
      let inline: string | undefined;
      if (a.startsWith("--")) {
        const eq = a.indexOf("=");
        name = eq < 0 ? a : a.slice(0, eq);
        inline = eq < 0 ? undefined : a.slice(eq + 1);
        if (!valued.includes(name)) continue;
      } else {
        // A cluster (`-Eu root`, `-iuX`): the first letter that takes a value takes the rest, or the next word.
        for (let k = 1; k < a.length; k++) {
          if (!valued.includes(`-${a[k]}`)) continue;
          name = `-${a[k]}`;
          inline = k + 1 < a.length ? a.slice(k + 1) : undefined;
          break;
        }
        if (!name) continue;
        if (OPTIONAL_VALUE.has(`${head} ${name}`)) continue; // `-i` alone; `-iX` carries its value inline
      }
      const value = inline ?? w.shift() ?? "";
      // `env -S 'git push -f'` runs its value as the command line.
      if (head === "env" && (name === "-S" || name === "--split-string")) w = [...(parseShell(value)[0] ?? []), ...w];
    }
    if (head === "timeout" && w.length && /^\d+(\.\d+)?[smhd]?$/.test(w[0]!)) w.shift(); // the duration
  }
}

// ---------- role rules (foreman.json "roles", resolved by foreman) ----------

const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** `Bash(ssh *)` → { tool: "Bash", spec: "ssh *" }; `mcp__deploy` → { tool: "mcp__deploy", spec: null }. */
function splitRule(rule: string): { tool: string; spec: string | null } {
  const m = /^([^(]+)\((.*)\)$/s.exec(rule.trim());
  return m ? { tool: m[1]!.trim(), spec: m[2]! } : { tool: rule.trim(), spec: null };
}

/**
 * Claude Code's Bash rule matching: `*` matches anything, spaces included; the legacy
 * `:*` suffix means ` *`. A trailing ` *` also matches the bare command, so
 * `Bash(gh pr merge *)` denies `gh pr merge` with no arguments too.
 */
export function bashPatternMatches(pattern: string, command: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  let p = norm(pattern);
  if (p.endsWith(":*")) p = `${p.slice(0, -2)} *`;
  const c = norm(command);
  const re = (s: string) => new RegExp(`^${s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  return re(p).test(c) || (p.endsWith(" *") && re(p.slice(0, -2)).test(c));
}

/** Claude Code's path rules: `//abs`, `~/home`, `/root-relative`, `relative`; a pattern without `/` matches at any depth. */
export function pathPatternMatches(pattern: string, path: string, ctx: Pick<Context, "projectRoot" | "cwd">): boolean {
  const home = process.env.HOME ?? "";
  let glob: string;
  if (pattern.startsWith("//")) glob = pattern.slice(1);
  else if (pattern.startsWith("~/")) glob = `${home}/${pattern.slice(2)}`;
  else if (pattern.startsWith("/")) glob = `${ctx.projectRoot}${pattern}`;
  else {
    const rel = pattern.replace(/^\.\//, "");
    glob = rel.includes("/") ? `${ctx.projectRoot}/${rel}` : `${ctx.projectRoot}/**/${rel}`;
  }
  const g = new Bun.Glob(glob);
  // A rule naming a directory covers what is inside it.
  for (let p = isAbsolute(path) ? path : resolve(ctx.cwd, path); p !== "/" && p !== "."; p = resolve(p, "..")) {
    if (g.match(p)) return true;
  }
  return false;
}

/** The role rules, or a reason to block when they should be known but can't be. */
function loadRoleRules(ctx: Context): RoleRule[] | string {
  try {
    return ctx.roleRules?.() ?? [];
  } catch (e) {
    return `can't read your role's rules: ${(e as Error).message}`;
  }
}

const denied = (r: RoleRule, what: string) =>
  `${what} is denied to ${r.role === "agent" ? "agent sessions" : `${r.role} sessions`} by ${r.rule} (foreman.json roles.${r.role})`;

/** A role rule that denies running this simple command (at any layer of wrappers). */
function roleBashRule(words: string[], ctx: Context): string | null {
  const rules = loadRoleRules(ctx);
  if (typeof rules === "string") return rules;
  const bash = rules.filter((r) => splitRule(r.rule).tool === "Bash");
  if (!bash.length) return null;
  const forms = new Set<string>();
  for (const layer of unwrapLayers(words)) {
    if (!layer.length) continue;
    forms.add(layer.join(" "));
    // `/usr/bin/ssh host` is `ssh host`.
    forms.add([basename(layer[0]!), ...layer.slice(1)].join(" "));
  }
  for (const r of bash) {
    const { spec } = splitRule(r.rule);
    for (const f of forms) if (spec === null || bashPatternMatches(spec, f)) return denied(r, `\`${f}\``);
  }
  return null;
}

/** A role rule that denies this tool call (Read, the edit tools, MCP tools, others by name). */
function roleToolRule(tool: string, input: Record<string, unknown>, ctx: Context): string | null {
  const rules = loadRoleRules(ctx);
  if (typeof rules === "string") return rules;
  const path = String(input.file_path ?? input.notebook_path ?? "");
  for (const r of rules) {
    const { tool: t, spec } = splitRule(r.rule);
    if (t === "Bash") continue; // checked command by command
    let hit: boolean;
    if (t.startsWith("mcp__") && tool.startsWith("mcp__")) {
      // `mcp__server` covers the server's tools; `mcp__server__*` and exact names as globs.
      hit = tool === t || (!t.slice(5).includes("__") && tool.startsWith(`${t}__`)) || new Bun.Glob(t).match(tool);
    } else if (t === "Edit" && EDIT_TOOLS.includes(tool)) hit = spec === null || (!!path && pathPatternMatches(spec, path, ctx));
    else if (t === tool) hit = spec === null || ((t === "Read" || EDIT_TOOLS.includes(t)) && !!path ? pathPatternMatches(spec, path, ctx) : true);
    else hit = false;
    if (hit) return denied(r, path ? `${tool} on ${path}` : tool);
  }
  return null;
}

/** A role rule that denies writing `path` from the shell (Edit-family rules with a path). */
function roleWriteRule(path: string, ctx: Context): string | null {
  if (path.startsWith("/dev/")) return null;
  const rules = loadRoleRules(ctx);
  if (typeof rules === "string") return rules;
  for (const r of rules) {
    const { tool, spec } = splitRule(r.rule);
    if (EDIT_TOOLS.includes(tool) && spec !== null && pathPatternMatches(spec, path, ctx)) return denied(r, `writing ${path}`);
  }
  return null;
}

// ---------- rules ----------

function gitRule(args: string[], ctx: Context): string | null {
  // Global options come before the subcommand: -C <dir>, -c k=v, --git-dir=..., --no-pager.
  let dir = ctx.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") dir = resolve(dir, args[++i] ?? ".");
    else if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
    else if (a.startsWith("-")) continue;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const shortFlags = (s: string) => /^-[A-Za-z]+$/.test(s);

  if (sub === "push") {
    const positional: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (a === "--no-verify") return "git push --no-verify skips the hooks";
      if (a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("--force-if-includes") || a === "--mirror")
        return "force-push rewrites history others may have";
      if (shortFlags(a) && a.includes("f")) return "force-push rewrites history others may have";
      if (a === "--delete" || (shortFlags(a) && a.includes("d"))) return "deleting a remote branch needs a person";
      if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack" || a === "--exec") {
        k++;
        continue;
      }
      if (a.startsWith("-")) continue;
      positional.push(a);
    }
    const refspecs = positional.slice(1); // first positional is the remote
    for (const r of refspecs) {
      if (r.startsWith("+")) return `"${r}" force-pushes`;
      if (r.startsWith(":")) return "deleting a remote branch needs a person";
      const target = (r.includes(":") ? r.split(":").pop()! : r).replace(/^refs\/heads\//, "");
      if (PROTECTED.has(target)) return `pushing to ${target} goes through a PR`;
      if (target === "HEAD" && PROTECTED.has(ctx.branchAt(dir) ?? "")) return "pushing to main goes through a PR";
    }
    if (refspecs.length === 0) {
      const branch = ctx.branchAt(dir);
      if (branch && PROTECTED.has(branch)) return `you're on ${branch}: push a branch and open a PR`;
    }
    return null;
  }
  if (sub === "commit" || sub === "merge" || sub === "am" || sub === "rebase" || sub === "cherry-pick") {
    const takesValue = new Set(["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--cleanup", "--trailer", "--fixup", "--squash", "-S", "--gpg-sign", "-s", "--strategy", "-X", "--strategy-option"]);
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (a === "--no-verify") return `git ${sub} --no-verify skips the hooks`;
      if (takesValue.has(a)) {
        k++;
        continue;
      }
      // -n is --no-verify for commit; in a cluster ("-nm msg", "-an") the letters before
      // a value-taking letter are flags.
      if (sub === "commit" && shortFlags(a)) {
        const flags = a.slice(1);
        const stop = flags.search(/[mFCct]/);
        if ((stop < 0 ? flags : flags.slice(0, stop)).includes("n")) return "git commit -n skips the hooks";
      }
    }
    return null;
  }
  if (sub === "reset" && rest.includes("--hard")) return "git reset --hard throws work away; use git stash or ask";
  if (sub === "clean" && rest.some((a) => a === "--force" || (shortFlags(a) && a.includes("f"))))
    return "git clean -f deletes untracked files; ask first";
  return null;
}

function rmRule(args: string[]): string | null {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === "--") break;
    if (a === "--recursive") recursive = true;
    else if (a === "--force") force = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes("f")) force = true;
    }
  }
  return recursive && force ? "recursive force rm is denied here; use the tool's own clean command or ask" : null;
}

/** Files a command writes to, for the commands that commonly write files. */
export function writeTargets(head: string, args: string[]): string[] {
  const plain = (xs: string[]) => xs.filter((a) => !a.startsWith("-"));
  // Creating, emptying or deleting a file is writing it.
  if (["tee", "touch", "rm", "unlink", "rmdir", "mkdir", "shred"].includes(head)) return plain(args);
  if (head === "truncate") return plain(args.filter((a, k) => !(args[k - 1] === "-s" || args[k - 1] === "--size")));
  if (head === "cp" || head === "mv" || head === "install" || head === "ln") {
    // -t DIR, also at the end of a flag cluster ("-rt DIR", "-vt DIR").
    const t = args.findIndex((a) => a === "--target-directory" || /^-[A-Za-z]*t$/.test(a));
    const longT = args.find((a) => a.startsWith("--target-directory="));
    const rest = plain(args.filter((_, k) => k !== t + 1 || t < 0));
    // mv also takes its sources away: they're written too.
    const moved = head === "mv" ? rest : [];
    if (t >= 0 && args[t + 1]) return [args[t + 1]!, ...moved];
    if (longT) return [longT.split("=")[1]!, ...moved];
    if (rest.length < 2) return [];
    return head === "mv" ? rest : [rest[rest.length - 1]!];
  }
  if (head === "dd") return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
  if (head === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok")) {
    // find deletes or runs commands under its start directories (the words before the first expression).
    const start: string[] = [];
    for (const a of args) {
      if (a.startsWith("-") || a === "(" || a === "!" || a === "\\(") break;
      start.push(a);
    }
    return start.length ? start : ["."];
  }
  if (head === "curl" || head === "wget") {
    // curl -o FILE / --output FILE / -sSLo FILE; wget -O FILE / --output-document FILE.
    const short = head === "curl" ? "o" : "O";
    const long = head === "curl" ? "--output" : "--output-document";
    const out: string[] = [];
    args.forEach((a, k) => {
      if ((a === long || new RegExp(`^-[A-Za-z]*${short}$`).test(a)) && args[k + 1] && args[k + 1] !== "-") out.push(args[k + 1]!);
      else if (a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1));
      // Attached value: `-ofile` (curl), `-Ofile` (wget).
      else if (a.length > 2 && a.startsWith(`-${short}`)) out.push(a.slice(2));
    });
    return out;
  }
  if (head === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))) {
    // The script is the first plain word unless given with -e/-f.
    const out: string[] = [];
    let scriptGiven = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
        scriptGiven = true;
        k++;
      } else if (!a.startsWith("-")) {
        if (!scriptGiven) scriptGiven = true;
        else out.push(a);
      }
    }
    return out;
  }
  return [];
}

/** Files git changes in the working tree: `git rm`, `git mv`, `git checkout -- x`, `git restore x`. */
export function gitWriteTargets(args: string[]): string[] {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
    else if (!a.startsWith("-")) break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const plain = rest.filter((a) => !a.startsWith("-"));
  if (sub === "rm" || sub === "mv") return plain;
  if (sub === "checkout") {
    const dd = rest.indexOf("--");
    if (dd >= 0) return rest.slice(dd + 1);
    // `git checkout <ref> <path>...`: everything after the ref is a path. A single word is
    // most often a branch to switch to, which writes no file of its own.
    const vals = new Set(["-b", "-B", "--orphan"]);
    const words = rest.filter((a, k) => !a.startsWith("-") && !vals.has(rest[k - 1] ?? ""));
    return words.length >= 2 ? words.slice(1) : [];
  }
  if (sub === "restore") {
    // --staged alone touches only the index, not files.
    if (rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W")) return [];
    const vals = new Set(["-s", "--source"]);
    return rest.filter((a, k) => !a.startsWith("-") && !vals.has(rest[k - 1] ?? "") && a !== "--");
  }
  return [];
}

/** Does this shell or interpreter read its script from stdin (so a heredoc fed to it is code)? */
/** Options of shells and interpreters whose next word is their value, not a script. */
const VALUE_OPTIONS = new Set([
  "-o", "-O", "+o", "+O", "--rcfile", "--init-file", // shells
  "-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", // node
  "--preload", "--cwd", "--config", "--tsconfig-override", // bun
  "-W", "-X", // python
  "-I", "-M", // perl, ruby
]);

function readsScriptFromStdin(head: string, args: string[]): boolean {
  if (args.some((a) => ["-c", "-e", "-E", "--eval", "-p", "--print", "-m"].includes(a))) return false; // code or module given
  if (args.includes("-s") || args.includes("-")) return true;
  // Only a word that looks like a script file names one. Anything else may be an option's
  // value (`bash -o pipefail`, `python3 -W ignore`), so the heredoc is treated as code:
  // when unsure, check it (verifier finding on T-0027).
  const looksLikeScript = (a: string) => !a.startsWith("-") && (a.includes("/") || /\.(sh|bash|zsh|py|js|mjs|cjs|ts|tsx|rb|pl|php)$/.test(a));
  // The value of an option that takes one (`--rcfile ./rc`, `--require ./x.js`) isn't the script.
  const plain = args.filter((a, k) => !VALUE_OPTIONS.has(args[k - 1] ?? ""));
  return !plain.some(looksLikeScript);
}

function inlineCode(head: string, args: string[]): string[] {
  // `bun -e '...'`, `node -e`, `python -c`, `perl -e`, ...: the code is text we must scan.
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (["-e", "-c", "--eval", "-p", "--print", "-E"].includes(args[k]!) && args[k + 1] !== undefined) out.push(args[++k]!);
  }
  return INTERPRETERS.has(head) ? out : [];
}

/** Code (not shell) that names a .env file in a string literal. */
function codeReadsEnv(code: string): boolean {
  const m = code.match(/["'`]([^"'`]*\.env(\.[A-Za-z0-9_.-]+)?)["'`]/g) ?? [];
  return m.some((s) => isEnvFile(s.slice(1, -1)));
}

export function checkCommand(command: string, ctx: Context, depth = 0): string | null {
  if (depth > 3) return "command nests shells too deeply to check";
  let commands: SimpleCommand[];
  try {
    commands = parseCommands(command);
  } catch (e) {
    return `couldn't parse the command (${(e as Error).message})`;
  }
  // Here-document bodies run as code when anything in the command line reads a script
  // from stdin: `bash <<EOF`, `cat <<EOF | bash`, `source /dev/stdin <<EOF`.
  const heads = commands.map((c) => {
    const w = unwrap(c.words);
    return { head: w[0] ? basename(w[0]) : "", args: w.slice(1) };
  });
  const bodies = commands.flatMap((c) => c.heredocs);
  if (bodies.length) {
    // Only a shell or interpreter that reads its script from stdin runs the body:
    // `bash script.sh <<EOF` and `python3 x.py <<EOF` feed it data (T-0027).
    const runsStdin = heads.some(
      (h) =>
        (SHELLS.has(h.head) && readsScriptFromStdin(h.head, h.args)) ||
        ((h.head === "source" || h.head === ".") && h.args[0] === "/dev/stdin"),
    );
    if (runsStdin) {
      for (const body of bodies) {
        const r = checkCommand(body, ctx, depth + 1);
        if (r) return r;
      }
    }
    // An interpreter fed a heredoc as its script (`python3 <<EOF`, `cat <<EOF | node`) runs code
    // we can't parse: scan it like `-e` code.
    if (heads.some((h) => INTERPRETERS.has(h.head) && readsScriptFromStdin(h.head, h.args)) && bodies.some(codeReadsEnv)) {
      return "inline code reads a .env file";
    }
  }
  // `cd DIR && ...`: later commands run in DIR, for branch checks and relative paths.
  for (const { words: raw, writes } of commands) {
    for (const target of writes) {
      const r = editRule(target, ctx);
      if (r) return r;
    }
    const roleHit = roleBashRule(raw, ctx);
    if (roleHit) return roleHit;
    const words = unwrap(raw);
    if (!words.length) continue;
    const head0 = basename(words[0]!);
    if (head0 === "cd" || head0 === "pushd") {
      const to = words.slice(1).find((a) => !a.startsWith("-"));
      // No argument or `cd -` goes somewhere we can't know: keep the outer cwd's rules.
      if (to && to !== "-") ctx = { ...ctx, cwd: isAbsolute(to) ? to : resolve(ctx.cwd, to) };
      continue;
    }
    if (head0 === "find") {
      // The command after -exec/-execdir/-ok runs on found files: check its own writes too.
      const args0 = words.slice(1);
      for (let k = 0; k < args0.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args0[k]!)) continue;
        const seg: string[] = [];
        for (k++; k < args0.length && args0[k] !== ";" && args0[k] !== "+" && args0[k] !== "\\;"; k++) seg.push(args0[k]!);
        if (!seg.length) continue;
        const segHit = roleBashRule(seg, ctx);
        if (segHit) return segHit;
        const h = basename(seg[0]!);
        // `{}` is each found file: a path under the first start directory.
        const firstStart = args0.find((a) => !a.startsWith("-") && a !== "(" && a !== "!") ?? ".";
        const rest = seg.slice(1).map((a) => (a === "{}" ? `${firstStart.replace(/\/$/, "")}/_` : a));
        const r =
          (h === "rm" ? rmRule(rest) : null) ??
          (h === "git" ? gitRule(rest, ctx) : null) ??
          (h === "git" ? gitWriteTargets(rest) : writeTargets(h, rest)).map((t) => editRule(t, ctx)).find((x) => x) ??
          null;
        if (r) return r;
      }
    }
    // `--env-file=.env` and other `--option=value` forms: a .env value is still a .env read.
    const assigned = words.slice(1).find((a) => /^--?[A-Za-z][\w-]*=/.test(a) && isEnvFile(a.slice(a.indexOf("=") + 1)));
    if (assigned) return `${assigned.slice(assigned.indexOf("=") + 1)} holds secrets: agents don't read or copy it`;
    const head = basename(words[0]!);
    const args = words.slice(1);
    if (head === "git") {
      const r = gitRule(args, ctx);
      if (r) return r;
    }
    if (head === "rm") {
      const r = rmRule(args);
      if (r) return r;
    }
    if (SHELLS.has(head) || head === "eval") {
      const ci = args.indexOf("-c");
      const script = head === "eval" ? args.join(" ") : ci >= 0 ? args[ci + 1] : undefined;
      if (script) {
        const r = checkCommand(script, ctx, depth + 1);
        if (r) return r;
      }
    }
    for (const code of inlineCode(head, args)) {
      if (codeReadsEnv(code)) return "inline code reads a .env file";
    }
    for (const target of head === "git" ? gitWriteTargets(args) : writeTargets(head, args)) {
      const r = editRule(target, ctx);
      if (r) return r;
    }
    // Any argument that IS a .env path (not text that mentions one).
    const envArg = args.find((a) => !a.includes(" ") && isEnvFile(a.replace(/^[<>]+/, "")));
    if (envArg && head !== "echo" && head !== "printf") return `${envArg} holds secrets: agents don't read or copy it`;
  }
  return null;
}

function editRule(path: string, ctx: Context): string | null {
  if (isEnvFile(path)) return `${basename(path)} holds secrets: agents don't write it`;
  const roleHit = roleWriteRule(path, ctx);
  if (roleHit) return roleHit;
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
  const rel = relative(ctx.projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null; // outside the repo: not a task's business
  let paths: string[] | null;
  try {
    paths = ctx.taskPaths();
  } catch (e) {
    return `can't check your task's paths: ${(e as Error).message}`;
  }
  if (!paths || paths.length === 0) return null;
  // A directory (cp -t DIR, mkdir DIR) is inside the paths when what goes into it would be.
  const ok = [...paths, ...ALWAYS_EDITABLE].some((g) => new Bun.Glob(g).match(rel) || new Bun.Glob(g).match(`${rel.replace(/\/$/, "")}/_`));
  return ok ? null : `${rel} is outside your task's paths (${paths.join(", ")}); file a task for it instead`;
}

export function decide(payload: { tool_name?: string; tool_input?: Record<string, unknown> }, ctx: Context): Decision | null {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  let reason: string | null = null;
  if (tool === "Bash") reason = checkCommand(String(input.command ?? ""), ctx);
  else if ((reason = roleToolRule(tool, input, ctx))) {
    // the role may not use this tool here
  } else if (tool === "Read") reason = isEnvFile(String(input.file_path ?? "")) ? ".env files hold secrets: agents don't read them" : null;
  else if (EDIT_TOOLS.includes(tool)) {
    const p = String(input.file_path ?? input.notebook_path ?? "");
    reason = p ? editRule(p, ctx) : "edit without a file path";
  }
  return reason ? { deny: reason } : null;
}

// ---------- wiring for a real run ----------

function sh(cmd: string[], cwd: string): string | null {
  return run(cmd, cwd).out;
}

/** Runs a command; on failure `err` says why (its stderr, its exit code, or the spawn error). */
function run(cmd: string[], cwd: string): { out: string | null; err: string } {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (p.exitCode === 0) return { out: p.stdout.toString().trim(), err: "" };
    const e = p.stderr.toString().trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    return { out: null, err: `exit ${p.exitCode}${e ? `: ${e}` : ""}` };
  } catch (e) {
    return { out: null, err: (e as Error).message };
  }
}

/** foreman from $FOREMAN_BIN, this repo's own copy, or the PATH. The repo's own comes before the
 * PATH so a worktree is judged by its own foreman, not an older linked one. */
function foremanCmd(root: string): string[] | null {
  if (process.env.FOREMAN_BIN) return process.env.FOREMAN_BIN.split(" ");
  const local = resolve(root, "packages/foreman/src/cli.ts");
  if (Bun.file(local).size) return ["bun", local];
  return Bun.which("foreman") ? ["foreman"] : null;
}

export function realContext(cwd: string): Context {
  let cached: string[] | null | undefined;
  let rules: RoleRule[] | null | undefined;
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || sh(["git", "rev-parse", "--show-toplevel"], cwd) || cwd;
  return {
    projectRoot,
    cwd,
    branchAt: (dir) => sh(["git", "branch", "--show-current"], dir),
    taskPaths: () => {
      if (cached !== undefined) return cached;
      if (!process.env.FOREMAN_ACTOR) return (cached = null); // no identity, no task to hold to
      // With an identity set, not knowing the task's paths is an error, not a free pass.
      const fm = foremanCmd(projectRoot);
      if (!fm) throw new Error("FOREMAN_ACTOR is set but foreman isn't installed (set FOREMAN_BIN)");
      const r = run([...fm, "list", "--mine", "--status", "claimed", "--status", "in_progress", "--json"], projectRoot);
      const out = r.out;
      if (out === null) throw new Error(`FOREMAN_ACTOR is set but foreman can't be run: \`${fm.join(" ")} list\` failed (${r.err})`);
      let tasks: { paths: string[] }[];
      try {
        tasks = JSON.parse(out);
      } catch {
        throw new Error("foreman's answer wasn't JSON");
      }
      if (!tasks.length || tasks.some((t) => t.paths.length === 0)) return (cached = null);
      return (cached = tasks.flatMap((t) => t.paths));
    },
    roleRules: () => {
      if (rules !== undefined) return rules;
      if (!process.env.FOREMAN_ACTOR) return (rules = null); // a person's session: no role
      // foreman resolves the rules (one source for this hook and the launch flags).
      const fm = foremanCmd(projectRoot);
      if (!fm) throw new Error("FOREMAN_ACTOR is set but foreman isn't installed (set FOREMAN_BIN)");
      const r = run([...fm, "policy", "--json"], projectRoot);
      const out = r.out;
      if (out === null) throw new Error(`FOREMAN_ACTOR is set but foreman can't be run: \`${fm.join(" ")} policy\` failed (${r.err}; or a foreman older than this hook, or a bad foreman.json)`);
      try {
        const r = (JSON.parse(out) as { rules?: unknown }).rules;
        if (!Array.isArray(r) || !r.every((x) => typeof x?.rule === "string" && typeof x?.role === "string")) throw new Error();
        return (rules = r as RoleRule[]);
      } catch {
        throw new Error("foreman policy's answer wasn't the expected JSON");
      }
    },
  };
}

if (import.meta.main) {
  let payload: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("guard: couldn't read the hook payload, blocking to be safe");
    process.exit(2);
  }
  try {
    const d = decide(payload, realContext(payload.cwd || process.cwd()));
    if (d) {
      console.error(`guard: ${d.deny}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`guard: internal error, blocking to be safe: ${(e as Error).message}`);
    process.exit(2);
  }
  process.exit(0);
}
