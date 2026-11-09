# D0030. The preset's .mcp.json lives under the source name mcp.json (2026-11-09)

**Status:** Active

**Context:** Claude Code refuses an unattended session's edits to `.mcp.json` files, as it does for paths under `.claude/`. The T-0083 worker couldn't change the preset's `.mcp.json`, so a person's session had to finish that task, and T-0085 and T-0086 change the file again. Amends [D0023](D0023-kit-sources-outside-dot-claude.md), which moved the kit's `.claude/` sources for the same reason.

**Chosen:**
- **The preset keeps its MCP config as `presets/bun-ts-postgres/mcp.json`.** `presets/generate.ts` writes it to the app as `.mcp.json` (its `RENAMED` table), so `create` and `examples/demo-app` get the same file as before. `examples/demo-app/.mcp.json` stays a real dotfile because it's generated, not edited.
- **The preset's other dotfiles keep their names.** `.gitignore`, `.dockerignore` and `.env.example` aren't among the files Claude Code protects (`.claude/`, `.git/`, `.mcp.json`, shell and git config files), so workers can edit them.
- **A new protected file in a preset goes in `RENAMED` the same way.** A test checks that the preset has no `.mcp.json` and that the app gets one.

**Why:** It lets dispatched workers change the preset's MCP config without loosening Claude Code's protection, which is right for a project's live config but not for a template's source. Renaming on output keeps the generated apps exactly as they were.

**Revisit if:** Claude Code changes which files it protects, or a preset needs many renamed files (then a general rule, such as a `dot-` prefix, beats a table).
