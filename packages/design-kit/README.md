# design-kit

Keeps an app's look in one file. `tokens.css` holds every raw value (colour, type scale, spacing, radius, motion, light and dark); stylesheets and components name tokens, and a lint fails when they don't. Why it's built this way: [D0017](../../docs/decisions/D0017-design-kit.md).

```sh
design-kit tokens <tokens.css> [--out tokens.ts] [--check]
design-kit lint [paths...] [--tokens tokens.css]
design-kit screenshot <url> [--out dir] [--widths 390,1280] [--executable path]
```

Exit codes: 0 clean, 1 findings (or `tokens.ts` out of date), 2 couldn't run, 3 no browser for screenshots.

## Tokens
[tokens.css](tokens.css) is the default palette: warm paper and ink with one green accent, a serif display face over the system sans, a major-third type scale, a 4px spacing grid in rem. Every text pair meets WCAG AA in both schemes, and a test checks it.

The format is strict, so the file stays a list of values:
- one `:root` block of custom properties (`--color-bg: #f6f4ef;`) and `color-scheme`;
- optional `:root` blocks inside `@media (prefers-color-scheme: dark)` and `@media (prefers-reduced-motion: reduce)` that override tokens already defined.

A token may name another (`--color-focus: var(--color-accent)`).

`design-kit tokens` writes `tokens.ts` next to it: `vars` (`vars.colorBg` is `"var(--color-bg)"`) for inline styles, and `light` and `dark` with the final values, for the few places CSS variables can't reach, like `<meta name="theme-color">`. `--check` fails when `tokens.ts` is stale. [tokens.ts](tokens.ts) here is generated from this package's `tokens.css`, and a test keeps it current.

An app made from the preset owns a copy of the tokens file. To re-skin it, edit that copy and run `design-kit tokens` on it.

## The lint
`design-kit lint` reads every `.css`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.html` file under the paths given, skipping `node_modules` and dot folders. The tokens file (`--tokens`, or the first `tokens.css` found) and files design-kit generated are skipped.

| Rule | Fails on |
|---|---|
| raw-color | a hex colour (`#e11d48`), or `rgb()`, `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, or a CSS named colour (`red`, `rebeccapurple`, `White`: the full CSS Color 4 list, any case, whole words only) |
| raw-px | any non-zero `px` length, including in `@media` (use `em` there) |
| unknown-token | `var(--x)` where `--x` is neither a token nor a custom property the same file defines |

In CSS only declaration values and at-rule conditions are read, so an id selector like `#add` isn't taken for a colour. In JS and TS, comments are skipped and strings are read. A line containing `design-lint-allow` is skipped: say why on the same line.

Named colours: `transparent`, `currentColor`, `inherit` and the other CSS-wide keywords are allowed. In CSS the value is read without its quoted strings, `url()`, `attr()`, `local()`, `counter()` and the name inside `var()` (a fallback, `var(--x, red)`, is read), and `font`, `font-family`, `animation(-name)`, `grid-area` and the other properties that hold names are skipped. In JS, TS and HTML a colour word counts only inside a string that is a style value: `"color: red"`, `style="background: tomato"`, or the value after a colour key (`fill="navy"`, `{ color: "red" }`). Words in code (`red`, `white`) and other strings never do.

Not caught: bare numbers in JS style objects; named colours in unquoted or computed JS values; a colour word used as a name inside a property not on the skip list (e.g. a custom property holding a custom ident).

## Screenshots
`design-kit screenshot` writes `page-<width>-<scheme>.png` at each width, light and dark, and says when a page scrolls sideways. It needs playwright-core and a browser, which this package doesn't install. Without them it exits 3 and says how to add them. The design-critic agent (agent-kit's `templates/claude/agents/design-critic.md`) uses it when it's there, and reviews the served markup and styles when it isn't.

## API
`parseTokens`, `generateTs`, `lint`, `lintText`, `parseCss`, `resolveStyles` (each declaration with its `var()` filled from the tokens: how the demo's test proves a tokens-only edit re-skins the page) and `contrast` (WCAG ratio of two hex colours), from `@meta-repo/design-kit`.
