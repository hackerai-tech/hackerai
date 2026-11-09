import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  assertGate,
  changedSince,
  planForEvent,
  planOutputs,
  selectPlan,
} from "./ci-plan.mjs";
import { runSuites, suites } from "./run-tooling.mjs";

export function jestArgs({ mode, shard, coverage, paths }) {
  if (
    !["full", "related"].includes(mode) ||
    !/^[1-4]\/[1-4]$/.test(shard) ||
    Number(shard[0]) > Number(shard[2])
  )
    throw new Error("Invalid Jest execution plan");
  const args = ["--ci", "--maxWorkers=2", `--shard=${shard}`];
  if (coverage) args.push("--coverage");
  if (mode === "related") {
    if (!Array.isArray(paths) || !paths.length)
      throw new Error("Related tests require committed paths");
    args.push("--passWithNoTests", "--findRelatedTests", ...paths);
  }
  return args;
}

export function main(action, env = process.env) {
  if (action === "plan") {
    const plan = planForEvent(env);
    const outputs = planOutputs(plan);
    if (env.GITHUB_OUTPUT)
      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries(outputs)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      );
    console.log(JSON.stringify(plan));
    return 0;
  }
  if (action === "gate") {
    assertGate(JSON.parse(env.CI_NEEDS));
    console.log("All planned CI checks passed.");
    return 0;
  }
  if (action === "tooling") {
    const selected = JSON.parse(env.CI_TOOLING_SUITES);
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some((name) => !suites.some((suite) => suite.name === name))
    )
      throw new Error("Invalid tooling plan");
    return runSuites(suites.filter((suite) => selected.includes(suite.name)));
  }
  if (action === "jest") {
    let mode = env.CI_JEST_MODE;
    let paths;
    if (mode === "related") {
      try {
        paths = changedSince(env.CI_BASE_SHA);
        if (selectPlan(paths).jest !== "related") mode = "full";
      } catch {
        mode = "full";
      }
    }
    const args = jestArgs({
      mode,
      paths,
      shard: env.CI_SHARD,
      coverage: env.CI_COVERAGE === "true",
    });
    const jest = createRequire(import.meta.url).resolve("jest/bin/jest");
    const result = spawnSync(process.execPath, [jest, ...args], {
      stdio: "inherit",
    });
    return result.error || result.signal ? 1 : (result.status ?? 1);
  }
  throw new Error("Usage: ci.mjs <plan|jest|tooling|gate>");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = main(process.argv[2]);
  } catch {
    console.error("CI execution failed; check the plan and job results.");
    process.exitCode = 1;
  }
}
