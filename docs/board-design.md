# The board's design system

How `fm serve`'s page looks and behaves, and the rules a change to it follows. The code is in `packages/foreman/src/board/`: `tokens.css` (every raw value), `board.css` (the components, tokens only) and `page.ts` (the markup and the page script). The choice is [D0027](decisions/D0027-board-design-system.md). What the board does (sign-off, merging, projects, the API) is in [foreman's README](../packages/foreman/README.md#board).

## Principles
- **Quiet.** Neutral greys do the work. A screen at rest is text, thin lines and one filled button at most: the selected task's action.
- **Colour means something.** Three hues, each with one meaning, and nothing decorative:
  - attention (amber): waits for you to sign off, checks pending, a skipped or sent-back result;
  - go (green): approved, checks green, a done write, the live dot;
  - danger (red): something failed or was undone: failed, conflicting, moved since verified, offline, an undone approval, the Human only risk tag. A result that isn't a merge is never green.

  Project colour labels are the one exception: they say which project, not what state, so they are only ever small dots ([D0028](decisions/D0028-project-colour-labels.md)).
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
| Selection | `--color-selected`, `-selected-strong`, `-selected-line` | A cool neutral, so a chosen task doesn't read as disabled grey. `selected` for the selected task, `selected-strong` for the open one, `selected-line` for their 1px ring. Text on them meets AA. |
| Labels | `--label-gray`, `-red`, `-orange`, `-yellow`, `-green`, `-teal`, `-blue`, `-purple`, `-pink`; `--label-size` 8 / `--label-size-lg` 10 px | Project colour labels, light and dark. Dots only, never under text. |
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
- **Sidebar.** The mark and `127.0.0.1`; a **Search…** button that opens the palette and shows its key; the views **Needs you** (count in amber), **All tasks** and **Plans** (the active plans; both counts in faint ink); a **Projects** label (**Project** when there is one), All projects when there are several, and each project with its colour label dot, its total in grey, an amber dot when something there waits for you and the dispatcher marker when one runs there. The label dot is its own button: it opens the palette's colour step for that project, even with a single project; at the foot, the live dot ("Live" or "Offline, retrying") and **Shortcuts ?**. The current item has the `active` fill.
- **Top bar.** Title with its scope (`project / Needs you`, with the project's label dot), the count (`3 of 12` while filtering), the filter field (sunk fill, `/` hint), and the List/Board switch.
- **Notice.** One line on `--color-attn-soft` under the top bar when the page can't write (no token, read-only board).
- **Dispatcher strip** (`.dstrip`, [D0041](decisions/D0041-dispatcher-registry.md)). Under the notice and above the list or board, in every view, so the person sees whether work will start without looking for a process. One line per dispatcher running in the projects in view, oldest first: the plain green dot (it runs; no pulse, which is for a session), **Dispatcher**, the project chip (All view only), its scope (`everything` for now), **2 of 3 slots** in ink (sessions running out of `--max`), an outlined pill per flag worth knowing (**verify only**, **once**), who started it (`by ada`, or `by session 0934d487` for one an agent's session started: the first eight characters of the id, the full name and id in the title), `started 5 min ago`, and the tasks its sessions are on, each the id in mono with its role, linked to the task (it opens the panel), or "nothing in flight" in faint ink. With none running it is one line in faint ink at the small size: "No dispatcher is running, so no new session will start. Start one from the terminal: `fm dispatch`", naming the project when one is picked. The lines wrap at any width. It holds no button: the board never starts or stops a dispatcher, because starting sessions spends money and the token is for sign-off. No new colour: text tiers and the go dot only. It follows the live updates (every poll carries the running dispatchers), and is rebuilt only when what it says changes, so a focused link stays focused.
- **Dispatcher marker** (`.disp-mark`). In the sidebar, on each project where a dispatcher runs: a small green play glyph and the slots in use over the total (`2/4`, summed when several run), in faint ink before the task count. Its title says it in words.
- **Label dot** (`.label-dot`). A project's colour label: an 8 px dot from its `--label-*` token. It shows beside the project's name in the sidebar, the project chip on rows, cards and phone sublines, the panel's crumb and Project property, the title scope and palette items. An unlabelled project shows no dot, except in the sidebar and palette, where it gets a hollow ring to click.
- **List rows.** Status glyph, id, title, then fixed slots on the right, so columns line up from row to row: live dot (a session is running), project chip with its label dot (All view only), risk tag (**Review risk** or **Human only**; nothing for auto), the action, the PR number, avatar, and how long ago it changed. The action slot is kept only when some visible row needs you. An approved row shows the PR's state (checks green, pending, red, conflicts, or "GitHub is checking if it merges" while GitHub answers `UNKNOWN`) with its Merge button. Hover and selection are a rounded highlight inset behind the row (`lg` radius), not a fill edge to edge: hover is the `hover` fill; the selected row is `selected` with a 1px `selected-line` ring, which is its focus indicator; the open row (its panel is showing) is `selected-strong`. A task whose approval was undone has the **Approval undone** flag after its title.
- **Plans view** ([D0033](decisions/D0033-plans.md)). Read-only, from the plans core. The list groups plans like the task list groups tasks: **Active**, then **Done** and **Cancelled**, folded at first (remembered with the other folds). A plan row is a list row: a glyph (an empty ring until a step is under way, then half full; the Done and Cancelled discs), the id, the title, then one step glyph per step in order and "1 of 3 steps · 1 of 3 tasks" in faint ink (on a phone the progress moves to the line under the title). Clicking a row, or Enter on it, opens the plan. **A plan:** a quiet **Plans** back button (Esc), a line with the glyph, id, state and progress, the title (the panel title's size), the cancel reason if it was cancelled, and the goal rendered like a spec. Then each step in order, as a sticky group header (its state glyph, `n. title`, the state in faint ink, the task count on the right), a **Check** line under it, and its tasks as normal task rows, with their actions, that open the task panel. A step with no tasks says how to file one. Step states are drawn with the task glyph they read like: empty is the dashed ring, waiting the empty ring, in progress half full, done the check. No new colour: a plan's state is never green or amber. List or Board doesn't apply here, so the switch hides.
- **Group headers.** Sticky, sunk fill: chevron, glyph, name, count, and the group's action on the right: **Approve all n** (Needs approval, two or more) and **Run queue** (Approved). Clicking the header folds the group.
- **Board cards.** One column per status in workflow order, Draft to Cancelled. In Needs you, only the Needs approval and Approved columns show. A card shows id, project chip, age, title, the Approval undone flag, risk, PR, live dot, avatar and its action. Empty columns are narrow and say so. The selected card has the `selected` fill with a `selected-line` border and ring; the open card has `selected-strong` with an `ink-faint` border and ring. While the panel is open, the board gets room at its end and scrolls the open card clear of the panel.
- **Status glyphs** (`.si`, 14 px), one shape per status:
  - Draft: dashed ring. Ready: empty ring.
  - Claimed, In progress, In review / Verifying: the ring fills a quarter, a half, three quarters.
  - Needs approval: three quarters, amber.
  - Approved: green disc with a check. Done: grey disc with a check. Cancelled: grey disc with an x.
- **Buttons.** `.btn` is the outlined default. `.btn.approve` and `.btn.merge` are the filled (ink) button, but on rows and cards they are outlined until their task is selected, so one filled button shows at a time; the panel's action is always filled. Merge is strong only when the PR reads as mergeable (at the verified commit, checks green, `MERGEABLE`); otherwise it stays outlined even when selected, so it reads as a try. On a PR GitHub calls `CONFLICTING` the merge button reads **Send back #n**, since the pass sends it back to its worker; its title says so, and that it merges instead if GitHub says it merges cleanly by then. The undo bar reads "Sending back" and the busy text "Sending back…". Disabled buttons are sunk and say why on hover and in the panel. `.icon-btn` is a bare square for icons.
- **Undo bar** ([D0021](decisions/D0021-board-one-click-sign-off.md)). In place of the button: "Approving in 4 s" over a fill that drains for the undo window, and a small ink **Undo**. Then "Approving…" / "Merging…" with a spinner while the request runs.
- **Detail panel.** A floating sheet on the right: a bar with project (and its label dot) / glyph / id, previous, next and close; then the title, the undone note if there is one, properties (status, risk, assignee, branch, pull request with its state, updated, project, and for a task in a plan its **Plan**, linked to the plan, and **Step** with the step's state glyph), the action with its full result, the spec rendered from its markdown (headings, lists, code fences, inline code, built with `textContent` only), acceptance checks (pass, fail or no verdict yet, with evidence), each session's last lines and cost, with a live dot while it runs (refreshed then), and the activity timeline, newest first.
- **Approval undone flag** (`.flag`, [D0031](decisions/D0031-no-silent-surprises.md)). A small red pill (`danger-soft` ground, `danger` text) on a task a person approved that was then sent back: an agent's or person's rework, or the merge queue's conflict send-back. An auto-approved task never gets it. Its title says who, when and why. It clears on a new approval, a merge or a cancel, and an approved task never shows it. In the panel, a `.flag-note` on `danger-soft` under the title: "Your approval was undone", who sent it back and when, the reason, and what happens next (verified again, then back to you).
- **Queue notice** (`.qnote`, D0031). A Run queue result, at the top of the list (in the Approved column on the board), so it stays in sight when Approved empties. Its ground is tinted by outcome: `go-soft` only if something merged, `attn-soft` if nothing did, `danger-soft` if anything failed. A head line ("Merge queue: Merged #12 · 1 skipped", in the outcome's colour), how long ago, **Run again** and dismiss; then one line per PR: an outcome chip (Merged, Sent back, Skipped, Error), the id and the queue's reason. The reason sits beside them where at least `reason-min` is left for it (the list), and takes its own line below where there isn't (a board column, a phone). After a merge with more still approved, a muted line says a pass merges at most one PR, so run it again for the next. It clears itself once a task it names changes status.
- **Command palette.** Centred near the top: an input, a chip naming the selected task, grouped results with each command's key, and a footer with the palette's own keys. Commands that can't run here are dimmed and say why. The first command is Open or Close the task, so Enter straight after Mod K never approves or merges. **Colour step:** "Colour label for <project>…" (or the sidebar's label dot) turns the palette into a list of the nine colours and No colour, with the current one marked and highlighted; Enter sets it at once, with no undo window. Esc, or Backspace in an empty input, goes back to the commands.
- **Shortcuts dialog.** Drawn from `SHORTCUTS` in `page.ts`, grouped General, Move, Go to, Act. The undo note and Close sit in a fixed footer.
- **Toasts.** Bottom left of the sheet, at most four. Each approve, merge or queue result, and short confirmations (copied, can't act here). Successes leave after 6 s, the rest after 14 s, and each has a dismiss button. An approval undone while the board is open raises a red toast once. It stays until dismissed only when an agent undid it; a person's rework or a conflict send-back gives one that leaves after 14 s (the queue notice reports a conflict), and the person who signs off on this board gets none for their own rework. Sticky toasts are dropped last when more than four pile up.
- **Empty states.** No tasks at all: how to add one from the terminal. No plans: what a plan is and the `fm plan new` line. A filter with no match: "Press Esc to clear the filter." A project with no tasks: "Pick All projects in the sidebar." Needs you with nothing waiting: "Nothing to sign off." and "Nothing to merge." under their headers.

## States
- **Hover:** the `hover` fill (inset and rounded on rows). **Current / selected:** the `active` fill (nav), the inset `selected` highlight with a `selected-line` ring (rows), the `selected` fill and ring (cards), or a surface fill with a 1px ring (the List/Board switch). **Open:** `selected-strong` on the row or card whose panel is showing. **Focus:** a 2px ink outline, offset 2px, on anything focusable.
- **Disabled:** sunk fill, faint text, and the reason in a title and in the panel.
- **Results:** `.out.ok` green, `.out.skip` amber (skipped, sent back), `.out.bad` red. The queue notice uses the same three: `.qnote.ok`, `.skip`, `.bad`.
- **Offline:** the live dot turns red and says "Offline, retrying"; polling continues.
- **Live session:** a pulsing green dot on the row or card, and on the session's heading in the panel.
- **Dispatcher running:** a still green dot at the start of its line in the dispatcher strip, and the green play glyph in the sidebar. None running is not an error: faint text, no colour.

## Phone (48em and below)
- The sidebar becomes a sheet that slides in from the left behind a menu button in the top bar, with a scrim.
- The sheet loses its frame. The filter takes its own line. The dispatcher strip wraps each dispatcher onto as many lines as it needs, with more room between dispatchers. Controls, nav items and buttons grow to the touch height. Key hints hide on any touch screen (`hover: none`), whatever its width.
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
| Esc | close the topmost thing (shortcuts, phone sidebar, panel, the open plan), else clear the filter, else clear the selection |
| `j` / ↓, `k` / ↑ | next, previous task (in the list, open groups only), plan (in the Plans list) or task of the open plan |
| `h` / ←, `l` / → | previous, next column, same row (board) |
| Enter / `o` | open the task, or the plan in the Plans list |
| `g n`, `g a`, `g p` | go to Needs you, All tasks, Plans |
| `g 1` … `g 9` | go to that project (with several) |
| `v` | switch between list and board |
| `a`, `m` | approve, merge the open task, or the selected one if it is still on screen; on a task that can't be acted on here, a toast says why |
| Shift `A` | Approve all: every task in view that needs approval (project and filter), through the undo window |
| Shift `M` | Run the merge queue for the approved tasks in view, through the undo window |
| `u` | undo the last approve or merge |
| `p` | open the task's pull request |

With the panel open, `j` and `k` keep moving and the panel follows. A task already waiting out its undo window or in a request, alone or in Approve all, is never scheduled twice. Keyboard focus stays on the selected task across re-renders. In the palette: ↑ ↓ (or Ctrl N / Ctrl P) move, Enter runs, Esc closes (in the colour step, Esc or Backspace on an empty input goes back). The palette offers, in this order: for the selected task, open or close, approve, merge, open the PR, copy the id; go to a view (Needs you, All tasks, Plans, and Back to Plans in a plan) or project; a colour label for each project, the current task's project first; list or board, show or hide finished tasks, filter, shortcuts; Sign off: undo, Approve all (Shift A; only the tasks the filter shows) and Run the merge queue (Shift M); then plans (four with nothing typed) by id, title, state or project, with their progress; and every task, by id, title, status or project.

## What is remembered
In `localStorage`, per browser: List or Board, and which groups are folded (Done and Cancelled start folded, for tasks and for plans). It is a convenience only; if storage is blocked the page uses the defaults. The token stays in `sessionStorage` (D0021). Colour labels are not kept in the browser: they live in the project registry, so every browser and `fm projects` show the same ones (D0028).

## Rules for a change
- **Tokens only.** `board.css` and `page.ts` use `var(--…)`, never a raw colour or px. `bun run board:design` (part of `bun run check`) runs `design-kit lint` over `src/board/` and fails otherwise. Media queries use `em`.
- **Contrast.** A new text colour, or a new surface under text, must meet WCAG AA in light and dark; `packages/foreman/test/board-design.test.ts` checks every text pair in `tokens.css`.
- **One filled button per place.** The list or board shows one ink button at a time, the selected task's action; the panel has one, its task's action.
- **No shadows at rest.** Shadows are for layers that float over the page; a selected control on the page gets a 1px ring instead.
- **Colour only for meaning.** A new hue needs a meaning first, and then it is a role token.
- **Labels are identity, not meaning.** A project's colour is a dot beside its name, never a fill, a border or a text colour, and never stands in for amber, green or red.
- **New keys go in `SHORTCUTS`**, so the dialog and the handler stay one list.
- **Text through `textContent`, inline only.** No external assets or fonts, no `innerHTML` with task text, everything under the page's CSP nonce.
