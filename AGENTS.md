# foreman

A starter for projects where AI coding agents (Claude Code; other tools later, see D0005) write most of the code: agent docs, guardrails, CI, test and design kits, and a task layer (also called foreman, `packages/foreman`) that turns requests into agent work and tracks it to sign-off. Its packages are published as `@foreman-kit/*` (D0026).

## Where things are
- `docs/research-plan.md`: the plan. Tracks R1–R8, steps M0–M8, each gated by a check.
- `docs/decisions/`: one file per decision, `Dnnnn-short-slug.md`.
- `docs/research/`: findings, one file per track (`R5.md`), written when the track's check runs.
- `packages/foreman/`: the task layer ([README](packages/foreman/README.md)). The board's design system: `docs/board-design.md`.
- `packages/agent-kit/`: guardrail baseline and templates ([README](packages/agent-kit/README.md)). This repo runs its own baseline (`.claude/settings.json`).
- `packages/docs-check/`: keeps the docs true to the code ([README](packages/docs-check/README.md)).
- `packages/foreman/src/kit/`: `fm create`, `init` and `sync`: start a project from a preset, add the kit to a repo, take the kit's updates ([KIT.md](packages/foreman/KIT.md)). agent-kit's templates and the presets ship inside the foreman package (D0032).
- `packages/design-kit/`: tokens file, design lint and screenshots ([README](packages/design-kit/README.md)).

## Commands
- Test Postgres (once): `docker run -d --name metarepo-pg -e POSTGRES_USER=metarepo -e POSTGRES_PASSWORD=metarepo -p 127.0.0.1:5544:5432 postgres:16 -c fsync=off`. Database tests skip without it locally and fail without it on CI.
- `bun install`, then `bun run check` (typecheck, docs check, the board's design lint, tests). `bun run link` once makes the foreman CLI available as `fm`. CI runs the same command, plus `bun audit`, gitleaks and zizmor.
- `rm -rf` is denied here: use the tool's own clean command (e.g. `bun install --force`) or ask.
- A guard hook (`packages/agent-kit/templates/claude/hooks/guard.ts`, which `.claude/settings.json` runs in place) checks every command and edit. With `FOREMAN_ACTOR` set, edits must stay inside your claimed task's `paths`.
- Change the kit's hooks, skills and agents in `packages/agent-kit/templates/claude/`; this repo's `.claude/skills` and `.claude/agents` are links to them. Claude Code won't let an unattended agent edit anything under a `.claude/` folder, so don't try (D0023).

## Tasks
Work on this repo is tracked in foreman itself (MCP server `foreman` in `.mcp.json`, or `bun packages/foreman/src/cli.ts`).
- Code tasks follow the `ship` skill (`.claude/skills/ship/`). A finished task is verified by a fresh session running the `verify` skill, never by the session that wrote it.
- Before starting: `next_tasks`, then `claim_task`. Report with `report_progress`, hand in with `submit_task` and the PR.
- Found other work on the way: `create_task` with `discoveredFrom`. Search `list_tasks` first.
- The work needs files outside your task's `paths`: `edit_task` with `addPaths` (the only edit allowed while you hold it). A gap found after you submitted, or a push after the verdict: `rework_task` with the reason, then claim it, fix, and submit again for a fresh verification (D0009).
- Never verify your own task, and never approve: people sign off, and only on changes to protected paths (`foreman.json`, D0008). Record your branch with `report_progress` so foreman can diff it.
- New decision file: get its number from `reserve_number` (kind `decision`), then `bun run docs:check --write-index` to update the index.

## Rules
- Research before building: don't build a step until its track's check has passed and the decision is recorded.
- Every non-obvious choice gets a decision file in the same PR. Format: `# Dnnnn. Title (YYYY-MM-DD)`, then `**Status:** Active | Amended by Dx | Superseded by Dx | Paused`, then `**Chosen:**`, `**Why:**`, `**Revisit if:**` in that order (an optional `**Context:**` first). `bun run docs:check` enforces it.
- Plans are ordered steps with a check each. No dates or effort estimates.
- Nothing here may depend on a hosted service or reference a private project, person or company.
- PRs only. Never push to main or force-push.
