# D0029. Sessions do their own review, edit mechanically by script, and tasks claim narrow paths (2026-11-09)

**Status:** Amended by D0047

**Context:** Measured from the session transcripts of T-0081 and T-0083: a dispatched worker took 4.3 minutes and its verifier 4.0, of which about 1.5 minutes each was `bun run check`, run twice. T-0083, a rename, took 11 minutes in 140 Edit and 75 Read calls, nearly all of it model time, not tool time. T-0083 to T-0087 all declared `packages/**` or `docs/decisions/**`, so the dispatcher ([D0011](D0011-foreman-dispatch.md)) ran them one at a time with two of its three slots idle. Interactive sessions on `ship` (T-0079, T-0080) took 10 and 32 minutes with test-writer, docs-writer and reviewer each starting cold.

**Chosen:**
- **Narrow paths.** The intake prompt and `create_task`'s `paths` description ask for the narrowest globs that cover the task's files, say that overlapping tasks never run together, and name a shared file (package.json, a lockfile, AGENTS.md) only when the task edits it.
- **Scripted mechanical edits.** The worker prompt and `ship` say: make a many-file mechanical change (a rename, an import move) with one scripted edit, then read the diff.
- **One full check.** While working, the typecheck and the area's tests; the full check once, before pushing.
- **`ship` reviews in the session by default.** It spawns test-writer, docs-writer and reviewer only for a large change (a new feature, many files across areas) or a risky one (auth, sessions, secrets, data, CI or deploy files, a protected path). Dispatched workers already never fan out.

**Why:**
- Overlap is the dispatcher's only throttle besides `--max`, so a broad glob costs whole sessions of wall-clock, more than anything inside a session.
- A session's time is mostly model turns: one script replaces a hundred turns.
- Every task gets a fresh verifier (the `verify` skill), so a reviewer agent before it mostly repeats that review, and three cold agents re-read the same code. For large or risky changes a second pass still pays.

**Revisit if:** verifiers start failing tasks for gaps a reviewer agent would have caught, or narrow paths let two tasks that did overlap run together and conflict.
