// fm serve: the local web board, with the merge queue in the same process under --queue (D0024).
import { Foreman, ForemanError } from "../core";
import type { QueueEntry } from "../queue";
import { type Exit, type Local, type Module, num } from "./context";

export const help = {
  "serve-short": `  serve [--port 4499] [--queue] local web board on 127.0.0.1; approve and merge from the link it prints;
                                --queue runs the merge queue in the same process (see below)`,
  serve: `  serve [--port 4499] [--project name|dir] [--queue [--interval 60] [--settle-seconds 30]]
                                local web board on 127.0.0.1 for every project on this machine (or one);
                                approve and merge from the link it prints; --queue also runs the
                                merge queue for each project shown, a pass every --interval seconds`,
};

async function serve({ o, me }: Local): Promise<Exit> {
  const port = o.port === undefined ? 4499 : Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ForemanError("invalid", `bad port ${o.port}`);
  const reg = await import("../projects");
  // The current repo first (if we are in one), then the registry; a stale entry is skipped, said once.
  const here = reg.projectRoot(process.cwd());
  if ("root" in here) reg.noteProject(here.root);
  const dirs = [...("root" in here ? [here.root] : []), ...reg.readRegistry()].filter((d, i, all) => all.indexOf(d) === i);
  const valid = dirs.filter((d) => {
    const r = reg.projectRoot(d);
    if ("error" in r) console.error(`skipping ${d}: ${r.error}`);
    return "root" in r;
  });
  let named = reg.nameProjects(valid);
  if (o.project !== undefined) {
    const want = o.project;
    const dir = "root" in reg.projectRoot(want) ? (reg.projectRoot(want) as { root: string }).root : null;
    named = named.filter((p) => p.name === want || p.dir === dir);
    if (!named.length) throw new ForemanError("not_found", `no project "${want}" (fm projects lists them)`);
  }
  if (!named.length) throw new ForemanError("invalid", "no projects to show: run this in a repo with a .foreman database, or fm projects add <dir>");
  const { startBoard } = await import("../board/server");
  // An agent that starts the board would read the token from its own output: no approving
  // then. Like `approve`, a person means an interactive terminal too (not a pipe or a log).
  const person = me.kind === "human" && process.stdin.isTTY === true && process.stdout.isTTY === true;
  // A project that needs a newer fm is left off the board, with the reason, rather than stopping it (D0026).
  const projects = named.flatMap((p) => {
    try {
      return [{ name: p.name, dir: p.dir, foreman: Foreman.open(p.dir) }];
    } catch (e) {
      if (e instanceof ForemanError && e.code === "too_old" && named.length > 1) {
        console.error(`skipped ${p.name}: ${e.message}`);
        return [];
      }
      throw e;
    }
  });
  let board;
  try {
    // --queue: the merge queue runs in this process too, as `fm merge-queue` would.
    const queueActor = process.env.FOREMAN_ACTOR ? me : { name: "merge-queue", kind: me.kind };
    const prefix = projects.length > 1;
    const autoQueue = o.queue
      ? {
          actor: queueActor,
          intervalMs: num(o.interval, 60, "--interval") * 1000,
          onPass: (name: string, r: QueueEntry[]) => {
            const lines = r.map((e) => `${e.id}  ${e.action.padEnd(15)} ${e.reason}`);
            const text = lines.join("\n") || "nothing approved";
            console.log(prefix ? text.split("\n").map((l) => `${name}: ${l}`).join("\n") : text);
          },
          onError: (name: string, e: unknown) => console.error(`${name}: merge queue pass failed: ${e instanceof Error ? e.message : String(e)}`),
        }
      : undefined;
    board = startBoard({
      projects,
      port,
      approver: person ? me : null,
      queue: o.queue ? { settleSeconds: num(o["settle-seconds"], 30, "--settle-seconds") } : undefined,
      autoQueue,
    });
  } catch (e) {
    // Another fm serve on this port: say so and point at it, instead of failing.
    const url = `http://127.0.0.1:${port}`;
    if (port !== 0 && (e as { code?: string }).code === "EADDRINUSE") {
      const other = await fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ board?: string }>, () => null);
      if (other?.board === "foreman") {
        if (o.queue) {
          // The person asked for the queue: don't let the other board's link hide that it isn't running.
          throw new ForemanError(
            "invalid",
            `a foreman board is already running on port ${port} (${url}), so the merge queue did not start: stop that board and run this again, pass --port for another board, or run fm merge-queue`,
          );
        }
        console.log(`a foreman board is already running on port ${port}: ${url}`);
        console.log("use its link (the token was shown in the terminal that started it), or pass --port for another board");
        return 0;
      }
      throw new ForemanError("invalid", `port ${port} is taken by something that isn't a foreman board; try --port`);
    }
    throw e;
  }
  console.log(`projects: ${projects.map((p) => p.name).join(", ")}`);
  if (board.queueRunning) console.log(`merge queue: on, a pass every ${num(o.interval, 60, "--interval")} s (Ctrl-C stops it and the board)`);
  if (board.token) {
    // The token rides in the fragment, which the browser keeps to itself (D0021).
    console.log(`foreman board: ${board.openUrl}`);
    console.log("open this link to approve and merge from the page; it is shown only here");
  } else {
    console.log(`foreman board: ${board.url}`);
    console.log("read-only: not a person at an interactive terminal, so approving and merging from the page are off");
  }
  return null;
}

export const local: Module["local"] = { serve };
