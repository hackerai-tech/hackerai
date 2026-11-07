import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPredictionSources,
  parsePredictedNextAction,
} from "../../../lib/chat/next-actions/contracts.ts";
import {
  fixtures,
  prepare,
  summarize,
  baselineSystem,
  reportedCost,
} from "./benchmark.ts";

test("both fixed splits prepare balanced paired requests from actual context and parser", () => {
  assert.equal(fixtures().length, 40);
  assert.equal(new Set(fixtures().map((f) => f.id)).size, 40);
  for (const split of ["tuning", "holdout"] as const) {
    const a = prepare(split);
    assert.deepEqual(a, prepare(split));
    assert.equal(a.manifest.caseCount, 20);
    assert.equal(a.rows.length, 80);
    assert.equal(a.manifest.plannedProviderCalls, 72);
    assert.equal(a.rows.filter((r) => r.arm === 0).length, 40);
    for (let i = 0; i < a.rows.length; i += 2) {
      const [left, right] = a.rows.slice(i, i + 2);
      assert.equal(left.caseId, right.caseId);
      assert.equal(left.repeat, right.repeat);
      assert.equal(left.prompt, right.prompt);
      assert.equal(left.skip, right.skip);
      assert.notEqual(left.arm, right.arm);
      assert.equal((left.arm === 0 ? left : right).system, baselineSystem());
    }
    for (const f of fixtures().filter((f) => f.split === split)) {
      const built = buildPredictionSources(f.messages);
      assert(built.reduce((sum, s) => sum + s.text.length, 0) <= 12000);
      assert.equal(
        JSON.parse(a.rows.find((r) => r.caseId === f.id)!.prompt).length,
        built.length,
      );
      if (f.category === "explicit-stop")
        assert(a.rows.filter((r) => r.caseId === f.id).every((r) => r.skip));
      if (f.category === "quoted-context")
        assert(a.rows.filter((r) => r.caseId === f.id).every((r) => !r.skip));
    }
  }
});

test("receipt coverage distinguishes priced calls, unknown calls, noncalls and missing tokens", () => {
  assert.equal(reportedCost({}), null);
  assert.equal(reportedCost({ cost: 0 }), 0);
  assert.equal(reportedCost({ cost: -1 }), null);
  assert.equal(reportedCost({ cost: Infinity }), null);
  assert.equal(reportedCost({ cost: 0.002 }), 0.002);
  const base = {
    latencyMs: 100,
    output: { suggestion: "show me an example" },
    unavailable: false,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    model: null,
  };
  const result = summarize([
    { ...base, id: "paid", providerCalls: 1, costUsd: 0.002 },
    {
      ...base,
      id: "unknown",
      providerCalls: 1,
      costUsd: null,
      unavailable: true,
    },
    { ...base, id: "free", providerCalls: 1, costUsd: 0 },
    {
      ...base,
      id: "skip",
      providerCalls: 0,
      costUsd: 0,
      output: { suggestion: null },
    },
  ]);
  assert.equal(result.batches, 4);
  assert.equal(result.calls, 3);
  assert.equal(result.pricedCalls, 2);
  assert.equal(result.unknownCalls, 1);
  assert.equal(result.knownCostUsd, 0.002);
  assert.equal(result.costPer1000PricedCalls, 1);
  assert.equal(summarize([]).medianProviderPathMs, null);
  for (const costUsd of [-1, NaN, Infinity])
    assert.throws(() =>
      summarize([{ ...base, id: "bad", providerCalls: 1, costUsd }]),
    );
  assert.throws(() =>
    summarize([{ ...base, id: "noncall", providerCalls: 0, costUsd: 0.01 }]),
  );
  assert.throws(() =>
    summarize(
      [1, 2].map(() => ({
        ...base,
        id: "duplicate",
        providerCalls: 1,
        costUsd: null,
      })),
    ),
  );
});

test("benchmark uses application rejection rules instead of treating formatting as quality", () => {
  for (const suggestion of [
    "/goal start a scan",
    "line one\nline two",
    "x".repeat(241),
  ])
    assert.deepEqual(parsePredictedNextAction({ suggestion }), []);
  assert.deepEqual(parsePredictedNextAction({ suggestion: null }), []);
  assert.deepEqual(
    parsePredictedNextAction({ suggestion: "how do i capture that output?" }),
    ["how do i capture that output?"],
  );
});
