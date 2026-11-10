// The guard asks the repo's own packages/foreman before any foreman on the PATH.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "guard-lookup-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const hook = join(import.meta.dir, "..", "templates/claude/hooks/guard.ts");

const project = join(tmp, "project");
mkdirSync(join(project, "packages/foreman/src"), { recursive: true });
Bun.spawnSync(["git", "init", "-q", project]);
// The repo's foreman: the task may edit only src/**.
writeFileSync(
  join(project, "packages/foreman/src/cli.ts"),
  `console.log(JSON.stringify(process.argv[2] === "list" ? [{ paths: ["src/**"] }] : { rules: [] }));`,
);
// A different foreman on the PATH: it would allow only other/**.
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "foreman"), `#!/bin/sh\n[ "$1" = policy ] && echo '{"rules":[]}' || echo '[{"paths":["other/**"]}]'\n`);
chmodSync(join(bin, "foreman"), 0o755);

const edit = (file: string, over: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CLAUDE_PROJECT_DIR: project,
    FOREMAN_ACTOR: "worker-T-1",
    ...over,
  };
  delete env.FOREMAN_BIN;
  if (over.FOREMAN_BIN) env.FOREMAN_BIN = over.FOREMAN_BIN;
  const p = Bun.spawnSync(["bun", hook], {
    cwd: project,
    env,
    stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(project, file) }, cwd: project })),
    stderr: "pipe",
  });
  return p.exitCode;
};

test("the repo's packages/foreman wins over a foreman on the PATH", () => {
  expect(edit("src/a.ts")).toBe(0); // allowed by the repo's foreman, refused by the PATH one
  expect(edit("other/a.ts")).toBe(2); // the reverse
});

test("FOREMAN_BIN still comes first", () => {
  const fake = join(tmp, "fm.sh");
  writeFileSync(fake, `#!/bin/sh\n[ "$1" = policy ] && echo '{"rules":[]}' || echo '[{"paths":["bin/**"]}]'\n`);
  chmodSync(fake, 0o755);
  expect(edit("bin/a.ts", { FOREMAN_BIN: fake })).toBe(0);
  expect(edit("src/a.ts", { FOREMAN_BIN: fake })).toBe(2);
});

// trustedOnPath: a foreman on the PATH is used only if it is foreman's own CLI (D0035).
describe("trustedOnPath", () => {
  const scope = join(import.meta.dir, "..", "templates/claude/hooks/scope.ts");
  let n = 0;
  /** A PATH dir (at `rel` under a fresh folder) holding `foreman`: a link to `target`, or a script when target is null. */
  const pathDir = (rel: string, target: string | null) => {
    const dir = join(tmp, `path-${++n}`, rel);
    mkdirSync(dir, { recursive: true });
    if (target) symlinkSync(target, join(dir, "foreman"));
    else writeFileSync(join(dir, "foreman"), "#!/bin/sh\necho not foreman\n");
    if (!target) chmodSync(join(dir, "foreman"), 0o755);
    return dir;
  };
  /** A cli.ts at `rel` under a fresh folder, executable so Bun.which finds a link to it. */
  const cli = (rel: string) => {
    const file = join(tmp, `cli-${++n}`, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "#!/usr/bin/env bun\n");
    chmodSync(file, 0o755);
    return file;
  };
  /** trustedOnPath("foreman") in a bun run with PATH set to `dir` alone (Bun.which reads the PATH a process starts with). */
  const withPath = (dir: string): string | null => {
    const p = Bun.spawnSync([process.execPath, "-e", `const { trustedOnPath } = await import(${JSON.stringify(scope)}); console.log(JSON.stringify(trustedOnPath("foreman")))`], {
      env: { HOME: process.env.HOME ?? tmp, PATH: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return JSON.parse(p.stdout.toString());
  };

  test("a link to a checkout's packages/foreman/src/cli.ts is trusted", () => {
    const dir = pathDir("bin", cli("checkout/packages/foreman/src/cli.ts"));
    expect(withPath(dir)).toBe(join(dir, "foreman"));
  });

  test("a link to an installed package's cli.ts is trusted, under either scope", () => {
    for (const rel of ["node_modules/@foreman-kit/foreman/src/cli.ts", "node_modules/@meta-repo/foreman/src/cli.ts"]) {
      const dir = pathDir("bin", cli(`global/${rel}`));
      expect(withPath(dir), rel).toBe(join(dir, "foreman"));
    }
  });

  test("a foreman in a node_modules/.bin folder is refused, even when it links to foreman's cli.ts", () => {
    const real = cli("checkout/packages/foreman/src/cli.ts");
    expect(withPath(pathDir("app/node_modules/.bin", real))).toBeNull();
    expect(withPath(pathDir("app/node_modules/.bin", cli("app/node_modules/@foreman-kit/foreman/src/cli.ts")))).toBeNull();
  });

  test("a foreman that is some other script, or links to some other cli.ts, is refused", () => {
    expect(withPath(pathDir("bin", null))).toBeNull();
    expect(withPath(pathDir("bin", cli("evil/src/cli.ts")))).toBeNull();
    expect(withPath(pathDir("bin", cli("evil/packages/foreman/src/cli.ts.bak")))).toBeNull();
  });

  test("no foreman on the PATH gives null, and so does a dangling link", () => {
    const empty = join(tmp, `path-${++n}`);
    mkdirSync(empty);
    expect(withPath(empty)).toBeNull();
    expect(withPath(pathDir("bin", join(tmp, "gone/packages/foreman/src/cli.ts")))).toBeNull();
  });
});
