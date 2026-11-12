# D0049. `fm dispatch --watch` stays up when nothing can start (2026-11-12)

**Status:** Active

**Context:** `fm dispatch` ([D0011](D0011-foreman-dispatch.md)) ends once nothing of its own is running and nothing more can start. That moment comes often and passes quickly: a task is approved but the merge queue hasn't merged it yet (a pass a minute, plus the settle time), so its dependents are still blocked; a task waits for a person's approval; a task filed or marked ready a minute later. Each time someone had to start the dispatcher again by hand. A plan's dispatcher already waits for its plan ([D0045](D0045-dispatcher-scope.md)), but ends when what is left needs a person, and the whole-board one never waits. Amends D0011.

**Chosen:**
- **`--watch`:** the dispatcher doesn't end when nothing can start. It looks again every 10 seconds (`pollMs`) until Ctrl-C or `fm dispatch --stop`. It works for the whole board and with `--plan` and `--verify-only`. With `--once` it is refused: one keeps running, the other stops after a round.
- **Tries are counted per round, not per run.** Without `--watch` a task gets one worker and one verifier per run, which would leave a long-lived dispatcher ignoring every task that comes back. With it:
  - a verifier per submission, as the `fm serve --queue` loop does ([D0046](D0046-serve-queue-verifies.md));
  - a worker again only after the task was sent back on purpose: a `rework` event (a person's, an agent's, or the merge queue's conflict send-back) or a failed verdict.
- **A worker that didn't finish is not started again.** One that crashed, timed out or ran out of budget leaves its task `ready`, and the dispatcher leaves it there until it is reworked or the dispatcher is restarted.
- **A wait is logged once.** `T-0001 waits: …` is printed when the reason changes, not on every pass, and going quiet is said once each time. This applies without `--watch` too.
- **In the registry** ([D0041](D0041-dispatcher-registry.md)) the record carries `watch`, and `fm dispatchers` shows `--watch`.
- Without the flag nothing changes: `fm dispatch` ends as before.

**Why:**
- The loop that people want is "keep the board moving while I'm away". Ending at the first quiet moment made that a shell loop around the command.
- Starting a worker again after a send-back is what the send-back is for: the task is `ready` with a reason, and the worker is told why it came back. With the board's queue running (D0046 verifies, [D0012](D0012-merge-queue-conflict-send-back.md) sends conflicts back), a conflict is then resolved, verified and merged with nobody starting anything.
- Not retrying a worker that didn't finish keeps the cost bounded. A task whose worker dies at once would otherwise get a new session every 10 seconds. Each session has its own budget, and each task gets one try per deliberate send-back.
- A flag, not the default: scripts and `--once` users rely on the command ending, and an idle process that can spend money should be asked for.

**Revisit if:** tasks often sit in `ready` after a worker died for a passing reason (then allow a bounded number of tries per round); or everyone runs `--watch` (then make it the default and add `--until-idle`); or the dispatcher's open database connection goes stale over days, as the merge queue's did (then reopen it between passes, as the queue does).
