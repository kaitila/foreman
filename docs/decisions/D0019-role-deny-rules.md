# D0019. Deny rules per agent role live in foreman.json, and foreman hands them to the guard and the launch flags (2026-11-03)

**Status:** Active

**Context:** Until now a project could forbid things for agents only in its committed `.claude/settings.json`. That file binds every session, the person's own included. In a pilot project it took away the owner's merge on green and the production commands they run after saying yes, just to keep foreman's workers, verifiers and intake away from them. Builds on [D0007](D0007-guardrail-layers.md) (the guard), [D0008](D0008-risk-from-paths.md) (foreman.json) and [D0011](D0011-foreman-dispatch.md) (the launch adapter and `FOREMAN_ACTOR`).

**Chosen:**
- **One place for the rules:** an optional `"roles"` block in `foreman.json`, with a `deny` list each for `agent`, `worker`, `verifier` and `intake`:
  ```json
  { "roles": {
      "agent":    { "deny": ["Bash(gh pr merge *)", "Bash(ssh *)", "Bash(kubectl *)"] },
      "worker":   { "deny": ["Bash(gh release *)"] },
      "verifier": { "deny": ["mcp__deploy"] },
      "intake":   { "deny": ["Read(data/**)"] } } }
  ```
  Entries are Claude Code permission rules: `Bash(...)`, `Read(...)`, `Edit(...)`, `mcp__server`, a tool name.
- **Who gets which rules:**
  - `agent` applies to every session with `FOREMAN_ACTOR` set.
  - A role's own list is added when the actor is named after it: `worker-T-0042`, `verifier-T-0042`, `intake`.
  - Any other actor name gets only `agent`.
  - No `FOREMAN_ACTOR` means a person's session: no role rules.
- **Foreman is the one reader:**
  - `roles.ts` validates the block. An unknown role name, a key other than `deny`, an entry that isn't a rule, or a comma in a rule (it would split in `--disallowedTools`) is an error, not something quietly skipped.
  - It reads the main checkout's `foreman.json`, the same file foreman reads for `protectedPaths`. A worker's edit in its own worktree doesn't change its rules.
  - `foreman policy [--actor a | --role r] --json` prints the resolved rules, each with the block it came from.
- **The guard asks foreman,** the way it asks for the task's paths. `foreman policy` needs no database.
  - **Bash rules** are matched against every simple command the guard parses, at every layer of wrapping: `bash -c`/`sh -c`/`eval`, `env`/`sudo`/`nice`/`timeout`/`xargs` and the other wrappers, `$(...)` and backticks, heredocs fed to a shell, `find -exec`.
  - **The head is also tried by its base name,** so `/usr/bin/ssh h` matches `Bash(ssh *)`.
  - **Matching is Claude Code's:** `*` matches anything, spaces included, and `:*` at the end means ` *`. One difference: a trailing ` *` also matches the bare command (`gh pr merge` with no arguments), because that is safer for a deny rule.
  - **Read rules** apply to the Read tool. **Edit-family rules** (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) apply to every edit tool, and, when they name a path, to the files shell commands write. **`mcp__server`** covers that server's tools, and `mcp__server__*` and exact tool names work too.
  - **The hook's matcher** gains `mcp__.*`, so MCP calls reach it.
  - **The block message** names the command, the rule and the role.
  - **It fails closed:** with `FOREMAN_ACTOR` set and no answer from foreman (not installed, a foreman older than the hook, or a bad `foreman.json`), every call is blocked.
- **The launch adapter** adds `agent`'s and the role's rules to `--disallowedTools`, after the role's fixed list. A launched session can't drop them, even by editing files. A bad roles block stops the launch.

**Why:**
- The person's own sessions keep everything `settings.json` allows. Only agent sessions lose what their role is denied.
- With one source, the hook and the launch flags can't disagree. A project changes one file, which is already a protected path (D0008), so an agent can't loosen its own limits through a PR without a person.
- Claude Code's own rules match only the command as typed, so `bash -c 'ssh h'` or `env -u X gh pr merge 1` get past them. The guard already parses these forms for its own rules, so the role rules reuse that parsing.
- Failing closed matches what the guard already does for task paths. An agent with an identity whose limits can't be known shouldn't run unlimited.

**This is a guardrail and a launch-time limit, not a security boundary.** String rules can always be got around: a script file, an interpreter (`python -c "import subprocess; ..."`), a build tool, an alias, or options between the words of a rule (`git -C . push` for `Bash(git push *)`). The guard doesn't apply Read rules to shell commands (`cat data/x`). An agent session the person starts by hand gets the rules only if `FOREMAN_ACTOR` is set in the environment Claude Code's hooks see. Credentials the agent can't reach, server-side branch protection and the verifier remain the hard limits.

**Revisit if:** Claude Code gets per-session or per-agent permission profiles that a launch can select, or its own Bash rules start matching inside wrappers and subshells. Either would make the guard's half redundant.
