# M8 check: a private app ships five tasks through foreman

Last reviewed: 2026-11-05 (through D0019)

**Check:** an existing private app adopts agent-kit and foreman and ships five real tasks through them.

**Result: passes.** Five real tasks went from a request to a merged, deployed PR. Every merge was made by the merge queue at the commit a fresh verifier passed. A person signed off the three that touched protected paths. The app isn't named here, per this repo's rules: it is an existing private production app (Bun, TypeScript, Postgres, about 2,400 tests), with years of its own agent docs and skills, where every merge to main deploys.

## Setup

- **`init` into the existing repo** ([R1](R1-create-init-sync.md)) added `.claude/settings.json`, the guard hook, the verify skill, `foreman.json` and the install record, and kept the app's own agents, ship skill, AGENTS.md, CLAUDE.md and CI. Two bugs surfaced: it added a stray `D0001` because the app keeps all decisions in one file, and a later `sync` didn't update a changed hook matcher (both filed).
- **Decision numbers** come from the app's single decision log through `foreman.json` `numbers` (from the earlier T-0040).
- **Per-role rules** ([D0019](../decisions/D0019-role-deny-rules.md)) were built during the pilot. The first setup put the app's extra denies (merging, production, `ssh`, real databases, data folders, connectors) in the committed `settings.json`, which took merge-on-green and production commands from the owner's own sessions too. With D0019 they moved to `foreman.json` `roles.agent` (about 300 rules), so only foreman's sessions get them. The owner's omit list keeps the baseline's `ask` on merging and `ssh` from prompting them.
- **The code refuses too.** The first pilot task made the app's CLI and wrapper refuse the real and production databases and blank its paid-API keys whenever `FOREMAN_ACTOR` is set, so a script or interpreter that gets past the string rules still can't reach them.
- **Not done, by the owner's choice:** a passphrase on the deploy key and branch protection on main. The rules above are guardrails, not a wall.

## The five tasks

| Task | What | Risk | Verdicts | Notes |
|---|---|---|---|---|
| 1 | Worker safety in code (the CLI refuses the real database under `FOREMAN_ACTOR`) | review | 3 | CI was red on one test the verifier didn't look at; then a verifier's worktree lacked a nested package's dependencies |
| 2 | Bring an automation doc up to date with the code | auto | 1 | about 10 minutes, request to merge |
| 3 | Remove three aliases of a shared helper | auto | 1 | about 16 minutes |
| 4 | Two copies of an HTML-escape helper become one | review | 1 | waited for sign-off |
| 5 | A graph view: expand a person into their neighbours and fold them again | review | 3 | sent back as conflicting; its decision renumbered after main took the same number |

Tasks 2 to 5 were filed by `fm intake` ($0.52 for four) and run by `fm dispatch --max 3`. Agent sessions cost about $4.30 in all. No agent ran a production command or called a paid API, and no decision number clashed on main.

## What needed a person, and what it became

- **Sign-off** on the three protected-path tasks, by design (D0008). The owner gave it with `fm approve` in their own terminal.
- **Three hand fixes** in the run. Each is now a task:
  - A verifier passed a PR whose CI was red: the verify skill must fail on red CI (T-0060).
  - A fresh worktree only had root dependencies: the dispatcher should run the project's setup command (T-0061).
  - A worker sent back for a conflict resubmitted without merging main: the prompt must say so, and `submit` should refuse a conflicting PR (T-0064).
- **Found along the way:** the guard preferred an older `foreman` on the PATH over the repo's own (T-0056); deny rules missed options placed before a subcommand, as in `gh -R x pr merge` (T-0057); a rule ending in `:*` means "followed by a space" and let `prod:pull` through (T-0059); foreman reads `foreman.json` from the main checkout's files, which must be on main (T-0054); and there is no readable live view of what a dispatched session is doing (T-0065).

## What we learned

- **Permissions belong to roles, not to the repo.** The person who owns a project keeps working the way they did; only foreman's sessions get the limits. One committed settings file can't express that.
- **Defence in depth works best in the app's own code.** String rules over shell commands catch accidents; a refusal inside the CLI catches the rest.
- **Verification must include CI.** Local runs miss environment differences, and CI is the merge gate anyway.
- **Merges deploy, so the queue's one-merge-per-pass pace is a feature.** Parallel work mostly lengthens the merge queue and raises the chance of a conflict.
