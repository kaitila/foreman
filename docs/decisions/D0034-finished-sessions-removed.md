# D0034. A done or cancelled task's background sessions are removed automatically, whatever happened to its worktree (2026-11-09)

**Status:** Active

**Context:** [D0022](D0022-background-sessions.md) runs workers and verifiers as Claude Code background sessions in the person's own sessions list, and had the janitor `claude rm` them once the task is done or cancelled. It did that only while removing the task's worktree, so a worktree that was gone, outside the repo or dirty left its sessions behind. Nothing ran the janitor unless a person typed `fm janitor`. Finished verifier sessions piled up until the person removed them by hand. Amends D0022's "a stopped session stays … until the janitor runs `claude rm`".

**Chosen:**
- **Every done or cancelled task's recorded sessions are removed** (the session ids on its `lease_pinned` events), separately from its worktree. A session `claude rm` reports as already gone ("No job matching") counts as removed; any other refusal is tried again next time. Each removal is recorded as a `sessions_removed` event on the task, so a session is removed once.
- **It runs on its own:** on every `fm dispatch` tick and after every pass of the `fm serve --queue` loop, as well as in `fm janitor`. A failure never breaks a tick or a pass.
- **It never gets in the way.** A session still running (its lease's process is alive, e.g. a worker on a task just cancelled) is left until it ends. A run removes at most 5 sessions; the first failure that isn't "already gone" ends it and pauses removals for 10 minutes, so a backlog after an upgrade or a stuck `claude` can't stall a dispatcher tick or the board. `claude rm` runs with the same cleaned environment as foreman's other `claude` calls, and a task with nothing left to remove isn't looked at again.
- **`FOREMAN_KEEP_SESSIONS=1` turns it off.** Under `bun test` it does nothing unless a test gives it a runner, so a test never removes a real session.
- **Helper agents are stopped too:** the ship skill says to stop a helper once its report is folded in and it won't be messaged again.

**Why:**
- The person's sessions list is shared with all their other work. A finished foreman session is noise there: nobody attaches to or resumes a task that is done.
- The task's events keep the record that matters: claims, progress, verdicts with their evidence, the PR and merge. The session transcripts, and the turn and cost figures read from them, are not kept.
- Tying removal to the worktree made it depend on something unrelated, and a cleanup that needs a person to run it doesn't happen.

**What it costs:** once a task is done or cancelled, its sessions are gone from `claude agents`, `claude attach` and `claude --resume`, and `fm logs <task>` and the board's session panel can no longer read their transcripts.

**Revisit if:** people need old transcripts after a task ends (keep them for N days first), or Claude Code adds archiving, which would hide sessions without deleting them.
