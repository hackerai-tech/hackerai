import { evaluatePaidFirstStepModel } from "../paid-first-step";
import { getPaidFirstStepEnrollment } from "../paid-first-step-enrollment";
import {
  hasAbliterationRoute,
  type AbliteratedAssignment,
} from "../abliterated-model";
import { getAbliterationHistoryEntry } from "../abliteration-history";
import { getExperimentAnalyticsProperties } from "@/lib/analytics/experiment-context";
import { resolveAbliterationModelForGenerationStep } from "../abliterated-model-steps";

jest.mock("../paid-first-step-enrollment", () => ({
  getPaidFirstStepEnrollment: jest.fn(),
}));
const enrollment = {
  _id: "enrollment",
  _creationTime: 1,
  user_id: "user",
  organization_id: "org",
  variant: "test",
  enrolled_at: 1,
  baseline_renewal_at: 1000,
  stripe_subscription_id: "sub",
  stripe_customer_id: "cus",
  billing_interval: "month",
  billing_interval_count: 1,
  subscription_started_at: 0,
  cancel_at_period_end: true,
  subscription_tier: "pro",
  subscription_status: "active",
};
const posthog = { getFeatureFlag: jest.fn(), capture: jest.fn() };
const args = {
  posthog,
  userId: "user",
  organizationId: "org",
  subscription: "pro" as const,
  mode: "agent" as const,
  selectedModel: "model-deepseek-v4-flash-0731",
  moderationEligible: false,
  safetyEligible: true,
  limitRescue: false,
  messages: [
    {
      id: "u",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "private content" }],
    },
  ],
};
const oldAssignment: AbliteratedAssignment = {
  key: "abliterated_paid_moderated_v1",
  variant: "test",
  modelKey: "model-abliterated-large-v2",
  baselineModel: args.selectedModel,
  selectionSource: "moderation",
};

describe("paid first-step expansion", () => {
  const originalKey = process.env.ABLITERATION_API_KEY;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.ABLITERATION_API_KEY = "test";
    posthog.getFeatureFlag.mockResolvedValue("test");
    jest
      .mocked(getPaidFirstStepEnrollment)
      .mockResolvedValue(enrollment as never);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.ABLITERATION_API_KEY;
    else process.env.ABLITERATION_API_KEY = originalKey;
  });
  it.each(["ask", "agent"] as const)(
    "expands %s despite a low moderation score, but only on step one",
    async (mode) => {
      const result = await evaluatePaidFirstStepModel({ ...args, mode });
      expect(result).toMatchObject({
        variant: "test",
        modelKey: "model-abliterated",
        baselineModel: args.selectedModel,
        selectionSource: "paid_expansion",
      });
      expect(hasAbliterationRoute(result)).toBe(true);
      expect(
        resolveAbliterationModelForGenerationStep({
          treatmentModel: result!.modelKey,
          baselineModel: result!.baselineModel,
          stepIndex: 1,
        }),
      ).toBe(args.selectedModel);
      expect(getExperimentAnalyticsProperties(result)).toMatchObject({
        baseline_renewal_at: 1000,
        baseline_cancel_at_period_end: true,
        paid_first_step_routing_changed: true,
      });
      expect(JSON.stringify(posthog.getFeatureFlag.mock.calls)).not.toContain(
        "private content",
      );
    },
  );
  it.each(["control", "test"] as const)(
    "preserves Large v2 and continuation routing in %s",
    async (variant) => {
      jest
        .mocked(getPaidFirstStepEnrollment)
        .mockResolvedValue({ ...enrollment, variant } as never);
      const result = await evaluatePaidFirstStepModel({
        ...args,
        existingAssignment: oldAssignment,
      });
      expect(result).toMatchObject({
        variant,
        modelKey: oldAssignment.modelKey,
        paidFirstStep: { routingChanged: false },
      });
      expect(hasAbliterationRoute(result)).toBe(true);
    },
  );
  it("keeps the frozen assignment even if remote bucketing later changes", async () => {
    jest
      .mocked(getPaidFirstStepEnrollment)
      .mockResolvedValue({ ...enrollment, variant: "control" } as never);
    expect(await evaluatePaidFirstStepModel(args)).toMatchObject({
      variant: "control",
      modelKey: args.selectedModel,
    });
  });
  it.each([false, undefined, "unknown"])(
    "obeys the live kill switch %s before reading enrollment",
    async (value) => {
      posthog.getFeatureFlag.mockResolvedValue(value);
      expect(
        await evaluatePaidFirstStepModel({
          ...args,
          existingAssignment: oldAssignment,
        }),
      ).toBe(oldAssignment);
      expect(getPaidFirstStepEnrollment).not.toHaveBeenCalled();
    },
  );
  it.each([
    { isAutomaticContinuation: true },
    { safetyEligible: false },
    { limitRescue: true },
    { organizationId: undefined },
    { subscription: "free" as const },
    { subscription: "team" as const },
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
              url: "private",
            },
          ],
        },
      ],
    },
  ])("preserves gates %j", async (changes) => {
    expect(
      await evaluatePaidFirstStepModel({ ...args, ...changes }),
    ).toBeUndefined();
    expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
  });
  it("fails closed when enrollment cannot be established", async () => {
    jest
      .mocked(getPaidFirstStepEnrollment)
      .mockRejectedValue(Error("private billing error"));
    expect(
      await evaluatePaidFirstStepModel({
        ...args,
        existingAssignment: oldAssignment,
      }),
    ).toBe(oldAssignment);
    expect(JSON.stringify(posthog.capture.mock.calls)).not.toContain(
      "private billing error",
    );
  });
  it("does not seed independent moderation history from experiment expansion", () => {
    expect(
      getAbliterationHistoryEntry({
        id: "a",
        finish_reason: "stop",
        usage: {
          abliterationRouting: {
            version: 1,
            source: "paid_expansion",
            completed: true,
          },
        },
      }).independent,
    ).toBe(false);
  });
});
