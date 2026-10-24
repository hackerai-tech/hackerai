import { sanitizeContextFeedbackEvent } from "../context-feedback-privacy";
it("removes SDK-enriched content and person envelopes without losing feedback attribution", () => {
  const sanitized = sanitizeContextFeedbackEvent({
    event: "task_outcome_survey_answered",
    properties: {
      survey_kind: "agent_context",
      experiment_key: "agent_pro_context_v1",
      experiment_variant: "control",
      answer: "no",
      reason: "incorrect",
      distinct_id: "u",
      $current_url: "private",
      $referrer: "private",
      prompt: "private",
      registered_content: "private",
      stripe_subscription_id: "private",
      $set: { email: "private" },
    },
    $set: { email: "private" },
    $set_once: { prompt: "private" },
  });
  expect(sanitized).toEqual({
    event: "task_outcome_survey_answered",
    properties: {
      survey_kind: "agent_context",
      experiment_key: "agent_pro_context_v1",
      experiment_variant: "control",
      answer: "no",
      reason: "incorrect",
      distinct_id: "u",
    },
  });
});
