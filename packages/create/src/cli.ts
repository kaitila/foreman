#!/usr/bin/env bun
// meta-repo create | init | sync: start a project, add the kit to a repo, take the kit's updates.
import { parseArgs } from "node:util";
import { runKitCommand, USAGE } from "./commands";
import { presets } from "./create";

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      name: { type: "string" },
      "no-install": { type: "boolean" },
      "no-git": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, dir, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(`Usage:\n${USAGE}\nPresets: ${presets().join(", ")}`);
    process.exit(values.help ? 0 : 2);
  }
  if (rest.length) throw new Error(`unexpected argument: ${rest[0]}`);
  runKitCommand(cmd, dir, {
    preset: values.preset,
    name: values.name,
    noInstall: values["no-install"],
    noGit: values["no-git"],
    dryRun: values["dry-run"],
  });
} catch (e) {
  console.error(`meta-repo: ${(e as Error).message}`);
  process.exit(1);
}
