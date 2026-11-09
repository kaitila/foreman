#!/usr/bin/env bun
// Make an app from a preset: copy its files, filling in the placeholders.
//   bun presets/generate.ts <preset> <target-dir> [--name my-app] [--force]
// Placeholders: {{name}} (the app's name, e.g. my-app) and {{db}} (the same, safe as a
// database name: my_app). examples/demo-app is this script's output for bun-ts-postgres;
// a test keeps the two equal. Files Claude Code protects are kept under a name without the
// dot and renamed on output (RENAMED, D0030).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Files that are never part of an app made from a preset. */
const skipped = (name: string, isDir: boolean) => (isDir ? name === "node_modules" || name === ".git" : /^\.env($|\.(?!example$))/.test(name));

/**
 * Preset files kept under a source name without the dot, because Claude Code refuses an
 * unattended session's edits to the dotted name (D0023). Keyed by path in the preset.
 */
export const RENAMED: Record<string, string> = { "mcp.json": ".mcp.json" };

/** Every file the preset makes, by path relative to the target, with placeholders filled in. */
export function generate(presetDir: string, name: string): Map<string, string> {
  if (!NAME.test(name)) throw new Error(`name must be lower-case letters, digits and dashes, starting with a letter: "${name}"`);
  if (!existsSync(join(presetDir, "package.json"))) throw new Error(`not a preset (no package.json): ${presetDir}`);
  const fill = (s: string) => s.replaceAll("{{name}}", name).replaceAll("{{db}}", name.replace(/\W/g, "_"));
  const out = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(presetDir, rel), { withFileTypes: true })) {
      if (skipped(e.name, e.isDirectory())) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path);
      else out.set(fill(RENAMED[path] ?? path), fill(readFileSync(join(presetDir, path), "utf8")));
    }
  };
  walk("");
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { name: { type: "string" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help || positionals.length !== 2) {
      console.log("usage: bun presets/generate.ts <preset> <target-dir> [--name my-app] [--force]");
      process.exit(values.help ? 0 : 2);
    }
    const [preset, target] = positionals as [string, string];
    const presetDir = existsSync(preset) ? resolve(preset) : join(import.meta.dir, preset);
    const dir = resolve(target);
    const files = generate(presetDir, values.name ?? basename(dir));
    if (existsSync(dir) && readdirSync(dir).length && !values.force) throw new Error(`${target} is not empty (--force overwrites the preset's files in it)`);
    for (const [path, text] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    console.log(`wrote ${files.size} files to ${target}`);
  } catch (e) {
    console.error(`generate: ${(e as Error).message}`);
    process.exit(1);
  }
}
