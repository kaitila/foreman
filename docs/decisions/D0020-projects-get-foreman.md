# D0020. Projects get foreman from the kit as a vendored devDependency, and the MCP server and hooks run the package's own file (2026-11-05)

**Status:** Active

**Context:** Projects made with `create` or `init` ([D0018](D0018-create-init-sync.md)) got agent-kit's skills and hooks but not foreman itself: no package, no MCP server, no Tasks section in `AGENTS.md`. Agents there never filed or claimed tasks. Amends D0018.

**Chosen:**
- **Vendored like the other packages.** The bun-ts-postgres preset depends on `@meta-repo/foreman`, so `create` packs it into `.meta-repo/packages/`. `init` packs it too and adds it as a devDependency, unless the repo already depends on it. The tarball is in the record, so `sync` updates it.
- **The MCP server runs the package's own file:** `.mcp.json` has `foreman` as `bun node_modules/@meta-repo/foreman/src/cli.ts mcp`. `init` merges it into an existing `.mcp.json` and keeps the other servers and any `foreman` entry there.
- **`init` edits `package.json` as text** to add the devDependency, so the rest of the file stays as it was, and rewrites it as JSON only if that edit doesn't parse.
- **`.mcp.json` is protected** in the template `foreman.json`: it says what runs as foreman, so changing it needs a person.
- **The rest of the wiring:** `.foreman/` in `.gitignore`, and a `## Tasks` section in `AGENTS.md` (`packages/create/templates/tasks-section.md`), appended by `init` only if there is no `## Tasks` heading.
- **`init` does this only for a repo with a `package.json`.** Without one it skips foreman and says so.
- **The hooks find the installed package** at `node_modules/@meta-repo/foreman/src/cli.ts`, after `$FOREMAN_BIN`, the PATH and `packages/foreman`, looking in the project root and then the main checkout.

**Why:**
- The skills (`ship`, `verify`) and the hooks already assume foreman; without it the kit's task flow does nothing.
- Vendoring keeps "no hosted service" and lets `sync` update foreman like the other kit packages.
- Not `bunx foreman`: npm has an unrelated package named `foreman`, which `bunx` would fetch.
- Not `node_modules/.bin/foreman`: any dependency can ship a bin named `foreman` and the last one linked wins, so a guard that trusted it could be made to drop path limits and role rules. A direct file path also works where `.bin` entries are shell shims (pnpm, Windows), and `.bin` isn't on a Claude Code session's PATH anyway.
- The main checkout as a fallback: a worktree the dispatcher just made has no `node_modules` yet.
- A package.json rewritten through JSON loses its key order, line endings and inline arrays; the text edit keeps the project's file as it was.
- A repo without `package.json` has nowhere to install a Bun package.

**Revisit if:** foreman is published to a registry, or projects that don't use Bun need it.
