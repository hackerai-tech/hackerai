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
      getFeatureFlag: jest.fn(async () => true),
      capture: jest.fn(),
    };

    const selected = await selectTaskOutcomeSurvey({ ...base, posthog });

    expect(selected).toBeDefined();
    expect(posthog.getFeatureFlag).toHaveBeenCalledWith(
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
        getFeatureFlag: jest.fn(async () => true),
        capture: jest.fn(),
      };

      await selectTaskOutcomeSurvey({ ...base, subscription, posthog });

      expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the flag is off", async () => {
    const posthog = {
      getFeatureFlag: jest.fn(async () => false),
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
          getFeatureFlag: jest.fn(async () => {
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
          getFeatureFlag: jest.fn(async () => true),
          capture: jest.fn(),
        },
      }),
    ).resolves.toBeUndefined();
  });
});
