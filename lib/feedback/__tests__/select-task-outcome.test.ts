import { selectTaskOutcomeSurvey } from "../select-task-outcome";
import { PAID_TASK_OUTCOME_FLAG } from "../task-outcome";

const mutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation }),
}));

const base = {
  userId: "user",
  chatId: "chat",
  messageId: "request",
  mode: "agent" as const,
  subscription: "pro",
};

describe("paid survey selection", () => {
  const oldKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-key";
    mutation.mockImplementation(async (_api, context) => ({
      _id: "survey",
      ...context,
    }));
  });

  afterAll(() => {
    if (oldKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = oldKey;
  });

  it("evaluates only the paid flag and reserves without model attribution", async () => {
    const posthog = {
      getFeatureFlagResult: jest.fn(async () => ({
        key: PAID_TASK_OUTCOME_FLAG,
        enabled: true,
        variant: undefined,
        payload: undefined,
      })),
      capture: jest.fn(),
    };

    const selected = await selectTaskOutcomeSurvey({ ...base, posthog });

    expect(selected).toBeDefined();
    expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
      PAID_TASK_OUTCOME_FLAG,
      "user",
      expect.objectContaining({
        personProperties: { subscription_tier: "pro" },
        sendFeatureFlagEvents: false,
      }),
    );
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0][1]).toMatchObject({
      survey_kind: "new_paid",
      request_id: "request",
    });
    expect(mutation.mock.calls[0][1]).not.toHaveProperty("experiment_key");
    expect(mutation.mock.calls[0][1]).not.toHaveProperty("assigned_model");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_selected",
        properties: expect.objectContaining({
          survey_key: PAID_TASK_OUTCOME_FLAG,
          survey_kind: "new_paid",
        }),
      }),
    );

    await selected?.linkMessage("fallback");
    expect(mutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        request_id: "request",
        message_id: "fallback",
      }),
    );
  });

  it.each(["free", "team"])(
    "does not evaluate the flag for %s users",
    async (subscription) => {
      const posthog = {
        getFeatureFlagResult: jest.fn(async () => ({
          key: PAID_TASK_OUTCOME_FLAG,
          enabled: true,
          variant: undefined,
          payload: undefined,
        })),
        capture: jest.fn(),
      };

      await selectTaskOutcomeSurvey({ ...base, subscription, posthog });

      expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the flag is off", async () => {
    const posthog = {
      getFeatureFlagResult: jest.fn(async () => ({
        key: PAID_TASK_OUTCOME_FLAG,
        enabled: false,
        variant: undefined,
        payload: undefined,
      })),
      capture: jest.fn(),
    };

    await selectTaskOutcomeSurvey({ ...base, posthog });

    expect(mutation).not.toHaveBeenCalled();
  });

  it("does not interrupt chat when flag evaluation or reservation fails", async () => {
    await expect(
      selectTaskOutcomeSurvey({
        ...base,
        posthog: {
          getFeatureFlagResult: jest.fn(async () => {
            throw Error("offline");
          }),
          capture: jest.fn(),
        },
      }),
    ).resolves.toBeUndefined();

    mutation.mockRejectedValueOnce(Error("offline"));
    await expect(
      selectTaskOutcomeSurvey({
        ...base,
        posthog: {
          getFeatureFlagResult: jest.fn(async () => ({
            key: PAID_TASK_OUTCOME_FLAG,
            enabled: true,
            variant: undefined,
            payload: undefined,
          })),
          capture: jest.fn(),
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("current Pro/Max experiment feedback", () => {
  const assignment = {
    key: "abliterated_max_moderated_v1" as const,
    variant: "control" as const,
    modelKey: "model-deepseek-v4-pro" as const,
    baselineModel: "model-deepseek-v4-pro" as const,
    selectionSource: "moderation" as const,
  };
  const oldKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-key";
    mutation.mockImplementation(async (_api, context) => ({
      _id: "survey",
      ...context,
    }));
  });
  afterAll(() => {
    if (oldKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = oldKey;
  });
  it.each([
    [
      "abliterated_paid_first_step_v2",
      "paid_first_step",
      "control",
      "abliterated_paid_first_step_feedback_v2",
    ],
    [
      "abliterated_paid_first_step_v2",
      "paid_first_step",
      "test",
      "abliterated_paid_first_step_feedback_v2",
    ],
    [
      "abliterated_paid_moderated_default_v1",
      "moderation",
      "test",
      "abliterated_paid_moderated_default_feedback_v1",
    ],
  ] as const)(
    "reserves %s/%s/%s with its own phase",
    async (key, selectionSource, variant, phase) => {
      for (const mode of ["ask", "agent"] as const) {
        for (const selectedModelOverride of [
          undefined,
          "auto",
          "hackerai-standard",
          "hackerai-pro",
          "hackerai-max",
        ]) {
          const posthog = {
            getFeatureFlagResult: jest.fn(async () => ({ enabled: true })),
            capture: jest.fn(),
          };
          const selected = await selectTaskOutcomeSurvey({
            ...base,
            posthog,
            mode,
            selectedModelOverride,
            assignment: { ...assignment, key, selectionSource, variant },
          });
          expect(selected).toBeDefined();
          expect(mutation).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({
              experiment_key: key,
              experiment_variant: variant,
              feedback_phase: phase,
              experiment_request_id: base.messageId,
              selected_model_override: selectedModelOverride ?? "auto",
            }),
          );
        }
      }
    },
  );
  it.each([
    {
      key: "abliterated_paid_first_step_v2",
      selectionSource: "history",
      variant: "test",
    },
    {
      key: "abliterated_paid_first_step_v2",
      selectionSource: "moderation",
      variant: "test",
    },
    {
      key: "abliterated_paid_moderated_default_v1",
      selectionSource: "moderation",
      variant: "control",
    },
    {
      key: "abliterated_moderated_three_steps_default_v1",
      selectionSource: "moderation",
      variant: "test",
    },
  ] as const)(
    "does not mislabel an ineligible new-phase assignment",
    async (overrides) => {
      const posthog = { getFeatureFlagResult: jest.fn(), capture: jest.fn() };
      await selectTaskOutcomeSurvey({
        ...base,
        posthog,
        selectedModelOverride: "hackerai-standard",
        assignment: { ...assignment, ...overrides },
      });
      expect(mutation).not.toHaveBeenCalled();
      expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
    },
  );
  it.each(["control", "test"] as const)(
    "selects %s identically before any generation outcome",
    async (variant) => {
      const posthog = {
        getFeatureFlagResult: jest.fn(async () => ({ enabled: true })),
        capture: jest.fn(),
      };
      const selected = await selectTaskOutcomeSurvey({
        ...base,
        posthog,
        assignment: { ...assignment, variant },
        selectedModelOverride: "hackerai-pro",
      });
      expect(selected).toBeDefined();
      expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
        "abliterated_task_outcome_feedback_v1",
        "user",
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription_tier: "pro" },
        },
      );
      expect(mutation.mock.calls[0][1]).toMatchObject({
        survey_kind: "current_experiment",
        experiment_key: assignment.key,
        experiment_variant: variant,
        request_id: "request",
        experiment_request_id: "request",
        selected_model_override: "hackerai-pro",
        feedback_phase: "abliterated_max_moderated_feedback_v1",
      });
      expect(mutation.mock.calls[0][1]).not.toHaveProperty("paid_started_at");
      await selected?.linkMessage("fallback");
      expect(mutation.mock.calls[1][1]).toMatchObject({
        request_id: "request",
        message_id: "fallback",
      });
      expect(posthog.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({
            experiment_request_id: "request",
            experiment_variant: variant,
          }),
        }),
      );
    },
  );
  it.each(["pro", "pro-plus", "ultra", "team"])(
    "supports authorized %s members in Ask and Agent",
    async (subscription) => {
      for (const mode of ["ask", "agent"] as const) {
        const posthog = {
          getFeatureFlagResult: jest.fn(async () => ({ enabled: true })),
          capture: jest.fn(),
        };
        expect(
          await selectTaskOutcomeSurvey({
            ...base,
            posthog,
            subscription,
            mode,
            assignment,
            selectedModelOverride: "hackerai-max",
          }),
        ).toBeDefined();
      }
    },
  );
  it.each([
    { subscription: "free" },
    { selectedModelOverride: "hackerai-standard" },
    {
      assignment: {
        ...assignment,
        key: "abliterated_paid_moderated_v1" as const,
      },
    },
    { assignment: { ...assignment, selectionSource: "history" as const } },
  ])(
    "excludes nonparticipants and historical cohorts without evaluating delivery",
    async (overrides) => {
      const posthog = {
        getFeatureFlagResult: jest.fn(async () => ({ enabled: true })),
        capture: jest.fn(),
      };
      await selectTaskOutcomeSurvey({
        ...base,
        posthog,
        assignment,
        selectedModelOverride: "hackerai-max",
        ...overrides,
      });
      expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    },
  );
  it.each([false, undefined])(
    "fails closed without feedback configuration (%s), with no cohort fallback",
    async (enabled) => {
      const posthog = {
        getFeatureFlagResult: jest.fn(async () =>
          enabled === undefined ? undefined : { enabled },
        ),
        capture: jest.fn(),
      };
      await selectTaskOutcomeSurvey({
        ...base,
        posthog,
        assignment,
        selectedModelOverride: "hackerai-max",
      });
      expect(mutation).not.toHaveBeenCalled();
      expect(posthog.getFeatureFlagResult).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves recovery even if selection analytics or linkage fails", async () => {
    const posthog = {
      getFeatureFlagResult: jest.fn(async () => ({ enabled: true })),
      capture: jest.fn(() => {
        throw Error("offline");
      }),
    };
    const selected = await selectTaskOutcomeSurvey({
      ...base,
      posthog,
      assignment,
      selectedModelOverride: "hackerai-max",
    });
    mutation.mockRejectedValueOnce(Error("offline"));
    await expect(selected?.linkMessage("fallback")).resolves.toBeUndefined();
  });
});
