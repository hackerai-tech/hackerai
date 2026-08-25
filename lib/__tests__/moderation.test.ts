import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockGenerateText = jest.fn();

jest.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: {
    object: (config: unknown) => ({ type: "object", ...config }),
  },
}));

jest.mock("@/lib/ai/providers", () => ({
  myProvider: {
    languageModel: jest.fn((name: string) => ({ modelId: name })),
  },
}));

const { getModerationResult } =
  require("@/lib/moderation") as typeof import("@/lib/moderation");

const scoresWith = (overrides: Record<string, number> = {}) => ({
  harassment: 0,
  "harassment/threatening": 0,
  sexual: 0,
  "sexual/minors": 0,
  hate: 0,
  "hate/threatening": 0,
  illicit: 0,
  "illicit/violent": 0,
  "self-harm": 0,
  "self-harm/intent": 0,
  "self-harm/instructions": 0,
  violence: 0,
  "violence/graphic": 0,
  ...overrides,
});

const userMessage = (text: string) => ({
  role: "user",
  parts: [{ type: "text", text }],
});

describe("getModerationResult", () => {
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      output: { category_scores: scoresWith() },
    });
  });

  afterEach(() => {
    // Assigning `undefined` would coerce to the string "undefined", which is
    // truthy and would leak a fake key into every later test in this worker.
    if (originalOpenRouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
    }
  });

  it("treats tokenizer special sentinels as normal text", async () => {
    const result = await getModerationResult(
      [userMessage("Please inspect this literal marker: <|im_start|>")],
      false,
    );

    expect(result.moderationText).toContain("<|im_start|>");
    expect(result).not.toHaveProperty("language");
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("routes moderation through the OpenRouter moderation model", async () => {
    await getModerationResult(
      [userMessage("Explain this ordinary application behavior in detail")],
      false,
    );

    const call = mockGenerateText.mock.calls[0][0] as {
      model: { modelId: string };
    };
    expect(call.model.modelId).toBe("moderation-model");
  });

  it("uncensors mid-band illicit content that hits no forbidden category", async () => {
    mockGenerateText.mockResolvedValue({
      output: { category_scores: scoresWith({ illicit: 0.5 }) },
    });

    const result = await getModerationResult(
      [userMessage("How do I exploit this SQL injection on my own lab host?")],
      false,
    );

    expect(result.shouldUncensorResponse).toBe(true);
  });

  it("does not uncensor when a forbidden category is flagged", async () => {
    mockGenerateText.mockResolvedValue({
      output: { category_scores: scoresWith({ illicit: 0.5, violence: 0.8 }) },
    });

    const result = await getModerationResult(
      [userMessage("A message that also scores high on violence somehow")],
      false,
    );

    expect(result.shouldUncensorResponse).toBe(false);
  });

  it("does not uncensor benign content below the minimum level", async () => {
    const result = await getModerationResult(
      [userMessage("Explain this ordinary application behavior in detail")],
      false,
    );

    expect(result.shouldUncensorResponse).toBe(false);
  });

  it("fails closed when the moderation model errors", async () => {
    mockGenerateText.mockRejectedValue(new Error("upstream failure"));

    const result = await getModerationResult(
      [userMessage("Explain this ordinary application behavior in detail")],
      false,
    );

    expect(result).toEqual({
      shouldUncensorResponse: false,
      moderationText: "",
    });
  });

  it("skips the model call when OPENROUTER_API_KEY is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await getModerationResult(
      [userMessage("Explain this ordinary application behavior in detail")],
      false,
    );

    expect(result.shouldUncensorResponse).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
