import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, mergeSettings, TEMPLATES, unmatchedOmit } from "../src/install";

const dir = mkdtempSync(join(tmpdir(), "agent-kit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const baseline = JSON.parse(readFileSync(join(TEMPLATES, ".claude", "settings.json"), "utf8"));

test("the baseline denies the things D0003 says it must", () => {
  const deny: string[] = baseline.permissions.deny;
  for (const rule of [
    "Bash(git push * main)",
    "Bash(git push --force *)",
    "Bash(git commit --no-verify*)",
    "Bash(rm -rf *)",
    "Read(**/.env)",
    "Read(**/.env.local)",
  ]) {
    expect(deny).toContain(rule);
  }
  // Write(...) rules never match in Claude Code; Edit/Read cover the file tools.
  expect(JSON.stringify(baseline)).not.toContain("Write(");
  // No rule is both allowed and denied.
  expect(baseline.permissions.allow.filter((r: string) => deny.includes(r))).toEqual([]);
});

test("a fresh repo gets the templates", () => {
  const target = join(dir, "fresh");
  mkdirSync(target);
  const r = install(target);
  expect(r.created).toContain(join(".claude", "settings.json"));
  expect(JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"))).toEqual(baseline);
});

test("an existing settings file keeps its rules and gains the baseline's; nothing is overwritten", () => {
  const target = join(dir, "existing");
  mkdirSync(join(target, ".claude"), { recursive: true });
  const mine = { model: "opus", permissions: { allow: ["Bash(make *)"], deny: ["Bash(git push * main)"] } };
  writeFileSync(join(target, ".claude", "settings.json"), JSON.stringify(mine));
  const r = install(target);
  expect(r.merged).toEqual([join(".claude", "settings.json")]);
  const after = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  expect(after.model).toBe("opus");
  expect(after.permissions.allow[0]).toBe("Bash(make *)");
  expect(after.permissions.deny.filter((x: string) => x === "Bash(git push * main)").length).toBe(1);
  expect(after.permissions.deny).toContain("Read(**/.env)");
  // a second run changes nothing
  expect(install(target).merged).toEqual([]);
});

test("mergeSettings counts what it adds", () => {
  expect(mergeSettings(baseline, baseline).added).toBe(0);
  expect(mergeSettings({}, baseline).added).toBeGreaterThan(30);
});

test("a rule listed as omitted is not re-added by a second init, and init says so", () => {
  const target = join(dir, "omit");
  mkdirSync(join(target, ".claude"), { recursive: true });
  install(target);
  const file = join(target, ".claude", "settings.json");
  // The project removes a deny rule, an ask rule and the guard hook on purpose, and records it.
  const guard = baseline.hooks.PreToolUse[0].hooks[0].command;
  const start = baseline.hooks.SessionStart[0].hooks[0].command;
  const s = JSON.parse(readFileSync(file, "utf8"));
  s.permissions.deny = s.permissions.deny.filter((r: string) => r !== "Bash(rm -rf *)");
  s.permissions.ask = s.permissions.ask.filter((r: string) => r !== "Bash(ssh *)");
  delete s.hooks;
  writeFileSync(file, JSON.stringify(s));
  writeFileSync(
    join(target, ".claude", "agent-kit.json"),
    JSON.stringify({ omit: ["Bash(rm -rf *)", "Bash(ssh *)", guard, start, "Bash(not-in-baseline *)"] }),
  );
  for (let run = 0; run < 2; run++) {
    const r = install(target);
    expect(r.merged).toEqual([]);
    expect(r.kept).toContain(join(".claude", "settings.json"));
    expect(r.omitted.sort()).toEqual(["Bash(rm -rf *)", "Bash(ssh *)", guard, start].sort());
    // Only the typo warns; entries for baseline rules and hooks (removed or not) don't.
    expect(r.unmatchedOmit).toEqual(["Bash(not-in-baseline *)"]);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.permissions.deny).not.toContain("Bash(rm -rf *)");
    expect(after.permissions.ask).not.toContain("Bash(ssh *)");
    expect(after.hooks).toBeUndefined();
    expect(after.permissions.deny).toContain("Read(**/.env)");
  }
  // A baseline rule removed but not listed still comes back.
  const s2 = JSON.parse(readFileSync(file, "utf8"));
  s2.permissions.deny = s2.permissions.deny.filter((r: string) => r !== "Read(**/.env)");
  writeFileSync(file, JSON.stringify(s2));
  const r = install(target);
  expect(r.merged).toEqual([join(".claude", "settings.json")]);
  expect(JSON.parse(readFileSync(file, "utf8")).permissions.deny).toContain("Read(**/.env)");
});

test("an omitted rule the project kept itself stays; omit applies to a fresh install too", () => {
  const kept = mergeSettings({ permissions: { ask: ["Bash(ssh *)"] } }, baseline, ["Bash(ssh *)"]);
  expect(kept.settings.permissions?.ask).toContain("Bash(ssh *)");
  expect(kept.omitted).toEqual([]);

  const target = join(dir, "omit-fresh");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "agent-kit.json"), JSON.stringify({ omit: ["Bash(docker *)"] }));
  const r = install(target);
  expect(r.created).toContain(join(".claude", "settings.json"));
  expect(r.omitted).toEqual(["Bash(docker *)"]);
  const after = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  expect(after.permissions.ask).not.toContain("Bash(docker *)");
  expect(after.permissions.ask).toContain("Bash(ssh *)");
  expect(after.hooks).toEqual(baseline.hooks);
});

test("omitting a whole list or every hook leaves it out, not the baseline's copy", () => {
  const guard = baseline.hooks.PreToolUse[0].hooks[0].command;
  const start = baseline.hooks.SessionStart[0].hooks[0].command;
  const { settings, omitted } = mergeSettings({}, baseline, [...baseline.permissions.ask, guard, start]);
  expect(settings.permissions?.ask).toBeUndefined();
  expect(settings.hooks).toBeUndefined();
  expect(settings.permissions?.deny).toEqual(baseline.permissions.deny);
  expect(omitted).toEqual([...baseline.permissions.ask, guard, start]);
});

test("a malformed omit file stops init with a clear error", () => {
  const target = join(dir, "omit-bad");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "agent-kit.json"), "{ not json");
  expect(() => install(target)).toThrow("agent-kit.json is not valid JSON");
  writeFileSync(join(target, ".claude", "agent-kit.json"), JSON.stringify({ omit: "Bash(ssh *)" }));
  expect(() => install(target)).toThrow('"omit" must be a list of strings');
});

test("omit entries for baseline rules the project still has don't warn; a typo does, and init still succeeds", () => {
  expect(unmatchedOmit(baseline, ["Bash(ssh *)", "Read(**/.env)", baseline.hooks.PreToolUse[0].hooks[0].command])).toEqual([]);
  expect(unmatchedOmit(baseline, ["Bash(sshh *)", "Bash(sshh *)"])).toEqual(["Bash(sshh *)"]);
  const target = join(dir, "omit-typo");
  mkdirSync(join(target, ".claude"), { recursive: true });
  install(target);
  writeFileSync(join(target, ".claude", "agent-kit.json"), JSON.stringify({ omit: ["Bash(ssh *)", "Bash(sshh *)"] }));
  expect(install(target).unmatchedOmit).toEqual(["Bash(sshh *)"]);
});
