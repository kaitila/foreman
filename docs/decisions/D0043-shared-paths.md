# D0043. A repo names the files tasks may edit side by side (2026-11-11)

**Status:** Active

**Context:** The dispatcher of [D0011](D0011-foreman-dispatch.md) keeps a ready task waiting while its declared paths overlap those of a task in flight. [D0037](D0037-decision-files-dont-clash.md) took the decision log out of that, and named this case in its "Revisit if". In this repo it was not enough: of the last 45 tasks, 22 declared `packages/foreman/README.md` and 11 declared `AGENTS.md`, because nearly every change documents itself there. One day's dispatcher log (2026-11-10, `--max 8`) had 2,605 "waits: its paths overlap" lines out of 2,623, and tasks ran one at a time. Amends D0037.

**Chosen:**
- **`sharedPaths` in `foreman.json`:** a list of paths or globs. In `pathsOverlap` (`packages/foreman/src/policy.ts`), a pair of globs that both stay inside shared paths is not an overlap. `docs/decisions/**` is always on the list (D0037), and the repo's list adds to it.
- **Inside means:** a plain path that a shared glob matches, the same glob, or any glob under a shared whole folder (`docs/changelog/**`). A glob that reaches past the shared path (`docs/**`, `**/*.md`) still overlaps it, and a task that declares no paths still overlaps every task.
- **One rule reads it:** `waitsOn` in `packages/foreman/src/waiting.ts` ([D0042](D0042-plan-steps-gate.md)), so the dispatcher, `fm next`, `fm list` and `fm show` agree on whether a task waits for paths. It is read from main like the rest of `foreman.json`, each time the rule runs and two tasks' paths overlap at all, so a change needs no restart. A value that isn't a list of globs is refused with an error naming the key.
- **Here:** `packages/foreman/README.md` and `AGENTS.md`.
- **The CLI is split by command** for the same reason: `packages/foreman/src/cli.ts` was declared by 11 of those 45 tasks. Each command, or small group of them, has its own file in `src/cli/` with its `fm help` lines, so two tasks changing different commands declare different files. That overlap was real, so it is removed, not declared shared.

**Why:**
- A file most tasks touch turns the dispatcher into a queue of one, whatever `--max` says. The edits are usually a line or a bullet in different sections, which git merges.
- When two edits do collide, the merge queue sends the second PR back to merge main and be verified again ([D0012](D0012-merge-queue-conflict-send-back.md)). That costs one extra verification now and then. Waiting costs every task its turn.
- The repo decides, in a file a person signs off (`foreman.json` protects itself, [D0008](D0008-risk-from-paths.md)): which files are safe to share differs by project, and an agent can't widen the list on its own.
- Requiring both globs to be shared keeps D0037's rule: a broad glob might be there for other files, so it still waits.

**Revisit if:** conflict send-backs on shared files become common (then drop the file from the list, or split it); or source files, not docs, start to appear on the list.
