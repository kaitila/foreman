# D0027. The board has its own design system, a status-grouped list by default, and a keyboard model drawn from one list (2026-11-09)

**Status:** Active

**Context:** The board (`fm serve`, [D0021](D0021-board-one-click-sign-off.md), [D0024](D0024-one-board-for-every-project.md)) was one inline stylesheet with raw values and ten status lanes side by side. The person asked for a clean, quiet UI in the manner of Linear, with strong keyboard navigation, minimal colour and a design system to hold it.

**Chosen:**
- **Tokens and components in design-kit's format** ([D0017](D0017-design-kit.md)): `packages/foreman/src/board/tokens.css` holds every raw value by role (light and dark, type, space, radius, motion, shadows), and `board.css` uses tokens only. The page still inlines both, so it has no build step and no external assets. `bun run board:design` runs `design-kit lint` over the board and is part of `bun run check`; a test checks every text colour pair for WCAG AA in both schemes.
- **Neutral greys, three meaning hues:** amber for what waits for the person, green for approved and green checks, red for failures, conflicts and offline. The one filled button is ink. Shadows only on floating layers.
- **A shell with a sidebar and one sheet,** and a list grouped by status as the default view, what waits for the person first (Needs approval, Approved, then the work in flight, Done and Cancelled folded). The board view stays, in workflow order, one key away (`v`). Task detail is a side panel that follows `j`/`k`.
- **A command palette (Mod K)** for every action, view and task, and a full keyboard model. The keys live in one list, `SHORTCUTS` in `page.ts`, that draws the `?` dialog; a test checks it against the handler.
- Unchanged: the token in the fragment, the three writes and their gate, the undo window, merge as a merge-queue pass, projects, CSP with a nonce, task text through `textContent`. The full design is in [board-design.md](../board-design.md).

**Why:**
- One tokens file re-skins the page, and the lint stops agents drifting back to raw values one fix at a time.
- The person opens the board to answer "what needs me?". A list with those groups on top answers it at a glance; ten columns made them scroll sideways to find two.
- The person signs off from the terminal too. Keys and a palette give the page the same speed, and one list keeps the help honest.
- Colour only for meaning keeps amber and red loud: when nearly everything is grey, the two things that need you stand out.

**Revisit if:** the board grows a build step or a UI framework, more than one page, or other people using it (then the shell, routing and design system need more than one file each).
