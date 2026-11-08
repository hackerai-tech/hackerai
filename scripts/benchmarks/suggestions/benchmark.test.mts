import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32, posix } from "node:path";
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
  benchmarkDestination,
  benchmarkFailureMessage,
  root,
  retainProviderReceipt,
  withinRepository,
} from "./benchmark.ts";

test("containment recognizes genuine parent traversal and sibling drives on both path platforms", () => {
  for (const paths of [posix, win32]) {
    const parent = paths === win32 ? "C:\\checkout" : "/checkout";
    assert(withinRepository(parent, parent, paths));
    assert(withinRepository(parent, paths.join(parent, "results"), paths));
    assert(withinRepository(parent, paths.join(parent, "..hidden"), paths));
    assert(
      !withinRepository(parent, paths.resolve(parent, "../results"), paths),
    );
  }
  assert(!withinRepository("C:\\checkout", "D:\\results", win32));
});

test("benchmark results cannot be written into the checkout directly or through a symlink", () => {
  assert.throws(() => benchmarkDestination(root));
  assert.throws(() => benchmarkDestination(join(root, "benchmark-results")));
  const temporary = mkdtempSync(join(tmpdir(), "suggestion-destination-"));
  try {
    symlinkSync(root, join(temporary, "checkout"));
    assert.throws(() => benchmarkDestination(join(temporary, "checkout")));
    assert.equal(benchmarkDestination(temporary), realpathSync(temporary));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

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

test("task-progress cases preserve goals, delivered replies and balanced active/finished cases", () => {
  assert.equal(fixtures("task-progress").length, 48);
  for (const split of ["tuning", "holdout"] as const) {
    const cases = fixtures("task-progress").filter((f) => f.split === split);
    assert.equal(cases.filter((f) => f.expectation === "suggest").length, 20);
    assert.equal(cases.filter((f) => f.expectation === "silence").length, 4);
    assert(cases.every((f) => f.goal && f.progressCriteria?.length));
    const plan = prepare(split, "task-progress");
    assert.equal(plan.rows.length, 96);
    assert.equal(plan.manifest.plannedProviderCalls, 88);
    for (const fixture of cases) {
      const context = buildPredictionSources(fixture.messages);
      assert.equal(context[0].role, "user");
      assert.equal(context.at(-1)?.role, "assistant");
      if (fixture.category === "wait-reply")
        assert(
          context.at(-1)?.text.includes('"waitOutcome":"message_arrived"'),
        );
      if (fixture.category === "stop")
        assert(
          plan.rows.filter((r) => r.caseId === fixture.id).every((r) => r.skip),
        );
      else
        assert(
          plan.rows
            .filter((r) => r.caseId === fixture.id)
            .every((r) => !r.skip),
        );
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

test("failed structured outputs retain valid USD while invalid token metadata stays unknown", () => {
  const receipt = {
    id: "parse-failed",
    providerCalls: 1,
    costUsd: null,
    latencyMs: 120,
    output: { suggestion: null },
    unavailable: true,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    model: null,
  };
  retainProviderReceipt(
    receipt,
    { raw: { cost: 0.002 }, inputTokens: 100, outputTokens: -1 },
    { modelId: "test-model" },
  );
  const result = summarize([receipt]);
  assert.equal(result.knownCostUsd, 0.002);
  assert.equal(result.pricedCalls, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.input.tokens, 100);
  assert.equal(result.output.tokens, null);
  retainProviderReceipt(receipt, undefined, undefined);
  assert.equal(summarize([receipt]).unknownCalls, 1);
  assert.equal(summarize([receipt]).unknownModelCalls, 1);
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

test("local setup diagnostics stay actionable while arbitrary errors remain private", () => {
  try {
    benchmarkDestination(process.cwd());
    assert.fail("Expected repository path rejection");
  } catch (error) {
    assert.equal(
      benchmarkFailureMessage(error),
      "Keep generated results outside the repository",
    );
  }
  for (const error of [
    new Error("private provider payload"),
    "secret value",
    { message: "private filesystem path" },
  ]) {
    assert.equal(
      benchmarkFailureMessage(error),
      "Benchmark failed. Check inputs and receipts privately; no credentials or provider payload logged.",
    );
  }
});

test("prediction review plans keep direct choices and delivered replies in actual context", () => {
  const cases = fixtures("prediction");
  const plan = prepare("holdout", "prediction");
  assert(cases.every((f) => f.predictionCriteria?.length));
  assert.equal(plan.manifest.plannedBatches, 4 * cases.length);
  for (const f of cases.filter((f) => f.category === "wait-reply")) {
    const rows = plan.rows.filter((r) => r.caseId === f.id);
    assert(rows.every((r) => r.prompt.includes("message_arrived")));
  }
  for (const f of cases.filter((f) => f.category === "stop")) {
    assert(plan.rows.filter((r) => r.caseId === f.id).every((r) => r.skip));
  }
});
