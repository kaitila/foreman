// The npm scope foreman's packages are published under. Change it here only:
// the hooks use it, and the kit's create, init and sync take it from here too.
export const SCOPE = "@foreman-kit";

/**
 * Where a project's installed foreman CLI is, in the order the hooks look. The second is
 * foreman's old package name, so a project that hasn't moved its dependency yet keeps working.
 */
export const FOREMAN_INSTALLS = [`node_modules/${SCOPE}/foreman/src/cli.ts`, "node_modules/@meta-repo/foreman/src/cli.ts"];
