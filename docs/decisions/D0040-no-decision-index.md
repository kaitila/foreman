# D0040. The decision index isn't committed: the folder of decision files is the list (2026-11-10)

**Status:** Active

**Context:** docs-check generated the decisions folder's README.md, a table of every decision with a count line at the top ("34 decisions: 13 amended, 21 active"), and failed when it was out of date. Every PR that added a decision rewrote the count line and added rows at the same place, so any two such PRs conflicted in that file even when nothing else overlapped. Each conflict made the merge queue send an approved PR back, which then needed main merged in, a fresh verification and the person's approval again. PR #81 bounced twice for this alone.

**Chosen:**
- `docs-check.config.ts` at the repo root sets `decisions: { index: false }`, an option docs-check already had. The index is no longer generated or checked here.
- That README.md is deleted. Each decision is still one file, `Dnnnn-short-slug.md`, with its title on the first line, and docs-check still checks each one.
- AGENTS.md no longer asks agents to run `docs:check --write-index`.
- The preset and the demo app keep their index for now. Whether new projects get one is a separate choice.

**Why:** A generated file that every change of one kind rewrites is a guaranteed merge conflict between any two such changes, and here each conflict cost a full re-verify and a second sign-off. The list it gave is one `ls` away, and the file names already say what each decision is.

**Revisit if:** people want a browsable summary again (then generate it at publish time, not in each PR), or the preset's projects run into the same conflicts.
