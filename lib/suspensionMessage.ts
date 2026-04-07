/**
 * Build a user-facing suspension message from a Stripe customer's
 * `blocked_reason` metadata (set by the fraud webhook).
 *
 * The raw reason categories come from app/api/fraud/webhook/route.ts:
 *   - early_fraud_warning:<fraud_type>
 *   - dispute_fraudulent:<dispute_id>
 *   - immediate_block:stolen_card | immediate_block:fraudulent
 *   - card_testing_detected:<reason>
 *
 * Specific fraud signals are intentionally not exposed to avoid tipping
 * off bad actors about how detection works.
 */
export function getSuspensionMessage(blockedReason?: string | null): string {
  const reasonLabel = mapBlockedReasonToLabel(blockedReason);
  return `Your account has been suspended due to ${reasonLabel}. Please contact support via chat at https://help.hackerai.co/ if you believe this is a mistake.`;
}

function mapBlockedReasonToLabel(blockedReason?: string | null): string {
  if (!blockedReason) return "suspicious activity";

  const category = blockedReason.split(":")[0];

  switch (category) {
    case "early_fraud_warning":
      return "a fraud warning from your card issuer";
    case "dispute_fraudulent":
      return "a fraudulent payment dispute (chargeback)";
    case "immediate_block":
      // immediate_block:stolen_card or immediate_block:fraudulent
      return "a reported fraudulent or stolen card";
    case "card_testing_detected":
      return "suspicious payment activity";
    default:
      return "suspicious activity";
  }
}
