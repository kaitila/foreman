# D0001. Research first, then template; SQLite-backed task layer (2026-10-30)

**Status:** Amended by D0026

**Chosen:**
- Build by following [the research plan](../research-plan.md): eight research tracks (R1–R8) and gated steps (M0–M8).
- Each piece is proven on a real codebase before it goes into the template.
- The project is MIT-licensed and depends on no hosted service.
- The core is stack-agnostic, with one reference stack (Bun/TS/Postgres).
- The task layer keeps live state in SQLite in the main checkout and exports each task's spec to markdown in the PR that delivers it.
- Decisions are one file each, numbered `Dnnnn`.

**Why:**
- The codebase this grew from works from code to merged PR. It has no task record before the branch, no sign-off after merge, guardrails that exist only as prompts, and decision numbers that clash across parallel PRs. Copying it as-is would copy those gaps.
- Markdown-only tasks split state across worktrees, can't be claimed atomically, and conflict on merge. SQLite gives one shared state, and the markdown export keeps the review trail in git.

**Revisit if:** the prior-art survey (R5.1) shows an existing open-source tracker already covers dispatch and sign-off well enough to build on.
