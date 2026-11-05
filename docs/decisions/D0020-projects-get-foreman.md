# D0020. Projects get foreman from the kit as a vendored devDependency, with an MCP server that runs the installed bin (2026-11-05)

**Status:** Active

**Context:** Projects made with `create` or `init` ([D0018](D0018-create-init-sync.md)) got agent-kit's skills and hooks but not foreman itself: no package, no MCP server, no Tasks section in `AGENTS.md`. Agents there never filed or claimed tasks. Amends D0018.

**Chosen:**
- **Vendored like the other packages.** The bun-ts-postgres preset depends on `@meta-repo/foreman`, so `create` packs it into `.meta-repo/packages/`. `init` packs it too and adds it as a devDependency, unless the repo already depends on it. The tarball is in the record, so `sync` updates it.
- **The MCP server runs the installed bin:** `.mcp.json` has `foreman` as `bun node_modules/.bin/foreman mcp`. `init` merges it into an existing `.mcp.json` and keeps the other servers and any `foreman` entry there.
- **The rest of the wiring:** `.foreman/` in `.gitignore`, and a `## Tasks` section in `AGENTS.md` (`packages/create/templates/tasks-section.md`), appended by `init` only if there is no `## Tasks` heading.
- **`init` does this only for a repo with a `package.json`.** Without one it skips foreman and says so.
- **The hooks find the installed package** at `node_modules/.bin/foreman`, after `$FOREMAN_BIN`, the PATH and `packages/foreman`.

**Why:**
- The skills (`ship`, `verify`) and the hooks already assume foreman; without it the kit's task flow does nothing.
- Vendoring keeps "no hosted service" and lets `sync` update foreman like the other kit packages.
- The bin path, not `bunx foreman`: npm has an unrelated package named `foreman`, which `bunx` would fetch.
- `node_modules/.bin` isn't on a Claude Code session's PATH, so the hooks look there themselves.
- A repo without `package.json` has nowhere to install a Bun package.

**Revisit if:** foreman is published to a registry, or projects that don't use Bun need it.
