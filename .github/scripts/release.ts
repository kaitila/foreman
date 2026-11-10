// Release helpers (D0026, D0036): every package under packages/ shares one version, and the published ones are
// packed and checked before npm sees them.
//   bun .github/scripts/release.ts version <x.y.z>   set every package's version
//   bun .github/scripts/release.ts tag <tag>         exit 1 unless the tag is v<the packages' version>
//   bun .github/scripts/release.ts pack --dry-run    dry-run pack each published package and check what it would ship
//   bun .github/scripts/release.ts pack <dir>        pack each published package into <dir> and check each tarball
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");

/** The packages that go to npm, in publish order (foreman last: it's the one people install). */
export const PUBLISHED = ["docs-check", "test-kit", "design-kit", "foreman"] as const;

export type Pkg = { dir: string; name: string; version: string; private: boolean };

/** Every package under `<root>/packages`. */
export function packages(root = ROOT): Pkg[] {
  const base = join(root, "packages");
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, "package.json")))
    .map((e) => {
      const j = JSON.parse(readFileSync(join(base, e.name, "package.json"), "utf8"));
      return { dir: e.name, name: j.name, version: j.version, private: j.private === true };
    })
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The one version all packages share; throws, naming each, when they differ. */
export function sharedVersion(root = ROOT): string {
  const all = packages(root);
  const versions = new Set(all.map((p) => p.version));
  if (versions.size !== 1) {
    throw new Error(`packages must share one version:\n${all.map((p) => `  ${p.name}: ${p.version}`).join("\n")}`);
  }
  return [...versions][0]!;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Set every package's version, as a text edit so the files keep their layout. Returns the files changed. */
export function setVersion(version: string, root = ROOT): string[] {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version} (want x.y.z)`);
  const changed: string[] = [];
  for (const p of packages(root)) {
    const file = join(root, "packages", p.dir, "package.json");
    const text = readFileSync(file, "utf8");
    const next = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
    if (next === text) continue;
    writeFileSync(file, next);
    changed.push(file);
  }
  return changed;
}

/** Why a release tag doesn't match the packages, or null when it does. */
export function tagProblem(tag: string, root = ROOT): string | null {
  const version = sharedVersion(root);
  return tag === `v${version}` ? null : `tag ${tag} doesn't match the packages' version ${version} (want v${version})`;
}

/** Files a published package must not ship: tests, fixtures, foreman's state. */
export function forbidden(files: string[]): string[] {
  return files.filter((f) =>
    /(^|\/)(test|tests|__tests__|fixtures?)\//.test(f) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) ||
    /(^|\/)\.foreman(\/|$)/.test(f) ||
    /(^|\/)node_modules\//.test(f),
  );
}

/** What a package's pack holds, checked: package.json and README.md present, nothing forbidden. */
export function contentProblems(files: string[]): string[] {
  const problems = forbidden(files).map((f) => `ships ${f}`);
  for (const must of ["package.json", "README.md"]) if (!files.includes(must)) problems.push(`missing ${must}`);
  return problems;
}

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const out = r.stdout.toString() + r.stderr.toString();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${out}`);
  return out;
}

/** The files `bun pm pack --dry-run` lists for a package. */
export function dryRunFiles(dir: string, root = ROOT): string[] {
  const out = run(["bun", "pm", "pack", "--dry-run"], join(root, "packages", dir));
  return [...out.matchAll(/^packed \S+ (.+)$/gm)].map((m) => m[1]!.trim());
}

/** Pack a package into `dest`; returns the tarball's path and the files in it. */
export function packTo(dir: string, dest: string, root = ROOT): { tarball: string; files: string[] } {
  mkdirSync(dest, { recursive: true });
  const before = new Set(readdirSync(dest));
  run(["bun", "pm", "pack", "--destination", dest], join(root, "packages", dir));
  const made = readdirSync(dest).filter((f) => f.endsWith(".tgz") && !before.has(f));
  if (made.length !== 1) throw new Error(`expected one new tarball for ${dir} in ${dest}, found ${made.length}`);
  const tarball = join(dest, made[0]!);
  const files = run(["tar", "-tzf", tarball], dest)
    .split("\n")
    .filter((l) => l && !l.endsWith("/"))
    .map((l) => l.replace(/^package\//, ""));
  return { tarball, files };
}

function main(argv: string[]): number {
  const [cmd, arg] = argv;
  if (cmd === "version" && arg) {
    const changed = setVersion(arg);
    console.log(`version ${arg}: ${changed.length} package.json file(s) changed. Then: bun install, commit, tag v${arg}.`);
    return 0;
  }
  if (cmd === "tag" && arg) {
    const problem = tagProblem(arg);
    if (problem) { console.error(problem); return 1; }
    console.log(`${arg} matches the packages' version`);
    return 0;
  }
  if (cmd === "pack" && arg) {
    const version = sharedVersion();
    let failed = false;
    for (const dir of PUBLISHED) {
      const { files, tarball } = arg === "--dry-run" ? { files: dryRunFiles(dir), tarball: "(dry run)" } : packTo(dir, resolve(arg));
      const problems = contentProblems(files);
      if (problems.length) {
        failed = true;
        console.error(`${dir}@${version}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
      } else console.log(`${dir}@${version}: ${files.length} files, ok ${tarball}`);
    }
    return failed ? 1 : 0;
  }
  console.error("usage: bun .github/scripts/release.ts version <x.y.z> | tag <tag> | pack --dry-run | pack <dir>");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
