import {
  isProviderContentBlockedFinishReasonError,
  isProviderContentFilterFinishReason,
} from "@/lib/utils/error-utils";

type ProviderContentBlockedLifecycleEvent = {
  error?: unknown;
  finishReason?: string;
  settled: boolean;
};

export const createProviderContentBlockedRefundLifecycle = ({
  hasUsage,
  refund,
}: {
  hasUsage: () => boolean;
  refund: () => Promise<void>;
}) => {
  let providerContentBlockedObserved = false;
  let refundInFlight: Promise<void> | undefined;

  return async ({
    error,
    finishReason,
    settled,
  }: ProviderContentBlockedLifecycleEvent): Promise<void> => {
    if (
      isProviderContentBlockedFinishReasonError(error) ||
      isProviderContentFilterFinishReason(finishReason)
    ) {
      providerContentBlockedObserved = true;
    }
    if (!settled || !providerContentBlockedObserved || hasUsage()) return;

    refundInFlight ??= refund().finally(() => {
      refundInFlight = undefined;
    });
    await refundInFlight;
  };
};
