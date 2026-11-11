# D0008. A person approves only guardrail changes; the real diff decides (2026-10-30)

**Status:** Amended by D0009, D0044

**Context:** Arttu: "I dont want to manually approve everything." Every task so far defaulted to `review`, so each one waited for a person after a fresh verifier had already passed it. Amends [D0006](D0006-foreman-mvp-rules.md).

**Chosen:**
- **Protected paths:** a committed `foreman.json` lists them (`protectedPaths`). Here they are `.claude/`, hooks, settings, `.github/`, `.mcp.json`, the security configs, foreman's source and agent-kit's templates. `foreman.json` always protects itself. Without the file, a default list applies.
- **Default risk** for a new task: `review` if its declared paths may touch a protected path, otherwise `auto`. An explicit `--risk` still wins.
- **The real diff decides.** When a verifier passes an `auto` task, foreman gets the PR's own file list (`gh pr diff --name-only`) when the task's PR is a GitHub URL. It doesn't use the branch the worker reported, because a worker could point that at an empty branch (found by the verifier, T-0016). Only without a GitHub PR does it diff the recorded branch against main, which is weaker.

  It escalates the task to `needs_approval`, with an `escalated` event, when either:
  - any changed file is protected, or
  - the diff is unknown or empty. This fails closed.

  An agent can't avoid review by filing a task as `auto`.
- **The protected list also covers what defines the checks and the agents' instructions:** `package.json` files, `bun.lock`, `tsconfig`, `AGENTS.md` and `CLAUDE.md`. A change that weakens the check command, or the rules agents follow, gets a person.
- **`foreman approve`** with no id lists everything waiting and asks one yes. One or more ids approve those.
- **Agent detection** uses `CLAUDE_CODE_CHILD_SESSION=1` (a command Claude Code runs for the model) or `FOREMAN_AGENT=1`, not `CLAUDECODE=1`. Claude Code also sets `CLAUDECODE=1` in IDE terminals, so a person approving from VS Code's terminal was treated as an agent and refused. That is the likely reason an earlier approval never registered.

**Why:**
- A fresh verifier already checks every task against its acceptance checks.
- What a person adds is judgement on changes that move the limits agents work within. If agents could approve edits to their own guard hook, settings, CI or sign-off code, they could loosen them.
- Diffing the branch at verdict time ties the decision to what changed, not to what was claimed.

**Revisit if:**
- Protected changes become most of the work, as they are while the guardrails are being built. Then consider a second, independent verifier as a cheaper stand-in for a person on low-impact protected edits.
- Merges move into a foreman merge queue (M6), which should re-check the diff right before merging.
