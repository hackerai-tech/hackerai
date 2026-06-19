"use client";

const normalizeFailureReason = (reason: string): string => {
  const trimmed = reason.trim().replace(/[.!?]+$/u, "");

  if (!trimmed || trimmed === "payment_failed") {
    return "Payment failed";
  }

  return trimmed;
};

type AutoReloadDisabledAlertProps = {
  reason: string;
  updateInBillingPortal?: boolean;
};

export const AutoReloadDisabledAlert = ({
  reason,
  updateInBillingPortal = false,
}: AutoReloadDisabledAlertProps) => {
  const displayReason = normalizeFailureReason(reason);
  const updateCopy = updateInBillingPortal
    ? "Update your payment method in the billing portal"
    : "Update your payment method";

  return (
    <div
      role="alert"
      className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500"
    >
      Auto-reload was turned off after failed payment attempts. {displayReason}.{" "}
      {updateCopy}, then turn auto-reload back on.
    </div>
  );
};
