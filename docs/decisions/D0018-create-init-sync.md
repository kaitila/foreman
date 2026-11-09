# D0018. Projects vendor the meta-repo packages as tarballs, and sync updates only kit files, by a recorded hash (2026-10-31)

**Status:** Amended by D0020, D0026, D0032

**Context:** M7 (track R1) needs three commands: `create` starts a project from a preset, `init` adds the kit to a repository that exists, and `sync` takes the kit's later updates. The preset's `package.json` takes `@meta-repo/docs-check` and `@meta-repo/test-kit` from the workspace, which a project outside this repo doesn't have, and the packages aren't published anywhere.

**Chosen:**
- **Vendored tarballs.** `create` packs each meta-repo package the preset takes from the workspace (`bun pm pack`) into `.meta-repo/packages/<pkg>-<hash>.tgz`, and points `package.json` at it (`file:`). The project commits them, so its own CI installs with `--frozen-lockfile` and nothing else.
- **The name carries the content hash.** Bun caches a `file:` tarball by its path, so a new build under the old name would never be installed.
- **One record:** `.meta-repo/installed.json` holds the meta-repo version (`0.1.0+<commit>`) and the sha256 of each kit file as it was written.
- **Kit files are the only files sync touches:** agent-kit's templates, `.claude/settings.json` (merged as `init` merges it, honouring the omit list, D0014) and the vendored tarballs. Everything else `create` or `init` writes (the preset's app, `AGENTS.md`, `CLAUDE.md`, D0001, `foreman.json`, the CI workflow) is written once, only if missing, and is the project's from then on.
- **Sync is three-way per file:**
  - recorded hash, file and kit agree, or the file already matches the kit: nothing to do
  - the file still has the recorded hash: updated to the kit's version
  - the file differs from the recorded hash: kept, with the kit's path to compare against
  - the file is gone but recorded: the project deleted it, so it isn't restored. Deleting its record entry brings it back on the next sync.
  - the kit has a file the project never had: created
  - a recorded file the kit no longer ships: left in place, dropped from the record
- **Sync doesn't commit**, and `--dry-run` writes nothing. A changed tarball rewrites only that dependency's value in `package.json` and asks for `bun install`.

**Why:**
- **Tarballs, not a path to a meta-repo checkout:** a path works on one machine only, so the project's CI would fail.
- **Tarballs, not unpacked source:** a source copy would be scanned by the project's typecheck, tests and docs check (its env reads would fail the env registry).
- **The record makes "changed by the project" exact.** Without it, sync can't tell an edited file from an old kit version. A missing file with a record is a deletion, so the project's choice to drop a skill or agent sticks.
- **App code isn't synced:** after `create` it's the project's code, and a template update merged into it would be a guess. `AGENTS.md` and the CI workflow are edited by every project.
- No hosted service: the tarballs come from the meta-repo checkout that runs the command.

**Revisit if:** the packages are published to a registry (then `package.json` takes versions and sync bumps them), or projects want preset updates offered as patches.
