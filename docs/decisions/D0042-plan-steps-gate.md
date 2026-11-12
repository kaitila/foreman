# D0042. Plan steps gate, and one function says why a task waits (2026-11-11)

**Status:** Amended by D0045

**Context:** The reasons a task didn't start lived in three places and none was shown. `Foreman.ready()` dropped tasks with an unfinished `blockedBy`. The dispatcher skipped tasks whose paths overlapped one in flight and said so only in its own log. And a plan's step order held nothing back: [D0033](D0033-plans.md) made steps a way to read progress, so a ready task in step 3 started beside step 1 unless someone repeated the order as `blockedBy` on every task. A person looking at a waiting task saw at most "blocked by T-x", not what T-x itself waited on. Amends D0033 (steps were display only) and [D0011](D0011-foreman-dispatch.md) (the overlap rule moves out of the dispatcher).

**Chosen:**
- **Steps gate.** A task in step n of a plan can't be claimed until every task in the steps before n that isn't cancelled is done. That holds for `next_tasks`, `claim_task` and the dispatcher, and for a person as for an agent. Tasks in the same step still run side by side. A step with no tasks holds nothing, and neither does a cancelled plan.
- **One function for the direct reasons,** `waitsOn` in `packages/foreman/src/waiting.ts`. Kinds: `draft`, `blocked` (each `blockedBy` task that isn't done; one that doesn't exist counts, as before), `step`, `paths` (overlaps a task that is claimed, in progress, in review or verifying) and `human`. `Foreman.ready()`, `claim` and the dispatcher all read it. No other code holds a copy of the blocker or the overlap rule.
- **`paths` holds the dispatcher, not a claim.** The dispatcher starts a task only when `waitsOn` is empty. `claim` refuses `draft`, `blocked` and `step`, and `human` for an agent, and lets a claim through an overlap, as it did before: a person or their own session may take two overlapping tasks knowingly. `next_tasks` lists such a task with a `waits:` note.
- **The whole path** (`pathOf`): the reasons followed through the tasks they name, to the end, as a tree. Each place it stops says who has to act: `running` (the holder, and whether its session is alive), `needs a person` (waiting for approval, risk human, a draft), `can start` (nothing has picked it up yet: a free ready task, a submitted task with no verifier, an approved task not yet merged) or `stuck` (failed verification or sent back, a cancelled or missing blocker, a cycle). A task reached twice is shown once in full, then as a reference. A loop is reported as a cycle and not followed.
- **The reverse** (`holdsUp`): every task that waits on a task, directly or through others.
- **Where it shows:** `fm show` and `show_task` print the tree, the leaves ("moves when: ...") and what the task holds up; `fm show --path` prints only the tree; `fm list`, `list_tasks` and `next_tasks` carry the short form (`waits: T-0112 <- T-0110 (in progress)`); `--json` has the tree as data.
- **`blockedBy` can be edited** on a draft or ready task (`edit_task` `addBlockedBy` and `removeBlockedBy`, `fm edit --blocked-by` and `--unblock`). An edit that would make a cycle is refused, and so is putting a task in a plan step earlier than a task it is blocked by, since steps gate too.
- Nothing is stored: like plan progress, the reasons and the path are worked out from the tasks on every read.

**Why:**
- The order of steps is the plan's promise. If foreman doesn't keep it, every session that files a plan has to say it a second time as `blockedBy` on each task, and the first one that forgets starts step 3 on top of unfinished step 1.
- Three copies of "can this start?" can disagree: a task `next_tasks` offers and the dispatcher silently skips looks broken. One function, read by all three, can't.
- A direct reason isn't enough to act on. The person needs the thing at the end of the chain: the PR waiting for their approval, the session that died, the draft nobody marked ready.
- An overlap is a guess from declared globs, not a fact about files, so it stays a rule for unattended work. Refusing a person's claim over it would also hold every overlapping task for as long as a PR sits in review.

**Revisit if:** a plan needs steps that overlap in time (start step 2 while step 1 is in review), a claim by hand through an overlap causes merge conflicts in practice, or working the path out on every `fm list` gets slow (thousands of open tasks).
