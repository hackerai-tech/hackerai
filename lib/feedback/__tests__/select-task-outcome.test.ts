import { selectTaskOutcomeSurvey } from "../select-task-outcome";
import { PAID_TASK_OUTCOME_FLAG, TASK_OUTCOME_FLAG } from "../task-outcome";
const mutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation }),
}));
const assignment = {
  key: "abliterated_paid_moderated_v1" as const,
  variant: "test" as const,
  modelKey: "model-abliterated" as const,
  baselineModel: "model-deepseek-v4-flash-0731" as const,
};
const base = {
  assignment,
  userId: "user",
  chatId: "chat",
  messageId: "request",
  mode: "agent" as const,
  subscription: "pro",
};
const row = {
  _id: "survey",
  request_id: "request",
  message_id: "request",
  chat_id: "chat",
  experiment_variant: "test",
  baseline_model: "baseline",
  assigned_model: "treatment",
  mode: "agent",
  subscription_tier: "pro",
  release: "test",
};
describe("survey selection", () => {
  it("evaluates both eligible survey flags once without automatic exposure", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockResolvedValue({
        [PAID_TASK_OUTCOME_FLAG]: true,
        [TASK_OUTCOME_FLAG]: true,
      }),
      getFeatureFlag: jest.fn(),
      capture: jest.fn(),
    };
    mutation.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    const selected = await selectTaskOutcomeSurvey({ ...base, posthog });
    expect(selected).toBeDefined();
    expect(posthog.getAllFlags).toHaveBeenCalledTimes(1);
    expect(posthog.getAllFlags).toHaveBeenCalledWith("user", {
      flagKeys: [PAID_TASK_OUTCOME_FLAG, TASK_OUTCOME_FLAG],
      personProperties: { subscription_tier: "pro" },
    });
    expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(mutation.mock.calls[0][1]).toMatchObject({
      survey_kind: "new_paid",
    });
    expect(mutation.mock.calls[1][1]).not.toHaveProperty("survey_kind");
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture.mock.calls[0][0].event).toBe(
      "task_outcome_survey_selected",
    );
  });

  it("fails closed for absent batch flags without repeating evaluation", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockResolvedValue({}),
      getFeatureFlag: jest.fn(),
      capture: jest.fn(),
    };
    await expect(
      selectTaskOutcomeSurvey({ ...base, posthog }),
    ).resolves.toBeUndefined();
    expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
  it("stores the free Ask assignment key and emits matching selection metadata", async () => {
    const key = "abliterated_free_ask_moderated_v1" as const;
    mutation.mockResolvedValue({ ...row, experiment_key: key });
    const posthog = {
      getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
      getFeatureFlag: jest.fn(async () => true),
      capture: jest.fn(),
    };
    await selectTaskOutcomeSurvey({
      ...base,
      mode: "ask",
      subscription: "free",
      assignment: { ...assignment, key },
      posthog,
    });
    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ experiment_key: key }),
    );
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_selected",
        properties: expect.objectContaining({ experiment_key: key }),
      }),
    );
  });
  const oldKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-key";
    mutation.mockResolvedValue(row);
  });
  afterAll(() => {
    if (oldKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = oldKey;
  });
  it("fails closed without an explicit independent or legacy flag", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
      getFeatureFlag: jest.fn(async () => false),
      capture: jest.fn(),
    };
    await selectTaskOutcomeSurvey({ ...base, posthog, assignment: undefined });
    expect(posthog.getFeatureFlag).toHaveBeenCalledWith(
      PAID_TASK_OUTCOME_FLAG,
      "user",
      expect.any(Object),
    );
    await selectTaskOutcomeSurvey({ ...base, posthog });
    expect(mutation).not.toHaveBeenCalled();
  });
  it("keeps control and test equally eligible and retains original attribution through fallback", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
      getFeatureFlag: jest.fn(async (key: string) => key === TASK_OUTCOME_FLAG),
      capture: jest.fn(),
    };
    const selected = await selectTaskOutcomeSurvey({
      ...base,
      posthog,
      assignment: { ...assignment, variant: "control" },
    });
    expect(posthog.getFeatureFlag).toHaveBeenCalledWith(
      TASK_OUTCOME_FLAG,
      "user",
      expect.any(Object),
    );
    expect(mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        experiment_variant: "control",
        generation_step_limit: 1,
        routing_version: "generation_steps_1_v1",
        request_id: "request",
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
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "task_outcome_survey_selected" }),
    );
  });
  it("keeps legacy selection available when the independent flag rejects", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
      getFeatureFlag: jest.fn(async (key: string) => {
        if (key === PAID_TASK_OUTCOME_FLAG) throw Error("flag unavailable");
        return key === TASK_OUTCOME_FLAG;
      }),
      capture: jest.fn(),
    };
    const selected = await selectTaskOutcomeSurvey({ ...base, posthog });
    expect(selected).toBeDefined();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0][1]).not.toHaveProperty("survey_kind");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "task_outcome_survey_selected",
        properties: expect.objectContaining({
          survey_kind: "model_experiment",
        }),
      }),
    );
  });
  it("does not interrupt chat when the flag or database is unavailable", async () => {
    const posthog = {
      getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
      getFeatureFlag: jest.fn(async () => {
        throw Error("offline");
      }),
      capture: jest.fn(),
    };
    await expect(
      selectTaskOutcomeSurvey({ ...base, posthog }),
    ).resolves.toBeUndefined();
    mutation.mockRejectedValue(Error("offline"));
    await expect(
      selectTaskOutcomeSurvey({
        ...base,
        posthog: { ...posthog, getFeatureFlag: jest.fn(async () => true) },
      }),
    ).resolves.toBeUndefined();
  });
});

it("samples independently without inventing model attribution", async () => {
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-key";
  mutation.mockReset();
  mutation.mockImplementation(async (_api, context) => ({
    _id: "survey",
    ...context,
  }));
  const posthog = {
    getAllFlags: jest.fn().mockRejectedValue(new Error("batch unavailable")),
    getFeatureFlag: jest.fn(
      async (key: string) => key === PAID_TASK_OUTCOME_FLAG,
    ),
    capture: jest.fn(),
  };
  await selectTaskOutcomeSurvey({ ...base, assignment: undefined, posthog });
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(mutation.mock.calls[0][1]).toMatchObject({ survey_kind: "new_paid" });
  const properties = posthog.capture.mock.calls[0][0].properties;
  expect(properties.survey_key).toBe(PAID_TASK_OUTCOME_FLAG);
  expect(properties).not.toHaveProperty("experiment_key");
  expect(properties).not.toHaveProperty("assigned_model");
  delete process.env.CONVEX_SERVICE_ROLE_KEY;
});
