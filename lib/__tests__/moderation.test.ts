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
    expect(result.language).toBe("en");
    expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
  });

  it("detects the moderation language from the scored user text", async () => {
    const result = await getModerationResult(
      [
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Tengo permiso y estoy autorizado para realizar esta prueba de penetración en mi sistema.",
            },
          ],
        },
      ],
      true,
    );

    expect(result.language).toBe("es");
    expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
  });
});
