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
const originalInferenceKey = process.env.INFERENCE_API_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.INFERENCE_API_KEY = "test-only";
  flag.mockResolvedValue(true);
});
afterAll(() => {
  if (originalInferenceKey === undefined) delete process.env.INFERENCE_API_KEY;
  else process.env.INFERENCE_API_KEY = originalInferenceKey;
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
      inferenceEnvironment: "production" as const,
      messages,
    });

    it("uses Inference for three generations, then the actual Free baseline", async () => {
      const input = args();
      const assignment = await evaluateAbliteratedModel(input);
      expect(assignment).toMatchObject({
        key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
        variant: "test",
        modelKey: "model-inference-cyber",
        baselineModel: input.selectedModel,
        generationStepLimit: 3,
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
        "model-inference-cyber",
        "model-inference-cyber",
        "model-inference-cyber",
        input.selectedModel,
        input.selectedModel,
      ]);
    });

    it.each(["preview", "production"] as const)(
      "consults only the Inference rollout for eligible %s requests",
      async (inferenceEnvironment) => {
        const input = { ...args(), inferenceEnvironment };
        expect(await evaluateAbliteratedModel(input)).toMatchObject({
          key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
          modelKey: "model-inference-cyber",
        });
        expect(flag.mock.calls.map((call) => call[1])).toEqual([
          "inference_cyber_v1",
        ]);
      },
    );
    it.each([false, undefined, "test"])(
      "keeps the Free baseline when the Inference rollout is %s",
      async (value) => {
        flag.mockResolvedValueOnce(value);
        expect(await evaluateAbliteratedModel(args())).toBeUndefined();
      },
    );
    it("keeps the Free baseline when the Inference lookup fails", async () => {
      flag.mockRejectedValueOnce(new Error("unavailable"));
      expect(await evaluateAbliteratedModel(args())).toBeUndefined();
    });
    it.each([null, undefined])(
      "keeps the Free baseline without analytics (%s)",
      async (posthog) => {
        expect(
          await evaluateAbliteratedModel({ ...args(), posthog }),
        ).toBeUndefined();
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
        expect(
          await evaluateAbliteratedModel({ ...args(), ...overrides }),
        ).toBeUndefined();
        expect(flag).not.toHaveBeenCalled();
      },
    );

    it("keeps the Free baseline when Inference is unconfigured or outside a deployed runtime", async () => {
      expect(
        await evaluateAbliteratedModel({
          ...args(),
          inferenceEnvironment: undefined,
        }),
      ).toBeUndefined();
      delete process.env.INFERENCE_API_KEY;
      expect(await evaluateAbliteratedModel(args())).toBeUndefined();
      expect(flag).not.toHaveBeenCalled();
    });

    it("keeps image uploads eligible for existing native/conversion preparation", async () => {
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
        modelKey: "model-inference-cyber",
      });
    });
  },
);
