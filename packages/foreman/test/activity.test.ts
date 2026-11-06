// T-0065: fm logs and live activity. Fixture transcripts only; no Claude Code runs.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { printLogs, readTranscript, taskSessions } from "../src/activity";
import { startBoard } from "../src/board/server";
import { type Actor, Foreman } from "../src/core";
import { transcriptPath } from "../src/launch";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "foreman-activity-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const SID = "11111111-2222-3333-4444-555555555555";
const cfg = join(tmp, "cfg");
const wt = join(tmp, "wt");

const assistant = (id: string, content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 1000 }, content } }) + "\n";
const toolResult = (text: string, err = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text, is_error: err }] } }) + "\n";

const FIRST =
  assistant("m1", [{ type: "text", text: "Reading the spec first." }, { type: "tool_use", name: "Bash", input: { command: "bun test", description: "run" } }]) +
  toolResult("3 pass\n0 fail") +
  assistant("m2", [{ type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts", old_string: "x" } }]);

function setup(live: boolean) {
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => [] };
  const f = new Foreman(openDb(":memory:"), null, Date.now, policy);
  f.isAlive = () => live;
  const t = f.create({ title: "x", acceptance: ["cmd: true"], ready: true }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { worktree: wt, branch: "b" });
  f.pinLease(t.id, worker, 4242, { session: "11111111", name: "n", sessionId: SID });
  return { f, id: t.id };
}

function writeTranscript(text: string) {
  const p = transcriptPath(cfg, wt, SID);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

describe("readTranscript", () => {
  test("tool calls with their main argument, text, first result line, cost and turns", () => {
    const r = readTranscript(FIRST);
    expect(r.lines).toEqual([
      { kind: "say", text: "Reading the spec first." },
      { kind: "tool", text: "Bash bun test" },
      { kind: "result", text: "3 pass" },
      { kind: "tool", text: "Edit /a/b.ts" },
    ]);
    expect(r.turns).toBe(2);
    expect(r.costUsd).toBeGreaterThan(0);
  });
});

describe("fm logs", () => {
  test("prints a fixture transcript, then follows lines appended later", async () => {
    const { f, id } = setup(true);
    const p = writeTranscript(FIRST);
    expect(taskSessions(f, id, [cfg])[0]).toMatchObject({ role: "worker", live: true, path: p });
    const out: string[] = [];
    let polls = 0;
    const done = printLogs(f, id, {
      follow: true,
      pollMs: 5,
      write: (l) => out.push(l),
      stop: () => ++polls > 40,
    }, [cfg]);
    await Bun.sleep(30);
    expect(out).toContain("> Bash bun test");
    expect(out).toContain("  -> 3 pass");
    expect(out.some((l) => /2 turns, \$0\.\d+ so far/.test(l))).toBe(true);
    appendFileSync(p, assistant("m3", [{ type: "text", text: "All done." }]));
    expect(await done).toBe(0);
    expect(out).toContain("# All done.");
  });

  test("--role filters, and a task with no session says so", async () => {
    const { f, id } = setup(false);
    writeTranscript(FIRST);
    const out: string[] = [];
    expect(await printLogs(f, id, { role: "verifier", write: (l) => out.push(l) }, [cfg])).toBe(1);
    expect(out[0]).toContain("no verifier session");
    const none = f.create({ title: "y", acceptance: ["cmd: true"] }, human);
    expect(await printLogs(f, none.id, { write: (l) => out.push(l) }, [cfg])).toBe(1);
  });
});

describe("board", () => {
  test("the task API includes a running session's recent activity and cost", async () => {
    const { f, id } = setup(true);
    writeTranscript(FIRST);
    const b = startBoard({ foreman: f, port: 0, approver: null, configDirs: [cfg] });
    try {
      const d = (await (await fetch(`${b.url}/api/tasks/${id}`)).json()) as any;
      expect(d.sessions).toHaveLength(1);
      expect(d.sessions[0]).toMatchObject({ role: "worker", live: true, turns: 2 });
      expect(d.sessions[0].costUsd).toBeGreaterThan(0);
      expect(d.sessions[0].lines.at(-1)).toEqual({ kind: "tool", text: "Edit /a/b.ts" });
      const list = (await (await fetch(`${b.url}/api/tasks`)).json()) as any;
      expect(list.tasks.find((t: any) => t.id === id).live).toBe(true);
    } finally {
      await b.stop();
    }
  });
});
