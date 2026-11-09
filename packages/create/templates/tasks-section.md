## Tasks
Work here is tracked in foreman: the MCP server `foreman` in `.mcp.json`, or its CLI, `bun node_modules/@foreman-kit/foreman/src/cli.ts help`. Its board is in `.foreman/`, which git ignores.
- Before starting: `next_tasks`, then `claim_task`. A request that has no task yet: search `list_tasks`, then `create_task` with acceptance checks and the paths it may touch.
- Code tasks follow the `ship` skill. Report with `report_progress`, hand in with `submit_task` and the PR.
- The work needs files outside your task's paths: `edit_task` with `addPaths`. A gap found after you submitted: `rework_task` with the reason, then claim it again. Once a person has approved it, don't rework it (foreman refuses): file the new work as its own task with `discoveredFrom`, or ask the person.
- Found other work on the way: search `list_tasks`, then `create_task` with `discoveredFrom`.
- Numbers that must be unique (decision files, migrations): take them from `reserve_number`.
- Never verify your own task, and never approve: a fresh session runs the `verify` skill, and a person signs off changes to the paths listed in `foreman.json`.
