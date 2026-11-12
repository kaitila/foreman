# D0044. Of foreman's source, only the files that enforce sign-off are protected (2026-11-11)

**Status:** Active

**Context:** [D0008](D0008-risk-from-paths.md) made a person approve only guardrail changes, and listed all of foreman's source (`packages/foreman/src/**`) as a guardrail. This repo is foreman, so that covered most work: 99 of 124 tasks were `review`, and 37 of the last 45. The board's layout, plans, the project list and help text all waited for a person after a fresh verifier had passed them. D0008's "Revisit if" named this. Amends D0008.

**Chosen:**
- `foreman.json` here no longer protects `packages/foreman/src/**`. It protects these files:
  - `core.ts`: the state machine, who may do what, the approve rule and the diff check at verdict time;
  - `store.ts`: the database and its append-only event log;
  - `policy.ts`: protected paths, default risk, and which files a PR changes;
  - `roles.ts` and `launch.ts`: the deny rules per role and the limits each session starts with;
  - `queue.ts`: what may merge;
  - `mcp.ts`: the tools agents get (approve is not one of them);
  - `board/server.ts`: the board's approve and merge endpoints and their token;
  - `cli/approve.ts`: `fm approve`, people only.
- Everything else in `packages/foreman/src/` merges on a passing verdict: the board's page and styles, plans, the dispatcher, the janitor, intake, the project list, the kit commands and the other CLI commands.
- Unchanged: `.claude/`, `.github/`, `foreman.json`, agent-kit's templates, `package.json` files, `bun.lock`, `tsconfig`, `AGENTS.md` and `CLAUDE.md` stay protected.
- A test checks that every plain path on the list exists, so a renamed file can't drop off it unnoticed.

**Why:**
- A person's approval is worth the wait where a change moves the limits agents work within. A change to the board's layout doesn't, and a fresh verifier has already checked it against its acceptance checks.
- The diff still decides (D0008): a task filed as `auto` that touches one of these files goes to a person.
- This is weaker than protecting the whole folder. All of foreman runs in one process, so an unprotected file could call the approve rule with a made-up actor, and only the verifier would catch it. That was already true of identity (`FOREMAN_ACTOR` is a guardrail, not a wall, [D0006](D0006-foreman-mvp-rules.md)). The hard limit is still branch protection on main, which this repo doesn't have.

**Revisit if:** a change to an unprotected file ever weakens sign-off and a verifier passes it (then protect that file, or go back to the folder); or enforcement moves into a new file, which must join the list in the same PR.
