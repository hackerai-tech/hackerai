import { resolveSubagentContextBudget } from "../context";
import { SUBAGENT_PAID_TEXT_MODEL } from "../model-routing";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/db/actions", () => ({}));

const PAID_ROUTE_SLUG = "deepseek/deepseek-v4-flash";

describe("resolveSubagentContextBudget", () => {
  it.each(["free", "pro", "ultra", "team"] as const)(
    "keeps a %s child on the 276k/256k Agent baseline",
    (subscription) => {
      expect(
        resolveSubagentContextBudget({
          subscription,
          modelId: PAID_ROUTE_SLUG,
        }),
      ).toEqual({
        maxTokens: 276_000,
        thresholdTokens: 256_000,
        expanded: false,
      });
    },
  );

  it("does not treat the routed Pro model key as an explicit Pro selection", () => {
    expect(
      resolveSubagentContextBudget({
        subscription: "pro",
        modelId: SUBAGENT_PAID_TEXT_MODEL,
      }),
    ).toEqual({
      maxTokens: 276_000,
      thresholdTokens: 256_000,
      expanded: false,
    });
  });

  it("uses the larger verified model budget only for an eligible explicit selection", () => {
    const expanded = resolveSubagentContextBudget({
      subscription: "pro",
      modelId: PAID_ROUTE_SLUG,
      selectedModel: "hackerai-pro",
    });
    expect(expanded.expanded).toBe(true);
    expect(expanded.maxTokens).toBeGreaterThan(276_000);
    expect(expanded.thresholdTokens).toBe(expanded.maxTokens - 20_000);

    // Unknown routes and free plans fail closed to the baseline.
    expect(
      resolveSubagentContextBudget({
        subscription: "pro",
        modelId: "custom/unknown",
        selectedModel: "hackerai-pro",
      }).maxTokens,
    ).toBe(276_000);
    expect(
      resolveSubagentContextBudget({
        subscription: "free",
        modelId: PAID_ROUTE_SLUG,
        selectedModel: "hackerai-max",
      }).maxTokens,
    ).toBe(276_000);
  });
});
