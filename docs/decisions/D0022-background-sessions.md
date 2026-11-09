# D0022. Dispatched workers and verifiers run as Claude Code background sessions on the person's config dir (2026-11-05)

**Status:** Amended by D0034

**Context:** The person wants foreman's workers and verifiers to show in Claude Code's own agent view: `claude agents`, `attach`, `logs`, `stop`, and `--resume` afterwards. Today [D0011](D0011-foreman-dispatch.md)'s launch adapter runs `claude -p` under a foreman-owned `CLAUDE_CONFIG_DIR`, and none of those views can see it. Live runs, their commands and what each one saw are in [R5.3b](../research/R5.3b-background-sessions.md). Amends D0011's launch adapter for the worker and verifier roles.

**Chosen:**
- **Workers and verifiers start with `claude --bg --name <actor>`** on the person's own config dir: no `CLAUDE_CONFIG_DIR` override, no login symlink. `<actor>` is `worker-T-0042` or `verifier-T-0042`. The isolation comes from flags instead of a separate dir:
  - `--setting-sources project,local`: no user CLAUDE.md, rules, hooks, skills, agents, commands or account-synced skills (plugins, enabled by user settings, are expected out too; the live test checks);
  - `--strict-mcp-config --mcp-config <the servers in the main checkout's .mcp.json>` (foreman's own when the project has none): the project's MCP servers, foreman's among them, but no user or local ones and no claude.ai connectors;
  - `--settings` with three entries:
    - `claudeMdExcludes` for every CLAUDE.md and rules dir above the repo, as now;
    - `autoMemoryEnabled: false`, without which the person's auto memory for the project loads;
    - `env` holding `FOREMAN_ACTOR` and `FOREMAN_AGENT`. A `--bg` session doesn't inherit the launching process's environment, so this is the only way they reach the session, its Bash and its hooks.
  - `--permission-mode dontAsk`: a call outside the allowed tools is refused, not left waiting for a person;
  - `--allowedTools` and `--disallowedTools` as now (role lists plus D0019's role rules), plus `--model`;
  - the prompt as the positional argument, after `--`.
- **Foreman enforces what `--bg` ignores.** It ignores `--max-turns` and `--max-budget-usd`, so foreman reads the transcript's `usage` to count turns and estimate cost (price table × tokens), and checks the wall clock. Over any limit, it runs `claude stop <id>`.
- **Foreman watches through `claude agents --json --all`,** by session id:
  - `status: idle` means the turn is over: foreman stops the session, so the PID-pinned lease ends;
  - `status: waiting` is flagged; under `dontAsk` it shouldn't happen;
  - a session gone from the list, or `status: null`, has ended.
  - **The result** is the job timeline's last `text`. Turns and cost come from the transcript.
  - **A stopped session stays** in the person's list, attachable and resumable, until the janitor runs `claude rm` once the task is done or cancelled.
- **Foreman stops what it started.** The sessions run under Claude Code's background service, so they would outlive foreman. When foreman exits or is interrupted, it runs `claude stop` on the ones still running, as it killed them before. They stay in the person's list, where they can be attached to or resumed.
- **Print mode stays:**
  - for intake, which needs `--json-schema` (print only);
  - behind a dispatcher option for the other roles;
  - as the fallback when `claude --bg` refuses, e.g. the workspace isn't trusted. Trust carries over to worktrees inside a trusted repo, so this matters only for a repo never opened in Claude Code.
- **Print mode gains `--strict-mcp-config`** with the same servers. Today it gives every session the claude.ai connectors and account skills.

**Why:**
- The person can watch, attach to, answer and stop any worker with the tools they already use.
- In the live runs this isolated at least as well as the separate config dir. It also closed today's connector leak.
- The flag set is one place to read, and it doesn't depend on a copied or linked login.

**What it costs:**
- Foreman becomes responsible for turn, budget and time limits, and for stopping every session it starts.
- The person's prompt history and `~/.claude.json` collect foreman's prompts and worktree entries.
- The guard depends on `--settings` `env` carrying `FOREMAN_ACTOR`; the live test checks it.

**Revisit if:** `--bg` starts honouring `--max-turns`/`--max-budget-usd`, or passing the launching environment through. Also revisit if `claude agents --json` starts reporting cost and turns, or if an isolated session is found loading something from the user's config dir (the live test checks this on every run).
