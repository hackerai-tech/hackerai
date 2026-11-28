import { AgentApprovalAuthorizationError } from "@/lib/chat/agent-approval-authorization";
import {
  verifyPaidDailyFreeAllowanceReservationOwnership,
  type PaidDailyFreeAllowanceReservation,
  type PaidDailyFreeAllowanceReservationOwnership,
} from "@/lib/rate-limit/paid-daily-free-allowance";

type AllowanceLostReason = Extract<
  PaidDailyFreeAllowanceReservationOwnership,
  { owned: false }
>["reason"];

/**
 * Rechecks spending capacity when an Agent run resumes after a question reply,
 * a human approval, or an automatic approval.
 *
 * A run admitted on the paid daily free allowance was admitted precisely
 * because included capacity was exhausted, so the normal capacity check would
 * always reject it. It continues only while it still owns its original lease;
 * a lost lease stops the run rather than reserving again or falling back to
 * other billing.
 */
export async function assertResumedAgentRunCapacity({
  userId,
  admittedAllowanceReservation,
  checkCapacity,
  onAllowanceLost,
}: {
  userId: string;
  admittedAllowanceReservation: PaidDailyFreeAllowanceReservation | undefined;
  checkCapacity: () => Promise<unknown>;
  onAllowanceLost?: (reason: AllowanceLostReason) => void;
}): Promise<void> {
  if (!admittedAllowanceReservation) {
    await checkCapacity();
    return;
  }

  const ownership = await verifyPaidDailyFreeAllowanceReservationOwnership(
    userId,
    admittedAllowanceReservation,
  );
  if (!ownership.owned) {
    onAllowanceLost?.(ownership.reason);
    throw new AgentApprovalAuthorizationError(
      "authorization_mismatch",
      "The daily allowance for this run is no longer available.",
    );
  }
}
