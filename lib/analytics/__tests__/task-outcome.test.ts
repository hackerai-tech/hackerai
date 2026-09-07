import { taskOutcomeProperties } from "../task-outcome";

const row = {
  request_id: "original",
  message_id: "fallback",
  chat_id: "chat",
  experiment_variant: "test",
  baseline_model: "baseline",
  assigned_model: "treatment",
  mode: "agent",
  subscription_tier: "pro",
  release: "old-worker",
};

describe("task feedback routing attribution", () => {
  it("preserves legacy three-step reservations across newer frontend deployments", () => {
    expect(taskOutcomeProperties(row)).toMatchObject({
      generation_step_limit: 3,
      routing_version: "first_three_generation_steps_v1",
      experiment_request_id: "original",
      message_id: "fallback",
    });
  });
  it("uses the reserved policy for delayed answers rather than the current runtime limit", () => {
    expect(
      taskOutcomeProperties({
        ...row,
        generation_step_limit: 1,
        routing_version: "generation_steps_1_v1",
        answer: "yes",
      }),
    ).toMatchObject({
      generation_step_limit: 1,
      routing_version: "generation_steps_1_v1",
      answer: "yes",
    });
    expect(
      taskOutcomeProperties({
        ...row,
        generation_step_limit: 2,
        routing_version: "future-policy",
        answer: "partly",
      }),
    ).toMatchObject({
      generation_step_limit: 2,
      routing_version: "future-policy",
    });
  });
});
