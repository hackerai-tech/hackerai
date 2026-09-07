import { selectTaskOutcomeSurvey } from "../select-task-outcome";
import { TASK_OUTCOME_FLAG } from "../task-outcome";
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
  it("requires an existing experiment assignment and an explicit survey flag", async () => {
    const posthog = {
      getFeatureFlag: jest.fn(async () => false),
      capture: jest.fn(),
    };
    await selectTaskOutcomeSurvey({ ...base, posthog, assignment: undefined });
    expect(posthog.getFeatureFlag).not.toHaveBeenCalled();
    await selectTaskOutcomeSurvey({ ...base, posthog });
    expect(mutation).not.toHaveBeenCalled();
  });
  it("keeps control and test equally eligible and retains original attribution through fallback", async () => {
    const posthog = {
      getFeatureFlag: jest.fn(async () => true),
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
  it("does not interrupt chat when the flag or database is unavailable", async () => {
    const posthog = {
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
