# D0026. Foreman is a published package, the project is renamed foreman, and init sets up foreman alone with the kit as opt-in pieces (2026-11-09)

**Status:** Active

**Context:** Today a person clones this repo, runs `bun run link`, and `fm create`, `init` and `sync` pack tarballs from that clone into each project (D0018, D0020, D0025). The clone has to stay in place, a project without `package.json` gets no foreman, and every project gets the whole kit. The person asked for a published package, the project renamed foreman, and an `init` that sets up foreman and offers the rest as opt-in pieces. Amends D0001, D0018, D0020 and D0025.

**Chosen:**
- **The name.** The project and repository are named foreman. npm's `foreman` is an unrelated package, so the packages are published under the `@foreman-kit` scope:
  - `@foreman-kit/foreman`: the CLI (`fm` and `foreman`), the MCP server and the board, plus everything `create`, `init` and `sync` need. That means `packages/create`'s code, agent-kit's templates and the presets ship inside it, and there are no relative imports across packages. <!-- docs-check: removed -->
  - `@foreman-kit/docs-check`, `@foreman-kit/test-kit` and `@foreman-kit/design-kit`: the packages a project's own checks import.
  - The scope is set in one place in the code, so a different scope is a one-line change if `foreman-kit` can't be had.
- **Install:** `bun add -g @foreman-kit/foreman` (or `npm i -g`; either way the CLI runs on bun, as before). `bun link` from a local checkout still works and needs no registry.
- **One version for all packages,** released together from a `v*` tag by a CI workflow. It uses npm trusted publishing with provenance, so no npm token is stored.
- **No hosted service at runtime.** Foreman's state, board, dispatch, merge queue and checks run on the person's machine, as before. The registry is only an install channel, and nothing reads it after install.
- **Projects run the global `fm`.** `.mcp.json` has the `foreman` server as `fm mcp`, and the hooks keep finding foreman through `$FOREMAN_BIN`, the repo's own copy, then the PATH. Projects no longer vendor foreman or depend on it. `foreman.json` records the lowest foreman version the project needs (`"foreman": ">=x.y.z"`), and an older `fm` refuses to open its database and names the upgrade command.
- **`fm init` sets up foreman alone by default,** in any git repository with or without `package.json`:
  - `.foreman/` in `.gitignore`;
  - `foreman.json` with the version and protected paths;
  - the `foreman` server in `.mcp.json`;
  - the Tasks section in `AGENTS.md`. If there's no `AGENTS.md`, it creates one with only that section, plus a `CLAUDE.md` that imports it.
- **The rest are pieces,** each opted into by name:
  - `docs`: the `AGENTS.md` and `CLAUDE.md` skeletons and the decision log with its first decision; with `package.json`, also docs-check and a `docs:check` script.
  - `guardrails`: the `.claude/settings.json` baseline and the guard and session-start hooks.
  - `skills`: the ship and verify skills and their agents.
  - `ci`: the CI workflow, only when `package.json` has a `check` script.
  - `test-kit` and `design`: those packages and their files. These need `package.json`.
- **Choosing pieces:**
  - In a terminal, `fm init` lists each piece with one line on what it adds, and the person ticks the ones they want.
  - `fm init --with docs,guardrails` and `--all` choose without asking. Without a terminal and without flags, init sets up foreman only.
  - `fm add <piece>` adds one later, with the same never-overwrite rules as init.
  - A piece that needs `package.json` is refused, with the reason, in a repo without one.
- **`fm create`** makes a project from a preset with every piece, as today.
- **The record** moves from `.meta-repo/installed.json` to `.foreman-kit/installed.json`. It's committed, and it holds the pieces, the version and the file hashes. `.foreman/` is gitignored, so it can't go there.
- **Sync takes updates by version:**
  - `fm sync` writes the kit files of the pieces the project has, from the `fm` that runs it, with D0018's three-way rules.
  - It sets the `@foreman-kit/*` dependencies in `package.json` to that version (as a text edit, as D0020 does) and asks for `bun install`.
  - It raises the version in `foreman.json`.
  - Updating is `bun add -g @foreman-kit/foreman@latest`, then `fm sync --all`.
  - A project made before this has its record moved, its `@meta-repo/*` tarball dependencies swapped for versions, and the tarballs it recorded deleted. The output lists all of it.

**Why:**
- One install and no clone to keep: what the person asked for, and what someone who isn't working on foreman expects.
- Foreman alone first: most of its value (tasks, claims, verification, the board) doesn't need the rest of the kit, and a repo in any language should be able to use it. Whether a project wants the agent docs, guardrails or CI is the person's choice, so those are opt-in.
- A global `fm` instead of a vendored copy:
  - D0024 already has one `fm` reading every project's database for the board, so one version per machine is how it already works.
  - Dropping the vendored copy removes the only reason foreman needed `package.json`.
  - D0020 avoided `node_modules/.bin` because any dependency can put a bin there. The person's own PATH doesn't have that problem.
  - The version in `foreman.json` covers what a vendored copy pinned: an `fm` too old for the project's database or config.
- Folding `create` and the kit's templates into the foreman package: nothing but `fm` uses them, and one package keeps the install a single command. docs-check, test-kit and design-kit stay separate because a project's own checks import them.
- Trusted publishing: no long-lived token in CI to leak, and provenance ties each release to its commit.
- Moving the record: `.meta-repo` names a project that no longer exists, and old projects are migrated, not broken.

**Revisit if:** the `@foreman-kit` scope can't be had, projects need to pin different foreman versions on one machine, foreman gets a build step for Node without bun, or a piece turns out to be needed by every project (then it joins the default).
