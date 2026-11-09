# D0035. Pieces are added later with `fm init --with`, and init's open details are settled (2026-11-09)

**Status:** Active

**Context:** D0026 has `fm init` set up foreman alone and the rest of the kit as opt-in pieces, and says `fm add <piece>` adds one later. Building it (T-0085) left a few details open. Amends D0026.

**Chosen:**
- **Adding a piece later is `fm init --with <piece>`** in a repo that has foreman, not `fm add`. It uses init's never-overwrite rules, and a piece already there is kept. `fm init` with no flags in such a repo asks in a terminal, and without one it's refused, naming `--with` and `sync`.
- **Which template files belong to which piece:**
  - `skills`: everything under `.claude/skills/` and `.claude/agents/`.
  - `guardrails`: every other agent-kit template (`.claude/settings.json`, the hooks).
  - `docs`, `ci`, `test-kit` and `design` bring no agent-kit templates.
- **Foreman alone also makes `CLAUDE.md` import `AGENTS.md`** (created, or `@AGENTS.md` appended once), so Claude Code sessions see the Tasks section.
- **`--all` skips the pieces that need `package.json`** in a repo without one, with a note, instead of refusing. Naming one with `--with` there is still refused.
- **The record:** new projects get `.foreman-kit/installed.json`, with `pieces`. A project with only `.meta-repo/installed.json` keeps it there: it's read and written in place until sync moves it (T-0086). A record with no `pieces` counts as `guardrails` and `skills`, which is what every project had before.
- **`fm create`** gives every piece, and the preset no longer depends on `@foreman-kit/foreman`: its `.mcp.json` runs `fm mcp`, like an init'd repo.
- **`fm` on the PATH, and a planted bin.** Started from a package script or with direnv, a session has `node_modules/.bin` first on its PATH, so a dependency's bin named `fm` or `foreman` would win there (D0020's hole).
  - The hooks trust a `foreman` found on the PATH only through `trustedOnPath` (`scope.ts` in agent-kit's hooks): not in a `node_modules/.bin` folder, and its real file is foreman's own CLI. A planted bin can't take over the guard's path limits or role rules.
  - The MCP server's `fm mcp` is resolved by Claude Code, not by foreman, and that gap is accepted for now. Claude Code approves a project MCP server by name, so it wouldn't ask again. The person decides whether to go further.
- **The version check on a board of several projects:** a project whose `foreman.json` needs a newer `fm` is left off the board with a note naming the upgrade, and the rest open. With one project, `fm` refuses as D0026 says.

**Why:**
- `fm add <title>` already files a task. `fm add docs` would be either a piece or a task titled "docs", and a typo in a piece name would quietly file a task. init already knows the pieces, the checklist and the rules.
- Files go by folder because a skill's agents are what make it work, and everything else in `.claude/` is the guard and its settings.
- Without the import, Claude Code reads `CLAUDE.md` and never sees `AGENTS.md`, so foreman alone would leave agents unaware of the task flow.
- `--all` means "everything that fits here". Refusing would leave no one-word way to take the whole kit in a repo without `package.json`.
- Moving the record is sync's job, with the rest of D0026's migration; doing half of it in init would leave two code paths.
- A vendored foreman was the only reason the preset depended on it, and D0026 dropped vendoring.
- The hooks are where foreman's limits are enforced, so they check what they run. For the MCP server, a check inside foreman's `fm` can't help when a different `fm` is what runs. An absolute path in the committed `.mcp.json` would break it for everyone else who clones the repo. A dependency that can plant the bin can already run code whenever the project's tests import it.
- One stale project shouldn't take the board down for all the others.

**Revisit if:** a second way to add pieces is wanted (then a separate verb, not `fm add`), a piece needs files in `.claude/` outside skills and agents, people want the board to show too-old projects instead of skipping them, Claude Code can pin a project MCP server's command, or sessions started with `node_modules/.bin` first on the PATH become common.
