# create, init and sync

foreman's kit commands: start a project from a preset, add the kit to a repository that exists, and take the kit's updates later without losing the project's own changes ([D0018](../../docs/decisions/D0018-create-init-sync.md)). Both kinds of project get foreman ([D0020](../../docs/decisions/D0020-projects-get-foreman.md)).

```sh
fm create <dir> [--preset bun-ts-postgres] [--name n] [--no-install] [--no-git]
fm init [dir] [--name n]
fm sync [dir] [--dry-run]
```

The code is in [`src/kit/`](src/kit/), and it runs the same from the checkout (`bun run link`) or from an installed package ([D0025](../../docs/decisions/D0025-one-global-fm.md), [D0032](../../docs/decisions/D0032-kit-ships-inside-foreman.md)).

## Where the kit's files come from
- **From the checkout,** agent-kit's templates and the presets are read where they're edited: `packages/agent-kit/templates/` and `presets/`.
- **From an installed package,** they're in its own `kit/` folder. `bun pm pack` (and so a publish) runs `scripts/bundle-kit.ts` first, which copies agent-kit's templates to `kit/templates/` and writes each preset as `kit/presets/<name>.json`, one JSON object of its files: pack drops some file names, `.gitignore` and `bunfig.toml` among them. The script removes `kit/` again after packing. `src/kit/paths.ts` decides which of the two it is: a checkout is two folders up, with `packages/agent-kit/templates` and `presets` in it.
- **The kit version** is this package's version in `package.json`, recorded as `source` in the project's record. No git commit is read.
- **Vendored packages:** foreman packs itself from wherever it runs. docs-check, test-kit and design-kit are packed only from the checkout; an installed foreman can't, so `create` writes their version into `package.json` instead (`skipped  @foreman-kit/docs-check (not vendored ...)`), to be fetched from the registry once they're published.

`test/installed.test.ts` packs foreman, installs the tarball globally into a temp prefix (`BUN_INSTALL`), and runs `fm help`, `fm init`, `fm sync` and `fm create` from there.

Each prints one line per file: `created`, `updated`, `merged`, `kept`, `deleted`, `removed` or `skipped`, with the reason.

## create
Makes a new project in an empty or missing folder:
- **The preset's files** come from the preset generator (`src/kit/generate.ts`; `presets/generate.ts` is its CLI), with the name filled in (default: the folder's name).
- **The `@foreman-kit` packages the preset uses** are packed into `.meta-repo/packages/<pkg>-<hash>.tgz`, and `package.json` points at them. The project needs nothing from this repo after that.
- **foreman** is one of them (a devDependency). The preset also has `.mcp.json` with a `foreman` server (`bun node_modules/@foreman-kit/foreman/src/cli.ts mcp`: the package's own file, never `bunx`, since npm has an unrelated `foreman`), `.foreman/` in `.gitignore`, and a `## Tasks` section in `AGENTS.md` ([`templates/tasks-section.md`](templates/tasks-section.md)).
- **The kit:** agent-kit's templates (`.claude/`), `foreman.json` (the paths that need a person's approval, `.mcp.json` among them) and a CI workflow that runs `bun run check` against Postgres.
- **The record:** `.meta-repo/installed.json`.
- **Then** it runs `bun install`, so the lockfile is in the first commit, and makes that commit on `main`. git needs a user name and email; it checks that before writing anything.

## init
Adds the kit to a git repository and **never overwrites a file it has**:
- **agent-kit's templates.** An existing `.claude/settings.json` gets the baseline's rules merged in, and its own rules and keys are kept (D0014).
- **`AGENTS.md` and `CLAUDE.md` skeletons**, if missing. A `CLAUDE.md` that doesn't import `AGENTS.md` gets a line `@AGENTS.md` appended (once; the rest is kept).
- **`docs/decisions/D0001-agent-kit.md`**, if the repo has no decision files yet. <!-- docs-check: elsewhere -->
- **`foreman.json`**, if missing.
- **foreman, if the repo has a `package.json`:**
  - The package is vendored into `.meta-repo/packages/` and added as a devDependency. A repo that already depends on `@foreman-kit/foreman` keeps its own. The entry is added as a text edit, so the rest of `package.json` (key order, line endings, inline arrays, a BOM) stays as it was; only if that edit doesn't parse is the file rewritten as JSON.
  - `.mcp.json` is created with the `foreman` server, or the server is merged into the one there and the file rewritten with its indent kept. Other servers, and a `foreman` server already there, are kept.
  - `.foreman/` is added to `.gitignore`.
  - The Tasks section is appended to `AGENTS.md` if it has no `## Tasks` heading.
  - Then run `bun install`.
  - Without `package.json` all of this is skipped (`skipped  foreman`). A `package.json` or `.mcp.json` that isn't valid JSON, or a `.mcp.json` whose `mcpServers` isn't an object, stops init before it writes anything.
- **A CI workflow** (`.github/workflows/ci.yml`, runs `bun run check`), only if the repo has no workflow and `package.json` has a `check` script, so it can pass.
- **The record:** `.meta-repo/installed.json`.

A second `init` is refused; use `sync`.

## sync
Brings the kit's files up to the foreman version it runs from. The kit's files are agent-kit's templates, `.claude/settings.json` and the vendored packages, foreman's included. Everything else `create` and `init` wrote is the project's from the start, and sync leaves it alone.

For each kit file it compares three versions: the hash recorded at install, the file now, and the kit's file now.
- **The project didn't change it:** updated.
- **The project changed it:** kept. The output names the kit's file to compare against.
- **The project deleted it:** not restored. To get it back, delete its entry in `installed.json` and sync again.
- **New in the kit:** created.
- **No longer in the kit:** left in place and dropped from the record.

`settings.json` is merged as `init` merges it, so the baseline's new rules are added and the ones in `.claude/agent-kit.json` stay out. <!-- docs-check: elsewhere -->

A kit hook group the project runs (same command) gets the kit's `matcher` when the kit's changes, so a widened matcher (say `mcp__.*`) reaches installed projects. The matcher's hash is recorded in `installed.json` at install: if the project edited it, sync keeps it and says so. A record from before this has no hash, so the matcher is assumed unchanged and the output shows the old value.

A rebuilt package gets a new tarball: sync replaces the old one, points `package.json` at it, and asks you to run `bun install`.

Sync commits nothing (review with `git diff`), and `--dry-run` writes nothing.

## In CI
The `create` job in the repo's CI makes a fresh project in a temp folder, installs it with `--frozen-lockfile` and runs its `bun run check` against Postgres.
