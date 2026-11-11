# D0037. New decision files don't count as overlapping paths (2026-11-09)

**Status:** Amended by D0043

**Context:** The dispatcher of [D0011](D0011-foreman-dispatch.md) keeps a ready task waiting while its declared paths overlap those of a task in flight. Nearly every task lists `docs/decisions/**`, in case it adds a decision file, so tasks that share nothing else still ran one after another (T-0083 to T-0087, among others). Found while measuring session speed for T-0090.

**Chosen:**
- In `pathsOverlap` (`packages/foreman/src/policy.ts`), a pair of globs that both stay inside `docs/decisions/` (their literal prefix starts there) is not an overlap. Every other pair is checked as before.
- A glob that reaches past the folder (`docs/**`) still overlaps `docs/decisions/**`, and a task that declares no paths still overlaps every task.
- The rule lives only in `pathsOverlap`; prompts still ask for `docs/decisions/**` when a task may add a decision.

**Why:**
- New decision files can't collide: their numbers come from `reserve_number`, and they share no index file: the generated one is no longer committed ([D0040](D0040-no-decision-index.md)).
- Two tasks editing the same existing decision file is rare, and the clash is in prose. The merge queue sends a PR that conflicts with main back to work ([D0012](D0012-merge-queue-conflict-send-back.md)), which handles it.

**Revisit if:** tasks often edit the same existing decision files, or another shared folder (migrations, changelogs) starts serialising tasks the same way.
