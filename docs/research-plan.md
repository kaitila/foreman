# foreman — revised plan: open-source, agent-native project starter

## Context

This project is a starter for codebases where most of the code is written by AI coding agents. It grew out of a private, ~95% agent-written production app ("gamma" below: Bun, TypeScript, Drizzle/Postgres, React/Vite). That app's setup works well from "code written" to "PR merged", but it has no task record before work starts, no sign-off after merge, guardrails that exist only as prompts, and decision numbers that clash across parallel PRs.

Constraints:
1. **Open source** (MIT), usable by anyone, with no dependency on any hosted service at runtime. A package registry is only an install channel ([D0026](decisions/D0026-publish-foreman.md)).
2. **The task layer is custom and modular**, not tied to an external tracker.
3. **Agents run locally** through Claude Code, possibly on a VPS. Other agent tools (Codex) come later ([D0005](decisions/D0005-claude-code-only-for-now.md)); keep agent-specific code behind one adapter. No cloud orchestration required.
4. **Stack:** an agnostic core (the agent layer) plus one reference stack (Bun/TS/Postgres).

Gamma is the source of patterns and a private pilot. The template must stand on its own.

## Task store: SQLite vs markdown 

Markdown files in git have downsides that matter here:
- **Each worktree has its own copy of `tasks/`.** An agent marking a task "doing" on its branch is invisible to everyone else until merge. That breaks claiming and dispatch, which is the whole point.
- **No atomic claim or lease.** Two agents can take the same task.
- **Merge conflicts.** Parallel agents editing one task file, or an index file, collide. This is the same failure as gamma's D-number clashes.
- **Every status change is a commit.** That is noise, and history gets mixed into the code PRs.
- **Queries** like "ready, unblocked, no path conflict" mean parsing every file.

What markdown does well is human review in PRs, readability with no tooling, and portability.

**Recommendation: SQLite is the live source of truth, and markdown is a projection.**
- The DB lives in the *main checkout's* `.foreman/foreman.db` (gitignored, WAL mode), resolved from any worktree via `git rev-parse --git-common-dir`. Every worktree and agent sees one state. Claims are transactions with leases, and an append-only `events` table keeps the history.
- Agents never touch the DB directly. They go through the `foreman` CLI or MCP server, so another agent tool can plug in later.
- A task's **spec and acceptance checks** are exported to `docs/tasks/T-<id>.md` inside the PR that delivers it, so reviewers see what was asked next to what was built. `foreman export` and `foreman import` rebuild the DB from git if it's lost.

This is close to what Beads converged on (a DB plus a git-tracked export). R5.1 checks that before we commit to it.

## Target architecture

```
foreman/                            (MIT, public)
  packages/
    foreman/        task layer: SQLite store + CLI + MCP server + dispatcher + local web UI
    docs-check/     drift checker with pluggable "registries" (env, CLI, routes); decisions + links + paths
    agent-kit/      installer for AGENTS.md skeleton, .claude/ config, subagents, skills, hooks, deny-list
    test-kit/       (ref stack) slot DBs per worktree, freshDb, fake fetch, fake LLM
  presets/
    core/           stack-agnostic files every project gets (AGENTS.md, docs/, .github/, guardrails)
    bun-ts-postgres/  reference app stack (gamma-shaped: Bun, Drizzle, React/Vite, Docker+Caddy)
  create/           `npx/bunx create-<name>` (new project) and `<name> init` (add to an existing repo)
  docs/             own decisions (one file each), research findings, design docs
  examples/demo-app/  generated from the ref preset, kept green in CI as the end-to-end test
```

**Modularity:** each package is usable alone. `agent-kit` without `foreman` works, and `foreman` works in any repo. The pieces connect through files and the CLI/MCP, never through imports between packages.

## Foreman design (core of the project)

- **Task model:**
  - `id`, `title`, `spec` (md), `acceptance` (list of checks: a command to run or a statement for the verifier), `paths` (globs it may touch), `risk`, `status`, `parent`, `blocked_by`, `assignee`, `worktree`, `branch`, `pr`, `reserved_ids`, `post_merge` (steps plus who confirms), `created_by`.
  - `risk` is one of `auto` (self-merge on green), `review` (a human approves), `human` (a human does it).
  - `status`: draft → ready → claimed → in_progress → in_review → verifying → done, plus blocked and needs_human.
  - `created_by` is a human or an agent session.
- **Roles.** Each is a prompt + skill + CLI verbs, run by Claude Code locally:
  - **Intake:** free text from a human (CLI or web UI) or an agent ("found while doing X") → dedupe search → clarifying questions only when needed → spec + acceptance → split into tasks.
  - **Dispatcher:** picks ready tasks, checks path overlap and concurrency caps, reserves decision and migration numbers, creates the worktree and slot, then launches a worker headless (`claude -p` or `codex exec`) or prints the command for a human-run session.
  - **Worker:** the `ship` flow (code → parallel test, docs and review subagents → gate → PR). It reports through `foreman` MCP verbs: `claim`, `progress`, `submit`.
  - **Verifier:** a fresh context checks the PR against the acceptance checks and runs the commands. It never trusts the worker's claim.
  - **Sign-off:** `auto` tasks merge on green. `review` tasks wait for an approval in the UI or CLI. Post-merge steps stay open until someone confirms them.
  - **Janitor:** reaps merged or abandoned worktrees, slots and branches, and expires stale leases.
- **Runtime:**
  - `foreman serve` is one local process: the HTTP API, the MCP server (stdio and HTTP) and a small web board with live updates.
  - It needs no account and no cloud. The same process runs on a VPS behind auth.
  - Spend controls: a per-task turn/cost budget, a global concurrency cap and a kill switch.
- **Agent hooks:** `SessionStart` injects the claimed task. `PreToolUse` blocks edits outside the task's `paths` (this is gamma's open item A5). `Stop` runs the fast gate and posts progress. Equivalents for Codex are mapped in R4.

## Research tracks (each ends in a decision file + `docs/research/R<n>.md`)

| Track | Key questions | Check |
|---|---|---|
| **R1 Distribution** | `create-*` generator vs template repo; `init` into existing repos; how projects take updates (versioned packages and a `sync` command that opens a PR) | A fresh project and an existing repo both get set up and pass CI |
| **R2 Agent docs** (Codex part paused, D0005) | AGENTS.md shape (short, imperative, Always/Ask/Never); CLAUDE.md = `@AGENTS.md`; what Codex supports today (AGENTS.md, skills, hooks, MCP, subagents) vs Claude Code; one source → both | The same 5 tasks succeed in Claude Code and Codex on the demo app |
| **R3 Decisions + docs-check** | One file per decision, with IDs reserved by foreman so parallel PRs can't clash; port gamma's `scripts/docs-check.ts` as a package with plug-in registries | Gamma's 178 decisions convert losslessly (private test); the demo passes |
| **R4 Guardrails, security, CI** | Committed deny-list baseline (push to main, force-push, `--no-verify`, reading `.env*`, `rm -rf`); hooks for path ownership and secret scan; CI with gitleaks, osv-scanner, semgrep/CodeQL, Trivy, Renovate, PR template, CODEOWNERS, branch protection; SECURITY.md; Codex sandbox and approval-mode equivalents | An adversarial agent run against the demo can't push to main, read secrets, or edit outside its task's paths |
| **R5 Foreman** | R5.1 run each of Beads, Backlog.md, Vibe Kanban and claude-code-action on one task, then record what to borrow and whether foreman is still needed; R5.2 finalise the schema and state machine; R5.3 headless worker launch for Claude Code and Codex; R5.4 MCP verb set; R5.5 the UI | 5 tasks in the demo go intake → merged → signed off with 3 running in parallel, and the full history is in `events` |
| **R6 Parallel isolation** | Generalise gamma's slots (DB, ports, cookies per worktree) as a preset feature; worktree lifecycle owned by foreman | 4 parallel workers with zero manual renumbering or port clashes |
| **R7 Test + eval kit** | Port gamma's `freshDb`, `cachedFixture`, `installFetch`, `setLlm` and affected-tests selection; add Playwright e2e and an LLM eval harness (golden sets, budgeted real-model runs) | Demo CI under 5 min with unit, DB, e2e and eval examples |
| **R8 Design kit** | A tokens file as the single source; lint against raw values; minimal components; a screenshot design-critic subagent (gamma's `report-critic` generalised) | Re-skin the demo by editing one tokens file; lint catches a raw hex |

## Order of work (each step gated by its check)

| Step | What | Check |
|---|---|---|
| M0 | Repo skeleton: `AGENTS.md`, `README.md`, D0001, this plan, `LICENSE` (MIT), `.gitignore` (`.foreman/`), `CONTRIBUTING.md` | No private names or services referenced |
| M1 | Public GitHub repo, a minimal CI job (markdown link check) added via PR | CI green on a PR; merged via `gh pr merge --merge` |
| M2 | R5.1 prior-art survey + R2 Codex capability check + CI options (R4 part) | Findings and decisions D0002–D0004 written (done 2026-10-30; hands-on trials still open) |
| M3 | Foreman MVP: store, CLI, MCP (`create/list/claim/progress/submit/verify/approve`), with the repo using it for its own tasks from here on | Meta-repo's own next tasks are tracked in foreman (done 2026-10-30, D0006) |
| M4 | agent-kit + R4 guardrails + CI template | R4 check passes on the demo |
| M5 | docs-check + test-kit packages, ref preset, `examples/demo-app` | Demo boots, CI under 5 min |
| M6 | Foreman dispatcher, verifier, janitor, web UI | R5 + R6 checks pass |
| M7 | `create` / `init` / `sync` + design kit | R1 + R8 checks pass |
| M8 | Private pilot: gamma adopts agent-kit + foreman (not in the public repo) | Gamma ships 5 real tasks through foreman |
| M9 | Publish and rename ([D0026](decisions/D0026-publish-foreman.md)): `@foreman-kit/*` packages released from a tag, the project named foreman, `fm init` sets up foreman alone with the kit as opt-in pieces, sync by version | On a machine with no checkout: `bun add -g @foreman-kit/foreman`; `fm init` in a repo without `package.json` gives a working `foreman` MCP server and task flow; `fm create` makes a project whose CI installs the kit packages by version and passes; `fm sync` moves an M7-era project off its tarballs |

## Verification

- Each track's check is run, and its result goes into `docs/research/R<n>.md`. Nothing is marked done on a claim alone.
- `examples/demo-app` is the permanent end-to-end test. CI regenerates it from the preset and runs its full suite.
- The final check is a fresh machine: `bun add -g @foreman-kit/foreman`, `fm create my-app`, then `fm serve`. Give intake a one-paragraph feature idea, and it should reach a merged, verified PR using Claude Code workers, with only approval clicks from a human.
