# foreman

A local task layer for AI coding agents working in parallel git worktrees. Tasks have acceptance checks. A worker claims a task, someone else verifies it, and sign-off depends on risk. There is no server, account or hosted service.

Status: MVP (step M3), plus M6: the launch adapter, the dispatcher, intake, the merge queue, the janitor and a local web board ([D0011](../../docs/decisions/D0011-foreman-dispatch.md)). The rules are in [D0006](../../docs/decisions/D0006-foreman-mvp-rules.md).

## How it works

- **One database per repository**, at `<main checkout>/.foreman/foreman.db` (SQLite, WAL mode). It is found from any worktree through git's shared directory, so every agent sees the same tasks. Add `.foreman/` to `.gitignore`.
- **Every change** is one transaction plus an event in an append-only log.
- **Claims are atomic and expire.** A worker keeps a claim alive with `heartbeat` or `progress`, and an expired claim goes back to `ready`. A claim the dispatcher pinned to a process follows the process instead: kept while it runs, released once it's gone.
- **Verification:** the worker submits a PR and lets go. Someone who didn't work on the task verifies it, recording one result per acceptance check.
- **Sign-off** ([D0008](../../docs/decisions/D0008-risk-from-paths.md)):
  - `auto` tasks are approved once every check passes.
  - `review` tasks also need a person's `approve`.
  - `human` tasks are claimed and finished only by people.
  - **Default risk:** a task is `auto` unless its declared paths touch the `protectedPaths` in `foreman.json` (guardrails, CI, foreman itself).
  - **The diff decides:** when an `auto` task passes, foreman diffs its branch against main. If any protected file changed, or the diff can't be seen, the task goes to a person instead.
- **Reserving numbers:** `reserve <kind>` hands out the highest number on disk or reserved before, plus one. On disk means `docs/decisions/D*` file names for `decision`, and nothing for other kinds, unless `foreman.json` names a source for the kind. The pattern's first capture group is the number, and paths are relative to the repo root:
  ```json
  { "numbers": {
      "decision": { "file": "docs/decisions.md", "pattern": "^## D(\\d+)\\." },
      "migration": { "glob": "db/*.sql", "pattern": "^(\\d+)_" } } }
  ```
  With `file`, the pattern runs over the file's text (multiline). With `glob`, it runs over each matched file's name. An entry replaces the default for its kind. A glob that matches nothing counts as empty (an empty folder is real), but a `file` that doesn't exist or can't be read is refused with its path, so `reserve` never hands out a number that file may already use. A malformed entry (neither or both of `file` and `glob`, or a pattern without a capture group) is refused.
- **Where `foreman.json` is read:** from `origin/main` (else `origin/master`) via `git show`, so a checkout on an old or detached commit still uses the default branch's protected paths, number sources and role rules. Without such a branch (or file there) the working tree's copy is used. The files a number source scans are still read from disk.
- **Exporting:** `export` writes a task as markdown (spec, checks, verdict, history) for the PR that delivers it.

```
draft → ready → claimed → in_progress → in_review → verifying → approved → done
                  ↑                                    │  └→ needs_approval → (person) approved
                  └──────── a check failed ────────────┘
```

## Use

One-time setup, from the repo root: `bun install && bun run link`. This links the `fm` command (and `foreman`, the same thing) into `~/.bun/bin`. After that, run `fm` in any git repository: it uses that repo's tasks, because the database is found from the current directory. Without the link, `bun packages/foreman/src/cli.ts` does the same.

```sh
fm help

foreman add "Add a stage filter" --check "cmd: bun test" --check "the filter shows on /investors" \
  --path "web/src/pages/**" --risk review --ready
foreman next                       # what can be claimed now
foreman claim                      # claim the next ready task (or: foreman claim T-0001)
foreman progress T-0001 --branch t-0001 --note "filter wired"
foreman submit T-0001 --pr https://github.com/me/repo/pull/12 --summary "..."
FOREMAN_ACTOR=verifier-1 foreman verify T-0001
FOREMAN_ACTOR=verifier-1 foreman verdict T-0001 --result "c1:pass:bun test 40 pass" --result "c2:pass:seen on /investors"
foreman approve                    # people only, in a terminal: everything waiting, after one yes
foreman approve T-0001 T-0002      # or just these
foreman merged T-0001              # refused if the PR moved after it was verified
foreman edit T-0001 --add-path "docs/**"   # while working: the holder may only add paths
foreman rework T-0001 --reason "gap found after the verdict"   # back to ready; verify again
foreman reserve decision           # next free Dnnnn, so parallel PRs never clash
foreman policy --actor worker-T-1  # the deny rules foreman.json gives that agent (see Role rules)
foreman export T-0001              # docs/tasks/T-0001.md
foreman merge-queue --once         # merge one approved PR whose checks are green (--dry-run to look)
foreman merge-queue                # the same, every 60 s until stopped (--interval, --settle-seconds 30)
foreman janitor --dry-run          # reclaim, clean up finished tasks, list stuck ones (--stuck-hours 24)
foreman intake "Add a stage filter to /investors"   # a session files it as draft tasks (see Intake)
fm dispatch [--max 3] [--once]     # run workers and verifiers until nothing more can start
fm serve                           # web board: open the link it prints to approve and merge (--port 0: a free port)
```

Every command takes `--json`.

## Merge queue and janitor

Both run as agents. Without `FOREMAN_ACTOR` they act as `merge-queue` and `janitor`.

- **Merge queue** (`merge-queue`, [D0011](../../docs/decisions/D0011-foreman-dispatch.md), [D0012](../../docs/decisions/D0012-merge-queue-conflict-send-back.md)): approved tasks, oldest first. It merges a PR only when:
  - it is a GitHub PR still at the commit that was verified;
  - its checks are green: at least one, all complete, all SUCCESS, NEUTRAL or SKIPPED (optional ones count too);
  - the checks have settled: the same check names on two reads at least `--settle-seconds` apart;
  - GitHub says it is `MERGEABLE`.
- **The merge** is `gh pr merge --merge --delete-branch --match-head-commit <verified sha>`, so GitHub refuses if the head moved. Then the task is marked merged.
- **One merge per pass.** Main has moved, so the other PRs are read again on the next pass.
- **A PR that conflicts with main** (`CONFLICTING`) goes back to `ready`, to merge main and be verified again. Foreman asks GitHub itself first, so anyone may trigger this, but only a real conflict counts.
- **Anything else** is skipped with the reason and tried again next pass. Without `--once` it loops.
- **From the board:** Merge on an approved card runs one pass limited to that task, and Run queue runs one pass (see Board).
- **Janitor** (`janitor`):
  - reclaims expired claims;
  - for done and cancelled tasks, removes the recorded worktree if it is a clean git worktree inside this repo. One with uncommitted changes is kept and reported;
  - releases that worktree's test-kit ports, if `@meta-repo/test-kit` is installed;
  - deletes the task's local branch only if it is already in `main` or `origin/main`;
  - lists tasks in `claimed`, `in_progress`, `in_review` or `verifying` for longer than `--stuck-hours` since they entered that state.

## Board

`fm serve [--port 4499]` runs a web board for the repo's tasks, where a person approves and merges in one click ([D0021](../../docs/decisions/D0021-board-one-click-sign-off.md)). It listens on 127.0.0.1 only and prints one link to its own terminal, `http://127.0.0.1:4499/#t=<token>`. Open that link to approve and merge from the page. `--port 0` picks a free port.

- **The page:** one lane per status, `draft` to `cancelled`, scrolling sideways with snapping (on a phone, one lane per screen, the two that wait for you first). A card shows the id, title, risk, assignee, PR link and how long ago it changed, and its next action: **Approve** (needs approval), **Merge #n** with the PR's checks and mergeability (approved), or what it waits for (`waiting for verifier`, `with worker-1`). Click a card for the spec, the acceptance checks with each one's latest verdict, and the history. `/#T-0001` opens that task. It polls for changes every 2 seconds.
- **One click, then Undo:** Approve, **Approve all** (the needs-approval lane), Merge and **Run queue** (the approved lane) wait 5 seconds with an Undo button before anything is sent. There is no confirm dialog. The result shows on the card: approved, merged, sent back, or skipped with the merge queue's reason.
- **Merging** is the merge queue (see above), not a second implementation. Merge runs one pass for that task only, with the same rules: the verified commit, settled green checks, `MERGEABLE`, and a conflict sends it back. Run queue runs one pass over all approved tasks, so it merges at most one. The checks settle for `--settle-seconds` (30), so a merge answers after about half a minute. One pass runs at a time, and a second request gets 409 `busy`. The merge runs as the person who started the board.
- **Keys:** `j`/`k` move between cards, `Enter` opens, `a` approves, `m` merges, `u` undoes, `/` filters, `Esc` closes or clears the filter, `?` lists them. The filter matches id, title, person, status, risk and PR number.
- **Look:** CSS and JS are inline, with no external assets or fonts, so it works offline. It follows the system's light or dark mode, with thin themed scroll bars (hidden on the lanes until you hover). It works at phone width.
- **API** (read-only JSON):
  - `GET /api/tasks`: all tasks.
  - `GET /api/tasks/:id`: the task, its checks with the latest verdict, and its events.
  - `GET /api/tasks/:id/pr`: the PR's state as the merge queue reads it (checks green, pending or red, mergeable, still at the verified commit), cached for 15 seconds.
  - `GET /api/events?since=<id>`: events after that id.
- **Writes:** `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/merge` and `POST /api/queue/run`. Each needs the header `x-foreman-token: <token>`, and if the browser sends an `Origin` it must be the board's own; otherwise 403. The page sends the header itself. The approver is `FOREMAN_ACTOR` or `USER`, as a person.
- **The token on the page:** browsers never send the part of a URL after `#`, so the server never sees the token in a request line. The page moves it into `sessionStorage` (this tab only), removes it from the address bar, and sends it as the header. Without it, the buttons are disabled with a hint to open the printed link. A new `fm serve` makes a new token, and the page forgets a token the board refuses.
- **From an agent:** started from an agent session (`CLAUDE_CODE_CHILD_SESSION=1` or `FOREMAN_AGENT=1`), or without an interactive terminal (stdin and stdout), the board prints a link without a token, and approving and merging are off, because the agent would read the token from its own output. Like `approve`, this is a guardrail, not a boundary.
- **Safety:**
  - The token is 32 random bytes in hex. It never appears in a page or an API response.
  - A request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>` gets 421, which blocks DNS rebinding.
  - Headers: a CSP of `default-src 'self'` with a per-response nonce for the inline script and style, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `nosniff` and `no-store`.
  - Task text reaches the page only through `textContent`. The initial state is JSON with `<`, `>` and `&` escaped.
  - Trade-off: a script running in the board's own page could read the token from `sessionStorage`. The CSP allows only the page's own nonce'd script, and task text is never parsed as HTML, so there is no way to get one in.

## Agents

- **MCP:** add foreman as a server. This repo's own `.mcp.json` does that:
  ```json
  { "mcpServers": { "foreman": { "type": "stdio", "command": "bun", "args": ["packages/foreman/src/cli.ts", "mcp"] } } }
  ```
- **MCP tools:** `list_tasks`, `next_tasks`, `show_task`, `create_task`, `claim_task`, `heartbeat`, `report_progress`, `submit_task`, `start_verify`, `record_verdict`, `mark_merged`, `reserve_number`, `edit_task`, `rework_task`. There is no approve tool.
- **The PR** ([D0009](../../docs/decisions/D0009-edit-rework-verified-head.md)):
  - **On submit:** a GitHub PR must be on this repo, and its branch must be the task's.
  - **At the verdict:** foreman records the PR's head commit.
  - **On merge:** `merged` is refused if the PR has changed since. Rework and verify again.
- **Identity:** `FOREMAN_ACTOR` names the caller. A command Claude Code runs for the model (`CLAUDE_CODE_CHILD_SESSION=1`) counts as an agent. IDE terminals don't, even though Claude Code sets `CLAUDECODE=1` there. This is a guardrail, not a security boundary: branch protection and the verifier are the hard limits.

## Role rules

`foreman.json` can deny agents things the person's own sessions keep, such as merging or production commands ([D0019](../../docs/decisions/D0019-role-deny-rules.md)). The project's `.claude/settings.json` binds everyone; these bind only sessions with `FOREMAN_ACTOR` set.

```json
{ "roles": {
    "agent":    { "deny": ["Bash(gh pr merge *)", "Bash(ssh *)"] },
    "worker":   { "deny": ["Bash(gh release *)"] },
    "verifier": { "deny": ["mcp__deploy"] },
    "intake":   { "deny": ["Read(data/**)"] } } }
```

- **Entries** are Claude Code permission rules: `Bash(...)`, `Read(...)`, `Edit(...)`, `mcp__server` or `mcp__server__tool`, a tool name. A comma inside a rule isn't allowed, because `--disallowedTools` is comma-separated. Keys starting with `$` are comments.
- **Who gets which:**
  - `agent` applies to every `FOREMAN_ACTOR`.
  - The role comes from the actor's prefix: `worker-T-0042` gets `worker`'s rules too, `verifier-…` gets `verifier`'s, `intake` gets `intake`'s.
  - Any other name gets only `agent`.
  - No `FOREMAN_ACTOR` (a person) gets none.
- **One source:** `foreman policy [--actor name | --role r] --json` prints the rules that apply (`{actor, role, rules: [{rule, role}]}`). The default actor is `$FOREMAN_ACTOR`. The rules come from the main checkout's `foreman.json`, so editing the file in a worktree changes nothing. A rule ending in `:*` right after a word (`Bash(*gamma prod:*)`, the legacy form of `gamma prod *`, which lets `gamma prod:pull` through) gets a warning on stderr naming the rule and the intended form. A malformed block (an unknown role, a key other than `deny`, an entry that isn't a rule) is an error. The guard hook asks this command; `resolvePolicy()` in `src/roles.ts` is the library call.
- **Enforced twice:** agent-kit's guard hook matches the rules against every command and tool call, wrappers included (see [agent-kit](../agent-kit/README.md)). The launch adapter adds them to `--disallowedTools`.
- **Not a security boundary:** a script or an interpreter can still do what a string rule names. See D0019 for the limits.

## Launch adapter

`src/launch.ts` starts a headless Claude Code session (`claude -p`) for one role: `worker`, `verifier` or `intake`. It keeps the person's own setup out of the session.

- **Own config dir:** `CLAUDE_CONFIG_DIR` is `<main checkout>/.foreman/claude-config` by default. It holds only `.credentials.json`, a symlink to `~/.claude/.credentials.json`, never a copy. The person's settings, hooks and memory don't load.
- **Nothing from above the repo:** `--settings` sets `claudeMdExcludes` to every `CLAUDE.md` (also inside a `.claude` folder), `CLAUDE.local.md` and `.claude` rules folder in the directories above the repo root. A repo under the home directory otherwise loads `~/.claude/CLAUDE.md`, `~/CLAUDE.md` and those rules even with its own config dir. `--bare` would lose the login, and `--setting-sources` alone doesn't stop these files.
- **Tools per role**, passed as `--allowedTools`, because the new config dir doesn't trust the workspace and so ignores the project's `permissions.allow`. The project's deny rules, hooks (so the guard hook too) and `.mcp.json` still apply. Edit tools are `Edit`, `MultiEdit`, `Write` and `NotebookEdit`.
  - `worker`: read and edit tools, `Bash`, `Agent`, `Skill`, and foreman's work tools one by one (list, next, show, create, claim, heartbeat, progress, submit, reserve, edit). `start_verify`, `record_verdict`, `mark_merged` and `rework_task` are disallowed, so a worker can't verify or merge.
  - `verifier`: read tools, `Bash`, `Skill`, and foreman's show, list, verify, verdict and heartbeat tools. Edit tools are disallowed.
  - `intake`: read tools and foreman's list, show and create tools. Edit tools, `Bash` and every other foreman tool are disallowed. The adapter can't restrict `Bash` to read-only commands, so intake gets none.
  - **Plus the role rules:** `foreman.json`'s `agent` and role deny rules ([Role rules](#role-rules)) are added to `--disallowedTools`. They are read from the main checkout (the `policyRoot` option changes where). A malformed `roles` block stops the launch.
- **MCP servers:** with the `mcpConfig` option the session gets exactly those servers (`--mcp-config` plus `--strict-mcp-config`), and the project's `.mcp.json` is not loaded. Without it, `.mcp.json` applies.
- **Limits per role:** `--max-turns`, `--max-budget-usd` and a wall-clock timeout.
- **Cleanup:** when a session ends, its process group gets SIGTERM, so leftover shells and servers go too. On timeout it gets SIGTERM, then SIGKILL after a grace period. Sessions still running are killed if foreman exits or gets SIGINT or SIGTERM.
- **Environment:** `FOREMAN_ACTOR=<role>-<taskId>`. `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_CHILD_SESSION` are removed, so the child doesn't think it is nested.
- **Login:** `launch()` refuses to start without `~/.claude/.credentials.json` (the `credentials` option changes the path) unless `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set. A login kept only in an OS keychain can't be shared this way. If the symlink was replaced by a file after a run, the result's `warnings` says so.

```ts
import { launch } from "./src/launch";

const r = await launch({
  role: "verifier",
  taskId: "T-0001",
  cwd: "/path/to/worktree",
  prompt: "Verify T-0001.",
  model: "claude-haiku-5-5", // optional; also maxTurns, maxBudgetUsd, timeoutMs, allowedTools, jsonSchema
});
// r: { exitCode, result, structured, costUsd, turns, sessionId, pid, timedOut, isError, subtype, warnings }
```

`buildLaunch()` returns the command and environment without starting anything.

**Live test:** `bun run live-launch` runs real Claude Code against a fake home with markers in `~/.claude/CLAUDE.md`, `~/CLAUDE.md`, rules above the repo and a user hook. A plain session must see them. A verifier started by `launch()` must see only the repo's own CLAUDE.md, the user hook must not run, the project's own PreToolUse hook must run, and the login must still be a symlink afterwards. It is opt-in and not run in CI; it costs about a cent with Haiku.

## Dispatcher

`fm dispatch [--max 3] [--once] [--model m] [--budget usd]` (`src/dispatch.ts`) runs workers and verifiers through the launch adapter until nothing more can start.

The design and its rules are in [D0011](../../docs/decisions/D0011-foreman-dispatch.md).

- **Slots:** at most `--max` sessions at once, workers and verifiers together. Submitted tasks get a verifier before new tasks get a worker.
- **No clashes:** a ready task waits while its declared paths overlap those of a task that is `claimed`, `in_progress`, `in_review` or `verifying`. A task that declares no paths overlaps every task.
- **A worker per task:** the dispatcher claims the task as `worker-<task>` and makes `.claude/worktrees/<task>` on a new branch `<task>-<title>` from `origin/main`. It records both with `progress`, then starts a worker with the `ship` skill. A task back for rework keeps its worktree, or its branch if the worktree is gone. If the worktree can't be made, the task goes back to `ready`.
- **A verifier when it's submitted:** once the worker has exited and the task is `in_review`, the dispatcher takes it with `start_verify` as `verifier-<task>` and starts a verifier with the `verify` skill in the same worktree. It also verifies other `in_review` tasks whose recorded worktree exists.
- **Leases follow the process:** each session's lease is pinned to its PID (`pinLease`). While the PID lives, the lease doesn't time out; once it's gone, `reclaim` releases the task (`ready`, or `in_review` for a verifier). A new holder ends the pin. The pins live in their own table, so an older foreman on the same database still works.
- **Prompts:** both prompts say not to spawn helper subagents, to give commands `< /dev/null`, and how to reach foreman through the CLI if its MCP tools are missing. The worker's also says the task is already claimed and to install dependencies in the fresh worktree first. Sessions run with `FOREMAN_AGENT=1`, and their stdin is `/dev/null`.
- **One try per run:** each task gets at most one worker and one verifier per `fm dispatch`. A task that failed, or whose worker died, waits for the next run.
- **`--once`:** start what fits now, see those tasks through verification, then stop. **`--model`** and **`--budget`** (USD, per session) go to every session.

Tests use a fake launcher (`Dispatcher`'s `launcher` option). `FOREMAN_LIVE_DISPATCH=1 bun test packages/foreman/test/dispatch.test.ts` also runs one real worker on a throwaway repo (Haiku, under $1).

## Intake

`fm intake "<request>" [--ready] [--model m] [--budget usd]` turns a free-text request into tasks (step M6). It starts an `intake` session through the launch adapter, in the current directory (see [D0011](../../docs/decisions/D0011-foreman-dispatch.md)):

- **What the session can do:** read the code (`Read`, `Glob`, `Grep`) and use foreman's `list_tasks`, `show_task` and `create_task`. Nothing else: no edits, no `Bash`, no other foreman tools.
- **Its foreman:** the session gets this foreman's own MCP server, by the absolute path of its `cli.ts`, and no other server, so it works in a repo whose `.mcp.json` doesn't list foreman. The server runs as `intake-<run id>`, which is what `created_by` shows, and with `FOREMAN_DRAFTS_ONLY=1`, so `create_task` files drafts whatever the model asks.
- **What it is told:** search the board first and report what is already filed (any status but cancelled) as a duplicate; then file each remaining piece of work with a spec, at least one acceptance check and paths. It answers with a `--json-schema` structured result: the ids it filed, the duplicates with a reason, and a summary.
- **What foreman believes:** the board, not the model. The tasks filed are the ones `intake-<run id>` created during the run. An id the model reports but didn't file, a filed task it doesn't report, a duplicate that wasn't on the board before, or a task without checks or paths is listed as a problem.
- **Drafts unless `--ready`:** with `--ready`, foreman marks each filed task ready itself, as the person who ran the command. A task without checks or paths stays a draft.
- **Output:** one line per task filed and per duplicate, then any problems and the cost. Exit 1 if there was a problem (the session failed, ran out of budget or turns, or a check above failed); what was filed is still listed. `--json` prints the whole result.
- **Limits:** `--budget` is the session's `--max-budget-usd` (default $1); turns and time are the intake role's limits (30 turns, 10 minutes).

```sh
$ fm intake "Add a --shout flag to the greet CLI in src/greet.ts that prints the greeting in upper case, with a test."
T-0002  draft  Add --shout flag to greet CLI that prints the greeting in upper case
(intake-9sh7, 10 turns, $0.009)
$ fm intake "Add a --shout flag to the greet CLI in src/greet.ts that prints the greeting in upper case, with a test."
T-0002  already filed: Already on the board in draft: ...
(intake-…, 8 turns, $0.005)
```

**Live test:** `bun run live-intake` builds a scratch git repo with its own `.foreman` database and an `.mcp.json` pointing at this checkout's CLI, runs `fm intake` with a sample request, then runs it again with the same request. The first run must file at least one draft with checks and paths, created by intake. The second must report that task as a duplicate and file nothing. It is opt-in and not run in CI; it costs about two cents with Haiku (`LIVE_TEST_MODEL`, `LIVE_TEST_BUDGET`; `KEEP=1` keeps the scratch repo).
