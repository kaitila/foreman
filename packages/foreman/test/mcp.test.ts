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
  expect(JSON.parse((await call("submit_task", { id: created.id, pr: "#3" })).text).status).toBe("in_review");

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
