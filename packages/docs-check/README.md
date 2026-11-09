# docs-check

Keeps a repository's docs true to its code. It was taken from a production codebase whose docs agents maintain, fixed in the places that were fragile (links with parentheses, malformed `%` escapes, dates like 2026-02-30, fences inside fences), and made configurable.

```sh
bun packages/docs-check/src/cli.ts [--json] [--write-index] [--strict-freshness] [--root dir]
```

Exit codes: 0 clean (warnings allowed), 1 failures, 2 couldn't run.

## Checks
| Check | Fails when |
|---|---|
| links | a relative link points at a file that doesn't exist, or a `#anchor` that file doesn't have (GitHub's heading slugs) |
| paths | a backticked repo path (`src/app.ts`, `src/app.ts:12`) doesn't exist. A span counts as a path only if its first folder is a top-level folder of the repo; globs, `<placeholders>` and spans with spaces are skipped. |
| decisions | one file per decision in `docs/decisions/`, named `D0001-short-slug.md`. Rules: the heading is `# D0001. The decision as a sentence (YYYY-MM-DD)`, with a real date that isn't in the future. Exactly one `**Status:**` line comes right after it: `Active`, `Paused[ (D0005)]`, `Superseded by D0004` or `Amended by D0002[, D0003]`. Status targets must exist and be later decisions. `**Chosen:**`, `**Why:**` and `**Revisit if:**` each appear once, in that order. Numbers start at 1 and are unique: two branches that both took the same number fail here. Gaps are allowed, because numbers are handed out to parallel branches (foreman's `reserve_number`): a lower one may still be on an open PR, or reserved and never used (D0016). |
| index | `docs/decisions/README.md` isn't the generated index (`--write-index` writes it) |
| refs | a `Dnnnn` (padded, so "D3 chart" is ignored) names no decision |
| reviewed | a `Last reviewed: YYYY-MM-DD (through Dnnnn)` line is malformed, future-dated or names an unknown decision. Older than 90 days is a warning, or a failure with `--strict-freshness`. |
| registries | opt-in code↔doc lists, e.g. `envRegistry`: every env var the code reads (outside tests and `.claude/`, which is agent tooling) is in the doc's table, the doc lists nothing the code doesn't read, and `.env.example` holds only real keys |

A line ending in `<!-- docs-check: planned -->` (or `removed`, `elsewhere`) skips its link and path checks: for a file that's coming, gone, or in another repo.

Files come from `git ls-files` (tracked and untracked-but-not-ignored), so an ignored file counts as missing. Outside a git repo, a plain walk is used.

## Config
Optional `docs-check.config.ts` at the repo root:

```ts
import { defineConfig, envRegistry } from "@foreman-kit/docs-check";
export default defineConfig({
  exclude: ["vendor/**"],
  decisions: { dir: "docs/decisions", pad: 4 }, // or false
  reviewed: { maxDays: 90 },                     // or false
  registries: [envRegistry({ doc: "docs/configuration.md" })],
});
```

A registry is `{ name, doc, fromCode(ctx), fromDoc?(text), bidirectional? }`. Extraction is by regex over source, so pair each registry with a test in your app that compares the regex's answer with the real list.
