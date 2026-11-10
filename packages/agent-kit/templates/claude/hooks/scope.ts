import { realpathSync } from "node:fs";
import { dirname } from "node:path";

// The npm scope foreman's packages are published under. Change it here only:
// the hooks use it, and the kit's create, init and sync take it from here too.
export const SCOPE = "@foreman-kit";

/**
 * Where a project's installed foreman CLI is, in the order the hooks look. The second is
 * foreman's old package name, so a project that hasn't moved its dependency yet keeps working.
 */
export const FOREMAN_INSTALLS = [`node_modules/${SCOPE}/foreman/src/cli.ts`, "node_modules/@meta-repo/foreman/src/cli.ts"];

/**
 * `name` on the PATH, only if it is foreman: not a link in a node_modules/.bin folder (a session
 * started from a package script has one first, and any dependency can put a bin there), and its real
 * file is foreman's own CLI, a checkout's packages/foreman or an installed package (D0035).
 */
export function trustedOnPath(name: string): string | null {
  const hit = Bun.which(name);
  if (!hit || /[\\/]node_modules[\\/]\.bin$/.test(dirname(hit))) return null;
  let real: string;
  try {
    real = realpathSync(hit).replaceAll("\\", "/");
  } catch {
    return null;
  }
  const own = real.endsWith("/packages/foreman/src/cli.ts") || FOREMAN_INSTALLS.some((rel) => real.endsWith(`/${rel}`));
  return own ? hit : null;
}
