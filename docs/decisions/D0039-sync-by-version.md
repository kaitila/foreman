# D0039. Kit packages are pinned to fm's exact version, sync only raises them, and an M7 project's pieces come from its record (2026-11-10)

**Status:** Active

**Context:** D0026 says projects take `@foreman-kit/*` by version, `fm sync` sets them to the running version and raises `foreman.json`'s range, and a project made before it is moved off its tarballs. Building it (T-0086) left details open. Amends D0026.

**Chosen:**
- **An exact version.** `create` and `init` write `"@foreman-kit/<pkg>": "<fm's version>"`, with no `^`. This holds from the checkout too: nothing is vendored any more, and `.meta-repo/packages` is gone.
- **Sync only raises.** A kit dependency given by a version lower than fm's is set to it, keeping a `^` or `~`. A higher version, or any other spec (`workspace:`, `file:`, `link:`, a tag), is the project's own and kept. The `foreman` range is raised only when it is `>=x` with a lower `x`, and added when missing. A range of another form is kept.
- **An M7 record's pieces:**
  - A record that names a preset was made by `create`, which gave every piece.
  - Otherwise the pieces come from the files it recorded: files under `.claude/skills/` or `.claude/agents/` mean `skills`, the other `.claude/` files `guardrails`, and a docs-check, test-kit or design-kit tarball `docs`, `test-kit` or `design`.
  - M7 never recorded the CI workflow, so `ci` can't be inferred for an `init` project.
- **The migration runs on every sync, step by step.** Each step checks its own condition, so a project made by the T-0083/T-0084 code (an `@foreman-kit/*` tarball, a `.foreman-kit` record) is cleaned up too. A tarball dependency under either scope becomes a version in place, not re-sorted. `.mcp.json` changes only when its `foreman` server is exactly D0020's. `.meta-repo/` is removed only once it is empty.
- **The template's `foreman.json` protects `.foreman-kit/**`,** the record's folder, instead of `.meta-repo/**`.
- **CI before the first publish:** the `create` job runs `create --no-install --no-git`. Then `packages/foreman/scripts/local-kit.ts` packs the kit packages from the checkout and adds `overrides` that point the test project at those tarballs. The job then installs, commits, runs the project's check, and checks that `fm sync` changes nothing. `create` itself never writes an override.
- **The M7 fixture** (`packages/foreman/test/fixtures/m7-projects.json`) is the real output of the M7 code at commit `834a060^`, for `create` and for `init`. It keeps only the files the migration reads, and its tarballs are placeholders. The test writes today's kit files for the other paths the record lists.

**Why:**
- An exact version matches what sync writes, so a project's kit packages always equal the `fm` that last synced it, and a fresh project's lockfile doesn't drift.
- Raising only: a project that pinned a newer package, or took one from a path, chose that. Sync shouldn't undo it, or downgrade it when an older `fm` runs.
- Inferring pieces from the record, not from the folder: the record is what the kit installed, and files the project wrote itself shouldn't turn into kit pieces.
- Checking each step on its own makes sync safe to rerun, and makes a dry run's output the same as the real run's.
- An override only in CI keeps the code under test the same code a person runs. The tarballs stay outside the project, so the check still covers what a fresh project commits.
- A JSON fixture, with no tarballs or hooks: binary files and `.ts` files under `test/` would bloat the repo and get typechecked.

**Revisit if:** the kit packages are published (then drop `local-kit.ts` and let the `create` job install by version), a project needs a kit package at a different version from its `fm`, or M7 projects are all migrated (then the migration code can go).
