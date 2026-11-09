// sync: bring a project's kit files up to the foreman version this runs from (D0018).
// Three-way per file: the hash recorded at install, the file now, and the kit's file now.
// A file the project changed or deleted is never overwritten or restored. Only the files of the
// pieces the project has are touched (D0026).
import { mergeSettings, OMIT_FILE, readOmit, SCOPE, TEMPLATES, templateSettings } from "./install";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkVersion } from "../core";
import {
  type Change,
  type HookGroup,
  filePieces,
  hookKey,
  matcherHash,
  kitFiles,
  pack,
  pointDep,
  readInstalled,
  recordPath,
  SETTINGS,
  sha256,
  source,
  vendoredName,
  VENDOR,
  write,
  writeInstalled,
} from "./kit";

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
  /** Vendored packages changed: run `bun install`. */
  reinstall: boolean;
}

export function sync(dir: string, opts: SyncOptions = {}): SyncResult {
  const target = resolve(dir);
  const templates = opts.templates ?? TEMPLATES;
  // An older fm would write its older kit over a project that needs a newer one (D0026).
  checkVersion(target);
  const rec = readInstalled(target);
  if (!rec) throw new Error(`no ${recordPath(target)} here: set up foreman with init (or create) first`);
  const pieces = filePieces(rec);
  const files = { ...rec.files };
  const hooks = { ...rec.hooks };
  const changes: Change[] = [];
  const put = (path: string, data: Uint8Array | string) => opts.dryRun || write(target, path, data);
  const hashOf = (path: string) => (existsSync(join(target, path)) ? sha256(readFileSync(join(target, path))) : null);

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

  // Vendored packages: a new tarball replaces the old one, and package.json is pointed at it.
  let reinstall = false;
  let pkgJson = existsSync(join(target, "package.json")) ? readFileSync(join(target, "package.json"), "utf8") : null;
  const pkgBefore = pkgJson;
  for (const old of Object.keys(files).filter((p) => p.startsWith(`${VENDOR}/`))) {
    const pkg = vendoredName(old);
    if (!pkg) continue;
    const { path, data } = pack(pkg);
    if (path === old) continue;
    put(path, data);
    if (!opts.dryRun && existsSync(join(target, old))) unlinkSync(join(target, old));
    delete files[old];
    files[path] = sha256(data);
    changes.push({ action: "updated", path, note: `${SCOPE}/${pkg}, replaces ${old}` });
    if (pkgJson !== null) pkgJson = pointDep(pkgJson, pkg, path);
    reinstall = true;
  }
  if (pkgJson !== null && pkgJson !== pkgBefore) {
    put("package.json", pkgJson);
    changes.push({ action: "updated", path: "package.json", note: "points at the new vendored packages" });
  }

  // Files the kit no longer ships stay: the project may use them. Only the record forgets them.
  for (const path of Object.keys(files)) {
    if (!kit.has(path) && !path.startsWith(`${VENDOR}/`)) {
      delete files[path];
      changes.push({ action: "removed", path, note: "no longer in the kit; left in place (delete it if unused)" });
    }
  }

  const to = source();
  if (!opts.dryRun) writeInstalled(target, { ...rec, source: to, files, hooks });
  return { from: rec.source, to, changes, reinstall };
}
