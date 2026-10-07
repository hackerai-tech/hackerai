import { PAID_TASK_OUTCOME_FLAG } from "../../feedback/task-outcome";
import { taskOutcomeProperties } from "../task-outcome";

describe("paid task outcome analytics", () => {
  it("emits the paid cohort allowlist without model attribution", () => {
    const properties = taskOutcomeProperties({
      request_id: "original",
      message_id: "fallback",
      chat_id: "chat",
      survey_kind: "new_paid",
      mode: "agent",
      subscription_tier: "pro",
      release: "worker-sha",
      paid_started_at: 1_800_000_000_000,
      stripe_subscription_id: "sub_1",
      paid_start_invoice_id: "in_1",
      baseline_renewal_at: 1_802_592_000_000,
      billing_interval: "month",
      selected_at: 1_800_000_001_000,
      expires_at: 1_800_172_801_000,
      answer: "solved",
      reason: "clear_explanation",
    });

    expect(properties).toMatchObject({
      survey_key: PAID_TASK_OUTCOME_FLAG,
      survey_version: 2,
      survey_kind: "new_paid",
      survey_request_id: "original",
      message_id: "fallback",
      task_solved: true,
      answer: "solved",
    });
    expect(properties).not.toHaveProperty("experiment_key");
    expect(properties).not.toHaveProperty("experiment_variant");
    expect(properties).not.toHaveProperty("assigned_model");
    expect(properties).not.toHaveProperty("baseline_model");
  });
});

it("freezes experiment attribution without forwarding content or treating unchecked as failure", () => {
  const row = {
    request_id: "original",
    message_id: "recovery",
    chat_id: "chat",
    mode: "ask",
    subscription_tier: "team",
    release: "sha",
    survey_kind: "current_experiment" as const,
    experiment_key: "abliterated_max_moderated_v1",
    experiment_variant: "test",
    experiment_request_id: "original",
    feedback_phase: "abliterated_max_moderated_feedback_v1",
    selected_model_override: "hackerai-pro",
    assigned_model: "abliterated-model",
    baseline_model: "baseline",
    answer: "not_checked",
    content: "private",
    prompt: "private",
    user_id: "user",
  };
  const properties = taskOutcomeProperties(row);
  expect(properties).toMatchObject({
    survey_version: 3,
    survey_key: "abliterated_task_outcome_feedback_v1",
    survey_request_id: "original",
    experiment_request_id: "original",
    message_id: "recovery",
    task_solved: null,
    selected_model_override: "hackerai-pro",
  });
  expect(properties).not.toHaveProperty("content");
  expect(properties).not.toHaveProperty("prompt");
  expect(properties).not.toHaveProperty("user_id");
});
