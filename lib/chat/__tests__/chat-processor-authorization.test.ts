import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { UIMessage } from "ai";

const mockGenerateText = jest.fn();

// Moderation now runs as a structured-output completion through OpenRouter, so
// only `generateText` is stubbed; the rest of the AI SDK stays real because
// chat-processor depends on it.
jest.mock("ai", () => ({
  ...(jest.requireActual("ai") as object),
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

const moderationScores = (overrides: Record<string, number> = {}) => ({
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

const { processChatMessages } =
  require("../chat-processor") as typeof import("../chat-processor");

const makeMessage = (text: string): UIMessage => ({
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text }],
});

describe("processChatMessages authorization metadata", () => {
  const originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    mockGenerateText.mockReset();
  });

  afterEach(() => {
    process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  });

  it("returns the authorization decision without changing provider-ready UI messages", async () => {
    mockGenerateText.mockResolvedValue({
      output: { category_scores: moderationScores({ illicit: 0.5 }) },
    });
    const messages = [
      makeMessage("Verifica la sicurezza della mia API autorizzata"),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));

    const result = await processChatMessages({
      messages,
      mode: "ask",
      userId: "user-1",
      subscription: "pro",
    });

    expect(result.platformAuthorized).toBe(true);
    expect(result.processedMessages).toEqual(snapshot);
    expect(messages).toEqual(snapshot);
    expect(JSON.stringify(result.processedMessages)).not.toContain(
      "<platform_authorization>",
    );
  });

  it("returns no provider authorization when moderation does not allow it", async () => {
    mockGenerateText.mockResolvedValue({
      output: { category_scores: moderationScores() },
    });

    const result = await processChatMessages({
      messages: [makeMessage("Explain this ordinary application behavior")],
      mode: "agent",
      userId: "user-1",
      subscription: "pro",
    });

    expect(result.platformAuthorized).toBe(false);
    expect(JSON.stringify(result.processedMessages)).not.toContain(
      "<platform_authorization>",
    );
  });
});
