# D0023. The kit's .claude files live under templates/claude/, and this repo runs them in place (2026-11-05)

**Status:** Amended by D0030

**Context:** Claude Code treats any path with a `.claude/` segment as a sensitive file and refuses an unattended session's edits to it, in `acceptEdits` and `dontAsk` alike. A probe in a scratch repo outside `~/.claude`, with Haiku in `acceptEdits`, edited a file at kit/claude/hooks/ and one at src/ but was refused one at .claude/hooks/, one at .claude/skills/ and one at pkg/templates/.claude/hooks/. So dispatched workers couldn't change agent-kit's guard, skills or agents: T-0057 stopped one rename short. The person chose to move the sources rather than mark such tasks human-only or finish them by hand.

**Chosen:**
- **The kit's files are under `packages/agent-kit/templates/claude/`,** with no dot. `install`, `init` and `sync` write them into a project's `.claude/` (`installedPath`). A templates folder laid out with `.claude/` still installs the same way.
- **This repo runs the kit in place:**
  - `.claude/settings.json`'s hook commands run `packages/agent-kit/templates/claude/hooks/guard.ts` and `session-start.ts`, and this repo has no .claude/hooks folder any more;
  - `.claude/skills/*` and `.claude/agents/*` are links to the template copies.
  - An agent changes the kit by editing the templates, and the change takes effect here at once. There are no copies to keep equal, and the old test that compared them now checks the links and commands instead.
- **`.claude/settings.json` itself stays a person's file.** Changing it needs a person, or a session where a person answers the edit prompt; it changes rarely.
- **Other projects** still get real files in `.claude/`, written by `init` or `sync`, which the person runs.

**Why:** It lets the dispatcher's workers do kit work without loosening Claude Code's protection of `.claude/`. The protection is right for a project's live configuration, and the kit's source isn't live configuration. Running the sources in place also removes a whole class of drift between two copies.

**Revisit if:** Claude Code changes which paths it treats as sensitive, or links into a repo stop being followed for skills or agents.
