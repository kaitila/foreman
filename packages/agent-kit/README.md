# agent-kit

Guardrails and templates for projects where Claude Code agents do most of the work.

```sh
bun packages/agent-kit/src/cli.ts init [dir]
```

`init` adds the templates to a repository and never overwrites a file. The one exception is `.claude/settings.json`: if the project already has one, the baseline's permission rules are added to it (a union) and the project's own rules and other keys are kept.

**Removing a baseline rule on purpose:** delete it from `.claude/settings.json` and list it in `.claude/agent-kit.json`, or the next `init` adds it back ([D0014](../../docs/decisions/D0014-init-omit-file.md)): <!-- docs-check: elsewhere -->

```json
{ "omit": ["Bash(ssh *)", "Bash(docker *)"] }
```

- Each entry is a permission rule, written exactly as in the baseline, or a hook's `command` (that skips the hook group running it).
- `init` prints each baseline rule it skipped: `omitted  Bash(ssh *) (listed in .claude/agent-kit.json)`.
- The omit list only stops rules being added. A rule the project still has stays, and an entry that matches no baseline rule or hook command (usually a typo) is reported as `warning  omit entry "Bash(sshh *)" matches no baseline rule or hook command (.claude/agent-kit.json)`. It only warns; `init` still succeeds.
- It applies to a first install too. A malformed file stops `init` with an error, before anything is written.
- `init` never creates or changes this file.

## What's in it

**`templates/.claude/settings.json`**, the permission baseline ([D0007](../../docs/decisions/D0007-guardrail-layers.md)):
- **Deny:**
  - pushing to main or master, force-push, `--no-verify`
  - `git reset --hard`, `rm -rf`
  - `gh repo delete`, `gh secret`, `gh auth`
  - reading `.env` files (Read tool and common shell forms), `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, gh's credentials
- **Ask:** `gh pr merge`, `gh api` writes, `docker`, `ssh`, `scp`.
- **Allow:** read-only git and gh commands, and `.env.example`.

Deny rules always beat allow rules, in any settings file. `settings.local.json` can add allows but can't undo a deny.

These rules are the first layer, not a security boundary: Claude Code's docs say so, and the [live test](../../docs/research/R4-guardrails-tested.md) confirmed it.

**`templates/.claude/hooks/session-start.ts`** is the SessionStart hook. When `FOREMAN_ACTOR` is set and that actor holds a task, it injects the task's id, title, spec, acceptance checks and paths as session context, so the session knows its task without being told. It finds foreman like the guard does (`FOREMAN_BIN`, `foreman` on the PATH, or the repo's `packages/foreman`). With no actor, no task, no foreman or any error it prints nothing and exits 0: it never blocks a session.

**`templates/.claude/hooks/guard.ts`** is the PreToolUse guard, wired in by the settings file. It needs Bun.
- **It parses each command**, so it catches what text rules miss:
  - `git -C . push origin main`, a bare `git push` while on main
  - force-push in any spelling (`-fu`, `--force-with-lease`, `+branch`), deleting remote branches
  - `--no-verify` / `commit -n`, `reset --hard`, `clean -f`
  - recursive force `rm` in any spelling
  - reading or writing `.env` files, also inside `bash -c` and inline code (`bun -e`, `node -e`, `python -c`)
- **Quoted text that only mentions `.env` is allowed**, so `git commit -m "ignore .env files"` works.
- **Task paths:** when the agent has `FOREMAN_ACTOR` set and holds a claimed foreman task with `paths`, writes outside those paths are refused.
  - This covers the edit tools and shell writes: `>`/`>>` redirects, `tee`, `cp`, `mv`, `install`, `ln`, `touch` and `sed -i`.
  - `docs/tasks/**`, where tasks are exported, is always allowed, and so are files outside the repo.
  - It finds foreman through `$FOREMAN_BIN`, then `foreman` on the PATH, then `packages/foreman` in the repo.
  - **With `FOREMAN_ACTOR` set but foreman unreachable**, writes in the repo are blocked with a reason, instead of quietly going unchecked.
  - **Known limits:** writes made by scripts and interpreters (`bun -e`, `python -c`, a build tool) aren't traced, and neither is `cd x && ...`. The verifier's changed-paths check is the backstop.
- **It fails closed:** a payload it can't read, or an internal error, blocks the call.

Live check: `bun run live-test` runs real headless Claude sessions against both layers, about $0.06 with Haiku. The other layers are CI and branch protection on the server.

**The ship flow, wired to foreman:**
- **`templates/.claude/skills/ship/`, the worker side.** It covers claim → worktree → code → three parallel agents → gate → merge main → PR → `submit_task`.
  - The worker never verifies or approves its own task.
  - It takes numbers from `reserve_number`.
  - Work found on the way becomes a new task with `discoveredFrom`.
- **`templates/.claude/skills/verify/`, for a fresh session that didn't do the work.**
  - It runs every `cmd` check itself and wants concrete evidence for each statement; a statement it can't confirm fails.
  - It checks the changed files against the task's `paths`.
  - It records one verdict per check, and lists weaknesses even when the checks pass.
- **`templates/.claude/agents/`: `test-writer`, `docs-writer`, `reviewer` and `design-critic`.**
  - They split the work by path: only test-writer runs the tests, docs-writer only edits docs, and the reviewer is read-only (no edit tools).
  - design-critic is read-only too, for UI changes. It reviews the changed pages against the project's `docs/design.md`. It screenshots them at phone and desktop width, light and dark, when playwright-core is installed; otherwise it reviews the served markup and styles. <!-- docs-check: elsewhere -->
  - None of them touches foreman: the worker owns the task.

The templates name no stack or layout. They read the project's commands from the "Commands" section of `AGENTS.md`, and a test keeps them free of project names, decision numbers and stack-specific commands.
