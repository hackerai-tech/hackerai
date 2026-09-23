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
