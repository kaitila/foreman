# R1 Distribution: create, init, sync

Last reviewed: 2026-10-31 (through D0018)

Run on 2026-10-31 (T-0038, then T-0047). Decision: [D0018](../decisions/D0018-create-init-sync.md). Package: [`packages/create`](../../packages/create/README.md). <!-- docs-check: removed -->

**Check:** a fresh project and an existing repo both get set up and pass CI.

**Result: passes.**
- **A fresh project.** CI's `create` job runs `bun packages/create/src/cli.ts create "$RUNNER_TEMP/new-app"` on every push, then in that new project runs `bun install --frozen-lockfile` and its own `bun run check` against Postgres. It also checks the tree is clean afterwards and runs `sync`. On main at `f9495c5` (CI run 41220067287) the job passed in 20 seconds. The new project installs with nothing from this repo: `create` packs the kit packages into `.meta-repo/packages/*.tgz` and points `package.json` at them.
- **An existing repo.** `packages/create/test/create.test.ts` ("adds the kit to an existing repo without overwriting any file it has") runs `init` on a repo that already has its own `AGENTS.md`, `CLAUDE.md`, an agent file, `foreman.json`, a workflow and a `settings.json` rule. `AGENTS.md`, the agent file, `foreman.json` and the workflow come out byte for byte the same. `CLAUDE.md` keeps its text and, since T-0047, gets `@AGENTS.md` appended once if it didn't import it. `settings.json` is merged with the project's rule kept, and no second workflow is added. <!-- docs-check: removed -->
- **Taking updates.** The `sync` tests show it updates kit files the project left alone, keeps files the project changed or deleted, adds new kit files, merges new baseline rules into `settings.json` (honouring the omit list from D0014), and replaces an outdated packed package. `--dry-run` reports the same and writes nothing.

**What we learned:**
- Workspace links (`workspace:*`) don't survive leaving the monorepo. Packing the kit into the project keeps a new project self-contained without publishing to a registry, which this repo may not depend on.
- A hash record of what was installed (`.meta-repo/installed.json`) is enough for a safe three-way update; no merge tool is needed when the rule is "never overwrite what the project changed".
- Gaps: the preset's app code is written once and never synced; packed tarballs can differ by Bun version, so `sync` may replace a package with identical contents.
