import { estimateExperimentProviderCost } from "../experiment-provider-cost";
it.each([
  ["abliterated-model", 3.55],
  ["abliterated-model-large-v2", 6.65],
] as const)(
  "prices %s using current provider rates and reported cache tokens",
  (modelName, expected) => {
    expect(
      estimateExperimentProviderCost({
        modelName,
        inputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(expected);
  },
);
it("does not invent a cache discount when usage omits it", () => {
  expect(
    estimateExperimentProviderCost({
      modelName: "abliterated-model",
      inputTokens: 1_000_000,
      outputTokens: 0,
    }),
  ).toBe(1);
});
