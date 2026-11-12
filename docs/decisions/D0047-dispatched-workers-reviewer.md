# D0047. A dispatched worker may spawn one reviewer on a risky task, once foreman counts subagent usage (2026-11-12)

**Status:** Active

**Context:** The worker prompt forbids subagents because "they are cut off when you finish, and their work is lost". [D0029](D0029-faster-sessions.md) keeps a fan-out in `ship` for large or risky changes, but dispatched workers ([D0022](D0022-background-sessions.md)) never get one. Live runs on Claude Code 2.1.322 are in [R5.3c](../research/R5.3c-worker-subagents.md). They found:
- The reason is no longer true. A subagent in a `--bg` session runs in the background, the parent stays `busy` in `claude agents --json` until it has reported, and foreman's watch loop waited for it in every run. Only `claude stop` cuts a subagent off.
- Subagents get the worker's `FOREMAN_ACTOR`, the guard's path limits and the launch's denied tools. The project's agents load.
- Subagent usage is in separate transcript files that foreman doesn't read. Its turn and cost limits missed 19–47% of a session's cost.
- On one small task, a reviewer alone cost 1.5× the solo run and found a bug the solo run's own review had called handled. Test-writer, docs-writer and reviewer together cost 3.1× and added nothing more than the reviewer did.

Amends D0029 ("Dispatched workers already never fan out"). Foreman's limits ([D0022](D0022-background-sessions.md)) keep their rule and gain the subagents' files.

**Chosen:**
- **The ban stays for most tasks, with its real reason.** A dispatched worker on a task of risk `auto` whose `paths` touch no protected path spawns no subagent. The reason the prompt gives becomes the measured one: a subagent costs half as much again or more, and a fresh verifier reviews the task anyway.
- **A risky task gets one `reviewer`.** When the task's risk is `review`, or one of its `paths` overlaps a protected path in `foreman.json` ([D0008](D0008-risk-from-paths.md)), the worker prompt tells the worker to spawn the project's `reviewer` agent once, after its own tests pass and before the full check, and to fix what it confirms. Tasks of risk `human` aren't dispatched, so the rule has nothing to say about them.
  - Foreman decides this from the task, when it writes the prompt. The worker doesn't judge whether its change is "large".
  - The prompt says how it works in a background session: the reviewer runs in the background, the worker ends its turn, and a notification brings the report. The worker doesn't submit the task before the report is in.
- **No test-writer or docs-writer for dispatched workers.** The worker writes its tests and docs itself, as now.
- **First, foreman counts subagent usage.** `launchBg` sums the session's transcript and every `subagents/agent-*.jsonl` under the session's folder, for the turn limit, the cost limit and the cost it records. Until that ships, the ban stays for every task.
- **Nothing else changes:** the watch loop (`status: idle`, twice), the guard and the launch flags stay as they are.

**Why:**
- A protected path or risk `review` is where a missed bug costs most, and where a person signs off after the verifier. A second reader before the PR is cheap next to a round of rework.
- The reviewer was the only agent of the three that found something the worker hadn't, and the cheapest: 9% of the fan-out's cost.
- Handing the tests and docs to subagents made the worker itself dearer (1.6× the whole solo run), because each report wakes it and it re-reads its context. Wall-clock hardly moved either way, so there is no speed to buy.
- A rule foreman can compute from `risk` and `paths` behaves the same on every run and can be tested. "Large" can't be known before the work is done.
- A limit that doesn't count half the spending isn't a limit. Counting comes first so that allowing a subagent never weakens the budget.

**Revisit if:**
- a Claude Code version reports the parent `idle` while a subagent runs, or stops running subagents in the background (the build task's live test checks);
- verifiers keep failing risky tasks for gaps in tests or docs, which would argue for test-writer or docs-writer;
- reviewer findings on risky tasks turn out to be ones the verifier catches anyway, which would argue for the ban everywhere;
- measurements on real tasks in a large codebase put the reviewer's cost far from 1.5× (R5.3c measured one small task, once per variant).
