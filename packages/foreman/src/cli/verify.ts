// fm verify and verdict: taking a submitted task and recording one result per check.
import { type CheckResult, ForemanError } from "../core";
import type { Module } from "./context";

export const help = {
  verify: `  verify <id>                   take the task for verification`,
  verdict: `  verdict <id> --result 'c1:pass:evidence' ...   or  --results-json file|-`,
};

function parseResult(s: string): CheckResult {
  const m = /^([^:]+):(pass|fail):(.*)$/s.exec(s);
  if (!m) throw new ForemanError("invalid", `--result must be check:pass|fail:evidence, got "${s}"`);
  return { check: m[1]!.trim(), pass: m[2] === "pass", evidence: m[3]!.trim() };
}

export const commands: Module["commands"] = {
  verify: ({ f, me, lease, need, one }) => (one(f.startVerify(need(0, "task id"), me, lease)), 0),
  async verdict({ f, me, o, need, one }) {
    let results: CheckResult[] = (o.result ?? []).map(parseResult);
    const rj = o["results-json"];
    if (rj) {
      const text = rj === "-" ? await Bun.stdin.text() : await Bun.file(rj).text();
      results = JSON.parse(text);
    }
    return one(f.recordVerify(need(0, "task id"), me, results)), 0;
  },
};
