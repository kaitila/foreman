// Preloaded before every test file (bunfig.toml).
import { setDefaultTimeout } from "bun:test";
import { COMMON_CREDENTIALS, slot, stripCredentials } from "@foreman-kit/test-kit";

// Bun 1.3.5 ignores bunfig's test timeout; database tests need more than the 5 s default.
setDefaultTimeout(15_000);

// No test can reach a real service with a real key.
stripCredentials(COMMON_CREDENTIALS);

// Each git worktree gets its own database (`{{db}}_test_<worktree>`), so parallel
// agents never share one. The app reads DATABASE_URL, so point it there too.
// The slot is named after the checkout's root, which may be above this app's folder.
const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
const root = top.exitCode === 0 ? top.stdout.toString().trim() : process.cwd();
const base = process.env.TEST_DATABASE_URL ?? `postgres://postgres:postgres@127.0.0.1:5432/{{db}}_test`;
process.env.TEST_DATABASE_URL = slot({ root }).dbUrl(base);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.APP_VERSION = "test";
