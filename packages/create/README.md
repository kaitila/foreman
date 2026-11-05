# create

Start a project from a preset, add the kit to a repository that exists, and take the kit's updates later without losing the project's own changes ([D0018](../../docs/decisions/D0018-create-init-sync.md)).

```sh
bun packages/create/src/cli.ts create <dir> [--preset bun-ts-postgres] [--name n] [--no-install] [--no-git]
bun packages/create/src/cli.ts init [dir] [--name n]
bun packages/create/src/cli.ts sync [dir] [--dry-run]
```

`fm create`, `fm init` and `fm sync` run this same code from anywhere ([D0025](../../docs/decisions/D0025-one-global-fm.md)).

Each prints one line per file: `created`, `updated`, `merged`, `kept`, `deleted`, `removed` or `skipped`, with the reason.

## create
Makes a new project in an empty or missing folder:
- **The preset's files** come from `presets/generate.ts`, with the name filled in (default: the folder's name).
- **The meta-repo packages the preset uses** are packed into `.meta-repo/packages/<pkg>-<hash>.tgz`, and `package.json` points at them. The project needs nothing from this repo after that.
- **The kit:** agent-kit's templates (`.claude/`), `foreman.json` (the paths that need a person's approval) and a CI workflow that runs `bun run check` against Postgres.
- **The record:** `.meta-repo/installed.json`.
- **Then** it runs `bun install`, so the lockfile is in the first commit, and makes that commit on `main`. git needs a user name and email; it checks that before writing anything.

## init
Adds the kit to a git repository and **never overwrites a file it has**:
- **agent-kit's templates.** An existing `.claude/settings.json` gets the baseline's rules merged in, and its own rules and keys are kept (D0014).
- **`AGENTS.md` and `CLAUDE.md` skeletons**, if missing. A `CLAUDE.md` that doesn't import `AGENTS.md` gets a line `@AGENTS.md` appended (once; the rest is kept).
- **`docs/decisions/D0001-agent-kit.md`**, if the repo has no decision files yet. <!-- docs-check: elsewhere -->
- **`foreman.json`**, if missing.
- **A CI workflow** (`.github/workflows/ci.yml`, runs `bun run check`), only if the repo has no workflow and `package.json` has a `check` script, so it can pass.
- **The record:** `.meta-repo/installed.json`.

A second `init` is refused; use `sync`.

## sync
Brings the kit's files up to the meta-repo version it runs from. The kit's files are agent-kit's templates, `.claude/settings.json` and the vendored packages. Everything else `create` and `init` wrote is the project's from the start, and sync leaves it alone.

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
