# D0025. One global `fm`: create, init, sync and setup are fm subcommands (2026-11-05)

**Status:** Amended by D0026

**Context:** A person wants one command on their machine that does everything: tasks, starting a project, adding the kit, taking its updates, and checking the machine.

**Chosen:**
- `fm create | init | sync` call `runKitCommand` from `@meta-repo/create`, the same function the package's own CLI calls. `packages/create/src/commands.ts` holds it; there is no second copy of the logic or the output. <!-- docs-check: removed -->
- `fm sync --all` walks the projects fm has seen: the registry `fm projects` lists (`~/.config/foreman/projects.json`, see D0024), added by create, init, sync and setup. It prints one block per project, keeps going past a failure, and exits 1 if any failed.
- `fm setup` checks bun, git, gh (installed, logged in), claude (installed, signed in, time left on the token from `~/.claude/.credentials.json`), fm on the PATH (it runs `bun link` unless `--no-link`) and whether Claude Code trusts the current repo. It prints the exact fix per missing item, `--json` for scripts, and exits 1 when something is missing. Trust is only read from `~/.claude.json`; the fix is to run `claude` once in the repo, never an edit of that file.
- Commands and files go through an `Env` object so tests use fakes.

**Why:** One install and one name beat four. Sharing the function keeps `fm` and `meta-repo` from drifting. A paths-only file in the user's config dir needs no hosted service and holds no task data. Never writing `~/.claude.json` leaves Claude Code's own trust flow in charge.

**Revisit if:** T-0071 adds a projects list of its own (then read that instead of this file), Claude Code gets a command to trust a folder, or the token expiry moves out of the credentials file (macOS keychain: setup then reports the time as unknown).
