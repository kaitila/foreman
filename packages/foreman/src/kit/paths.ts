// Where the kit's files are, found from this package's own folder (D0032).
// In the foreman checkout, agent-kit's templates and the presets are read where they're
// edited. In an installed package they're in kit/, which the prepack script copies in.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** This package's folder: packages/foreman in the checkout, or where it's installed. */
export const PACKAGE_ROOT = resolve(import.meta.dir, "..", "..");

const own = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { name: string; version: string };
/** The kit version: this package's version. */
export const VERSION = own.version;
/** The npm scope of foreman's packages, from this package's name. The hooks keep their own copy in scope.ts; a test keeps them equal. */
export const SCOPE = own.name.slice(0, own.name.indexOf("/"));

/** The foreman checkout this package sits in, or null when it's installed from a tarball. */
export const CHECKOUT: string | null = (() => {
  const root = resolve(PACKAGE_ROOT, "..", "..");
  return existsSync(join(root, "packages", "agent-kit", "templates")) && existsSync(join(root, "presets")) ? root : null;
})();

/** What the prepack script copies into the package: agent-kit's templates and the presets. */
export const BUNDLE = join(PACKAGE_ROOT, "kit");
/** agent-kit's templates: the files a project gets under .claude/. */
export const TEMPLATES = CHECKOUT ? join(CHECKOUT, "packages", "agent-kit", "templates") : join(BUNDLE, "templates");
/** The presets create makes projects from. */
export const PRESETS = CHECKOUT ? join(CHECKOUT, "presets") : join(BUNDLE, "presets");
/** create's and init's own templates (AGENTS.md, foreman.json, CI). */
export const OWN_TEMPLATES = join(PACKAGE_ROOT, "templates");

