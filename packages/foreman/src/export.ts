// A task as markdown, for the PR that delivers it (D0001). Section markers keep
// the file readable by people and parseable by tools (the Backlog.md idea, D0002).
import type { Event, Task } from "./core";

export function toMarkdown(t: Task, events: Event[], plan?: { plan: string; step: number } | null): string {
  const verdict = [...events].reverse().find((e) => e.type === "verified" || e.type === "verify_failed");
  const results = (verdict?.data.results as { check: string; pass: boolean; evidence: string }[]) ?? [];
  const summary = [...events].reverse().find((e) => e.type === "submitted")?.data.summary as
    | string
    | undefined;
  const lines = [
    "---",
    `id: ${t.id}`,
    `title: ${JSON.stringify(t.title)}`,
    `status: ${t.status}`,
    `risk: ${t.risk}`,
    ...(t.parent ? [`parent: ${t.parent}`] : []),
    ...(plan ? [`plan: ${plan.plan}`, `plan_step: ${plan.step}`] : []),
    ...(t.blockedBy.length ? [`blocked_by: [${t.blockedBy.join(", ")}]`] : []),
    ...(t.discoveredFrom ? [`discovered_from: ${t.discoveredFrom}`] : []),
    ...(t.paths.length ? [`paths: [${t.paths.map((p) => JSON.stringify(p)).join(", ")}]`] : []),
    ...(t.pr ? [`pr: ${t.pr}`] : []),
    `created_by: ${t.createdBy}`,
    `created: ${new Date(t.createdAt).toISOString()}`,
    "---",
    "",
    `# ${t.id}. ${t.title}`,
    "",
    "## Spec",
    "<!-- SECTION:SPEC:BEGIN -->",
    t.spec.trim() || "_none_",
    "<!-- SECTION:SPEC:END -->",
    "",
    "## Acceptance checks",
    "<!-- AC:BEGIN -->",
    ...t.acceptance.map((c) => {
      const r = results.find((x) => x.check === c.id);
      const box = r ? (r.pass ? "[x]" : "[ ]") : "[ ]";
      const what = c.kind === "cmd" ? `\`${c.text}\`` : c.text;
      return `- ${box} ${c.id} (${c.kind}): ${what}${r ? `\n  - ${r.pass ? "pass" : "FAIL"}: ${r.evidence}` : ""}`;
    }),
    "<!-- AC:END -->",
    "",
  ];
  if (summary) lines.push("## Final summary", "<!-- SECTION:SUMMARY:BEGIN -->", summary.trim(), "<!-- SECTION:SUMMARY:END -->", "");
  lines.push(
    "## History",
    ...events.map((e) => {
      // A background session (D0022) says how to watch it.
      const watch = typeof e.data.attach === "string" ? `: session "${String(e.data.name)}", \`${e.data.attach}\`` : "";
      return `- ${new Date(e.at).toISOString()} ${e.type} by ${e.actor} (${e.actorKind})${watch}`;
    }),
    "",
  );
  return lines.join("\n");
}
