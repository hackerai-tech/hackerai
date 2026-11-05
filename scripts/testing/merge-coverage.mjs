import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import coverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

// The complete discovery list is independent of the shard results, so a missing
// artifact, duplicate shard, or accidental test filter cannot produce a green gate.
export function mergeCoverage(expectedTests, shards, thresholds = {}) {
  assert(expectedTests.length > 0, "No tests discovered");
  assert.equal(new Set(expectedTests).size, expectedTests.length);
  assert.equal(shards.length, 2, "Expected both Jest shards");
  const seen = new Set();
  const merged = coverage.createCoverageMap({});
  let tests = 0;
  let pending = 0;
  for (const { result, coverage: data } of shards) {
    assert.equal(result.success, true, "Jest shard failed");
    assert.equal(result.numFailedTestSuites, 0, "Failed test suite");
    assert.equal(result.numFailedTests, 0, "Failed test");
    assert(result.testResults.length > 0, "Empty Jest shard");
    assert(Object.keys(data).length > 0, "Missing coverage");
    for (const suite of result.testResults) {
      assert(!seen.has(suite.name), `Duplicate suite: ${suite.name}`);
      seen.add(suite.name);
    }
    tests += result.numTotalTests;
    pending += result.numPendingTests;
    merged.merge(data);
  }
  assert.deepEqual(
    [...seen].sort(),
    [...expectedTests].sort(),
    "Test inventory mismatch",
  );
  // Fail closed if the repository adds scoped thresholds: these need Jest's
  // subtract-from-global semantics, not a silently ignored configuration.
  assert(
    Object.keys(thresholds).every((key) => key === "global"),
    "Scoped coverage thresholds need aggregation support",
  );
  const summary = merged.getCoverageSummary().toJSON();
  for (const [metric, threshold] of Object.entries(thresholds.global ?? {})) {
    assert(summary[metric], `Unknown coverage metric: ${metric}`);
    const { total, covered, pct } = summary[metric];
    assert(
      threshold < 0 ? total - covered <= -threshold : pct >= threshold,
      `Coverage threshold failed: ${metric} (${pct}%, ${total - covered} uncovered)`,
    );
  }
  return { merged, suites: seen.size, tests, pending };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(process.argv[2] ?? "coverage");
  const config = (await import("../../jest.config.js")).default;
  const { coverageThreshold, coverageReporters } = await config();
  const result = mergeCoverage(
    readJson(`${root}/expected-tests.json`),
    [1, 2].map((id) => ({
      result: readJson(`${root}/jest-shard-${id}/results.json`),
      coverage: readJson(`${root}/jest-shard-${id}/coverage-final.json`),
    })),
    coverageThreshold,
  );
  const context = libReport.createContext({
    dir: `${root}/combined`,
    coverageMap: result.merged,
  });
  for (const reporter of new Set([...coverageReporters, "json"])) {
    assert.equal(
      typeof reporter,
      "string",
      "Reporter options need aggregation support",
    );
    reports.create(reporter).execute(context);
  }
  console.log(
    `Verified ${result.suites} suites, ${result.tests} tests (${result.pending} intentionally pending); merged coverage thresholds passed.`,
  );
}
