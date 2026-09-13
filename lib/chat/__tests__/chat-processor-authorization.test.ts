import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import type { UIMessage } from "ai";

const mockModerationsCreate = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    moderations: {
      create: mockModerationsCreate,
    },
  })),
}));

const { processChatMessages } =
  require("../chat-processor") as typeof import("../chat-processor");

const makeMessage = (text: string): UIMessage => ({
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text }],
});

describe("processChatMessages authorization metadata", () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    mockModerationsCreate.mockReset();
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  it("returns the authorization decision without changing provider-ready UI messages", async () => {
    mockModerationsCreate.mockResolvedValue({
      results: [
        {
          categories: { illicit: true },
          category_scores: { illicit: 0.5 },
        },
      ],
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
    mockModerationsCreate.mockResolvedValue({
      results: [
        {
          categories: { illicit: false },
          category_scores: { illicit: 0 },
        },
      ],
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
