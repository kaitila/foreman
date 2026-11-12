# D0046. `fm serve --queue` verifies submitted tasks, and starts no workers (2026-11-12)

**Status:** Active

**Context:** `fm serve --queue` ([D0024](D0024-one-board-for-every-project.md)) ran only the merge queue. Verifiers came from `fm dispatch` ([D0011](D0011-foreman-dispatch.md)), which ends once nothing more can start and gives each task one verifier per run. So a task submitted by an interactive session, or submitted again after the merge queue sent it back for a conflict ([D0012](D0012-merge-queue-conflict-send-back.md)), sat in `in_review` until someone ran `fm dispatch` by hand: on 2026-11-10 two tasks waited about 7 hours that way with the board and its queue running. Amends D0011 (who starts verifiers, and the one-verifier-per-run rule for a long-lived loop) and D0024 (what `--queue` runs).

**Chosen:**
- **A verify pass in the loop.** After each project's merge-queue pass, the `fm serve --queue` loop starts a verifier for every `in_review` task of that project whose recorded worktree exists, as `fm dispatch --verify-only` does: the same code (`Dispatcher` with `verifyOnly`), one instance per project kept for the life of the board. It never claims a ready task.
- **One verifier per submission.** In this loop a task's verifier is counted against its latest `submitted` event, not against the run (`reverify`). A task reworked and submitted again gets a fresh verifier from the same process. A verifier that could not start, or ended without a verdict, is not started again for the same submission: the task stays in `in_review`, where the board shows it, until it is submitted again, the board is restarted, or someone runs `fm dispatch --verify-only`. `fm dispatch` itself keeps one worker and one verifier per run.
- **Limits.** `--max` (default 3) is the number of verifier sessions at once, per project. `--model`, `--budget` and `--print` mean what they do for `fm dispatch`. Stopping the board stops the verifiers it started, and their tasks go back to `in_review`.
- **Never in the way.** A failure in the verify pass is printed and the loop goes on; it runs after the merge-queue pass, in its own try. A project whose merge pass is skipped because a click's pass is running still gets its verify pass.
- **Opt-out.** `fm serve --queue --no-verify` runs the merge queue only.
- **No workers: a conflict send-back is not re-claimed.** The loop does not start a worker for a task the merge queue sent back (or for any ready task). The task waits in `ready` for `fm dispatch`, a plan's dispatcher, or a session that claims it; the worker it gets is told why it came back and to merge main, and once it submits again this loop verifies it.
- **Not in the dispatcher registry.** The loop writes no record ([D0041](D0041-dispatcher-registry.md)). A record with scope `everything` would refuse the whole-board `fm dispatch` ([D0045](D0045-dispatcher-scope.md)), and it starts no workers, so it covers no ready task: `no dispatcher` stays true for them.

**Why:**
- A verifier is the step nobody decides: every submitted task needs one, it changes no code, and its cost is bounded by its budget and by one try per submission. Leaving it to a hand-run command only added hours of waiting. The board with `--queue` is the one process people keep running, so that is where it belongs.
- Counting per submission is what makes a long-lived loop both useful and safe. Per run would verify a task once per board lifetime, so the send-back case this is for would still wait. No count at all would start a session every minute for a task whose verifier can't start.
- Starting a worker is a different kind of act. It writes code and costs several times what a verifier does, and a conflict resolution can go wrong in ways a person may want to see first. `--queue` was asked for to merge; spending on new work without a person asking is what `fm dispatch` is the explicit request for. With a plan dispatcher running (D0045), a sent-back task of that plan is picked up anyway.
- Reusing the dispatcher keeps one rule for what a verifier is given (prompt, tools, lease pinned to its process) and for the session limit.
- Two processes may try to verify the same task (this loop and an `fm dispatch`): `start_verify` is atomic, the loser logs one line and doesn't try that submission again.

**Revisit if:**
- Sent-back tasks still wait hours in `ready` with a board running: then add an opt-in (`--rework-conflicts`) that starts a worker only for a task whose last event is the queue's conflict send-back.
- Verifiers that end without a verdict (a budget, a crash) leave tasks in `in_review` often enough to matter: then allow a bounded number of tries per submission, or flag them on the board.
- The per-project `--max` adds up to too many sessions on a machine with many projects: then make the limit one for the whole board.
