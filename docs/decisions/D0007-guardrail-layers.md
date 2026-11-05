# D0007. Guardrails come in layers, each tested against real Claude Code (2026-10-30)

**Status:** Active

**Context:** [D0003](D0003-one-agent-config.md), and the M4 test in [R4 guardrails](../research/R4-guardrails-tested.md).

**Chosen:** Agent-kit puts four layers in place. Each layer catches what the one before misses:
1. **Committed `.claude/settings.json` deny/ask/allow baseline** (`packages/agent-kit/templates/claude/settings.json`). It is merged into a project's existing settings, never replaced. It blocks:
   - pushing to main or master, force-push and `--no-verify`
   - `git reset --hard` and `rm -rf`
   - deleting a repo, `gh secret` and `gh auth`
   - reading `.env` files, keys, `~/.ssh` and `~/.aws`

   `.env.example` stays readable. The sandbox is not turned on in the committed file: without bubblewrap it is silently skipped, and it needs a domain allowlist for each project. Projects can opt in through `settings.local.json`.
2. **A PreToolUse guard hook** (`templates/claude/hooks/guard.ts`, T-0002). It parses commands (quotes, `bash -c`, `$(...)`, wrappers such as `timeout` and `sudo`), so it catches what text rules miss: `git -C . push`, `-fu`, `+refspec`, `commit -nm`, `rm -Rf`, inline code reading `.env`. It also enforces the claimed foreman task's `paths` on every edit. It fails closed. The `.env` Bash rules moved here from layer 1, because text rules also matched quoted mentions of `.env` (see R4).
3. **CI**, which agents can't skip:
   - `bun run check`
   - `bun audit --audit-level=high`
   - gitleaks: the MIT binary, checksum pinned, with a self-test on a key generated at runtime
   - zizmor on the workflows
   - every action pinned to a commit SHA, credentials not persisted
   - Renovate keeps the pins current.
4. **Server-side branch protection on main** (T-0004, a person's job).

**Why:**
- Claude Code's own docs say Bash permission rules are "not a security boundary".
- The live test showed a second gap. With Bash allowed, `Read(**/.env)` did **not** stop `cat .env`, so explicit `Bash(* .env)` rules were needed. Deny also always beats allow, so a broad `Read(**/.env.*)` would have hidden `.env.example`.
- The baseline also stopped this session's own `rm -rf node_modules`. That is the intended trade: the agent uses `bun install --force` or asks.
- `bun audit` caught a high-severity zod advisory (GHSA-mrhx-c7xc-m3w5) the first time it ran. It was fixed by moving to zod 4.6.7 with a tree-wide override.

**Revisit if:** Claude Code makes Read denies cover Bash reliably, or adds built-in branch protection. Either would make some of these rules redundant.
