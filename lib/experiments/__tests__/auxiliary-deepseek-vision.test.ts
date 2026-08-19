import {
  AUXILIARY_DEEPSEEK_VISION_EXPOSURE_EVENT,
  createAuxiliaryVisionExposureRecorder,
  evaluateAuxiliaryDeepSeekVisionFlag,
  isEligibleForAuxiliaryDeepSeekVision,
  resolveAuxiliaryDeepSeekVisionPreviewAssignment,
} from "@/lib/experiments/auxiliary-deepseek-vision";

describe("auxiliary DeepSeek vision flag", () => {
  it("limits treatment to paid non-Max routes", () => {
    expect(isEligibleForAuxiliaryDeepSeekVision({ subscription: "pro" })).toBe(
      true,
    );
    expect(
      isEligibleForAuxiliaryDeepSeekVision({
        subscription: "pro",
        selectedModelOverride: "hackerai-max",
      }),
    ).toBe(false);
    expect(isEligibleForAuxiliaryDeepSeekVision({ subscription: "free" })).toBe(
      false,
    );
  });

  it("enables preview deployments for PR validation", () => {
    expect(
      resolveAuxiliaryDeepSeekVisionPreviewAssignment({
        VERCEL_ENV: "preview",
      }),
    ).toEqual({ key: "auxiliary-deepseek-vision", variant: "test" });
  });

  it("accepts the boolean production flag without capturing exposure", async () => {
    const capture = jest.fn();
    const assignment = await evaluateAuxiliaryDeepSeekVisionFlag({
      posthog: {
        evaluateFlags: jest.fn(async () => ({
          getFlag: () => true,
        })),
      } as never,
      userId: "user-1",
      subscription: "pro",
      selectedModelOverride: "hackerai-standard",
    });

    expect(assignment).toEqual({
      key: "auxiliary-deepseek-vision",
      variant: "test",
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures exposure once, only after an image is sent", () => {
    const capture = jest.fn();
    const record = createAuxiliaryVisionExposureRecorder({
      posthog: { capture } as never,
      userId: "user-1",
      chatId: "chat-1",
      triggerRunId: "run-1",
      subscription: "pro",
      mode: "agent",
      selectedModelOverride: "hackerai-pro",
      getSelectedModel: () => "model-deepseek-v4-pro-0813",
      assignment: { key: "auxiliary-deepseek-vision", variant: "test" },
    });

    expect(capture).not.toHaveBeenCalled();
    record("file_view");
    record("attachment");

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: AUXILIARY_DEEPSEEK_VISION_EXPOSURE_EVENT,
      properties: expect.objectContaining({
        experiment_variant: "test",
        exposure_surface: "file_view",
        chat_id: "chat-1",
        trigger_run_id: "run-1",
        selected_model_override: "hackerai-pro",
        selected_model: "model-deepseek-v4-pro-0813",
        $process_person_profile: false,
      }),
    });
  });
});
