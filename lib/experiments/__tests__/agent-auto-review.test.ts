import {
  AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
  AGENT_AUTO_REVIEW_FEATURE_PROPERTY,
  AGENT_AUTO_REVIEW_FLAG_KEY,
  evaluateAgentAutoReviewFlag,
  resolveAgentAutoReviewPreviewAssignment,
} from "@/lib/experiments/agent-auto-review";

describe("Agent Auto review flag", () => {
  describe("preview assignment", () => {
    it.each(["shadow", "enforce"] as const)(
      "accepts an explicit %s override only on Vercel previews",
      (phase) => {
        expect(
          resolveAgentAutoReviewPreviewAssignment({
            VERCEL_ENV: "preview",
            AGENT_AUTO_REVIEW_PREVIEW_PHASE: phase,
          }),
        ).toEqual({ key: AGENT_AUTO_REVIEW_FLAG_KEY, phase });
        expect(
          resolveAgentAutoReviewPreviewAssignment({
            VERCEL_ENV: "production",
            AGENT_AUTO_REVIEW_PREVIEW_PHASE: phase,
          }),
        ).toBeUndefined();
      },
    );

    it.each([undefined, "", "approve", "true"])(
      "fails closed for a malformed preview override: %p",
      (phase) => {
        expect(
          resolveAgentAutoReviewPreviewAssignment({
            VERCEL_ENV: "preview",
            AGENT_AUTO_REVIEW_PREVIEW_PHASE: phase,
          }),
        ).toBeUndefined();
      },
    );

    it("does not require PostHog for an explicit preview assignment", async () => {
      const previousVercelEnv = process.env.VERCEL_ENV;
      const previousPreviewPhase = process.env.AGENT_AUTO_REVIEW_PREVIEW_PHASE;
      process.env.VERCEL_ENV = "preview";
      process.env.AGENT_AUTO_REVIEW_PREVIEW_PHASE = "enforce";

      try {
        await expect(
          evaluateAgentAutoReviewFlag({
            posthog: null,
            userId: "development-user",
          }),
        ).resolves.toEqual({
          key: AGENT_AUTO_REVIEW_FLAG_KEY,
          phase: "enforce",
        });
      } finally {
        if (previousVercelEnv === undefined) {
          delete process.env.VERCEL_ENV;
        } else {
          process.env.VERCEL_ENV = previousVercelEnv;
        }
        if (previousPreviewPhase === undefined) {
          delete process.env.AGENT_AUTO_REVIEW_PREVIEW_PHASE;
        } else {
          process.env.AGENT_AUTO_REVIEW_PREVIEW_PHASE = previousPreviewPhase;
        }
      }
    });
  });

  it.each(["shadow", "enforce"] as const)(
    "accepts the %s rollout phase and captures privacy-safe exposure",
    async (phase) => {
      const posthog = {
        evaluateFlags: jest.fn(async () => ({
          getFlag: jest.fn(() => phase),
        })),
        capture: jest.fn(),
      };

      await expect(
        evaluateAgentAutoReviewFlag({
          posthog: posthog as never,
          userId: "user-1",
          captureExposure: true,
        }),
      ).resolves.toEqual({ key: AGENT_AUTO_REVIEW_FLAG_KEY, phase });
      expect(posthog.capture).toHaveBeenCalledWith({
        distinctId: "user-1",
        event: AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
        properties: {
          rollout_phase: phase,
          surface: "agent_permission_selector",
          [AGENT_AUTO_REVIEW_FEATURE_PROPERTY]: phase,
          $process_person_profile: false,
        },
      });
    },
  );

  it.each([false, true, "control", undefined])(
    "fails closed for an unsupported assignment: %p",
    async (value) => {
      const posthog = {
        evaluateFlags: jest.fn(async () => ({ getFlag: () => value })),
        capture: jest.fn(),
      };
      await expect(
        evaluateAgentAutoReviewFlag({
          posthog: posthog as never,
          userId: "user-1",
        }),
      ).resolves.toBeUndefined();
      expect(posthog.capture).not.toHaveBeenCalled();
    },
  );
});
