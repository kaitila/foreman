// The dispatcher (D0011) with a fake launcher: no Claude Code runs, sessions are
// promises the test settles. One opt-in live test at the end runs the real thing.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, Foreman, type Task } from "../src/core";
import { branchFor, Dispatcher, gitWorktree, type Launcher, type SessionResult } from "../src/dispatch";
import { actorFor, buildLaunch, type LaunchOptions } from "../src/launch";
import { DEFAULT_PROTECTED, type Policy } from "../src/policy";
import { openDb } from "../src/store";

const dir = mkdtempSync(join(tmpdir(), "foreman-dispatch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const human: Actor = { name: "ada", kind: "human" };
const OK: SessionResult = { exitCode: 0, costUsd: 0.01, isError: false, timedOut: false, result: "done" };

interface Session {
  opts: LaunchOptions;
  pid: number;
  actor: Actor;
  /** Ends the session: the process is gone. */
  end(r?: SessionResult): void;
}

/** A foreman, a fake launcher whose sessions the test ends, and fake PIDs. */
function setup(onLaunch?: (s: Session) => void) {
  let clock = 1_000_000;
  const alive = new Set<number>();
  const policy: Policy = { protectedPaths: DEFAULT_PROTECTED, changedFiles: () => ["src/x.ts"] };
  const f = new Foreman(openDb(":memory:"), dir, () => clock, policy, (pid) => alive.has(pid));
  const sessions: Session[] = [];
  let nextPid = 1000;
  let running = 0;
  let peak = 0;
  const launcher: Launcher = (opts, onSpawn) =>
    new Promise((resolve) => {
      const pid = nextPid++;
      alive.add(pid);
      running++;
      peak = Math.max(peak, running);
      const s: Session = {
        opts,
        pid,
        actor: { name: actorFor(opts.role, opts.taskId), kind: "agent" },
        end(r = OK) {
          alive.delete(pid);
          running--;
          resolve(r);
        },
      };
      sessions.push(s);
      onSpawn(pid);
      onLaunch?.(s);
    });
  const worktrees = (t: Task) => {
    const path = join(dir, `${t.id}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path);
    return { branch: branchFor(t), path };
  };
  const add = (title: string, paths: string[]) =>
    f.create({ title, acceptance: ["cmd: true"], paths, risk: "auto", ready: true }, human);
  const log: string[] = [];
  const dispatcher = (o: { max?: number; once?: boolean } = {}) =>
    new Dispatcher(f, { ...o, launcher, worktrees, pollMs: 5, log: (l) => log.push(l) });
  return { f, sessions, alive, add, dispatcher, log, peak: () => peak, tick: (ms: number) => (clock += ms) };
}

/** What a worker does: submit a PR, then exit. */
const submit = (f: Foreman, s: Session) => {
  f.submit(s.opts.taskId!, s.actor, { pr: `https://example.com/pull/${s.pid}`, summary: "done" });
  s.end();
};

/** What a verifier does: pass every check, then exit. */
const pass = (f: Foreman, s: Session) => {
  const t = f.get(s.opts.taskId!);
  f.recordVerify(t.id, s.actor, t.acceptance.map((c) => ({ check: c.id, pass: true, evidence: "ran it" })));
  s.end();
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("dispatch", () => {
  test("runs at most --max sessions at once and verifies every submitted task", async () => {
    const env = setup((s) => {
      // Each session finishes on a later turn, so several overlap in time.
      setTimeout(() => (s.opts.role === "worker" ? submit(env.f, s) : pass(env.f, s)), 2);
    });
    for (let i = 1; i <= 5; i++) env.add(`task ${i}`, [`src/t${i}/**`]);
    const d = env.dispatcher({ max: 2 });
    const done = await d.run();

    expect(env.peak()).toBe(2);
    expect(d.peak).toBe(2);
    expect(env.f.list().map((t) => t.status)).toEqual(Array(5).fill("approved"));
    expect(done.filter((s) => s.role === "worker")).toHaveLength(5);
    expect(done.filter((s) => s.role === "verifier")).toHaveLength(5);
    for (const t of env.f.list()) {
      const ev = env.f.events(t.id);
      const by = (type: string) => ev.find((e) => e.type === type)?.actor;
      expect(by("claimed")).toBe(`worker-${t.id}`);
      expect(by("verify_started")).toBe(`verifier-${t.id}`);
      expect(by("verified")).toBe(`verifier-${t.id}`);
      // The verifier ran after the worker's session ended, in the worker's worktree.
      const [w, v] = ["worker", "verifier"].map((r) => env.sessions.find((s) => s.opts.taskId === t.id && s.opts.role === r)!);
      expect(v!.opts.cwd).toBe(t.worktree!);
      expect(w!.opts.cwd).toBe(t.worktree!);
      expect(ev.filter((e) => e.type === "lease_pinned").map((e) => e.data.pid)).toEqual([w!.pid, v!.pid]);
    }
  });

  test("never runs two tasks whose paths overlap", async () => {
    const env = setup();
    const a = env.add("a", ["src/a/**"]);
    const b = env.add("b", ["src/a/b.ts"]);
    const c = env.add("c", ["docs/**"]);
    const d = env.dispatcher({ max: 3 });
    d.tick();
    const workers = () => env.sessions.filter((s) => s.opts.role === "worker").map((s) => s.opts.taskId);
    expect(workers()).toEqual([a.id, c.id]);
    expect(env.f.get(b.id).status).toBe("ready");
    expect(env.log.some((l) => l.includes(`${b.id} waits`) && l.includes(a.id))).toBe(true);

    // a is submitted: still in flight (its PR is being checked), so b still waits.
    submit(env.f, env.sessions[0]!);
    await flush();
    d.tick();
    expect(workers()).toEqual([a.id, c.id]);
    const verifier = env.sessions.find((s) => s.opts.role === "verifier")!;
    expect(verifier.opts.taskId).toBe(a.id);

    // a is verified: its paths are free, b starts.
    pass(env.f, verifier);
    await flush();
    d.tick();
    expect(workers()).toEqual([a.id, c.id, b.id]);
  });

  test("a task without declared paths overlaps everything", () => {
    const env = setup();
    env.add("anything", []);
    const narrow = env.add("narrow", ["src/z.ts"]);
    env.dispatcher({ max: 3 }).tick();
    expect(env.sessions.map((s) => s.opts.taskId)).toEqual(["T-0001"]);
    expect(env.f.get(narrow.id).status).toBe("ready");
  });

  test("a worker that dies without submitting lets go of the task, and gets no verifier", async () => {
    const env = setup((s) => setTimeout(() => s.end({ ...OK, exitCode: 1, isError: true, result: "crashed" }), 1));
    const t = env.add("fragile", ["src/f/**"]);
    const done = await env.dispatcher({ max: 1 }).run();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ task: t.id, role: "worker", status: "ready", error: "crashed" });
    const released = env.f.events(t.id).find((e) => e.type === "lease_expired")!;
    expect(released.data).toMatchObject({ reason: "process gone", pid: env.sessions[0]!.pid });
    // Each task gets one worker per run: it isn't started again straight away.
    expect(env.sessions).toHaveLength(1);
  });

  test("--once sees the first batch through verification and starts nothing new", async () => {
    const env = setup((s) => setTimeout(() => (s.opts.role === "worker" ? submit(env.f, s) : pass(env.f, s)), 1));
    const first = env.add("first", ["src/1/**"]);
    const d = env.dispatcher({ max: 1, once: true });
    const run = d.run();
    env.add("second", ["src/2/**"]); // ready after the first pass
    const done = await run;
    expect(done.map((s) => `${s.task} ${s.role}`)).toEqual([`${first.id} worker`, `${first.id} verifier`]);
    expect(env.f.get(first.id).status).toBe("approved");
    expect(env.f.get("T-0002").status).toBe("ready");
  });

  test("workers and verifiers get their own actor, tools, and the lessons in their prompt", () => {
    const env = setup();
    const t = env.add("prompted", ["src/p/**"]);
    const d = env.dispatcher();
    d.tick();
    const w = env.sessions[0]!;
    expect(w.opts).toMatchObject({ role: "worker", taskId: t.id });
    expect(w.opts.baseEnv?.FOREMAN_AGENT).toBe("1");
    expect(w.actor.name).toBe(`worker-${t.id}`);
    for (const lesson of ["don't claim", "bun install", "subagents", "< /dev/null", "submit_task", "FOREMAN_ACTOR=worker-", "one scripted edit", "full check once"]) {
      expect(w.opts.prompt).toContain(lesson);
    }
    const task = env.f.get(t.id);
    expect(w.opts.prompt).toContain(task.branch!);
    expect(w.opts.prompt).toContain(task.worktree!);

    submit(env.f, w);
    return flush().then(() => {
      d.tick();
      const v = env.sessions[1]!;
      expect(v.opts).toMatchObject({ role: "verifier", taskId: t.id, cwd: task.worktree });
      expect(v.actor.name).toBe(`verifier-${t.id}`);
      for (const lesson of ["start_verify", "show_task", "record_verdict", "list_tasks", "subagents", "< /dev/null", "FOREMAN_ACTOR=verifier-", "gh pr checks", "failing or pending"]) {
        expect(v.opts.prompt).toContain(lesson);
      }
      // The verifier's tool list really has foreman's verify tools.
      const allowed = buildLaunch({ ...v.opts, repoRoot: dir, configDir: dir }).cmd;
      const tools = allowed[allowed.indexOf("--allowedTools") + 1]!;
      for (const n of ["start_verify", "show_task", "record_verdict", "list_tasks"]) expect(tools).toContain(`mcp__foreman__${n}`);
    });
  });

  test("a task that can't get a worktree goes back to ready", () => {
    const env = setup();
    const t = env.add("no room", ["src/n/**"]);
    new Dispatcher(env.f, {
      launcher: () => Promise.resolve(OK),
      worktrees: () => {
        throw new Error("disk full");
      },
      log: () => {},
    }).tick();
    expect(env.f.get(t.id)).toMatchObject({ status: "ready", assignee: null });
    expect(env.f.events(t.id).at(-1)).toMatchObject({ type: "released", actor: `worker-${t.id}` });
  });

  test("runs foreman.json's setup in the new worktree before the worker starts, and the prompt drops the install line", () => {
    const calls: string[] = [];
    const env = setup();
    env.add("needs web deps", ["src/w/**"]);
    const prompts: string[] = [];
    new Dispatcher(env.f, {
      launcher: (o) => {
        prompts.push(o.prompt);
        calls.push(`launch ${o.cwd}`);
        return new Promise(() => {});
      },
      worktrees: (t) => ({ ...(() => { const p = join(dir, `${t.id}-s`); mkdirSync(p, { recursive: true }); return { branch: branchFor(t), path: p }; })(), fresh: true }),
      setup: "bun install && bun install --cwd web",
      setupRunner: (cmd, cwd) => (calls.push(`setup ${cmd} @ ${cwd}`), { ok: true }),
      log: () => {},
    }).tick();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toStartWith("setup bun install && bun install --cwd web @ ");
    expect(calls[1]).toStartWith("launch ");
    expect(prompts[0]).toContain("already ran the project's setup command");
    expect(prompts[0]).not.toContain("install its dependencies first");
  });

  test("a failed setup is told to the worker; a reused worktree and no setup keep the old behaviour", () => {
    const run = (o: { setup?: string; fresh: boolean; ok: boolean }) => {
      const env = setup();
      env.add("x", ["src/x/**"]);
      const prompts: string[] = [];
      let ran = 0;
      new Dispatcher(env.f, {
        launcher: (l) => (prompts.push(l.prompt), new Promise(() => {})),
        worktrees: (t) => ({ branch: branchFor(t), path: dir, fresh: o.fresh }),
        setup: o.setup ?? "",
        setupRunner: () => (ran++, o.ok ? { ok: true } : { ok: false, error: "exit 1: boom" }),
        log: () => {},
      }).tick();
      return { prompt: prompts[0]!, ran };
    };
    const bad = run({ setup: "make deps", fresh: true, ok: false });
    expect(bad.prompt).toContain("it failed (exit 1: boom)");
    const reused = run({ setup: "make deps", fresh: false, ok: true });
    expect(reused.ran).toBe(0);
    expect(reused.prompt).toContain("install its dependencies first");
    const none = run({ fresh: true, ok: true });
    expect(none.ran).toBe(0);
    expect(none.prompt).toContain("install its dependencies first");
  });

  test("--max must be at least 1", () => {
    const env = setup();
    expect(() => new Dispatcher(env.f, { max: 0 })).toThrow("--max");
  });
});

describe("leases pinned to a PID", () => {
  const worker: Actor = { name: "worker-T-0001", kind: "agent" };

  test("an alive PID keeps the lease past its timeout; a dead one releases it", () => {
    const env = setup();
    const t = env.add("pinned", ["src/**"]);
    env.f.claim(t.id, worker, 1);
    env.alive.add(42);
    env.f.pinLease(t.id, worker, 42);
    env.tick(10 * 60_000);
    expect(env.f.reclaim(human)).toEqual([]);
    expect(env.f.get(t.id).assignee).toBe(worker.name);
    env.alive.delete(42);
    expect(env.f.reclaim(human)).toEqual([t.id]);
    expect(env.f.get(t.id)).toMatchObject({ status: "ready", assignee: null });
  });

  test("a dead PID releases the lease before it times out; a verifier's goes back to in_review", () => {
    const env = setup();
    const t = env.add("pinned", ["src/**"]);
    env.f.claim(t.id, worker);
    env.f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    const v: Actor = { name: "verifier-T-0001", kind: "agent" };
    env.f.startVerify(t.id, v);
    env.f.pinLease(t.id, v, 7); // never alive
    expect(env.f.reclaim(human)).toEqual([t.id]);
    expect(env.f.get(t.id).status).toBe("in_review");
  });

  test("a pin ends with its holder: the next holder isn't kept by the old PID", () => {
    const env = setup();
    const t = env.add("pinned", ["src/**"]);
    env.f.claim(t.id, worker, 1);
    env.alive.add(42);
    env.f.pinLease(t.id, worker, 42);
    env.f.submit(t.id, worker, { pr: "https://example.com/pull/1" });
    expect(env.f.leasePid(t.id)).toBeNull();
    const v: Actor = { name: "verifier-T-0001", kind: "agent" };
    env.f.startVerify(t.id, v, 1);
    env.tick(2 * 60_000);
    expect(env.f.reclaim(human)).toEqual([t.id]); // timed out: PID 42 was the worker's
  });

  test("only the holder may pin, and only a real PID", () => {
    const env = setup();
    const t = env.add("pinned", ["src/**"]);
    env.f.claim(t.id, worker);
    expect(() => env.f.pinLease(t.id, { name: "someone", kind: "agent" }, 42)).toThrow("held by");
    expect(() => env.f.pinLease(t.id, worker, 0)).toThrow("bad pid");
  });
});

describe("gitWorktree", () => {
  const sh = (cmd: string[], cwd: string) => {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };

  test("makes .claude/worktrees/<task> on a new branch from origin/main, and finds it again", () => {
    const origin = join(dir, "origin.git");
    const root = join(dir, "clone");
    sh(["git", "init", "-q", "--bare", "-b", "main", origin], dir);
    sh(["git", "clone", "-q", origin, root], dir);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], root);
    sh(["git", "push", "-q", "origin", "HEAD:main"], root);

    const env = setup();
    const t = env.add("Add a stage filter!", ["src/**"]);
    const make = gitWorktree();
    const wt = make(t, root);
    expect(wt).toEqual({ branch: "t-0001-add-a-stage-filter", path: join(root, ".claude", "worktrees", "T-0001"), fresh: true });
    expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], wt.path)).toBe(wt.branch);
    expect(sh(["git", "rev-parse", "HEAD"], wt.path)).toBe(sh(["git", "rev-parse", "origin/main"], root));
    // Back for rework: the recorded worktree is reused.
    expect(make({ ...t, branch: wt.branch, worktree: wt.path }, root)).toEqual({ branch: wt.branch, path: wt.path });
    // Worktree gone, branch kept: it comes back on the same branch.
    sh(["git", "worktree", "remove", wt.path], root);
    expect(existsSync(wt.path)).toBe(false);
    expect(make({ ...t, branch: wt.branch, worktree: wt.path }, root)).toEqual(wt);
  });
});

// Opt-in: FOREMAN_LIVE_DISPATCH=1 runs real Claude Code (Haiku, under $1) on a throwaway repo.
test.skipIf(process.env.FOREMAN_LIVE_DISPATCH !== "1")(
  "live: a real worker session runs in its own worktree with its lease pinned to its PID",
  async () => {
    const origin = join(dir, "live-origin.git");
    const root = join(dir, "live");
    const sh = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    sh(["git", "init", "-q", "--bare", "-b", "main", origin], dir);
    sh(["git", "clone", "-q", origin, root], dir);
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], root);
    sh(["git", "push", "-q", "origin", "HEAD:main"], root);
    const f = Foreman.open(root);
    const t = f.create(
      {
        title: "write hello.txt",
        spec: "Create hello.txt containing the word hi. Commit it. No PR: submit with --pr local-1.",
        acceptance: ["cmd: test -f hello.txt"],
        paths: ["hello.txt"],
        risk: "auto",
        ready: true,
      },
      human,
    );
    const done = await new Dispatcher(f, { max: 1, once: true, model: process.env.FOREMAN_LIVE_MODEL ?? "haiku", budgetUsd: 0.5 }).run();
    const worker = done.find((s) => s.role === "worker")!;
    expect(worker.pid).toBeGreaterThan(0);
    const ev = f.events(t.id);
    expect(ev.find((e) => e.type === "lease_pinned")?.data.pid).toBe(worker.pid!);
    expect(f.get(t.id).worktree).toBe(join(root, ".claude", "worktrees", t.id));
    // Whatever the model did, the task isn't left held by a process that is gone.
    expect(["claimed", "in_progress", "verifying"]).not.toContain(f.get(t.id).status);
  },
  10 * 60_000,
);
