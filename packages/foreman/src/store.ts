// Where foreman keeps its state, and the SQLite schema (D0001, D0002).
// One database per repository, in the main checkout's .foreman/, so every
// worktree and every agent sees the same tasks and claims.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const SCHEMA_VERSION = 1;

/** The main checkout's root, found from any worktree via the shared git dir. */
export function repoRoot(cwd = process.cwd()): string {
  const run = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`not inside a git repository: ${cwd}`);
    return p.stdout.toString().trim();
  };
  const common = run(["rev-parse", "--git-common-dir"]);
  const abs = isAbsolute(common) ? common : resolve(cwd, common);
  // A normal checkout's common dir is <root>/.git; a bare repo has no checkout.
  if (abs.endsWith("/.git") || abs.endsWith("\\.git")) return dirname(abs);
  return run(["rev-parse", "--show-toplevel"]);
}

/** FOREMAN_DB wins; otherwise <main checkout>/.foreman/foreman.db. */
export function dbPath(cwd = process.cwd()): string {
  if (process.env.FOREMAN_DB) return process.env.FOREMAN_DB;
  return join(repoRoot(cwd), ".foreman", "foreman.db");
}

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.query(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | null;
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `foreman database is schema v${current}, this foreman knows v${SCHEMA_VERSION}: upgrade foreman`,
    );
  }
  if (current === SCHEMA_VERSION) return additive(db);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,           -- T-0001
        num         INTEGER NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        spec        TEXT NOT NULL DEFAULT '',   -- markdown: what and why
        acceptance  TEXT NOT NULL DEFAULT '[]', -- JSON [{id, kind: cmd|statement, text}]
        paths       TEXT NOT NULL DEFAULT '[]', -- JSON globs the task may touch
        risk        TEXT NOT NULL CHECK (risk IN ('auto','review','human')),
        status      TEXT NOT NULL,
        parent      TEXT REFERENCES tasks(id),
        blocked_by  TEXT NOT NULL DEFAULT '[]', -- JSON task ids
        discovered_from TEXT REFERENCES tasks(id),
        assignee    TEXT,
        lease_until INTEGER,                    -- ms epoch; claim expires after this
        branch      TEXT,
        worktree    TEXT,
        pr          TEXT,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX tasks_status ON tasks(status);
      CREATE TABLE events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT REFERENCES tasks(id),
        at         INTEGER NOT NULL,
        actor      TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
        type       TEXT NOT NULL,
        data       TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX events_task ON events(task_id, id);
      -- Numbers handed out so parallel PRs never pick the same one (decisions, migrations).
      CREATE TABLE reservations (
        kind    TEXT NOT NULL,
        value   INTEGER NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        actor   TEXT NOT NULL,
        at      INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      );
      -- Events are history: never rewritten.
      CREATE TRIGGER events_append_only_u BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_append_only_d BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `);
    db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  })();
  additive(db);
}

/**
 * Tables an older foreman can ignore, so they don't bump the schema version: every
 * worktree shares one database, and a newer foreman in one of them must not lock
 * out the older ones still running elsewhere.
 */
function additive(db: Database) {
  // A lease pinned to a process (D0011): while the PID lives, the claim doesn't time out;
  // once it's gone, the claim is released. Only valid while the task's assignee is still `assignee`.
  db.exec(`CREATE TABLE IF NOT EXISTS lease_pids (
    task_id  TEXT PRIMARY KEY REFERENCES tasks(id),
    assignee TEXT NOT NULL,
    pid      INTEGER NOT NULL
  )`);
  // Plans (D0033): ordered steps with a check each, and which step each task is in.
  // Progress isn't stored: plans.ts works it out from the tasks' statuses.
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    id            TEXT PRIMARY KEY,           -- P-0001
    num           INTEGER NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    goal          TEXT NOT NULL DEFAULT '',   -- markdown
    status        TEXT NOT NULL CHECK (status IN ('active','cancelled')),
    cancel_reason TEXT,
    created_by    TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plan_steps (
    plan_id    TEXT NOT NULL REFERENCES plans(id),
    n          INTEGER NOT NULL,              -- 1, 2, ... in order
    title      TEXT NOT NULL,
    check_text TEXT NOT NULL,
    PRIMARY KEY (plan_id, n)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plan_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id), -- a task is in at most one plan
    plan_id TEXT NOT NULL REFERENCES plans(id),
    step    INTEGER NOT NULL,
    FOREIGN KEY (plan_id, step) REFERENCES plan_steps(plan_id, n)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS plan_tasks_plan ON plan_tasks(plan_id, step)`);
}
