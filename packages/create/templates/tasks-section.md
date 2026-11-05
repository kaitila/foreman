## Tasks
Work here is tracked in foreman: the MCP server `foreman` in `.mcp.json`, or its CLI, `bun node_modules/.bin/fm help`. Its board is in `.foreman/`, which git ignores.
- Before starting: `next_tasks`, then `claim_task`. A request that has no task yet: search `list_tasks`, then `create_task` with acceptance checks and the paths it may touch.
- Code tasks follow the `ship` skill. Report with `report_progress`, hand in with `submit_task` and the PR.
- Found other work on the way: search `list_tasks`, then `create_task` with `discoveredFrom`.
- Numbers that must be unique (decision files, migrations): take them from `reserve_number`.
- Never verify your own task, and never approve: a fresh session runs the `verify` skill, and a person signs off changes to the paths listed in `foreman.json`.
