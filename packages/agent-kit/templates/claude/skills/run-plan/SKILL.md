---
name: run-plan
description: Take a request that is more than one task from the person's words to finished, verified work without leaving this session - file it as a foreman plan with tasks, start the plan's dispatcher on their yes, watch it, and say what is left for them to sign off. Use when the person says "plan this and run it", "have this built", or asks for work of several tasks to be done by agents.
---

# Run a plan

You are the session the person talks to. You shape the work, start it and watch it. Other sessions do it: the plan's dispatcher runs a worker for each task and a fresh verifier for each submission. So you never do one of the plan's tasks yourself while a dispatcher covers the plan, you never verify one, and you never approve: people sign off.

Talk to foreman through its MCP tools (`create_plan`, `create_task`, `run_plan`, `watch_plan`, ...) or its CLI (`fm plan ...`, `fm help`).

## 1. Shape the plan
- Read enough of the code and docs to split the work well. Search `list_plans` and `list_tasks` first, so you don't file what is already there.
- `create_plan`: a title, a goal, and ordered steps, **each with a check** that says the step is done. Tasks that can run side by side share a step; work that needs an earlier step merged goes in a later one. No dates or estimates.
- `create_task` with `plan` and `step` for each task, as a draft (don't set `ready`):
  - a **spec** a session starting cold can work from: what and why, and what you already found out;
  - **acceptance checks** it will be judged on: `cmd:` for a command that must exit 0, `statement:` for a claim a verifier can test;
  - the **narrowest `paths`** that cover the files it will touch. Tasks with overlapping paths never run at once, so a broad glob makes the others wait.
- Steps already hold the order between them. Use `blockedBy` only for order inside one step.

## 2. Ask the person
Show the plan (`show_plan`): the steps, each task with its checks and paths, and how many sessions will run at once (`max`, default 3). Starting it spends money, so wait for their yes. Change what they ask to change.

On their yes, mark the tasks ready. There is no MCP tool for that, so use the CLI: `fm ready-up <task>` for each. A task with risk `human` stays with the person: say so.

## 3. Start it
`run_plan` with the plan's id (and `max`, `model`, `budgetUsd` if the person gave them). It starts the plan's dispatcher as a background process that keeps running when this session ends, and returns its pid and its log file.
- `started: false` means a dispatcher already covers the plan: nothing was started, watch that one.
- `nothing_to_run` means no task of the plan can start without a person: `show_plan` and `show_task` say what each waits on. Fix that (a draft not marked ready, a blocker) or tell the person.

Tell the person in a line that it runs, and that `claude agents` lists the sessions.

## 4. Watch it
Call `watch_plan` once without `since` for the state and its `next`. Then loop: `watch_plan` with `since` set to the last `next`. Each call returns when something happened, or after its timeout with `timedOut: true` (then just call again). Don't tail the log and don't poll with `sleep`.

Report each thing in `happened` to the person in one line, and act on it:
- **submitted**, **passed**, **approved**, **merged**: say it. Nothing to do.
- **needs_approval**: say which task waits for them on the board (`fm serve`). Keep watching: other tasks may still run.
- **failed**: say which checks failed, with the verifier's evidence. Foreman has already put the task back to `ready` with that evidence for its next worker. It gets **one** more try, in step 5.
- **ended_early**: a session ended without submitting or without a verdict. Its task is free again; like a failed one, it gets one more try in step 5.
- **no_dispatcher**: the dispatcher has ended (nothing is left that could start without a person) or was stopped. Go to step 5.
- **plan_done** or **plan_cancelled**: stop, and report.

`tasks` has each task's status and what it waits on in short; `sessions` has each live session's last lines. Use them to answer "where is it?", not to narrate every call.

## 5. When the dispatcher ends
A dispatcher tries each task once per run. So when it has ended:
- If a task failed verification or lost its session, is `ready` again, and hasn't had a second run from you: `run_plan` again, once, and go back to step 4. Keep a note of which tasks have had their second try.
- A task that fails twice is the person's call: report the evidence of both verdicts and stop retrying it. Don't fix it yourself and don't rewrite its checks to make it pass.

Stop when every task is approved or done, or waits on the person. Then report:
- what is done and merged, and what is approved and waiting to merge;
- **what they have to sign off on the board**, by task id and title (`needsPerson`), with each PR;
- what failed twice or is stuck, with the reason (`show_task` has the path to what it waits on);
- that the dispatcher has ended, or its pid if it still runs.

## Rules
- The person wants it stopped: `stop_plan`. Its sessions stop, and their tasks go back to `ready` or `in_review`; say that work not pushed stays in the worktrees.
- Work you find that the plan lacks: `create_task` into the right step, show it to the person, and mark it ready on their yes.
- Never `start_verify`, `record_verdict` or approve. Never `claim_task` a task of a plan a dispatcher covers.
