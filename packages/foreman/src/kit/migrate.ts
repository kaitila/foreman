// Moving a project made before D0026 (the M7 kit, D0018 and D0020) off its vendored tarballs.
// Each step is a pure function of the file's text, so sync can print it, and skip writing it on a dry run.
import { FOREMAN_SERVER, indentOf, type Installed, type KIT_PACKAGES, OLD_SCOPE } from "./kit";
import { SCOPE } from "./install";
import { type Piece, PIECES, pieceOfFile } from "./pieces";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The kit package a vendored tarball path holds (`.meta-repo/packages/docs-check-<hash>.tgz`), or undefined. */
export const legacyTarball = (path: string) => /^\.meta-repo\/packages\/([a-z0-9-]+)-[0-9a-f]+\.tgz$/.exec(path)?.[1];

/** The piece that brought each kit package. */
const PIECE_OF_PACKAGE: Record<(typeof KIT_PACKAGES)[number], Piece> = { "docs-check": "docs", "test-kit": "test-kit", "design-kit": "design" };

/**
 * The pieces of a pre-D0026 record. One made by create (it names a preset) had every piece. One
 * made by init has the pieces of the files it recorded: the kit's .claude files, and the tarballs of
 * the packages a piece brings. A record that already lists pieces keeps them.
 */
export function inferPieces(rec: Installed): Piece[] {
  if (rec.pieces) return rec.pieces;
  if (rec.preset) return [...PIECES];
  const have = new Set<Piece>();
  for (const path of Object.keys(rec.files)) {
    const pkg = legacyTarball(path);
    if (pkg) {
      const piece = (PIECE_OF_PACKAGE as Record<string, Piece | undefined>)[pkg]; // foreman's own tarball brought no piece
      if (piece) have.add(piece);
    } else if (path.startsWith(".claude/")) have.add(pieceOfFile(path));
  }
  return PIECES.filter((p) => have.has(p));
}

/**
 * Remove one `"name": "value"` entry from a JSON object's text, with the comma that went with it,
 * leaving the rest of the file as it was.
 */
function removeEntry(text: string, entry: RegExp): string {
  const m = entry.exec(text);
  if (!m) return text;
  let start = m.index;
  let end = start + m[0].length;
  const comma = /^\s*,/.exec(text.slice(end));
  const before = /,\s*$/.exec(text.slice(0, start));
  if (comma) {
    // A middle (or first) entry: drop it, its trailing comma, and the whitespace before it.
    end += comma[0].length;
    while (start > 0 && /\s/.test(text[start - 1]!)) start--;
  } else if (before) start = before.index; // the last entry: drop the comma before it
  else while (start > 0 && /\s/.test(text[start - 1]!)) start--; // the only entry
  return text.slice(0, start) + text.slice(end);
}

const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * package.json without its vendored tarballs (D0018, D0020): each kit package's `file:.meta-repo/packages/...`
 * dependency, under the old scope or this one, becomes `<scope>/<pkg>` at `version`, and a vendored foreman
 * is removed (projects run the person's own fm, D0026). A text edit, so the rest of the file stays; if the
 * edit doesn't parse, the file is rewritten as JSON in its own indent.
 */
export function migratePackageJson(text: string, version: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const scopes = `(${esc(OLD_SCOPE)}|${esc(SCOPE)})`;
  const tarball = (pkg: string) => `"file:\\.meta-repo/packages/${pkg}-[0-9a-f]+\\.tgz"`;
  let out = text;
  for (;;) {
    // The tarball must hold the package the entry names (the \2 backreference).
    const m = new RegExp(`"${scopes}/([a-z0-9-]+)"\\s*:\\s*"file:\\.meta-repo/packages/\\2-[0-9a-f]+\\.tgz"`).exec(out);
    if (!m) break;
    const [, scope, pkg] = m as unknown as [string, string, string];
    const entry = new RegExp(`"${esc(scope)}/${pkg}"\\s*:\\s*${tarball(pkg)}`);
    if (pkg === "foreman") {
      out = removeEntry(out, entry);
      notes.push(`${scope}/foreman removed (the foreman MCP server is your own fm)`);
    } else {
      out = out.replace(entry, `"${SCOPE}/${pkg}": "${version}"`);
      notes.push(`${scope}/${pkg} tarball -> ${SCOPE}/${pkg} ${version}`);
    }
  }
  if (out === text) return { text, notes };
  try {
    JSON.parse(out.replace(/^﻿/, ""));
    return { text: out, notes };
  } catch {
    // The text edit broke the file (an odd layout): rewrite it as JSON with the same changes.
    const pkg = JSON.parse(text.replace(/^﻿/, "")) as Record<string, Record<string, string> | undefined>;
    for (const key of DEP_KEYS) {
      const deps = pkg[key];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        const m = new RegExp(`^${scopes}/([a-z0-9-]+)$`).exec(name);
        if (!m || !new RegExp(`^${tarball(m[2]!).slice(1, -1)}$`).test(spec)) continue;
        delete deps[name];
        if (m[2] !== "foreman") deps[`${SCOPE}/${m[2]}`] = version;
      }
    }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return { text: (text.startsWith("﻿") ? "﻿" : "") + (JSON.stringify(pkg, null, indentOf(text)) + "\n").replaceAll("\n", eol), notes };
  }
}

/** The foreman servers D0020 wrote into `.mcp.json`: the vendored package's own file, under either scope. */
const LEGACY_SERVERS = [OLD_SCOPE, SCOPE].map((scope) => JSON.stringify({ type: "stdio", command: "bun", args: [`node_modules/${scope}/foreman/src/cli.ts`, "mcp"] }));

/**
 * `.mcp.json` with its foreman server as `fm mcp`, but only if it's still exactly the server D0020 wrote.
 * One the project changed is its own. Rewritten whole in its own indent and line endings, as init does. Null: no change.
 */
export function migrateMcp(text: string): string | null {
  let mcp: { mcpServers?: Record<string, unknown> };
  try {
    mcp = JSON.parse(text);
  } catch {
    return null;
  }
  const server = mcp?.mcpServers?.foreman;
  if (!server || !LEGACY_SERVERS.includes(JSON.stringify(server))) return null;
  mcp.mcpServers!.foreman = FOREMAN_SERVER;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return (JSON.stringify(mcp, null, indentOf(text)) + "\n").replaceAll("\n", eol);
}

/**
 * foreman.json with its `foreman` range raised to `>=version` (D0026), as a text edit. A range of the
 * form `>=x` lower than this is raised; a missing one (a project from before ranges) is added after
 * `$comment`; any other range is the project's own and kept. Null: no change.
 */
export function raiseForemanRange(text: string, version: string): { text: string; from: string | null } | null {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) return null;
  const want = `>=${version}`;
  const range = cfg.foreman;
  let out: string;
  if (range === undefined) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const entry = `${indentOf(text)}"foreman": ${JSON.stringify(want)},`;
    const comment = /("\$comment"\s*:\s*"(?:[^"\\]|\\.)*"\s*,)/.exec(text);
    const at = comment ? comment.index + comment[0].length : text.indexOf("{") + 1;
    out = `${text.slice(0, at)}${eol}${entry}${text.slice(at)}`;
  } else {
    const m = typeof range === "string" ? /^>=\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim()) : null;
    if (!m || Bun.semver.order(m[1]!, version) >= 0) return null;
    out = text.replace(/("foreman"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(want)}`);
  }
  try {
    if ((JSON.parse(out.replace(/^﻿/, "")) as { foreman?: unknown }).foreman === want) return { text: out, from: (range as string | undefined) ?? null };
  } catch {}
  const { $comment, ...rest } = cfg;
  const obj = $comment === undefined ? { foreman: want, ...rest } : { $comment, foreman: want, ...rest };
  return { text: JSON.stringify(obj, null, indentOf(text)) + "\n", from: (range as string | undefined) ?? null };
}
