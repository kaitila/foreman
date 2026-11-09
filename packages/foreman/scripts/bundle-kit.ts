// prepack / postpack: copy agent-kit's templates and the presets (as kit/presets/<name>.json) into kit/, so a packed
// foreman has everything create, init and sync need (D0032). `--clean` removes kit/ again.
// In an installed copy there's no checkout to copy from, and kit/ is already there: both do nothing.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { presetFiles } from "../src/kit/generate";
import { BUNDLE, CHECKOUT, PRESETS, TEMPLATES } from "../src/kit/paths";

if (CHECKOUT) {
  rmSync(BUNDLE, { recursive: true, force: true });
  if (!process.argv.includes("--clean")) {
    cpSync(TEMPLATES, join(BUNDLE, "templates"), { recursive: true });
    for (const e of readdirSync(PRESETS, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(PRESETS, e.name, "package.json"))) continue;
      // One JSON file per preset: bun pm pack drops some names (.gitignore, bunfig.toml).
      mkdirSync(join(BUNDLE, "presets"), { recursive: true });
      writeFileSync(join(BUNDLE, "presets", `${e.name}.json`), JSON.stringify({ files: Object.fromEntries(presetFiles(join(PRESETS, e.name))) }) + "\n");
    }
  }
}
