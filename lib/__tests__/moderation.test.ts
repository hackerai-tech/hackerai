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
  const request = [
    {
      role: "user",
      parts: [
        { type: "text", text: "Continue the authorized security assessment." },
      ],
    },
  ];
  it.each([false, true])(
    "uses the 0.05 threshold when isPaidUser is %s",
    async (isPaidUser) => {
      for (const [score, expected] of [
        [0.049, false],
        [0.05, true],
        [0.075, true],
        [0.1, true],
      ] as const) {
        mockModerationsCreate.mockResolvedValue({
          results: [
            {
              categories: { illicit: false },
              category_scores: { illicit: score },
            },
          ],
        });
        expect(
          (await getModerationResult(request, isPaidUser))
            .shouldUncensorResponse,
        ).toBe(expected);
      }
    },
  );
  it.each([
    {
      score: 0.01,
      category: "illicit",
      flagged: false,
      independent: false,
    },
    {
      score: 0.2,
      category: "illicit",
      flagged: true,
      independent: true,
    },
    {
      score: 0.99,
      category: "illicit",
      flagged: true,
      independent: false,
    },
    {
      score: 0.075,
      category: "sexual/minors",
      flagged: true,
      independent: false,
    },
    {
      score: NaN,
      category: "illicit",
      flagged: false,
      independent: false,
    },
  ])(
    "applies the normal threshold and category restrictions: %j",
    async ({ score, category, flagged, independent }) => {
      mockModerationsCreate.mockResolvedValue({
        results: [
          {
            categories: { [category]: flagged },
            category_scores: { [category]: score },
          },
        ],
      });
      expect(await getModerationResult(request, true)).toMatchObject({
        shouldUncensorResponse: independent,
      });
      expect(mockModerationsCreate).toHaveBeenCalledTimes(1);
    },
  );
  it("does not authorize routing on API failure, missing scores or missing credentials", async () => {
    mockModerationsCreate.mockRejectedValueOnce(new Error("offline"));
    expect(
      (await getModerationResult(request, true)).shouldUncensorResponse,
    ).toBe(false);
    mockModerationsCreate.mockResolvedValueOnce({
      results: [{ categories: {}, category_scores: {} }],
    });
    expect(
      (await getModerationResult(request, true)).shouldUncensorResponse,
    ).toBe(false);
    delete process.env.OPENAI_API_KEY;
    expect(
      (await getModerationResult(request, true)).shouldUncensorResponse,
    ).toBe(false);
  });
  it.each(["illicit", "illicit/violent"])(
    "excludes flagged %s intent from Free treatment without changing paid routing",
    async (category) => {
      mockModerationsCreate.mockResolvedValue({
        results: [
          {
            categories: {
              illicit: false,
              "illicit/violent": false,
              [category]: true,
            },
            category_scores: { illicit: 0.9 },
          },
        ],
      });
      expect(await getModerationResult(request, false)).toMatchObject({
        shouldUncensorResponse: true,
        allowsFreeAbliteration: false,
      });
      expect(await getModerationResult(request, true)).toMatchObject({
        shouldUncensorResponse: true,
      });
    },
  );
  it("keeps legitimate eligible security tasks and requires known illicit-category results", async () => {
    mockModerationsCreate.mockResolvedValue({
      results: [
        {
          categories: { illicit: false, "illicit/violent": false },
          category_scores: { illicit: 0.15 },
        },
      ],
    });
    expect(await getModerationResult(request, false)).toHaveProperty(
      "allowsFreeAbliteration",
      true,
    );
    mockModerationsCreate.mockResolvedValue({
      results: [
        {
          categories: {},
          category_scores: { illicit: 0.15 },
        },
      ],
    });
    expect(await getModerationResult(request, false)).toHaveProperty(
      "allowsFreeAbliteration",
      false,
    );
  });
});
