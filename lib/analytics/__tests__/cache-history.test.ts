import {
  cacheHistoryProperties,
  sampleCacheHistoryStart,
  type CacheHistoryTelemetry,
} from "../cache-history";

it("samples a stable tenth of random run identifiers independently of treatment", () => {
  const decisions = Array.from({ length: 10_000 }, (_, i) =>
    sampleCacheHistoryStart(`run-${i}`),
  );
  expect(decisions.filter(Boolean).length).toBeGreaterThan(900);
  expect(decisions.filter(Boolean).length).toBeLessThan(1100);
  expect(sampleCacheHistoryStart("run-1")).toBe(
    sampleCacheHistoryStart("run-1"),
  );
});

it("projects only bounded metadata, never attached contents or error text", () => {
  const value = {
    runId: "random-id",
    eligible: true,
    assignment: "treatment",
    model: "test-model",
    startedAt: 1000,
    sampled: false,
    attempts: 2,
    exposures: 1,
    restores: 1,
    load: "restored",
    save: "timeout",
    prompt: "private",
    error: "secret error",
  } as CacheHistoryTelemetry;
  const props = cacheHistoryProperties(value);
  expect(props).toMatchObject({
    cache_history_run_id: "random-id",
    cache_history_attempts: 2,
    cache_history_save_result: "timeout",
  });
  expect(JSON.stringify(props)).not.toMatch(/private|secret error|prompt/);
  expect(cacheHistoryProperties()).toEqual({});
});
