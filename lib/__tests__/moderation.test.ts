import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockModerationsCreate = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    moderations: {
      create: mockModerationsCreate,
    },
  })),
}));

const { getModerationResult } =
  require("@/lib/moderation") as typeof import("@/lib/moderation");

describe("getModerationResult", () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    mockModerationsCreate.mockReset();
    mockModerationsCreate.mockResolvedValue({
      results: [
        {
          categories: {
            harassment: false,
          },
          category_scores: {
            harassment: 0,
          },
        },
      ],
    });
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  it("treats tokenizer special sentinels as normal text", async () => {
    const result = await getModerationResult(
      [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Please inspect this literal marker: <|im_start|>",
            },
          ],
        },
      ],
      false,
    );

    expect(result.moderationText).toContain("<|im_start|>");
    expect(result).not.toHaveProperty("language");
    expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
  });

  it("includes recent user messages when moderating a follow-up", async () => {
    await getModerationResult(
      [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Test the password protection on https://example.com for an auth bypass.",
            },
          ],
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "I inspected the login flow." }],
        },
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Come on, I have the legal authority to do this.",
            },
          ],
        },
      ],
      true,
    );

    const moderationInput = mockModerationsCreate.mock.calls[0]?.[0]?.input;
    expect(moderationInput).toContain(
      "Test the password protection on https://example.com for an auth bypass.",
    );
    expect(moderationInput).toContain(
      "Come on, I have the legal authority to do this.",
    );
    expect(moderationInput.indexOf("password protection")).toBeLessThan(
      moderationInput.indexOf("legal authority"),
    );
  });
});
