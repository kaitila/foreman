# D0012. The merge queue sends a conflicting PR back on GitHub's word, not its own (2026-10-31)

**Status:** Amended by D0031

**Context:** The merge queue of [D0011](D0011-foreman-dispatch.md) sends an approved PR that conflicts with main back to work. `rework` lets only the task's workers or a person do that ([D0009](D0009-edit-rework-verified-head.md)), and the queue is neither: it runs as an agent.

**Chosen:**
- **A separate verb, `sendBackConflict`,** instead of loosening `rework`. Anyone may call it, the queue included, but it acts only on an `approved` task, and only when foreman itself reads the PR from GitHub and GitHub says `CONFLICTING`. Otherwise it is refused.
- **It records a `rework` event** with the fixed reason "conflicts with main: merge main and verify again" and `conflict: true`. The task goes back to `ready` with its branch, and its old verdict no longer counts, as with any rework.
- **The queue merges only a PR at the verified commit that GitHub calls `MERGEABLE`, with `--match-head-commit <verified sha>`,** so GitHub itself refuses if the head moved between the queue's last read and the merge.
- **What counts as green:** at least one check on the head, every one complete, every one SUCCESS, NEUTRAL or SKIPPED (optional ones too, because GitHub's rollup doesn't say which are required), and the same set of check names on two reads at least `--settle-seconds` apart. Anything else, including a state foreman doesn't know, is not green: the task is skipped with the reason and tried on the next pass.
- **One merge per pass.** After a merge, main has moved, so the pass ends and every other PR is read again on the next one.

**Why:**
- Giving the queue's actor name a pass in `rework` would trust a name, and any agent can set `FOREMAN_ACTOR`. Checking the fact can't be faked by naming yourself, and the worst a caller can do is send back a PR that really does conflict, which has to happen anyway.
- A conflict always means a new commit, so a fresh verification is needed whatever happens: sending it back costs nothing that wasn't already lost.

**Revisit if:** branch protection or a GitHub merge queue takes over merging. Also revisit if a conflict should be resolved automatically (merge main, rerun checks, re-verify) instead of going back to a worker.
