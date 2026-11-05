# D0024. One board for every project on this machine (2026-11-05)

**Status:** Active

**Context:** A person runs several repos at once, each with its own `.foreman/foreman.db`. `fm serve` showed only the repo it started in, on a fixed port, so a second board could not start.

**Chosen:**
- **A per-user registry** (`$FOREMAN_PROJECTS_FILE`, else `$XDG_CONFIG_HOME/foreman/projects.json`, else `~/.config/foreman/projects.json`) lists repo directories. `fm` adds the current repo when it opens its database (unless `FOREMAN_DB` is set); `fm projects [add <dir> | rm <name|dir>]` manages it. An entry is a directory and nothing else: the board opens its database and runs `gh` there, and never serves a file from it. Only a git repo with a `.foreman` database is accepted, and stale entries are skipped with a note.
- **One board process serves all of them,** the current repo first (`--project <name|dir>` for one). A project's name is its folder name (`-2`, `-3` on a clash). Task ids repeat across projects, so the page keys everything by project and id.
- **Routes are scoped:** `/api/projects`, `/api/p/<project>/tasks…`, `…/queue/run`. The unscoped routes stay and mean the first project. Approve, merge and the merge queue act on that project's database, with `gh` run in that project's directory, one pass at a time per project. The page's Run queue runs each project's queue in turn.
- **Security is unchanged:** one token per process, 127.0.0.1 only, same Host and Origin checks.
- **A second `fm serve` on a taken port** checks whether `/api/projects` answers as a foreman board and, if so, prints that URL instead of failing.

**Why:** One link, one token and one port beat a board per repo, and per-project routes keep every write inside one database and one repo.

**Revisit if:** projects need to appear on a running board without a restart, or boards on different machines should be merged.
