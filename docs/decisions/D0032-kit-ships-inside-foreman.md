# D0032. The kit ships inside the foreman package: create's code moves in, templates and presets are bundled at pack time (2026-11-09)

**Status:** Active

**Context:** D0026 makes `@foreman-kit/foreman` installable on its own, with `create`, agent-kit's templates and the presets inside it. Until now the CLI imported `packages/create` by a relative path, and create read the templates, the presets and its version (`0.1.0+<commit>`, D0018) from the checkout. Amends D0018. <!-- docs-check: removed -->

**Chosen:**
- **Code moves, it isn't a dependency.** `packages/create`'s code, agent-kit's installer (`install.ts`) and the preset generator's core move into `packages/foreman/src/kit/`. `packages/create` is gone, and `presets/generate.ts` stays only as the CLI that makes `examples/demo-app`. foreman's `src/` imports nothing outside its package except its declared dependencies. <!-- docs-check: removed -->
- **Templates and presets stay where they're edited:** `packages/agent-kit/templates/` and `presets/`. This repo's `.claude/` links and runs them in place, and an unattended agent can't edit `.claude/` to point elsewhere (D0023). agent-kit becomes a private package that holds the templates and their tests.
- **A prepack script bundles them.** `bun pm pack` (and so a publish) runs `scripts/bundle-kit.ts`, which copies the templates into `kit/templates/` and writes each preset as one JSON file of its files, `kit/presets/<name>.json`. postpack removes `kit/` again; it's gitignored. Pack drops some file names, `.gitignore` and `bunfig.toml` among them, so a preset can't travel as plain files.
- **One rule finds them** (`src/kit/paths.ts`): if the package sits in a checkout (two folders up are `packages/agent-kit/templates` and `presets`), use those; otherwise use the package's own `kit/`.
- **The kit version is the package's version** from its own `package.json`. No git commit is read.
- **Vendoring:** foreman packs itself from wherever it runs, installed or not. docs-check, test-kit and design-kit are packed only from a checkout. An installed foreman writes their version into the new project's `package.json` instead, to come from the registry once they're published (T-0086 moves every project to versions).

**Why:**
- Moving the code: D0026 already chose one package, and a bundled dependency would need a published `@foreman-kit/create` or bun's bundled-dependency support in both pack and global install, for code nothing else uses.
- Bundling at pack time, not a second copy in git: the templates have one home, and the checkout and the package can't drift. Symlinks were the other option, but `bun pm pack` leaves them out.
- The checkout first: a person editing templates sees the change in `fm init` straight away, with no rebuild step.
- The version alone: an installed package has no git history, and from D0026 on a release is a version.

**Revisit if:** `bun pm pack` starts keeping every file name (then presets can ship as plain files), foreman gets a build step, or the templates move out of agent-kit.
