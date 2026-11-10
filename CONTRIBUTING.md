# Contributing

The project is in its research phase. See [docs/research-plan.md](docs/research-plan.md) for the tracks and steps.

- Open a PR; nothing goes to `main` directly.
- A non-obvious choice gets a decision file in `docs/decisions/` in the same PR (format in [AGENTS.md](AGENTS.md)).
- Research findings go in `docs/research/R<n>.md`, with the result of the track's check.
- Agents and people follow the same rules: read `AGENTS.md` first.

## Releasing

Every `@foreman-kit` package shares one version and is published together from a `v*` tag ([D0026](docs/decisions/D0026-publish-foreman.md), [D0036](docs/decisions/D0036-release-workflow.md)).

1. On a branch, set the new version everywhere: `bun run release:version 0.2.0`, then `bun install`. Check what would ship: `bun run release:pack --dry-run`. Open a PR and merge it.
2. Tag the merged commit on `main` and push the tag:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The [release workflow](.github/workflows/release.yml) checks that the tag matches the packages' version, runs `bun run check`, packs and checks each package, then publishes them with provenance. No npm token is involved.

If a publish fails part way, the packages already out stay out (npm never takes a version twice). Fix the cause, bump to the next patch version and release that.

### One-time setup (a person, before the first release)

- On npmjs.com, create the `foreman-kit` organization.
- For each of `@foreman-kit/foreman`, `docs-check`, `test-kit` and `design-kit`, add a trusted publisher: GitHub Actions, this repository, workflow `release.yml`, environment `npm`. npm only lets you add one to a package that exists, so the first version of each may need publishing by hand (`npm publish --access public` on a tarball from `bun run release:pack <dir>`), then the trusted publisher added, then token publishing turned off in the package's settings.
- In the repository's settings, the `npm` environment appears after the first run. Add required reviewers there if a release should wait for a person.
