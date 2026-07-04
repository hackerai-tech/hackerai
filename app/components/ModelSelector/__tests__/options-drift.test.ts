import { describe, it, expect } from "@jest/globals";
import { ASK_MODEL_OPTIONS, AGENT_MODEL_OPTIONS } from "../constants";
import { myProvider, resolveTierToProviderKey } from "@/lib/ai/providers";
import type { ChatMode } from "@/types/chat";

/**
 * Drift guard: every selectable ZHACKER tier must resolve to a provider key
 * registered with `myProvider` in *both* modes. Without this, picking the
 * tier from the UI would crash on `myProvider.languageModel()`.
 */
describe("ModelSelector tier ↔ provider drift", () => {
  const allOptions = [...ASK_MODEL_OPTIONS, ...AGENT_MODEL_OPTIONS];

  it("every option in both lineups resolves to a registered provider", () => {
    for (const mode of ["ask", "agent"] as ChatMode[]) {
      const options =
        mode === "agent" ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;
      for (const option of options) {
        const providerKey = resolveTierToProviderKey(option.id, mode);
        expect(providerKey).not.toBeNull();
        expect(() =>
          myProvider.languageModel(providerKey as string),
        ).not.toThrow();
      }
    }
  });

  it("ask + agent lineups expose the same tier ids", () => {
    const askIds = new Set(ASK_MODEL_OPTIONS.map((o) => o.id));
    const agentIds = new Set(AGENT_MODEL_OPTIONS.map((o) => o.id));
    expect([...askIds].sort()).toEqual([...agentIds].sort());
  });

  it("ZHACKER Standard resolves to different providers per mode", () => {
    expect(resolveTierToProviderKey("zhacker-standard", "ask")).toBe(
      "model-deepseek-v4-pro",
    );
    expect(resolveTierToProviderKey("zhacker-standard", "agent")).toBe(
      "model-minimax-m3",
    );
  });

  it("ZHACKER Pro resolves to Sonnet in both modes", () => {
    expect(resolveTierToProviderKey("zhacker-pro", "ask")).toBe(
      "model-sonnet-4.6",
    );
    expect(resolveTierToProviderKey("zhacker-pro", "agent")).toBe(
      "model-sonnet-4.6",
    );
  });

  it("ZHACKER Max resolves to the same provider in both modes", () => {
    expect(resolveTierToProviderKey("zhacker-max", "ask")).toBe(
      "model-opus-4.6",
    );
    expect(resolveTierToProviderKey("zhacker-max", "agent")).toBe(
      "model-opus-4.6",
    );
  });

  it("'auto' returns null (caller routes to the auto router)", () => {
    expect(resolveTierToProviderKey("auto", "ask")).toBeNull();
    expect(resolveTierToProviderKey("auto", "agent")).toBeNull();
  });

  it("hover-popup descriptions are present for every ZHACKER tier", () => {
    const tiered = allOptions.filter((o) => o.label.startsWith("ZHACKER"));
    expect(tiered.length).toBeGreaterThan(0);
    for (const option of tiered) {
      expect(option.description).toBeTruthy();
      expect(option.poweredBy).toBeTruthy();
    }
  });
});
