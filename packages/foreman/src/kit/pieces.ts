// The kit's opt-in pieces (D0026). `fm init` always sets up foreman itself; each piece is
// chosen by name (a checklist in a terminal, --with, --all), and added later with `fm init --with`.

export const PIECES = ["docs", "guardrails", "skills", "ci", "test-kit", "design"] as const;
export type Piece = (typeof PIECES)[number];

export interface PieceInfo {
  /** One line on what it adds, for the checklist and `fm help`. */
  about: string;
  /** Refused in a repo without package.json. */
  needsPackageJson: boolean;
}

export const PIECE_INFO: Record<Piece, PieceInfo> = {
  docs: { about: "AGENTS.md and CLAUDE.md skeletons and the decision log; with package.json, docs-check and a docs:check script", needsPackageJson: false },
  guardrails: { about: ".claude/settings.json's baseline rules, and the guard and session-start hooks", needsPackageJson: false },
  skills: { about: "the ship and verify skills, and the test-writer, docs-writer, reviewer and design-critic agents", needsPackageJson: false },
  ci: { about: "a CI workflow that runs bun run check (when package.json has a check script)", needsPackageJson: true },
  "test-kit": { about: "@foreman-kit/test-kit: a database per worktree, fake fetch and fake LLM for tests", needsPackageJson: true },
  design: { about: "@foreman-kit/design-kit: one tokens file, a lint against raw values, screenshots", needsPackageJson: true },
};

/** The pieces that bring kit files sync keeps up to date. A record from before pieces had both. */
export const FILE_PIECES: Piece[] = ["guardrails", "skills"];

export const isPiece = (s: string): s is Piece => (PIECES as readonly string[]).includes(s);

/** `docs,guardrails` (or spaces) as pieces, in the kit's order. Throws on a name that isn't one. */
export function parsePieces(list: string): Piece[] {
  const names = list.split(/[\s,]+/).filter(Boolean);
  const bad = names.filter((n) => !isPiece(n));
  if (bad.length) throw new Error(`unknown piece${bad.length > 1 ? "s" : ""}: ${bad.join(", ")} (have: ${PIECES.join(", ")})`);
  return PIECES.filter((p) => names.includes(p));
}

/** The piece a kit template file belongs to, by its path in a project. */
export function pieceOfFile(rel: string): Piece {
  return rel.startsWith(".claude/skills/") || rel.startsWith(".claude/agents/") ? "skills" : "guardrails";
}

/** The checklist shown in a terminal: one numbered line per piece. */
export function checklist(): string {
  return PIECES.map((p, i) => `  ${i + 1}. ${p.padEnd(10)} ${PIECE_INFO[p].about}`).join("\n");
}

/** An answer to the checklist: numbers or names, `all`, or nothing for foreman alone. */
export function parseAnswer(answer: string): Piece[] {
  const a = answer.trim().toLowerCase();
  if (!a) return [];
  if (a === "all") return [...PIECES];
  return parsePieces(a.split(/[\s,]+/).map((x) => (/^\d+$/.test(x) ? (PIECES[Number(x) - 1] ?? x) : x)).join(","));
}
