import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCoverage } from "./merge-coverage.mjs";

const location = {
  start: { line: 1, column: 0 },
  end: { line: 1, column: 10 },
};
function shard(name, hits) {
  return {
    result: {
      success: true,
      numFailedTestSuites: 0,
      numFailedTests: 0,
      numTotalTests: 2,
      numPendingTests: 1,
      testResults: [{ name }],
    },
    coverage: {
      "/repo/shared.ts": {
        path: "/repo/shared.ts",
        statementMap: { 0: location },
        fnMap: {},
        branchMap: {},
        s: { 0: hits },
        f: {},
        b: {},
      },
    },
  };
}

test("combines hits before enforcing coverage and retains intentionally skipped tests", () => {
  const result = mergeCoverage(["a", "b"], [shard("a", 0), shard("b", 2)], {
    global: { statements: 100 },
  });
  assert.equal(result.merged.fileCoverageFor("/repo/shared.ts").s[0], 2);
  assert.equal(result.suites, 2);
  assert.equal(result.tests, 4);
  assert.equal(result.pending, 2);
});

test("preserves distinct functions sharing a source-mapped body and rejects different instrumentation", () => {
  const shards = [shard("a", 0), shard("b", 2)];
  for (const s of shards) {
    const file = s.coverage["/repo/shared.ts"];
    file.fnMap = {
      0: { name: "outer", decl: location, loc: location },
      1: {
        name: "inner",
        decl: { ...location, start: { line: 1, column: 1 } },
        loc: location,
      },
    };
    file.f = { 0: 1, 1: 0 };
    file.branchMap = {
      0: { type: "if", loc: location, locations: [location, location] },
    };
    file.b = { 0: [1, 0] };
  }
  const result = mergeCoverage(["a", "b"], shards);
  const file = result.merged.fileCoverageFor("/repo/shared.ts");
  assert.equal(file.toSummary().functions.total, 2);
  assert.deepEqual(file.f, { 0: 2, 1: 0 });
  assert.deepEqual(file.b, { 0: [2, 0] });
  assert.equal(shards[0].coverage["/repo/shared.ts"].f[0], 1);
  shards[1].coverage["/repo/shared.ts"].fnMap[1].name = "different";
  assert.throws(
    () => mergeCoverage(["a", "b"], shards),
    /Instrumentation mismatch/,
  );
});

test("fails closed on missing or duplicated test coverage and failed shards", () => {
  for (const change of [
    (shards) => shards.pop(),
    (shards) => {
      shards[1] = shard("a", 1);
    },
    (shards) => {
      shards[1] = shard("unexpected", 1);
    },
    (shards) => {
      shards[1].result.testResults = [];
    },
    (shards) => {
      shards[1].coverage = {};
    },
    (shards) => {
      shards[1].result.success = false;
    },
    (shards) => {
      shards[1].result.numFailedTests = 1;
    },
    (shards) => {
      shards[1].result.numFailedTestSuites = 1;
    },
  ]) {
    const shards = [shard("a", 0), shard("b", 1)];
    change(shards);
    assert.throws(() => mergeCoverage(["a", "b"], shards));
  }
  assert.throws(() => mergeCoverage([], [shard("a", 0), shard("b", 1)]));
  assert.throws(() =>
    mergeCoverage(["a", "b", "missing"], [shard("a", 0), shard("b", 1)]),
  );
});

test("enforces positive percentages and negative uncovered limits without ignoring new config", () => {
  const shards = [shard("a", 0), shard("b", 0)];
  assert.throws(
    () => mergeCoverage(["a", "b"], shards, { global: { statements: 1 } }),
    /threshold failed/,
  );
  assert.doesNotThrow(() =>
    mergeCoverage(["a", "b"], shards, { global: { statements: -1 } }),
  );
  assert.throws(
    () => mergeCoverage(["a", "b"], shards, { "./app/": { statements: 80 } }),
    /Scoped/,
  );
});
