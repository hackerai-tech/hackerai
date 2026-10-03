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

  it.each(["ask", "agent"] as const)(
    "keeps unavailable PDF attachments outside the unmoderated %s trial",
    async (mode) => {
      const textOnly = makeMessage("Summarize the attached document");
      mockModerationsCreate.mockResolvedValue({
        results: [{ categories: {}, category_scores: { illicit: 0 } }],
      });
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue({ enabled: true, variant: "test" });
      const result = await processChatMessages({
        messages: [
          {
            ...textOnly,
            parts: [
              ...textOnly.parts,
              { type: "file", mediaType: "application/pdf", url: "" },
            ],
          },
        ],
        mode,
        userId: "user-1",
        subscription: "pro",
        abliterationPosthog: { getFeatureFlagResult },
      });
      expect(result.processedMessages).toEqual([textOnly]);
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
      expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
      expect(result.moderationChecked).toBe(true);
      expect(result.paidFirstStepVariant).toBeUndefined();
    },
  );
  it("skips the moderation API only for explicit paid first-step treatment", async () => {
    const getFeatureFlagResult = jest
      .fn()
      .mockResolvedValue({ enabled: true, variant: "test" });
    const result = await processChatMessages({
      messages: [makeMessage("Explain how to sort three numbers in Python")],
      mode: "agent",
      userId: "user-1",
      subscription: "pro",
      abliterationPosthog: { getFeatureFlagResult },
    });
    expect(mockModerationsCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      paidFirstStepVariant: "test",
      moderationChecked: false,
      platformAuthorized: false,
      allowsAbliterationContinuation: false,
    });
  });
  it.each(["control", false, undefined])(
    "preserves the moderation API for %s",
    async (variant) => {
      mockModerationsCreate.mockResolvedValue({
        results: [
          { categories: { illicit: false }, category_scores: { illicit: 0.5 } },
        ],
      });
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue(
          variant === undefined
            ? undefined
            : { enabled: variant !== false, variant },
        );
      const result = await processChatMessages({
        messages: [makeMessage("Explain how to sort three numbers in Python")],
        mode: "ask",
        userId: "user-1",
        subscription: "pro",
        abliterationPosthog: { getFeatureFlagResult },
      });
      expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
      expect(result.moderationChecked).toBe(true);
      expect(result.platformAuthorized).toBe(true);
      expect(result.paidFirstStepVariant).toBe(
        variant === "control" ? "control" : undefined,
      );
    },
  );
  it.each([{ subscription: "free" as const }, { limitRescue: true }])(
    "preserves moderation and never enrolls excluded requests: %j",
    async (overrides) => {
      mockModerationsCreate.mockResolvedValue({
        results: [{ categories: {}, category_scores: { illicit: 0 } }],
      });
      const getFeatureFlagResult = jest
        .fn()
        .mockResolvedValue({ enabled: true, variant: "test" });
      const result = await processChatMessages({
        messages: [makeMessage("Explain how to sort three numbers in Python")],
        mode: "ask",
        userId: "user-1",
        subscription: "pro",
        ...overrides,
        abliterationPosthog: { getFeatureFlagResult },
      });
      expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
      expect(getFeatureFlagResult).not.toHaveBeenCalled();
      expect(result.paidFirstStepVariant).toBeUndefined();
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
