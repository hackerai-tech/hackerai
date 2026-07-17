import { describe, it, expect } from "@jest/globals";
import { ASK_MODEL_OPTIONS, AGENT_MODEL_OPTIONS } from "../constants";
import { myProvider, resolveTierToProviderKey } from "@/lib/ai/providers";
import type { ChatMode } from "@/types/chat";

/**
 * Drift guard: every selectable HackerAI tier must resolve to a provider key
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

  it("HackerAI Standard resolves to DeepSeek in both modes", () => {
    expect(resolveTierToProviderKey("hackerai-standard", "ask")).toBe(
      "model-deepseek-v4-pro",
    );
    expect(resolveTierToProviderKey("hackerai-standard", "agent")).toBe(
      "model-deepseek-v4-pro",
    );
  });

  it("HackerAI Pro resolves to its dedicated Grok route in both modes", () => {
    expect(resolveTierToProviderKey("hackerai-pro", "ask")).toBe(
      "model-grok-4.5-pro",
    );
    expect(resolveTierToProviderKey("hackerai-pro", "agent")).toBe(
      "model-grok-4.5-pro",
    );
  });

  it("HackerAI Max resolves to the same provider in both modes", () => {
    expect(resolveTierToProviderKey("hackerai-max", "ask")).toBe(
      "model-opus-4.6",
    );
    expect(resolveTierToProviderKey("hackerai-max", "agent")).toBe(
      "model-opus-4.6",
    );
  });

  it("'auto' returns null (caller routes to the auto router)", () => {
    expect(resolveTierToProviderKey("auto", "ask")).toBeNull();
    expect(resolveTierToProviderKey("auto", "agent")).toBeNull();
  });

  it("hover-popup descriptions are present for every HackerAI tier", () => {
    const tiered = allOptions.filter((o) => o.label.startsWith("HackerAI"));
    expect(tiered.length).toBeGreaterThan(0);
    for (const option of tiered) {
      expect(option.description).toBeTruthy();
      expect(option.poweredBy).toBeTruthy();
    }
  });

  it("discloses the text and vision providers for Agent Standard", () => {
    expect(
      AGENT_MODEL_OPTIONS.find((option) => option.id === "hackerai-standard")
        ?.poweredBy,
    ).toBe("DeepSeek V4 Pro · MiniMax M3 for vision");
  });

  it("discloses Grok primary and GLM fallback for HackerAI Pro", () => {
    expect(
      ASK_MODEL_OPTIONS.find((option) => option.id === "hackerai-pro")
        ?.poweredBy,
    ).toBe("xAI Grok 4.5 · Z.ai GLM 5.2 fallback");
    expect(
      AGENT_MODEL_OPTIONS.find((option) => option.id === "hackerai-pro")
        ?.poweredBy,
    ).toBe("xAI Grok 4.5 · Z.ai GLM 5.2 fallback");
  });
});
