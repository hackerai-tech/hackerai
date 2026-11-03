import {
  evaluateAbliteratedModel,
  ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
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
const originalInferenceKey = process.env.INFERENCE_API_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.ABLITERATION_API_KEY = "test-only";
  process.env.INFERENCE_API_KEY = "test-only";
});
afterAll(() => {
  if (originalInferenceKey === undefined) delete process.env.INFERENCE_API_KEY;
  else process.env.INFERENCE_API_KEY = originalInferenceKey;
  if (originalKey === undefined) delete process.env.ABLITERATION_API_KEY;
  else process.env.ABLITERATION_API_KEY = originalKey;
});

describe.each(["ask", "agent"] as const)(
  "Free %s three-step default",
  (mode) => {
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

    it("uses the shipped route for three generations, then the actual Free baseline", async () => {
      const input = args();
      const assignment = await evaluateAbliteratedModel(input);
      expect(assignment).toMatchObject({
        key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
        variant: "test",
        modelKey: "model-abliterated",
        baselineModel: input.selectedModel,
        generationStepLimit: 3,
        inferenceCyberEnabled: false,
      });
      expect(myProvider.languageModel(assignment!.baselineModel).modelId).toBe(
        "z-ai/glm-5.3-flash",
      );
      expect(
        Array.from({ length: 5 }, (_, stepIndex) =>
          resolveAbliterationModelForGenerationStep({
            treatmentModel: assignment!.modelKey,
            baselineModel: assignment!.baselineModel,
            generationStepLimit: assignment!.generationStepLimit,
            stepIndex,
          }),
        ),
      ).toEqual([
        "model-abliterated",
        "model-abliterated",
        "model-abliterated",
        input.selectedModel,
        input.selectedModel,
      ]);
      expect(flag).not.toHaveBeenCalled();
    });

    it.each(["preview", "production"] as const)(
      "uses Inference for eligible %s requests independently of the retired experiment",
      async (inferenceEnvironment) => {
        flag.mockResolvedValueOnce(true);
        const input = { ...args(), inferenceEnvironment };
        const assignment = await evaluateAbliteratedModel(input);
        expect(assignment).toMatchObject({
          key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
          variant: "test",
          modelKey: "model-abliterated",
          baselineModel: input.selectedModel,
          generationStepLimit: 3,
          inferenceCyberEnabled: true,
        });
        expect(flag.mock.calls.map((call) => call[1])).toEqual([
          "inference_cyber_v1",
        ]);
      },
    );
    it.each([false, undefined, "test"])(
      "retains Abliteration recovery policy when Inference assignment is %s",
      async (value) => {
        flag.mockResolvedValueOnce(value);
        expect(
          await evaluateAbliteratedModel({
            ...args(),
            inferenceEnvironment: "production",
          }),
        ).toMatchObject({ variant: "test", inferenceCyberEnabled: false });
      },
    );
    it("retains enrolled Free treatment when the Inference lookup fails", async () => {
      flag.mockRejectedValueOnce(new Error("unavailable"));
      expect(
        await evaluateAbliteratedModel({
          ...args(),
          inferenceEnvironment: "production",
        }),
      ).toMatchObject({
        key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
        variant: "test",
        inferenceCyberEnabled: false,
      });
    });
    it.each([null, undefined])(
      "keeps the default without analytics (%s)",
      async (posthog) => {
        expect(
          await evaluateAbliteratedModel({
            ...args(),
            posthog,
            inferenceEnvironment: "production",
          }),
        ).toMatchObject({
          key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
          variant: "test",
          inferenceCyberEnabled: false,
        });
        expect(flag).not.toHaveBeenCalled();
      },
    );

    it.each(["control", false, undefined, "unexpected"])(
      "does not consult the retired Free allocation (%s)",
      async (value) => {
        flag.mockResolvedValue(value);
        expect(await evaluateAbliteratedModel(args())).toMatchObject({
          key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
          variant: "test",
          modelKey: "model-abliterated",
          generationStepLimit: 3,
        });
        expect(flag).not.toHaveBeenCalled();
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

    it("keeps the baseline when the fallback provider is not configured", async () => {
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
        key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
        modelKey: "model-abliterated",
      });
    });
  },
);
