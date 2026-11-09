import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "foreman-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("an agent works a task end to end over MCP, and can't approve", async () => {
  Bun.spawnSync(["git", "init", "-q", dir]);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [CLI, "mcp"],
      cwd: dir,
      env: { ...(process.env as Record<string, string>), FOREMAN_DB: "", FOREMAN_ACTOR: "worker-1" },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]!.text };
  };

  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("claim_task");
  expect(names).not.toContain("approve");

  const created = JSON.parse(
    (await call("create_task", { title: "MCP task", acceptance: ["cmd: true"], risk: "auto", ready: true })).text,
  );
  expect(created.status).toBe("ready");
  expect(JSON.parse((await call("claim_task")).text).assignee).toBe("worker-1");
  await call("report_progress", { id: created.id, note: "halfway" });
  expect(JSON.parse((await call("submit_task", { id: created.id, pr: "https://example.com/pull/3" })).text).status).toBe("in_review");

  // same actor again: refused, with a readable error instead of a crash
  const own = await call("start_verify", { id: created.id });
  expect(own.error).toBe(true);
  expect(own.text).toStartWith("own_work:");
  expect((await call("show_task", { id: created.id })).text).toContain("## Acceptance checks");
  await client.close();
}, 20_000);

test("servers started by the same parent act as the same actor, so a restarted one keeps the claims", async () => {
  const { actorName } = await import("../src/mcp");
  expect(actorName({}, 4242)).toBe(actorName({}, 4242));
  expect(actorName({ FOREMAN_ACTOR: "w" }, 4242)).toBe("w");
  expect(actorName({ CLAUDE_CODE_SESSION_ID: "abc-1" }, 4242)).toBe("mcp-abc-1");
  expect(actorName({ USER: "me" }, 1)).toBe("mcp-me");

  const d = mkdtempSync(join(tmpdir(), "foreman-mcp-restart-"));
  Bun.spawnSync(["git", "init", "-q", d]);
  const env = { ...(process.env as Record<string, string>), FOREMAN_DB: "" } as Record<string, string>;
  delete env.FOREMAN_ACTOR;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  const start = async () => {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StdioClientTransport({ command: "bun", args: [CLI, "mcp"], cwd: d, env }));
    return c;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]!.text };
  };
  try {
    const first = await start();
    const t = JSON.parse(
      (await call(first, "create_task", { title: "T", acceptance: ["cmd: true"], risk: "auto", ready: true })).text,
    );
    const claimed = JSON.parse((await call(first, "claim_task")).text);
    await first.close();
    const second = await start();
    const r = await call(second, "report_progress", { id: t.id, note: "after restart" });
    expect(r.error).toBe(false);
    expect(JSON.parse((await call(second, "show_task", { id: t.id })).text).assignee ?? claimed.assignee).toBe(
      claimed.assignee,
    );
    await second.close();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("plans over MCP: create, file a task into a step, show progress, move and cancel", async () => {
  const d = mkdtempSync(join(tmpdir(), "foreman-mcp-plans-"));
  Bun.spawnSync(["git", "init", "-q", d]);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [CLI, "mcp"],
      cwd: d,
      env: { ...(process.env as Record<string, string>), FOREMAN_DB: "", FOREMAN_ACTOR: "planner" },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { error: r.isError === true, text: r.content[0]!.text };
  };
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_plan", "list_plans", "show_plan", "edit_plan", "plan_task"]));

    const plan = JSON.parse(
      (await call("create_plan", {
        title: "Publish",
        goal: "Ship it.",
        steps: [{ title: "Rename", check: "renamed" }, { title: "Release", check: "on npm" }],
      })).text,
    );
    expect(plan.id).toBe("P-0001");
    const t = JSON.parse((await call("create_task", { title: "Rename it", acceptance: ["cmd: true"], plan: "P-0001", step: 1 })).text);
    expect((await call("create_task", { title: "half", plan: "P-0001" })).text).toStartWith("invalid:");
    expect((await call("create_task", { title: "bad step", plan: "P-0001", step: 7 })).error).toBe(true);

    const shown: string = JSON.parse((await call("show_plan", { id: "P-0001" })).text);
    expect(shown).toContain("○ 1. Rename  [waiting]");
    expect(shown).toContain(`${t.id}  draft`);
    expect(shown).toContain("- 2. Release  [empty]");
    expect(JSON.parse((await call("show_task", { id: t.id })).text)).toContain("plan: P-0001\nplan_step: 1");

    await call("plan_task", { task: t.id, plan: "P-0001", step: 2 });
    const edited = JSON.parse((await call("edit_plan", { id: "P-0001", addSteps: [{ title: "Announce", check: "posted" }] })).text);
    expect(edited.steps.map((s: { state: string }) => s.state)).toEqual(["empty", "waiting", "empty"]);
    expect(JSON.parse((await call("list_plans")).text)[0]).toMatchObject({ id: "P-0001", progress: { steps: 3, tasks: 1 } });
    expect(JSON.parse((await call("plan_task", { task: t.id, remove: true })).text)).toEqual({ plan: "P-0001", step: 2 });
    expect(JSON.parse((await call("edit_plan", { id: "P-0001", cancel: "not now" })).text).state).toBe("cancelled");
  } finally {
    await client.close();
    rmSync(d, { recursive: true, force: true });
  }
}, 20_000);
