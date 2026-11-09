import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstCellKeys } from "@foreman-kit/docs-check";
import { EnvSchema, env, requireEnv, resetEnv } from "../src/config";
import { cliMessage } from "../src/cli";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnv();
});

test("empty values count as unset, so defaults apply", () => {
  process.env.PORT = "";
  process.env.APP_VERSION = "";
  resetEnv();
  expect(env().PORT).toBe(3000);
  expect(env().APP_VERSION).toBe("dev");
});

test("a bad value names the field, never the value", () => {
  process.env.DATABASE_URL = "mysql://user:s3cret-value@db/x";
  process.env.PORT = "not-a-port";
  resetEnv();
  let msg = "";
  try {
    env();
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("DATABASE_URL");
  expect(msg).toContain("PORT");
  expect(msg).not.toContain("s3cret");
  expect(msg).not.toContain("not-a-port");
});

test("requireEnv lists the missing keys", () => {
  delete process.env.DATABASE_URL;
  resetEnv();
  expect(() => requireEnv("DATABASE_URL")).toThrow("missing configuration: DATABASE_URL");
});

test("the CLI shows its own errors and hides a driver's text", () => {
  expect(cliMessage(new Error("unknown command \"x\""))).toBe('unknown command "x"');
  const driver = Object.assign(new Error("connect to postgres://u:s3cret@h failed"), { code: "ECONNREFUSED" });
  expect(cliMessage(driver)).toBe("failed (Error ECONNREFUSED)");
});

test("docs/configuration.md lists exactly the schema's keys (what docs-check's regex should find)", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "configuration.md"), "utf8");
  const documented = firstCellKeys(doc).map((k) => k.key).filter((k) => k !== "TEST_DATABASE_URL");
  expect(documented.sort()).toEqual(Object.keys(EnvSchema.shape).sort());
});
