# create, init and sync

foreman's kit commands: set up foreman in a repository that exists, with the kit pieces you choose; start a project from a preset; and take the kit's updates later without losing the project's own changes ([D0018](../../docs/decisions/D0018-create-init-sync.md), [D0026](../../docs/decisions/D0026-publish-foreman.md), [D0035](../../docs/decisions/D0035-modular-init.md)).

```sh
fm create <dir> [--preset bun-ts-postgres] [--name n] [--no-install] [--no-git]
fm init [dir] [--with p,q | --all] [--name n]
fm sync [dir] [--dry-run]
```

The code is in [`src/kit/`](src/kit/), and it runs the same from the checkout (`bun run link`) or from an installed package ([D0025](../../docs/decisions/D0025-one-global-fm.md), [D0032](../../docs/decisions/D0032-kit-ships-inside-foreman.md)).

Projects don't depend on foreman or vendor it: they run the person's own `fm` (`.mcp.json` has the `foreman` server as `fm mcp`), and `foreman.json` names the lowest version they need ([README](README.md#use)).

## Where the kit's files come from
- **From the checkout,** agent-kit's templates and the presets are read where they're edited: `packages/agent-kit/templates/` and `presets/`.
- **From an installed package,** they're in its own `kit/` folder. `bun pm pack` (and so a publish) runs `scripts/bundle-kit.ts` first, which copies agent-kit's templates to `kit/templates/` and writes each preset as `kit/presets/<name>.json`, one JSON object of its files: pack drops some file names, `.gitignore` and `bunfig.toml` among them. The script removes `kit/` again after packing. `src/kit/paths.ts` decides which of the two it is: a checkout is two folders up, with `packages/agent-kit/templates` and `presets` in it.
- **The kit version** is this package's version in `package.json`, recorded as `source` in the project's record. No git commit is read.
- **Kit packages** (docs-check, test-kit, design-kit) are taken by version: `package.json` gets `"@foreman-kit/<pkg>": "<this version>"`, fetched from the registry, from the checkout and from an installed package alike. Nothing is vendored, and there is no `.meta-repo/` folder ([D0039](../../docs/decisions/D0039-sync-by-version.md)).

`test/installed.test.ts` packs foreman, installs the tarball globally into a temp prefix (`BUN_INSTALL`), and runs `fm help`, `fm init`, `fm sync` and `fm create` from there.

Each prints one line per file: `created`, `updated`, `merged`, `kept`, `moved`, `deleted`, `removed` or `skipped`, with the reason.

## Pieces
foreman is always set up. The rest of the kit is in pieces, each chosen by name (`src/kit/pieces.ts`):
- `docs`: the `AGENTS.md` and `CLAUDE.md` skeletons, and `docs/decisions/D0001-agent-kit.md` if the repo has no decisions yet. With `package.json`, also docs-check as a devDependency and a `docs:check` script. <!-- docs-check: elsewhere -->
- `guardrails`: agent-kit's `.claude/settings.json` baseline and its hooks.
- `skills`: the ship, verify and run-plan skills, and the agents under `.claude/agents/`.
- `ci`: a CI workflow (`.github/workflows/ci.yml`, runs `bun run check`), only if the repo has no workflow and `package.json` has a `check` script, so it can pass.
- `test-kit` and `design`: `@foreman-kit/test-kit` and `@foreman-kit/design-kit` as devDependencies.

`ci`, `test-kit` and `design` need `package.json`. In a repo without one, naming them is refused before anything is written.

## create
Makes a new project, with every piece, in an empty or missing folder:
- **The preset's files** come from the preset generator (`src/kit/generate.ts`; `presets/generate.ts` is its CLI), with the name filled in (default: the folder's name). They include `.mcp.json` with the `foreman` server, `.foreman/` in `.gitignore`, and a `## Tasks` section in `AGENTS.md` ([`templates/tasks-section.md`](templates/tasks-section.md)).
- **The kit packages the preset uses** are set to this foreman's version in `package.json` (the preset has them as `workspace:*`). The project needs nothing from this repo after that.
- **The kit:** agent-kit's templates (`.claude/`), `foreman.json` (the foreman version it needs, and the paths that need a person's approval, `.mcp.json` among them) and a CI workflow that runs `bun run check` against Postgres.
- **The record:** `.foreman-kit/installed.json`, with every piece.
- **Then** it runs `bun install`, so the lockfile is in the first commit, and makes that commit on `main`. git needs a user name and email; it checks that before writing anything.

## init
Sets up foreman in any git repository, with or without `package.json`, plus the pieces chosen. It **never overwrites a file it has**.

**foreman, always:**
- `foreman.json`, if missing, with `"foreman": ">=<this version>"` and the protected paths.
- `.mcp.json` is created with the `foreman` server (`fm mcp`), or the server is merged into the one there and the file rewritten with its indent kept. Other servers, and a `foreman` server already there, are kept.
- `.foreman/` is added to `.gitignore`.
- The Tasks section is appended to `AGENTS.md` if it has no `## Tasks` heading. Without `AGENTS.md`, one is created with only that section.
- `CLAUDE.md` imports `AGENTS.md`: it's created as `@AGENTS.md`, or that line is appended once to a `CLAUDE.md` that lacks it.
- A `package.json` or `.mcp.json` that isn't valid JSON, or a `.mcp.json` whose `mcpServers` isn't an object, stops init before it writes anything.

**Choosing pieces:**
- In a terminal, init lists the pieces as a numbered checklist. Answer with numbers or names, `all`, or nothing for foreman alone.
- `--with docs,guardrails` and `--all` choose without asking. Without a terminal and without flags, init sets up foreman only.
- `--all` skips a piece that needs `package.json` in a repo without one, with a note.

**Each piece's files:**
- `docs`: the skeletons are written only if missing. Its `AGENTS.md` skeleton goes in first, so the Tasks section is appended to it.
- `guardrails`: an existing `.claude/settings.json` gets the baseline's rules merged in, and its own rules and keys are kept (D0014).
- devDependencies are added at this foreman's version, as a text edit, so the rest of `package.json` (key order, line endings, inline arrays, a BOM) stays as it was; only if that edit doesn't parse is the file rewritten as JSON. A repo that already depends on the package keeps its own. Then run `bun install`.

**Adding pieces later:** `fm add <piece>` (or `fm init --with <piece>`) in a repo that has foreman adds them, with the same rules. A piece it already has is kept. `fm add` takes pieces only when every word is a piece name and no task flag is given; otherwise it files a task, as before (D0035). `fm init` there with no flags asks in a terminal, and is refused without one.

**The record:** `.foreman-kit/installed.json`, with the pieces.

After init, review the changes and commit them. The `foreman` server runs `fm`, so `fm` must be on the PATH (`fm setup` checks).

## The record
`.foreman-kit/installed.json` is committed. It holds the kit version (`source`), the preset (create only), the pieces, and the hash of each kit file and hook matcher as installed.

A project made before D0026 has `.meta-repo/installed.json` instead. foreman reads and writes it there until sync moves it (see below), and a record with no `pieces` counts as `guardrails` and `skills`.

## sync
Brings the kit up to the foreman version it runs from. The kit's files are those of the pieces the record lists: agent-kit's templates for `guardrails` and `skills`, and `.claude/settings.json` with `guardrails`. Everything else `create` and `init` wrote is the project's from the start, and sync leaves it alone, apart from the version edits and the migration below.

For each kit file it compares three versions: the hash recorded at install, the file now, and the kit's file now.
- **The project didn't change it:** updated.
- **The project changed it:** kept. The output names the kit's file to compare against.
- **The project deleted it:** not restored. To get it back, delete its entry in `installed.json` and sync again.
- **New in the kit:** created.
- **No longer in the kit:** left in place and dropped from the record.

`settings.json` is merged as `init` merges it, so the baseline's new rules are added and the ones in `.claude/agent-kit.json` stay out. <!-- docs-check: elsewhere -->

A kit hook group the project runs (same command) gets the kit's `matcher` when the kit's changes, so a widened matcher (say `mcp__.*`) reaches installed projects. The matcher's hash is recorded in `installed.json` at install: if the project edited it, sync keeps it and says so. A record from before this has no hash, so the matcher is assumed unchanged and the output shows the old value.

**Versions.** Each `@foreman-kit/docs-check`, `test-kit` or `design-kit` dependency given by a lower version is set to this one (a `^` or `~` stays), as a text edit that keeps the rest of `package.json`; then sync asks you to run `bun install`. Any other spec (`workspace:`, `file:`, a tag) or a higher version is the project's and kept. `foreman.json`'s `foreman` range is raised to `>=<this version>` when it is `>=` a lower one, and added after `$comment` when it's missing; a range of another form is kept.

**A project made before D0026** (the M7 kit) is moved off its tarballs, each step printed:
- `.meta-repo/installed.json` moves to `.foreman-kit/installed.json`. Its pieces come from the files it recorded: every piece if it names a preset (create made it); otherwise `skills` for `.claude/skills/` and `.claude/agents/` files, `guardrails` for the other `.claude/` files, and `docs`, `test-kit` or `design` for a docs-check, test-kit or design-kit tarball.
- In `package.json`, each `file:.meta-repo/packages/<pkg>-<hash>.tgz` dependency (named `@meta-repo/<pkg>` or `@foreman-kit/<pkg>`) becomes `@foreman-kit/<pkg>` at this version, in place, and a vendored foreman is removed.
- `.mcp.json`'s `foreman` server becomes `fm mcp`, only if it is still exactly the one D0020 wrote (`bun node_modules/@meta-repo/foreman/src/cli.ts mcp`). One the project changed is kept.
- The tarballs the record lists are deleted, then `.meta-repo/packages/` and `.meta-repo/` if that leaves them empty. A folder with other files in it is kept, and the output names them.

Sync commits nothing (review with `git diff`), and `--dry-run` writes nothing.

## In CI
The `create` job in the repo's CI makes a fresh project in a temp folder, installs it with `--frozen-lockfile`, runs its `bun run check` against Postgres, and checks that `fm sync` then changes nothing. Until the kit packages are on the registry it can't install them by version, so [`scripts/local-kit.ts`](scripts/local-kit.ts) packs them from the checkout and adds `overrides` to that project's `package.json` pointing at the tarballs. Only the CI job does this; `create` itself always writes versions.

`test/kit-migrate.test.ts` syncs two projects the M7 kit made (`test/fixtures/m7-projects.json`, from `create` and from `init`) and checks each migration step, and that `--dry-run` writes nothing.
