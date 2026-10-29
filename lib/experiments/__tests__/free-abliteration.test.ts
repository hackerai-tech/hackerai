import {
  evaluateAbliteratedModel,
  ABLITERATED_FREE_THREE_STEPS_KEY,
} from "../abliterated-model";
import { resolveAbliterationModelForGenerationStep } from "../abliterated-model-steps";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { selectModel } from "@/lib/chat/chat-processor";
import { myProvider } from "@/lib/ai/providers";

jest.mock("@/lib/posthog/flag-assignment", () => ({
  getPostHogFlagWithoutExposure: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { info: jest.fn() } }));

const flag = jest.mocked(getPostHogFlagWithoutExposure);
const posthog = { getFeatureFlagResult: jest.fn() };
const messages = [
  {
    id: "u",
    role: "user" as const,
    parts: [{ type: "text" as const, text: "synthetic authorized test" }],
  },
];
const originalKey = process.env.ABLITERATION_API_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ABLITERATION_API_KEY = "test-only";
});
afterAll(() => {
  if (originalKey === undefined) delete process.env.ABLITERATION_API_KEY;
  else process.env.ABLITERATION_API_KEY = originalKey;
});

describe.each(["ask", "agent"] as const)("Free %s three-step trial", (mode) => {
  const args = () => ({
    posthog,
    userId: "free-user",
    subscription: "free" as const,
    mode,
    selectedModel: selectModel(mode, "free"),
    moderationEligible: true,
    moderationChecked: true,
    allowsFreeAbliteration: true,
    newUserTurn: true,
    messages,
  });

  it.each(["control", "test"] as const)(
    "keeps the actual Free baseline for %s and steps after three",
    async (variant) => {
      flag.mockResolvedValue(variant);
      const input = args();
      const assignment = await evaluateAbliteratedModel(input);
      expect(assignment).toMatchObject({
        key: ABLITERATED_FREE_THREE_STEPS_KEY,
        variant,
        baselineModel: input.selectedModel,
        generationStepLimit: 3,
        inferenceCyberEnabled: false,
      });
      expect(myProvider.languageModel(assignment!.baselineModel).modelId).toBe(
        "z-ai/glm-5.3-flash",
      );
      const models = Array.from({ length: 5 }, (_, stepIndex) =>
        resolveAbliterationModelForGenerationStep({
          treatmentModel: assignment!.modelKey,
          baselineModel: assignment!.baselineModel,
          generationStepLimit: assignment!.generationStepLimit,
          stepIndex,
        }),
      );
      expect(models).toEqual(
        variant === "test"
          ? [
              "model-abliterated",
              "model-abliterated",
              "model-abliterated",
              input.selectedModel,
              input.selectedModel,
            ]
          : Array(5).fill(input.selectedModel),
      );
      expect(flag).toHaveBeenCalledTimes(1);
      expect(flag).toHaveBeenCalledWith(
        posthog,
        ABLITERATED_FREE_THREE_STEPS_KEY,
        "free-user",
        {
          subscription: "free",
          subscription_tier: "free",
        },
      );
    },
  );

  it.each([undefined, false, true, "unexpected"])(
    "does not enroll an absent/off/invalid flag (%s)",
    async (value) => {
      flag.mockResolvedValue(value);
      expect(await evaluateAbliteratedModel(args())).toBeUndefined();
    },
  );

  it.each([
    { limitRescue: true },
    { newUserTurn: false },
    { moderationChecked: false },
    { moderationEligible: false },
    { allowsFreeAbliteration: false },
    { allowsFreeAbliteration: undefined },
    { userId: "" },
    { messages: [] },
    {
      messages: [
        {
          id: "pdf",
          role: "user" as const,
          parts: [
            {
              type: "file" as const,
              mediaType: "application/pdf",
              url: "https://example.test/fixture.pdf",
            },
          ],
        },
      ],
    },
  ])(
    "preserves application gates without evaluating assignment (%j)",
    async (overrides) => {
      flag.mockResolvedValue("test");
      expect(
        await evaluateAbliteratedModel({ ...args(), ...overrides }),
      ).toBeUndefined();
      expect(flag).not.toHaveBeenCalled();
    },
  );

  it("fails closed for assignment errors and a missing provider key", async () => {
    flag.mockRejectedValueOnce(new Error("unavailable"));
    expect(await evaluateAbliteratedModel(args())).toBeUndefined();
    delete process.env.ABLITERATION_API_KEY;
    flag.mockClear();
    expect(await evaluateAbliteratedModel(args())).toBeUndefined();
    expect(flag).not.toHaveBeenCalled();
  });

  it("keeps image uploads eligible for existing native/conversion preparation", async () => {
    flag.mockResolvedValue("test");
    const image = {
      type: "file" as const,
      mediaType: "image/png",
      url: "https://example.test/fixture.png",
    };
    expect(
      await evaluateAbliteratedModel({
        ...args(),
        messages: [{ ...messages[0], parts: [image] }],
      }),
    ).toMatchObject({
      key: ABLITERATED_FREE_THREE_STEPS_KEY,
      modelKey: "model-abliterated",
    });
  });
});
