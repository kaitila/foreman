// Minimal stdio MCP server with one tool, named by argv[2]. Touches argv[3] when started.
import { writeFileSync } from "node:fs";
const tool = process.argv[2] ?? "zqx_tool";
if (process.argv[3]) writeFileSync(process.argv[3], "started\n");
let buf = "";
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === "initialize")
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } } });
    else if (m.method === "tools/list")
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: tool, description: "Canary tool; returns ok.", inputSchema: { type: "object", properties: {} } }] } });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
    else send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
