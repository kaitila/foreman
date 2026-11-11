// fm policy and fm mcp: what agent sessions ask foreman for. Neither opens the database
// here: the guard hook asks for the policy on every tool call of an agent session.
import { ForemanError } from "../core";
import { repoRoot } from "../store";
import type { Base, Exit, Module } from "./context";

export const help = {
  policy: `  policy [--actor name | --role r]
                                deny rules that apply to an agent (foreman.json "roles"): "agent" plus
                                the role from the actor's prefix (worker-, verifier-, intake-); default
                                actor $FOREMAN_ACTOR; none for a person`,
  mcp: `  mcp                           run the MCP server on stdio`,
};

async function mcp(): Promise<Exit> {
  const { serve } = await import("../mcp");
  await serve();
  return null;
}

async function policy({ o }: Base): Promise<Exit> {
  const { resolvePolicy, loadRoles, rulesForRole, ruleWarning, ROLES } = await import("../roles");
  const root = repoRoot();
  let found;
  if (o.role !== undefined) {
    if (o.role !== "agent" && !(ROLES as readonly string[]).includes(o.role)) {
      throw new ForemanError("invalid", `--role must be agent, ${ROLES.join(", ")}; got "${o.role}"`);
    }
    const role = o.role === "agent" ? null : (o.role as (typeof ROLES)[number]);
    found = { actor: null, role, rules: rulesForRole(loadRoles(root), role) };
  } else {
    found = resolvePolicy(root, o.actor ?? process.env.FOREMAN_ACTOR ?? null);
  }
  const text = found.rules.length ? found.rules.map((r) => `${r.role.padEnd(9)} ${r.rule}`).join("\n") : "no role rules";
  for (const r of found.rules) {
    const w = ruleWarning(r.rule);
    if (w) console.error(`warning: ${w}`); // stderr: --json on stdout stays parseable
  }
  console.log(o.json ? JSON.stringify(found, null, 2) : text);
  return 0;
}

export const early: Module["early"] = { mcp, policy };
