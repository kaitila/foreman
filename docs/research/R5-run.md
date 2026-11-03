# R5/R6 check: five tasks from intake to merged

Last reviewed: 2026-10-31 (through D0018)

**Result: pass.** Five real tasks went from a one-line request to a merged PR through foreman alone: `fm intake`, then `fm dispatch --max 3`, then a fresh verifier per task, then the merge queue and the janitor. Three ran at once at the peak. No two running tasks had overlapping declared paths, and there were no port clashes, no merge conflicts, and no decision or migration numbers to renumber. One PR did carry a change outside its task's paths (below). A person wrote the five requests and started the commands; nothing else was done by hand except one workaround for a merge-queue bug (below).

## How it was run

On this repo, on 2026-10-31, from the main checkout at `7e98d0c`:

```sh
fm intake "<request>" --ready --model claude-sonnet-5-5 --budget 0.6     # five times
fm dispatch --max 3 --model claude-sonnet-5-5 --budget 4
fm merge-queue --interval 60 --settle-seconds 30                          # replaced by --once passes, see below
fm janitor
```

The requests were real follow-ups that verifiers had reported on earlier tasks, picked so their files didn't overlap.

## The five tasks

Times are minutes after intake filed the task. Every PR's checks (check, demo, create, docs, secrets, workflows) were green at the verified commit.

| Task | What | PR | Claimed | Submitted | Verified | Merged | Worker | Verifier |
|---|---|---|---|---|---|---|---|---|
| T-0045 | design lint flags CSS named colours | [#37](https://github.com/kaitila/meta-repo/pull/37) | 6 | 9 | 11 | 16 | $0.32 | $0.19 |
| T-0046 | agent-kit warns on omit entries that match nothing | [#36](https://github.com/kaitila/meta-repo/pull/36) | 5 | 8 | 9 | 10 | $0.29 | $0.17 |
| T-0047 | `init` adds `@AGENTS.md` to an existing CLAUDE.md | [#35](https://github.com/kaitila/meta-repo/pull/35) | 4 | 6 | 8 | 12 | $0.23 | $0.23 |
| T-0048 | D0006 says what D0011 changed | [#38](https://github.com/kaitila/meta-repo/pull/38) | 8 | 9 | 9 | 16 | $0.17 | $0.14 |
| T-0049 | foreman README links D0011 | [#39](https://github.com/kaitila/meta-repo/pull/39) | 8 | 9 | 9 | 18 | $0.17 | $0.15 |

- **Intake:** five sessions, 10 to 12 turns each, $0.62 in all. Each filed one task with a spec, 2 to 4 acceptance checks and paths, as `intake-<run>`. None found a duplicate, which was right. All five came out `auto`: none touches a protected path, so they merged without a person's sign-off (D0008).
- **Dispatch:** 10 sessions (5 workers, 5 verifiers) in about 6 minutes of wall time, $2.08. T-0045, T-0046 and T-0047 ran at once; T-0048 and T-0049 started as slots freed. Each verifier ran as `verifier-<task>`, never the worker. Leases were pinned to each session's PID.
- **Total:** $2.70 (intake's and dispatch's own cost reports, not foreman events) and about 30 minutes from the first request to the last merge, most of it waiting for CI and for GitHub to compute mergeability.
- **Janitor:** removed the five worktrees and their merged branches.

## What went wrong, and what was filed

- **The merge-queue loop never saw new approvals.** `fm merge-queue` started before the run printed "nothing approved" every pass while all five were approved; a fresh `fm merge-queue --once` in another process saw them at once. Workaround: fresh `--once` passes, one merge each. Filed as T-0050.
- **GitHub's `UNKNOWN` mergeability costs a pass.** After each merge, the other PRs read `UNKNOWN` for about a minute, so with one merge per pass the five merged over 8 minutes. Working as designed; a shorter interval after a merge would help.
- **The launch adapter's sessions ignore the repo's committed `permissions.allow`,** because their config directory has never been trusted. Expected: the adapter passes `--allowedTools` itself, and deny rules and hooks still apply. Each session printed a warning about it.
- **The janitor kept two old worktrees** (T-0033, T-0037) with uncommitted changes from before this run, as it should.
- **A change outside a task's paths reached main.** T-0045's PR (#37, paths limited to the design kit) also carried a mode change, 100644 to 100755, on `packages/agent-kit/src/cli.ts`, inside T-0046's paths. The cause: `bun install` marks every package `bin` target executable, the file was stored as 100644, and the worker's commit picked the mode change up. The guard only scopes edits and shell writes, not what `git add` stages, so it didn't stop it. The same mode change kept appearing in the main checkout and blocked `git pull`. Filed as T-0052 (store bin targets as 100755, with a test). It merged without a conflict because both sides agreed on the mode.

## Against the checks

- **R5:** five tasks intake → merged, three in parallel, the full history in foreman's events: **pass.**
- **R6:** parallel workers with zero manual renumbering and no port clashes: **partial pass.** It held for three at once, the number T-0036 asked for; the plan's R6 check asks for four, which this run didn't exercise.
