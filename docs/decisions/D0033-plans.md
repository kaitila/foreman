# D0033. Plans are ordered steps with a check each, and their progress comes from the tasks (2026-11-09)

**Status:** Active

**Context:** Foreman tracked tasks one by one. Work that spans several, like D0026's six publishing tasks (T-0083 to T-0088), was tied together only by `discovered_from` and a decision file, so nobody could ask the board "how far along is this?". Tasks have had a `parent` field since the start, but nothing reads it. This repo's own rule for plans is ordered steps with a check each, no dates or estimates.

**Chosen:**
- **Plans are their own record,** `P-0001`: a title, a goal and ordered steps, each with a title and a check. A task is in at most one plan, at one step; tasks that can run side by side share a step. Not a parent task: a plan has no claim, lease, PR or verdict, and it must never show up in `next_tasks`.
- **Progress is derived, never stored:** from the step's tasks' statuses (`empty`, `waiting`, `in_progress`, `done`; cancelled tasks don't count), and the plan is done when every step is. Only cancelling is set by hand.
- **Additive tables** (`plans`, `plan_steps`, `plan_tasks`), not a new column on `tasks`, so `SCHEMA_VERSION` stays 1 and an older foreman in another worktree keeps opening the shared database (D0002).
- **Plan events** go in the existing append-only `events` table: plan-wide ones with no task id, `planned`/`unplanned` on the task.
- **Dispatched sessions can't change plans:** `create_plan`, `edit_plan` and `plan_task` are in every role's `--disallowedTools`. A worker can still file a discovered task into a plan with `create_task`.
- The core lives in `plans.ts`, beside `core.ts` rather than in it. The board view (T-0097) and intake filing plans (T-0098) come after.

**Why:**
- Steps with checks keep plans in the same form as the repo's own plan (`docs/research-plan.md`), and a check makes "done" something a person can judge, not a count.
- Stored progress would drift from the tasks the first time one is cancelled, reworked or merged by the queue. Working it out on every read is cheap at this size and always right.
- A parent task would drag in task rules that don't fit (claims, checks, verification, risk) and a status that has to be kept in sync by hand.

**Revisit if:** plans need to nest or depend on each other, a task really belongs to two plans, or reading progress gets slow (thousands of tasks in one plan).
