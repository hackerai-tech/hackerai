/**
 * Tests for buildProviderOptions fallback-chain resolution.
 *
 * Verifies that MODEL_FALLBACK_CHAIN entries (declared as registry keys) are
 * resolved to OpenRouter slugs via myProvider.languageModel(...).modelId, and
 * that the function fails closed (no fallback, no throw) for unknown keys.
 */

import { buildProviderOptions } from "@/lib/api/chat-stream-helpers";

jest.mock("@/lib/db/actions", () => ({
  getNotes: jest.fn(),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Slugs the test asserts against. These match the registry in lib/ai/providers.ts.
// If the registry slug for a model changes, update both places intentionally.
const KIMI_SLUG = "moonshotai/kimi-k2.6:exacto";
const GEMINI_SLUG = "google/gemini-3-flash-preview";

describe("buildProviderOptions fallback chain", () => {
  it("resolves Opus 4.6 ask chain to Gemini slug", () => {
    const opts = buildProviderOptions(false, "user-1", "model-opus-4.6", "ask");
    expect(opts.openrouter).toMatchObject({
      models: [GEMINI_SLUG],
      user: "user-1",
    });
  });

  it("resolves Opus 4.6 agent chain to Kimi slug", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
      user: "user-1",
    });
  });

  it("resolves Sonnet 4.6 ask chain to Gemini slug", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "ask",
    );
    expect(opts.openrouter).toMatchObject({
      models: [GEMINI_SLUG],
      user: "user-1",
    });
  });

  it("resolves Sonnet 4.6 agent chain to Kimi slug", () => {
    const opts = buildProviderOptions(
      false,
      "user-1",
      "model-sonnet-4.6",
      "agent",
    );
    expect(opts.openrouter).toMatchObject({
      models: [KIMI_SLUG],
      user: "user-1",
    });
  });

  it("keeps fallback for free auto agent model", () => {
    const opts = buildProviderOptions(false, "user-1", "agent-model-free");
    expect(opts.openrouter).toMatchObject({
      models: ["x-ai/grok-4.3"],
      user: "user-1",
    });
  });

  it("emits no `models` field for a model without a chain entry", () => {
    const opts = buildProviderOptions(false, "user-1", "model-gemini-3-flash");
    expect(opts.openrouter).not.toHaveProperty("models");
  });

  it("does not throw for an unknown registry key — no chain, no slug", () => {
    expect(() =>
      buildProviderOptions(false, "user-1", "model-does-not-exist"),
    ).not.toThrow();
    const opts = buildProviderOptions(false, "user-1", "model-does-not-exist");
    expect(opts.openrouter).not.toHaveProperty("models");
  });

  it("emits no `models` field when modelName is omitted", () => {
    const opts = buildProviderOptions(false, "user-1");
    expect(opts.openrouter).not.toHaveProperty("models");
  });

  it("includes reasoning settings independent of fallback chain", () => {
    const reasoning = buildProviderOptions(
      true,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(reasoning.openrouter).toMatchObject({
      reasoning: { enabled: true },
      models: [KIMI_SLUG],
    });

    const noReasoning = buildProviderOptions(
      false,
      "user-1",
      "model-opus-4.6",
      "agent",
    );
    expect(noReasoning.openrouter).toMatchObject({
      reasoning: { enabled: false },
      models: [KIMI_SLUG],
    });
  });
});
