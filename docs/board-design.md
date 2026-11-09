# The board's design system

How `fm serve`'s page looks and behaves, and the rules a change to it follows. The code is in `packages/foreman/src/board/`: `tokens.css` (every raw value), `board.css` (the components, tokens only) and `page.ts` (the markup and the page script). The choice is [D0027](decisions/D0027-board-design-system.md). What the board does (sign-off, merging, projects, the API) is in [foreman's README](../packages/foreman/README.md#board).

## Principles
- **Quiet.** Neutral greys do the work. A screen at rest is text, thin lines and one filled button at most: the selected task's action.
- **Colour means something.** Three hues, each with one meaning, and nothing decorative:
  - attention (amber): waits for you to sign off, checks pending, a skipped or sent-back result;
  - go (green): approved, checks green, a done write, the live dot;
  - danger (red): something failed or was undone: failed, conflicting, moved since verified, offline, an undone approval, the Human only risk tag. A result that isn't a merge is never green.
- **What needs you comes first.** Needs approval and Approved lead the list, the sidebar counts them in amber, and the tab title shows the count.
- **Keyboard first.** Everything the mouse does has a key or a palette command, and the page says the key next to the control.
- **Flat at rest.** Only floating layers (detail panel, palette, dialogs, toasts, the phone sidebar) have a shadow.

## Tokens
`tokens.css` holds one `:root` block, its dark overrides under `prefers-color-scheme: dark`, and motion set to 0 under `prefers-reduced-motion`. To re-skin the board, edit this file only.

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--color-bg`, `-surface`, `-hover`, `-active`, `-sunk` | `bg` is the window ground behind the sidebar; `surface` is the sheet and floating layers. |
| Lines | `--color-line`, `-line-soft`, `-line-strong` | Control borders are subtle (about 1.5:1) on purpose; a control is known by its label and fill. |
| Text | `--color-ink`, `-ink-muted`, `-ink-faint` | Three tiers. Every pair meets WCAG AA on the surfaces it sits on, in both schemes. |
| Filled control | `--color-primary`, `-primary-hover`, `-on-primary` | Ink: near-black in light, inverted in dark. |
| Meaning | `--color-attn`, `-go`, `-danger`, each with `-soft` | `-soft` is a tinted ground, used for the notice bar. |
| Other colour | `--color-focus`, `-scrim`, `-thumb`, `-thumb-hover` | Focus ring is ink. |
| Elevation | `--shadow-float`, `--shadow-panel` | Floating layers only. |
| Type | `--font-body`, `--font-mono`, `--text-xs` 12 / `sm` 13 / `base` 14 / `md` 16 / `lg` 20 px (in rem), `--leading-*`, `--weight-*`, `--tracking-*` | One face (Inter if installed, else the system UI face), a mono for ids, branches and logs. No web fonts. |
| Space | `--space-px`, `--space-0` … `--space-8` | A 4px grid in rem (2, 4, 8, 12, 16, 20, 24, 32, 48 px). |
| Sizes | `--sidebar-width`, `--topbar-height`, `--row-height`, `--control-height`, `--control-height-touch`, `--lane-width`, `--panel-width`, `--palette-width`, `--dialog-width`, `--slot-tag`, `--slot-act`, `--slot-pr`, … | Touch height (44 px) replaces control height at phone width. The `--slot-*` widths are the list's fixed columns. |
| Radius | `--radius-sm` 4 / `md` 6 / `lg` 8 / `xl` 12 px, `--radius-full` | Tight. Controls `md`, sheet and floating layers `xl`. |
| Motion | `--duration-fast` 90 ms, `--duration-base` 160 ms, `--duration-spin` 800 ms, `--duration-pulse` 1600 ms, `--ease-standard` | Feedback only (hover, the chevron, the phone sidebar, the spinner, the live dot). Under reduced motion the durations are 0 and the spinner, pulse and undo drain stop. |

A new value goes in `tokens.css` first, named by its role (`--color-attn`, not `--amber`), with its dark value if it is a colour.

## Components
All in `board.css`, in this order.

- **Shell.** `.app` is a sidebar on `--color-bg` and the work on one framed `.sheet` (surface, line border, `xl` radius) beside it.
- **Sidebar.** The mark and `127.0.0.1`; a **Search…** button that opens the palette and shows its key; the views **Needs you** (count in amber) and **All tasks** (count in faint ink); a **Projects** label and, when there are several, All projects and each project with its total in grey and an amber dot when something there waits for you; at the foot, the live dot ("Live" or "Offline, retrying") and **Shortcuts ?**. The current item has the `active` fill.
- **Top bar.** Title with its scope (`project / Needs you`), the count (`3 of 12` while filtering), the filter field (sunk fill, `/` hint), and the List/Board switch.
- **Notice.** One line on `--color-attn-soft` under the top bar when the page can't write (no token, read-only board).
- **List rows.** Status glyph, id, title, then fixed slots on the right, so columns line up from row to row: live dot (a session is running), project chip (All view only), risk tag (**Review risk** or **Human only**; nothing for auto), the action, the PR number, avatar, and how long ago it changed. The action slot is kept only when some visible row needs you. An approved row shows the PR's state (checks green, pending, red, conflicts, or "GitHub is checking if it merges" while GitHub answers `UNKNOWN`) with its Merge button. A task whose approval was undone has the **Approval undone** flag after its title. The selected row has the `active` fill and a 2px ink bar on its left edge; that is its focus indicator.
- **Group headers.** Sticky, sunk fill: chevron, glyph, name, count, and the group's action on the right: **Approve all n** (Needs approval, two or more) and **Run queue** (Approved). Clicking the header folds the group.
- **Board cards.** One column per status in workflow order, Draft to Cancelled. In Needs you, only the Needs approval and Approved columns show. A card shows id, project chip, age, title, the Approval undone flag, risk, PR, live dot, avatar and its action. Empty columns are narrow and say so. The selected card has an ink ring. While the panel is open, the board gets room at its end and scrolls the open card clear of the panel.
- **Status glyphs** (`.si`, 14 px), one shape per status:
  - Draft: dashed ring. Ready: empty ring.
  - Claimed, In progress, In review / Verifying: the ring fills a quarter, a half, three quarters.
  - Needs approval: three quarters, amber.
  - Approved: green disc with a check. Done: grey disc with a check. Cancelled: grey disc with an x.
- **Buttons.** `.btn` is the outlined default. `.btn.approve` and `.btn.merge` are the filled (ink) button, but on rows and cards they are outlined until their task is selected, so one filled button shows at a time; the panel's action is always filled. Merge is strong only when the PR reads as mergeable (at the verified commit, checks green, `MERGEABLE`); otherwise it stays outlined even when selected, so it reads as a try. On a PR GitHub calls `CONFLICTING` the merge button reads **Send back #n**, since the pass sends it back to its worker; its title says so, and that it merges instead if GitHub says it merges cleanly by then. The undo bar reads "Sending back" and the busy text "Sending back…". Disabled buttons are sunk and say why on hover and in the panel. `.icon-btn` is a bare square for icons.
- **Undo bar** ([D0021](decisions/D0021-board-one-click-sign-off.md)). In place of the button: "Approving in 4 s" over a fill that drains for the undo window, and a small ink **Undo**. Then "Approving…" / "Merging…" with a spinner while the request runs.
- **Detail panel.** A floating sheet on the right: a bar with project / glyph / id, previous, next and close; then the title, the undone note if there is one, properties (status, risk, assignee, branch, pull request with its state, updated, project), the action with its full result, the spec rendered from its markdown (headings, lists, code fences, inline code, built with `textContent` only), acceptance checks (pass, fail or no verdict yet, with evidence), each session's last lines and cost, with a live dot while it runs (refreshed then), and the activity timeline, newest first.
- **Approval undone flag** (`.flag`, [D0031](decisions/D0031-no-silent-surprises.md)). A small red pill (`danger-soft` ground, `danger` text) on a task a person approved that was then sent back: an agent's or person's rework, or the merge queue's conflict send-back. An auto-approved task never gets it. Its title says who, when and why. It clears on a new approval, a merge or a cancel, and an approved task never shows it. In the panel, a `.flag-note` on `danger-soft` under the title: "Your approval was undone", who sent it back and when, the reason, and what happens next (verified again, then back to you).
- **Queue notice** (`.qnote`, D0031). A Run queue result, at the top of the list (in the Approved column on the board), so it stays in sight when Approved empties. Its ground is tinted by outcome: `go-soft` only if something merged, `attn-soft` if nothing did, `danger-soft` if anything failed. A head line ("Merge queue: Merged #12 · 1 skipped", in the outcome's colour), how long ago, **Run again** and dismiss; then one line per PR: an outcome chip (Merged, Sent back, Skipped, Error), the id and the queue's reason. After a merge with more still approved, a muted line says a pass merges at most one PR, so run it again for the next. It clears itself once a task it names changes status.
- **Command palette.** Centred near the top: an input, a chip naming the selected task, grouped results with each command's key, and a footer with the palette's own keys. Commands that can't run here are dimmed and say why. The first command is Open or Close the task, so Enter straight after Mod K never approves or merges.
- **Shortcuts dialog.** Drawn from `SHORTCUTS` in `page.ts`, grouped General, Move, Go to, Act. The undo note and Close sit in a fixed footer.
- **Toasts.** Bottom left of the sheet, at most four. Each approve, merge or queue result, and short confirmations (copied, can't act here). Successes leave after 6 s, the rest after 14 s, and each has a dismiss button. An approval undone while the board is open raises a red toast once that stays until dismissed; a conflict send-back's leaves after 14 s, since the queue notice reports it, and the person who signs off on this board gets none for their own rework. Sticky toasts are dropped last when more than four pile up.
- **Empty states.** No tasks at all: how to add one from the terminal. A filter with no match: "Press Esc to clear the filter." A project with no tasks: "Pick All projects in the sidebar." Needs you with nothing waiting: "Nothing to sign off." and "Nothing to merge." under their headers.

## States
- **Hover:** the `hover` fill. **Current / selected:** the `active` fill (nav), the `active` fill and an ink edge bar (rows), an ink ring (cards), or a surface fill with a 1px ring (the List/Board switch). **Focus:** a 2px ink outline, offset 2px, on anything focusable.
- **Disabled:** sunk fill, faint text, and the reason in a title and in the panel.
- **Results:** `.out.ok` green, `.out.skip` amber (skipped, sent back), `.out.bad` red. The queue notice uses the same three: `.qnote.ok`, `.skip`, `.bad`.
- **Offline:** the live dot turns red and says "Offline, retrying"; polling continues.
- **Live session:** a pulsing green dot on the row or card, and on the session's heading in the panel.

## Phone (48em and below)
- The sidebar becomes a sheet that slides in from the left behind a menu button in the top bar, with a scrim.
- The sheet loses its frame. The filter takes its own line. Controls, nav items and buttons grow to the touch height. Key hints hide on any touch screen (`hover: none`), whatever its width.
- Rows wrap: the title can take two lines, and the id, assignee and age move to a line under it.
- The board snaps one column per screen, Needs approval and Approved first.
- The detail panel is full screen. Toasts span the width.
- Between 48em and 56em the list leaves out risk tags and project chips.

## Keyboard
One list, `SHORTCUTS` in `page.ts`, draws the `?` dialog; a test checks it against the key handler. Mod is ⌘ on a Mac and Ctrl elsewhere. Keys are ignored while typing in the filter, except Esc, and Enter or ↓ (to the first match).

| Keys | What it does |
|---|---|
| Mod K | command palette: every action, view and task |
| `/` | filter the tasks |
| `?` | show the shortcuts |
| Esc | close the topmost thing (shortcuts, phone sidebar, panel), else clear the filter, else clear the selection |
| `j` / ↓, `k` / ↑ | next, previous task (in the list, open groups only) |
| `h` / ←, `l` / → | previous, next column, same row (board) |
| Enter / `o` | open the task |
| `g n`, `g a` | go to Needs you, All tasks |
| `g 1` … `g 9` | go to that project (with several) |
| `v` | switch between list and board |
| `a`, `m` | approve, merge the open task, or the selected one if it is still on screen; on a task that can't be acted on here, a toast says why |
| `u` | undo the last approve or merge |
| `p` | open the task's pull request |

With the panel open, `j` and `k` keep moving and the panel follows. A task already waiting out its undo window or in a request, alone or in Approve all, is never scheduled twice. Keyboard focus stays on the selected task across re-renders. In the palette: ↑ ↓ (or Ctrl N / Ctrl P) move, Enter runs, Esc closes. The palette offers, in this order: for the selected task, open or close, approve, merge, open the PR, copy the id; go to a view or project; list or board, show or hide finished tasks, filter, shortcuts; Sign off: undo, Approve all (only the tasks the filter shows) and Run the merge queue; and every task, by id, title, status or project.

## What is remembered
In `localStorage`, per browser: List or Board, and which groups are folded (Done and Cancelled start folded). It is a convenience only; if storage is blocked the page uses the defaults. The token stays in `sessionStorage` (D0021).

## Rules for a change
- **Tokens only.** `board.css` and `page.ts` use `var(--…)`, never a raw colour or px. `bun run board:design` (part of `bun run check`) runs `design-kit lint` over `src/board/` and fails otherwise. Media queries use `em`.
- **Contrast.** A new text colour, or a new surface under text, must meet WCAG AA in light and dark; `packages/foreman/test/board-design.test.ts` checks every text pair in `tokens.css`.
- **One filled button per place.** The list or board shows one ink button at a time, the selected task's action; the panel has one, its task's action.
- **No shadows at rest.** Shadows are for layers that float over the page; a selected control on the page gets a 1px ring instead.
- **Colour only for meaning.** A new hue needs a meaning first, and then it is a role token.
- **New keys go in `SHORTCUTS`**, so the dialog and the handler stay one list.
- **Text through `textContent`, inline only.** No external assets or fonts, no `innerHTML` with task text, everything under the page's CSP nonce.
