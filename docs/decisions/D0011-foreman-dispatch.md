# D0011. Foreman runs the loop: dispatch workers, launch fresh verifiers, merge one at a time, reap (2026-10-31)

**Status:** Amended by D0012, D0022, D0037

**Context:** Up to M5, a person (or one session acting as orchestrator) did by hand what foreman should do: pick tasks, start a worker in a worktree, start a fresh verifier, merge approved PRs in order, and clean up. Step M6 of the [research plan](../research-plan.md). It borrows from [R5.1](../research/R5.1-prior-art.md), [R5.1b](../research/R5.1b-delegatus-yylo.md) and [R2](../research/R2-claude-code-codex.md).

**Chosen:**
- **Launch adapter** (`foreman/src/launch.ts`). One function starts a headless Claude Code session for a role (worker, verifier, intake) and returns {result, structured output, cost, turns, exit}. Each session gets:
  - **Its own config directory**, holding only a symlink to the person's login. The person's settings, hooks and memory don't leak into it.
  - **How this was established (2026-10-31, Haiku, about $0.002 per run):**
    - Plain `--setting-sources project,local` still loaded the person's `/root/.claude/CLAUDE.md`, found as an ancestor of the repo.
    - `--bare` lost the login ("Not logged in").
    - The separate config dir kept the login and the project's MCP tools, but still saw the ancestor file.
    - Adding `claudeMdExcludes` made the session answer that no instruction mentioned the marker.
    - T-0010 turns this into a rerunnable live test.
  - **`claudeMdExcludes`** for every CLAUDE.md above the repository: a repo under the home directory otherwise picks up the person's global instructions as project instructions (seen in a test).
  - **Explicit tools**, `--max-turns`, `--max-budget-usd` and a wall-clock timeout that kills the process group.
  - **For a verifier:** no edit tools.
  - **Identity:** `FOREMAN_ACTOR` set to the role and task (`worker-T-0042`, `verifier-T-0042`).
- **Dispatcher** (`fm dispatch`). It claims ready tasks while fewer than `--max` (default 3) are running. It skips tasks whose declared paths overlap a task already in progress. For each task:
  - it creates a git worktree on a fresh branch from `origin/main`;
  - it records the branch and worktree, then starts a worker with the `ship` skill;
  - it pins the lease to the worker's PID, so a timeout alone never hands the task to someone else, only a dead process does (YYLO's rule; revisits D0006);
  - when the task reaches `in_review`, it starts a verifier with the `verify` skill in the same worktree.
- **Merge queue** (`fm merge-queue`). One `approved` task at a time:
  - **Checks must be settled and green:** checks reported on the head, none red (optional ones included), and the set of checks stable across two reads.
  - **Before merging,** foreman confirms the PR is still at the verified commit (D0009), then runs `gh pr merge --merge` and marks it merged.
  - **A PR that conflicts with main** is sent back with rework.
- **Janitor** (`fm janitor`):
  - reclaims expired leases;
  - removes the worktrees and local branches of done and cancelled tasks, and releases their test-kit ports;
  - flags tasks stuck in a state for longer than a limit.
- **Intake** (`fm intake "<request>"`). A session turns a free-text request into one or more tasks, each with a spec, acceptance checks and paths. It searches the board first, so it doesn't file duplicates. The tasks are drafts until a person or the request marks them ready.
- **Board** (`fm serve`):
  - a local web page (127.0.0.1) with lanes, task details and history, and live updates;
  - approving from the page needs the one-time token `fm serve` prints in the terminal, so an agent can't approve through it.

**Why:**
- Every step was proven by hand over 28 tasks first. This automates what worked.
- Each piece is separate, so a person can run one by hand while the rest stays automatic.
- Isolating sessions from the person's own configuration is what D0003 asked for; the claudeMdExcludes test showed how.

**Revisit if:** the M6 check fails, which is five tasks going from intake to merged with three in parallel and no clashes. Also revisit if Claude Code gains a supported way to run sessions without the user's configuration.
