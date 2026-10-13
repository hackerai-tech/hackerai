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
  const originalAbliterationKey = process.env.ABLITERATION_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.ABLITERATION_API_KEY = "test-only-key";
    mockModerationsCreate.mockReset();
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    if (originalAbliterationKey === undefined)
      delete process.env.ABLITERATION_API_KEY;
    else process.env.ABLITERATION_API_KEY = originalAbliterationKey;
  });

  it.each([
    { mode: "ask", subscription: "free" },
    { mode: "ask", subscription: "pro" },
    { mode: "agent", subscription: "free" },
    { mode: "agent", subscription: "pro" },
  ] as const)(
    "authorizes a score of 0.05 for $subscription users in $mode mode",
    async ({ mode, subscription }) => {
      mockModerationsCreate.mockResolvedValue({
        results: [
          {
            categories: { illicit: false },
            category_scores: { illicit: 0.05 },
          },
        ],
      });

      const result = await processChatMessages({
        messages: [makeMessage("Continue the authorized security assessment")],
        mode,
        userId: "user-1",
        subscription,
      });

      expect(result.platformAuthorized).toBe(true);
    },
  );

  it.each(["ask", "agent"] as const)(
    "always moderates %s despite a stale paid treatment flag",
    async (mode) => {
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue({ enabled: true, variant: "test" });
      const legacyInput = { abliterationPosthog: { getFeatureFlagResult } };
      for (const subscription of [
        "pro",
        "pro-plus",
        "ultra",
        "team",
      ] as const) {
        mockModerationsCreate.mockResolvedValue({
          results: [{ categories: {}, category_scores: { illicit: 0 } }],
        });
        const result = await processChatMessages({
          ...legacyInput,
          messages: [
            makeMessage("Explain how to sort three numbers in Python"),
          ],
          mode,
          userId: "user-1",
          subscription,
        });
        expect(result).toMatchObject({
          moderationChecked: true,
          platformAuthorized: false,
          allowsAbliterationContinuation: true,
        });
      }
      expect(mockModerationsCreate).toHaveBeenCalledTimes(4);
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
    },
  );

  it.each(["ask", "agent"] as const)(
    "moderates %s after dropping an unavailable PDF attachment",
    async (mode) => {
      const textOnly = makeMessage("Summarize the attached document");
      mockModerationsCreate.mockResolvedValue({
        results: [{ categories: {}, category_scores: { illicit: 0 } }],
      });
      const result = await processChatMessages({
        messages: [
          {
            ...textOnly,
            parts: [
              ...textOnly.parts,
              {
                type: "file",
                mediaType: "application/pdf",
                url: "",
              },
            ],
          },
        ],
        mode,
        userId: "user-1",
        subscription: "pro",
      });
      expect(result.processedMessages).toEqual([textOnly]);
      expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
      expect(result.moderationChecked).toBe(true);
    },
  );

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
