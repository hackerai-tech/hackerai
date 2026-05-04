import { describe, it, expect } from "@jest/globals";
import { ASK_MODEL_OPTIONS, AGENT_MODEL_OPTIONS } from "../constants";
import { myProvider } from "@/lib/ai/providers";

/**
 * Drift guard: every selectable model option must have a corresponding
 * `model-{id}` entry registered with the provider. Without this, picking
 * the option from the UI would crash on `myProvider.languageModel()`.
 */
describe("ModelSelector option ↔ provider drift", () => {
  const allOptions = [...ASK_MODEL_OPTIONS, ...AGENT_MODEL_OPTIONS];

  it.each(allOptions.map((o) => [o.id, o.label]))(
    "option %s (%s) has a registered provider",
    (id) => {
      // languageModel throws (NoSuchModelError) for unregistered ids.
      expect(() => myProvider.languageModel(`model-${id}`)).not.toThrow();
    },
  );

  it("every option has a stable id and label", () => {
    for (const option of allOptions) {
      expect(option.id).toBeTruthy();
      expect(option.label).toBeTruthy();
    }
  });

  it("HackerAI tier labels map to expected underlying models", () => {
    const askLite = ASK_MODEL_OPTIONS.find((o) => o.label === "HackerAI Lite");
    const askPro = ASK_MODEL_OPTIONS.find((o) => o.label === "HackerAI Pro");
    const askMax = ASK_MODEL_OPTIONS.find((o) => o.label === "HackerAI Max");
    const agentLite = AGENT_MODEL_OPTIONS.find(
      (o) => o.label === "HackerAI Lite",
    );
    const agentPro = AGENT_MODEL_OPTIONS.find(
      (o) => o.label === "HackerAI Pro",
    );
    const agentMax = AGENT_MODEL_OPTIONS.find(
      (o) => o.label === "HackerAI Max",
    );

    expect(askLite?.id).toBe("gemini-3-flash");
    expect(askPro?.id).toBe("sonnet-4.6");
    expect(askMax?.id).toBe("opus-4.6");
    expect(agentLite?.id).toBe("kimi-k2.6");
    expect(agentPro?.id).toBe("sonnet-4.6");
    expect(agentMax?.id).toBe("opus-4.6");
  });

  it("hover-popup descriptions are present for every HackerAI tier", () => {
    const tiered = allOptions.filter((o) => o.label.startsWith("HackerAI"));
    expect(tiered.length).toBeGreaterThan(0);
    for (const option of tiered) {
      expect(option.description).toBeTruthy();
      expect(option.poweredBy).toBeTruthy();
    }
  });
});
