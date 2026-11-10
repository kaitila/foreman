// For this repo's CI only, until the kit's packages are on the registry: a project made by `fm create`
// takes @foreman-kit/* by version (D0026), which bun can't install before the first publish. This packs
// each kit package the project depends on from this checkout, and adds an `overrides` entry pointing at
// the tarball, so `bun install` takes it from there. Nothing else in the project changes.
//
//   bun packages/foreman/scripts/local-kit.ts <project> <folder for the tarballs>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addEntry } from "../src/kit/create";
import { SCOPE } from "../src/kit/install";
import { KIT_PACKAGES } from "../src/kit/kit";
import { CHECKOUT } from "../src/kit/paths";

const [project, out] = process.argv.slice(2).map((a) => resolve(a));
if (!project || !out) throw new Error("usage: local-kit.ts <project> <folder for the tarballs>");
if (!CHECKOUT) throw new Error("local-kit.ts runs from a foreman checkout: it packs the kit packages from there");

const file = join(project, "package.json");
let text = readFileSync(file, "utf8");
const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
mkdirSync(out, { recursive: true });
for (const name of KIT_PACKAGES) {
  if (deps[`${SCOPE}/${name}`] === undefined) continue;
  const dest = join(out, name);
  mkdirSync(dest, { recursive: true });
  const p = Bun.spawnSync(["bun", "pm", "pack", "--destination", dest, "--quiet"], { cwd: join(CHECKOUT, "packages", name), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`bun pm pack failed for ${name}: ${p.stderr.toString()}`);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`bun pm pack wrote no tarball for ${name}`);
  text = addEntry(text, "overrides", `${SCOPE}/${name}`, `file:${join(dest, tgz)}`);
  console.log(`override ${SCOPE}/${name} -> ${join(dest, tgz)}`);
}
writeFileSync(file, text);
