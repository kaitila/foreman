# D0021. The board approves and merges in one click: the token rides in the URL fragment, and an undo window replaces the confirm (2026-11-05)

**Status:** Active

**Context:** The person signs off and merges from the terminal (`fm approve`, `fm merge-queue --once`) and wanted to do it from the board (`fm serve`, [D0011](D0011-foreman-dispatch.md)) instead. On the board, approving meant copying the token from the terminal into a password field on every task, and merging wasn't there at all. The token is the board's defence against cross-site requests and DNS rebinding, together with the Origin and Host checks, so it has to stay; the friction around it didn't. Every merge deploys in some projects, so a merge from the page must follow the merge queue's rules ([D0011](D0011-foreman-dispatch.md), [D0012](D0012-merge-queue-conflict-send-back.md)) exactly.

**Chosen:**
- **The token in the fragment.** `fm serve` prints one link, `http://127.0.0.1:4499/#t=<token>`. Browsers never send the fragment to the server, so the token still never appears in a request line, a page or an API response. The page moves it into `sessionStorage` (this tab only, gone when the tab closes), takes it off the address bar with `history.replaceState`, and sends it as the `x-foreman-token` header on each write. A 403 about the token (the board restarted with a new one) makes the page forget it and say to open the new link.
- **Three writes, one gate:** `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/merge` and `POST /api/queue/run` each need the token, our own Origin when the browser sends one, and our own Host, as approve did. A board started by an agent, or without an interactive terminal, has no token, so all three are off.
- **Merge is a merge-queue pass.** The merge endpoint runs `mergeQueuePass` with a new `only` option that limits it to that task; Run queue runs one ordinary pass. There is no second implementation: the same verified commit, settled green checks, `MERGEABLE`, `--match-head-commit`, and a conflict sends the task back. The board runs one pass at a time and answers a second request with 409 `busy`. The merge runs as the person who started the board.
- **An undo window, not a confirm.** Approve, Approve all, Merge and Run queue wait 5 seconds after the click, with a draining bar and an Undo button (and `u`), before the request is sent. The merge button names what it merges (`Merge #344`) and shows the queue's answer on the card: merged, sent back or skipped with the reason.
- **PR state on the card** comes from `GET /api/tasks/:id/pr`: the merge queue's first read (`readPr`, `judgeChecks`), cached for 15 seconds so polling the page doesn't poll GitHub.

**Why:**
- The fragment is the one part of a URL the browser keeps to itself, so the link can carry the token without the server ever serving it. The alternatives were worse: a cookie set by the server would put the token in a response and be sent automatically, which is the thing CSRF exploits; a query string lands in the server's request line and in history; pasting is what the person found too slow.
- `sessionStorage` rather than `localStorage`: the token lives no longer than the tab, and each `fm serve` makes a new one anyway.
- A confirm dialog gets clicked through by habit and blocks keyboard flow. A short delay with Undo keeps the one click, still catches the wrong card, and works the same for one task or a lane.
- Reusing the pass keeps the rules in one place, so a fix to the queue is a fix to the board.

**Revisit if:** the board is served on anything but 127.0.0.1, or to more than one person (then it needs real sign-in, not a shared token); a browser starts sending fragments or exposing `sessionStorage` across origins; or a 5-second window proves too short or too long in use.
