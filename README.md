# meta-repo

A starter for new projects where most of the code is written by AI coding agents (Claude Code for now).

It packages patterns proven in a production codebase that was written mostly by agents:
- short agent docs
- a decision log
- a check that keeps docs in sync with code
- a database per worktree
- a fixed "ship" flow with parallel test, docs and review agents

It also fills that codebase's gaps:
- a local task layer that takes a request from a person or an agent and tracks it through to sign-off
- guardrails that tools enforce, not just prompts
- security scanning
- isolation for agents working in parallel

## Install

For anyone, on a machine with [bun](https://bun.sh) and git:

```sh
git clone <this repo's URL> meta-repo && cd meta-repo
bun install
bun run link          # or: bun packages/foreman/src/cli.ts setup
fm setup              # checks gh and claude, links fm, says how to fix what is missing
```

Then `fm` works from anywhere: `fm create ~/x` starts a project, `fm init` adds the kit to the repo you are in, `fm sync --all` takes the kit's updates in every project fm has seen, and `fm help` lists the rest. See [packages/foreman](packages/foreman/README.md).

Status: research. Start with [docs/research-plan.md](docs/research-plan.md).

License: [MIT](LICENSE).
