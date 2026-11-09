# D0038. A glob that starts with a wildcard overlaps the folders it can reach, and counts towards risk only from the task's side (2026-11-09)

**Status:** Active

**Context:** `globsOverlap` compared literal prefixes, so a glob with none (`**/*.md`) overlapped nothing it didn't match outright: `**/*.md` and `docs/decisions/**` could run side by side, and a task declaring `**/*.md` got risk "auto" next to a protected `docs/decisions/**` (T-0104). Fixing that both ways has a cost: the default protected list has `**/package.json`, `**/.claude/**` and `**/tsconfig*.json`, which reach into every folder, so every task declaring `src/**` would default to risk "review" and wait for a person.

**Chosen:**
- `globsOverlap` (used by `pathsOverlap`, which keeps tasks apart) is true when either glob starts with a wildcard and can reach into the other's folders: `**` reaches anywhere, other leading segments are matched folder by folder (`*/x.md` reaches `docs/`, `*.md` doesn't), a brace is assumed to reach. A plain path is only ever matched, never reached into.
- `mayTouchProtected` (the default risk, D0008) counts only the task's glob reaching into a protected one (`**/*.md` into `docs/decisions/**`), not a protected glob reaching into the task's folder (`**/package.json` into `src/**`).

**Why:**
- Two tasks that could edit the same file must not run in parallel, so overlap errs towards yes in both directions.
- Default risk is a forecast; the verdict's diff check against the protected paths (D0008) is the guarantee, and it catches a `src/package.json` that an "auto" task added. Counting the protected side's `**` would turn nearly every task into "review" and lose autonomous merges for no added safety.

**Revisit if:** the verdict's diff check stops covering "auto" tasks, or protected globs that start with `**` stop being catch-alls for single file names.
