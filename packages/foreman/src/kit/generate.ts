// Make an app from a preset: its files with the placeholders filled in (presets/generate.ts is the CLI).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Files that are never part of an app made from a preset. */
const skipped = (name: string, isDir: boolean) => (isDir ? name === "node_modules" || name === ".git" : /^\.env($|\.(?!example$))/.test(name));

/**
 * Preset files kept under a source name without the dot, because Claude Code refuses an
 * unattended session's edits to the dotted name (D0023). Keyed by path in the preset.
 */
export const RENAMED: Record<string, string> = { "mcp.json": ".mcp.json" };

/**
 * A preset's own files, by path in the preset, unfilled. `preset` is its folder, or the
 * `<preset>.json` a packed foreman ships instead (D0032): `bun pm pack` drops some names,
 * `.gitignore` and `bunfig.toml` among them, so the files travel as one JSON object.
 */
export function presetFiles(preset: string): Map<string, string> {
  const out = new Map<string, string>();
  if (preset.endsWith(".json")) {
    const files = (JSON.parse(readFileSync(preset, "utf8")) as { files?: Record<string, string> }).files;
    if (!files?.["package.json"]) throw new Error(`not a preset (no package.json): ${preset}`);
    for (const [path, text] of Object.entries(files)) out.set(path, text);
    return out;
  }
  if (!existsSync(join(preset, "package.json"))) throw new Error(`not a preset (no package.json): ${preset}`);
  const walk = (rel: string) => {
    for (const e of readdirSync(join(preset, rel), { withFileTypes: true })) {
      if (skipped(e.name, e.isDirectory())) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path);
      else out.set(path, readFileSync(join(preset, path), "utf8"));
    }
  };
  walk("");
  return out;
}

/** Every file the preset makes, by path relative to the target, with placeholders filled in. */
export function generate(preset: string, name: string): Map<string, string> {
  if (!NAME.test(name)) throw new Error(`name must be lower-case letters, digits and dashes, starting with a letter: "${name}"`);
  const fill = (s: string) => s.replaceAll("{{name}}", name).replaceAll("{{db}}", name.replace(/\W/g, "_"));
  const out = new Map<string, string>();
  for (const [path, text] of presetFiles(preset)) out.set(fill(RENAMED[path] ?? path), fill(text));
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}
