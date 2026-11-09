#!/usr/bin/env bun
// Make an app from a preset: copy its files, filling in the placeholders.
//   bun presets/generate.ts <preset> <target-dir> [--name my-app] [--force]
// Placeholders: {{name}} (the app's name, e.g. my-app) and {{db}} (the same, safe as a
// database name: my_app). examples/demo-app is this script's output for bun-ts-postgres;
// a test keeps the two equal. Files Claude Code protects are kept under a name without the
// dot and renamed on output (RENAMED, D0030).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generate } from "../packages/foreman/src/kit/generate";

export { generate, NAME, RENAMED } from "../packages/foreman/src/kit/generate";

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
