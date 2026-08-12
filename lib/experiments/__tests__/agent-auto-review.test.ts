import {
  AGENT_AUTO_REVIEW_EXPOSURE_EVENT,
  AGENT_AUTO_REVIEW_FEATURE_PROPERTY,
  AGENT_AUTO_REVIEW_FLAG_KEY,
  evaluateAgentAutoReviewFlag,
  resolveAgentAutoReviewPreviewAssignment,
} from "@/lib/experiments/agent-auto-review";

describe("Agent Auto review flag", () => {
  describe("preview assignment", () => {
    it("enables enforcement on every Vercel preview", () => {
      expect(
        resolveAgentAutoReviewPreviewAssignment({ VERCEL_ENV: "preview" }),
      ).toEqual({ key: AGENT_AUTO_REVIEW_FLAG_KEY, phase: "enforce" });
      expect(
        resolveAgentAutoReviewPreviewAssignment({ VERCEL_ENV: "production" }),
      ).toBeUndefined();
      expect(
        resolveAgentAutoReviewPreviewAssignment({ VERCEL_ENV: "development" }),
      ).toBeUndefined();
    });

    it("does not require PostHog for a preview assignment", async () => {
      const previousVercelEnv = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "preview";

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
      }
    });

    it("does not call PostHog when resolving preview availability", async () => {
      const previousVercelEnv = process.env.VERCEL_ENV;
      process.env.VERCEL_ENV = "preview";
      const posthog = {
        evaluateFlags: jest.fn(),
        capture: jest.fn(() => {
          throw new Error("capture unavailable");
        }),
      };

      try {
        await expect(
          evaluateAgentAutoReviewFlag({
            posthog: posthog as never,
            userId: "development-user",
            captureExposure: true,
          }),
        ).resolves.toEqual({
          key: AGENT_AUTO_REVIEW_FLAG_KEY,
          phase: "enforce",
        });
        expect(posthog.evaluateFlags).not.toHaveBeenCalled();
        expect(posthog.capture).not.toHaveBeenCalled();
      } finally {
        if (previousVercelEnv === undefined) {
          delete process.env.VERCEL_ENV;
        } else {
          process.env.VERCEL_ENV = previousVercelEnv;
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
