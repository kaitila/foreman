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

Status: steps M0–M7 of [the plan](docs/research-plan.md) are done; M8 is a private pilot.

License: [MIT](LICENSE).
