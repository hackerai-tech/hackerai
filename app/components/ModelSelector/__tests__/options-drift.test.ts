import { describe, it, expect } from "@jest/globals";
import { AGENT_MODEL_OPTIONS } from "../constants";
import { myProvider, resolveAgentTierToProviderKey } from "@/lib/ai/providers";

/** Every selectable paid Agent tier must have a registered provider. */
describe("ModelSelector tier provider drift", () => {
  it("every Agent option resolves to a registered provider", () => {
    for (const option of AGENT_MODEL_OPTIONS) {
      const providerKey = resolveAgentTierToProviderKey(option.id);
      expect(providerKey).not.toBeNull();
      expect(() =>
        myProvider.languageModel(providerKey as string),
      ).not.toThrow();
    }
  });

  it.each([
    ["hackerai-standard", "model-deepseek-v4.1-flash-1017-pro"],
    ["hackerai-pro", "model-deepseek-v4.1-flash-1017-pro"],
    ["hackerai-max", "model-glm-5.3"],
  ] as const)("resolves the Agent provider for %s", (tier, model) => {
    expect(resolveAgentTierToProviderKey(tier)).toBe(model);
  });

  it("leaves Auto routing to the caller", () => {
    expect(resolveAgentTierToProviderKey("auto")).toBeNull();
  });

  it("includes descriptions for every Agent tier", () => {
    for (const option of AGENT_MODEL_OPTIONS) {
      expect(option.description).toBeTruthy();
    }
  });
});
