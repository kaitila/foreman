// T-0070: a gh that never answers must not stall the board; a merge in progress is a 409 "busy"
// the page retries.
import { expect, test } from "bun:test";
import { startBoard } from "../src/board/server";
import { type Actor, Foreman } from "../src/core";
import { DEFAULT_PROTECTED } from "../src/policy";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };

test("a hung gh times out the PR endpoint with a clear state; other requests are still answered", async () => {
  const f = new Foreman(openDb(":memory:"), null, undefined, {
    protectedPaths: DEFAULT_PROTECTED,
    changedFiles: () => ["src/a.ts"],
    prInfo: () => ({ head: "b", headSha: "s", mergeable: "MERGEABLE" }),
    originRepo: () => "acme/app",
  });
  const t = f.create({ title: "x", acceptance: ["cmd: true"], paths: ["src/**"], ready: true }, human);
  f.claim(t.id, worker);
  f.progress(t.id, worker, { branch: "b" });
  f.submit(t.id, worker, { pr: "https://github.com/acme/app/pull/9" });
  const board = startBoard({
    foreman: f,
    port: 0,
    approver: null,
    prTimeoutMs: 100,
    readRun: () => new Promise<string | null>(() => {}), // never returns
  });
  try {
    const slow = fetch(`${board.url}/api/tasks/${t.id}/pr`).then((r) => r.json());
    const started = Date.now();
    const other = await fetch(`${board.url}/api/tasks`);
    expect(other.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(90);
    const body = (await slow) as { readable: boolean; timedOut?: boolean; reason: string };
    expect(body).toMatchObject({ readable: false, timedOut: true });
    expect(body.reason).toContain("couldn't reach GitHub");
  } finally {
    await board.stop();
  }
});
