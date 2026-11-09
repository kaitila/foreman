import { createTestDb, type TestDb } from "@foreman-kit/test-kit";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";
import { handle } from "../src/server";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;

/** Is the test Postgres up? Locally a missing one skips the database tests; on CI it fails them. */
export const dbReachable = await (async () => {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
})();
if (!dbReachable) {
  if (process.env.CI) throw new Error(`CI must provide Postgres at ${new URL(TEST_DATABASE_URL).host} (TEST_DATABASE_URL)`);
  console.warn(`no Postgres at ${new URL(TEST_DATABASE_URL).host}; database tests skipped (set TEST_DATABASE_URL)`);
}

let db: TestDb | undefined;

/** The test database, created and migrated on first use. `fresh()` empties it. */
export function testDb(): TestDb {
  return (db ??= createTestDb({
    url: TEST_DATABASE_URL,
    migrate: runMigrations,
  }));
}

/** Call the app as a browser on APP_URL would; POSTs carry the CSRF header unless told otherwise. */
export function call(method: string, path: string, opts: { json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(method === "GET" ? {} : { "x-app": "1" }), ...opts.headers };
  if (opts.json !== undefined) headers["content-type"] = "application/json";
  return handle(new Request(`http://localhost:3000${path}`, { method, headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) }));
}
