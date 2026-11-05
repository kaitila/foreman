---
name: verify
description: Verify a submitted foreman task as a fresh agent that did not do the work, checking each acceptance check yourself and recording one verdict per check. Run it in a new session, never in the session that wrote the code.
---

# Verify a task

You are checking someone else's work. You didn't write it, and you don't trust its summary, its PR description or its notes: those are claims, and your job is to test them. Don't edit any file in the repository.

## Steps
1. `start_verify` the task. Foreman refuses if you worked on it. That's correct: stop and say so.
2. `show_task`: read the spec, every acceptance check (`c1`, `c2`, ...) and any earlier failed verdict.
3. Look at the change itself: the PR's diff (`gh pr diff <url>`) or `git diff origin/main...<branch>`.
4. Check every acceptance check yourself, cheapest to falsify first.
   - **`cmd` checks:** run the command and use its exit code. Report the counts it prints.
   - **Statements:** find concrete evidence: the lines of code that make it true, a test that proves it (and that would fail without the change), or a command you ran and its output. A script that exercises the real behaviour is better than reading code; read the script first to judge whether it really tests the statement.
   - A statement you can't confirm with evidence is a **fail**, with the reason. Not being able to run something is not a pass.
   - A test that also fails on main is pre-existing: note it, don't fail the task for it.
5. Check the changed files against the task's `paths`. Anything outside them is a finding.
6. `record_verdict`: one result per check, with `pass` true or false and the evidence in a sentence or two (what you ran or read, and what you saw).

## Report
Per check: pass or fail, and the evidence. Then the weaknesses you noticed even where the checks pass, most serious first: each with where it is, what goes wrong, and when. Out-of-scope remarks go last, marked as such. Don't pad with style nits.

You never approve. If every check passes, foreman decides whether a person still has to sign off.
