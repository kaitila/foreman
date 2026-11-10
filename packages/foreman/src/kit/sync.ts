// sync: bring a project's kit files up to the foreman version this runs from (D0018).
// Three-way per file: the hash recorded at install, the file now, and the kit's file now.
// A file the project changed or deleted is never overwritten or restored. Only the files of the
// pieces the project has are touched, the kit's packages are taken by version, and a project made
// before D0026 is moved off its vendored tarballs first (D0026, migrate.ts).
import { mergeSettings, OMIT_FILE, readOmit, TEMPLATES, templateSettings } from "./install";
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkVersion } from "../core";
import {
  type Change,
  type HookGroup,
  filePieces,
  hookKey,
  LEGACY_RECORD,
  LEGACY_VENDOR,
  matcherHash,
  MCP,
  kitFiles,
  raiseKitDeps,
  readInstalled,
  RECORD,
  recordPath,
  SETTINGS,
  sha256,
  source,
  write,
  writeInstalled,
} from "./kit";
import { inferPieces, legacyTarball, migrateMcp, migratePackageJson, raiseForemanRange } from "./migrate";

export interface SyncOptions {
  /** Report what would change, write nothing. */
  dryRun?: boolean;
  /** agent-kit's templates (tests point this elsewhere). */
  templates?: string;
}

export interface SyncResult {
  from: string;
  to: string;
  changes: Change[];
  /** package.json's kit packages changed: run `bun install`. */
  reinstall: boolean;
}

export function sync(dir: string, opts: SyncOptions = {}): SyncResult {
  const target = resolve(dir);
  const templates = opts.templates ?? TEMPLATES;
  // An older fm would write its older kit over a project that needs a newer one (D0026).
  checkVersion(target);
  const rec = readInstalled(target);
  if (!rec) throw new Error(`no ${recordPath(target)} here: set up foreman with init (or create) first`);
  const to = source();
  const changes: Change[] = [];
  const put = (path: string, data: Uint8Array | string) => opts.dryRun || write(target, path, data);
  const hashOf = (path: string) => (existsSync(join(target, path)) ? sha256(readFileSync(join(target, path))) : null);
  const readText = (path: string) => (existsSync(join(target, path)) ? readFileSync(join(target, path), "utf8") : null);

  // A project made before D0026: its record moves to .foreman-kit/, with the pieces its files show.
  const legacy = recordPath(target) === LEGACY_RECORD;
  if (legacy) {
    rec.pieces = inferPieces(rec);
    changes.push({ action: "moved", path: RECORD, note: `from ${LEGACY_RECORD}, pieces: ${rec.pieces.join(", ") || "none"}` });
  }
  const pieces = filePieces(rec);
  const files = { ...rec.files };
  const hooks = { ...rec.hooks };

  // The tarballs it vendored are deleted: package.json takes the packages by version now.
  for (const path of Object.keys(files).filter((p) => legacyTarball(p))) {
    delete files[path];
    if (!existsSync(join(target, path))) continue;
    if (!opts.dryRun) unlinkSync(join(target, path));
    changes.push({ action: "deleted", path, note: "vendored tarball, no longer used" });
  }

  // settings.json is merged, as init does: the baseline's new rules are added, the project's kept.
  const omit = readOmit(target);
  if (!pieces.includes("guardrails")) {
    // No guardrails piece: the project has no kit settings or hooks to keep up to date.
  } else if (!existsSync(join(target, SETTINGS))) changes.push({ action: "deleted", path: SETTINGS, note: "not there; not restored (agent-kit init adds it)" });
  else {
    const project = JSON.parse(readFileSync(join(target, SETTINGS), "utf8"));
    const baseline = JSON.parse(readFileSync(templateSettings(templates), "utf8"));
    // A kit hook group the project runs (same command) gets the kit's matcher, unless the project changed it.
    let rematched = 0;
    for (const [event, groups] of Object.entries((baseline.hooks ?? {}) as Record<string, HookGroup[]>)) {
      for (const g of groups) {
        const mine = ((project.hooks?.[event] ?? []) as HookGroup[]).find((m) => m.hooks.some((h) => h.command === g.hooks[0]?.command));
        if (!mine) continue;
        const key = hookKey(event, g);
        if (matcherHash(mine) === matcherHash(g)) hooks[key] = matcherHash(g);
        else if (hooks[key] === undefined || hooks[key] === matcherHash(mine)) {
          const was = mine.matcher;
          if (g.matcher === undefined) delete mine.matcher;
          else mine.matcher = g.matcher;
          hooks[key] = matcherHash(g);
          rematched++;
          changes.push({ action: "updated", path: `${SETTINGS} ${event} matcher`, note: `${was ?? "(none)"} -> ${g.matcher ?? "(none)"}${rec.hooks?.[key] === undefined ? " (not recorded at install: assumed unchanged)" : ""}` });
        } else changes.push({ action: "kept", path: `${SETTINGS} ${event} matcher`, note: `changed here (${mine.matcher ?? "(none)"}); the kit's is ${g.matcher ?? "(none)"}` });
      }
    }
    const { settings, added, omitted } = mergeSettings(project, baseline, omit);
    if (added || rematched) {
      put(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
      if (added) changes.push({ action: "merged", path: SETTINGS, note: `${added} baseline rule${added === 1 ? "" : "s"} or hook${added === 1 ? "" : "s"} added` });
    }
    for (const rule of omitted) changes.push({ action: "skipped", path: rule, note: `listed in ${OMIT_FILE}` });
  }

  const kit = kitFiles(templates, pieces);
  for (const [path, data] of kit) {
    const base = files[path];
    const cur = hashOf(path);
    const next = sha256(data);
    if (cur === next) files[path] = next;
    else if (cur === null) {
      if (base) changes.push({ action: "deleted", path, note: `deleted here; not restored (delete its entry in ${recordPath(target)} to get it back)` });
      else {
        put(path, data);
        files[path] = next;
        changes.push({ action: "created", path, note: "new in the kit" });
      }
    } else if (base === cur) {
      put(path, data);
      files[path] = next;
      changes.push({ action: "updated", path });
    } else if (base) {
      if (base !== next) changes.push({ action: "kept", path, note: `changed here and in the kit; compare with ${join(templates, path)}` });
    } else changes.push({ action: "kept", path, note: `not installed by the kit; compare with ${join(templates, path)}` });
  }

  // package.json: tarballs become versions, a vendored foreman goes, and the kit's packages are raised to this version.
  let reinstall = false;
  const pkgBefore = readText("package.json");
  if (pkgBefore !== null) {
    const migrated = migratePackageJson(pkgBefore, to);
    const { text, raised } = raiseKitDeps(migrated.text, to);
    if (text !== pkgBefore) {
      put("package.json", text);
      reinstall = true;
      changes.push({ action: "updated", path: "package.json", note: [...migrated.notes, ...raised].join("; ") });
    }
  }
  // .mcp.json: the foreman server D0020 wrote (the vendored package's file) becomes the person's fm.
  const mcpBefore = readText(MCP);
  const mcp = mcpBefore === null ? null : migrateMcp(mcpBefore);
  if (mcp !== null) {
    put(MCP, mcp);
    changes.push({ action: "updated", path: MCP, note: "foreman server: bun node_modules/.../foreman/src/cli.ts mcp -> fm mcp" });
  }
  // foreman.json: the lowest foreman the project needs is the one that synced it (D0026).
  const fjBefore = readText("foreman.json");
  const fj = fjBefore === null ? null : raiseForemanRange(fjBefore, to);
  if (fj !== null) {
    put("foreman.json", fj.text);
    changes.push({ action: "updated", path: "foreman.json", note: `foreman ${fj.from ?? "(no range)"} -> >=${to}` });
  }

  // Files the kit no longer ships stay: the project may use them. Only the record forgets them.
  for (const path of Object.keys(files)) {
    if (!kit.has(path)) {
      delete files[path];
      changes.push({ action: "removed", path, note: "no longer in the kit; left in place (delete it if unused)" });
    }
  }

  if (!opts.dryRun) {
    writeInstalled(target, { ...rec, source: to, files, hooks }, RECORD);
    if (legacy) unlinkSync(join(target, LEGACY_RECORD));
  }
  if (legacy || Object.keys(rec.files).some((p) => legacyTarball(p))) removeIfEmpty(target, [LEGACY_VENDOR, ".meta-repo"], changes, opts.dryRun);
  return { from: rec.source, to, changes, reinstall };
}

/**
 * Remove each folder (innermost first) that has nothing left in it. On a dry run, a folder counts as
 * empty when all that's in it is what the run would have deleted: the legacy record and the recorded tarballs.
 */
function removeIfEmpty(target: string, dirs: string[], changes: Change[], dryRun = false) {
  const gone = new Set(changes.filter((c) => c.action === "deleted" || c.action === "moved").map((c) => (c.action === "moved" ? LEGACY_RECORD : c.path)));
  for (const dir of dirs) {
    const abs = join(target, dir);
    if (!existsSync(abs)) continue;
    const left = readdirSync(abs).filter((f) => !gone.has(join(dir, f)));
    if (left.length) {
      changes.push({ action: "kept", path: `${dir}/`, note: `not empty: ${left.join(", ")}` });
      return;
    }
    if (!dryRun) rmdirSync(abs);
    gone.add(dir);
    changes.push({ action: "deleted", path: `${dir}/`, note: "empty" });
  }
}
