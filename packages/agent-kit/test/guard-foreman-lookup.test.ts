// The guard asks the repo's own packages/foreman before any foreman on the PATH.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
