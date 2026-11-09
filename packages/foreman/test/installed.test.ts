// foreman installed from its own tarball, with no checkout around it (D0026, D0032): pack it,
// install it globally into a temp prefix, and run fm help, init, sync and create from there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CHECKOUT, PACKAGE_ROOT, TEMPLATES } from "../src/kit/paths";

const base = realpathSync(mkdtempSync(join(tmpdir(), "foreman-installed-")));
const prefix = join(base, "prefix");
const installed = join(prefix, "install", "global", "node_modules", "@foreman-kit", "foreman");
const fm = join(prefix, "bin", "fm");
const checkout = CHECKOUT!;
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** The user's bun cache, so the install reuses the dependencies it has instead of fetching them. */
const cache = () => {
  const p = Bun.spawnSync(["bun", "pm", "cache"], { stdout: "pipe", stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
};

/** A plain env: no FOREMAN_* settings, a HOME of its own, and git's identity for create's commit. */
const env = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FOREMAN_") && !k.startsWith("BUN_")) out[k] = v;
  const c = cache();
  return {
    ...out,
    HOME: join(base, "home"),
    XDG_CONFIG_HOME: join(base, "home", ".config"),
    FOREMAN_PROJECTS_FILE: join(base, "projects.json"),
    BUN_INSTALL: prefix,
    ...(c ? { BUN_INSTALL_CACHE_DIR: c } : {}),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
};

function run(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd, env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${p.exitCode}:\n${out}`);
  return out;
}

/** Every file under dir, by path relative to it. */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const path = rel ? `${rel}/${n}` : n;
    return statSync(join(dir, path)).isDirectory() ? (n === ".git" ? [] : walk(dir, path)) : [path];
  });
}

/** Files under dir whose text names the checkout: what a run that read from it would leave behind. */
const naming = (dir: string) => walk(dir).filter((f) => readFileSync(join(dir, f), "latin1").includes(checkout));

beforeAll(() => {
  mkdirSync(join(base, "home"), { recursive: true });
  run(["bun", "pm", "pack", "--destination", base, "--quiet"], PACKAGE_ROOT);
  const tgz = readdirSync(base).find((f) => f.endsWith(".tgz"))!;
  run(["bun", "add", "-g", join(base, tgz)], base);
}, 180_000);

test("the tarball has agent-kit's templates and the presets, and packing leaves no kit/ in the checkout", () => {
  expect(existsSync(fm)).toBe(true);
  expect(existsSync(join(PACKAGE_ROOT, "kit"))).toBe(false);
  expect(walk(join(installed, "kit", "templates")).sort()).toEqual(walk(TEMPLATES).sort());
  expect(readdirSync(join(installed, "kit", "presets"))).toContain("bun-ts-postgres.json");
});

test("the installed copy finds its kit inside itself, not in a checkout", () => {
  expect(relative(checkout, installed).startsWith("..")).toBe(true);
  const where = run(["bun", "-e", `const p = await import(${JSON.stringify(join(installed, "src", "kit", "paths.ts"))}); console.log(JSON.stringify([p.CHECKOUT, p.TEMPLATES, p.PRESETS]))`], base);
  const [found, templates, presets] = JSON.parse(where) as [string | null, string, string];
  expect(found).toBeNull();
  expect(templates).toBe(join(installed, "kit", "templates"));
  expect(presets).toBe(join(installed, "kit", "presets"));
});

test("fm help runs from the installed copy", () => {
  expect(run([fm, "help"], base)).toContain("Usage: fm <command>");
});

test("fm init adds the kit to a git repo, and fm sync finds it up to date", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  run(["git", "init", "-q"], repo);
  const out = run([fm, "init"], repo);
  expect(out).toContain("created  .claude/hooks/guard.ts");
  expect(readFileSync(join(repo, ".claude", "hooks", "guard.ts"), "utf8")).toBe(readFileSync(join(TEMPLATES, "claude", "hooks", "guard.ts"), "utf8"));
  const version = (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string }).version;
  expect(JSON.parse(readFileSync(join(repo, ".meta-repo", "installed.json"), "utf8")).source).toBe(version);
  expect(run([fm, "sync"], repo)).toContain(`kit ${version} -> ${version}`);
  expect(naming(repo)).toEqual([]);
});

test("fm create makes a project from the bundled preset, with foreman vendored from the installed copy", () => {
  const work = join(base, "work");
  mkdirSync(work);
  const out = run([fm, "create", "app", "--no-install"], work);
  const app = join(work, "app");
  // Files bun pm pack would drop by name still arrive: the preset travels as one JSON file.
  for (const f of [".gitignore", "bunfig.toml", ".mcp.json", ".claude/settings.json", "foreman.json", ".github/workflows/ci.yml"]) {
    expect(existsSync(join(app, f)), f).toBe(true);
  }
  const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  expect(deps["@foreman-kit/foreman"]).toMatch(/^file:\.meta-repo\/packages\/foreman-[0-9a-f]+\.tgz$/);
  // The other kit packages can't be packed without the checkout: they're taken by version.
  for (const [name, spec] of Object.entries(deps)) if (name.startsWith("@foreman-kit/") && name !== "@foreman-kit/foreman") expect(spec, name).toMatch(/^\d+\.\d+\.\d+/);
  expect(out).toContain("from the registry");
  expect(naming(app)).toEqual([]);
});
