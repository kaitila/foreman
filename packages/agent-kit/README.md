# agent-kit

Guardrails and templates for projects where Claude Code agents do most of the work.

This package is where the templates are edited. It isn't published: the templates ship inside `@foreman-kit/foreman`, and `fm init`, `fm create` and `fm sync` install them, with the installer in [`packages/foreman/src/kit/install.ts`](../foreman/src/kit/install.ts) ([D0032](../../docs/decisions/D0032-kit-ships-inside-foreman.md), [KIT.md](../foreman/KIT.md)).

`fm init --with guardrails,skills` adds the templates to a repository (`guardrails`: `.claude/settings.json` and the hooks; `skills`: the skills and agents), and never overwrites a file. `fm create` adds both. The one exception is `.claude/settings.json`: if the project already has one, the baseline's permission rules are added to it (a union) and the project's own rules and other keys are kept.

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

**`templates/claude/settings.json`**, the permission baseline ([D0007](../../docs/decisions/D0007-guardrail-layers.md)):
- **Deny:**
  - pushing to main or master, force-push, `--no-verify`
  - `git reset --hard`, `rm -rf`
  - `gh repo delete`, `gh secret`, `gh auth`
  - reading `.env` files (Read tool and common shell forms), `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, gh's credentials
- **Ask:** `gh pr merge`, `gh api` writes, `docker`, `ssh`, `scp`.
- **Allow:** read-only git and gh commands, and `.env.example`.

Deny rules always beat allow rules, in any settings file. `settings.local.json` can add allows but can't undo a deny.

These rules are the first layer, not a security boundary: Claude Code's docs say so, and the [live test](../../docs/research/R4-guardrails-tested.md) confirmed it.

**`templates/claude/hooks/session-start.ts`** is the SessionStart hook. When `FOREMAN_ACTOR` is set and that actor holds a task, it injects the task's id, title, spec, acceptance checks and paths as session context, so the session knows its task without being told. It finds foreman like the guard does (`FOREMAN_BIN`, `foreman` on the PATH if it is foreman, then `packages/foreman` or the installed package, in the project and then the main checkout). With no actor, no task, no foreman or any error it prints nothing and exits 0: it never blocks a session.

**`templates/claude/hooks/guard.ts`** is the PreToolUse guard, wired in by the settings file. It needs Bun.
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
  - It finds foreman through `$FOREMAN_BIN`, then `foreman` on the PATH if it is foreman (see below), then `packages/foreman/src/cli.ts`, then the installed package's own file, `node_modules/@foreman-kit/foreman/src/cli.ts` (or `@meta-repo/foreman`, foreman's old name, for a project not yet moved).
    - The scope, `@foreman-kit`, is set once in `templates/claude/hooks/scope.ts`; `create`, `init` and `sync` take it from there too (through agent-kit's `SCOPE`). A project gets that file next to the hooks.
    - Those two are looked for in the project root, then in the main checkout, since a worktree the dispatcher just made has no `node_modules` yet.
    - Not `node_modules/.bin/foreman`: any dependency can ship a bin named `foreman`, and the last one linked wins, so a fake one could drop the path limits and role rules. A session started from a package script or with direnv has `node_modules/.bin` first on its PATH, so a `foreman` on the PATH counts only if it isn't in a `node_modules/.bin` folder and its real file is foreman's own CLI (`trustedOnPath` in `scope.ts`, [D0035](../../docs/decisions/D0035-modular-init.md)).
    - The dispatcher sets `FOREMAN_BIN` to the main checkout's foreman in every session it launches, so a task editing its own worktree's foreman can't lock itself out. When foreman can't run, the refusal names the command and its error.
  - **With `FOREMAN_ACTOR` set but foreman unreachable**, writes in the repo are blocked with a reason, instead of quietly going unchecked.
  - **Known limits:** writes made by scripts and interpreters (`bun -e`, `python -c`, a build tool) aren't traced, and neither is `cd x && ...`. The verifier's changed-paths check is the backstop.
- **Role rules:** with `FOREMAN_ACTOR` set, it asks foreman (`foreman policy --json`) for the deny rules `foreman.json` gives the session's role ([D0019](../../docs/decisions/D0019-role-deny-rules.md), [format](../foreman/README.md#role-rules)). A person's session (no `FOREMAN_ACTOR`) is never affected.
  - **Bash rules** are matched against every command the shell would run, after the same unwrapping as the rules above: `bash -c`, `sh -c`, `eval`, `env`/`sudo`/`nice`/`timeout`/`xargs` and other wrappers, `$(...)`, backticks, heredocs fed to a shell, `find -exec`. So `Bash(ssh *)` also stops `bash -c 'ssh host true'`, `sudo timeout 5 ssh host` and `/usr/bin/ssh host`.
  - **Matching follows Claude Code:** `*` matches anything, spaces included, and a trailing `:*` means ` *`. A trailing ` *` also matches the bare command, so `Bash(gh pr merge *)` stops `gh pr merge` too.
  - **Other tools:** `Read(...)` applies to the Read tool. `Edit(...)` (and `Write(...)`) apply to every edit tool, and to files that shell commands write. `mcp__server` covers that server's tools. The hook's matcher includes `mcp__.*` for this. A project installed before the change keeps its old matcher: add `|mcp__.*` to it by hand.
  - **Path patterns** follow Claude Code: `//abs`, `~/home`, `/from-project-root`, `relative`. A pattern with no `/` matches at any depth.
  - **The block message** names the command, the rule and the role: `` `ssh host true` is denied to agent sessions by Bash(ssh *) (foreman.json roles.agent) ``.
  - **With `FOREMAN_ACTOR` set and no answer from foreman**, every call is blocked. That covers foreman not installed, a bad `foreman.json`, and a foreman older than the hook (update both together).
  - **Known limits:** it is a guardrail. A script, an interpreter, a build tool, or options placed between a rule's words (`git -C . push` vs `Bash(git push *)`) get past string rules. Read rules aren't applied to shell commands like `cat`. Only the tools in the hook's matcher are seen; foreman's launch adapter also passes the rules as `--disallowedTools`, which covers the rest for sessions it starts.
- **It fails closed:** a payload it can't read, or an internal error, blocks the call.

Live check: `bun run live-test` runs real headless Claude sessions against both layers, about $0.06 with Haiku. The other layers are CI and branch protection on the server.

**The ship flow, wired to foreman:**
- **`templates/claude/skills/ship/`, the worker side.** It covers claim → worktree → code → three parallel agents → gate → merge main → PR → `submit_task`.
  - The worker never verifies or approves its own task.
  - It takes numbers from `reserve_number`.
  - Work found on the way becomes a new task with `discoveredFrom`.
- **`templates/claude/skills/verify/`, for a fresh session that didn't do the work.**
  - It runs every `cmd` check itself and wants concrete evidence for each statement; a statement it can't confirm fails.
  - It checks the changed files against the task's `paths`.
  - It records one verdict per check, and lists weaknesses even when the checks pass.
- **`templates/claude/agents/`: `test-writer`, `docs-writer`, `reviewer` and `design-critic`.**
  - They split the work by path: only test-writer runs the tests, docs-writer only edits docs, and the reviewer is read-only (no edit tools).
  - design-critic is read-only too, for UI changes. It reviews the changed pages against the project's `docs/design.md`. It screenshots them at phone and desktop width, light and dark, when playwright-core is installed; otherwise it reviews the served markup and styles. <!-- docs-check: elsewhere -->
  - None of them touches foreman: the worker owns the task.

The templates name no stack or layout. They read the project's commands from the "Commands" section of `AGENTS.md`, and a test keeps them free of project names, decision numbers and stack-specific commands.
