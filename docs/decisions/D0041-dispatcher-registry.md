# D0041. A running dispatcher records itself in the task database (2026-11-10)

**Status:** Amended by D0045

**Context:** [D0011](D0011-foreman-dispatch.md)'s dispatcher was recorded nowhere. The only way to know one was running, with what `--max` and on which tasks, was `pgrep -af "fm dispatch"` and reading its terminal. The board can't show that, and a later step scopes a dispatcher to a plan, which needs somewhere to say so. Amends D0011.

**Chosen:**
- **One row per running dispatcher**, in a `dispatchers` table in the project's foreman database. `fm dispatch` writes it when it starts:
  - its pid, `--max`, and the flags `--once`, `--verify-only` and `--print` (print also when `FOREMAN_LAUNCH=print` chose it);
  - who started it: `FOREMAN_ACTOR` or the person, and `CLAUDE_CODE_SESSION_ID` when a Claude Code session did;
  - its working directory and start time;
  - a `scope`, which is `everything` for now.
- **Each tick updates it:** the sessions running (task, role, pid, background session id) and a last-seen time. A session that starts or ends between ticks updates it too.
- **The table is additive**, like `lease_pids`: created if missing, no schema version bump, so an older foreman on the same database keeps working and ignores it.
- **Never stale, by two rules:**
  - The dispatcher deletes its row when its run ends, fails, or the process exits. It handles SIGINT and SIGTERM by exiting, so the row goes before the launch adapter stops the sessions.
  - A read deletes any row whose pid is not alive, with the same check as pinned leases (`Foreman.isAlive`), and doesn't return it. So a dispatcher stopped with `kill -9` is never reported as running.
- **One read function**, `runningDispatchers` in `src/dispatchers.ts`, for the CLI now and the board next:
  - `fm dispatchers [--json]` lists them: pid, scope, slots in use out of max, flags, starter, age, tasks in flight.
  - `fm list` ends with one line per running dispatcher, and nothing when none runs. `fm list --json` stays the array of tasks.
- **Last-seen is recorded, not judged.** A dispatcher is running if its process is alive; nothing is dropped for a late tick.

**Why:**
- The database is the one place every worktree, the CLI and the board already read, so the registry needs no new file, lock or port.
- Liveness by pid is the rule the leases already use, so there is one notion of "still running" and one function tests replace.
- Dropping on read needs no background sweeper, and works when the dispatcher died too hard to clean up.
- A heartbeat timeout would hide a dispatcher that is alive but slow (a long setup command blocks its tick), which is exactly when a person wants to see it.
- Keeping `fm list --json` an array doesn't break scripts that read it.

**Revisit if:** a pid reused by another process shows a dead dispatcher as running (then also compare the process start time), dispatchers run on another machine or in a container with its own pid namespace, or the board needs history of past dispatchers rather than only the running ones.
