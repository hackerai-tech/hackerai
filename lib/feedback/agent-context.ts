// Delivery is independent of both context assignments. Keep this cohort separate
// from paid onboarding and model-routing feedback.
export const AGENT_CONTEXT_FEEDBACK_FLAG = "agent_context_task_feedback_v1";
export const AGENT_CONTEXT_FEEDBACK_PHASE = "saved_history_80k_chars_v1";
// Older loaded clients use a different survey attribution/privacy contract.
export const AGENT_CONTEXT_FEEDBACK_CLIENT_VERSION = 1;
export const AGENT_CONTEXT_FEEDBACK_MIN_CHARS = 80_000;
export const AGENT_CONTEXT_FEEDBACK_HISTORY_LIMIT = 8;
export const AGENT_CONTEXT_FEEDBACK_KEYS = [
  "agent_model_context_v1",
  "agent_pro_context_v1",
] as const;
export type ContextFeedbackKey = (typeof AGENT_CONTEXT_FEEDBACK_KEYS)[number];

/** Measure original stored history, never the variant-dependent prompt/summary.
 * This is an eligibility proxy, not a token estimate or proof of long context.
 * Cap before export; no source text leaves the reservation transaction.
 */
export function contextFeedbackSourceChars(
  messages: readonly {
    id: string;
    user_id: string;
    is_hidden?: boolean;
    parts: unknown[];
  }[],
  userId: string,
  messageId: string,
) {
  let chars = 0;
  for (const message of messages) {
    if (
      message.user_id !== userId ||
      message.id === messageId ||
      message.is_hidden
    )
      continue;
    chars += JSON.stringify(message.parts).length;
    if (chars >= AGENT_CONTEXT_FEEDBACK_MIN_CHARS)
      return AGENT_CONTEXT_FEEDBACK_MIN_CHARS;
  }
  return chars;
}
