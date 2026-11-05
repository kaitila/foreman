---
name: ship
description: Take a foreman task from claim to a submitted PR with green checks, using parallel test, docs and review agents. Use for any task that changes code, or when the user says "ship it".
---

# Ship a task

Many of these run at once, each in its own worktree. The user hands over a task and comes back to a submitted PR or one clear question. So don't stop to ask what a sensible default answers: note the assumption in the PR. Ask only for what is really the user's to decide (production, money, policy, or a conflict with someone else's deliberate change).

The project's commands are in `AGENTS.md` ("Commands"): the full check, affected tests, typecheck, docs check. Use those. If one you need is missing, ask once and add it to `AGENTS.md` in the same PR.

Talk to foreman through its MCP tools (`claim_task`, `report_progress`, `submit_task`, ...) or its CLI, under one `FOREMAN_ACTOR` for the whole task. You never verify or approve your own task: a fresh verifier and, for protected paths, a person do that.

## 1. Claim and isolate
- `claim_task` (a given id, or the next ready one). If the claim is refused, stop and say why.
- Read the task (`show_task`): its spec, its acceptance checks, its `paths`. The checks are what you'll be judged on, so read them before you write code.
- Work in your own git worktree, branched from the latest `origin/main`. If the project gives each worktree its own database or ports, use them.
- `report_progress` with the branch and worktree. Foreman needs the branch to find your PR's changes.

## 2. Write the code
- Read the doc for the area you're changing, and the decisions it cites, before you change it.
- Stay inside the task's `paths`; the guard hook refuses edits outside them. Work you find that's outside them is a new task: `create_task` with `discoveredFrom` set to this one. Search `list_tasks` first so it isn't a duplicate.
- Typecheck, then commit, so the agents in step 3 see a stable diff. `report_progress` with one line.

## 3. Fan out: one message, three agents
Spawn **test-writer**, **docs-writer** and **reviewer** in a single message so they run in parallel. Each starts cold, so give each:
- the task in the user's words and its acceptance checks
- what you changed and why: files, behaviour, the choices you made
- for docs-writer: whether there's a decision to record, and its gist in one sentence

They split the work by path: test-writer edits tests and is the only one that runs them; docs-writer edits docs; reviewer only reads. Don't edit their paths or run the tests while they work.

Skip the fan-out for a small, self-evident change (a copy fix, one condition): run the typecheck and the area's tests yourself and go to step 5.

## 4. Fold in their reports
- A code bug from test-writer or a finding from reviewer: fix it, then send test-writer a message (by name, so it keeps its context) to rerun, until the tests pass.
- Reviewer says "needs security-review", or you touched auth, sessions, secrets, CI or deploy files: run the `security-review` skill and fix what it confirms.
- docs-writer says the code looks wrong: fix the code, or tell it to document the behaviour as intended.
- Commit everything. `report_progress`.

## 5. Gate
Before pushing: typecheck, the docs check, and the affected tests must pass. A failure that also fails on main: say so in the PR, don't hide it.

## 6. Sync with main
- Fetch and **merge** `origin/main` into your branch. Never rebase a pushed branch, never force-push.
- Numbers that must be unique (decision files, migrations): take them from foreman's `reserve_number`, never by counting files yourself.
- Generated files: regenerate them, don't hand-merge.
- Other conflicts: keep both sides' intent. If the conflict is in code another task changed on purpose and the right merge isn't clear, that's the one question to ask.
- Rerun the step 5 gate if the merge brought anything in.

## 7. Open the PR
Push your branch and open a PR against main. Title: what changed, in plain words. Body:
- `## What and why`
- `## Decision` (if there's one)
- `## Review findings`: what the agents found and how each was settled
- `## Assumptions`: defaults you chose instead of asking
- `## For the owner`: commands or steps only a person can do (production, accounts)
- `## Checks`: the gate results as counts, and any failure that also fails on main

Wait for CI in the background. Never submit red.

## 8. Submit
`submit_task` with the PR URL and a summary that says, for each acceptance check, what you did and how you showed it. You let go of the task here. Don't merge it yourself unless the project's rules say a passing verifier is enough for this task; foreman says which (`approved`, or `needs_approval` for a person).

## 9. Report
To the user: the PR link and state, the task id and its foreman status, what the agents found and what you did about it, and anything left for a person.
