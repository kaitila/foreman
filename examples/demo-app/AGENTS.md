# demo-app

A Bun HTTP API on Postgres, with one server-rendered web page. Setup and layout: [README](README.md). Settings: [configuration](docs/configuration.md). Design rules: [design](docs/design.md). Decisions: [decisions](docs/decisions/README.md).

## Commands
- `bun run check`: typecheck, docs check, design check and tests. Run it before every commit; CI runs the same.
- `bun test test/routes.test.ts`: one test file.
- `bun run typecheck`, `bun run docs:check`, `bun run design:check` (the design lint, and `src/ui/tokens.ts` up to date).
- `bun run tokens` after changing `src/ui/tokens.css`: regenerates `src/ui/tokens.ts`.
- `bun run screenshot -- http://127.0.0.1:$PORT/ --out <dir>`: PNGs of the page at phone and desktop width, light and dark. Needs `playwright-core` and a browser; without them it exits 3 and says how to add them.
- `bun run db:generate` after changing `src/db/schema.ts`; commit the migration it writes. Never edit a committed migration.
- Tests use `TEST_DATABASE_URL` (each worktree gets its own database). Locally they skip without Postgres; CI fails without it.

## Tasks
Work here is tracked in foreman: the MCP server `foreman` in `.mcp.json`, or its CLI, `fm help` (install it with `bun add -g @foreman-kit/foreman`). Its board is in `.foreman/`, which git ignores.
- Before starting: `next_tasks`, then `claim_task`. A request that has no task yet: search `list_tasks`, then `create_task` with acceptance checks and the paths it may touch.
- Code tasks follow the `ship` skill. Report with `report_progress`, hand in with `submit_task` and the PR.
- Work of more than one task that the person wants done by agents: follow the `run-plan` skill. File a plan (`create_plan`, then `create_task` with `plan` and `step`), start its dispatcher with `run_plan` on their yes, and follow it with `watch_plan`.
- The work needs files outside your task's paths: `edit_task` with `addPaths`. A gap found after you submitted: `rework_task` with the reason, then claim it again. Once a person has approved it, don't rework it (foreman refuses): file the new work as its own task with `discoveredFrom`, or ask the person.
- Found other work on the way: search `list_tasks`, then `create_task` with `discoveredFrom`.
- Numbers that must be unique (decision files, migrations): take them from `reserve_number`.
- Never verify your own task, and never approve: a fresh session runs the `verify` skill, and a person signs off changes to the paths listed in `foreman.json`.

## Rules
- Every route in `src/server/routes/` declares `mcp`: the tool that exposes it to agents, or `skip` with a reason. The parity test enforces it.
- Validate every input with zod via `parse()`. Throw `ApiFailure` for errors the client may see; anything else becomes "internal error" and its text is never logged.
- Read configuration only through `src/config.ts`, and list every new variable in the configuration doc and `.env.example`.
- State-changing routes keep the CSRF check (`x-app: 1` header, same Origin as `APP_URL`).
- Pages use only tokens from `src/ui/tokens.css`: no hex, `rgb()`, `hsl()` or `px` anywhere else in `src/` (the design check fails). Follow [design rules](docs/design.md).
- Every non-obvious choice gets a decision file in the decisions folder, in the format the docs check enforces.
