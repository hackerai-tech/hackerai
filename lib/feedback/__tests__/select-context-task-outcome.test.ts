import { selectContextTaskOutcomeSurvey } from "../select-context-task-outcome";
import { AGENT_CONTEXT_FEEDBACK_FLAG } from "../agent-context";
const mutation = jest.fn();
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation }),
}));
const base = {
  userId: "user",
  chatId: "chat",
  messageId: "assistant",
  triggerRunId: "run",
  mode: "agent" as const,
  subscription: "pro",
  selectedModelOverride: "hackerai-pro",
  variant: "control" as const,
  release: "worker",
};
describe("context feedback delivery", () => {
  const oldKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "test";
    mutation.mockImplementation(async (_api, args) => ({
      _id: "survey",
      ...args,
    }));
  });
  afterAll(() => {
    if (oldKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = oldKey;
  });
  const ph = (enabled = true) => ({
    getFeatureFlagResult: jest.fn(async () => ({ enabled })),
    capture: jest.fn(),
  });
  it.each(["hackerai-max", "hackerai-pro"])(
    "freezes both variants of %s without reevaluating context or emitting false exposure",
    async (selectedModelOverride) => {
      for (const variant of ["control", "test"] as const) {
        const posthog = ph();
        const selected = await selectContextTaskOutcomeSurvey({
          ...base,
          selectedModelOverride,
          variant,
          posthog,
        });
        expect(posthog.getFeatureFlagResult).toHaveBeenCalledTimes(1);
        expect(posthog.getFeatureFlagResult).toHaveBeenCalledWith(
          AGENT_CONTEXT_FEEDBACK_FLAG,
          "user",
          expect.objectContaining({ sendFeatureFlagEvents: false }),
        );
        expect(mutation).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            experiment_variant: variant,
            experiment_key:
              selectedModelOverride === "hackerai-max"
                ? "agent_model_context_v1"
                : "agent_pro_context_v1",
            trigger_run_id: "run",
          }),
        );
        expect(posthog.capture).toHaveBeenCalledWith(
          expect.objectContaining({
            event: "task_outcome_survey_selected",
            properties: expect.objectContaining({
              survey_kind: "agent_context",
              survey_key: AGENT_CONTEXT_FEEDBACK_FLAG,
              experiment_variant: variant,
            }),
          }),
        );
        await selected?.linkMessage("recovery");
        expect(mutation).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({
            request_id: "assistant",
            message_id: "recovery",
          }),
        );
      }
    },
  );
  it.each([
    { mode: "ask" },
    { subscription: "free" },
    { selectedModelOverride: "auto" },
    { variant: undefined },
  ])("does not ask in excluded runs %j", async (patch) => {
    const posthog = ph();
    await selectContextTaskOutcomeSurvey({
      ...base,
      ...patch,
      posthog,
    } as Parameters<typeof selectContextTaskOutcomeSurvey>[0]);
    expect(posthog.getFeatureFlagResult).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
  it("fails closed on disabled delivery, unselected history and unavailable service", async () => {
    await selectContextTaskOutcomeSurvey({ ...base, posthog: ph(false) });
    expect(mutation).not.toHaveBeenCalled();
    mutation.mockResolvedValue(null);
    const posthog = ph();
    expect(
      await selectContextTaskOutcomeSurvey({ ...base, posthog }),
    ).toBeUndefined();
    expect(posthog.capture).not.toHaveBeenCalled();
    mutation.mockRejectedValue(Error("unavailable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await selectContextTaskOutcomeSurvey({ ...base, posthog }),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.not.stringContaining("unavailable"),
    );
    warn.mockRestore();
  });
});
