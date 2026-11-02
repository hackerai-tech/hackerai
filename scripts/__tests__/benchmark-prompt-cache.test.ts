import { summarizeCacheRows } from "../benchmark-prompt-cache";

const row = {
  pair: 0,
  variant: "treatment" as const,
  step: 0,
  input: 100,
  cached: 0,
  written: 0,
  output: 5,
  cost: 0,
  elapsedMs: 10,
  valid: true,
};

it("weights cache reads by covered input, includes cold misses and preserves explicit zero cost", () => {
  expect(
    summarizeCacheRows([
      row,
      { ...row, input: 300, cached: 200, written: 10 },
      { ...row, input: 900, cached: null, cost: null },
    ]),
  ).toMatchObject({
    calls: 3,
    cacheCoverage: 2,
    cacheReadRatio: 0.5,
    inputTokensWithCacheCoverage: 400,
    cachedTokens: 200,
    writeCoverage: 3,
    writtenTokens: 10,
    costCoverage: 2,
    reportedCost: 0,
  });
});

it("keeps missing usage and cost unknown rather than reporting a miss or free work", () => {
  expect(
    summarizeCacheRows([
      {
        ...row,
        input: null,
        cached: null,
        written: null,
        cost: null,
        valid: false,
      },
    ]),
  ).toMatchObject({
    valid: 0,
    cacheCoverage: 0,
    cacheReadRatio: null,
    writeCoverage: 0,
    writtenTokens: null,
    costCoverage: 0,
    reportedCost: null,
  });
});
