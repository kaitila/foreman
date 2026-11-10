# D0036. Releases: one version bumped by a script, a tag that must match it, checked tarballs published by a job that runs no repo code (2026-11-09)

**Status:** Active

**Context:** D0026 chose one version for every `@foreman-kit` package, released from a `v*` tag through npm trusted publishing. This records how.

**Chosen:**
- **One version, kept by a script and a test.** `bun run release:version <x.y.z>` sets the version in every `packages/*/package.json`, the private agent-kit included, as a text edit. A test in `packages/foreman/test/release.test.ts` fails when any two differ.
- **What each package ships is listed.** docs-check, test-kit and design-kit get a `files` field (their `src`, README and, for design-kit, the tokens files), as foreman already had. Without it they shipped their tests. `.github/scripts/release.ts pack` refuses a pack holding tests, fixtures, `.foreman` or `node_modules`, or missing `package.json` or `README.md`.
- **CI dry-runs the pack on every run** (`bun run release:pack --dry-run`), so a packaging break shows up in the PR that causes it.
- **The release workflow** (`.github/workflows/release.yml`) has two jobs:
  - `pack`, with read access only: checks the tag is `v<version>`, runs `bun run check` against Postgres, packs each package with `bun pm pack` and checks it, and uploads the tarballs.
  - `publish`, with `id-token: write` in the `npm` environment: downloads those tarballs and runs `npm publish --provenance --access public` on each, dependencies first and foreman last. No checkout, no install, no cache.
- **npm comes from setup-node's Node 24,** whose npm is 11.x. Trusted publishing needs npm 11.5.1 or later; bun can't publish through it.

**Why:**
- Splitting the jobs keeps the OIDC token away from the tests and install scripts, and the tarballs published are byte for byte the ones checked.
- `bun pm pack` runs foreman's prepack (D0032) and is what `fm` itself uses, so the release packs the way development does.
- Checking the tag against the version stops a tag from publishing a version nobody bumped, or one already out.
- A named environment lets the trusted publisher on npmjs.com be limited to it, and a person can add a required reviewer to it later without changing the workflow.
- No caches in the release: a cache written by another run is the usual way into a release job.

**Revisit if:** packages need their own versions, bun gains trusted publishing, or a partial publish (some packages out, the rest failed) happens often enough to need a resume step.
