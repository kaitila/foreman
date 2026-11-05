// Deny rules per agent role (D0019). foreman.json's optional "roles" block lists
// Claude Code permission rules a role must not use:
//
//   { "roles": { "agent":    { "deny": ["Bash(gh pr merge *)", "Bash(ssh *)"] },
//                "worker":   { "deny": ["Bash(gh release *)"] },
//                "verifier": { "deny": ["mcp__deploy"] },
//                "intake":   { "deny": ["Read(data/**)"] } } }
//
// "agent" applies to every session with FOREMAN_ACTOR set; a role's own list is added
// for actors named after it (worker-T-0042, verifier-T-0042, intake). A session without
// FOREMAN_ACTOR (a person's) gets no role rules. foreman is the one source: the guard
// hook asks `foreman policy --json`, and the launch adapter adds them to --disallowedTools.
import { loadConfig } from "./policy";

export const ROLES = ["worker", "verifier", "intake"] as const;
export type AgentRole = (typeof ROLES)[number];

/** One deny rule and the role block it came from ("agent" or a role name). */
export interface RoleRule {
  rule: string;
  role: string;
}

export interface ResolvedPolicy {
  actor: string | null;
  /** The actor's role, or null for a person or an actor no role is named after. */
  role: AgentRole | null;
  rules: RoleRule[];
}

/** `Tool` or `Tool(specifier)`: the shape of a Claude Code permission rule. */
const RULE = /^[A-Za-z_][A-Za-z0-9_-]*(\(.+\))?$/s;

/** Validated deny lists by block name. Throws with the offending entry's place in foreman.json. */
export function parseRoles(raw: unknown): Record<string, string[]> {
  if (raw === undefined) return {};
  const where = "foreman.json roles";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const out: Record<string, string[]> = {};
  for (const [name, block] of Object.entries(raw as Record<string, unknown>)) {
    if (name.startsWith("$")) continue; // "$comment"
    // A typo ("workers") would otherwise apply to nobody without a word.
    if (name !== "agent" && !(ROLES as readonly string[]).includes(name)) {
      throw new Error(`${where}: unknown role "${name}" (use agent, ${ROLES.join(", ")})`);
    }
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(`${where}.${name} must be an object`);
    for (const key of Object.keys(block)) {
      if (key !== "deny" && !key.startsWith("$")) throw new Error(`${where}.${name}: unknown key "${key}" (only "deny")`);
    }
    const deny = (block as { deny?: unknown }).deny ?? [];
    if (!Array.isArray(deny)) throw new Error(`${where}.${name}.deny must be a list of rules`);
    out[name] = deny.map((r, i) => {
      if (typeof r !== "string" || !RULE.test(r.trim())) {
        throw new Error(`${where}.${name}.deny[${i}]: ${JSON.stringify(r)} isn't a permission rule (Tool or Tool(specifier))`);
      }
      // --disallowedTools is a comma-separated list, so a comma would split the rule in two.
      if (r.includes(",")) throw new Error(`${where}.${name}.deny[${i}]: ${JSON.stringify(r)} has a comma; write it as two rules`);
      if (/[\n\r]/.test(r)) throw new Error(`${where}.${name}.deny[${i}]: a rule is one line`);
      return r.trim();
    });
  }
  return out;
}

/** The repo's role rules, validated (empty without foreman.json or a "roles" block). */
export function loadRoles(root: string | null): Record<string, string[]> {
  return parseRoles(loadConfig(root).roles);
}

/** worker-T-0042 → worker; intake → intake; anything else (a custom name, or none) → null. */
export function roleOf(actor: string | null | undefined): AgentRole | null {
  if (!actor) return null;
  return ROLES.find((r) => actor === r || actor.startsWith(`${r}-`)) ?? null;
}

/**
 * A warning for a rule whose specifier ends in ":*" right after a word: that is the legacy
 * suffix for " *", so `Bash(*gamma prod:*)` means `gamma prod *` and lets `gamma prod:pull` through.
 */
export function ruleWarning(rule: string): string | null {
  const m = /^(.*[^\s(]):\*\)$/s.exec(rule);
  if (!m || !m[1].includes("(")) return null;
  return `deny rule ${JSON.stringify(rule)} ends in ":*", the legacy form of " *", so it matches "${m[1].slice(m[1].indexOf("(") + 1)} *" and not the word with ":" after it; write ${JSON.stringify(`${m[1]} *)`)} if that is what you mean`;
}

/** The rules for a role ("agent" first, then the role's own), without repeats. */
export function rulesForRole(roles: Record<string, string[]>, role: AgentRole | null): RoleRule[] {
  const out: RoleRule[] = [];
  for (const block of role ? ["agent", role] : ["agent"]) {
    for (const rule of roles[block] ?? []) if (!out.some((r) => r.rule === rule)) out.push({ rule, role: block });
  }
  return out;
}

/** What applies to `actor`: nothing without one (a person), "agent" plus its role's rules with one. */
export function resolvePolicy(root: string | null, actor: string | null | undefined): ResolvedPolicy {
  const roles = loadRoles(root);
  if (!actor) return { actor: null, role: null, rules: [] };
  const role = roleOf(actor);
  return { actor, role, rules: rulesForRole(roles, role) };
}
