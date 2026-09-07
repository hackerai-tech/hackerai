import {
  ABLITERATION_MAX_GENERATION_STEPS,
  resolveAbliterationModelForGenerationStep,
} from "../abliterated-model-steps";

describe("resolveAbliterationModelForGenerationStep", () => {
  it.each([0])(
    "uses Abliteration for generation step index %i",
    (stepIndex) => {
      expect(
        resolveAbliterationModelForGenerationStep({
          treatmentModel: "abliteration",
          baselineModel: "openrouter",
          stepIndex,
        }),
      ).toBe("abliteration");
    },
  );

  it.each([ABLITERATION_MAX_GENERATION_STEPS, 2, 3, 499])(
    "uses OpenRouter for generation step index %i",
    (stepIndex) => {
      expect(
        resolveAbliterationModelForGenerationStep({
          treatmentModel: "abliteration",
          baselineModel: "openrouter",
          stepIndex,
        }),
      ).toBe("openrouter");
    },
  );

  it.each([-1, 1.5, Number.NaN])(
    "fails closed for invalid generation step index %s",
    (stepIndex) => {
      expect(
        resolveAbliterationModelForGenerationStep({
          treatmentModel: "abliteration",
          baselineModel: "openrouter",
          stepIndex,
        }),
      ).toBe("openrouter");
    },
  );
});
